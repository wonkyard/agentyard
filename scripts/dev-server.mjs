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
const { StreamJsonParser } = require('../shared/streamJson.js');

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

// Live event log for the browser scene. AGENTYARD_EVENTS points at a real
// events-*.jsonl; otherwise the bundled synthetic sample is used. Timestamps
// are shifted so the newest event lands ~3s ago and the scene looks live.
const EVENTS_FILE = process.env.AGENTYARD_EVENTS
  ? path.resolve(process.env.AGENTYARD_EVENTS)
  : path.join(DEMO_DIR, 'sample-events.jsonl');

function readEvents() {
  let raw;
  try {
    raw = fs.readFileSync(EVENTS_FILE, 'utf8');
  } catch {
    return { events: [], hooksInstalled: false };
  }
  const events = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let maxMs = 0;
  for (const e of events) {
    const m = Date.parse(String(e.ts || ''));
    if (!isNaN(m)) maxMs = Math.max(maxMs, m);
  }
  const shift = maxMs ? Date.now() - 3000 - maxMs : 0;
  for (const e of events) {
    const m = Date.parse(String(e.ts || ''));
    if (!isNaN(m)) e.ts = new Date(m + shift).toISOString();
  }
  return { events, hooksInstalled: true };
}

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
    if (url.startsWith('/api/events')) {
      return sendJson(res, readEvents());
    }
    if (url.startsWith('/api/run-sample')) {
      // The run view needs a real child process (VS Code only). For browser
      // layout work, parse the bundled synthetic stream-json fixture into the
      // same feed items the extension would post.
      const p = new StreamJsonParser();
      let items = [];
      try {
        const raw = fs.readFileSync(path.join(DEMO_DIR, 'sample-stream-json.jsonl'), 'utf8');
        items = p.push(raw).concat(p.flush());
      } catch {
        items = [];
      }
      return sendJson(res, { items });
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
  console.log('  events    : ' + EVENTS_FILE + (fs.existsSync(EVENTS_FILE) ? '' : '  (MISSING)'));
  console.log('  open      : http://localhost:' + PORT);
});
