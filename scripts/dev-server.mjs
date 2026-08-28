// Zero-dependency dev server for Agentyard.
//
// Serves the exact same webview/ that the VS Code extension loads. By default it
// feeds it the bundled SYNTHETIC fixtures in dev-data/ (fake departments, fake
// projects) so nothing real is ever exposed. Point it at a real workspace with
// AGENTYARD_REPO to view actual data locally.
// No build step, no bundler, no network access.
//
//   npm run dev                                     (synthetic demo data)
//   PORT=5000 npm run dev
//   AGENTYARD_REPO=/path/to/company-repo npm run dev (real: <root>/state/company.db + <root>/.claude/agents)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toDepartments } = require('../shared/frontmatter.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const WEBVIEW_DIR = path.join(EXT_ROOT, 'webview');
const DEMO_DIR = path.join(EXT_ROOT, 'dev-data');

// AGENTYARD_REPO is the current name. PIXEL_OFFICE_REPO is still read as a
// fallback for one version — deprecated, remove after 0.3.
const REPO_ENV = process.env.AGENTYARD_REPO || process.env.PIXEL_OFFICE_REPO;
const REAL_ROOT = REPO_ENV ? path.resolve(REPO_ENV) : null;
const DEMO = !REAL_ROOT;

const DB_PATH = DEMO
  ? path.join(DEMO_DIR, 'demo.db')
  : path.join(REAL_ROOT, 'state', 'company.db');
const DEPT_DIR = DEMO
  ? path.join(DEMO_DIR, 'agents')
  : path.join(REAL_ROOT, '.claude', 'agents');
const TEAM_DIR = DEMO
  ? path.join(DEMO_DIR, 'team')
  : path.join(REAL_ROOT, 'templates', 'project-repo', '.claude', 'agents');

const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function readAgentDir(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  return toDepartments(
    entries.map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }))
  );
}

function sendJson(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const clean = urlPath.split('?')[0].replace(/^\/+/, '');
  const rel = clean === '' ? 'index.html' : clean;
  const full = path.join(WEBVIEW_DIR, rel);
  if (!full.startsWith(WEBVIEW_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  try {
    if (url.startsWith('/api/agents')) {
      return sendJson(res, {
        dataMode: DEMO ? 'demo' : 'workspace',
        departments: readAgentDir(DEPT_DIR),
        teamRoles: readAgentDir(TEAM_DIR),
      });
    }
    if (url.startsWith('/api/db')) {
      const buf = fs.readFileSync(DB_PATH);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }
    return serveStatic(res, url);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('dev-server error: ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log('Agentyard - dev mode');
  console.log('  data mode : ' + (DEMO ? 'SYNTHETIC demo fixtures' : 'real workspace: ' + REAL_ROOT));
  console.log('  db        : ' + DB_PATH + (fs.existsSync(DB_PATH) ? '' : '  (MISSING - run `npm run demo-data`)'));
  console.log('  agents    : ' + DEPT_DIR + (fs.existsSync(DEPT_DIR) ? '' : '  (MISSING)'));
  console.log('  open      : http://localhost:' + PORT);
});
