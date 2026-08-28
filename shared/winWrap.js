'use strict';

/**
 * Running a `.cmd` / `.bat` on Windows through `child_process.spawn` now
 * requires a shell. Node's own `shell: true` joins argv with spaces and does
 * NO quoting, so a prompt with a space or a quote would break apart or worse.
 *
 * Instead we build the command line ourselves: each argv element is quoted with
 * the standard CommandLineToArgvW backslash/quote rules, the whole thing is
 * wrapped for `cmd.exe /d /s /c "..."`, and spawned with
 * `windowsVerbatimArguments: true` so Node passes our string through untouched.
 * This is strictly safer than `shell: true` — every element, prompt included,
 * is escaped.
 *
 * Pure (no child_process / fs). The extension calls this to shape spawn args.
 */

// Quote one argv element per CommandLineToArgvW rules.
function quoteArg(s) {
  s = String(s);
  if (s.length > 0 && !/[ \t\n\v"]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      backslashes++;
    } else if (c === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + c;
      backslashes = 0;
    }
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

/**
 * Wrap (command, args) for cmd.exe.
 * @returns {{file:string, args:string[], windowsVerbatimArguments:boolean}}
 */
function wrapForCmd(command, args) {
  const parts = [command].concat(Array.isArray(args) ? args : []).map(quoteArg);
  // Outer quotes: with /s, cmd strips exactly one leading and one trailing quote
  // and runs the rest verbatim.
  const line = '"' + parts.join(' ') + '"';
  const comspec = (typeof process !== 'undefined' && process.env && process.env.ComSpec) || 'cmd.exe';
  return { file: comspec, args: ['/d', '/s', '/c', line], windowsVerbatimArguments: true };
}

function needsCmdWrap(command, platform) {
  const plat = platform || process.platform;
  return plat === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));
}

module.exports = { quoteArg, wrapForCmd, needsCmdWrap };
