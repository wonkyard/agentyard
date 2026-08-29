// Clipboard + attachment key handling for the Run-view terminal. xterm.js ships
// with no clipboard behaviour, so term.js wires this in through
// term.attachCustomKeyEventHandler. The decision is kept here as one pure
// function so scripts/sanity.mjs can exercise every branch without a DOM or a
// real clipboard.
//
// keyHandler(ev, io) -> boolean
//   ev : a KeyboardEvent-shaped object { type, key, ctrlKey, shiftKey, metaKey }
//   io : {
//     platform         'darwin' on macOS, anything else otherwise
//     enabled          false disables all copy/paste handling (config gate)
//     hasSelection()   -> boolean
//     getSelection()   -> string
//     copy(text)       write text to the clipboard
//     paste()          read the clipboard and paste it into the pty
//   }
//   returns true  -> let xterm / the pty handle the key unchanged
//           false -> the key was handled here; swallow it
(function (root) {
  const AY = (root.AY = root.AY || {});

  function isMac(io) {
    return io.platform === 'darwin' || io.platform === 'mac';
  }

  function keyHandler(ev, io) {
    if (!ev || ev.type !== 'keydown') return true;
    if (!io || io.enabled === false) return true;

    const mac = isMac(io);
    const primary = mac ? !!ev.metaKey : !!ev.ctrlKey;
    const key = String(ev.key || '').toLowerCase();

    // ---- soft newline ---------------------------------------------------
    // Ctrl+Shift+Enter (Cmd+Shift+Enter on macOS) inserts a literal newline
    // into the current input line instead of submitting it. io.paste('\n')
    // routes through term.paste, whose bracketed-paste framing the claude CLI
    // treats as literal text — so the newline lands in the buffer without
    // submitting, same as pasting a multi-line block. Plain Enter and plain
    // Shift+Enter are left untouched (some shells already treat the latter
    // specially — only the explicit chord is ours).
    if (key === 'enter' && ev.shiftKey && (ev.ctrlKey || ev.metaKey)) {
      if (io.paste) io.paste('\n');
      return false;
    }

    // ---- copy -------------------------------------------------------------
    // Ctrl/Cmd+C, and Ctrl+Shift+C as an always-copy for muscle memory.
    if (key === 'c' && (primary || (ev.ctrlKey && ev.shiftKey))) {
      const hasSel = !!(io.hasSelection && io.hasSelection());
      if (hasSel) {
        io.copy(io.getSelection ? io.getSelection() : '');
        return false;
      }
      // Ctrl+Shift+C / Cmd+C never send SIGINT — just do nothing when there is
      // nothing selected. A plain Ctrl+C with no selection passes through.
      if (ev.shiftKey || mac) return false;
      return true;
    }

    // ---- paste ----------------------------------------------------------
    // Ctrl/Cmd+V, Ctrl+Shift+V, and Shift+Insert.
    if ((key === 'v' && (primary || (ev.ctrlKey && ev.shiftKey))) ||
        (key === 'insert' && ev.shiftKey)) {
      if (io.paste) io.paste();
      return false;
    }

    return true;
  }

  // Pull the first image blob out of a DOM ClipboardEvent / DataTransfer, or
  // null. Shared by the terminal textarea paste handler and drag-and-drop.
  function firstImageFile(dataTransfer) {
    if (!dataTransfer) return null;
    const items = dataTransfer.items;
    if (items && items.length) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it && it.kind === 'file' && String(it.type || '').indexOf('image/') === 0) {
          const f = it.getAsFile();
          if (f) return f;
        }
      }
    }
    const files = dataTransfer.files;
    if (files && files.length) {
      for (let i = 0; i < files.length; i++) {
        if (String(files[i].type || '').indexOf('image/') === 0) return files[i];
      }
    }
    return null;
  }

  AY.termclip = { keyHandler, firstImageFile };
})(window);
