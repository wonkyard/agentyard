// First-run onboarding wizard + always-on Help view + empty-state banner.
//
// All UI lives in the webview (an in-panel overlay card and a banner strip) —
// no browser dialog. The extension host answers over the adapter's generic
// message bridge (adapter.sendMsg / adapter.onMsg) with globalState, bundled
// help markdown, and ~/.claude/agents writes. In a plain browser (dev server)
// there is no host, so the "?" button shows a short static note and the wizard
// never auto-opens.
(function (root) {
  const AY = (root.AY = root.AY || {});
  const doc = root.document;

  function el(tag, cls, text) {
    const d = doc.createElement(tag);
    if (cls) d.className = cls;
    if (text != null) d.textContent = text;
    return d;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[c]));
  }

  // ---- tiny, safe markdown -> HTML (bundled content only) ----------------
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
      .replace(/\*\*([^*]+)\*\*/g, (_, b) => '<strong>' + b + '</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
        (_, t, u) => '<a href="#" data-ext="' + u + '">' + t + '</a>')
      // bare URLs not already inside an href="…"
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
        (_, pre, u) => pre + '<a href="#" data-ext="' + u + '">' + u + '</a>');
  }
  function mdLite(src) {
    const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) { const n = h[1].length; out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>'); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
          if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
          i++;
        }
        out.push('<table>' + rows.map((r, ri) => '<tr>' + r.map((c) =>
          (ri === 0 ? '<th>' + inline(c) + '</th>' : '<td>' + inline(c) + '</td>')).join('') + '</tr>').join('') + '</table>');
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*[-*]\s+/, '')) + '</li>');
          i++;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*[-*]\s|\s*\|)/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }
    return out.join('\n');
  }

  function init() {
    const cfg = root.AY_CONFIG || {};
    const adapter = AY.adapter || {};
    const supported = adapter.onboardSupported === true;
    const overlay = doc.getElementById('ay-overlay');
    const card = doc.getElementById('ay-overlay-card');
    const helpBtn = doc.getElementById('help-btn');
    const banner = doc.getElementById('office-banner');
    if (!overlay || !card) return;

    let state = {
      onboarded: !!cfg.onboarded,
      starters: [],
      claude: null,
      codex: null,
      agents: Array.isArray(cfg.agents) && cfg.agents.length ? cfg.agents.slice() : ['claude-code'],
      hasWorkspace: false,
    };
    let topics = [];
    let shownThisSession = false;
    let lastData = null;

    let wizardActive = false;
    function open() { overlay.hidden = false; }
    function close() {
      overlay.hidden = true;
      card.textContent = '';
      if (wizardActive) {
        // Dismissing the first-run wizard counts as "seen it" — it never
        // re-prompts. Re-open from the header ? or "Agentyard: Setup Guide".
        wizardActive = false;
        if (!state.onboarded) {
          state.onboarded = true;
          if (adapter.sendMsg) adapter.sendMsg({ type: 'onboard', action: 'done' });
        }
      }
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });

    // route link clicks inside the card to the host's external-open
    card.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[data-ext]');
      if (a) { e.preventDefault(); if (adapter.sendMsg) adapter.sendMsg({ type: 'ui', action: 'openExternal', url: a.getAttribute('data-ext') }); }
    });

    function frame(titleText) {
      card.textContent = '';
      const head = el('div', 'ay-card-head');
      head.appendChild(el('span', 'ay-card-title', titleText));
      const x = el('button', 'ay-card-x', '×');
      x.setAttribute('aria-label', '닫기');
      x.addEventListener('click', close);
      head.appendChild(x);
      card.appendChild(head);
      const body = el('div', 'ay-card-body');
      card.appendChild(body);
      return body;
    }

    // ---- Help view ----------------------------------------------------
    function showHelp(topicId) {
      open();
      const body = frame('도움말');
      if (!supported) {
        body.appendChild(el('p', null,
          '도움말과 설정 안내는 VS Code 확장에서 제공됩니다. 이 화면은 브라우저 미리보기예요.'));
        return;
      }
      const nav = el('div', 'ay-help-nav');
      const content = el('div', 'ay-help-content');
      body.appendChild(nav);
      body.appendChild(content);

      function render(t) {
        content.innerHTML = mdLite(t.markdown);
        if (t.id === 'terminal' || t.id === 'agents') {
          const actions = el('div', 'ay-help-actions');
          if (t.id === 'terminal') {
            actions.appendChild(mkBtn('진단 실행', () => adapter.sendMsg({ type: 'ui', action: 'diagnostics' })));
            actions.appendChild(mkBtn('claudePath 설정 열기', () => adapter.sendMsg({ type: 'ui', action: 'openClaudePathSetting' })));
            actions.appendChild(mkBtn('일반 터미널에서 열기', () => adapter.sendMsg({ type: 'ui', action: 'openClaudeTerminal' })));
          } else {
            actions.appendChild(mkBtn('샘플 부서 만들기', () => { close(); showWizard(true, 2); }));
            actions.appendChild(mkBtn('부서 폴더 열기', () => adapter.sendMsg({ type: 'onboard', action: 'openAgentsFolder' })));
          }
          content.appendChild(actions);
        }
        for (const b of nav.querySelectorAll('button')) b.classList.toggle('on', b.dataset.id === t.id);
        content.scrollTop = 0;
      }

      function paint() {
        nav.textContent = '';
        for (const t of topics) {
          const b = el('button', null, t.title);
          b.dataset.id = t.id;
          b.addEventListener('click', () => render(t));
          nav.appendChild(b);
        }
        const want = topics.find((t) => t.id === topicId) || topics[0];
        if (want) render(want);
      }

      if (topics.length) paint();
      else {
        content.appendChild(el('p', null, '불러오는 중…'));
        adapter.sendMsg({ type: 'help', action: 'list' });
        pendingHelpPaint = paint;
      }
    }
    let pendingHelpPaint = null;

    function mkBtn(label, fn, primary) {
      const b = el('button', 'ay-btn' + (primary ? ' ay-btn-primary' : ''), label);
      b.addEventListener('click', fn);
      return b;
    }

    // ---- Wizard -----------------------------------------------------
    function showWizard(force, startStep) {
      if (!supported) { showHelp(); return; }
      if (!force && state.onboarded) return;
      shownThisSession = true;
      wizardActive = true;
      open();
      let step = startStep || 1;
      const body = frame('Agentyard 시작하기');
      const steps = el('div', 'ay-steps');
      const nav = el('div', 'ay-wiz-nav');
      body.appendChild(steps);
      body.appendChild(nav);

      function paint() {
        steps.textContent = '';
        nav.textContent = '';
        steps.appendChild(el('div', 'ay-wiz-dots', '단계 ' + step + ' / 3'));
        if (step === 1) paintAgentsPicker(steps);
        else if (step === 2) paintAgents(steps);
        else paintDone(steps);

        if (step > 1) nav.appendChild(mkBtn('← 이전', () => { step--; paint(); }));
        nav.appendChild(el('span', 'ay-wiz-spacer'));
        if (step < 3) {
          nav.appendChild(mkBtn(step === 1 ? '건너뛰기 / 다음 →' : '다음 →', () => { step++; paint(); }, true));
        } else {
          nav.appendChild(mkBtn('Agentyard 시작', () => {
            adapter.sendMsg({ type: 'onboard', action: 'done' });
            state.onboarded = true;
            close();
          }, true));
        }
      }

      function paintAgentsPicker(host) {
        host.appendChild(el('h3', null, '1. 어떤 코딩 에이전트를 쓰나요?'));
        host.appendChild(el('p', null,
          '하나 이상 고르세요. Codex 는 AGENTS.md 를, Claude Code 는 CLAUDE.md 를 읽어요. ' +
          '나중에 설정(agentyard.agents)에서 바꿀 수 있어요.'));
        const OPTS = [
          { id: 'claude-code', label: 'Claude Code', diag: state.claude, bin: 'claude' },
          { id: 'codex', label: 'Codex', diag: state.codex, bin: 'codex' },
        ];
        const list = el('div', 'ay-starter-list');
        const boxes = [];
        for (const o of OPTS) {
          const label = el('label', 'ay-starter');
          const cb = doc.createElement('input');
          cb.type = 'checkbox';
          cb.value = o.id;
          cb.checked = state.agents.indexOf(o.id) !== -1;
          cb.dataset.id = o.id;
          boxes.push(cb);
          label.appendChild(cb);
          label.appendChild(el('span', 'ay-starter-name', o.label));
          const d = o.diag || {};
          const foundLine = d.resolved
            ? el('span', 'ay-starter-desc ay-ok', '찾음: ' + d.resolved)
            : el('span', 'ay-starter-desc ay-warn', '"' + (d.command || o.bin) + '" 를 PATH 에서 못 찾음');
          label.appendChild(foundLine);
          list.appendChild(label);
        }
        host.appendChild(list);
        const save = () => {
          const picked = boxes.filter((b) => b.checked).map((b) => b.value);
          state.agents = picked.length ? picked : ['claude-code'];
          adapter.sendMsg({ type: 'onboard', action: 'setAgents', agents: state.agents });
        };
        for (const b of boxes) b.addEventListener('change', save);
        const row = el('div', 'ay-help-actions');
        row.appendChild(mkBtn('다시 감지', () => adapter.sendMsg({ type: 'onboard', action: 'detectClis' })));
        host.appendChild(row);
      }

      function paintAgents(host) {
        if (state.agents.indexOf('claude-code') === -1) {
          host.appendChild(el('h3', null, '2. 부서(에이전트) 파일'));
          host.appendChild(el('p', null,
            'Codex 는 부서(에이전트)별 파일이 없어요 — 여기서 만들 게 없습니다. ' +
            '지침은 마지막 단계에서 AGENTS.md 로 만들 수 있어요.'));
          return;
        }
        host.appendChild(el('h3', null, '2. 부서(에이전트) 만들기'));
        host.appendChild(el('p', null,
          '부서는 ~/.claude/agents/<이름>.md 파일이에요. 아래에서 골라 시작하고, 나중에 파일을 열어 고치면 됩니다.'));
        const list = el('div', 'ay-starter-list');
        const boxes = [];
        for (const s of (state.starters || [])) {
          const label = el('label', 'ay-starter');
          const cb = doc.createElement('input');
          cb.type = 'checkbox';
          cb.value = s.name;
          cb.checked = !s.exists;
          cb.disabled = s.exists;
          boxes.push(cb);
          label.appendChild(cb);
          label.appendChild(el('span', 'ay-starter-name', s.name + (s.exists ? '  (이미 있음)' : '')));
          if (s.description) label.appendChild(el('span', 'ay-starter-desc', s.description));
          list.appendChild(label);
        }
        host.appendChild(list);
        host.appendChild(mkBtn('선택한 부서 파일 생성', () => {
          const names = boxes.filter((b) => b.checked && !b.disabled).map((b) => b.value);
          if (names.length) adapter.sendMsg({ type: 'onboard', action: 'createAgents', names });
        }, true));
        const res = el('div', 'ay-starter-result');
        res.id = 'ay-starter-result';
        host.appendChild(res);
        if (lastCreated) renderCreated(res, lastCreated);
      }

      function paintDone(host) {
        host.appendChild(el('h3', null, '3. 지침 파일 (AGENTS.md)'));
        host.appendChild(el('p', null,
          'AGENTS.md 하나를 기준 문서로 두고, Claude Code 를 함께 쓰면 CLAUDE.md 는 ' +
          '"@AGENTS.md" 한 줄로 이어 붙여 동기화해요. 기존 CLAUDE.md 는 절대 덮어쓰지 않고 ' +
          '먼저 백업합니다.'));
        host.appendChild(mkBtn('지침 파일 설정', () => {
          adapter.sendMsg({ type: 'ui', action: 'setupGuidelines' });
        }, true));
        const made = (lastCreated && lastCreated.results || []).filter((r) => r.state === 'created').length;
        if (made) host.appendChild(el('p', null, '부서 ' + made + '개를 만들었어요.'));
        host.appendChild(el('p', null,
          '패널 헤더의 ? 를 누르면 이 안내와 자세한 도움말을 다시 볼 수 있어요. ' +
          '명령 팔레트의 "Agentyard: Setup Guide" 로도 열립니다.'));
      }

      paint();
      wizardRepaint = paint;
    }
    let wizardRepaint = null;
    let lastCreated = null;

    function renderCreated(host, result) {
      host.textContent = '';
      for (const r of (result.results || [])) {
        const line = r.state === 'created' ? '✓ ' + r.name + ' 생성'
          : r.state === 'exists' ? '· ' + r.name + ' 이미 있음'
          : r.state === 'unknown' ? '? ' + r.name + ' (템플릿 없음)'
          : '✕ ' + r.name + ' 실패';
        host.appendChild(el('div', 'ay-starter-line', line));
      }
    }

    // ---- banner (demo badge / empty-state card) --------------------
    function onData(raw) {
      lastData = raw || {};
      if (!banner) return;
      const demo = lastData.dataMode === 'demo';
      const rosterEmpty = !!lastData.rosterEmpty;
      const gl = lastData.guideline || {};
      const noGuideline = !demo && lastData.hasWorkspace &&
        gl.agentsMd === 'absent' && gl.claudeMd === 'absent';
      if (!demo && !rosterEmpty && !noGuideline) { banner.hidden = true; banner.textContent = ''; return; }
      banner.textContent = '';
      banner.hidden = false;
      if (!demo && !rosterEmpty && noGuideline) {
        banner.className = 'ay-banner ay-banner-empty';
        banner.appendChild(el('b', null, '지침 파일이 없어요'));
        banner.appendChild(el('span', null,
          '코딩 에이전트가 읽을 AGENTS.md 를 만들어 두면 좋아요. CLAUDE.md 도 함께 동기화됩니다.'));
        const a = el('span', 'ay-banner-actions');
        a.appendChild(mkBtn('지침 파일 만들기',
          () => adapter.sendMsg && adapter.sendMsg({ type: 'ui', action: 'setupGuidelines' }), true));
        a.appendChild(mkBtn('자세히', () => showHelp('data')));
        banner.appendChild(a);
        return;
      }
      if (rosterEmpty) {
        banner.className = 'ay-banner ay-banner-empty';
        banner.appendChild(el('b', null, '아직 부서가 없어요'));
        banner.appendChild(el('span', null,
          'Agentyard는 ~/.claude/agents/ 의 .md 파일을 회사 부서로 읽어요. 샘플로 시작해 볼까요?'));
      } else {
        banner.className = 'ay-banner ay-banner-demo';
        banner.appendChild(el('b', null, '데모 데이터예요'));
        banner.appendChild(el('span', null, '아래는 합성 예시입니다 — 내 부서를 만들어 보세요.'));
      }
      const actions = el('span', 'ay-banner-actions');
      actions.appendChild(mkBtn(rosterEmpty ? '샘플 부서 만들기' : '시작하기',
        () => (supported ? showWizard(true) : showHelp('agents')), true));
      actions.appendChild(mkBtn('자세히', () => showHelp(rosterEmpty ? 'agents' : 'about')));
      banner.appendChild(actions);
    }

    // ---- host messages --------------------------------------------
    function handle(msg) {
      if (!msg) return;
      if (msg.type === 'onboard') {
        if (msg.event === 'state') {
          if (typeof msg.onboarded === 'boolean') state.onboarded = msg.onboarded;
          if (msg.starters) state.starters = msg.starters;
          if (msg.claude) state.claude = msg.claude;
          if (msg.codex) state.codex = msg.codex;
          if (Array.isArray(msg.agents)) state.agents = msg.agents.slice();
          if (typeof msg.hasWorkspace === 'boolean') state.hasWorkspace = msg.hasWorkspace;
          if (!state.onboarded && !shownThisSession) showWizard(false);
          if (wizardRepaint && !overlay.hidden) wizardRepaint();
        } else if (msg.event === 'open') {
          showWizard(!!msg.force);
        } else if (msg.event === 'claude') {
          state.claude = msg.claude || state.claude;
          if (wizardRepaint && !overlay.hidden) wizardRepaint();
        } else if (msg.event === 'clis') {
          if (msg.claude) state.claude = msg.claude;
          if (msg.codex) state.codex = msg.codex;
          if (Array.isArray(msg.agents)) state.agents = msg.agents.slice();
          if (wizardRepaint && !overlay.hidden) wizardRepaint();
        } else if (msg.event === 'created') {
          lastCreated = msg.result || null;
          if (msg.starters) state.starters = msg.starters;
          const res = doc.getElementById('ay-starter-result');
          if (res && lastCreated) renderCreated(res, lastCreated);
          if (wizardRepaint && !overlay.hidden) wizardRepaint();
        }
      } else if (msg.type === 'help' && msg.event === 'topics') {
        topics = msg.topics || [];
        if (pendingHelpPaint) { const f = pendingHelpPaint; pendingHelpPaint = null; f(); }
      }
    }

    if (helpBtn) helpBtn.addEventListener('click', () => showHelp());
    if (adapter.onMsg) adapter.onMsg(handle);
    if (supported && adapter.sendMsg) {
      adapter.sendMsg({ type: 'onboard', action: 'get' });
      adapter.sendMsg({ type: 'help', action: 'list' });
    }

    AY.onboard.showHelp = showHelp;
    AY.onboard.showWizard = showWizard;
    AY.onboard.onData = onData;
  }

  AY.onboard = { init, onData() {} };
})(window);
