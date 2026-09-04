'use strict';

const path = require('path');

/**
 * Making `claude` runnable from a GUI-launched editor.
 *
 * A VS Code started from Finder / Dock / the Start menu does NOT inherit the
 * login shell's PATH — it gets a minimal one (`/usr/bin:/bin:/usr/sbin:/sbin`
 * on macOS). So `whichSync('claude')` misses an npm-global / Homebrew / bun /
 * volta install, and even when `claude` itself is found, node-pty exec's it
 * with no shell: the kernel reads its `#!/usr/bin/env node` shebang and looks
 * for `node` on that same minimal PATH, which fails with `posix_spawnp` /
 * `ENOENT` (see reports/TOOL-20260828-1008/posix-spawn-bug.md).
 *
 * This module is pure — no `fs`, no `child_process`, no `vscode`. It takes its
 * filesystem probes as injected callbacks so `extension.js` and `scripts/
 * sanity.mjs` exercise exactly one code path. The extension owns the actual
 * spawn and the small-buffer read of the shebang line.
 */

/**
 * Common install locations for a CLI like `claude` (or the `node` its shim
 * needs) that a minimal GUI PATH tends to miss. Returned as absolute paths
 * relative to `homedir`; the caller filters by existence — nothing here is
 * assumed to be present.
 *
 * @param {string} homedir   os.homedir()
 * @param {string} platform  process.platform
 * @returns {string[]}
 */
function commonBinDirs(homedir, platform) {
  const h = String(homedir || '');
  const j = (...seg) => path.join(h, ...seg);
  if (platform === 'win32') {
    return [
      j('AppData', 'Roaming', 'npm'),                 // npm -g
      j('AppData', 'Local', 'Programs', 'claude'),    // native installer
      j('AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
      j('scoop', 'shims'),
      j('.local', 'bin'),
      j('.codex', 'bin'),                             // Codex CLI
    ];
  }
  return [
    j('.local', 'bin'),          // native installer, pipx-style
    '/opt/homebrew/bin',         // Homebrew on Apple Silicon
    '/usr/local/bin',            // Homebrew on Intel, manual installs
    j('.npm-global', 'bin'),     // npm prefix override
    j('.npm', 'bin'),
    j('.bun', 'bin'),            // bun
    j('.deno', 'bin'),           // deno
    j('.volta', 'bin'),          // volta shims
    j('.asdf', 'shims'),         // asdf shims
    j('.nvm', 'current', 'bin'), // nvm "current" symlink, when present
    j('.codex', 'bin'),          // Codex CLI
    '/usr/bin',
    '/bin',
  ];
}

function pathSep(platform) {
  return platform === 'win32' ? ';' : ':';
}

function stripTrailingSlash(p) {
  return String(p).replace(/[\\/]+$/, '');
}

/**
 * The directory list `whichSync` should search: the process PATH first (so the
 * existing behaviour is unchanged when `claude` is already resolvable), then
 * any of the common install dirs that aren't already in PATH and actually
 * exist. Deduplicated, order-preserving.
 *
 * @param {object} env        process.env (reads PATH / Path)
 * @param {string} homedir    os.homedir()
 * @param {string} platform   process.platform
 * @param {(p:string)=>boolean} [existsSync]  existence probe for the extra dirs
 * @returns {string[]}
 */
function searchDirs(env, homedir, platform, existsSync) {
  const sep = pathSep(platform);
  const fromPath = String((env && (env.PATH || env.Path)) || '')
    .split(sep)
    .map((d) => d.trim())
    .filter(Boolean);
  const seen = new Set(fromPath.map(stripTrailingSlash));
  const out = fromPath.slice();
  for (const d of commonBinDirs(homedir, platform)) {
    const key = stripTrailingSlash(d);
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync && !existsSync(d)) continue;
    out.push(d);
  }
  return out;
}

/**
 * A PATH string with the (existing) common install dirs appended — for the
 * spawn env, so a shebang script's `env node` resolves even under a minimal
 * GUI PATH. Only appends; the caller's existing PATH keeps priority.
 *
 * @returns {{ value:string, added:string[] }}
 */
function augmentPath(currentPath, homedir, platform, existsSync) {
  const sep = pathSep(platform);
  const cur = String(currentPath || '');
  const have = new Set(cur.split(sep).map(stripTrailingSlash).filter(Boolean));
  const added = [];
  for (const d of commonBinDirs(homedir, platform)) {
    if (have.has(stripTrailingSlash(d))) continue;
    if (existsSync && !existsSync(d)) continue;
    added.push(d);
  }
  if (!added.length) return { value: cur, added: [] };
  return { value: cur ? cur + sep + added.join(sep) : added.join(sep), added };
}

