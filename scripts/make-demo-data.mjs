// Generates the SYNTHETIC demo fixtures under dev-data/ :
//   dev-data/agents/*.md   fake department agents
//   dev-data/team/*.md      fake project-repo team roles
//   dev-data/demo.db        fake projects + status_log + gate_decisions
//
// None of this references real WONKYARD ideas, stages, or repos. It is what the
// committed screenshot and `npm run dev` / `npm run sanity` render by default.
//
//   npm run demo-data

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DD = path.join(ROOT, 'dev-data');
const AGENTS = path.join(DD, 'agents');
const TEAM = path.join(DD, 'team');

fs.mkdirSync(AGENTS, { recursive: true });
fs.mkdirSync(TEAM, { recursive: true });

function md(dir, file, attrs) {
  const fm = Object.entries(attrs)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(
    path.join(dir, file),
    `---\n${fm}\n---\n\nSynthetic demo agent. Not a real WONKYARD department.\n`
  );
}

// --- fake departments -----------------------------------------------------
const departments = [
  ['front-desk', 'haiku', 'Greets visitors and routes each request to the right room.'],
  ['scout', 'haiku', 'Explores new ideas and checks whether anyone actually wants them.'],
  ['forge', 'sonnet', 'Builds the product once a plan has been approved. Owns tests.'],
  ['proving-grounds', 'sonnet', 'Runs safety and reliability checks before anything ships.'],
  ['megaphone', 'sonnet', 'Handles launch, distribution and pricing for shipped products.'],
  ['concierge', 'haiku', 'Answers customer questions and gathers feedback for the team.'],
  ['ledger', 'sonnet', 'Tracks costs versus revenue and calls the profit / loss.'],
  ['quartermaster', 'haiku', 'Keeps the shared tools, licences and supplies stocked.'],
];
for (const [name, model, description] of departments) {
  md(AGENTS, `${name}.md`, { name, description, tools: 'Read, Write', model });
}

// --- fake project-repo team roles ---------------------------------------
const team = [
  ['squad-lead', 'sonnet', 'Owns this one product’s direction and backlog.'],
  ['squad-eng', 'sonnet', 'Implements the current priority for this product. Owns tests.'],
  ['squad-ops', 'haiku', 'Scans this product for update and monetization opportunities.'],
  ['squad-scribe', 'haiku', 'Writes the daily "what happened in this repo" summary.'],
  ['gate-keeper', 'sonnet', 'Reviews the diff right before any release. PASS or BLOCK.'],
];
for (const [name, model, description] of team) {
  md(TEAM, `${name}.md`, { name, description, tools: 'Read, Write', model });
}

// --- fake company.db ----------------------------------------------------
const SQL = await initSqlJs();
const db = new SQL.Database();
db.run(`
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY, idea_summary TEXT NOT NULL, created_at TEXT NOT NULL,
  current_stage TEXT NOT NULL DEFAULT 'research', updated_at TEXT NOT NULL, repo_url TEXT,
  local_path TEXT
);
CREATE TABLE gate_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, gate TEXT NOT NULL,
  decision TEXT NOT NULL, reason TEXT, ts TEXT NOT NULL
);
CREATE TABLE status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, department TEXT NOT NULL,
  status TEXT NOT NULL, note TEXT, ts TEXT NOT NULL
);
CREATE TABLE project_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, report_date TEXT NOT NULL,
  summary TEXT NOT NULL, detail_path TEXT, ts TEXT NOT NULL
);
`);

// local_path is a SYNTHETIC placeholder — never a real machine path. Split repos
// carry one (used by §7 annex-attribution); pre-split ideas don't.
const projects = [
  ['DEMO-0001', 'Talking toaster companion app', 'building', null, null],
  ['DEMO-0002', 'Cloud garden subscription box', 'launch-ready', 'https://example.com/demo/cloud-garden', '/demo/workspace/cloud-garden'],
  ['DEMO-0003', 'Retro synth keyboard firmware', 'shipped', 'https://example.com/demo/retro-synth', '/demo/workspace/retro-synth'],
  ['DEMO-0004', 'Pocket weather balloon kit', 'killed', null, null],
];
for (const [id, summary, stage, repo, localPath] of projects) {
  db.run(
    'INSERT INTO projects (project_id, idea_summary, created_at, current_stage, updated_at, repo_url, local_path) VALUES (?,?,?,?,?,?,?)',
    [id, summary, '2026-01-02 09:00:00', stage, '2026-01-09 16:30:00', repo, localPath]
  );
}

// status rows in insert order; model.js keeps the latest per (project, department)
const statuses = [
  ['DEMO-0001', 'forge', 'working', 'wiring up the toaster voice lines', '2026-01-09 15:55:00'],
  ['DEMO-0001', 'proving-grounds', 'blocked', 'waiting on a fire-safety sign-off', '2026-01-09 16:10:00'],
  ['DEMO-0004', 'scout', 'idle', 'shelved — nobody wanted it', '2026-01-05 11:00:00'],
  ['DEMO-0002', 'megaphone', 'working', 'drafting the launch announcement post', '2026-01-09 16:20:00'],
  ['DEMO-0003', 'ledger', 'idle', 'january numbers done, margin looks healthy', '2026-01-08 10:00:00'],
  ['DEMO-0002', 'squad-lead', 'idle', 'backlog groomed for the week', '2026-01-09 09:30:00'],
  ['DEMO-0003', 'squad-eng', 'working', 'porting the arpeggiator to the new chip', '2026-01-09 16:25:00'],
  ['DEMO-0002', 'gate-keeper', 'blocked', 'found a hard-coded key in the diff, sent it back', '2026-01-09 16:28:00'],
];
for (const row of statuses) {
  db.run('INSERT INTO status_log (project_id, department, status, note, ts) VALUES (?,?,?,?,?)', row);
}

db.run(
  "INSERT INTO gate_decisions (project_id, gate, decision, reason, ts) VALUES ('DEMO-0004','gate1','KILL','no demand found','2026-01-05 10:45:00')"
);

const bytes = Buffer.from(db.export());
db.close();
fs.writeFileSync(path.join(DD, 'demo.db'), bytes);

console.log('wrote dev-data/agents/*.md   (' + departments.length + ')');
console.log('wrote dev-data/team/*.md     (' + team.length + ')');
console.log('wrote dev-data/demo.db       (' + bytes.length + ' bytes)');

setTimeout(() => process.exit(0), 50).unref();
