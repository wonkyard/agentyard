'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { toDepartments } = require('./shared/frontmatter.js');
const hooksConfig = require('./shared/hooksConfig.js');
const {
  buildClaudeArgs,
  buildInteractiveClaudeArgs,
  buildInteractiveCodexArgs,
  candidateCommands,
} = require('./shared/claudeArgs.js');
const { needsCmdWrap, resolveLauncher } = require('./shared/winWrap.js');
const claudeResolve = require('./shared/claudeResolve.js');
const guidelines = require('./shared/guidelines.js');
const { StreamJsonParser } = require('./shared/streamJson.js');
const { killTree, spawnGroupOpts } = require('./shared/killTree.js');
const attach = require('./shared/attach.js');
const pkg = require('./package.json');

// node-pty powers the embedded terminal in the Run view. It is a native module;
// if its prebuilt binary can't load on this platform/ABI we fall back to the
// headless Run view instead of throwing on activation. See CLAUDE.md for the
// Electron-ABI rebuild step when a future VS Code engine bump outruns the
// shipped prebuilds.
let nodePty = null;
let nodePtyError = null;
try {
  nodePty = require('@homebridge/node-pty-prebuilt-multiarch');
} catch (e) {
  nodePtyError = (e && e.message) ? e.message : String(e);
}

const PTY_UNAVAILABLE_NOTICE =
  "Live terminal needs a native component that didn't load on this platform — " +
  'using the non-interactive runner. Run "Agentyard: Open Claude Code Terminal" ' +
  'for a full session.';

// ---- coding-agent backends -----------------------------------------
// Everything CLI-specific routes through one of these: the Run-view switcher,
// which instructions file the guidelines command manages, which live sources
// are watched. Adding a backend means adding an entry here.
const KNOWN_AGENTS = ['claude-code', 'codex'];

const BACKENDS = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    cliDefault: 'claude',
    cliSetting: 'claudePath',
    docsUrl: 'https://docs.anthropic.com/claude-code',
    instructionsFile: 'CLAUDE.md',
    buildInteractiveArgs(cfg) {
      return buildInteractiveClaudeArgs({
        claudePath: cfg.get('claudePath', 'claude'),
        permissionMode: cfg.get('claudePermissionMode', 'default'),
        extraArgs: cfg.get('claudeExtraArgs', []),
      });
    },
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    cliDefault: 'codex',
    cliSetting: 'codexPath',
    docsUrl: 'https://github.com/openai/codex',
    instructionsFile: 'AGENTS.md',
    buildInteractiveArgs(cfg) {
      return buildInteractiveCodexArgs({
        codexPath: cfg.get('codexPath', 'codex'),
        extraArgs: cfg.get('codexExtraArgs', []),
      });
    },
  },
};

// The enabled backend id list, de-duped and validated. Default (and any
// unrecognised value) → Claude Code only, so an existing install is unchanged.
function enabledAgents() {
  const raw = vscode.workspace.getConfiguration('agentyard').get('agents', ['claude-code']);
  const out = [];
  if (Array.isArray(raw)) {
    for (const id of raw) {
      if (KNOWN_AGENTS.indexOf(id) !== -1 && out.indexOf(id) === -1) out.push(id);
    }
  }
  return out.length ? out : ['claude-code'];
}

function backendFor(id) {
  return BACKENDS[id] || BACKENDS['claude-code'];
}

function nonce() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function workspaceRoot() {
  const f = vscode.workspace.workspaceFolders;
  return f && f.length ? f[0].uri.fsPath : null;
}

// The hook script ships inside the extension folder (which VS Code names by
// version), so we never point settings.json at it directly — see installHook().
const BUNDLED_HOOK = path.join(__dirname, 'hooks', 'agentyard-hook.mjs');
const AGENTYARD_DIR = path.join(os.homedir(), '.claude', 'agentyard');
const HOOK_SCRIPT = path.join(AGENTYARD_DIR, 'agentyard-hook.mjs');
const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const EVENTS_DIR = AGENTYARD_DIR;

const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // housekeeping cadence for the event log
const STALE_FILE_MS = 2 * 60 * 60 * 1000; // silence after which an events file is dead

// Copy the bundled hook to a stable, version-independent path so an extension
// update never leaves settings.json pointing at a folder VS Code has removed.
// Re-copy whenever the bundled script is newer than the installed one.
function installHook() {
  try {
    fs.mkdirSync(AGENTYARD_DIR, { recursive: true });
    let need = true;
    try {
      const src = fs.statSync(BUNDLED_HOOK);
      const dst = fs.statSync(HOOK_SCRIPT);
      need = src.mtimeMs > dst.mtimeMs || src.size !== dst.size;
    } catch (e) {
      need = true;
    }
    if (need) fs.copyFileSync(BUNDLED_HOOK, HOOK_SCRIPT);
  } catch (e) {
    /* if this fails live mode just won't have a hook to point at */
  }
}

// Bundled first-run content (shipped in the .vsix — see .vscodeignore).
const STARTER_AGENTS_DIR = path.join(__dirname, 'media', 'starter-agents');
const STARTER_GUIDELINES = path.join(__dirname, 'media', 'starter-guidelines', 'AGENTS.md');
const HELP_DIR = path.join(__dirname, 'media', 'help');
const USER_AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');

// globalState keys for the first-run wizard. `onboarded` gates the auto-open;
// `onboardedVersion` records the version it was completed on (room for a future
// one-time re-notice on a major change — off by default).
const ONBOARDED_KEY = 'agentyard.onboarded';
const ONBOARDED_VERSION_KEY = 'agentyard.onboardedVersion';

// PATH augmentation for a GUI-launched editor is computed once (an existence
// scan of ~12 dirs) and reused for every spawn. See shared/claudeResolve.js.
let _augmentedEnv = null;
function augmentedEnv() {
  if (_augmentedEnv) return _augmentedEnv;
  const cur = process.env.PATH || process.env.Path || '';
  const { value, added } = claudeResolve.augmentPath(
    cur, os.homedir(), process.platform, (p) => { try { return fs.existsSync(p); } catch (e) { return false; } }
  );
  const env = { ...process.env };
  if (process.platform === 'win32') env.Path = value;
  env.PATH = value;
  _augmentedEnv = { env, added };
  return _augmentedEnv;
}

// First line / first ~256 bytes of a file, for shebang detection — never reads
// a whole binary.
function readHead(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n);
  } catch (e) {
    return '';
  }
}

// Rewrite a resolved { file, args } claude target to run under VS Code's bundled
// Node when it is a `#!…node` script (removes the separate-`node`-on-PATH
// dependency that causes posix_spawnp failures). No-op for a real binary / Windows.
function withNodeShebang(target) {
  if (!target) return target;
  return claudeResolve.nodeShebangTarget(target, {
    readHead,
    execPath: process.execPath,
    platform: process.platform,
  });
}

const DEMO = {
  db: path.join(__dirname, 'dev-data', 'demo.db'),
  depts: path.join(__dirname, 'dev-data', 'agents'),
  team: path.join(__dirname, 'dev-data', 'team'),
  dataMode: 'demo',
  watch: false,
};

function dirHasMarkdown(dir) {
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.md'));
  } catch (e) {
    return false;
  }
}

// Any Claude Code hook log (events-*.jsonl) touched within the stale-file
// window — i.e. some coding agent is or was very recently active.
function hasRecentLiveActivity() {
  const now = Date.now();
  try {
    return fs.readdirSync(EVENTS_DIR).some((f) => {
      if (!/^events-.*\.jsonl$/.test(f)) return false;
      try {
        return now - fs.statSync(path.join(EVENTS_DIR, f)).mtimeMs < STALE_FILE_MS;
      } catch (e) {
        return false;
      }
    });
  } catch (e) {
    return false;
  }
}

function paths() {
  const cfg = vscode.workspace.getConfiguration('agentyard');
  const pollSeconds = cfg.get('pollSeconds', 3);
  const root = workspaceRoot();
  if (!root) return { ...DEMO, pollSeconds };
  const db = path.join(root, cfg.get('dbPath', 'state/company.db'));
  const depts = path.join(root, cfg.get('agentsGlob', '.claude/agents'));
  // v1.1: a ROSTER — not company.db — is what makes this "workspace" mode. A
  // roster exists if the workspace .claude/agents has .md files, or the user's
  // ~/.claude/agents does, or any coding agent has recent live activity.
  // company.db missing just leaves the board / annex layers empty.
  const hasRoster =
    dirHasMarkdown(depts) ||
    dirHasMarkdown(USER_AGENTS_DIR) ||
    hasRecentLiveActivity();
  if (!hasRoster) return { ...DEMO, pollSeconds, root };
  let team = path.join(root, 'templates', 'project-repo', '.claude', 'agents');
  if (!fs.existsSync(team)) team = DEMO.team;
  return { root, db, depts, team, dataMode: 'workspace', watch: true, pollSeconds };
}

