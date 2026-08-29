'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { toDepartments } = require('./shared/frontmatter.js');
const hooksConfig = require('./shared/hooksConfig.js');
const { buildClaudeArgs, buildInteractiveClaudeArgs, candidateCommands } = require('./shared/claudeArgs.js');
const { needsCmdWrap, resolveLauncher } = require('./shared/winWrap.js');
const { StreamJsonParser } = require('./shared/streamJson.js');
const { killTree, spawnGroupOpts } = require('./shared/killTree.js');
const attach = require('./shared/attach.js');

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

const DEMO = {
  db: path.join(__dirname, 'dev-data', 'demo.db'),
  depts: path.join(__dirname, 'dev-data', 'agents'),
  team: path.join(__dirname, 'dev-data', 'team'),
  dataMode: 'demo',
  watch: false,
};

function paths() {
  const cfg = vscode.workspace.getConfiguration('agentyard');
  const pollSeconds = cfg.get('pollSeconds', 3);
  const root = workspaceRoot();
  if (!root) return { ...DEMO, pollSeconds };
  const db = path.join(root, cfg.get('dbPath', 'state/company.db'));
  const depts = path.join(root, cfg.get('agentsGlob', '.claude/agents'));
  if (!fs.existsSync(db) || !fs.existsSync(depts)) return { ...DEMO, pollSeconds, root };
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
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter);
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

