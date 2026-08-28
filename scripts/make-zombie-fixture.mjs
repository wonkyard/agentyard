// Regenerates dev-data/zombie-session.jsonl from a captured real event log.
// Parses each JSONL record, rewrites machine-specific values to synthetic ones,
// and writes it back out. Run:  node scripts/make-zombie-fixture.mjs <src.jsonl>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/make-zombie-fixture.mjs <captured.jsonl>');
  process.exit(1);
}
const DD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dev-data");
const SID = '00000000-0000-4000-8000-00000000dead';

function scrubStr(s) {
  return String(s)
    .replace(/[A-Za-z]:\\Users\\[^\\"]+\\projects\\wonkyard\\agentyard/gi, '/home/dev/widget-shop/tool')
    .replace(/[A-Za-z]:\\Users\\[^\\"]+\\OneDrive\\[^\\"]+\\wonkyard/gi, '/home/dev/widget-shop')
    .replace(/[A-Za-z]:\\Users\\[^\\"]+/gi, '/home/dev')
    .replace(/velog\.io\/@[A-Za-z0-9]+/gi, 'example.com/@dev')
    .replace(/(?:IDEA|TOOL)-\d[\d-]*/g, 'PROJ-XXXX')
    .replace(/hyeokkiyaa|hyeok|wonkyardhq/gi, 'dev');
}

// The staleness/zombie logic in live.js only reads ts / event name / ids /
// cwd — the captured tool_input_summary strings carry nothing the test needs
// and can echo other projects' identifiers, so replace them with a generic
// label per tool.
const GENERIC_SUMMARY = {
  Bash: 'run a shell command', Read: 'read a file', Write: 'write a file',
  Edit: 'edit a file', Grep: 'search files', Glob: 'list files', Task: 'start a subagent',
};

const out = [];
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  const s = line.trim();
  if (!s) continue;
  const r = JSON.parse(s);
  if (r.session_id) r.session_id = SID;
  if (typeof r.tool_input_summary === 'string') {
    r.tool_input_summary = GENERIC_SUMMARY[r.tool_name] || 'work';
  }
  for (const k of ['cwd', 'stop_reason']) {
    if (typeof r[k] === 'string') r[k] = scrubStr(r[k]);
  }
  out.push(JSON.stringify(r));
}
fs.writeFileSync(path.join(DD, 'zombie-session.jsonl'), out.join('\n') + '\n');
console.log('wrote zombie-session.jsonl —', out.length, 'records');
