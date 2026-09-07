'use strict';

// Pure adapters for the versioned Codex SQLite store. The host owns all I/O.
function normalizePath(value) {
  let p = typeof value === 'string' ? value.replace(/\\/g, '/') : '';
  p = p.replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  if (/^[a-z]:\//i.test(p) || p.startsWith('//')) p = p.toLowerCase();
  return p.replace(/\/+$/, '');
}

function pickDatabase(files, prefix) {
  const pattern = new RegExp('^' + prefix + '_(\\d+)\\.sqlite$');
  return (Array.isArray(files) ? files : []).filter((f) => f && pattern.test(f.name))
    .sort((a, b) => Number(b.name.match(pattern)[1]) - Number(a.name.match(pattern)[1]) ||
      (Number(b.mtime) || 0) - (Number(a.mtime) || 0))[0] || null;
}

function millis(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeThreads(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.id === 'string' &&
    r.id && Number(r.archived) !== 1).map((r) => ({
    session_id: r.id, cwd: typeof r.cwd === 'string' ? r.cwd : '',
    model: typeof r.model === 'string' ? r.model : null,
    title: typeof r.title === 'string' ? r.title : '',
    first_user_message: typeof r.first_user_message === 'string' ? r.first_user_message : '',
    updated_ms: millis(r.updated_at_ms) || millis(r.updated_at) * 1000,
    created_ms: millis(r.created_at_ms) || millis(r.created_at) * 1000,
    ended: r.status === 'completed' || r.ended === true,
  }));
}

function normalizeItems(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    try {
      if (!row || typeof row.thread_id !== 'string' || !row.thread_id) continue;
      const p = typeof row.item_json === 'string' ? JSON.parse(row.item_json) : row.item_json;
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      const type = row.item_type || p.type;
      const ms = millis(row.created_at_ms);
      const ev = { ts: ms ? new Date(ms).toISOString() : null, source: 'codex',
        session_id: row.thread_id, cwd: typeof row.cwd === 'string' ? row.cwd : null,
        model: null, kind: 'activity', doing: 'thinking', ended: false };
      if (type === 'userMessage' || type === 'agentMessage') {
        ev.role = type === 'userMessage' ? 'user' : 'assistant';
        ev.text = typeof p.text === 'string' ? p.text : Array.isArray(p.content)
          ? p.content.filter((c) => c && typeof c.text === 'string').map((c) => c.text).join('\n') : '';
        if (ev.role === 'user') { ev.kind = 'meta'; ev.doing = null; }
      } else if (type === 'commandExecution') {
        ev.command = Array.isArray(p.command) ? p.command.join(' ') : typeof p.command === 'string' ? p.command : '';
        ev.doing = 'shell: ' + ev.command.replace(/\s+/g, ' ').trim().slice(0, 80);
      } else if (['fileChange', 'patchApply', 'apply_patch', 'patch_apply_begin'].includes(type)) {
        ev.files = [];
        const changes = p.changes;
        if (Array.isArray(changes)) {
          for (const c of changes) {
            if (!c || typeof c.path !== 'string') continue;
            const kind = typeof c.kind === 'string' ? c.kind : c.kind && c.kind.type;
            ev.files.push({ path: c.path, mode: kind === 'add' ? 'created' : kind === 'delete' ? 'deleted' : 'modified' });
          }
        } else if (changes && typeof changes === 'object') {
          for (const fp of Object.keys(changes)) {
            const c = changes[fp] || {};
            ev.files.push({ path: fp, mode: c.add ? 'created' : c.delete || c.remove ? 'deleted' : 'modified' });
          }
        }
        ev.doing = 'apply_patch';
      } else if (type !== 'reasoning') continue;
      out.push(ev);
    } catch (e) { /* corrupt row or unknown shape: keep the rest */ }
  }
  return out;
}

module.exports = { normalizePath, pickDatabase, normalizeThreads, normalizeItems };
