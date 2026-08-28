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
const { buildClaudeArgs, candidateCommands } = require('../shared/claudeArgs.js');
const { needsCmdWrap, parseCmdShim, tokenizeCmdLine, resolveLauncher } = require('../shared/winWrap.js');
const { StreamJsonParser } = require('../shared/streamJson.js');
const { killTree, isAlive } = require('../shared/killTree.js');
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
check('dev-data/zombie-session.jsonl present', fs.existsSync(path.join(DD, 'zombie-session.jsonl')));
check('zombie fixture is synthetic (no real user paths / session id)', (() => {
  const t = fs.readFileSync(path.join(DD, 'zombie-session.jsonl'), 'utf8');
  return !/[A-Za-z]:\\Users\\/.test(t) && !/b178cf9a/.test(t);
})());

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
const stubNode = () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
  addEventListener() {}, appendChild() {}, querySelectorAll: () => [], querySelector: () => null,
  closest: () => null, textContent: '', hidden: false });
const win = {
  addEventListener() {}, performance: { now: () => 0 },
  document: { getElementById: () => null, createElement: stubNode, querySelector: () => null,
    querySelectorAll: () => [], addEventListener() {} },
};
win.window = win;
for (const f of ['js/palette.js', 'js/sprites.js', 'js/live.js', 'js/model.js', 'js/render.js', 'js/run.js']) {
  const code = fs.readFileSync(path.join(EXT_ROOT, 'webview', f), 'utf8');
  new Function('window', 'self', 'globalThis', 'module', 'document', code)(win, win, win, undefined, win.document);
}
check('webview namespace is AY', !!win.AY && !!win.AY.render && !!win.AY.sprites && !!win.AY.live);
check('run view module loaded', !!win.AY.run && typeof win.AY.run.describe === 'function');
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
const cfgProps = (((pkg.contributes || {}).configuration || {}).properties) || {};
check('run-view config props declared',
  !!cfgProps['agentyard.claudePath'] && !!cfgProps['agentyard.claudeExtraArgs'] &&
  !!cfgProps['agentyard.claudePermissionMode']);
check('claudePermissionMode default is not a skip-permissions mode',
  cfgProps['agentyard.claudePermissionMode'].default === 'default');
check('package version is 0.4.x', /^0\.4\./.test(pkg.version), pkg.version);
// needles assembled from parts so this test file itself stays grep-clean
const OLD_NAME = ['pixel', 'office'].join('-');
const OLD_CFG = 'pixel' + 'Office';
const OLD_NS = 'P' + 'O_CONFIG';
const legacyRe = new RegExp([OLD_NAME.replace('-', '.?'), OLD_CFG, OLD_NS].join('|'), 'i');
check('no legacy config-key prefix', !JSON.stringify(pkg.contributes.configuration).includes(OLD_CFG));

