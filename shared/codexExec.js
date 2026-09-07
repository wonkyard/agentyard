'use strict';

/**
 * Parses the JSONL that `codex exec … --json` writes to stdout and turns it
 * into the SAME compact "feed items" the Run view already renders for a
 * `claude -p` run (see shared/streamJson.js). Pure and dependency-free: runs in
 * the extension (require) and is unit-tested in scripts/sanity.mjs against a
 * fixture. Never writes anything anywhere — the caller forwards items to the
 * webview only.
 *
 * Codex's event stream is the same family of records as a rollout transcript
 * (`shared/codexSessions.js`), so the shape-tolerance here mirrors that module:
 * `{type, payload:{type,…}}`, a flatter `{type,…}`, or `{msg:{type,…}}`. A
 * malformed line is skipped, never thrown.
 *
 * Feed item kinds (a subset of the Claude feed's kinds, plus 'prompt'/'text'/'error'
 * which webview/js/run.js `describe()` also renders):
 *   { kind: 'prompt', text }                       // the initial user message, if echoed
 *   { kind: 'text',   text }                        // an assistant / agent message
 *   { kind: 'tool',   name, summary, text }         // a shell / command / patch / tool call
 *   { kind: 'result', ok:boolean, text, numTurns, meta }   // task_complete
 *   { kind: 'error',  text }                        // an error payload
 *
 * The session id from the first `session_meta` / `task_started` is captured for
 * `codex exec resume`.
 */

const MAX_TEXT = 4000;
const MAX_SUMMARY = 160;

function clip(s, n) {
  s = String(s == null ? '' : s).replace(/\r/g, '');
  const lim = n || MAX_TEXT;
  return s.length > lim ? s.slice(0, lim - 1) + '…' : s;
}

function oneLine(s) {
  return clip(String(s == null ? '' : s).replace(/\s+/g, ' ').trim(), MAX_SUMMARY);
}

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

// Compact "→ name: summary" line, identical in format to the Claude tool line
// (webview/js/run.js `describe()` builds the same string from name + summary).
function toolText(name, summary) {
  return '→ ' + name + (summary ? ': ' + summary : '');
}

// One already-parsed record → 0..n feed items. `state` carries { sessionId }.
function recordToItems(rec, state) {
  const out = [];
  if (!rec || typeof rec !== 'object') return out;

  const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload
    : (rec.msg && typeof rec.msg === 'object' ? rec.msg : rec);
  const top = String(rec.type || rec.record_type || '');
  const inner = String(payload.type || '');

  // identity: session_meta / task_started / thread.started / configured
  if (top === 'session_meta' || top === 'session' || inner === 'session_meta' ||
      inner === 'thread.started' || inner === 'session_configured') {
    const meta = payload.id || payload.cwd || payload.session_id ? payload : rec;
    const sid = pick(meta, ['id', 'session_id', 'conversation_id', 'thread_id', 'uuid']);
    if (sid) state.sessionId = String(sid);
    return out;
  }
  const anySid = pick(rec, ['session_id', 'conversation_id', 'thread_id']) ||
    pick(payload, ['session_id', 'conversation_id', 'thread_id']);
  if (anySid && !state.sessionId) state.sessionId = String(anySid);

  // the initial user message
  if (inner === 'user_message' || top === 'user_message' ||
      (inner === 'message' && payload.role === 'user')) {
    const t = pick(payload, ['message', 'text', 'content']);
    if (t) out.push({ kind: 'prompt', text: clip(t) });
    return out;
  }

  // end of the task / turn
  if (inner === 'task_complete' || inner === 'turn_complete' || inner === 'turn.completed' ||
      top === 'turn.completed') {
    const usage = payload.usage || payload.token_usage || null;
    const turns = pick(payload, ['turn_count', 'num_turns', 'turns']);
    out.push({
      kind: 'result',
      ok: true,
      text: clip(pick(payload, ['last_agent_message', 'message', 'text']) || ''),
      numTurns: typeof turns === 'number' ? turns : null,
      meta: usage && typeof usage === 'object' ? { usage } : null,
    });
    return out;
  }

  // an error payload
  if (inner === 'error' || inner === 'stream_error' || top === 'error' || payload.error) {
    out.push({ kind: 'error', text: oneLine(pick(payload, ['message', 'error']) || 'error') });
    return out;
  }

  // a tool / shell / patch call
  if (top === 'response_item' || inner === 'function_call' || inner === 'tool_call' ||
      inner === 'exec_command_begin' || inner === 'patch_apply_begin' ||
      inner === 'mcp_tool_call_begin') {
    const name = pick(payload, ['name', 'tool', 'tool_name']) ||
      (inner === 'exec_command_begin' ? 'shell'
        : inner === 'patch_apply_begin' ? 'apply_patch' : 'tool');
    let summary = pick(payload, ['command', 'arguments', 'cmd', 'query', 'path']);
    if (Array.isArray(summary)) summary = summary.join(' ');
    const s = summary ? oneLine(summary) : '';
    out.push({ kind: 'tool', name: String(name), summary: s, text: toolText(String(name), s) });
    return out;
  }

  // a full assistant message (deltas are skipped to avoid a flood)
  if (inner === 'agent_message' || top === 'agent_message' ||
      (inner === 'message' && payload.role === 'assistant')) {
    const t = pick(payload, ['message', 'text', 'content', 'last_agent_message']);
    if (t) out.push({ kind: 'text', text: clip(t) });
    return out;
  }

  // task_started / reasoning / token_count / turn_context / config → nothing
  return out;
}

class CodexExecParser {
  constructor() {
    this.buf = '';
    this.state = { sessionId: null };
  }

  get sessionId() {
    return this.state.sessionId;
  }

  push(chunk) {
    this.buf += String(chunk == null ? '' : chunk);
    const items = [];
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this._line(line, items);
    }
    return items;
  }

  flush() {
    const items = [];
    if (this.buf.trim()) this._line(this.buf, items);
    this.buf = '';
    return items;
  }

  _line(raw, items) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch (e) {
      return; // a non-JSON line is skipped, never a throw (matches codexSessions.js)
    }
    for (const it of recordToItems(rec, this.state)) items.push(it);
  }
}

module.exports = { CodexExecParser, recordToItems, toolText };
