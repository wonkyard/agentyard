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

  function init() {
    const cfg = root.AY_CONFIG || {};
    const adapter = AY.adapter || {};

    const termEl = document.getElementById('run-term');
    const noticeEl = document.getElementById('run-notice');
    const footEl = document.getElementById('run-term-foot');
    const newBtn = document.getElementById('run-term-new');
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
