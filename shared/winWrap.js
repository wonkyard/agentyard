'use strict';

const path = require('path');

/**
 * Launching a Windows `.cmd` / `.bat` (e.g. an npm-installed `claude.cmd`)
 * through `child_process.spawn` needs a shell, and there is no safe way to
 * quote arguments for `cmd.exe`. cmd.exe does NOT use the CommandLineToArgvW
 * backslash/quote rules — every `"` just toggles quoted state and backslash is
 * never an escape — so a prompt with an unbalanced `"` before `& | < > ( )`
 * breaks out of the quoted context and cmd.exe runs the rest
 * (CVE-2024-24576 / "BatBadBut"). `%VAR%` is expanded regardless of quoting.
 *
 * So Agentyard does NOT wrap for cmd.exe. Instead: a `.cmd`/`.bat` launcher is
 * almost always a generated shim (npm, pnpm, yarn, bun, …) whose real work is
 * one line that forwards `%*` to an actual executable — `node "<…>\cli.js"` or
 * a bundled `<…>.exe`. `parseCmdShim()` reads that line; `resolveLauncher()`
 * turns it into a concrete `{ file, prefixArgs }`. The caller then spawns that
 * directly with **no shell**, so the prompt is passed verbatim through
 * `CreateProcess` and cmd.exe is never involved. If the shim can't be
 * recognised the caller refuses and asks the user to point
 * `agentyard.claudePath` at the real executable — there is no unsafe cmd.exe
 * fallback.
 *
 * Pure: no `child_process`, no `fs`. `resolveLauncher` takes its file IO as
 * injected callbacks so the extension and the sanity test share one code path.
 */

function needsCmdWrap(command, platform) {
  const plat = platform || process.platform;
  return plat === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));
}

/**
 * Split one cmd.exe line into words. cmd.exe rules: whitespace separates,
 * every `"` toggles quoting, backslash is not an escape.
 */
function tokenizeCmdLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  let started = false;
  for (let i = 0; i < String(line).length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuote = !inQuote;
      started = true;
      continue;
    }
    if (!inQuote && (c === ' ' || c === '\t')) {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

// Placeholders every common shim uses to mean "the directory this shim is in".
// Paths are normalised to forward slashes, which Windows accepts natively.
function expandShimVars(tok, dir) {
  const d = String(dir).replace(/[\\/]+$/, '');
  return String(tok)
    .replace(/%~dp0\\?/gi, d + '/')
    .replace(/%dp0%\\?/gi, d + '/')
    .replace(/%~d0%~p0\\?/gi, d + '/')
    .replace(/\$basedir\/?/gi, d + '/')
    .replace(/%_prog%/gi, 'node');
}

// cmd.exe scaffolding that is never part of the real invocation.
const CMD_NOISE = new Set([
  '@', '@echo', 'echo', 'off', 'title', '%comspec%', 'endlocal', 'setlocal',
  'call', 'goto', '#_undefined_#', '2>nul', '||', '&&', '&', 'if', 'exist',
  'else', '(', ')', 'set', 'exit',
]);

function hasUnresolvedVar(s) {
  return /%[^%\s]*%|%~[a-z0-9]/i.test(String(s));
}

function toSlash(p) {
  return /[\\/]/.test(p) ? path.posix.normalize(String(p).replace(/\\/g, '/')) : p;
}

/**
 * Parse a Windows shim script down to the real executable it forwards to.
 *
 * @param {string} text     full contents of the `.cmd` / `.bat` shim
 * @param {string} shimDir  the directory the shim lives in (for `%~dp0`)
 * @returns {{file:string, prefixArgs:string[]} | null}  null if unrecognised
 */
function parseCmdShim(text, shimDir) {
  const dir = String(shimDir || '').replace(/[\\/]+$/, '');
  const lines = String(text || '').split(/\r?\n/);

  // The exec line forwards all args (`%*`, or `%~1 %~2 …`, or `$@` / `$args`).
  // The last such line wins — earlier ones are usually `IF EXIST` probes.
  let exec = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (/%\*/.test(l) || /"?%~1"?/.test(l) || /\$args\b/.test(l) || /"?\$@"?/.test(l)) exec = l;
  }
  if (!exec) return null;

  // Older one-line npm shims: `… 2>NUL || title %COMSPEC% & "<real>" %*`.
  // Everything up to the last `||` is fallback scaffolding.
  const orIdx = exec.lastIndexOf('||');
  if (orIdx !== -1) exec = exec.slice(orIdx + 2);

  // Drop the trailing forwarded-args placeholder.
  exec = exec
    .replace(/\s*%\*\s*$/, '')
    .replace(/(?:\s*"?%~\d+"?)+\s*$/, '')
    .replace(/\s*\$args\s*$/i, '')
    .replace(/\s*"?\$@"?\s*$/, '')
    .trim();
  if (!exec) return null;

  const toks = tokenizeCmdLine(exec)
    .map((t) => expandShimVars(t, dir))
    .map((t) => t.trim())
    .filter((t) => t && !CMD_NOISE.has(t.toLowerCase()));
  if (!toks.length) return null;

  let file = toks[0];
  const prefixArgs = toks.slice(1).map(toSlash);

  // If anything is still an unexpanded cmd variable, we can't resolve it
  // safely — bail and let the caller refuse.
  if (hasUnresolvedVar(file) || prefixArgs.some(hasUnresolvedVar)) return null;

  file = toSlash(file);
  return { file, prefixArgs };
}

/**
 * Resolve a launcher command to a concrete, shell-free spawn target.
 *
 * @param {string} command  the configured command (bare name or path)
 * @param {{
 *   which: (name:string) => string|null,   // PATH lookup -> absolute path or null
 *   read:  (p:string) => string,           // read a file to text ('' on failure)
 *   exists:(p:string) => boolean,          // does this path exist
 *   nodePath?: string,                     // process.execPath, if it is a real node
 * }} io
 * @returns {{file:string, prefixArgs:string[]} | null}
 */
function resolveLauncher(command, io) {
  const shimPath = io.which(command);
  if (!shimPath) return null;
  const parsed = parseCmdShim(io.read(shimPath), path.dirname(shimPath));
  if (!parsed) return null;

  let file = parsed.file;
  const base = path.basename(file).toLowerCase();
  if (base === 'node' || base === 'node.exe') {
    const sibling = path.join(path.dirname(shimPath), 'node.exe');
    if (io.exists(sibling)) file = sibling;
    else if (io.nodePath && /[\\/]node(\.exe)?$/i.test(io.nodePath)) file = io.nodePath;
    else file = io.which('node.exe') || io.which('node') || 'node';
  } else if ((path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) && !io.exists(file)) {
    return null;
  }
  return { file, prefixArgs: parsed.prefixArgs };
}

module.exports = { needsCmdWrap, tokenizeCmdLine, parseCmdShim, resolveLauncher };
