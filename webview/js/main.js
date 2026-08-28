// Bootstrap: poll data on an interval, run the render loop, handle clicks and
// the info panel. Sized to work in a narrow/short VS Code panel view.
(function (root) {
  const AY = root.AY;
  const cfg = root.AY_CONFIG || {};
  const POLL_MS = Math.max(1000, (cfg.pollSeconds || 3) * 1000);

  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');
  const panel = document.getElementById('panel');
  const statusEl = document.getElementById('status');

  const view = { selectedId: null };
  let office = null;
  let hits = [];
  let lastError = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[c]));
  }

  function wrapText(c, text, x, y, maxW, lh) {
    const words = String(text).split(/\s+/);
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (c.measureText(test).width > maxW && line) {
        c.fillText(line, x, y);
        y += lh;
        line = w;
      } else {
        line = test;
      }
    }
    if (line) c.fillText(line, x, y);
  }

  function relTime(ts) {
    if (!ts) return 'no status yet';
    const then = Date.parse(String(ts).replace(' ', 'T') + 'Z');
    if (isNaN(then)) return String(ts);
    let s = Math.floor((Date.now() - then) / 1000);
    if (s < 0) s = 0;
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function showPanel(agent) {
    const projectLine = agent.projectId
      ? `<div class="row"><span>project</span><b>${esc(agent.projectId)}</b></div>` : '';
    const annexLine = agent.annex
      ? `<div class="row"><span>annex</span><b>${esc(agent.annex)}</b></div>` : '';
    panel.innerHTML = `
      <button id="panel-close">×</button>
      <h2>${esc(agent.name)}</h2>
      <div class="row"><span>model</span><b>${esc(agent.model)}</b></div>
      <div class="row"><span>status</span><b class="st-${esc(agent.status)}">${esc(agent.status)}</b></div>
      ${annexLine}${projectLine}
      <div class="row"><span>updated</span><b>${esc(relTime(agent.ts))}</b></div>
      <div class="note">${esc(agent.note || '(no note logged)')}</div>
      <div class="desc">${esc(agent.description || '')}</div>`;
    panel.classList.add('open');
    const c = document.getElementById('panel-close');
    if (c) c.onclick = () => { view.selectedId = null; panel.classList.remove('open'); };
  }

  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    const x = (ev.clientX - rect.left) * sx;
    const y = (ev.clientY - rect.top) * sy;
    let found = null;
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { found = h; break; }
    }
    if (found) {
      view.selectedId = found.id;
      showPanel(found.data);
    } else {
      view.selectedId = null;
      panel.classList.remove('open');
    }
  });

  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.className = isErr ? 'err' : '';
  }

  async function poll() {
    try {
      const raw = await AY.adapter.getRaw();
      const dbResult = await AY.db.read(raw.dbBytes, AY.adapter.wasmUrl);
      office = AY.model.build(raw, dbResult);
      lastError = null;
      const dataTag = office.dataMode === 'demo' ? 'SYNTHETIC demo data' : 'workspace data';
      setStatus(
        `${AY.adapter.mode} · ${dataTag} · ${office.departments.length} departments · ` +
        `${office.annexes.length} annexes · updated ${new Date().toLocaleTimeString()}`
      );
      if (view.selectedId) {
        const all = office.departments
          .map((d) => ['dept:' + d.name, d])
          .concat(...office.annexes.map((a) => a.team.map((m) => [
            'team:' + a.projectId + ':' + m.name, { ...m, annex: a.slug, projectId: a.projectId },
          ])));
        const hit = all.find(([id]) => id === view.selectedId);
        if (hit) showPanel(hit[1]);
      }
    } catch (err) {
      lastError = err;
      setStatus('data error: ' + err.message, true);
      // eslint-disable-next-line no-console
      console.error('[agentyard] poll failed', err);
    }
  }

  function frame() {
    const t = performance.now();
    if (office) {
      const out = AY.render.render(ctx, office, t, view);
      if (canvas.width !== out.width || canvas.height !== out.height) {
        canvas.width = out.width;
        canvas.height = out.height;
        AY.render.render(ctx, office, t, view);
      }
      hits = out.hits;
    } else {
      ctx.fillStyle = '#12141c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = '13px "Courier New", monospace';
      if (lastError) {
        ctx.fillStyle = '#ff6b6b';
        ctx.fillText('Agentyard error:', 20, 28);
        ctx.fillStyle = '#e0a0a0';
        const msg = String(lastError && lastError.message || lastError);
        wrapText(ctx, msg, 20, 50, canvas.width - 40, 18);
      } else {
        ctx.fillStyle = '#9aa0b4';
        ctx.fillText('loading Agentyard…', 20, 24);
      }
    }
    requestAnimationFrame(frame);
  }

  canvas.width = AY.render.WIDTH;
  canvas.height = 600;
  setStatus('connecting…');
  poll();
  setInterval(poll, POLL_MS);
  requestAnimationFrame(frame);
})(window);