// Roster files can live in the workspace .claude/agents AND the user's
// ~/.claude/agents. Read both, workspace wins on name clash.
function readAgentDir(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch (e) {
    return [];
  }
  return toDepartments(
    files.map((f) => ({ file: f, text: safeRead(path.join(dir, f)) }))
  );
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return '';
  }
}

// Minimal PATH lookup for a bare command name (no shell).
function whichSync(name) {
  if (!name) return null;
  if (path.isAbsolute(name) || /[\\/]/.test(name)) {
    try { return fs.statSync(name).isFile() ? name : null; } catch (e) { return null; }
  }
  // Process PATH first (unchanged behaviour when claude is already resolvable),
  // then the common GUI-missed install dirs from shared/claudeResolve.js.
  const dirs = claudeResolve.searchDirs(
    process.env, os.homedir(), process.platform,
    (p) => { try { return fs.existsSync(p); } catch (e) { return false; } }
  );
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, name);
    try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* keep looking */ }
  }
  return null;
}

// Resolve a Windows `.cmd`/`.bat` launcher to the real executable it forwards
// to, so we can spawn that directly with NO shell (cmd.exe is never involved,
// so there is nothing to inject into). Returns null if the shim is not a
// recognisable forwarder — the caller then refuses rather than run it unsafely.
function resolveWinLauncher(command) {
  return resolveLauncher(command, {
    which: whichSync,
    read: safeRead,
    exists: (p) => fs.existsSync(p),
    nodePath: process.execPath,
  });
}

// Resolve a configured CLI command (claude, codex, …) to a concrete
// { file, args } that can be handed to node-pty with NO shell — the same
// no-cmd.exe guarantee the headless runner keeps (see shared/winWrap.js). Tries
// the platform candidate list (name.exe -> name.cmd -> … on Windows); a
// `.cmd`/`.bat` shim is resolved to the real executable it forwards to, never
// shelled. Returns null if nothing runnable was found — the caller then tells
// the user to set an explicit path setting.
function resolvePtyCli(command, baseArgs) {
  for (const cand of candidateCommands(command, process.platform)) {
    if (needsCmdWrap(cand, process.platform)) {
      const resolved = resolveWinLauncher(cand);
      if (resolved) return { file: resolved.file, args: resolved.prefixArgs.concat(baseArgs) };
      continue;
    }
    const found = whichSync(cand);
    if (found) return { file: found, args: baseArgs.slice() };
  }
  return null;
}

// killTree() expects a child_process-shaped object. Wrap a node-pty IPty so its
// whole process tree is taken down (taskkill /T on Windows, process-group
// signal elsewhere) with no orphan `claude`.
function ptyKillHandle(pty) {
  return {
    pid: pty.pid,
    kill: (sig) => { try { pty.kill(sig); } catch (e) { /* ignore */ } },
    once: (ev, cb) => { if (ev === 'exit') pty.onExit(() => cb()); },
  };
}

