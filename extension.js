'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toDepartments } = require('./shared/frontmatter.js');
const hooksConfig = require('./shared/hooksConfig.js');

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

const HOOK_SCRIPT = path.join(__dirname, 'hooks', 'agentyard-hook.mjs');
const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const EVENTS_DIR = path.join(os.homedir(), '.claude', 'agentyard');

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
    this.pruneTimer = setInterval(() => {
      this.prune();
      this.scanAll();
    }, 60 * 60 * 1000);
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
        if (now - st.mtimeMs > 24 * 60 * 60 * 1000) drop = true;
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

async function enableLiveMode() {
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
      const cleaned = hooksConfig.removeHooks(hooksConfig.parseLenient(text));
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

// ---- webview -------------------------------------------------------
function getHtml(webview, extUri) {
  const n = nonce();
  const asset = (...seg) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'webview', ...seg)).toString();
  const wasmUrl = asset('vendor', 'sql-wasm.wasm');
  const cfg = vscode.workspace.getConfiguration('agentyard');
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

  const scripts = ['vendor/sql-wasm.js', 'js/palette.js', 'js/sprites.js', 'js/db.js',
    'js/adapter.js', 'js/live.js', 'js/model.js', 'js/render.js', 'js/main.js']
    .map((s) => `<script nonce="${n}" src="${asset(...s.split('/'))}"></script>`)
    .join('\n  ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${asset('css', 'style.css')}" />
  <title>Agentyard</title>
</head>
<body class="panel">
  <div id="app">
    <div id="stage-wrap"><canvas id="scene" width="840" height="600"></canvas></div>
    <aside id="panel"></aside>
    <div id="status">connecting…</div>
  </div>
  <script nonce="${n}">
    window.AY_CONFIG = { mode: 'vscode', pollSeconds: ${JSON.stringify(cfg.get('pollSeconds', 3))}, wasmUrl: ${JSON.stringify(wasmUrl)} };
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
  }

  pushData() {
    if (!this.view) return;
    this.view.webview.postMessage(collectSnapshot(this.live));
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
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.pushData();
    });

    webviewView.onDidDispose(() => {
      this.stop();
      this.view = null;
    });

    this.startWatchers();
    this.pushData();
  }
}

function activate(context) {
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
    )
  );
  context.subscriptions.push({ dispose: () => provider.dispose() });
}

function deactivate() {}

module.exports = { activate, deactivate };
