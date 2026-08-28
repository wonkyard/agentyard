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

    root.addEventListener('message', (ev) => {
      const msg = ev.data || {};
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
      runCommand(command) {
        vscode.postMessage({ type: 'command', command });
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