// Resolve the configured `claude` command to a concrete { file, args } that can
// be handed to node-pty with NO shell — the same no-cmd.exe guarantee the
// headless runner keeps (see shared/winWrap.js). Tries the platform candidate
// list (claude.exe -> claude.cmd -> … on Windows); a `.cmd`/`.bat` shim is
// resolved to the real executable it forwards to, never shelled. Returns null
// if nothing runnable was found — the caller then tells the user to set an
// explicit claudePath.
function resolvePtyClaude(command, baseArgs) {
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
        'Could not launch "' + candidates[0] + '". Set agentyard.claudePath to the Claude ' +
        'Code CLI — on Windows point it at claude.exe or a full path to the real executable, ' +
        'not a .cmd/.bat shim.'
      );
      return;
    }
    const command = candidates[i];
    let file = command;
    let spawnArgs = args;
    const opts = { cwd, env: process.env, windowsHide: true, ...spawnGroupOpts(process.platform) };

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
    }

    let child;
    try {
      child = cp.spawn(file, spawnArgs, opts);
    } catch (e) {
      this._spawn(candidates, i + 1, args, cwd);
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
      if (!sawData && (err.code === 'ENOENT' || err.code === 'EINVAL')) {
        this.child = null;
        this._spawn(candidates, i + 1, args, cwd);
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

// ---- run Claude Code in an embedded terminal -----------------------
// The Run view's xterm.js surface talks to this over the webview postMessage
// channel. One pty per panel, kept here in the extension host so a webview
// reload re-attaches to the running session instead of restarting it. Spawns
// the user's own INTERACTIVE `claude` (never `-p`) with their existing CLI
// auth — no API key. The command is always an argv array through node-pty, so
// there is no shell and cmd.exe is never involved (v0.4 guarantee).
class TerminalRun {
  constructor(post) {
    this.post = post; // (msg) => void, to the webview
    this.pty = null;
    this.cols = 80;
    this.rows = 24;
    this.buffer = []; // recent output chunks, replayed on re-attach
    this.bufferLen = 0;
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
    this.post({ type: 'term', event: 'data', data: text });
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
      this.post({ type: 'term', event: 'unavailable', message: PTY_UNAVAILABLE_NOTICE });
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
      built = buildInteractiveClaudeArgs({
        claudePath: cfg.get('claudePath', 'claude'),
        permissionMode: cfg.get('claudePermissionMode', 'default'),
        extraArgs: cfg.get('claudeExtraArgs', []),
      });
    } catch (e) {
      this._say('\r\n\x1b[31mBad Agentyard run config: ' + e.message + '\x1b[0m\r\n');
      return;
    }

    const target = resolvePtyClaude(built.command, built.args);
    if (!target) {
      this._say('\r\n\x1b[31mCould not launch "' + built.command + '". Set agentyard.claudePath ' +
        'to the Claude Code CLI — on Windows point it at claude.exe or a full path to the real ' +
        'executable, not a .cmd/.bat shim.\x1b[0m\r\n');
      return;
    }

    let pty;
    try {
      pty = nodePty.spawn(target.file, target.args, {
        name: 'xterm-256color',
        cwd: root,
        env: process.env,
        cols: this.cols,
        rows: this.rows,
      });
    } catch (e) {
      this._say('\r\n\x1b[31mcould not start the terminal: ' + e.message + '\x1b[0m\r\n');
      return;
    }

    this.pty = pty;
    this.buffer = [];
    this.bufferLen = 0;
    pty.onData((d) => {
      if (this.pty !== pty) return;
      this._bufferPush(d);
      this.post({ type: 'term', event: 'data', data: d });
    });
    pty.onExit((e) => {
      if (this.pty !== pty) return;
      this.pty = null;
      const code = e && typeof e.exitCode === 'number' ? e.exitCode : null;
      this.post({ type: 'term', event: 'exit', code });
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
function getHtml(webview, extUri) {
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
    'js/render.js', 'js/termclip.js', 'js/run.js', 'js/term.js', 'js/main.js']
    .map((s) => `<script nonce="${n}" src="${asset(...s.split('/'))}"></script>`)
    .join('\n  ');

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
      <span class="brand">AGENTYARD<span class="ver">v1.0</span></span>
      <span id="view-toggle">
        <button type="button" data-view="office" class="on">Office</button>
        <button type="button" data-view="run">Run</button>
      </span>
    </header>
    <div id="office-pane">
      <div id="stage-wrap"><canvas id="scene" width="840" height="600"></canvas></div>
      <aside id="panel"></aside>
      <div id="status">connecting…</div>
    </div>
    <div id="run-pane" hidden>
      <div id="run-notice" hidden></div>
      <div id="run-term" hidden></div>
      <div id="run-term-foot" hidden>
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
    window.AY_CONFIG = { mode: 'vscode', pollSeconds: ${JSON.stringify(cfg.get('pollSeconds', 3))}, wasmUrl: ${JSON.stringify(wasmUrl)}, runView: ${JSON.stringify(runView)}, runViewRequested: ${JSON.stringify(runViewRequested)}, ptyAvailable: ${JSON.stringify(ptyAvailable)}, platform: ${JSON.stringify(process.platform)}, terminalCopyPaste: ${JSON.stringify(cfg.get('terminalCopyPaste', true))}, copyOnSelection: ${JSON.stringify(cfg.get('copyOnSelection', false))} };
  </script>
  ${scripts}
</body>
</html>`;
}

function collectSnapshot(live) {
  const p = paths();
  const cfg = vscode.workspace.getConfiguration('agentyard');
  let dbBase64 = '';
  try {
    dbBase64 = fs.readFileSync(p.db).toString('base64');
  } catch (e) {
    return { type: 'data', error: 'cannot read ' + p.db + ': ' + e.message };
  }
  return {
    type: 'data',
    dataMode: p.dataMode,
    departments: p.dataMode === 'demo' ? readAgentDir(p.depts) : readRoster(p.depts),
    teamRoles: readAgentDir(p.team),
    dbBase64,
    liveEvents: live ? live.recent() : [],
    hooksInstalled: hooksInstalled(),
    idleSeconds: cfg.get('idleSeconds', 30),
    staleMinutes: cfg.get('staleMinutes', 15),
    maxSpritesPerRoom: cfg.get('maxSpritesPerRoom', 8),
    nowMs: Date.now(),
  };
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
    this.term = new TerminalRun((m) => {
      if (this.view) this.view.webview.postMessage(m);
    });
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
    this.term.dispose();
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
    webviewView.webview.html = getHtml(webviewView.webview, this.context.extensionUri);

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
        if (msg.event === 'attach') this.term.attach(msg.cols, msg.rows);
        else if (msg.event === 'input') this.term.input(String(msg.data == null ? '' : msg.data));
        else if (msg.event === 'resize') this.term.resize(msg.cols, msg.rows);
        else if (msg.event === 'new') { this.term.newThread(); this.clearAttachments(); }
      }
      if (msg.type === 'clip') this.handleClip(msg);
      if (msg.type === 'attach') this.handleAttach(msg);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.pushData();
    });

    webviewView.onDidDispose(() => {
      this.stop();
      // The panel is gone — kill the pty so no orphan `claude` is left behind.
      this.term.dispose();
      this.view = null;
    });

    // A resolve is a Run-view init (first load or a window reload) — clear stale
    // attachments unless the user asked to keep them.
    this.clearAttachments();
    this.startWatchers();
    this.pushData();
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

function activate(context) {
  installHook();
  migrateHookPath();
  const provider = new OfficeViewProvider(context);
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
    vscode.commands.registerCommand('agentyard.openClaudeTerminal', openClaudeTerminal)
  );
  context.subscriptions.push({ dispose: () => provider.dispose() });
}

function deactivate() {}

module.exports = { activate, deactivate };