// --- 6. no legacy identifiers left in shipped code ----------------
const shipped = ['extension.js', 'webview/index.html', 'webview/css/style.css',
  'webview/js/palette.js', 'webview/js/sprites.js', 'webview/js/db.js', 'webview/js/adapter.js',
  'webview/js/model.js', 'webview/js/render.js', 'webview/js/run.js', 'webview/js/main.js',
  'shared/claudeArgs.js', 'shared/winWrap.js', 'shared/streamJson.js', 'shared/killTree.js'];
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

  // ---- zombie horizon: an agent that never ended and went quiet is dropped ----
  // A session force-closed mid-run never emits Stop / SessionEnd. Its events
  // file ends on a PreToolUse. Long after, resolve() must not still render it.
  const zEvents = [
    { ts: iso(0), hook_event_name: 'SessionStart', session_id: 'z1', cwd: '/w/app' },
    { ts: iso(1), hook_event_name: 'UserPromptSubmit', session_id: 'z1', cwd: '/w/app' },
    { ts: iso(2), hook_event_name: 'SubagentStart', session_id: 'z1', agent_id: 'zs', agent_type: 'Explore' },
    { ts: iso(3), hook_event_name: 'PreToolUse', session_id: 'z1', agent_id: 'zs', agent_type: 'Explore', tool_name: 'Grep', tool_input_summary: 'x' },
    { ts: iso(5), hook_event_name: 'PreToolUse', session_id: 'z1', cwd: '/w/app', tool_name: 'Edit', tool_input_summary: 'a.ts' },
  ];
  const zSoon = L.resolve(zEvents, { nowMs: base + 60 * 1000, idleSeconds: 30 });
  check('live: within the horizon the (idle) zombie is still shown',
    zSoon.agents.length === 2, zSoon.agents.map((a) => a.type).join(','));
  const zLater = L.resolve(zEvents, { nowMs: base + 20 * 60 * 1000, idleSeconds: 30 });
  check('live: past the 15-min horizon a never-ended agent is dropped entirely',
    zLater.agents.length === 0 && zLater.counts.idle === 0,
    zLater.agents.map((a) => a.type).join(',') + ' ' + JSON.stringify(zLater.counts));
  const zKept = L.resolve(zEvents, { nowMs: base + 20 * 60 * 1000, idleSeconds: 30, staleMs: 0 });
  check('live: staleMs=0 disables the horizon', zKept.agents.length === 2);

  // ---- and against a real captured force-close log -------------------------
  const zombieLog = fs.readFileSync(path.join(DD, 'zombie-session.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const lastMs = Date.parse(zombieLog[zombieLog.length - 1].ts);
  const zFixNow = L.resolve(zombieLog, { nowMs: lastMs + 90 * 60 * 1000, idleSeconds: 30 });
  check('live: captured force-close log renders nothing 90 min later',
    zFixNow.agents.length === 0,
    zFixNow.agents.length + ' left: ' + zFixNow.agents.map((a) => a.type).slice(0, 5).join(','));
  const zFixOld = L.resolve(zombieLog, { nowMs: lastMs + 90 * 60 * 1000, idleSeconds: 30, staleMs: 0 });
  check('live: without the horizon that same log would leave zombies behind',
    zFixOld.agents.length > 0, 'sanity of the test itself');
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

// --- 11. run view: claude argv construction -------------------------
{
  const base = buildClaudeArgs({ prompt: 'add a test for parseFoo' });
  check('claudeArgs: -p prompt is its own element, verbatim',
    base.args[0] === '-p' && base.args[1] === 'add a test for parseFoo');
  check('claudeArgs: stream-json + verbose always present',
    base.args.includes('--output-format') &&
    base.args[base.args.indexOf('--output-format') + 1] === 'stream-json' &&
    base.args.includes('--verbose'));
  check('claudeArgs: default command is claude, no permission flag',
    base.command === 'claude' && !base.args.includes('--permission-mode') &&
    !base.args.join(' ').includes('dangerously'));

  const full = buildClaudeArgs({
    claudePath: 'claude.cmd',
    prompt: 'say "hi" & echo done',
    resume: 'sess-1234',
    permissionMode: 'acceptEdits',
    extraArgs: ['--allowedTools', 'Read Edit'],
  });
  check('claudeArgs: resume id appended after --resume',
    full.args[full.args.indexOf('--resume') + 1] === 'sess-1234');
  check('claudeArgs: permission mode appended when not default',
    full.args[full.args.indexOf('--permission-mode') + 1] === 'acceptEdits');
  check('claudeArgs: extra args appended verbatim, in order',
    full.args.slice(-2).join(' ') === '--allowedTools Read Edit');
  check('claudeArgs: prompt with shell metachars stays one element',
    full.args[1] === 'say "hi" & echo done');
  check('claudeArgs: falsy resume adds nothing',
    !buildClaudeArgs({ prompt: 'x', resume: null }).args.includes('--resume'));
  check('claudeArgs: unknown permission mode throws', (() => {
    try { buildClaudeArgs({ prompt: 'x', permissionMode: 'yolo' }); return false; }
    catch (e) { return /unknown claudePermissionMode/.test(e.message); }
  })());

  check('claudeArgs: win candidates try .exe then .cmd then bare',
    JSON.stringify(candidateCommands('claude', 'win32')) ===
    JSON.stringify(['claude.exe', 'claude.cmd', 'claude.bat', 'claude']));
  check('claudeArgs: non-win candidates are just the name',
    JSON.stringify(candidateCommands('claude', 'linux')) === JSON.stringify(['claude']));
  check('claudeArgs: explicit extension is trusted as-is',
    JSON.stringify(candidateCommands('claude.cmd', 'win32')) === JSON.stringify(['claude.cmd']));
}

// --- 11b. winWrap: Windows .cmd launcher is resolved, never shelled ---
{
  check('winWrap: needsCmdWrap only for .cmd/.bat on win32',
    needsCmdWrap('claude.cmd', 'win32') && needsCmdWrap('x.bat', 'win32') &&
    !needsCmdWrap('claude.exe', 'win32') && !needsCmdWrap('claude.cmd', 'linux'));

  // cmd.exe tokeniser: whitespace splits, `"` toggles, backslash is literal
  check('winWrap: tokenizeCmdLine keeps backslash paths intact',
    JSON.stringify(tokenizeCmdLine('"%dp0%\\node.exe"  "%dp0%\\cli.js" %*')) ===
    JSON.stringify(['%dp0%\\node.exe', '%dp0%\\cli.js', '%*']));

  const DIR = 'C:\\tools\\npm';
  // modern npm shim that forwards straight to a bundled .exe
  const exeShim = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b',
    ':start', 'SETLOCAL', 'CALL :find_dp0',
    '"%dp0%\\node_modules\\@scope\\cli\\bin\\cli.exe"   %*',
  ].join('\r\n');
  const exeParsed = parseCmdShim(exeShim, DIR);
  check('winWrap: .exe-forwarding shim resolves to the real exe, no args',
    exeParsed && exeParsed.file === 'C:/tools/npm/node_modules/@scope/cli/bin/cli.exe' &&
    exeParsed.prefixArgs.length === 0, JSON.stringify(exeParsed));

  // classic npm shim that forwards to `node <cli.js>` via %_prog%
  const jsShim = [
    '@IF EXIST "%~dp0\\node.exe" (', '  SET "_prog=%~dp0\\node.exe"', ') ELSE (',
    '  SET "_prog=node"', ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@scope\\cli\\cli.js" %*',
  ].join('\r\n');
  const jsParsed = parseCmdShim(jsShim, DIR);
  check('winWrap: node-forwarding shim resolves to node + the cli.js path',
    jsParsed && jsParsed.file === 'node' &&
    JSON.stringify(jsParsed.prefixArgs) === JSON.stringify(['C:/tools/npm/node_modules/@scope/cli/cli.js']),
    JSON.stringify(jsParsed));

  check('winWrap: an unrecognisable .cmd is refused (null), never shelled',
    parseCmdShim('@echo off\r\necho hello world\r\n', DIR) === null &&
    parseCmdShim('@"%SOME_UNSET_VAR%\\thing.exe" %*', DIR) === null);

  // --- spawn-level regression: a real shim, a hostile prompt, no shell ---
  // Build a working npm-style shim that forwards to `node <echo-argv.mjs>`,
  // resolve it exactly the way the extension does, spawn the result with NO
  // shell, and prove the child got the prompt verbatim and nothing else ran.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentyard-shim-'));
  const echoJs = path.join(tmp, 'echo-argv.mjs');
  fs.writeFileSync(echoJs, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const shimCmd = path.join(tmp, 'claude.cmd');
  fs.writeFileSync(shimCmd,
    ['@ECHO off', 'SETLOCAL', '"%~dp0\\node.exe" "%~dp0\\echo-argv.mjs" %*'].join('\r\n'));

  const resolved = resolveLauncher('claude.cmd', {
    which: (n) => (n === 'claude.cmd' ? shimCmd : null),
    read: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } },
    exists: (p) => fs.existsSync(p),
    nodePath: process.execPath,
  });
  check('winWrap: resolveLauncher points at a runnable node + script',
    resolved && /node(\.exe)?$/i.test(resolved.file) &&
    resolved.prefixArgs.length === 1 && /echo-argv\.mjs$/.test(resolved.prefixArgs[0]),
    JSON.stringify(resolved));

  const HOSTILE = 'refactor x" & echo OWNED>' + path.join(tmp, 'PWNED.txt') + ' & rem ';
  const userArgs = ['-p', HOSTILE, '--verbose'];
  let childArgv = null;
  let spawnErr = null;
  try {
    const file = /node(\.exe)?$/i.test(resolved.file) && !fs.existsSync(resolved.file)
      ? process.execPath : resolved.file;
    const outBuf = execFileSync(file, resolved.prefixArgs.concat(userArgs), {
      timeout: 8000, windowsHide: true, shell: false,
    });
    childArgv = JSON.parse(String(outBuf));
  } catch (e) {
    spawnErr = e.message;
  }
  check('winWrap: child received the hostile prompt as ONE verbatim argv element',
    !spawnErr && Array.isArray(childArgv) &&
    childArgv.length === 3 && childArgv[1] === HOSTILE,
    spawnErr || JSON.stringify(childArgv));
  check('winWrap: no injected command ran — PWNED file was not created',
    !fs.existsSync(path.join(tmp, 'PWNED.txt')));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

// --- 12. run view: stream-json parser -------------------------------
{
  const fixture = fs.readFileSync(path.join(DD, 'sample-stream-json.jsonl'), 'utf8');
  // feed it in two arbitrary chunks to prove partial-line buffering
  const cut = Math.floor(fixture.length / 2);
  const p = new StreamJsonParser();
  const items = p.push(fixture.slice(0, cut))
    .concat(p.push(fixture.slice(cut)))
    .concat(p.flush());
  const kinds = items.map((i) => i.kind);
  check('streamJson: emits a system init item first', kinds[0] === 'system');
  check('streamJson: system item carries session + model + tool count',
    items[0].sessionId === 'demo-run-0001' && items[0].model === 'claude-sonnet-4' && items[0].tools === 6);
  check('streamJson: assistant text becomes an assistant item',
    items.some((i) => i.kind === 'assistant' && /haiku/.test(i.text)));
  const tool = items.find((i) => i.kind === 'tool' && i.name === 'Edit');
  check('streamJson: tool_use -> compact tool item with path summary',
    tool && tool.summary === '/home/dev/widget-shop/README.md');
  const bash = items.find((i) => i.kind === 'tool' && i.name === 'Bash');
  check('streamJson: Bash tool summarised to the command', bash && bash.summary === 'npm test --silent');
  check('streamJson: tool_result -> tool-result item (ok)',
    items.some((i) => i.kind === 'tool-result' && i.ok === true && /12 passing/.test(i.preview)));
  const result = items.find((i) => i.kind === 'result');
  check('streamJson: result item ok + turns + duration + session',
    result && result.ok === true && result.numTurns === 4 && result.durationMs === 9120 &&
    result.sessionId === 'demo-run-0001');
  check('streamJson: parser exposes the last session id', p.sessionId === 'demo-run-0001');

  // robustness: a non-JSON line -> a 'log' item, never a throw
  const p2 = new StreamJsonParser();
  const j2 = p2.push('not json here\n{"type":"result","subtype":"success","result":"ok","num_turns":1}\n');
  check('streamJson: non-JSON stdout line becomes a log item, no throw',
    j2[0].kind === 'log' && j2[0].text === 'not json here' && j2[1].kind === 'result');

  // run.js pure formatter
  check('run.describe: tool item -> "→ Name: summary"',
    win.AY.run.describe({ kind: 'tool', name: 'Bash', summary: 'npm test' }).text === '→ Bash: npm test');
  check('run.describe: a successful result is a summary line with no body (answer already streamed)',
    win.AY.run.describe({ kind: 'result', ok: true, text: 'all good', numTurns: 2 }).body === '' &&
    /done/.test(win.AY.run.describe({ kind: 'result', ok: true, text: 'all good', numTurns: 2 }).text));
  check('run.describe: an error result still carries its text as the body',
    win.AY.run.describe({ kind: 'result', ok: false, text: 'boom' }).body === 'boom');

  // one 'system' feed item per run even when claude emits several system records
  const pSys = new StreamJsonParser();
  const sysItems = pSys.push(
    '{"type":"system","subtype":"init","session_id":"s1","model":"m","tools":["a","b"]}\n' +
    '{"type":"system","subtype":"info","session_id":"s1"}\n' +
    '{"type":"system","subtype":"info","session_id":"s1"}\n'
  );
  check('streamJson: only the first (init) system record becomes a feed item',
    sysItems.filter((i) => i.kind === 'system').length === 1 && sysItems[0].tools === 2);
}

// --- 13. run view: Cancel kills the whole process tree --------------
{
  const cp = require('node:child_process');
  // a parent that spawns a long-lived child, so we prove tree-kill, not just
  // a single kill(). Both should be gone after killTree().
  const parentSrc =
    'const cp=require("child_process");' +
    'const c=cp.spawn(process.execPath,["-e","setInterval(()=>{},1e9)"],{stdio:"ignore"});' +
    'process.stdout.write(String(c.pid));' +
    'setInterval(()=>{},1e9);';
  const child = cp.spawn(process.execPath, ['-e', parentSrc], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: process.platform !== 'win32',
  });
  let grandPid = 0;
  child.stdout.on('data', (d) => { grandPid = parseInt(String(d).trim(), 10) || grandPid; });

  await new Promise((r) => setTimeout(r, 400));
  const parentPid = child.pid;
  check('cancel: test processes are alive before kill',
    isAlive(parentPid) && grandPid > 0 && isAlive(grandPid), 'parent=' + parentPid + ' grand=' + grandPid);

  const ok = await killTree(child, { graceMs: 300 });
  await new Promise((r) => setTimeout(r, 400));
  check('cancel: killTree resolves truthy', ok === true);
  check('cancel: parent process is gone', !isAlive(parentPid));
  check('cancel: spawned child process is gone too', !isAlive(grandPid), 'grand=' + grandPid);
  check('cancel: killTree on an already-dead/empty child is safe',
    (await killTree(null)) === false);
}

check('extension registers WebviewViewProvider',
  /registerWebviewViewProvider\(\s*['"]agentyard\.office['"]/.test(
    fs.readFileSync(path.join(EXT_ROOT, 'extension.js'), 'utf8')));
check('retainContextWhenHidden set',
  /retainContextWhenHidden:\s*true/.test(fs.readFileSync(path.join(EXT_ROOT, 'extension.js'), 'utf8')));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 50).unref();