function readRoster(primaryDir) {
  const userDir = path.join(os.homedir(), '.claude', 'agents');
  const byName = new Map();
  for (const d of readAgentDir(userDir)) byName.set(d.name, d);
  for (const d of readAgentDir(primaryDir)) byName.set(d.name, d); // workspace overrides
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- live event log ---------------------------------------------------
// Tails ~/.claude/agentyard/events-*.jsonl. Incremental: remembers how many
// bytes of each file it has already consumed and only parses the new tail.
class LiveLog {
  constructor(onChange) {
    this.onChange = onChange;
    this.offsets = new Map(); // file -> bytes consumed
    this.partial = new Map(); // file -> leftover partial line
    this.events = []; // newest last, capped
    this.watcher = null;
    this.pruneTimer = null;
  }

  start() {
    try {
      fs.mkdirSync(EVENTS_DIR, { recursive: true });
    } catch (e) {
      /* ignore */
    }
    this.scanAll();
    try {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(EVENTS_DIR), 'events-*.jsonl');
      this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const bump = (uri) => this.ingestFile(uri.fsPath);
      this.watcher.onDidCreate(bump);
      this.watcher.onDidChange(bump);
      this.watcher.onDidDelete((uri) => {
        this.offsets.delete(uri.fsPath);
        this.partial.delete(uri.fsPath);
      });
    } catch (e) {
      /* watcher unavailable — poll still refreshes via scanAll on interval */
    }
    this.prune();
    // Prune often, not hourly: a force-closed VS Code leaves events-*.jsonl
    // files that never got a terminal event, and we want them gone before the
    // next scanAll re-ingests a whole dead session.
    this.pruneTimer = setInterval(() => {
      this.prune();
      this.scanAll();
    }, PRUNE_INTERVAL_MS);
  }

  stop() {
    if (this.watcher) this.watcher.dispose();
    this.watcher = null;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  listFiles() {
    try {
      return fs
        .readdirSync(EVENTS_DIR)
        .filter((f) => /^events-.*\.jsonl$/.test(f))
        .map((f) => path.join(EVENTS_DIR, f));
    } catch (e) {
      return [];
    }
  }

  scanAll() {
    for (const f of this.listFiles()) this.ingestFile(f);
  }

  ingestFile(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (e) {
      return;
    }
    let from = this.offsets.get(file) || 0;
    if (stat.size < from) {
      from = 0; // truncated / rotated
      this.partial.set(file, '');
    }
    if (stat.size === from) return;
    let chunk = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(stat.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
    } catch (e) {
      return;
    }
    this.offsets.set(file, stat.size);
    const text = (this.partial.get(file) || '') + chunk;
    const lines = text.split('\n');
    this.partial.set(file, lines.pop() || '');
    let added = 0;
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s);
        if (rec && typeof rec === 'object') {
          this.events.push(rec);
          added++;
        }
      } catch (e) {
        /* skip malformed line */
      }
    }
    if (this.events.length > 4000) this.events = this.events.slice(-4000);
    if (added && this.onChange) this.onChange();
  }

  prune() {
    const now = Date.now();
    const endedSessions = new Map(); // session_id -> last end ts (ms)
    for (const e of this.events) {
      if (e && (e.hook_event_name === 'SessionEnd' || e.hook_event_name === 'Stop')) {
        const ms = Date.parse(String(e.ts || '')) || 0;
        const prev = endedSessions.get(e.session_id) || 0;
        endedSessions.set(e.session_id, Math.max(prev, ms));
      }
    }
    for (const f of this.listFiles()) {
      let drop = false;
      try {
        const st = fs.statSync(f);
        // A live session writes constantly. This many hours of silence means
        // it is dead (force-closed / crashed) even without a terminal event.
        if (now - st.mtimeMs > STALE_FILE_MS) drop = true;
      } catch (e) {
        continue;
      }
      const m = path.basename(f).match(/^events-(.*)\.jsonl$/);
      const sid = m ? m[1] : null;
      if (sid) {
        for (const [k, ts] of endedSessions) {
          const safe = k.replace(/[^A-Za-z0-9._-]/g, '_');
          if (safe === sid && now - ts > 60 * 60 * 1000) drop = true;
        }
      }
      if (drop) {
        try {
          fs.unlinkSync(f);
          this.offsets.delete(f);
          this.partial.delete(f);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  recent() {
    // keep the payload small: last ~1500 events is plenty for the scene
    return this.events.length > 1500 ? this.events.slice(-1500) : this.events;
  }
}

// ---- hooks in settings.json -----------------------------------------
function hooksInstalled() {
  const candidates = [USER_SETTINGS];
  const root = workspaceRoot();
  if (root) candidates.push(path.join(root, '.claude', 'settings.json'));
  return candidates.some((p) => hooksConfig.textHasOurHooks(safeRead(p)));
}

// If live mode was turned on by an older build, its settings.json still points
// at that build's version-named extension folder (which VS Code may have
// deleted). Re-point it at the stable path. Runs on activation.
function migrateHookPath() {
  const scriptForCmd = HOOK_SCRIPT.replace(/\\/g, '/');
  const targets = [USER_SETTINGS];
  const root = workspaceRoot();
  if (root) targets.push(path.join(root, '.claude', 'settings.json'));
  for (const p of targets) {
    let text = '';
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      continue;
    }
    if (!hooksConfig.textHasOurHooks(text)) continue;
    if (text.includes(scriptForCmd)) continue; // already stable
    const parsed = hooksConfig.parseLenient(text);
    if (text.trim() && text.trim() !== '{}' && Object.keys(parsed).length === 0) continue;
    try {
      fs.writeFileSync(p + '.agentyard-backup', text);
      const merged = hooksConfig.mergeHooks(parsed, scriptForCmd);
      fs.writeFileSync(p, JSON.stringify(merged, null, 2) + '\n');
    } catch (e) {
      /* leave it; enable/disable still work by marker */
    }
  }
}

async function enableLiveMode() {
  installHook();
  const scriptForCmd = HOOK_SCRIPT.replace(/\\/g, '/');
  const block = hooksConfig.buildHooksBlock(scriptForCmd);
  const preview = JSON.stringify({ hooks: block }, null, 2);

  const choice = await vscode.window.showInformationMessage(
    'Agentyard live mode adds these hooks to ~/.claude/settings.json so it can ' +
      'show live Claude Code activity. A backup (settings.json.agentyard-backup) is ' +
      'written first. Nothing is sent anywhere — the hook only appends local JSONL.\n\n' +
      preview,
    { modal: true },
    'Add hooks',
    'Cancel'
  );
  if (choice !== 'Add hooks') return;

  try {
    fs.mkdirSync(path.dirname(USER_SETTINGS), { recursive: true });
    let text = '';
    try {
      text = fs.readFileSync(USER_SETTINGS, 'utf8');
    } catch (e) {
      text = '';
    }
    if (text.trim()) fs.writeFileSync(USER_SETTINGS + '.agentyard-backup', text);
    const parsed = hooksConfig.parseLenient(text);
    // Don't rewrite a settings.json we couldn't understand — we'd drop the user's
    // other keys. Bail and let them fix the file (or point us at a good one).
    if (text.trim() && text.trim() !== '{}' && Object.keys(parsed).length === 0) {
      vscode.window.showErrorMessage(
        'Agentyard could not parse ~/.claude/settings.json, so it will not modify it. ' +
          'Fix the JSON there and try again.'
      );
      return;
    }
    const merged = hooksConfig.mergeHooks(parsed, scriptForCmd);
    fs.writeFileSync(USER_SETTINGS, JSON.stringify(merged, null, 2) + '\n');
    vscode.window.showInformationMessage(
      'Agentyard live mode is on. New Claude Code sessions will show up here. ' +
        (text.includes('//') || text.includes('/*')
          ? 'Note: comments in your settings.json were not preserved (a backup was saved).'
          : '')
    );
  } catch (e) {
    vscode.window.showErrorMessage('Agentyard could not update settings.json: ' + e.message);
  }
}

async function disableLiveMode() {
  const targets = [USER_SETTINGS];
  const root = workspaceRoot();
  if (root) targets.push(path.join(root, '.claude', 'settings.json'));
  let touched = 0;
  for (const p of targets) {
    let text = '';
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      continue;
    }
    if (!hooksConfig.textHasOurHooks(text)) continue;
    try {
      if (text.trim()) fs.writeFileSync(p + '.agentyard-backup', text);
      const parsed = hooksConfig.parseLenient(text);
      if (text.trim() && text.trim() !== '{}' && Object.keys(parsed).length === 0) {
        vscode.window.showErrorMessage(
          'Agentyard could not parse ' + p + ', so it will not modify it. Remove its ' +
            'hook entries manually (lines mentioning agentyard-hook.mjs).'
        );
        continue;
      }
      const cleaned = hooksConfig.removeHooks(parsed);
      fs.writeFileSync(p, JSON.stringify(cleaned, null, 2) + '\n');
      touched++;
    } catch (e) {
      vscode.window.showErrorMessage('Agentyard could not update ' + p + ': ' + e.message);
    }
  }
  vscode.window.showInformationMessage(
    touched
      ? 'Agentyard live mode is off. Its hooks were removed from settings.json.'
      : 'Agentyard found no live-mode hooks to remove.'
  );
}

// ---- run Claude Code from the panel --------------------------------
// One run at a time. Spawns `claude -p "<prompt>" --output-format stream-json
// --verbose` with the user's existing CLI auth (no API key, no metered
// billing). The prompt is always a spawn arg, never a shell string. stdout is
// parsed to feed items and forwarded to the webview only — nothing is written
// to disk here.
class RunController {
  constructor(post) {
    this.post = post; // (msg) => void, to the webview
    this.child = null;
    this.parser = null;
    this.sessionId = null; // last claude session id, for --resume
    this.running = false;
    this.stderrBuf = '';
  }

  dispose() {
    this.cancel();
  }

  pushStatus() {
    this.post({
      type: 'run',
      event: 'status',
      running: this.running,
      sessionId: this.sessionId,
      hasWorkspace: !!workspaceRoot(),
    });
  }

  newThread() {
    if (this.running) return;
    this.sessionId = null;
    this.pushStatus();
  }

  send(prompt, resume) {
    if (this.running) {
      this.post({ type: 'run', event: 'error', message: 'A run is already in progress.' });
      return;
    }
    prompt = String(prompt == null ? '' : prompt);
    if (!prompt.trim()) return;
    // The headless feed is Claude Code only (v1.1). A Codex-only install must use
    // the interactive terminal Run view — headless Codex is a v1.2 follow-up.
    if (enabledAgents().indexOf('claude-code') === -1) {
      this.post({
        type: 'run', event: 'error',
        message: 'The headless Run view supports Claude Code only. Set agentyard.runView to "terminal" to use Codex.',
      });
      return;
    }
    const root = workspaceRoot();
    if (!root) {
      this.post({ type: 'run', event: 'error', message: 'Open a workspace folder first — runs use the folder as the working directory.' });
      return;
    }

    const cfg = vscode.workspace.getConfiguration('agentyard');
    let built;
    try {
      built = buildClaudeArgs({
        claudePath: cfg.get('claudePath', 'claude'),
        prompt,
        resume: resume ? this.sessionId : null,
        permissionMode: cfg.get('claudePermissionMode', 'default'),
        extraArgs: cfg.get('claudeExtraArgs', []),
      });
    } catch (e) {
      this.post({ type: 'run', event: 'error', message: 'Bad Agentyard run config: ' + e.message });
      return;
    }

    const candidates = candidateCommands(built.command, process.platform);
    this.parser = new StreamJsonParser();
    this.stderrBuf = '';
    this.running = true;
    this.post({
      type: 'run',
      event: 'started',
      prompt,
      resumed: !!(resume && this.sessionId),
      resumeId: resume ? this.sessionId : null,
    });
    this.pushStatus();
    this._spawn(candidates, 0, built.args, root);
  }

  _spawn(candidates, i, args, cwd) {
    if (i >= candidates.length) {
      this._fail(
        claudeResolve.friendlySpawnMessage(
          { message: 'not found on PATH' },
          candidates[0],
          process.platform
        )
      );
      return;
    }
    const command = candidates[i];
    let file = command;
    let spawnArgs = args;
    // Augmented PATH so a GUI-launched editor can still find `claude` and its
    // `node` interpreter (see shared/claudeResolve.js).
    const opts = { cwd, env: { ...augmentedEnv().env }, windowsHide: true, ...spawnGroupOpts(process.platform) };

    if (needsCmdWrap(command, process.platform)) {
      // There is no safe way to pass a prompt through cmd.exe, so we never do.
      // Resolve the shim to the real executable it forwards to and spawn that
      // directly (no shell). If it can't be resolved, skip this candidate — the
      // exhaustion path below tells the user to set an explicit claudePath.
      const resolved = resolveWinLauncher(command);
      if (!resolved) {
        this._spawn(candidates, i + 1, args, cwd);
        return;
      }
      file = resolved.file;
      spawnArgs = resolved.prefixArgs.concat(args);
    } else {
      // Resolve to a concrete path so a `#!…node` script can be run under the
      // editor's bundled Node instead of relying on `node` being on PATH.
      const resolved = whichSync(command);
      if (resolved) {
        const tgt = withNodeShebang({ file: resolved, args: spawnArgs.slice() });
        file = tgt.file;
        spawnArgs = tgt.args;
        if (tgt.env) opts.env = { ...opts.env, ...tgt.env };
      }
    }

    let child;
    try {
      child = cp.spawn(file, spawnArgs, opts);
    } catch (e) {
      if (i + 1 < candidates.length) { this._spawn(candidates, i + 1, args, cwd); return; }
      this._fail(claudeResolve.friendlySpawnMessage(e, candidates[0], process.platform));
      return;
    }
    this.child = child;

    // The prompt is passed as an argv (`-p "<prompt>"`) and nothing is piped
    // in, so close stdin immediately — otherwise `claude -p` waits on it and
    // prints "no stdin data received in 3s" to stderr.
    if (child.stdin) {
      try { child.stdin.end(); } catch (e) { /* ignore */ }
    }

    let sawData = false;
    child.on('error', (err) => {
      if (this.child !== child) return;
      if (!sawData && (err.code === 'ENOENT' || err.code === 'EINVAL') && i + 1 < candidates.length) {
        this.child = null;
        this._spawn(candidates, i + 1, args, cwd);
        return;
      }
      if (!sawData && claudeResolve.isExecFailure(err)) {
        this._fail(claudeResolve.friendlySpawnMessage(err, candidates[0], process.platform));
        return;
      }
      this._fail('claude process error: ' + err.message);
    });

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        sawData = true;
        const items = this.parser.push(d);
        if (this.parser.sessionId) this.sessionId = this.parser.sessionId;
        for (const it of items) this.post({ type: 'run', event: 'item', item: it });
        if (items.length) this.pushStatus();
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        this.stderrBuf = (this.stderrBuf + d).slice(-4000);
        this.post({ type: 'run', event: 'stderr', text: String(d).replace(/\s+$/, '') });
      });
    }

    child.on('close', (code, signal) => {
      if (this.child !== child) return;
      const tail = this.parser ? this.parser.flush() : [];
      if (this.parser && this.parser.sessionId) this.sessionId = this.parser.sessionId;
      for (const it of tail) this.post({ type: 'run', event: 'item', item: it });
      this.running = false;
      this.child = null;
      this.parser = null;
      this.post({
        type: 'run',
        event: 'ended',
        code: typeof code === 'number' ? code : null,
        signal: signal || null,
        sessionId: this.sessionId,
        stderr: (code && this.stderrBuf.trim()) ? this.stderrBuf.trim().slice(-800) : null,
      });
      this.pushStatus();
    });
  }

  _fail(message) {
    this.running = false;
    if (this.child) {
      try { this.child.removeAllListeners(); } catch (e) { /* ignore */ }
    }
    this.child = null;
    this.parser = null;
    this.post({ type: 'run', event: 'error', message });
    this.post({ type: 'run', event: 'ended', code: null, signal: null, sessionId: this.sessionId });
    this.pushStatus();
  }

  cancel() {
    const child = this.child;
    if (!child) return;
    this.post({ type: 'run', event: 'stderr', text: '^C cancelling…' });
    killTree(child).then((ok) => {
      if (!ok) this.post({ type: 'run', event: 'stderr', text: 'process may still be exiting' });
    });
    // the 'close' handler above emits 'ended' and clears state
  }
}

