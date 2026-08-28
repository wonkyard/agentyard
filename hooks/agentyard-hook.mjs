#!/usr/bin/env node
// Agentyard live-activity hook.
//
// Claude Code runs this once per hook event, piping the event JSON on stdin.
// It appends exactly one compact JSON line to
//   <homedir>/.claude/agentyard/events-<session_id>.jsonl
// and exits. That file is all Agentyard tails to draw live activity.
//
// Design rules:
//   - zero dependencies, no imports from the rest of the extension
//   - never throw on bad input, never block Claude Code, exit fast
//   - NEVER write secrets: tool input is summarised + scrubbed, never dumped
//   - no network, ever
//
// It is safe to run by hand:  echo '{"hook_event_name":"Stop","session_id":"x"}' | node agentyard-hook.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_SUMMARY = 120;

// Redact anything that looks like a credential before it can reach disk.
const SECRET_PATTERNS = [
  /\b[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|SESSION|BEARER|APIKEY|ACCESS)[A-Z0-9_]*\s*[:=]\s*\S+/gi,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/g,
];

function scrub(s) {
  let out = String(s == null ? '' : s);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

function clip(s) {
  s = scrub(s).replace(/\s+/g, ' ').trim();
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY - 1) + '…' : s;
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

// Turn tool_input into something short and safe. Path-like tools -> just the
// path. Bash -> the command head. Everything else -> a tiny key hint, never the
// full object.
function summariseToolInput(toolName, input) {
  if (input == null || typeof input !== 'object') {
    return input == null ? null : clip(input);
  }
  const name = String(toolName || '').toLowerCase();
  if (name === 'bash' || name === 'shell') {
    return clip(firstString(input.command, input.cmd, input.script) || '');
  }
  if (name === 'read' || name === 'edit' || name === 'write' || name === 'multiedit' || name === 'notebookedit') {
    return clip(firstString(input.file_path, input.path, input.notebook_path, input.filePath) || '');
  }
  if (name === 'glob' || name === 'grep' || name === 'search') {
    return clip(firstString(input.pattern, input.query, input.glob) || '');
  }
  if (name === 'task') {
    return clip(firstString(input.description, input.subagent_type, input.prompt) || '');
  }
  if (name === 'webfetch' || name === 'websearch') {
    return clip(firstString(input.url, input.query, input.prompt) || '');
  }
  if (name === 'todowrite') return 'updating todo list';
  // Unknown tool: expose only the shape, scrubbed and clipped.
  const keys = Object.keys(input).slice(0, 4);
  const bits = [];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') bits.push(`${k}=${v}`);
    else if (typeof v === 'number' || typeof v === 'boolean') bits.push(`${k}=${v}`);
    else bits.push(k);
  }
  return clip(bits.join(' ')) || null;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const rawText = readStdin();
  let e = {};
  try {
    e = JSON.parse(rawText) || {};
  } catch {
    e = {};
  }
  if (!e || typeof e !== 'object') e = {};

  const sessionId = firstString(e.session_id, e.sessionId) || 'unknown';
  const eventName = firstString(e.hook_event_name, e.hookEventName, e.event) || 'Unknown';

  const rec = {
    ts: new Date().toISOString(),
    hook_event_name: eventName,
    session_id: sessionId,
    cwd: firstString(e.cwd, e.workspace, e.project_dir) || null,
  };

  const agentId = firstString(e.agent_id, e.agentId, e.subagent_id);
  const agentType = firstString(e.agent_type, e.agentType, e.subagent_type);
  if (agentId) rec.agent_id = agentId;
  if (agentType) rec.agent_type = clip(agentType);

  const toolName = firstString(e.tool_name, e.toolName);
  if (toolName) {
    rec.tool_name = clip(toolName);
    const summary = summariseToolInput(toolName, e.tool_input != null ? e.tool_input : e.toolInput);
    if (summary) rec.tool_input_summary = summary;
  }

  // PermissionRequest / permission decision info, if any.
  const perm = firstString(
    e.permission,
    e.permission_decision,
    e.decision,
    e.permission_mode,
    e.permissionRequest && e.permissionRequest.tool_name
  );
  if (perm) rec.permission = clip(perm);

  const stopReason = firstString(e.stop_reason, e.stopReason, e.reason, e.message, e.notification);
  if (stopReason) rec.stop_reason = clip(stopReason);

  const dir = path.join(os.homedir(), '.claude', 'agentyard');
  const file = path.join(dir, `events-${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch {
    // disk problems must never break the session
  }
}

try {
  main();
} catch {
  // swallow everything
}
process.exit(0);
