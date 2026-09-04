// Run view — embedded terminal(s). When agentyard.runView is "terminal" (the
// default) and node-pty loaded in the extension host, the Run view is a real
// xterm.js surface wired to an interactive coding-agent session in the workspace
// folder. With more than one backend enabled (agentyard.agents) there is one
// xterm instance + one pty PER backend and a Claude Code / Codex switcher; each
// keeps its own scrollback, and switching never restarts a session (the
// extension host owns the pty). The extension owns the pty; this file only draws
// output and forwards keystrokes / resize.
//
// When runView is "headless" (or the native component could not load) this
// module stays out of the way and js/run.js drives the old feed instead.
(function (root) {
  const AY = (root.AY = root.AY || {});

  const LABEL = { 'claude-code': 'Claude Code', codex: 'Codex' };

  // Read a pasted / dropped image File and hand its bytes to the extension,
  // which writes a temp file and returns the path to splice in. Never logs the
  // bytes.
  function sendImageFile(adapter, file) {
    if (!file || !adapter.attachImage) return;
    const reader = new root.FileReader();
    reader.onload = () => {
      const buf = reader.result;
      if (!buf) return;
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      adapter.attachImage(root.btoa(bin), file.type || 'image/png');
    };
    reader.readAsArrayBuffer(file);
  }

  function init() {
    const cfg = root.AY_CONFIG || {};
    const adapter = AY.adapter || {};
    const clip = AY.termclip || {};

    const agents = Array.isArray(cfg.agents) && cfg.agents.length ? cfg.agents.slice() : ['claude-code'];

    const termEl = document.getElementById('run-term');
    const noticeEl = document.getElementById('run-notice');
    const footEl = document.getElementById('run-term-foot');
    const newBtn = document.getElementById('run-term-new');
    const attachBtn = document.getElementById('run-term-attach');
    const metaEl = document.getElementById('run-term-meta');
    const switchEl = document.getElementById('run-backend-switch');
    const feedEl = document.getElementById('run-feed');
    const barEl = document.getElementById('run-bar');
    if (!termEl) return;

    function showNotice(text) {
      if (!noticeEl) return;
      noticeEl.textContent = text;
      noticeEl.hidden = !text;
    }

    // A spawn failure: the friendly message + actionable buttons (no dialog).
    function showSpawnFailure(message, backend) {
      if (!noticeEl) return;
      noticeEl.textContent = '';
      noticeEl.hidden = false;
      const p = document.createElement('div');
      p.textContent = message || 'CLI 실행에 실패했어요.';
      p.style.whiteSpace = 'pre-wrap';
      noticeEl.appendChild(p);
      const row = document.createElement('div');
      row.className = 'run-notice-actions';
      const mk = (label, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', fn);
        row.appendChild(b);
      };
      mk('CLI 경로 설정 열기', () => adapter.sendMsg &&
        adapter.sendMsg({ type: 'ui', action: 'openCliPathSetting', backend: backend || agents[0] }));
      mk('진단 실행', () => adapter.sendMsg && adapter.sendMsg({ type: 'ui', action: 'diagnostics' }));
      mk('도움말', () => { if (AY.onboard && AY.onboard.showHelp) AY.onboard.showHelp('terminal'); });
      noticeEl.appendChild(row);
    }

    // Not terminal mode: js/run.js owns the view. Still surface a one-line
    // notice for the two cases the user should know about.
    if (cfg.runView !== 'terminal') {
      if (cfg.runViewRequested === 'terminal' && cfg.ptyAvailable === false) {
        showNotice(
          "Live terminal needs a native component that didn't load on this platform — " +
          'using the non-interactive runner. Run "Agentyard: Open Claude Code Terminal" ' +
          'for a full session.'
        );
      } else if (agents.indexOf('codex') !== -1) {
        showNotice(
          'Codex runs in the interactive terminal Run view — set agentyard.runView to "terminal" ' +
          '(the headless feed is Claude Code only).'
        );
      }
      return;
    }

    // Terminal mode: take over the Run pane.
    if (feedEl) feedEl.hidden = true;
    if (barEl) barEl.hidden = true;
    termEl.hidden = false;
    if (footEl) footEl.hidden = false;

    if (adapter.termSupported === false || typeof root.Terminal === 'undefined') {
      termEl.hidden = true;
      if (footEl) footEl.hidden = true;
      const many = agents.length > 1 ? agents.map((a) => LABEL[a] || a).join(' / ') + ' ' : '';
      showNotice('The embedded ' + many + 'terminal runs inside VS Code — this preview is layout only.');
      return;
    }

    // ---- one xterm + pty per enabled backend --------------------------
    const backends = new Map(); // id -> { term, fit, surface, attached }
    let activeId = agents[0];

    for (const id of agents) {
      const surface = document.createElement('div');
      surface.className = 'run-term-surface';
      surface.dataset.backend = id;
      termEl.appendChild(surface);

      const term = new root.Terminal({
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
        cursorBlink: true,
        scrollback: 5000,
        theme: { background: '#10121a', foreground: '#d8e0f0' },
      });
      const fit = new root.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(surface);

      const entry = { term, fit, surface, attached: false };
      backends.set(id, entry);
      wireBackend(id, entry);
    }

    // ---- backend switcher (only when there is more than one) ----------
    if (switchEl && agents.length > 1) {
      switchEl.hidden = false;
      for (const id of agents) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'run-backend-btn';
        b.textContent = LABEL[id] || id;
        b.dataset.backend = id;
        b.addEventListener('click', () => setActive(id));
        switchEl.appendChild(b);
      }
    }

    function setActive(id) {
      if (!backends.has(id)) return;
      activeId = id;
      for (const [bid, e] of backends) e.surface.style.display = bid === id ? '' : 'none';
      if (switchEl) {
        for (const btn of switchEl.querySelectorAll('button')) {
          btn.classList.toggle('on', btn.dataset.backend === id);
        }
      }
      if (metaEl) {
        metaEl.textContent = 'interactive ' + (LABEL[id] || id) +
          ' — permission prompts are answered here';
      }
      fitActive();
    }

    function fitActive() {
      const e = backends.get(activeId);
      if (!e) return;
      try { e.fit.fit(); } catch (err) { /* container not measurable yet */ }
      // Spawn a backend's session the first time its surface is actually on
      // screen — not on webview load — so no CLI starts for someone who never
      // opens the Run view or never switches to that backend.
      if (!e.attached && e.surface.clientWidth > 0) {
        e.attached = true;
        adapter.termAttach(activeId, e.term.cols, e.term.rows);
      }
      e.term.focus();
    }

    // ---- per-backend wiring: input, resize, clipboard, attachments ----
    function wireBackend(id, entry) {
      const term = entry.term;
      term.onData((d) => adapter.termInput(id, d));
      term.onResize(({ cols, rows }) => adapter.termResize(id, cols, rows));

      // clipboard: xterm.js has none of its own. The pure decision lives in
      // js/termclip.js; here we give it this terminal's selection and route
      // copy/paste through the extension's system clipboard.
      let pendingPaste = false;
      const clipIo = {
        platform: cfg.platform,
        get enabled() { return cfg.terminalCopyPaste !== false; },
        hasSelection: () => term.hasSelection(),
        getSelection: () => term.getSelection(),
        copy: (text) => { if (text) adapter.clipWrite(text); },
        paste: (text) => {
          if (typeof text === 'string') { term.paste(text); return; }
          pendingPaste = true;
          adapter.clipRead();
        },
      };
      if (typeof clip.keyHandler === 'function') {
        term.attachCustomKeyEventHandler((e) => clip.keyHandler(e, clipIo));
      }
      if (adapter.onClip) {
        adapter.onClip((msg) => {
          if (msg && msg.event === 'text' && pendingPaste && id === activeId) {
            pendingPaste = false;
            if (msg.text) term.paste(msg.text);
          }
        });
      }
      if (cfg.copyOnSelection && typeof term.onSelectionChange === 'function') {
        term.onSelectionChange(() => {
          if (clipIo.enabled && term.hasSelection()) adapter.clipWrite(term.getSelection());
        });
      }
      entry.surface.addEventListener('contextmenu', (e) => {
        if (!clipIo.enabled) return;
        e.preventDefault();
        if (term.hasSelection()) adapter.clipWrite(term.getSelection());
        else clipIo.paste();
      });

      // attachments: image paste + drag & drop route to the active backend
      if (adapter.onAttach) {
        adapter.onAttach((msg) => {
          if (msg && msg.event === 'insert' && msg.text && id === activeId) term.paste(msg.text + ' ');
        });
      }
      const textarea = term.textarea;
      if (textarea) {
        textarea.addEventListener('paste', (e) => {
          if (!clipIo.enabled) return;
          const dt = e.clipboardData;
          const img = clip.firstImageFile && clip.firstImageFile(dt);
          if (img) {
            e.preventDefault();
            pendingPaste = false;
            sendImageFile(adapter, img);
            return;
          }
          const text = dt && dt.getData ? dt.getData('text') : '';
          if (text) {
            e.preventDefault();
            pendingPaste = false;
            term.paste(text);
          }
        });
      }
      entry.surface.addEventListener('dragover', (e) => { e.preventDefault(); });
      entry.surface.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if (!dt) return;
        e.preventDefault();
        const files = dt.files;
        if (!files || !files.length) return;
        const paths = [];
        for (let i = 0; i < files.length; i++) {
          if (files[i].path) paths.push(files[i].path);
        }
        if (paths.length) {
          if (adapter.attachPaths) adapter.attachPaths(paths);
          return;
        }
        const img = clip.firstImageFile && clip.firstImageFile(dt);
        if (img) sendImageFile(adapter, img);
      });
    }

    if (attachBtn && adapter.attachPick) {
      attachBtn.addEventListener('click', () => adapter.attachPick());
    }

    if (typeof root.ResizeObserver === 'function') {
      const ro = new root.ResizeObserver(() => fitActive());
      ro.observe(termEl);
    }
    root.addEventListener('resize', fitActive);

    adapter.onTerm((msg) => {
      if (!msg || msg.type !== 'term') return;
      const id = msg.backend || agents[0];
      const e = backends.get(id);
      if (!e) return;
      if (msg.event === 'data') {
        e.term.write(msg.data || '');
      } else if (msg.event === 'exit') {
        const code = msg.code != null ? ' (' + msg.code + ')' : '';
        e.term.write('\r\n\x1b[2m[' + (LABEL[id] || id) + ' exited' + code +
          '] — press New thread or start typing to run it again\x1b[0m\r\n');
      } else if (msg.event === 'unavailable') {
        showNotice(msg.message || '');
      } else if (msg.event === 'spawn-failed') {
        showSpawnFailure(msg.message || '', id);
      }
    });

    if (newBtn) {
      newBtn.addEventListener('click', () => {
        const e = backends.get(activeId);
        if (!e) return;
        e.term.reset();
        adapter.termNew(activeId);
      });
    }

    setActive(activeId);

    // main.js calls this when the Run view becomes visible so the terminal
    // sizes to a container that was display:none a moment ago.
    AY.term.fit = () => { fitActive(); };
  }

  AY.term = { init };
})(window);
