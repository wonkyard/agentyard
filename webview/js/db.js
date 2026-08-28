// sql.js wrapper. Loads the vendored WASM build (never a CDN) and runs a couple
// of read-only queries against the company.db bytes it is handed each poll.
(function (root) {
  let sqlPromise = null;

  function init(wasmUrl) {
    if (!sqlPromise) {
      if (typeof root.initSqlJs !== 'function') {
        return Promise.reject(new Error('vendor/sql-wasm.js did not load'));
      }
      sqlPromise = root.initSqlJs({ locateFile: () => wasmUrl });
    }
    return sqlPromise;
  }

  function rows(db, sql) {
    const res = db.exec(sql);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map((v) => {
      const o = {};
      columns.forEach((c, i) => (o[c] = v[i]));
      return o;
    });
  }

  async function read(bytes, wasmUrl) {
    const SQL = await init(wasmUrl);
    const db = new SQL.Database(bytes);
    try {
      const projects = rows(
        db,
        `SELECT project_id, idea_summary, current_stage, updated_at, repo_url
           FROM projects ORDER BY created_at`
      );
      const statuses = rows(
        db,
        `SELECT s.project_id, s.department, s.status, s.note, s.ts
           FROM status_log s
           JOIN (SELECT project_id, department, MAX(id) AS mid
                   FROM status_log GROUP BY project_id, department) m
             ON s.id = m.mid`
      );
      return { projects, statuses };
    } finally {
      db.close();
    }
  }

  root.AY = root.AY || {};
  root.AY.db = { init, read };
})(window);
