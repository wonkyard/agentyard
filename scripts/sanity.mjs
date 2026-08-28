// Headless smoke test. Runs entirely against the bundled SYNTHETIC fixtures in
// dev-data/ — no real data, no browser, no network. Parses the fake agent files,
// opens dev-data/demo.db through the SAME sql.js build the webview uses, builds
// the office model, runs one render pass against a recording canvas stub, and
// checks the extension manifest wires up the bottom-panel view.
//
//   npm run sanity

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toDepartments } = require('../shared/frontmatter.js');
const hooksConfig = require('../shared/hooksConfig.js');
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
for (const f of ['js/palette.js', 'js/sprites.js', 'js/live.js', 'js/model.js', 'js/render.js']) {
  const code = fs.readFileSync(path.join(EXT_ROOT, 'webview', f), 'utf8');
  new Function('window', 'self', 'globalThis', 'module', code)(win, win, win, undefined);
}
check('webview namespace is AY', !!win.AY && !!win.AY.render && !!win.AY.sprites && !!win.AY.live);
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

// --- 7. hook script: writes clean JSONL, never leaks a secret -----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentyard-hook-'));
  const env = { ...process.env, HOME: tmp, USERPROFILE: tmp };
  const HOOK = path.join(EXT_ROOT, 'hooks', 'agentyard-hook.mjs');
  const SID = 'sanity-session-1';
  const payloads = [
    { hook_event_name: 'SessionStart', session_id: SID, cwd: '/tmp/proj' },
    { hook_event_name: 'PreToolUse', session_id: SID, cwd: '/tmp/proj', tool_name: 'Read', tool_input: { file_path: '/tmp/proj/src/app.ts' } },
    {
      hook_event_name: 'PreToolUse', session_id: SID, cwd: '/tmp/proj', tool_name: 'Bash',
      tool_input: { command: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls && export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    },
    { hook_event_name: 'SubagentStop', session_id: SID, agent_id: 'sub-9', agent_type: 'Explore' },
    { hook_event_name: 'Stop', session_id: SID, stop_reason: 'end_turn' },
  ];
  let hookErr = null;
  for (const p of payloads) {
    try {
      execFileSync(process.execPath, [HOOK], { input: JSON.stringify(p), env, timeout: 5000 });
    } catch (e) {
      hookErr = e.message;
    }
  }
  const outFile = path.join(tmp, '.claude', 'agentyard', `events-${SID}.jsonl`);
  const exists = fs.existsSync(outFile);
  check('hook: wrote events JSONL to fake home', exists && !hookErr, hookErr || outFile);
  let lines = [];
  if (exists) lines = fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
  check('hook: one line per event, all valid JSON', lines.length === payloads.length &&
    lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }),
    lines.length + ' lines');
  const blob = lines.join('\n');
  check('hook: no secret substrings leaked',
    !/wJalrXUtnFEMI/.test(blob) && !/ghp_abcdefghijklmnopqrstuvwxyz/.test(blob) &&
    !/AWS_SECRET_ACCESS_KEY=\S/.test(blob) && blob.includes('[redacted]'));
  const parsed = lines.map((l) => JSON.parse(l));
  check('hook: records carry ts + hook_event_name + session_id',
    parsed.every((r) => r.ts && r.hook_event_name && r.session_id === SID));
  check('hook: Read tool summarised to just the path',
    parsed.some((r) => r.tool_name === 'Read' && r.tool_input_summary === '/tmp/proj/src/app.ts'));
  check('hook: subagent record keeps agent_id + agent_type',
    parsed.some((r) => r.hook_event_name === 'SubagentStop' && r.agent_id === 'sub-9' && r.agent_type === 'Explore'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

// --- 8. live state machine resolves statuses --------------------------
{
  const L = win.AY.live;
  const base = Date.parse('2026-08-28T12:00:00Z');
  const iso = (sec) => new Date(base + sec * 1000).toISOString();
  const events = [
    { ts: iso(0), hook_event_name: 'SessionStart', session_id: 's1', cwd: '/w/app' },
    { ts: iso(1), hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/w/app', tool_name: 'Edit', tool_input_summary: 'src/x.ts' },
    { ts: iso(2), hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'g1', agent_type: 'Explore' },
    { ts: iso(3), hook_event_name: 'PreToolUse', session_id: 's1', agent_id: 'g1', agent_type: 'Explore', tool_name: 'Grep', tool_input_summary: 'foo' },
    { ts: iso(4), hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'g2', agent_type: 'Plan' },
    { ts: iso(5), hook_event_name: 'PermissionRequest', session_id: 's1', agent_id: 'g2', agent_type: 'Plan', tool_name: 'Bash' },
    { ts: iso(6), hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'g3', agent_type: 'code-reviewer' },
    { ts: iso(7), hook_event_name: 'PreToolUse', session_id: 's1', agent_id: 'g3', agent_type: 'code-reviewer', tool_name: 'Read', tool_input_summary: 'a.ts' },
    { ts: iso(8), hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'g3', agent_type: 'code-reviewer' },
  ];
  // t = 10s: main + Explore worked <30s ago -> working; Plan pending perm -> blocked; g3 stopped -> gone
  const r1 = L.resolve(events, { nowMs: base + 10000, idleSeconds: 30 });
  const byType = Object.fromEntries(r1.agents.map((a) => [a.type, a]));
  check('live: main session is working', byType.main && byType.main.status === 'working', JSON.stringify(r1.counts));
  check('live: Explore subagent is working', byType.Explore && byType.Explore.status === 'working');
  check('live: PermissionRequest -> blocked', byType.Plan && byType.Plan.status === 'blocked');
  check('live: SubagentStop lingers briefly then leaves', byType['code-reviewer'] && byType['code-reviewer'].leaving === true);
  const rGone = L.resolve(events, { nowMs: base + 20000, idleSeconds: 30 });
  check('live: SubagentStop -> agent gone after linger',
    !rGone.agents.some((a) => a.type === 'code-reviewer'), rGone.agents.map((a) => a.type).join(','));
  check('live: doing line shows tool + summary', byType.Explore.doing === 'Grep: foo', byType.Explore.doing);
  // t = 5 min later: no new tool activity -> everyone idle (still within linger? no)
  const r2 = L.resolve(events, { nowMs: base + 300000, idleSeconds: 30 });
  const byType2 = Object.fromEntries(r2.agents.map((a) => [a.type, a]));
  check('live: goes idle after idleSeconds', !byType2.main || byType2.main.status === 'idle',
    byType2.main ? byType2.main.status : 'gone');
  check('live: blocked persists while permission unresolved', byType2.Plan && byType2.Plan.status === 'blocked');
  // data-mode badge
  check('live: dataMode live when fresh', L.dataMode(r1, true, base + 10000) === 'live');
  check('live: dataMode watching when quiet', L.dataMode(r2, true, base + 300000) === 'watching');
  check('live: dataMode off without hooks', L.dataMode(r1, false, base + 10000) === 'off');
}

// --- 9. model folds live rooms + department overlay ------------------
{
  const base = Date.now();
  const iso = (sec) => new Date(base + sec * 1000).toISOString();
  const liveEvents = [
    { ts: iso(-2), hook_event_name: 'SessionStart', session_id: 'ms', cwd: '/home/dev/widget' },
    { ts: iso(-1), hook_event_name: 'PreToolUse', session_id: 'ms', cwd: '/home/dev/widget', tool_name: 'Bash', tool_input_summary: 'make' },
    { ts: iso(-2), hook_event_name: 'SubagentStart', session_id: 'ms', agent_id: 'e1', agent_type: 'Explore' },
    { ts: iso(-1), hook_event_name: 'PreToolUse', session_id: 'ms', agent_id: 'e1', agent_type: 'Explore', tool_name: 'Grep', tool_input_summary: 'main' },
    { ts: iso(-1), hook_event_name: 'SubagentStart', session_id: 'ms', agent_id: 'f1', agent_type: 'forge' },
    { ts: iso(0), hook_event_name: 'PreToolUse', session_id: 'ms', agent_id: 'f1', agent_type: 'forge', tool_name: 'Edit', tool_input_summary: 'toaster.c' },
  ];
  const office2 = win.AY.model.build(
    { departments, teamRoles, dataMode: 'demo', liveEvents, hooksInstalled: true, nowMs: base, idleSeconds: 30, maxSpritesPerRoom: 8 },
    { projects, statuses }
  );
  check('model: live main session becomes a room', office2.liveRooms.some((r) => r.kind === 'live-main'));
  check('model: unknown subagent type gets its own room',
    office2.liveRooms.some((r) => r.kind === 'live-sub' && r.title === 'Explore'));
  const forgeDept = office2.departments.find((d) => d.name === 'forge');
  check('model: live agent overlays matching department', forgeDept && forgeDept.live === true && forgeDept.status === 'working',
    forgeDept ? JSON.stringify({ live: forgeDept.live, status: forgeDept.status }) : 'no forge');
  check('model: forge NOT duplicated as a live room', !office2.liveRooms.some((r) => r.title === 'forge'));
  check('model: liveMode is live', office2.liveMode === 'live');
  // fleet cap
  const fleet = [{ ts: iso(-1), hook_event_name: 'SessionStart', session_id: 'fs', cwd: '/x' }];
  for (let i = 0; i < 20; i++) {
    fleet.push({ ts: iso(-1), hook_event_name: 'SubagentStart', session_id: 'fs', agent_id: 'gp' + i, agent_type: 'general-purpose' });
    fleet.push({ ts: iso(0), hook_event_name: 'PreToolUse', session_id: 'fs', agent_id: 'gp' + i, agent_type: 'general-purpose', tool_name: 'Read', tool_input_summary: 'f' + i });
  }
  const office3 = win.AY.model.build(
    { departments, teamRoles, dataMode: 'demo', liveEvents: fleet, hooksInstalled: true, nowMs: base, idleSeconds: 30, maxSpritesPerRoom: 8 },
    { projects, statuses }
  );
  const gpRoom = office3.liveRooms.find((r) => r.title === 'general-purpose');
  check('model: fleet room caps sprites + reports overflow',
    gpRoom && gpRoom.occupants.length === 8 && gpRoom.overflow === 12,
    gpRoom ? gpRoom.occupants.length + '+' + gpRoom.overflow : 'no room');
}

// --- 10. settings.json hook merge is non-destructive ----------------
{
  const SCRIPT = 'C:/ext/agentyard/hooks/agentyard-hook.mjs';
  const userSettings = {
    model: 'sonnet',
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /home/me/my-audit.js' }] },
      ],
    },
  };
  const merged = hooksConfig.mergeHooks(userSettings, SCRIPT);
  check('settings: pre-existing unrelated hook preserved',
    merged.hooks.PreToolUse.some((e) => e.hooks[0].command === 'node /home/me/my-audit.js'));
  check('settings: our hook added to every event',
    hooksConfig.HOOK_EVENTS.every((ev) =>
      (merged.hooks[ev] || []).some((e) => e.hooks.some((h) => h.command.includes('agentyard-hook.mjs')))));
  check('settings: user model key untouched', merged.model === 'sonnet');
  check('settings: merge is idempotent',
    JSON.stringify(hooksConfig.mergeHooks(merged, SCRIPT)) === JSON.stringify(merged));
  const removed = hooksConfig.removeHooks(merged);
  check('settings: after disable, user hook still present',
    removed.hooks.PreToolUse.length === 1 &&
    removed.hooks.PreToolUse[0].hooks[0].command === 'node /home/me/my-audit.js');
  check('settings: after disable, none of ours remain',
    !JSON.stringify(removed).includes('agentyard-hook.mjs'));
  check('settings: lenient parse strips // and /* */ comments',
    hooksConfig.parseLenient('{\n  // a comment\n  "x": 1, /* blk */ "y": 2,\n}').y === 2);
  check('settings: textHasOurHooks detects our command path',
    hooksConfig.textHasOurHooks(JSON.stringify(merged)) && !hooksConfig.textHasOurHooks('{}'));
}

check('extension registers WebviewViewProvider',
  /registerWebviewViewProvider\(\s*['"]agentyard\.office['"]/.test(
    fs.readFileSync(path.join(EXT_ROOT, 'extension.js'), 'utf8')));
check('retainContextWhenHidden set',
  /retainContextWhenHidden:\s*true/.test(fs.readFileSync(path.join(EXT_ROOT, 'extension.js'), 'utf8')));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 50).unref();
