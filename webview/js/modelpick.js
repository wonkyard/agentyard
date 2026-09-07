// Run-view model control (v1.3). A small `model: <label> ▾` button in the Run
// header that reflects the active backend's model setting and, on click, asks
// the extension to show the picker. The extension computes label/value/options
// (shared/modelPick.js) into the poll snapshot's `model` field; this module just
// renders the label and posts a `modelPick` intent — no model list lives here,
// same discipline as the guideline chip.
(function (root) {
  const AY = (root.AY = root.AY || {});

  const BACKEND_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex' };

  // registered controls: { el, getBackend }
  const controls = [];
  let snap = null; // { 'claude-code': {label,value,options}, codex: {…} }

  function renderOne(c) {
    if (!c.el) return;
    const id = c.getBackend();
    const s = snap && snap[id];
    if (!s) { c.el.hidden = true; return; }
    c.el.hidden = false;
    c.el.textContent = 'model: ' + (s.label || 'default') + ' ▾';
    c.el.title = (BACKEND_LABEL[id] || id) + ' model — applies to the next run';
    c.el.dataset.default = s.value ? 'no' : 'yes';
  }

  // run.js / term.js call this once with the element that lives in their header
  // and a function returning the currently-active backend id.
  function attach(el, getBackend) {
    if (!el || typeof getBackend !== 'function') return;
    const adapter = AY.adapter || {};
    const c = { el, getBackend };
    controls.push(c);
    el.addEventListener('click', () => {
      if (adapter.sendMsg) adapter.sendMsg({ type: 'ui', action: 'modelPick', backend: getBackend() });
    });
    renderOne(c);
  }

  // main.js calls this on every poll with snapshot.model.
  function onData(modelSnap) {
    if (modelSnap && typeof modelSnap === 'object') snap = modelSnap;
    controls.forEach(renderOne);
  }

  // let a control re-render after its backend switches without waiting for a poll
  function refresh() {
    controls.forEach(renderOne);
  }

  AY.modelpick = { attach, onData, refresh };
})(window);