// ---- run a coding agent in an embedded terminal -------------------
// The Run view's xterm.js surface talks to this over the webview postMessage
// channel. ONE instance per enabled backend (Claude Code, Codex, …), each with
// its own pty, kept here in the extension host so a webview reload re-attaches
// to the running session instead of restarting it. Spawns the user's own
// INTERACTIVE CLI (never `-p`) with their existing CLI auth — no API key. The
// command is always an argv array through node-pty, so there is no shell and
// cmd.exe is never involved (v0.4 guarantee — kept for every backend).
class TerminalRun {
  constructor(post, backend) {
    this._postRaw = post; // (msg) => void, to the webview
    this.backend = backend || BACKENDS['claude-code'];
    this.pty = null;
    this.cols = 80;
    this.rows = 24;
    this.buffer = []; // recent output chunks, replayed on re-attach
    this.bufferLen = 0;
  }

  // Every message this backend posts is tagged with its id so the webview
  // routes it to the right terminal surface.
  _post(msg) {
    msg.backend = this.backend.id;
    this._postRaw(msg);
  }

  _bufferPush(data) {
    this.buffer.push(data);
    this.bufferLen += data.length;
    const CAP = 256 * 1024; // enough to redraw a scrollback on reload, bounded
    while (this.bufferLen > CAP && this.buffer.length > 1) {
      this.bufferLen -= this.buffer.shift().length;
    }
  }

  _say(text) {
    this._post({ type: 'term', event: 'data', data: text });
  }

  // A resolve/spawn failure: print the friendly message in the terminal AND
  // post an actionable notice so the panel can show [설정 열기] / [진단 실행] /
  // [도움말] buttons (no browser dialog).
  _failSpawn(message, raw) {
    this._say('\r\n\x1b[31m' + String(message).replace(/\n/g, '\r\n') + '\x1b[0m\r\n');
    this._post({ type: 'term', event: 'spawn-failed', message: String(message), raw: raw || null });
  }

  // The webview's terminal has connected — first load, or after a reload.
  attach(cols, rows) {
    if (cols > 0 && rows > 0) { this.cols = cols; this.rows = rows; }
    if (this.pty) {
      try { this.pty.resize(this.cols, this.rows); } catch (e) { /* ignore */ }
      this._say(this.buffer.join(''));
      return;
    }
    if (!nodePty) {
      this._post({ type: 'term', event: 'unavailable', message: PTY_UNAVAILABLE_NOTICE });
      return;
    }
    this._spawn();
  }

  _spawn() {
    const root = workspaceRoot();
    if (!root) {
      this._say('\r\n\x1b[33mOpen a workspace folder first — the terminal uses it as the ' +
        'working directory.\x1b[0m\r\n');
      return;
    }
    const cfg = vscode.workspace.getConfiguration('agentyard');
    let built;
    try {
      built = this.backend.buildInteractiveArgs(cfg);
    } catch (e) {
      this._say('\r\n\x1b[31mBad Agentyard run config: ' + e.message + '\x1b[0m\r\n');
      return;
    }

    const resolved = resolvePtyCli(built.command, built.args);
    if (!resolved) {
      this._failSpawn(claudeResolve.friendlySpawnMessage(
        { message: 'not found on PATH' }, built.command, process.platform, this.backend.id));
      return;
    }
    // Run a `#!…node` CLI script under VS Code's bundled Node so it doesn't
    // depend on `node` being on the (minimal, GUI-inherited) PATH.
    const target = withNodeShebang(resolved);
    const env = { ...augmentedEnv().env };
    if (target.env) Object.assign(env, target.env);

    let pty;
    try {
      pty = nodePty.spawn(target.file, target.args, {
        name: 'xterm-256color',
        cwd: root,
        env,
        cols: this.cols,
        rows: this.rows,
      });
    } catch (e) {
      this._failSpawn(
        claudeResolve.friendlySpawnMessage(e, built.command, process.platform, this.backend.id),
        e.message
      );
      return;
    }

    this.pty = pty;
    this.buffer = [];
    this.bufferLen = 0;
    pty.onData((d) => {
      if (this.pty !== pty) return;
      this._bufferPush(d);
      this._post({ type: 'term', event: 'data', data: d });
    });
    pty.onExit((e) => {
      if (this.pty !== pty) return;
      this.pty = null;
      const code = e && typeof e.exitCode === 'number' ? e.exitCode : null;
      this._post({ type: 'term', event: 'exit', code });
    });
  }

  input(data) {
    if (this.pty) {
      try { this.pty.write(data); } catch (e) { /* ignore */ }
      return;
    }
    // Typing into an exited terminal starts a fresh session.
    if (nodePty && workspaceRoot()) this._spawn();
  }

  resize(cols, rows) {
    if (cols > 0 && rows > 0) { this.cols = cols; this.rows = rows; }
    if (this.pty) {
      try { this.pty.resize(this.cols, this.rows); } catch (e) { /* ignore */ }
    }
  }

  async newThread() {
    await this._killPty();
    this._say('\x1bc'); // full terminal reset
    this._spawn();
  }

  _killPty() {
    const pty = this.pty;
    this.pty = null;
    if (!pty) return Promise.resolve(true);
    return killTree(ptyKillHandle(pty), { platform: process.platform });
  }

  dispose() {
    this._killPty();
  }
}

