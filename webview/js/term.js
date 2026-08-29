// Run view — embedded terminal. When agentyard.runView is "terminal" (the
// default) and node-pty loaded in the extension host, the Run view is a real
// xterm.js surface wired to an interactive `claude` session in the workspace
// folder. The extension owns the pty; this file only draws its output and
// forwards keystrokes / resize. Everything Claude Code renders — markdown,
// colour, spinners, permission prompts — is the CLI's own TUI, so there is no
// feed formatting here.
//
// When runView is "headless" (or the native component could not load) this
// module stays out of the way and js/run.js drives the old feed instead.
(function (root) {
  const AY = (root.AY = root.AY || {});

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

    const termEl = document.getElementById('run-term');
    const noticeEl = document.getElementById('run-notice');
    const footEl = document.getElementById('run-term-foot');
    const newBtn = document.getElementById('run-term-new');
    const attachBtn = document.getElementById('run-term-attach');
    const metaEl = document.getElementById('run-term-meta');
    const feedEl = document.getElementById('run-feed');
    const barEl = document.getElementById('run-bar');
    if (!termEl) return;

    function showNotice(text) {
      if (!noticeEl) return;
      noticeEl.textContent = text;
      noticeEl.hidden = !text;
    }

    // Not terminal mode: js/run.js owns the view. Still surface a one-line
    // notice if the user asked for a terminal but the native component is
    // missing on this platform (the extension already fell back to headless).
    if (cfg.runView !== 'terminal') {
      if (cfg.runViewRequested === 'terminal' && cfg.ptyAvailable === false) {
        showNotice(
          "Live terminal needs a native component that didn't load on this platform — " +
          'using the non-interactive runner. Run "Agentyard: Open Claude Code Terminal" ' +
          'for a full session.'
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
      showNotice('The embedded terminal runs inside VS Code — this preview is layout only.');
      return;
    }

    const term = new root.Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#10121a', foreground: '#d8e0f0' },
    });
    const fit = new root.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(termEl);

    let attached = false;
    function doFit() {
      try { fit.fit(); } catch (e) { /* container not measurable yet */ }
      // Spawn the session the first time the terminal is actually on screen —
      // not on webview load — so `claude` doesn't start for someone who never
      // opens the Run view.
      if (!attached && termEl.clientWidth > 0) {
        attached = true;
        adapter.termAttach(term.cols, term.rows);
      }
    }

    term.onData((d) => adapter.termInput(d));
    term.onResize(({ cols, rows }) => adapter.termResize(cols, rows));

    // ---- clipboard: xterm.js has none of its own ----------------------
    // The pure decision lives in js/termclip.js; here we give it the terminal's
    // selection and route copy/paste through the extension's system clipboard.
    let pendingPaste = false;
    const clipIo = {
      platform: cfg.platform,
      get enabled() { return cfg.terminalCopyPaste !== false; },
      hasSelection: () => term.hasSelection(),
      getSelection: () => term.getSelection(),
      copy: (text) => { if (text) adapter.clipWrite(text); },
      // No arg: read the system clipboard and paste it. With a string (the
      // Ctrl+Shift+Enter soft newline): paste that text directly, bracketed.
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
        if (msg && msg.event === 'text' && pendingPaste) {
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
    // Right-click: paste when there is no selection, copy when there is —
    // matches the common terminal.integrated.rightClickBehavior.
    termEl.addEventListener('contextmenu', (e) => {
      if (!clipIo.enabled) return;
      e.preventDefault();
      if (term.hasSelection()) adapter.clipWrite(term.getSelection());
      else clipIo.paste();
    });

    // ---- attachments: 📎 button, image paste, drag & drop -------------
    if (attachBtn && adapter.attachPick) {
      attachBtn.addEventListener('click', () => adapter.attachPick());
    }
    if (adapter.onAttach) {
      adapter.onAttach((msg) => {
        if (msg && msg.event === 'insert' && msg.text) term.paste(msg.text + ' ');
      });
    }
    // The DOM `paste` event on xterm's helper textarea carries a synchronous,
    // focus-independent DataTransfer — the reliable path for an image, and it
    // also lets us short-circuit the async extension round-trip for text.
    const textarea = term.textarea;
    if (textarea) {
      textarea.addEventListener('paste', (e) => {
        if (!clipIo.enabled) return;
        const dt = e.clipboardData;
        const img = clip.firstImageFile && clip.firstImageFile(dt);
        if (img) {
          e.preventDefault();
          pendingPaste = false; // the key handler's clipRead reply is now moot
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
    termEl.addEventListener('dragover', (e) => { e.preventDefault(); });
    termEl.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      e.preventDefault();
      const files = dt.files;
      if (!files || !files.length) return;
      // A real filesystem path (Electron exposes File.path) is inserted
      // directly; otherwise fall back to the image-byte pipeline.
      const paths = [];
      for (let i = 0; i < files.length; i++) {
        if (files[i].path) paths.push(files[i].path);
      }
      if (paths.length) {
        // let the extension quote them (single source of truth); it replies
        // with an 'insert' message the onAttach handler above splices in
        if (adapter.attachPaths) adapter.attachPaths(paths);
        return;
      }
      const img = clip.firstImageFile && clip.firstImageFile(dt);
      if (img) sendImageFile(adapter, img);
    });

    if (typeof root.ResizeObserver === 'function') {
      const ro = new root.ResizeObserver(() => doFit());
      ro.observe(termEl);
    }
    root.addEventListener('resize', doFit);

    adapter.onTerm((msg) => {
      if (!msg || msg.type !== 'term') return;
      if (msg.event === 'data') {
        term.write(msg.data || '');
      } else if (msg.event === 'exit') {
        const code = msg.code != null ? ' (' + msg.code + ')' : '';
        term.write('\r\n\x1b[2m[claude exited' + code +
          '] — press New thread or start typing to run it again\x1b[0m\r\n');
      } else if (msg.event === 'unavailable') {
        showNotice(msg.message || '');
      }
    });

    if (newBtn) {
      newBtn.addEventListener('click', () => {
        term.reset();
        adapter.termNew();
      });
    }
    if (metaEl) metaEl.textContent = 'interactive claude — permission prompts are answered here';

    // main.js calls this when the Run view becomes visible so the terminal
    // sizes to a container that was display:none a moment ago.
    AY.term.fit = () => { doFit(); term.focus(); };
  }

  AY.term = { init };
})(window);
