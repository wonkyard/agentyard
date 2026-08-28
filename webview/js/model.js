// Merges raw inputs (agent .md frontmatter + company.db rows + live hook events)
// into the single "office" object the renderer draws.
(function (root) {
  function latestStatus(statuses, predicate) {
    let best = null;
    for (const s of statuses) {
      if (!predicate(s)) continue;
      if (!best || String(s.ts) > String(best.ts)) best = s;
    }
    if (!best) return { status: 'idle', note: null, ts: null, projectId: null };
    return { status: best.status || 'idle', note: best.note, ts: best.ts, projectId: best.project_id };
  }

  function slugFromRepo(url) {
    if (!url) return null;
    return String(url).replace(/\/+$/, '').split('/').pop();
  }

  function build(raw, dbResult) {
    const statuses = (dbResult && dbResult.statuses) || [];
    const projects = (dbResult && dbResult.projects) || [];

    const nowMs = raw.nowMs || Date.now();
    const idleSeconds = raw.idleSeconds || 30;
    const maxPerRoom = raw.maxSpritesPerRoom || 8;
    const hooksInstalled = !!raw.hooksInstalled;
    const staleMs = raw.staleMs != null
      ? raw.staleMs
      : (raw.staleMinutes != null ? raw.staleMinutes * 60000 : undefined);

    // ---- live activity ------------------------------------------------
    const live = root.AY && root.AY.live
      ? root.AY.live.resolve(raw.liveEvents || [], { nowMs, idleSeconds, staleMs })
      : { agents: [], sessions: [], agentTypes: [], lastActivityMs: 0, counts: {}, hasEvents: false };

    // fastest-changing live agent per subagent type, for department overlay
    const liveByType = new Map();
    for (const a of live.agents) {
      if (a.kind !== 'subagent') continue;
      const cur = liveByType.get(a.type);
      if (!cur || String(a.ts || '') > String(cur.ts || '')) liveByType.set(a.type, a);
    }

    // ---- HQ departments (files) + optional live overlay --------------
    const deptNames = new Set((raw.departments || []).map((d) => d.name));
    const departments = (raw.departments || []).map((d) => {
      const st = latestStatus(statuses, (s) => s.department === d.name);
      const lv = liveByType.get(d.name);
      if (lv && !lv.leaving) {
        return { ...d, status: lv.status, note: lv.doing, ts: lv.ts, projectId: null, live: true };
      }
      return { ...d, ...st };
    });

    const teamRoles = raw.teamRoles || [];
    const annexes = projects
      .filter((p) => p.repo_url)
      .map((p) => ({
        projectId: p.project_id,
        slug: slugFromRepo(p.repo_url),
        stage: p.current_stage,
        summary: p.idea_summary,
        team: teamRoles.map((r) => {
          const st = latestStatus(
            statuses,
            (s) => s.project_id === p.project_id && s.department === r.name
          );
          return { ...r, ...st };
        }),
      }));

    const board = projects.map((p) => ({
      projectId: p.project_id,
      stage: p.current_stage,
      summary: p.idea_summary,
      updatedAt: p.updated_at,
      hasRepo: !!p.repo_url,
    }));

    // ---- live rooms: main sessions + subagent types with no file -----
    const liveRooms = [];
    for (const sess of live.sessions) {
      const mains = sess.agents.filter((a) => a.kind === 'main');
      for (const m of mains) {
        liveRooms.push({
          id: 'live:' + m.key,
          kind: 'live-main',
          title: sess.title,
          subtitle: 'main session',
          model: 'live',
          occupants: [liveOccupant(m)],
          overflow: 0,
        });
      }
    }
    const byType = new Map();
    for (const a of live.agents) {
      if (a.kind !== 'subagent') continue;
      if (deptNames.has(a.type)) continue; // shown in its department room
      if (!byType.has(a.type)) byType.set(a.type, []);
      byType.get(a.type).push(a);
    }
    for (const [type, arr] of byType) {
      arr.sort((x, y) => String(y.ts || '').localeCompare(String(x.ts || '')));
      const shown = arr.slice(0, maxPerRoom);
      liveRooms.push({
        id: 'live:type:' + type,
        kind: 'live-sub',
        title: type,
        subtitle: arr.length > 1 ? arr.length + ' running' : 'subagent',
        model: 'live',
        occupants: shown.map(liveOccupant),
        overflow: Math.max(0, arr.length - shown.length),
      });
    }

    // ---- counts (departments + annex teams + live rooms) ------------
    const counts = { working: 0, idle: 0, blocked: 0 };
    const tally = (s) => { counts[s] = (counts[s] || 0) + 1; };
    departments.forEach((a) => tally(a.status));
    annexes.forEach((a) => a.team.forEach((m) => tally(m.status)));
    liveRooms.forEach((r) => {
      r.occupants.forEach((o) => tally(o.status));
    });

    const liveMode = root.AY && root.AY.live
      ? root.AY.live.dataMode(live, hooksInstalled, nowMs)
      : (hooksInstalled ? 'watching' : 'off');

    return {
      dataMode: raw.dataMode || 'workspace',
      liveMode, // 'live' | 'watching' | 'off'
      hooksInstalled,
      departments,
      annexes,
      board,
      liveRooms,
      liveAgentCount: live.agents.length,
      liveSessionCount: live.sessions.length,
      counts,
    };
  }

  function liveOccupant(a) {
    return {
      name: a.name,
      model: a.kind === 'main' ? 'main' : a.type,
      status: a.status,
      note: a.doing,
      doing: a.doing,
      ts: a.ts,
      description: a.cwd ? 'cwd: ' + a.cwd : '',
      kind: a.kind,
      type: a.type,
      sessionId: a.sessionId,
      leaving: a.leaving,
    };
  }

  root.AY = root.AY || {};
  root.AY.model = { build };
})(window);