// ---- clipboard + attachments for the Run view ---------------------
// xterm.js has no clipboard behaviour of its own, and a webview's
// navigator.clipboard is inconsistent across VS Code versions and focus states,
// so the webview asks the extension host to read/write the system clipboard.
// Attachments (picked files, pasted/dropped images) are turned into an input
// string here — image bytes are written to a generated path strictly inside the
// first workspace folder, size-guarded, and never logged.
async function readClipboardText() {
  try {
    return await vscode.env.clipboard.readText();
  } catch (e) {
    return '';
  }
}

async function writeClipboardText(text) {
  try {
    await vscode.env.clipboard.writeText(String(text == null ? '' : text));
  } catch (e) {
    /* ignore — nothing else depends on the write succeeding */
  }
}

// ---- webview -------------------------------------------------------
function getHtml(webview, extUri, context) {
  const n = nonce();
  const asset = (...seg) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'webview', ...seg)).toString();
  const wasmUrl = asset('vendor', 'sql-wasm.wasm');
  const cfg = vscode.workspace.getConfiguration('agentyard');
  // The Run view runs a real terminal unless the user asked for the old headless
  // feed, or node-pty could not load on this platform.
  const runViewRequested = cfg.get('runView', 'terminal') === 'headless' ? 'headless' : 'terminal';
  const ptyAvailable = !!nodePty;
  const runView = (runViewRequested === 'terminal' && ptyAvailable) ? 'terminal' : 'headless';
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    // sql.js fetches its .wasm at runtime; without connect-src the webview
    // hangs forever on "loading Agentyard…" because the DB never loads.
    `connect-src ${webview.cspSource}`,
    `script-src 'nonce-${n}' 'wasm-unsafe-eval'`,
  ].join('; ');

  const scripts = ['vendor/sql-wasm.js', 'vendor/xterm.js', 'vendor/xterm-addon-fit.js',
    'js/palette.js', 'js/sprites.js', 'js/db.js', 'js/adapter.js', 'js/live.js', 'js/model.js',
    'js/render.js', 'js/termclip.js', 'js/run.js', 'js/term.js', 'js/onboard.js', 'js/main.js']
    .map((s) => `<script nonce="${n}" src="${asset(...s.split('/'))}"></script>`)
    .join('\n  ');

  const onboarded = !!(context && context.globalState && context.globalState.get(ONBOARDED_KEY));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${asset('css', 'style.css')}" />
  <link rel="stylesheet" href="${asset('vendor', 'xterm.css')}" />
  <title>Agentyard</title>
</head>
<body class="panel">
  <div id="app">
    <header id="topbar">
      <span class="brand">AGENTYARD<span class="ver" id="brand-ver"></span></span>
      <button type="button" id="help-btn" title="도움말 · 설정 안내" aria-label="도움말 열기">?</button>
      <span id="view-toggle">
        <button type="button" data-view="office" class="on">Office</button>
        <button type="button" data-view="run">Run</button>
      </span>
    </header>
    <div id="office-pane">
      <div id="office-banner" hidden></div>
      <div id="stage-wrap"><canvas id="scene" width="840" height="600"></canvas></div>
      <aside id="panel"></aside>
      <div id="status">connecting…</div>
    </div>
    <div id="ay-overlay" hidden><div id="ay-overlay-card" role="dialog" aria-modal="true"></div></div>
    <div id="run-pane" hidden>
      <div id="run-notice" hidden></div>
      <div id="run-term" hidden></div>
      <div id="run-term-foot" hidden>
        <span id="run-backend-switch" hidden></span>
        <button type="button" id="run-term-attach" class="attach-btn" title="Attach a file or image">📎 Attach</button>
        <button type="button" id="run-term-new">New thread</button>
        <span id="run-term-meta"></span>
      </div>
      <div id="run-feed"></div>
      <div id="run-bar">
        <div id="run-hint" hidden></div>
        <div id="run-input-row">
          <button type="button" id="run-attach" class="attach-btn" title="Attach a file or image">📎</button>
          <textarea id="run-input" rows="1" placeholder="Send a prompt to Claude Code in this workspace…"></textarea>
          <button type="button" id="run-send">Send</button>
          <button type="button" id="run-cancel" hidden>Cancel</button>
        </div>
        <div id="run-foot">
          <button type="button" id="run-new">New thread</button>
          <span id="run-meta"></span>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${n}">
    window.AY_CONFIG = { mode: 'vscode', version: ${JSON.stringify(pkg.version)}, pollSeconds: ${JSON.stringify(cfg.get('pollSeconds', 3))}, wasmUrl: ${JSON.stringify(wasmUrl)}, runView: ${JSON.stringify(runView)}, runViewRequested: ${JSON.stringify(runViewRequested)}, ptyAvailable: ${JSON.stringify(ptyAvailable)}, platform: ${JSON.stringify(process.platform)}, agents: ${JSON.stringify(enabledAgents())}, terminalCopyPaste: ${JSON.stringify(cfg.get('terminalCopyPaste', true))}, copyOnSelection: ${JSON.stringify(cfg.get('copyOnSelection', false))}, onboarded: ${JSON.stringify(onboarded)} };
  </script>
  ${scripts}
