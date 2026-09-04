'use strict';

/**
 * A Codex rollout transcript (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) is
 * JSONL — one object per line with a top-level `type` and a `payload`. Agentyard
 * only needs enough to place a Codex session in the office scene alongside
 * Claude Code hook events: which session, where it is running (cwd), whether it
 * is working / finished / blocked, and a short "what it's doing" line.
 *
 * Pure: no fs. The extension does the bounded (today + yesterday) directory scan
 * and the incremental byte-offset tail — a mirror of `LiveLog` — then hands the
 * new lines here. A malformed line is skipped, never thrown (same rule as the
 * hook parser in hooks/agentyard-hook.mjs).
 *
 * Normalised event shape:
 *   { ts, source:'codex', session_id, cwd, model?, kind, doing, ended }
 *   kind: 'meta' | 'activity' | 'ended' | 'blocked'
 */

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function tsOf(rec, payload) {
  return pick(rec, ['timestamp', 'ts', 'time']) || pick(payload, ['timestamp', 'ts']) || null;
}

function clip(s, n) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, n || 80);
}

/** One raw JSONL string → a normalised event, or null to skip it. Never throws. */
function parseLine(line) {
  let rec;
  try {
    rec = JSON.parse(String(line == null ? '' : line).trim());
  } catch (e) {
    return null;
  }
  if (!rec || typeof rec !== 'object') return null;

  const payload = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
  const top = String(rec.type || rec.record_type || '');
  const inner = String(payload.type || '');
  const ts = tsOf(rec, payload);

  // session_meta: identity + working directory (+ model)
  if (top === 'session_meta' || top === 'session' || inner === 'session_meta') {
    const meta = payload.id || payload.cwd || payload.model ? payload : rec;
    return {
      ts,
      source: 'codex',
      session_id: pick(meta, ['id', 'session_id', 'conversation_id', 'uuid']),
      cwd: pick(meta, ['cwd', 'workdir', 'working_directory']),
      model: pick(meta, ['model']) || null,
      kind: 'meta',
      doing: null,
      ended: false,
    };
  }

  const base = {
    ts,
    source: 'codex',
    session_id: pick(rec, ['session_id', 'conversation_id']) || pick(payload, ['session_id', 'conversation_id']),
    cwd: pick(rec, ['cwd']) || pick(payload, ['cwd']),
  };

  // end of a turn / task
  if (inner === 'task_complete' || inner === 'turn_complete' || inner === 'turn.completed' ||
      top === 'turn.completed') {
    return Object.assign(base, { model: null, kind: 'ended', doing: null, ended: true });
  }

  // an error payload → the session is blocked / waiting
  if (inner === 'error' || inner === 'stream_error' || top === 'error' || payload.error) {
    const msg = pick(payload, ['message', 'error']) || 'error';
    return Object.assign(base, { model: null, kind: 'blocked', doing: 'error: ' + clip(msg), ended: false });
  }

  // task started
  if (inner === 'task_started' || inner === 'turn_started' || inner === 'turn.started' ||
      top === 'turn.started') {
    return Object.assign(base, { model: null, kind: 'activity', doing: 'working', ended: false });
  }

  // a tool / shell / patch call
  if (top === 'response_item' || inner === 'function_call' || inner === 'tool_call' ||
      inner === 'exec_command_begin' || inner === 'patch_apply_begin') {
    const name = pick(payload, ['name', 'tool', 'tool_name']) ||
      (inner === 'exec_command_begin' ? 'shell'
        : inner === 'patch_apply_begin' ? 'apply_patch' : 'tool');
    let summary = pick(payload, ['command', 'arguments', 'cmd']);
    if (Array.isArray(summary)) summary = summary.join(' ');
    const doing = summary ? name + ': ' + clip(summary) : String(name);
    return Object.assign(base, { model: null, kind: 'activity', doing, ended: false });
  }

  // an assistant message: still working, no tool
  if (inner === 'agent_message' || inner === 'agent_message_delta' || inner === 'agent_reasoning') {
    return Object.assign(base, { model: null, kind: 'activity', doing: 'thinking', ended: false });
  }

  // token_count, turn_context, config, etc. — nothing the scene needs
  return null;
}

/**
 * Fold raw JSONL lines into normalised events, carrying the session_id / cwd
 * from the leading `session_meta` forward onto later lines that don't repeat it.
 * Input order is preserved; skipped lines are dropped. Accepts an array of lines
 * or a single string blob.
 */
function normalize(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines == null ? '' : lines).split('\n');
  const out = [];
  let sid = null;
  let cwd = null;
  for (const line of arr) {
    const ev = parseLine(line);
    if (!ev) continue;
    if (ev.session_id) sid = ev.session_id;
    else ev.session_id = sid;
    if (ev.cwd) cwd = ev.cwd;
    else ev.cwd = cwd;
    out.push(ev);
  }
  return out;
}

module.exports = { parseLine, normalize };
