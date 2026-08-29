// Run view: an input box + a scrollable feed that shows a `claude -p` run
// (prompt, assistant text, tool calls, result). The extension owns the child
// process; this file only renders the messages it posts back and sends
// send/cancel/new-thread intents. In a plain browser there is no child process,
// so it shows "available inside VS Code" and (from the dev server) a canned
// sample feed for layout work.
(function (root) {
  const AY = (root.AY = root.AY || {});

  function el(tag, cls, text) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }

  function fmtDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return ms + 'ms';
    const s = ms / 1000;
    return (s < 20 ? s.toFixed(1) : Math.round(s)) + 's';
  }

  // Pure: one feed item -> { cls, text }  (unit-tested in sanity)
  function describe(item) {
    if (!item || typeof item !== 'object') return null;
    switch (item.kind) {
      case 'system': {
        const bits = [];
        if (item.sessionId) bits.push('session ' + String(item.sessionId).slice(0, 8));
        if (item.model) bits.push(item.model);
        if (item.tools) bits.push(item.tools + ' tools');
        return { cls: 'ln-system', text: bits.join('  ·  ') };
      }
      case 'assistant':
        return { cls: 'ln-assistant', text: String(item.text || '') };
      case 'tool':
        return {
          cls: 'ln-tool',
          text: '→ ' + item.name + (item.summary ? ': ' + item.summary : ''),
        };
      case 'tool-result':
        return {
          cls: item.ok ? 'ln-result-ok' : 'ln-result-bad',
          text: (item.ok ? '✓ ' : '✕ ') + (item.preview || (item.ok ? 'done' : 'failed')),
        };
      case 'result': {
        const meta = [];
        if (item.numTurns != null) meta.push(item.numTurns + ' turn' + (item.numTurns === 1 ? '' : 's'));
        if (item.durationMs != null) meta.push(fmtDuration(item.durationMs));
        const head = (item.ok ? 'done' : 'ended with an error') + (meta.length ? '  ·  ' + meta.join('  ·  ') : '');
        // The answer is already streamed as an assistant line above, so the
        // result line is just a summary. Only carry text when the run errored
        // (an error result may hold text that was never streamed).
        return { cls: item.ok ? 'ln-done' : 'ln-done bad', text: head, body: item.ok ? '' : String(item.text || '') };
      }
      case 'log':
        return { cls: 'ln-log', text: String(item.text || '') };
      default:
        return null;
    }
  }

  // Splice text into a textarea at the caret without submitting.
  function insertAtCaret(input, text) {
    const start = input.selectionStart == null ? input.value.length : input.selectionStart;
    const end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const caret = start + text.length;
    try { input.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
    input.dispatchEvent(new root.Event('input'));
  }

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
    const feed = document.getElementById('run-feed');
    const input = document.getElementById('run-input');
    const sendBtn = document.getElementById('run-send');
    const cancelBtn = document.getElementById('run-cancel');
    const newBtn = document.getElementById('run-new');
    const attachBtn = document.getElementById('run-attach');
    const meta = document.getElementById('run-meta');
    const hint = document.getElementById('run-hint');
    if (!feed || !input) return;

    const adapter = AY.adapter || {};
    const clip = AY.termclip || {};
    const supported = adapter.runSupported !== false;
    let running = false;
    let threadActive = false; // becomes true after a completed run -> next send resumes
    let sessionId = null;
    let atBottom = true;

    feed.addEventListener('scroll', () => {
      atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 24;
    });

    function scroll() {
      if (atBottom) feed.scrollTop = feed.scrollHeight;
    }

    function add(node) {
      feed.appendChild(node);
      scroll();
    }

    function addLine(desc) {
      if (!desc) return;
      const wrap = el('div', 'feed-ln ' + desc.cls);
      wrap.appendChild(el('div', 'feed-ln-head', desc.text));
      if (desc.body) wrap.appendChild(el('div', 'feed-ln-body', desc.body));
      add(wrap);
    }

    function addPrompt(text, resumed) {
      const wrap = el('div', 'feed-ln ln-prompt');
      wrap.appendChild(el('div', 'feed-ln-tag', resumed ? 'you · resuming' : 'you'));
      wrap.appendChild(el('div', 'feed-ln-body', text));
      add(wrap);
    }

    function addDivider(text) {
      add(el('div', 'feed-divider', text || ''));
    }

    function setRunning(on) {
      running = on;
      sendBtn.disabled = on || !supported;
      cancelBtn.hidden = !on;
      input.disabled = on || !supported;
      newBtn.disabled = on;
      updateMeta();
    }

    function updateMeta() {
      const parts = [];
      if (!supported) parts.push('run is available inside VS Code');
      else if (running) parts.push('running…');
      else if (threadActive) parts.push('thread active — next message continues it');
      else parts.push('new thread');
      if (sessionId) parts.push('session ' + String(sessionId).slice(0, 8));
      meta.textContent = parts.join('   ·   ');
    }

    function doSend() {
      if (!supported || running) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      autosize();
      if (adapter.runSend) adapter.runSend(text, threadActive);
    }

    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(140, input.scrollHeight) + 'px';
    }

    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    sendBtn.addEventListener('click', doSend);
    cancelBtn.addEventListener('click', () => adapter.runCancel && adapter.runCancel());
    newBtn.addEventListener('click', () => {
      if (running) return;
      feed.textContent = '';
      threadActive = false;
      sessionId = null;
      if (adapter.runNew) adapter.runNew();
      updateMeta();
    });

    function handle(msg) {
      if (!msg || msg.type !== 'run') return;
      switch (msg.event) {
        case 'status':
          if (typeof msg.running === 'boolean') setRunning(msg.running);
          if (msg.sessionId) sessionId = msg.sessionId;
          updateMeta();
          break;
        case 'started':
          addPrompt(msg.prompt, msg.resumed);
          setRunning(true);
          break;
        case 'item':
          addLine(describe(msg.item));
          if (msg.item && msg.item.kind === 'result') addDivider('');
          break;
        case 'stderr':
          if (msg.text) addLine({ cls: 'ln-log', text: msg.text });
          break;
        case 'error':
          addLine({ cls: 'ln-error', text: msg.message || 'run error' });
          break;
        case 'ended':
          if (msg.sessionId) sessionId = msg.sessionId;
          if (msg.stderr) addLine({ cls: 'ln-log', text: msg.stderr });
          threadActive = !!sessionId;
          setRunning(false);
          addDivider('— end of run —');
          break;
        default:
          break;
      }
    }

    // ---- attachments: 📎 button, image paste, drag & drop -----------
    if (attachBtn && adapter.attachPick) {
      attachBtn.addEventListener('click', () => adapter.attachPick());
    }
    if (adapter.onAttach) {
      adapter.onAttach((msg) => {
        if (msg && msg.event === 'insert' && msg.text) {
          insertAtCaret(input, (input.value && !/\s$/.test(input.value) ? ' ' : '') + msg.text + ' ');
        }
      });
    }
    input.addEventListener('paste', (e) => {
      const img = clip.firstImageFile && clip.firstImageFile(e.clipboardData);
      if (img) {
        e.preventDefault();
        sendImageFile(adapter, img);
      }
    });
    input.addEventListener('dragover', (e) => { e.preventDefault(); });
    input.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      e.preventDefault();
      const paths = [];
      for (let i = 0; i < dt.files.length; i++) {
        if (dt.files[i].path) paths.push(dt.files[i].path);
      }
      if (paths.length) {
        if (adapter.attachPaths) adapter.attachPaths(paths);
        return;
      }
      const img = clip.firstImageFile && clip.firstImageFile(dt);
      if (img) sendImageFile(adapter, img);
    });

    if (adapter.onRun) adapter.onRun(handle);
    setRunning(false);

    if (!supported) {
      hint.textContent = 'Runs spawn the Claude Code CLI, which needs VS Code — this browser preview is layout only.';
      hint.hidden = false;
      if (adapter.runSample) {
        adapter.runSample().then((items) => {
          if (!items || !items.length) return;
          addDivider('sample feed — not a live run');
          addPrompt('Add a short haiku about pixels to the top of README.md', false);
          for (const it of items) {
            addLine(describe(it));
            if (it && it.kind === 'result') addDivider('— end of run —');
          }
        });
      }
    } else if (adapter.runStatus) {
      adapter.runStatus();
    }
    updateMeta();
  }

  AY.run = { init, describe };
})(window);
