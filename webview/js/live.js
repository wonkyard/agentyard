// Live-activity state machine. Pure: takes the flat list of hook-event records
// (as written by hooks/agentyard-hook.mjs) plus a clock, returns the set of
// agents currently visible and what each is doing.
//
// Runs in three places off the same source: the webview (window.AY.live), the
// extension (require), and the sanity test (require).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.AY = root.AY || {};
    root.AY.live = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  const DEFAULT_IDLE_SECONDS = 30;
  const LINGER_MS = 8000; // keep a finished agent on screen briefly so you see it end
  const LIVE_WINDOW_MS = 60000; // events newer than this => data mode "LIVE"
  const DEFAULT_STALE_MS = 15 * 60 * 1000; // absolute horizon for an agent with no terminal event

  const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
  const CC_BUILTINS = ['Explore', 'Plan', 'general-purpose', 'Task'];

  // Optional phase marker a repo build runner may echo at each role handoff:
  //   [agentyard] project-lead -> project-eng   (or "→", or just "[agentyard] project-eng")
  // The office lights the last role-like token named after the tag.
  function phaseFromText(s) {
    if (!s) return null;
    const str = String(s);
    const at = str.indexOf('[agentyard]');
    if (at === -1) return null;
    const tokens = str.slice(at + '[agentyard]'.length).match(/[a-z][a-z-]*[a-z]/gi);
    if (!tokens || !tokens.length) return null;
    return tokens[tokens.length - 1].toLowerCase();
  }

  function ms(ts) {
    if (typeof ts === 'number') return ts;
    const s = String(ts || '');
    const p = Date.parse(s.indexOf('T') === -1 ? s.replace(' ', 'T') + 'Z' : s);
    return isNaN(p) ? 0 : p;
  }

  function agentKey(ev) {
    if (ev.agent_id) return 'sub:' + ev.agent_id;
    return 'main:' + (ev.session_id || 'unknown');
  }

  function titleFromCwd(cwd) {
    if (!cwd) return 'main session';
    const parts = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || 'main session';
  }

  function doingLine(a) {
    if (a.pendingPermission) {
      return a.permissionTool ? 'waiting for permission · ' + a.permissionTool : 'waiting for permission';
    }
    if (!a.lastTool) return a.lastPrompt ? 'working on your request' : 'ready';
    const t = a.lastTool.name || 'tool';
    const s = a.lastTool.summary;
    let line = s ? t + ': ' + s : t;
    if (a.lastToolFailed) line += ' (failed)';
    return line;
  }

  /**
   * @param {Array} events  hook-event records
   * @param {{nowMs?:number, idleSeconds?:number, staleMs?:number}} [opts]
   * @returns {{agents:Array, sessions:Array, agentTypes:Array, lastActivityMs:number,
   *            counts:{working:number,idle:number,blocked:number}}}
   */
  function resolve(events, opts) {
    opts = opts || {};
    const now = opts.nowMs || Date.now();
    const idleMs = (opts.idleSeconds || DEFAULT_IDLE_SECONDS) * 1000;
    // 0 / negative disables the horizon; undefined => the default.
    const staleMs = opts.staleMs == null ? DEFAULT_STALE_MS : opts.staleMs;

    const list = (Array.isArray(events) ? events.slice() : [])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({ e, m: ms(e.ts) }))
      .sort((a, b) => a.m - b.m);

    const agents = new Map();
    const sessions = new Map();
    let lastActivityMs = 0;

    function ensureSession(id, cwd) {
      if (!id) return null;
      let s = sessions.get(id);
      if (!s) {
        s = { sessionId: id, cwd: cwd || null, ended: false, endedTs: 0 };
        sessions.set(id, s);
      }
      if (cwd && !s.cwd) s.cwd = cwd;
      return s;
    }

    function ensureAgent(ev) {
      const key = agentKey(ev);
      let a = agents.get(key);
      if (!a) {
        const isSub = !!ev.agent_id;
        a = {
          key,
          kind: isSub ? 'subagent' : 'main',
          type: isSub ? ev.agent_type || 'subagent' : 'main',
          sessionId: ev.session_id || 'unknown',
          cwd: ev.cwd || null,
          firstTs: 0,
          lastTs: 0,
          lastToolTs: 0,
          lastTool: null,
          lastToolFailed: false,
          lastPrompt: 0,
          pendingPermission: false,
          permissionTs: 0,
          permissionTool: null,
          phase: null, // latest "[agentyard] <role>" marker, if the runner echoes one
          ended: false,
          endedTs: 0,
        };
        agents.set(key, a);
      }
      if (ev.cwd && !a.cwd) a.cwd = ev.cwd;
      if (ev.agent_type && a.kind === 'subagent') a.type = ev.agent_type;
      return a;
    }

    for (const { e, m } of list) {
      const name = e.hook_event_name || 'Unknown';
      const s = ensureSession(e.session_id, e.cwd);
      if (m) lastActivityMs = Math.max(lastActivityMs, m);

      if (name === 'SessionStart') {
        if (s) {
          s.ended = false;
          s.endedTs = 0;
        }
        const a = ensureAgent(e);
        a.firstTs = a.firstTs || m;
        a.lastTs = m;
        a.ended = false;
        a.endedTs = 0;
        continue;
      }

      if (name === 'SessionEnd' || name === 'Stop') {
        if (s) {
          // Stop can fire per-turn; only SessionEnd truly ends. Treat Stop as a
          // soft end for the main agent so it lingers then clears if quiet.
          if (name === 'SessionEnd') {
            s.ended = true;
            s.endedTs = m;
          }
        }
        for (const a of agents.values()) {
          if (a.sessionId !== e.session_id) continue;
          if (name === 'SessionEnd' || a.kind === 'main') {
            a.ended = true;
            a.endedTs = m;
            a.pendingPermission = false;
          }
        }
        continue;
      }

      if (name === 'SubagentStart') {
        const a = ensureAgent(e);
        a.firstTs = a.firstTs || m;
        a.lastTs = m;
        a.ended = false;
        a.endedTs = 0;
        continue;
      }

      if (name === 'SubagentStop') {
        const a = ensureAgent(e);
        a.ended = true;
        a.endedTs = m;
        a.pendingPermission = false;
        continue;
      }

      const a = ensureAgent(e);
      a.firstTs = a.firstTs || m;
      a.lastTs = Math.max(a.lastTs, m);
      // any fresh event revives a soft-ended (Stop) main agent
      if (a.ended && a.kind === 'main') {
        a.ended = false;
        a.endedTs = 0;
      }

      if (name === 'UserPromptSubmit') {
        a.lastPrompt = m;
      } else if (name === 'PermissionRequest') {
        a.pendingPermission = true;
        a.permissionTs = m;
        a.permissionTool = e.tool_name || e.permission || null;
      } else if (TOOL_EVENTS.has(name)) {
        a.lastToolTs = Math.max(a.lastToolTs, m);
        a.lastTool = {
          name: e.tool_name || 'tool',
          summary: e.tool_input_summary || null,
        };
        a.lastToolFailed = name === 'PostToolUseFailure';
        const ph = phaseFromText(e.tool_input_summary);
        if (ph) a.phase = ph;
        if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
          a.pendingPermission = false;
        }
      } else if (name === 'Notification') {
        // notifications often mean "waiting for the user" -> treat as a soft block
        if (/permission|approve|waiting/i.test(String(e.stop_reason || ''))) {
          a.pendingPermission = true;
          a.permissionTs = m;
        }
      }
    }

    // ---- classify ----
    const outAgents = [];
    const counts = { working: 0, idle: 0, blocked: 0 };
    for (const a of agents.values()) {
      const sess = sessions.get(a.sessionId);
      const endedTs = a.ended ? a.endedTs : sess && sess.ended ? sess.endedTs : 0;
      if (endedTs && now - endedTs > LINGER_MS) continue; // gone

      // Absolute staleness horizon. An agent that never received a terminal
      // event (SessionEnd / Stop / SubagentStop) and whose newest activity is
      // older than staleMs is a zombie — its VS Code was force-closed or
      // crashed mid-run, so no terminal event was ever written and the
      // linger path below can never clear it. Drop it entirely: not rendered,
      // not counted. A live session merely paused between turns keeps emitting
      // Stop and is handled by the linger path, so this only removes the dead.
      const newestMs = Math.max(a.lastTs, a.lastToolTs, a.permissionTs, a.lastPrompt);
      if (!endedTs && staleMs > 0 && newestMs && now - newestMs > staleMs) continue;

      let status;
      if (endedTs) {
        status = 'idle';
      } else if (a.pendingPermission) {
        status = 'blocked';
      } else if (a.lastToolFailed && a.lastToolTs && a.lastToolTs >= a.lastTs - 1) {
        status = 'blocked';
      } else if (a.lastToolTs && now - a.lastToolTs <= idleMs) {
        status = 'working';
      } else if (a.lastPrompt && now - a.lastPrompt <= idleMs) {
        status = 'working';
      } else {
        status = 'idle';
      }
      counts[status] = (counts[status] || 0) + 1;

      const lastTs = Math.max(a.lastTs, a.lastToolTs, a.permissionTs, a.lastPrompt);
      outAgents.push({
        key: a.key,
        kind: a.kind,
        type: a.type,
        name: a.kind === 'main' ? titleFromCwd(a.cwd) : a.type,
        sessionId: a.sessionId,
        cwd: a.cwd,
        status,
        doing: doingLine(a),
        note: doingLine(a),
        tool: a.lastTool ? a.lastTool.name : null,
        phase: a.phase || null,
        ts: lastTs ? new Date(lastTs).toISOString() : null,
        leaving: !!endedTs,
      });
    }

    const typeSet = new Set();
    for (const a of outAgents) if (a.kind === 'subagent') typeSet.add(a.type);

    const outSessions = [];
    for (const s of sessions.values()) {
      const mine = outAgents.filter((a) => a.sessionId === s.sessionId);
      if (!mine.length) continue;
      outSessions.push({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: titleFromCwd(s.cwd),
        agents: mine,
      });
    }

    return {
      agents: outAgents,
      sessions: outSessions,
      agentTypes: Array.from(typeSet),
      lastActivityMs,
      counts,
      hasEvents: list.length > 0,
    };
  }

  // Data-mode badge for the header.
  function dataMode(resolved, hooksInstalled, nowMs) {
    if (!hooksInstalled) return 'off';
    const now = nowMs || Date.now();
    if (resolved && resolved.lastActivityMs && now - resolved.lastActivityMs <= LIVE_WINDOW_MS) {
      return 'live';
    }
    return 'watching';
  }

  return {
    resolve, dataMode, CC_BUILTINS,
    DEFAULT_IDLE_SECONDS, LINGER_MS, LIVE_WINDOW_MS, DEFAULT_STALE_MS,
  };
});
