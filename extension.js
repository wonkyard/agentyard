'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { toDepartments } = require('./shared/frontmatter.js');

let panel = null;
let timer = null;
let watchers = [];

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

const DEMO = {
  db: path.join(__dirname, 'dev-data', 'demo.db'),
  depts: path.join(__dirname, 'dev-data', 'agents'),
  team: path.join(__dirname, 'dev-data', 'team'),
  dataMode: 'demo',
  watch: false,
};

// Use real workspace data when the open folder actually has a company.db + agent
// folder; otherwise fall back to the bundled synthetic demo so the extension
// always renders something (first run, unrelated project, Marketplace preview).
function paths() {
  const cfg = vscode.workspace.getConfiguration('pixelOffice');
  const pollSeconds = cfg.get('pollSeconds', 3);
  const root = workspaceRoot();
  if (!root) return { ...DEMO, pollSeconds };
  const db = path.join(root, cfg.get('dbPath', 'state/company.db'));
  const depts = path.join(root, cfg.get('agentsGlob', '.claude/agents'));
  if (!fs.existsSync(db) || !fs.existsSync(depts)) return { ...DEMO, pollSeconds };
  let team = path.join(root, 'templates', 'project-repo', '.claude', 'agents');
  if (!fs.existsSync(team)) team = DEMO.team;
  return { root, db, depts, team, dataMode: 'workspace', watch: true, pollSeconds };
}

function readAgentDir(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch (e) {
    return [];
  }
  return toDepartments(
    files.map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }))
  );
}

function collectSnapshot() {
  const p = paths();
  let dbBase64 = '';
  try {
    dbBase64 = fs.readFileSync(p.db).toString('base64');
  } catch (e) {
    return { type: 'data', error: 'cannot read ' + p.db + ': ' + e.message };
  }
  return {
    type: 'data',
    dataMode: p.dataMode,
    departments: readAgentDir(p.depts),
    teamRoles: readAgentDir(p.team),
    dbBase64,
  };
}

function pushData() {
  if (!panel) return;
  const snap = collectSnapshot();
  panel.webview.postMessage(snap);
}

function getHtml(webview, extUri) {
  const n = nonce();
  const asset = (...seg) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'webview', ...seg)).toString();
  const wasmUrl = asset('vendor', 'sql-wasm.wasm');
  const cfg = vscode.workspace.getConfiguration('pixelOffice');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${n}' 'wasm-unsafe-eval'`,
  ].join('; ');

  const scripts = ['vendor/sql-wasm.js', 'js/palette.js', 'js/sprites.js', 'js/db.js',
    'js/adapter.js', 'js/model.js', 'js/render.js', 'js/main.js']
    .map((s) => `<script nonce="${n}" src="${asset(...s.split('/'))}"></script>`)
    .join('\n  ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${asset('css', 'style.css')}" />
  <title>WONKYARD Pixel Office</title>
</head>
<body>
  <div id="app">
    <div id="stage-wrap"><canvas id="scene" width="900" height="600"></canvas></div>
    <aside id="panel"></aside>
    <div id="status">connecting…</div>
  </div>
  <script nonce="${n}">
    window.PO_CONFIG = { mode: 'vscode', pollSeconds: ${JSON.stringify(cfg.get('pollSeconds', 3))}, wasmUrl: ${JSON.stringify(wasmUrl)} };
  </script>
  ${scripts}
</body>
</html>`;
}

function disposeWatchers() {
  watchers.forEach((w) => w.dispose());
  watchers = [];
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'pixelOffice',
    'WONKYARD Pixel Office',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'webview')],
    }
  );
  panel.webview.html = getHtml(panel.webview, context.extensionUri);

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg && (msg.type === 'ready' || msg.type === 'poll')) pushData();
  });

  const p = paths();
  timer = setInterval(pushData, Math.max(1000, p.pollSeconds * 1000));

  if (p.watch) {
    for (const target of [p.db, path.join(p.depts, '*.md'), path.join(p.team, '*.md')]) {
      const w = vscode.workspace.createFileSystemWatcher(target);
      w.onDidChange(pushData);
      w.onDidCreate(pushData);
      w.onDidDelete(pushData);
      watchers.push(w);
    }
  }

  panel.onDidDispose(() => {
    panel = null;
    disposeWatchers();
  });
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('pixelOffice.open', () => openPanel(context))
  );
}

function deactivate() {
  disposeWatchers();
  if (panel) panel.dispose();
}

module.exports = { activate, deactivate };
