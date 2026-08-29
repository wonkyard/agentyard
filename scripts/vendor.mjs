// Copies third-party browser runtimes out of node_modules into webview/vendor/
// so the extension and the dev server never touch a CDN at runtime. Run after
// `npm install` whenever one of the pinned versions below changes.
//
//   npm run vendor
//
// Pinned versions live in package.json (sql.js, @xterm/xterm, @xterm/addon-fit);
// this script only copies whatever `npm install` resolved. Bump the version in
// package.json, `npm install`, then `npm run vendor` and commit the result.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');
const NM = path.join(EXT_ROOT, 'node_modules');
const DST = path.join(EXT_ROOT, 'webview', 'vendor');

// [ source path (relative to node_modules), destination name in webview/vendor ]
const assets = [
  ['sql.js/dist/sql-wasm.js', 'sql-wasm.js'],
  ['sql.js/dist/sql-wasm.wasm', 'sql-wasm.wasm'],
  ['sql.js/LICENSE', 'sql.js-LICENSE'],
  // xterm.js: the embedded terminal in the Run view. The UMD build assigns
  // `globalThis.Terminal` / `self.FitAddon`, so a plain <script nonce> tag is
  // enough — no bundler, CSP-safe.
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/xterm/LICENSE', 'xterm-LICENSE'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'xterm-addon-fit.js'],
  ['@xterm/addon-fit/LICENSE', 'xterm-addon-fit-LICENSE'],
];

fs.mkdirSync(DST, { recursive: true });
for (const [from, to] of assets) {
  const src = path.join(NM, from);
  if (!fs.existsSync(src)) {
    console.error('missing ' + src + ' - run `npm install` first');
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(DST, to));
  console.log('vendored ' + to + ' (' + fs.statSync(src).size + ' bytes)');
}
