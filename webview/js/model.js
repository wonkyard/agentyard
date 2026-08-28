// Merges raw inputs (agent .md frontmatter + company.db rows) into the single
// "office" object the renderer draws.
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

    const departments = (raw.departments || []).map((d) => {
      const st = latestStatus(statuses, (s) => s.department === d.name);
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

    const everyone = departments.concat(...annexes.map((a) => a.team));
    const counts = { working: 0, idle: 0, blocked: 0 };
    for (const a of everyone) counts[a.status] = (counts[a.status] || 0) + 1;

    return { dataMode: raw.dataMode || 'workspace', departments, annexes, board, counts };
  }

  root.AY = root.AY || {};
  root.AY.model = { build };
})(window);
