// Copies the sql.js WASM runtime out of node_modules into webview/vendor/ so the
// extension and the dev server never touch a CDN at runtime. Run after npm install
// if you ever bump the sql.js version.
//
//   npm run vendor

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const SRC = path.join(EXT_ROOT, 'node_modules', 'sql.js', 'dist');
const DST = path.join(EXT_ROOT, 'webview', 'vendor');

const files = [
  ['sql-wasm.js', 'sql-wasm.js'],
  ['sql-wasm.wasm', 'sql-wasm.wasm'],
];

fs.mkdirSync(DST, { recursive: true });
for (const [from, to] of files) {
  const src = path.join(SRC, from);
  if (!fs.existsSync(src)) {
    console.error('missing ' + src + ' - run `npm install` first');
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(DST, to));
  console.log('vendored ' + to + ' (' + fs.statSync(src).size + ' bytes)');
}
const lic = path.join(EXT_ROOT, 'node_modules', 'sql.js', 'LICENSE');
if (fs.existsSync(lic)) {
  fs.copyFileSync(lic, path.join(DST, 'sql.js-LICENSE'));
  console.log('vendored sql.js-LICENSE');
}
