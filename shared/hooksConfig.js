'use strict';

/**
 * Builds and merges the `hooks` block Agentyard adds to a Claude Code
 * settings.json so live activity flows into the event log. Pure functions,
 * no fs / vscode — the extension does the actual file IO, the sanity test
 * exercises the merge logic directly.
 *
 * Agentyard's own entries are always recognisable by their command string
 * containing `agentyard-hook.mjs`, so disable can strip exactly ours and
 * leave every other hook untouched.
 */

// Every event we want to see. Matcher "" = all tools / all cases.
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Notification',
];

const MARKER = 'agentyard-hook.mjs';

// The command string that goes in settings.json. `node` + absolute script
// path with forward slashes so it works the same on Windows and POSIX.
function hookCommand(scriptPath) {
  const p = String(scriptPath).replace(/\\/g, '/');
  return `node "${p}"`;
}

function isOurEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  return hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(MARKER));
}

// The exact object we merge in (also what the confirm dialog shows).
function buildHooksBlock(scriptPath) {
  const cmd = hookCommand(scriptPath);
  const block = {};
  for (const ev of HOOK_EVENTS) {
    block[ev] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: cmd }],
      },
    ];
  }
  return block;
}

// Deep-ish clone that is fine for plain JSON settings.
function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

/**
 * Merge Agentyard's hooks into a parsed settings object without clobbering
 * anything the user already has. Returns a NEW object.
 */
function mergeHooks(settings, scriptPath) {
  const out = clone(settings) || {};
  if (!out.hooks || typeof out.hooks !== 'object') out.hooks = {};
  const block = buildHooksBlock(scriptPath);
  for (const ev of HOOK_EVENTS) {
    const existing = Array.isArray(out.hooks[ev]) ? out.hooks[ev] : [];
    const kept = existing.filter((entry) => !isOurEntry(entry)); // drop stale ours
    out.hooks[ev] = kept.concat(block[ev]);
  }
  return out;
}

/**
 * Remove ONLY Agentyard's entries. Returns a NEW object. Empty arrays and an
 * empty `hooks` object are cleaned up so we don't leave litter.
 */
function removeHooks(settings) {
  const out = clone(settings) || {};
  if (!out.hooks || typeof out.hooks !== 'object') return out;
  for (const ev of Object.keys(out.hooks)) {
    if (!Array.isArray(out.hooks[ev])) continue;
    const kept = out.hooks[ev].filter((entry) => !isOurEntry(entry));
    if (kept.length) out.hooks[ev] = kept;
    else delete out.hooks[ev];
  }
  if (Object.keys(out.hooks).length === 0) delete out.hooks;
  return out;
}

/** True if the given raw settings text already wires up our hook. */
function textHasOurHooks(text) {
  return typeof text === 'string' && text.includes(MARKER);
}

/**
 * Tolerant JSON(-C) parse: strips // and /* *​/ comments and trailing commas
 * while respecting string literals. Returns {} on total failure.
 */
function parseLenient(text) {
  const src = String(text || '');
  let out = '';
  let inStr = false;
  let strCh = '';
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += src[i + 1] || '';
        i++;
      } else if (c === strCh) {
        inStr = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  // trailing commas
  out = out.replace(/,(\s*[}\]])/g, '$1');
  const trimmed = out.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

module.exports = {
  HOOK_EVENTS,
  MARKER,
  hookCommand,
  buildHooksBlock,
  mergeHooks,
  removeHooks,
  textHasOurHooks,
  parseLenient,
};
