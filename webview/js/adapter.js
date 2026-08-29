// Thin environment adapter. Everything VS Code-specific lives here so the exact
// same renderer runs in a plain browser (`npm run dev`) and in the extension.
(function (root) {
  const inVsCode = typeof root.acquireVsCodeApi === 'function';

  function b64ToBytes(b64) {
    const bin = root.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---- browser: talk to scripts/dev-server.mjs over HTTP -------------------
  function browserAdapter() {
    return {
      mode: 'browser',
      wasmUrl: 'vendor/sql-wasm.wasm',
      // The run view needs a real child process, so it is VS Code only. The dev
      // server can still hand back a canned sample feed for layout work.
      runSupported: false,
      termSupported: false,
      onRun() {},
      onTerm() {},
      termAttach() {},
      termInput() {},
      termResize() {},
      termNew() {},
      async runSample() {
        try {
          const res = await fetch('api/run-sample', { cache: 'no-store' });
          if (!res.ok) return [];
          const data = await res.json();
          return Array.isArray(data.items) ? data.items : [];
        } catch (e) {
          return [];
        }
      },
      async getRaw() {
        const [agentsRes, dbRes, evRes] = await Promise.all([
          fetch('api/agents', { cache: 'no-store' }),
          fetch('api/db', { cache: 'no-store' }),
          fetch('api/events', { cache: 'no-store' }).catch(() => null),
        ]);
        if (!agentsRes.ok) throw new Error('api/agents ' + agentsRes.status);
        if (!dbRes.ok) throw new Error('api/db ' + dbRes.status);
        const agents = await agentsRes.json();
        const dbBytes = new Uint8Array(await dbRes.arrayBuffer());
        let live = { events: [], hooksInstalled: false };
        if (evRes && evRes.ok) live = await evRes.json();
        return {
          dataMode: agents.dataMode || 'demo',
          departments: agents.departments,
          teamRoles: agents.teamRoles,
          dbBytes,
          liveEvents: live.events || [],
          hooksInstalled: !!live.hooksInstalled,
          nowMs: Date.now(),
        };
      },
    };
  }

  // ---- VS Code: the extension pushes snapshots via postMessage ------------
  function vscodeAdapter() {
    const vscode = root.acquireVsCodeApi();
    const cfg = root.AY_CONFIG || {};
    let latest = null;
    let waiters = [];
    const runListeners = [];
    const termListeners = [];

    root.addEventListener('message', (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'run') {
        runListeners.forEach((fn) => {
          try { fn(msg); } catch (e) { /* ignore */ }
        });
        return;
      }
      if (msg.type === 'term') {
        termListeners.forEach((fn) => {
          try { fn(msg); } catch (e) { /* ignore */ }
        });
        return;
      }
      if (msg.type !== 'data') return;
      latest = {
        dataMode: msg.dataMode || 'workspace',
        departments: msg.departments || [],
        teamRoles: msg.teamRoles || [],
        dbBytes: msg.dbBase64 ? b64ToBytes(msg.dbBase64) : new Uint8Array(),
        liveEvents: msg.liveEvents || [],
        hooksInstalled: !!msg.hooksInstalled,
        nowMs: msg.nowMs || Date.now(),
        idleSeconds: msg.idleSeconds || 30,
        maxSpritesPerRoom: msg.maxSpritesPerRoom || 8,
      };
      const w = waiters;
      waiters = [];
      w.forEach((fn) => fn(latest));
    });

    vscode.postMessage({ type: 'ready' });

    return {
      mode: 'vscode',
      wasmUrl: cfg.wasmUrl || 'vendor/sql-wasm.wasm',
      runSupported: true,
      termSupported: true,
      runCommand(command) {
        vscode.postMessage({ type: 'command', command });
      },
      onRun(fn) {
        if (typeof fn === 'function') runListeners.push(fn);
      },
      onTerm(fn) {
        if (typeof fn === 'function') termListeners.push(fn);
      },
      termAttach(cols, rows) {
        vscode.postMessage({ type: 'term', event: 'attach', cols, rows });
      },
      termInput(data) {
        vscode.postMessage({ type: 'term', event: 'input', data: String(data) });
      },
      termResize(cols, rows) {
        vscode.postMessage({ type: 'term', event: 'resize', cols, rows });
      },
      termNew() {
        vscode.postMessage({ type: 'term', event: 'new' });
      },
      runStatus() {
        vscode.postMessage({ type: 'run', action: 'status' });
      },
      runSend(prompt, resume) {
        vscode.postMessage({ type: 'run', action: 'send', prompt: String(prompt), resume: !!resume });
      },
      runCancel() {
        vscode.postMessage({ type: 'run', action: 'cancel' });
      },
      runNew() {
        vscode.postMessage({ type: 'run', action: 'new' });
      },
      async getRaw() {
        vscode.postMessage({ type: 'poll' });
        if (latest) return latest;
        return new Promise((resolve) => waiters.push(resolve));
      },
    };
  }

  root.AY = root.AY || {};
  root.AY.adapter = inVsCode ? vscodeAdapter() : browserAdapter();
})(window);