/**
 * Is `headText` (the first line, or first ~256 bytes) a `#!…node` shebang —
 * i.e. a JS script that relies on `node` being exec-able, not a real binary?
 * A binary's first bytes are not `#!`, so this is false for it.
 */
function isNodeShebang(headText) {
  if (typeof headText !== 'string') return false;
  const first = headText.split('\n', 1)[0] || '';
  if (first.slice(0, 2) !== '#!') return false;
  // `#!/usr/bin/env node`, `#!/usr/bin/env -S node --foo`, `#!/usr/local/bin/node`
  return /(^|[/\s])node([0-9.]*)?(\s|$)/.test(first.slice(2));
}

/**
 * Given a resolved spawn target `{ file, args }` for `claude`, return a target
 * that runs it under the editor's own bundled Node when `file` is a node
 * shebang script — removing the dependency on a separate `node` on PATH. A
 * real binary (or Windows, where shebangs aren't a kernel concern) is returned
 * unchanged.
 *
 * @param {{file:string,args:string[]}} target
 * @param {{
 *   readHead:(p:string)=>string,   // first line / ~256 bytes of a file ('' on failure)
 *   execPath:string,               // process.execPath (VS Code's Electron/Node)
 *   platform:string,               // process.platform
 * }} io
 * @returns {{file:string,args:string[],env?:object}}
 */
function nodeShebangTarget(target, io) {
  if (!target || !target.file || !io || io.platform === 'win32') return target;
  if (!io.execPath) return target;
  let head = '';
  try { head = io.readHead(target.file) || ''; } catch (e) { return target; }
  if (!isNodeShebang(head)) return target;
  return {
    file: io.execPath,
    args: ['--', target.file].concat(target.args || []),
    // Electron only behaves as a plain Node when this is set in the child env.
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * A recognised failed-to-exec error → an actionable, Korean-first message. Used
 * verbatim at every spawn site instead of leaking `posix_spawnp failed.`.
 *
 * CLI-agnostic: `cli` names which coding-agent backend failed so the message
 * points at the right setting and docs. Called with a string (legacy) or a
 * descriptor; a missing `cli` defaults to Claude Code so old call sites are
 * unchanged.
 *
 * @param {Error|{code?:string,message?:string}} err
 * @param {string} command  the configured CLI command, for the message
 * @param {string} platform process.platform
 * @param {string|{name?:string,bin?:string,setting?:string,docsUrl?:string}} [cli]
 * @returns {string}
 */
function friendlySpawnMessage(err, command, platform, cli) {
  const known = {
    'claude-code': { bin: 'claude', setting: 'agentyard.claudePath', docsUrl: 'https://docs.anthropic.com/claude-code' },
    codex: { bin: 'codex', setting: 'agentyard.codexPath', docsUrl: 'https://github.com/openai/codex' },
  };
  const d = (typeof cli === 'string' ? known[cli] : cli) || known['claude-code'];
  const bin = d.bin || 'claude';
  const setting = d.setting || 'agentyard.claudePath';
  const docsUrl = d.docsUrl || 'https://docs.anthropic.com/claude-code';
  const which = (platform === 'win32' ? 'where ' : 'which ') + bin;
  const raw = (err && (err.message || err.code)) ? String(err.message || err.code) : String(err);
  return (
    'Agentyard가 "' + (command || bin) + '" 를 실행하지 못했어요.\n' +
    '일반 터미널에서 `' + which + '` 결과를 설정의 ' + setting + ' 에 넣어 주세요.\n' +
    '설치가 안 돼 있으면 ' + docsUrl + ' 를 참고하세요.\n' +
    '(원본 오류: ' + raw + ')'
  );
}

/** True for the exec-time failures worth replacing with the friendly message. */
function isExecFailure(err) {
  const code = err && err.code ? String(err.code) : '';
  const msg = err && err.message ? String(err.message) : String(err || '');
  return (
    code === 'ENOENT' || code === 'EACCES' || code === 'EINVAL' ||
    /posix_spawn|spawnp|ENOENT|EACCES/i.test(msg)
  );
}

module.exports = {
  commonBinDirs,
  searchDirs,
  augmentPath,
  isNodeShebang,
  nodeShebangTarget,
  friendlySpawnMessage,
  isExecFailure,
};