</body>
</html>`;
}

function collectSnapshot(live) {
  const p = paths();
  const cfg = vscode.workspace.getConfiguration('agentyard');
  // v1.1: a missing company.db is NOT an error. The roster + live activity
  // drive the scene; the board / annex layers just stay empty.
  let dbBase64 = '';
  try {
    dbBase64 = fs.readFileSync(p.db).toString('base64');
  } catch (e) {
    dbBase64 = '';
  }
  const departments = p.dataMode === 'demo' ? readAgentDir(p.depts) : readRoster(p.depts);
  return {
    type: 'data',
    dataMode: p.dataMode,
    departments,
    teamRoles: readAgentDir(p.team),
    dbBase64,
    liveEvents: live ? live.recent() : [],
    hooksInstalled: hooksInstalled(),
    idleSeconds: cfg.get('idleSeconds', 30),
    staleMinutes: cfg.get('staleMinutes', 15),
    staleWorkingHours: cfg.get('staleWorkingHours', 3),
    maxSpritesPerRoom: cfg.get('maxSpritesPerRoom', 8),
    platform: process.platform, // §7: case-insensitive local_path match on win32
    nowMs: Date.now(),
    // first-run guidance: is there a workspace, and does it have any departments?
    hasWorkspace: !!workspaceRoot(),
    rosterEmpty: p.dataMode === 'workspace' && departments.length === 0,
    userRosterCount: readAgentDir(USER_AGENTS_DIR).length,
    agents: enabledAgents(),
    guideline: guidelineState(p.root),
  };
}

// Presence + sync state of the enabled backends' instruction files at the
// workspace root. A hint for the banner / guidelines command — never an error.
function guidelineState(root) {
  if (!root) return { agentsMd: 'absent', claudeMd: 'absent', sync: 'n/a' };
  const aText = safeRead(path.join(root, 'AGENTS.md'));
  const cText = safeRead(path.join(root, 'CLAUDE.md'));
  const a = !!aText.trim();
  const c = !!cText.trim();
  return {
    agentsMd: a ? 'present' : 'absent',
    claudeMd: !c ? 'absent' : (guidelines.isPointer(cText) ? 'pointer' : 'present'),
    sync: guidelines.classify({ agentsMd: a, claudeMd: c, claudeText: cText }),
  };
}

// ---- first-run: starter agents, diagnostics -----------------------
// Copy the picked bundled starter agents into ~/.claude/agents/. Non-destructive
// — an existing file is left untouched and reported as such.
function createStarterAgents(names) {
  const want = Array.isArray(names) && names.length
    ? names
    : ['research', 'engineering', 'growth', '_template'];
  const results = [];
  try {
    fs.mkdirSync(USER_AGENTS_DIR, { recursive: true });
  } catch (e) {
    return { dir: USER_AGENTS_DIR, error: e.message, results };
  }
  for (const raw of want) {
    const name = String(raw).replace(/[^A-Za-z0-9_-]/g, '');
    if (!name) continue;
    const src = path.join(STARTER_AGENTS_DIR, name + '.md');
    const dst = path.join(USER_AGENTS_DIR, name + '.md');
    if (!fs.existsSync(src)) { results.push({ name, state: 'unknown' }); continue; }
    if (fs.existsSync(dst)) { results.push({ name, state: 'exists', path: dst }); continue; }
    try {
      fs.copyFileSync(src, dst);
      results.push({ name, state: 'created', path: dst });
    } catch (e) {
      results.push({ name, state: 'error', message: e.message });
    }
  }
  return { dir: USER_AGENTS_DIR, results };
}

function listStarterAgents() {
  let files = [];
  try {
    files = fs.readdirSync(STARTER_AGENTS_DIR).filter((f) => f.endsWith('.md'));
  } catch (e) {
    return [];
  }
  return files.map((f) => {
    const name = f.replace(/\.md$/, '');
    const { attrs } = require('./shared/frontmatter.js').parseFrontmatter(safeRead(path.join(STARTER_AGENTS_DIR, f)));
    return {
      name,
      description: attrs.description || '',
      model: attrs.model || 'sonnet',
      exists: fs.existsSync(path.join(USER_AGENTS_DIR, f)),
      template: name.charAt(0) === '_',
    };
  });
}

// Read the bundled help markdown files (media/help/NN-<id>.md) in name order.
function helpTopics() {
  let files = [];
  try {
    files = fs.readdirSync(HELP_DIR).filter((f) => f.endsWith('.md')).sort();
  } catch (e) {
    return [];
  }
  return files.map((f) => {
    const text = safeRead(path.join(HELP_DIR, f));
    const m = text.match(/^#\s+(.+)$/m);
    return {
      id: f.replace(/^\d+-/, '').replace(/\.md$/, ''),
      title: m ? m[1].trim() : f,
      markdown: text,
    };
  });
}

// Resolve a configured CLI command to a concrete target for diagnostics / the
// first-run picker. CLI-agnostic — the same probe for `claude` and `codex`.
function diagnoseCli(command) {
  const out = { command, resolved: null, shebang: null, viaAugment: false };
  for (const cand of candidateCommands(command, process.platform)) {
    if (needsCmdWrap(cand, process.platform)) {
      const r = resolveWinLauncher(cand);
      if (r) { out.resolved = r.file; break; }
      continue;
    }
    const found = whichSync(cand);
    if (found) {
      out.resolved = found;
      const head = readHead(found);
      if (claudeResolve.isNodeShebang(head)) {
        out.shebang = head.split('\n', 1)[0];
      }
      const pathDirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).map((d) => d.replace(/[\\/]+$/, ''));
      out.viaAugment = !pathDirs.includes(path.dirname(found).replace(/[\\/]+$/, ''));
      break;
    }
  }
  return out;
}

function diagnoseClaude() {
  return diagnoseCli(vscode.workspace.getConfiguration('agentyard').get('claudePath', 'claude'));
}

function diagnoseCodex() {
  return diagnoseCli(vscode.workspace.getConfiguration('agentyard').get('codexPath', 'codex'));
}

function buildDiagnostics() {
  const cfg = vscode.workspace.getConfiguration('agentyard');
  const p = paths();
  const cl = diagnoseClaude();
  const aug = augmentedEnv();
  const L = [];
  L.push('Agentyard Diagnostics — ' + new Date().toISOString());
  L.push('');
  L.push('platform          : ' + process.platform + ' ' + process.arch);
  L.push('VS Code           : ' + vscode.version);
  L.push('extension         : agentyard ' + pkg.version);
  L.push('node (execPath)    : ' + process.execPath);
  L.push('');
  L.push('enabled agents     : ' + enabledAgents().join(', '));
  L.push('claude (configured): ' + cl.command);
  L.push('claude (resolved)  : ' + (cl.resolved || 'NOT FOUND on PATH or common install dirs'));
  if (cl.resolved) {
    L.push('  via PATH augment : ' + (cl.viaAugment ? 'yes' : 'no'));
    L.push('  shebang script   : ' + (cl.shebang ? cl.shebang + '  → run under VS Code Node' : 'no (native binary)'));
  }
  const cx = diagnoseCodex();
  L.push('codex (configured) : ' + cx.command);
  L.push('codex (resolved)   : ' + (cx.resolved || 'NOT FOUND on PATH or common install dirs'));
  L.push('PATH dirs added    : ' + (aug.added.length ? aug.added.join(', ') : '(none — PATH already had them or they do not exist)'));
  L.push('');
  L.push('node-pty          : ' + (nodePty ? 'loaded' : 'NOT loaded — ' + (nodePtyError || 'unknown') + ' (Run view falls back to headless)'));
  L.push('data mode         : ' + p.dataMode);
  L.push('  db              : ' + p.db + (fs.existsSync(p.db) ? ' (exists)' : ' (missing)'));
  L.push('  agents dir      : ' + p.depts + (fs.existsSync(p.depts) ? '' : ' (missing)'));
  L.push('user roster       : ' + USER_AGENTS_DIR + ' — ' + readAgentDir(USER_AGENTS_DIR).length + ' file(s)');
  L.push('workspace roster  : ' + (workspaceRoot()
    ? (p.dataMode === 'workspace' ? readAgentDir(p.depts).length + ' file(s)' : 'n/a (demo mode)')
    : 'no workspace folder open'));
  L.push('');
  L.push('settings');
  for (const k of ['agents', 'claudePath', 'claudePermissionMode', 'codexPath', 'runView', 'pollSeconds', 'dbPath', 'agentsGlob', 'staleWorkingHours']) {
    L.push('  agentyard.' + k + ' = ' + JSON.stringify(cfg.get(k)));
  }
  return L.join('\n');
}

let _diagChannel = null;
function showDiagnostics() {
  if (!_diagChannel) _diagChannel = vscode.window.createOutputChannel('Agentyard');
  _diagChannel.clear();
  _diagChannel.appendLine(buildDiagnostics());
  _diagChannel.show(true);
}

class OfficeViewProvider {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.timer = null;
    this.watchers = [];
    this.live = new LiveLog(() => this.pushData());
    this.run = new RunController((m) => {
      if (this.view) this.view.webview.postMessage(m);
    });
    // One embedded terminal per enabled backend, lazily created on first attach.
    this.terms = new Map(); // backend id -> TerminalRun
  }

  termFor(id) {
    const backend = backendFor(id);
    let t = this.terms.get(backend.id);
    if (!t) {
      t = new TerminalRun((m) => { if (this.view) this.view.webview.postMessage(m); }, backend);
      this.terms.set(backend.id, t);
    }
    return t;
  }

  disposeTerms() {
    for (const t of this.terms.values()) t.dispose();
    this.terms.clear();
  }

  pushData() {
    if (!this.view) return;
    this.view.webview.postMessage(collectSnapshot(this.live));
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  // Run-view clipboard bridge. `write` puts the terminal selection on the system
  // clipboard; `read` sends the clipboard text back so the webview can paste it.
  handleClip(msg) {
    if (msg.action === 'write') {
      writeClipboardText(msg.text);
    } else if (msg.action === 'read') {
      readClipboardText().then((text) => this.post({ type: 'clip', event: 'text', text }));
    }
  }

  // Run-view attachments. `pick` opens the native file dialog; `image` writes
  // pasted/dropped image bytes to a generated path inside the workspace. Both
  // reply with the exact text to splice into the input line — nothing is
  // submitted, and neither the bytes nor the prompt are logged.
  async handleAttach(msg) {
    const cfg = vscode.workspace.getConfiguration('agentyard');
    const root = workspaceRoot();
    try {
      if (msg.action === 'pick') {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Attach',
        });
        if (!uris || !uris.length) return;
        const text = attach.buildPathInsert(uris.map((u) => u.fsPath));
        if (text) this.post({ type: 'attach', event: 'insert', text });
        return;
      }
      if (msg.action === 'paths') {
        // Drag & drop handed us real filesystem paths — quote them the same way
        // as picked files (single source of truth in shared/attach.js).
        const text = attach.buildPathInsert(Array.isArray(msg.paths) ? msg.paths : []);
        if (text) this.post({ type: 'attach', event: 'insert', text });
        return;
      }
      if (msg.action === 'image') {
        if (!root) {
          vscode.window.showWarningMessage('Open a folder to attach files.');
          return;
        }
        let bytes;
        try {
          bytes = Buffer.from(String(msg.b64 || ''), 'base64');
        } catch (e) {
          return;
        }
        const target = attach.writePastedImage({
          root,
          dir: cfg.get('attachmentsDir', attach.DEFAULT_ATTACHMENTS_DIR),
          bytes,
          maxMB: cfg.get('maxAttachmentMB', attach.DEFAULT_MAX_ATTACHMENT_MB),
          now: new Date(),
          mime: msg.mime,
        });
        this.post({ type: 'attach', event: 'insert', text: attach.buildPathInsert([target]) });
      }
    } catch (e) {
      vscode.window.showWarningMessage('Agentyard attach: ' + e.message);
    }
  }

  // Called on Run-view init and on "New thread". Removes the attachments folder
  // unless agentyard.keepAttachments is set. Only ever touches <workspace>/<dir>.
  clearAttachments() {
    const cfg = vscode.workspace.getConfiguration('agentyard');
    if (cfg.get('keepAttachments', false)) return;
    const root = workspaceRoot();
    if (!root) return;
    attach.clearAttachmentsDir(root, cfg.get('attachmentsDir', attach.DEFAULT_ATTACHMENTS_DIR));
  }

  // ---- first-run wizard + help bridge -----------------------------
  // The webview owns the wizard/help UI (in-panel views, no browser dialog);
  // the host answers with globalState, bundled content, and filesystem writes.
  handleOnboard(msg) {
    const gs = this.context.globalState;
    if (msg.action === 'get') {
      this.post({
        type: 'onboard', event: 'state',
        onboarded: !!gs.get(ONBOARDED_KEY),
        hasWorkspace: !!workspaceRoot(),
        claude: diagnoseClaude(),
        codex: diagnoseCodex(),
        agents: enabledAgents(),
        starters: listStarterAgents(),
        userAgentsDir: USER_AGENTS_DIR,
      });
      return;
    }
    if (msg.action === 'done') {
      gs.update(ONBOARDED_KEY, true);
      gs.update(ONBOARDED_VERSION_KEY, pkg.version);
      this.post({ type: 'onboard', event: 'state', onboarded: true });
      return;
    }
    if (msg.action === 'reset') { // internal / test affordance, not surfaced in UI
      gs.update(ONBOARDED_KEY, false);
      return;
    }
    if (msg.action === 'detectClaude') {
      this.post({ type: 'onboard', event: 'claude', claude: diagnoseClaude() });
      return;
    }
    if (msg.action === 'detectClis') {
      this.post({ type: 'onboard', event: 'clis', claude: diagnoseClaude(), codex: diagnoseCodex() });
      return;
    }
    if (msg.action === 'setClaudePath') {
      const v = String(msg.path || '').trim();
      vscode.workspace.getConfiguration('agentyard')
        .update('claudePath', v || undefined, vscode.ConfigurationTarget.Global)
        .then(() => this.post({ type: 'onboard', event: 'claude', claude: diagnoseClaude() }));
      return;
    }
    if (msg.action === 'setAgents') {
      const list = Array.isArray(msg.agents)
        ? msg.agents.filter((x) => KNOWN_AGENTS.indexOf(x) !== -1)
        : [];
      const val = list.length ? Array.from(new Set(list)) : ['claude-code'];
      vscode.workspace.getConfiguration('agentyard')
        .update('agents', val, vscode.ConfigurationTarget.Global)
        .then(() => {
          this.post({
            type: 'onboard', event: 'clis',
            agents: enabledAgents(), claude: diagnoseClaude(), codex: diagnoseCodex(),
          });
          this.pushData();
        });
      return;
    }
    if (msg.action === 'createAgents') {
      const res = createStarterAgents(msg.names);
      this.post({ type: 'onboard', event: 'created', result: res, starters: listStarterAgents() });
      this.pushData();
      return;
    }
    if (msg.action === 'openAgent') {
      const name = String(msg.name || '').replace(/[^A-Za-z0-9_-]/g, '');
      if (name) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(USER_AGENTS_DIR, name + '.md')));
      return;
    }
    if (msg.action === 'openAgentsFolder') {
      try { fs.mkdirSync(USER_AGENTS_DIR, { recursive: true }); } catch (e) { /* ignore */ }
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(USER_AGENTS_DIR));
    }
  }

  handleHelp(msg) {
    if (msg.action === 'list' || msg.action === 'get') {
      this.post({ type: 'help', event: 'topics', topics: helpTopics() });
    }
  }

  // `Agentyard: Setup Guide` — open the wizard even if it's the first time the
  // panel is being shown (the webview may still be resolving).
  openSetupGuide() {
    vscode.commands.executeCommand('agentyard.office.focus');
    if (this.view) this.post({ type: 'onboard', event: 'open', force: true });
    else this._pendingOnboardOpen = true;
  }

  handleUi(msg) {
    if (msg.action === 'openClaudePathSetting') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'agentyard.claudePath');
    } else if (msg.action === 'openCliPathSetting') {
      const key = msg.backend === 'codex' ? 'agentyard.codexPath' : 'agentyard.claudePath';
      vscode.commands.executeCommand('workbench.action.openSettings', key);
    } else if (msg.action === 'diagnostics') {
      showDiagnostics();
    } else if (msg.action === 'openClaudeTerminal') {
      openClaudeTerminal();
    } else if (msg.action === 'openCodexTerminal') {
      openCodexTerminal();
    } else if (msg.action === 'setupGuidelines') {
      vscode.commands.executeCommand('agentyard.setupGuidelines');
    } else if (msg.action === 'openExternal' && msg.url) {
      try { vscode.env.openExternal(vscode.Uri.parse(String(msg.url))); } catch (e) { /* ignore */ }
    } else if (msg.action === 'liveMode') {
      vscode.commands.executeCommand('agentyard.enableLiveMode');
    }
  }

  stop() {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose() {
    this.stop();
    this.live.stop();
    this.run.dispose();
    this.disposeTerms();
  }

  startWatchers() {
    this.stop();
    const p = paths();
    this.timer = setInterval(() => this.pushData(), Math.max(1000, p.pollSeconds * 1000));
    const targets = [];
    if (p.watch) {
      targets.push(p.db, path.join(p.depts, '*.md'), path.join(p.team, '*.md'));
    }
    // settings.json changes flip the LIVE / hooks-off badge
    targets.push(USER_SETTINGS);
    if (p.root) targets.push(path.join(p.root, '.claude', 'settings.json'));
    for (const target of targets) {
      try {
        const w = vscode.workspace.createFileSystemWatcher(target);
        w.onDidChange(() => this.pushData());
        w.onDidCreate(() => this.pushData());
        w.onDidDelete(() => this.pushData());
        this.watchers.push(w);
      } catch (e) {
        /* ignore */
      }
    }
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'webview')],
    };
    webviewView.webview.html = getHtml(webviewView.webview, this.context.extensionUri, this.context);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (!msg) return;
      if (msg.type === 'ready' || msg.type === 'poll') this.pushData();
      if (msg.type === 'command' && typeof msg.command === 'string') {
        if (msg.command === 'agentyard.enableLiveMode' || msg.command === 'agentyard.disableLiveMode') {
          vscode.commands.executeCommand(msg.command);
        }
      }
      if (msg.type === 'run') {
        if (msg.action === 'send') this.run.send(msg.prompt, !!msg.resume);
        else if (msg.action === 'cancel') this.run.cancel();
        else if (msg.action === 'new') { this.run.newThread(); this.clearAttachments(); }
        else if (msg.action === 'status') this.run.pushStatus();
      }
      if (msg.type === 'term') {
        const bt = this.termFor(msg.backend || enabledAgents()[0]);
        if (msg.event === 'attach') bt.attach(msg.cols, msg.rows);
        else if (msg.event === 'input') bt.input(String(msg.data == null ? '' : msg.data));
        else if (msg.event === 'resize') bt.resize(msg.cols, msg.rows);
        else if (msg.event === 'new') { bt.newThread(); this.clearAttachments(); }
      }
      if (msg.type === 'clip') this.handleClip(msg);
      if (msg.type === 'attach') this.handleAttach(msg);
      if (msg.type === 'onboard') this.handleOnboard(msg);
      if (msg.type === 'help') this.handleHelp(msg);
      if (msg.type === 'ui') this.handleUi(msg);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.pushData();
    });

    webviewView.onDidDispose(() => {
      this.stop();
      // The panel is gone — kill every backend's pty so no orphan CLI is left behind.
      this.disposeTerms();
      this.view = null;
    });

    // A resolve is a Run-view init (first load or a window reload) — clear stale
    // attachments unless the user asked to keep them.
    this.clearAttachments();
    this.startWatchers();
    this.pushData();
    if (this._pendingOnboardOpen) {
      this._pendingOnboardOpen = false;
      this.post({ type: 'onboard', event: 'open', force: true });
    }
  }
}

// Fallback (also just handy): open Claude Code in a normal VS Code integrated
// terminal, in the workspace folder, using the configured claudePath. This is a
// real shell the user drives, so a `.cmd`/`.bat` launcher is fine here — the
// no-cmd.exe rule only applies to Agentyard spawning `claude` itself.
function openClaudeTerminal() {
  const root = workspaceRoot();
  const claudePath = vscode.workspace.getConfiguration('agentyard').get('claudePath', 'claude');
  const term = vscode.window.createTerminal({ name: 'Claude Code', cwd: root || undefined });
  term.sendText(claudePath, true);
  term.show();
}

// Same, for Codex — a normal integrated terminal running the configured
// codexPath in the workspace folder.
function openCodexTerminal() {
  const root = workspaceRoot();
  const codexPath = vscode.workspace.getConfiguration('agentyard').get('codexPath', 'codex');
  const term = vscode.window.createTerminal({ name: 'Codex', cwd: root || undefined });
  term.sendText(codexPath, true);
  term.show();
}

// First run only: if the user has not set `agentyard.agents` and only Codex is
// on PATH, default to Codex; if both CLIs are present, enable both. Otherwise
// leave the Claude-Code-only default untouched.
function maybeSeedAgents(context) {
  try {
    if (context.globalState.get(ONBOARDED_KEY)) return;
    const cfg = vscode.workspace.getConfiguration('agentyard');
    const insp = cfg.inspect('agents');
    if (insp && (insp.globalValue !== undefined || insp.workspaceValue !== undefined)) return;
    const hasClaude = !!diagnoseCli(cfg.get('claudePath', 'claude')).resolved;
    const hasCodex = !!diagnoseCli(cfg.get('codexPath', 'codex')).resolved;
    let want = null;
    if (hasClaude && hasCodex) want = ['claude-code', 'codex'];
    else if (hasCodex && !hasClaude) want = ['codex'];
    if (want) cfg.update('agents', want, vscode.ConfigurationTarget.Global);
  } catch (e) {
    /* best effort — the default stands */
  }
}

function activate(context) {
  installHook();
  migrateHookPath();
  const provider = new OfficeViewProvider(context);
  maybeSeedAgents(context);
  provider.live.start();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentyard.office', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('agentyard.focus', () => {
      vscode.commands.executeCommand('agentyard.office.focus');
    }),
    vscode.commands.registerCommand('agentyard.enableLiveMode', () =>
      enableLiveMode().then(() => provider.pushData())
    ),
    vscode.commands.registerCommand('agentyard.disableLiveMode', () =>
      disableLiveMode().then(() => provider.pushData())
    ),
    vscode.commands.registerCommand('agentyard.openClaudeTerminal', openClaudeTerminal),
    vscode.commands.registerCommand('agentyard.openCodexTerminal', openCodexTerminal),
    vscode.commands.registerCommand('agentyard.setupGuide', () => provider.openSetupGuide()),
    vscode.commands.registerCommand('agentyard.setupGuidelines', () => setupGuidelinesCommand(provider)),
    vscode.commands.registerCommand('agentyard.diagnostics', showDiagnostics),
    vscode.commands.registerCommand('agentyard.createAgentFile', () => createAgentFileCommand(provider))
  );
  context.subscriptions.push({ dispose: () => provider.dispose() });
  context.subscriptions.push({ dispose: () => { if (_diagChannel) _diagChannel.dispose(); } });
}

// `Agentyard: New Department (Agent) File` — pick a bundled starter (or the blank
// template), create it in ~/.claude/agents/ if it isn't there, and open it.
async function createAgentFileCommand(provider) {
  const starters = listStarterAgents();
  const pick = await vscode.window.showQuickPick(
    starters.map((s) => ({
      label: s.name,
      description: s.exists ? '이미 있음 — 열기' : (s.template ? '빈 템플릿' : s.model),
      detail: s.description,
      name: s.name,
    })),
    { placeHolder: '만들 부서(에이전트)를 고르세요 — ~/.claude/agents/ 에 생성됩니다' }
  );
  if (!pick) return;
  const res = createStarterAgents([pick.name]);
  const r = (res.results || [])[0];
  const target = (r && r.path) || path.join(USER_AGENTS_DIR, pick.name + '.md');
  if (r && r.state === 'created') vscode.window.showInformationMessage('부서 파일을 만들었어요: ' + target);
  else if (r && r.state === 'exists') vscode.window.showInformationMessage('이미 있어서 그대로 엽니다: ' + target);
  try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target)); } catch (e) { /* ignore */ }
  if (provider) provider.pushData();
}

// `Agentyard: Set Up Agent Guidelines` — scaffold a canonical AGENTS.md and keep
// CLAUDE.md in sync as a thin `@AGENTS.md` pointer. Never clobbers an existing
// CLAUDE.md: every write is confirmed and a `.agentyard-backup` is saved first,
// the same discipline as the settings.json hook merge. Pure decision logic lives
// in shared/guidelines.js. First workspace folder root only.
async function setupGuidelinesCommand(provider) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace folder first — guidelines live at its root.');
    return;
  }
  const agentsPath = path.join(root, 'AGENTS.md');
  const claudePath = path.join(root, 'CLAUDE.md');
  const aText = safeRead(agentsPath);
  const cText = safeRead(claudePath);
  const a = !!aText.trim();
  const c = !!cText.trim();
  const claudeEnabled = enabledAgents().indexOf('claude-code') !== -1;
  const plan = guidelines.plan({ agentsMd: a, claudeMd: c, claudeText: cText, claudeEnabled });

  const starter = safeRead(STARTER_GUIDELINES) || '# Project\n\nTODO: describe this project.\n';
  const backupThenWrite = (p, content) => {
    try {
      if (fs.existsSync(p)) fs.copyFileSync(p, p + '.agentyard-backup');
      fs.writeFileSync(p, content);
      return true;
    } catch (e) {
      vscode.window.showErrorMessage('Agentyard could not write ' + p + ': ' + e.message);
      return false;
    }
  };
  const openAgents = async () => {
    try { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(agentsPath)); } catch (e) { /* ignore */ }
    if (provider) provider.pushData();
  };

  if (plan.action === 'none') {
    vscode.window.showInformationMessage('Agent guidelines are already "' + plan.status + '". Nothing to do.');
    await openAgents();
    return;
  }

  if (plan.action === 'create') {
    const willPointer = plan.createClaudePointer || plan.fromClaude;
    const body = plan.fromClaude ? cText : starter;
    const label = plan.fromClaude ? 'from your CLAUDE.md' : 'from a starter template';
    const ok = await vscode.window.showInformationMessage(
      'Create AGENTS.md ' + label +
        (willPointer ? ', and make CLAUDE.md a "@AGENTS.md" pointer' : '') +
        '? Any existing file is backed up to .agentyard-backup first.',
      { modal: true }, 'Create'
    );
    if (ok !== 'Create') return;
    if (!backupThenWrite(agentsPath, body)) return;
    if (willPointer) backupThenWrite(claudePath, guidelines.pointerText());
    vscode.window.showInformationMessage('AGENTS.md is set up — edit it; CLAUDE.md imports it.');
    await openAgents();
    return;
  }

  if (plan.action === 'choose') {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Keep them separate', value: 'keep-separate',
          detail: 'Do nothing to CLAUDE.md — you manage both files.' },
        { label: 'Append @AGENTS.md to CLAUDE.md', value: 'append-import',
          detail: 'Add the import line only. Your CLAUDE.md content stays put.' },
        { label: 'Make CLAUDE.md a pointer', value: 'make-pointer',
          detail: 'Move the CLAUDE.md body into AGENTS.md; CLAUDE.md becomes "@AGENTS.md".' },
      ],
      { placeHolder: 'CLAUDE.md already has content — how should it relate to AGENTS.md?' }
    );
    if (!pick) return;
    if (pick.value === 'keep-separate') {
      if (!a && !backupThenWrite(agentsPath, starter)) return;
      vscode.window.showInformationMessage(
        'Left CLAUDE.md as-is.' + (!a ? ' Created a starter AGENTS.md alongside it.' : ''));
      await openAgents();
      return;
    }
    if (pick.value === 'append-import') {
      if (!a && !backupThenWrite(agentsPath, starter)) return;
      if (!backupThenWrite(claudePath, guidelines.appendImportText(cText))) return;
      vscode.window.showInformationMessage('Added "@AGENTS.md" to CLAUDE.md. A backup was saved.');
      await openAgents();
      return;
    }
    if (pick.value === 'make-pointer') {
      if (!backupThenWrite(agentsPath, guidelines.mergedAgentsText(aText, cText))) return;
      if (!backupThenWrite(claudePath, guidelines.pointerText())) return;
      vscode.window.showInformationMessage('CLAUDE.md now points at AGENTS.md. Both files were backed up.');
      await openAgents();
    }
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
