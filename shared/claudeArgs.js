'use strict';

/**
 * Builds the argv for `claude -p` in headless stream-json mode. Pure: no fs,
 * no child_process, no vscode — the extension does the spawn, the sanity test
 * exercises this directly.
 *
 * The prompt is always its own argv element — it is NEVER interpolated into a
 * shell string. See shared/winWrap.js for how a `.cmd`/`.bat` `claudePath` is
 * handled on Windows without `shell: true`.
 *
 * We deliberately do NOT map any permission mode onto a
 * skip-all-permissions flag. Headless `-p` cannot answer a permission prompt,
 * so tools have to be pre-allowed in the user's settings or via
 * `agentyard.claudeExtraArgs` (e.g. `--allowedTools "Read Edit Bash(npm test)"`).
 */

// Values accepted for agentyard.claudePermissionMode. `default` adds no flag.
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

function cleanStr(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * @param {object} opts
 * @param {string} [opts.claudePath]     configured binary name/path (default "claude")
 * @param {string} opts.prompt           the user's prompt (kept verbatim)
 * @param {string|null} [opts.resume]    session id to continue, or falsy for a fresh thread
 * @param {string} [opts.permissionMode] one of PERMISSION_MODES
 * @param {string[]} [opts.extraArgs]    verbatim extra argv (e.g. ["--allowedTools","Read Edit"])
 * @returns {{command:string, args:string[], prompt:string}}
 */
function buildClaudeArgs(opts) {
  opts = opts || {};
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : String(opts.prompt == null ? '' : opts.prompt);

  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

  const mode = cleanStr(opts.permissionMode);
  if (mode && mode !== 'default') {
    if (PERMISSION_MODES.indexOf(mode) === -1) {
      throw new Error('unknown claudePermissionMode: ' + mode);
    }
    args.push('--permission-mode', mode);
  }

  const resume = cleanStr(opts.resume);
  if (resume) args.push('--resume', resume);

  const extra = Array.isArray(opts.extraArgs) ? opts.extraArgs : [];
  for (const a of extra) {
    if (typeof a === 'string' && a.length) args.push(a);
  }

  const command = cleanStr(opts.claudePath) || 'claude';
  return { command, args, prompt };
}

/**
 * Ordered list of executables to try for a bare command name. On Windows an
 * npm-installed CLI is usually `<name>.cmd`; a native install is `<name>.exe`.
 * If the caller already gave an explicit extension or a path separator we trust
 * it as-is.
 */
function candidateCommands(command, platform) {
  const base = cleanStr(command) || 'claude';
  const plat = platform || process.platform;
  const hasExt = /\.[a-z0-9]+$/i.test(base);
  const hasSep = /[\\/]/.test(base);
  if (plat !== 'win32' || hasExt) return [base];
  const list = [base + '.exe', base + '.cmd', base + '.bat', base];
  // keep the caller's literal first if they passed a path
  return hasSep ? [base].concat(list.filter((x) => x !== base)) : list;
}

module.exports = { PERMISSION_MODES, buildClaudeArgs, candidateCommands };
