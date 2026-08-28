// Headless smoke test. Runs entirely against the bundled SYNTHETIC fixtures in
// dev-data/ — no real data, no browser, no network. Parses the fake agent files,
// opens dev-data/demo.db through the SAME sql.js build the webview uses, builds
// the office model, runs one render pass against a recording canvas stub, and
// checks the extension manifest wires up the bottom-panel view.
//
//   npm run sanity

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toDepartments } = require('../shared/frontmatter.js');
const initSqlJs = require('sql.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const DD = path.join(EXT_ROOT, 'dev-data');

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

function readAgentDir(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  return toDepartments(
    files.map((f) => ({ file: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }))
  );
}

// --- 0. fixtures exist and are synthetic --------------------------------
check('dev-data/demo.db present', fs.existsSync(path.join(DD, 'demo.db')));
check('dev-data/agents present', fs.existsSync(path.join(DD, 'agents')));
check('dev-data/team present', fs.existsSync(path.join(DD, 'team')));

// --- 1. frontmatter -> departments -------------------------------------
const departments = readAgentDir(path.join(DD, 'agents'));
check('departments parsed', departments.length === 8, departments.length + ' rooms');
check('every department has a model', departments.every((d) => d.model && d.model !== 'unknown'));
const teamRoles = readAgentDir(path.join(DD, 'team'));
check('team roles parsed', teamRoles.length === 5, teamRoles.map((r) => r.name).join(','));

// --- 2. demo.db via sql.js -------------------------------------------
const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync(path.join(DD, 'demo.db')));
const exec = (sql) => {
  const r = db.exec(sql);
  if (!r.length) return [];
  return r[0].values.map((v) => {
    const o = {};
    r[0].columns.forEach((c, i) => (o[c] = v[i]));
    return o;
  });
};
const projects = exec(
  'SELECT project_id, idea_summary, current_stage, updated_at, repo_url FROM projects ORDER BY created_at'
);
const statuses = exec(
  `SELECT s.project_id, s.department, s.status, s.note, s.ts FROM status_log s
   JOIN (SELECT project_id, department, MAX(id) mid FROM status_log GROUP BY project_id, department) m
   ON s.id = m.mid`
);
db.close();
check('projects read', projects.length === 4, projects.length + ' projects');
check('all project ids are DEMO-*', projects.every((p) => /^DEMO-/.test(p.project_id)));
check('no example.com leak into real repos', projects.every((p) => !p.repo_url || /example\.com/.test(p.repo_url)));
const annexCount = projects.filter((p) => p.repo_url).length;
check('annex projects have repo_url', annexCount === 2, annexCount + ' annexes');
check('latest-status rows read', statuses.length >= 5, statuses.length + ' rows');

// --- 3. load browser modules with a fake window ---------------------
const win = { addEventListener() {}, performance: { now: () => 0 } };
win.window = win;
for (const f of ['js/palette.js', 'js/sprites.js', 'js/model.js', 'js/render.js']) {
  const code = fs.readFileSync(path.join(EXT_ROOT, 'webview', f), 'utf8');
  new Function('window', 'self', 'globalThis', code)(win, win, win);
}
check('webview namespace is AY', !!win.AY && !!win.AY.render && !!win.AY.sprites);
const office = win.AY.model.build(
  { departments, teamRoles, dataMode: 'demo' },
  { projects, statuses }
);
check('model builds departments', office.departments.length === departments.length);
check(
  'model builds annex teams',
  office.annexes.length === annexCount && office.annexes.every((a) => a.team.length === 5)
);
check('working status resolves', office.counts.working >= 1, JSON.stringify(office.counts));
check('blocked status resolves', office.counts.blocked >= 1, JSON.stringify(office.counts));

// --- 4. one render pass against a recording stub -------------------
const calls = { fillRect: 0, fillText: 0, strokeRect: 0 };
const ctx = new Proxy(
  {
    fillRect: () => calls.fillRect++,
    strokeRect: () => calls.strokeRect++,
    fillText: () => calls.fillText++,
    measureText: (s) => ({ width: String(s).length * 6 }),
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, save() {}, restore() {},
  },
  { get: (t, k) => (k in t ? t[k] : undefined), set: () => true }
);
let out;
try {
  out = win.AY.render.render(ctx, office, 1234, { selectedId: 'dept:' + departments[0].name });
  check('render() runs without throwing', true);
} catch (e) {
  check('render() runs without throwing', false, e.message + '\n' + e.stack);
}
if (out) {
  check('render drew tiles + text', calls.fillRect > 200 && calls.fillText > 20);
  check(
    'hit-rects = one per agent',
    out.hits.length === departments.length + annexCount * 5,
    out.hits.length + ' rects'
  );
  check('selected room drew a highlight', calls.strokeRect >= 1);
  // a second pass at a later time must still work (animation is time-driven)
  try {
    win.AY.render.render(ctx, office, 99999, { selectedId: null });
    check('render() is stable across time', true);
  } catch (e) {
    check('render() is stable across time', false, e.message);
  }
}

// --- 5. extension manifest wires up the bottom-panel view ----------
const pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'));
check('package name is agentyard', pkg.name === 'agentyard');
check('displayName is Agentyard', pkg.displayName === 'Agentyard');
check('publisher is wonkyard', pkg.publisher === 'wonkyard');
check('activates onStartupFinished', (pkg.activationEvents || []).includes('onStartupFinished'));
check('icon declared', pkg.icon === 'media/icon.png' && fs.existsSync(path.join(EXT_ROOT, pkg.icon)));
const panelC = ((pkg.contributes || {}).viewsContainers || {}).panel || [];
check('panel viewsContainer "agentyard"', panelC.some((c) => c.id === 'agentyard' && c.title === 'Agentyard'));
const views = ((pkg.contributes || {}).views || {}).agentyard || [];
check('webview view "agentyard.office"', views.some((v) => v.id === 'agentyard.office' && v.type === 'webview'));
const cmds = ((pkg.contributes || {}).commands || []).map((c) => c.command);
check('agentyard.focus command present', cmds.includes('agentyard.focus'));
// needles assembled from parts so this test file itself stays grep-clean
const OLD_NAME = ['pixel', 'office'].join('-');
const OLD_CFG = 'pixel' + 'Office';
const OLD_NS = 'P' + 'O_CONFIG';
const legacyRe = new RegExp([OLD_NAME.replace('-', '.?'), OLD_CFG, OLD_NS].join('|'), 'i');
check('no legacy config-key prefix', !JSON.stringify(pkg.contributes.configuration).includes(OLD_CFG));

// --- 6. no legacy identifiers left in shipped code ----------------
const shipped = ['extension.js', 'webview/index.html', 'webview/css/style.css',
  'webview/js/palette.js', 'webview/js/sprites.js', 'webview/js/db.js', 'webview/js/adapter.js',
  'webview/js/model.js', 'webview/js/render.js', 'webview/js/main.js'];
let legacy = [];
for (const f of shipped) {
  const txt = fs.readFileSync(path.join(EXT_ROOT, f), 'utf8');
  if (legacyRe.test(txt)) legacy.push(f);
}
check('no legacy identifiers in shipped code', legacy.length === 0, legacy.join(', '));
check('extension registers WebviewViewProvider',
  /registerWebviewViewProvider\(\s*['"]agentyard\.office['"]/.test(
    fs.readFileSync(path.join(EXT_ROOT, 'extension.js'), 'utf8')));
check('retainContextWhenHidden set',
  /retainContextWhenHidden:\s*true/.test(fs.readFileSync(path.join(EXT_ROOT, 'extension.js'), 'utf8')));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 50).unref();
