'use strict';

/**
 * Pure decision logic for the Run-view model picker (v1.3).
 *
 * The extension computes `{ label, value, options }` per backend and puts it in
 * `collectSnapshot().model`; the webview just renders the label and posts a
 * `modelPick` intent. Same discipline as the v1.2 guideline chip — no model-list
 * logic lives in the webview. No fs, no vscode: the extension does the config
 * read/write and shows the quick-pick, this module only decides what the choices
 * are. The sanity test exercises it directly.
 *
 * Model names drift (Codex especially — gpt-5.x, *-codex, varies by auth), so
 * neither backend gets an enum in package.json and Codex offers free-text only.
 * Claude Code has stable aliases, so it gets them as quick-pick shortcuts plus
 * Custom… for a full model id.
 */

// Claude Code: the stable aliases (`claude --model <alias>`) + a free-text escape
// hatch. `value: ''` clears agentyard.claudeModel so the CLI's own default wins.
const CLAUDE_OPTIONS = [
  { id: 'default', label: 'Default (let Claude Code decide)', value: '' },
  { id: 'sonnet', label: 'Sonnet', value: 'sonnet' },
  { id: 'opus', label: 'Opus', value: 'opus' },
  { id: 'haiku', label: 'Haiku', value: 'haiku' },
  { id: 'opusplan', label: 'Opus Plan', value: 'opusplan' },
  { id: 'custom', label: 'Custom…', value: null, custom: true },
];

// Codex: no known-good list to offer, so just clear-or-type.
const CODEX_OPTIONS = [
  { id: 'default', label: 'Default (codex config / CLI)', value: '' },
  { id: 'custom', label: 'Custom…', value: null, custom: true },
];

function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function backendKey(backendId) {
  return backendId === 'codex' ? 'codex' : 'claude-code';
}

/**
 * @param {string} backendId               'claude-code' | 'codex'
 * @param {{claudeModel?:string, codexModel?:string}} [values]  the raw settings
 * @returns {{backend:string, value:string, label:string, options:Array}}
 */
function pickerState(backendId, values) {
  values = values || {};
  const backend = backendKey(backendId);
  const isCodex = backend === 'codex';
  const value = clean(isCodex ? values.codexModel : values.claudeModel);
  const options = (isCodex ? CODEX_OPTIONS : CLAUDE_OPTIONS).map((o) => Object.assign({}, o));
  return {
    backend,
    value,
    label: value || 'default',
    options,
  };
}

/** The settings key a backend's picker writes. */
function settingKey(backendId) {
  return backendKey(backendId) === 'codex' ? 'agentyard.codexModel' : 'agentyard.claudeModel';
}

module.exports = {
  CLAUDE_OPTIONS,
  CODEX_OPTIONS,
  pickerState,
  settingKey,
};
