// Merges raw inputs (agent .md frontmatter + company.db rows + live hook events)
// into the single "office" object the renderer draws.
(function (root) {
  // company.db writes `datetime('now')` -> "YYYY-MM-DD HH:MM:SS" in UTC.
  // Returns NaN for null / any unexpected shape; callers treat NaN as "cannot
  // date this row" and leave it untouched.
  function parseDbTs(ts) {
    if (ts == null) return NaN;
    return Date.parse(String(ts).replace(' ', 'T') + 'Z');
  }

  // Newest matching status_log row per department / annex role. `opts` (optional):
  //   { nowMs, staleWorkingMs } — when the newest row is `working` but its `ts`
  //   is older than nowMs - staleWorkingMs, render it as `idle` instead (the
  //   session likely ended without logging that it finished). Same convention as
  //   live.js `staleMs`: a value <= 0 disables the horizon. `note` and `ts` are
  //   kept as-is so the info panel still shows what it was last doing.
  function latestStatus(statuses, predicate, opts) {
    let best = null;
    for (const s of statuses) {
      if (!predicate(s)) continue;
      if (!best || String(s.ts) > String(best.ts)) best = s;
    }
    if (!best) return { status: 'idle', note: null, ts: null, projectId: null };
    let status = best.status || 'idle';
    const o = opts || {};
    if (status === 'working' && o.staleWorkingMs > 0) {
      const t = parseDbTs(best.ts);
      if (!isNaN(t) && t < (o.nowMs || Date.now()) - o.staleWorkingMs) status = 'idle';
    }
    return { status, note: best.note, ts: best.ts, projectId: best.project_id };
  }

  function slugFromRepo(url) {
    if (!url) return null;
    return String(url).replace(/\/+$/, '').split('/').pop();
  }

  // ---- §7: attribute an in-repo build runner to its project's annex -----
  // The Chief of Staff dispatches a build into a split repo; an in-process
  // runner acts as that repo's project-lead -> project-eng -> release-check
  // inside `projects.local_path`. When we can see that (a live subagent whose
  // cwd resolves inside a project's local_path, or the repo-build runner type),
  // that project's annex team is the one working right now — not idle.
  const REPO_RUNNER_TYPES = new Set(['repo-team-runner', 'repo-build-runner']);

  function normPath(s) {
    return String(s || '').replace(/\\/g, '/').replace(/\/+$/, '');
  }

  // Is `child` the same as, or nested inside, `parent`? Slash-normalised, and
  // case-insensitive when either side looks like a Windows path or we're told
  // we're on win32.
  function pathInside(child, parent, platform) {
    let c = normPath(child);
    let p = normPath(parent);
    if (!c || !p) return false;
    const winish = platform === 'win32' || /^[a-zA-Z]:/.test(c) || /^[a-zA-Z]:/.test(p);
    if (winish) { c = c.toLowerCase(); p = p.toLowerCase(); }
    return c === p || c.indexOf(p + '/') === 0;
  }

  // Does an annex team role match a phase marker token? Exact first, then
  // tolerate project-lead / squad-lead / lead and similar naming.
  function roleMatchesPhase(roleName, phase) {
    if (!roleName || !phase) return false;
    const r = String(roleName).toLowerCase();
    const p = String(phase).toLowerCase();
    if (r === p) return true;
    const tail = p.replace(/^(project|repo)-/, '');
    return r === tail || r.endsWith('-' + tail) || r.indexOf(tail) !== -1;
  }

  // Map each project that has a local_path to the freshest live runner agent
  // building it. Empty when there is no company.db / no local_path / no match —
  // callers then keep today's behaviour (loose runner sprite).
  function attributeRunners(liveAgents, projects, platform) {
    const withPath = projects.filter((p) => p.repo_url && p.local_path);
    const hits = new Map();
    if (!withPath.length) return hits;
    for (const a of liveAgents) {
      if (a.kind !== 'subagent' || a.leaving) continue;
      const proj =
        withPath.find((p) => pathInside(a.cwd, p.local_path, platform)) ||
        (REPO_RUNNER_TYPES.has(a.type) && withPath.length === 1 ? withPath[0] : null);
      if (!proj) continue;
      const cur = hits.get(proj.project_id);
      if (!cur || String(a.ts || '') > String(cur.agent.ts || '')) {
        hits.set(proj.project_id, { agent: a, phase: a.phase || null });
      }
    }
    return hits;
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
    // company.db-layer horizon: a `working` status_log row older than this reads
    // as idle (a session that ended without logging idle). Default 3h;
    // `staleWorkingMs` (tests) wins; <= 0 disables. Demo mode ships a fixed
    // fixture with frozen timestamps, so the horizon is off there — otherwise
    // every demo desk would read idle the moment the fixture aged past 3h.
    const staleWorkingMs = raw.dataMode === 'demo'
      ? 0
      : (raw.staleWorkingMs != null
        ? raw.staleWorkingMs
        : (raw.staleWorkingHours != null ? raw.staleWorkingHours * 3600000 : 3 * 3600000));

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
      const st = latestStatus(statuses, (s) => s.department === d.name, { nowMs, staleWorkingMs });
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
            (s) => s.project_id === p.project_id && s.department === r.name,
            { nowMs, staleWorkingMs }
          );
          return { ...r, ...st };
        }),
      }));

    // §7: light the annex whose repo a build runner is live inside.
    const runnerHits = attributeRunners(live.agents, projects, raw.platform);
    const attributedKeys = new Set();
    for (const anx of annexes) {
      const hit = runnerHits.get(anx.projectId);
      if (!hit) continue;
      attributedKeys.add(hit.agent.key);
      anx.building = true;
      anx.buildRunner = hit.agent.type;
      anx.buildDoing = hit.agent.doing || null;
      anx.buildPhase = hit.phase || null;
      const phaseRole = hit.phase
        ? anx.team.find((m) => roleMatchesPhase(m.name, hit.phase))
        : null;
      for (const m of anx.team) {
        if (phaseRole && m !== phaseRole) continue; // role hint -> just that seat
        m.status = 'working';
        m.note = hit.agent.doing || m.note;
        m.doing = hit.agent.doing || m.doing || null;
        m.ts = hit.agent.ts || m.ts;
        m.building = true;
      }
    }

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
      if (attributedKeys.has(a.key)) continue; // shown as its project's annex (§7)
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
