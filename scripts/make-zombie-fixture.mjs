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
    .replace(/hyeokkiyaa|hyeok/gi, 'dev');
}

const out = [];
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  const s = line.trim();
  if (!s) continue;
  const r = JSON.parse(s);
  if (r.session_id) r.session_id = SID;
  for (const k of ['cwd', 'tool_input_summary', 'stop_reason']) {
    if (typeof r[k] === 'string') r[k] = scrubStr(r[k]);
  }
  out.push(JSON.stringify(r));
}
fs.writeFileSync(path.join(DD, 'zombie-session.jsonl'), out.join('\n') + '\n');
console.log('wrote zombie-session.jsonl —', out.length, 'records');
