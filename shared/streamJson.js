'use strict';

/**
 * Parses the NDJSON that `claude -p --output-format stream-json --verbose`
 * writes to stdout and turns it into compact "feed items" for the run view.
 *
 * Pure and dependency-free. Runs in the extension (require) and is unit-tested
 * in scripts/sanity.mjs against fixtures. Never writes anything anywhere — the
 * caller forwards items straight to the webview.
 *
 * Feed item kinds:
 *   { kind: 'system',    sessionId, model, cwd, tools:number }
 *   { kind: 'assistant', text }
 *   { kind: 'tool',      name, summary, id }
 *   { kind: 'tool-result', id, ok:boolean, preview }
 *   { kind: 'result',    ok:boolean, text, durationMs, numTurns, sessionId, costUsd }
 *   { kind: 'log',       text }        // a stdout line that was not JSON
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

function firstString() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

// Compact, readable one-liner for a tool call. Never dumps the whole input.
function summariseToolInput(toolName, input) {
  if (input == null || typeof input !== 'object') {
    return input == null ? '' : oneLine(input);
  }
  const name = String(toolName || '').toLowerCase();
  if (name === 'bash' || name === 'shell') {
    return oneLine(firstString(input.command, input.cmd, input.script) || '');
  }
  if (['read', 'edit', 'write', 'multiedit', 'notebookedit'].indexOf(name) !== -1) {
    return oneLine(firstString(input.file_path, input.path, input.notebook_path, input.filePath) || '');
  }
  if (['glob', 'grep', 'search'].indexOf(name) !== -1) {
    return oneLine(firstString(input.pattern, input.query, input.glob) || '');
  }
  if (name === 'task') {
    return oneLine(firstString(input.description, input.subagent_type, input.prompt) || '');
  }
  if (name === 'webfetch' || name === 'websearch') {
    return oneLine(firstString(input.url, input.query, input.prompt) || '');
  }
  if (name === 'todowrite') return 'updating todo list';
  const keys = Object.keys(input).slice(0, 4);
  const bits = keys.map((k) => {
    const v = input[k];
    return (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? k + '=' + v : k;
  });
  return oneLine(bits.join(' '));
}

function toolResultPreview(content) {
  if (typeof content === 'string') return oneLine(content);
  if (Array.isArray(content)) {
    const txt = content
      .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
      .join(' ');
    return oneLine(txt);
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return oneLine(content.text);
  return '';
}

// Turn one already-parsed stream-json object into 0..n feed items.
function recordToItems(rec, state) {
  const out = [];
  if (!rec || typeof rec !== 'object') return out;
  const type = rec.type;

  if (rec.session_id && typeof rec.session_id === 'string') state.sessionId = rec.session_id;

  if (type === 'system') {
    out.push({
      kind: 'system',
      sessionId: rec.session_id || state.sessionId || null,
      model: firstString(rec.model, rec.slash_model) || null,
      cwd: rec.cwd || null,
      tools: Array.isArray(rec.tools) ? rec.tools.length : 0,
    });
    return out;
  }

  if (type === 'assistant' && rec.message && Array.isArray(rec.message.content)) {
    for (const block of rec.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'assistant', text: clip(block.text) });
      } else if (block.type === 'tool_use') {
        out.push({
          kind: 'tool',
          name: String(block.name || 'tool'),
          summary: summariseToolInput(block.name, block.input),
          id: block.id || null,
        });
      }
    }
    return out;
  }

  if (type === 'user' && rec.message && Array.isArray(rec.message.content)) {
    for (const block of rec.message.content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue;
      out.push({
        kind: 'tool-result',
        id: block.tool_use_id || null,
        ok: !block.is_error,
        preview: toolResultPreview(block.content),
      });
    }
    return out;
  }

  if (type === 'result') {
    const text = firstString(rec.result, rec.error, rec.subtype) || '';
    out.push({
      kind: 'result',
      ok: !rec.is_error && rec.subtype !== 'error_max_turns' && rec.subtype !== 'error_during_execution',
      text: clip(text),
      durationMs: typeof rec.duration_ms === 'number' ? rec.duration_ms : null,
      numTurns: typeof rec.num_turns === 'number' ? rec.num_turns : null,
      costUsd: typeof rec.total_cost_usd === 'number' ? rec.total_cost_usd : null,
      sessionId: rec.session_id || state.sessionId || null,
    });
    return out;
  }

  return out;
}

class StreamJsonParser {
  constructor() {
    this.buf = '';
    this.state = { sessionId: null };
  }

  get sessionId() {
    return this.state.sessionId;
  }

  // Feed a raw stdout chunk; returns an array of feed items.
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

  // Call when the stream closes to flush a trailing line with no newline.
  flush() {
    const items = [];
    if (this.buf.trim()) this._line(this.buf, items);
    this.buf = '';
    return items;
  }

  _line(raw, items) {
    const s = raw.trim();
    if (!s) return;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch (e) {
      items.push({ kind: 'log', text: oneLine(s) });
      return;
    }
    for (const it of recordToItems(rec, this.state)) items.push(it);
  }
}

module.exports = { StreamJsonParser, summariseToolInput, recordToItems };
