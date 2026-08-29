// Scene layout + drawing. Pure function of (office model, time, view state):
// paints the canvas and returns the clickable hit-rects for the frame.
(function (root) {
  const P = root.AY.palette;
  const S = root.AY.sprites;
  const {
    px, alpha, drawFloor, drawRug, drawDoor, drawWindow, drawPlant, drawShelf, drawDesk,
    drawChair, drawPerson, drawShadow, drawThought, drawBang,
  } = S;

  const W = 840;
  const MARGIN = 14;
  const HEADER_H = 42;
  const BOARD_H = 66;
  const LIVE_TOP = HEADER_H + BOARD_H + 8;
  const COLS = 3;
  const GAP = 12;
  const CELL_W = Math.floor((W - MARGIN * 2 - GAP * (COLS - 1)) / COLS);
  const CELL_H = 150;
  const LIVE_CELL_H = 132;

  function liveLayout(office) {
    const n = (office.liveRooms || []).length;
    if (!n) return { rows: 0, labelY: 0, top: LIVE_TOP, height: 0, deptTop: LIVE_TOP };
    const rows = Math.ceil(n / COLS);
    const labelY = LIVE_TOP;
    const top = labelY + 18;
    const bottom = top + rows * LIVE_CELL_H + (rows - 1) * GAP;
    return { rows, labelY, top, height: bottom - LIVE_TOP + 16, deptTop: bottom + 16 };
  }

  function layout(office) {
    const LL = liveLayout(office);
    const OFFICE_TOP = LL.deptTop;
    const nDept = office.departments.length;
    const rows = Math.max(1, Math.ceil(nDept / COLS));
    const officeBottom = OFFICE_TOP + rows * CELL_H + (rows - 1) * GAP;
    const annexLabelY = officeBottom + 14;
    const annexTop = annexLabelY + 20;
    const nAnnex = Math.max(1, office.annexes.length);
    const annexCols = Math.min(2, nAnnex);
    const annexRows = Math.ceil(nAnnex / annexCols);
    const annexCellW = Math.floor((W - MARGIN * 2 - GAP * (annexCols - 1)) / annexCols);
    const annexCellH = 184;
    const annexBottom = annexTop + annexRows * annexCellH + (annexRows - 1) * GAP;
    return {
      rows, officeBottom, annexLabelY, annexTop, annexCols, annexCellW, annexCellH,
      deptTop: OFFICE_TOP, live: LL,
      height: annexBottom + MARGIN,
    };
  }

  function trunc(ctx, str, maxW) {
    str = String(str == null ? '' : str);
    if (ctx.measureText(str).width <= maxW) return str;
    while (str.length > 1 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1);
    return str + '…';
  }

  function look(name) {
    return {
      shirt: root.AY.pick(P.shirts, name),
      skin: root.AY.pick(P.skin, name + '|s'),
      hair: root.AY.pick(P.hair, name + '|h'),
      phase: (root.AY.hash(name) % 628) / 100,
      speed: 11 + (root.AY.hash(name + '|v') % 12),
    };
  }

  // point at distance d clockwise around rect r, starting top-left
  function perimeter(r, d) {
    const per = 2 * (r.w + r.h);
    d = ((d % per) + per) % per;
    if (d < r.w) return { x: r.x + d, y: r.y, facing: 1 };
    d -= r.w;
    if (d < r.h) return { x: r.x + r.w, y: r.y + d, facing: 0 };
    d -= r.h;
    if (d < r.w) return { x: r.x + r.w - d, y: r.y + r.h, facing: -1 };
    d -= r.w;
    return { x: r.x, y: r.y + r.h - d, facing: 0 };
  }

  function wanderState(lk, t) {
    // sin term makes agents ease and briefly pause -> looks alive, not a treadmill
    const d = lk.phase * 60 + (t / 1000) * lk.speed + Math.sin(t / 900 + lk.phase) * 9;
    return { d, frame: Math.floor(Math.abs(d) / 5) % 3 };
  }

  // ---- header --------------------------------------------------------
  function drawHeader(ctx, office) {
    px(ctx, 0, 0, W, HEADER_H, P.roomWall);
    px(ctx, 0, HEADER_H - 2, W, 2, P.accentTeal);
    ctx.textBaseline = 'top';
    ctx.font = 'bold 15px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    ctx.fillStyle = P.text;
    ctx.fillText('AGENTYARD', MARGIN, 7);
    const tw = ctx.measureText('AGENTYARD').width;
    ctx.font = '9px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.fillText('v0.4', MARGIN + tw + 8, 12);

    // --- data-mode pill (row 2, left) ---
    let pillHit = null;
    ctx.font = 'bold 9px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    ctx.textBaseline = 'top';
    let badge;
    if (office.dataMode === 'demo') {
      badge = { text: 'DEMO DATA', bg: P.purple, fg: P.bgTop, click: false };
    } else if (office.liveMode === 'live') {
      badge = { text: 'LIVE', bg: P.green, fg: P.bgTop, click: false };
    } else if (office.liveMode === 'watching') {
      badge = { text: 'WATCHING', bg: P.accentTeal, fg: P.bgTop, click: false };
    } else {
      badge = { text: 'hooks off — turn on live mode', bg: '#3a2030', fg: P.blocked, click: true };
    }
    const bw = ctx.measureText(badge.text).width + 12;
    px(ctx, MARGIN, 25, bw, 13, badge.bg);
    if (badge.click) px(ctx, MARGIN, 25, 2, 13, P.blocked);
    ctx.fillStyle = badge.fg;
    ctx.fillText(badge.text, MARGIN + 6, 27);
    if (badge.click) pillHit = { kind: 'livepill', x: MARGIN, y: 25, w: bw, h: 13 };

    // live counts hint, right of the pill
    if (office.dataMode !== 'demo' && (office.liveSessionCount || office.liveAgentCount)) {
      ctx.font = '9px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
      ctx.fillStyle = P.textFaint;
      ctx.fillText(
        `${office.liveSessionCount} session${office.liveSessionCount === 1 ? '' : 's'} · ${office.liveAgentCount} agent${office.liveAgentCount === 1 ? '' : 's'}`,
        MARGIN + bw + 8, 27);
    }

    const c = office.counts;
    const chips = [
      ['working ' + (c.working || 0), P.working],
      ['idle ' + (c.idle || 0), P.idle],
      ['blocked ' + (c.blocked || 0), P.blocked],
    ];
    let x = W - MARGIN;
    ctx.font = '10px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    for (let i = chips.length - 1; i >= 0; i--) {
      const [label, col] = chips[i];
      const w = ctx.measureText(label).width + 18;
      x -= w;
      px(ctx, x, 11, w, 20, '#20242f');
      px(ctx, x + 6, 18, 6, 6, col);
      ctx.fillStyle = P.text;
      ctx.fillText(label, x + 15, 15);
      x -= 6;
    }
    return pillHit;
  }

  function stageColor(stage) {
    if (/kill/i.test(stage)) return P.red;
    if (/done|ready|launch|ship|scale/i.test(stage)) return P.green;
    if (/build|engineer/i.test(stage)) return P.blue;
    return P.yellow;
  }

  function drawBoard(ctx, office) {
    const y0 = HEADER_H;
    px(ctx, 0, y0, W, BOARD_H, P.bgTop);
    px(ctx, 0, y0 + BOARD_H - 1, W, 1, P.roomWall);
    ctx.textBaseline = 'top';
    ctx.font = '9px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    ctx.fillStyle = P.textDim;
    ctx.fillText('COMPANY BOARD', MARGIN, y0 + 5);

    let x = MARGIN;
    let y = y0 + 18;
    let rowsUsed = 1;
    ctx.font = '9px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    for (const b of office.board) {
      const kind = b.projectId.slice(0, 4);
      const label = kind + ' ' + b.projectId.replace(/^IDEA-|^TOOL-|^DEMO-/, '') + '  ' + b.stage;
      const w = ctx.measureText(label).width + 24;
      if (x + w > W - MARGIN && x > MARGIN) {
        if (rowsUsed >= 2) break;
        x = MARGIN;
        y += 21;
        rowsUsed++;
      }
      px(ctx, x, y, w, 17, '#20242f');
      px(ctx, x, y, 3, 17, stageColor(b.stage));
      px(ctx, x + w - 11, y + 6, 6, 6, b.hasRepo ? P.accentTeal : '#3a3f4f');
      ctx.fillStyle = P.text;
      ctx.fillText(label, x + 8, y + 5);
      x += w + 7;
    }
  }

  // ---- HQ department room -------------------------------------------
  function drawRoom(ctx, agent, rx, ry, t, view) {
    const working = agent.status === 'working';
    const blocked = agent.status === 'blocked';
    const selected = view.selectedId === 'dept:' + agent.name;
    const sway = Math.round(Math.sin(t / 700 + rx) );

    // shell
    px(ctx, rx - 2, ry - 2, CELL_W + 4, CELL_H + 4, P.roomShadow);
    px(ctx, rx, ry, CELL_W, CELL_H, P.roomWall);
    px(ctx, rx + 1, ry + 15, CELL_W - 2, 3, P.roomWallHi);

    // floor
    const fx = rx + 3, fy = ry + 18, fw = CELL_W - 6, fh = CELL_H - 21;
    drawFloor(ctx, fx, fy, fw, fh,
      working ? P.roomFloorWork : P.roomFloor,
      working ? P.roomFloorWorkAlt : P.roomFloorAlt);
    // back-wall band + windows so the top of the room isn't dead space
    px(ctx, fx, fy, fw, 20, P.roomWall);
    px(ctx, fx, fy + 20, fw, 1, P.roomWallHi);
    drawWindow(ctx, rx + 26, fy + 5, 26, 12, t);
    drawWindow(ctx, rx + CELL_W - 52, fy + 5, 26, 12, t);
    drawRug(ctx, rx + (CELL_W >> 1), fy + fh - 26, 78, 34);

    // wall sign with the department name
    px(ctx, rx, ry, CELL_W, 15, P.roomLabelBg);
    px(ctx, rx, ry, 4, 15, root.AY.modelColor(agent.model));
    ctx.textBaseline = 'top';
    ctx.font = '10px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    ctx.fillStyle = P.text;
    ctx.fillText(trunc(ctx, agent.name, CELL_W - 32), rx + 8, ry + 3);
    px(ctx, rx + CELL_W - 13, ry + 4, 7, 7, root.AY.statusColor(agent.status));

    // fittings
    drawShelf(ctx, rx + 9, fy + 40);
    drawPlant(ctx, rx + CELL_W - 12, fy + fh - 6, sway);
    drawDoor(ctx, rx + CELL_W - 34, ry + CELL_H - 1);

    // desk + agent
    const deskX = rx + (CELL_W >> 1) - 22;
    const deskY = ry + CELL_H - 34;
    const seatX = deskX + 22;
    const seatFeetY = deskY + 20;
    const lk = look(agent.name);

    drawDesk(ctx, deskX, deskY, working, t);

    if (working) {
      drawChair(ctx, seatX, seatFeetY);
      drawShadow(ctx, seatX, seatFeetY, 12);
      drawPerson(ctx, seatX, seatFeetY - 4, { ...lk, pose: 'seated', t });
      drawThought(ctx, seatX + 6, deskY - 16, agent.note || '…', t);
    } else if (blocked) {
      const bx = deskX - 14;
      const by = deskY + 22;
      drawShadow(ctx, bx, by, 10);
      drawPerson(ctx, bx, by, { ...lk, pose: 'stand', facing: 1, t });
      drawBang(ctx, bx, by - 30, t);
    } else {
      const path = { x: fx + 30, y: fy + 30, w: fw - 46, h: fh - 44 };
      const st = wanderState(lk, t);
      const p = perimeter(path, st.d);
      drawShadow(ctx, p.x, p.y, 9);
      drawPerson(ctx, p.x, p.y, { ...lk, pose: 'walk', frame: st.frame, facing: p.facing, t });
    }

    // model tag
    ctx.font = '9px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    ctx.fillStyle = P.textFaint;
    ctx.fillText(agent.model, rx + 7, ry + CELL_H - 11);

    if (selected) {
      ctx.strokeStyle = P.accentTeal;
      ctx.lineWidth = 2;
      ctx.strokeRect(rx - 1, ry - 1, CELL_W + 2, CELL_H + 2);
    }

    return { kind: 'agent', id: 'dept:' + agent.name, x: rx, y: ry, w: CELL_W, h: CELL_H, data: agent };
  }

  // ---- live session / subagent room (glass office, reads as "now") --
  function drawLiveRoom(ctx, room, rx, ry, w, h, t, view) {
    const selected = view.selectedId === room.id;
    px(ctx, rx - 2, ry - 2, w + 4, h + 4, P.roomShadow);
    px(ctx, rx, ry, w, h, P.roomWall);

    const fx = rx + 3, fy = ry + 16, fw = w - 6, fh = h - 19;
    drawFloor(ctx, fx, fy, fw, fh, P.roomFloorWork, P.roomFloorWorkAlt);
    px(ctx, fx, fy, fw, 16, P.roomWall);
    px(ctx, fx, fy + 16, fw, 1, P.roomWallHi);
    drawWindow(ctx, rx + 18, fy + 3, 22, 10, t);
    drawWindow(ctx, rx + w - 42, fy + 3, 22, 10, t);

    // title bar
    px(ctx, rx, ry, w, 14, P.roomLabelBg);
    px(ctx, rx, ry, 4, 14, P.accentTeal);
    ctx.textBaseline = 'top';
    ctx.font = '10px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    ctx.fillStyle = P.text;
    ctx.fillText(trunc(ctx, room.title, w - 46), rx + 8, ry + 2);
    // pulsing LIVE dot
    const pulse = 0.4 + 0.6 * Math.abs(Math.sin(t / 500));
    alpha(ctx, pulse, () => px(ctx, rx + w - 14, ry + 4, 6, 6, P.green));

    ctx.font = '8px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    ctx.fillStyle = P.textFaint;
    ctx.fillText(trunc(ctx, (room.kind === 'live-main' ? 'main · ' : 'subagent · ') + room.subtitle, w - 12), rx + 8, ry + h - 9);

    const rects = [];
    const occ = room.occupants || [];
    const slots = occ.length + (room.overflow ? 1 : 0);
    const slotW = Math.max(18, Math.floor((fw - 6) / Math.max(1, slots)));
    const feetY = fy + fh - 8;
    const showBubble = occ.length <= 2;

    for (let i = 0; i < occ.length; i++) {
      const m = occ[i];
      const cx = fx + 3 + i * slotW + (slotW >> 1);
      const lk = look(room.title + '|' + m.name + i);
      const working = m.status === 'working';
      const blocked = m.status === 'blocked';

      if (working) {
        const deskX = cx - 22, deskY = feetY - 12;
        drawDesk(ctx, deskX, deskY, true, t);
        drawChair(ctx, cx, feetY);
        drawShadow(ctx, cx, feetY, 11);
        drawPerson(ctx, cx, feetY - 4, { ...lk, pose: 'seated', t });
        if (showBubble) drawThought(ctx, cx + 4, deskY - 14, m.doing || m.note || '…', t);
      } else if (blocked) {
        drawShadow(ctx, cx, feetY, 9);
        drawPerson(ctx, cx, feetY, { ...lk, pose: 'stand', facing: 1, t });
        drawBang(ctx, cx, feetY - 28, t);
      } else {
        const path = { x: fx + 8, y: fy + 20, w: fw - 16, h: fh - 30 };
        const st = wanderState(lk, t);
        const p = perimeter(path, st.d);
        drawShadow(ctx, p.x, p.y, 8);
        drawPerson(ctx, p.x, p.y, { ...lk, pose: 'walk', frame: st.frame, facing: p.facing, t });
      }
      px(ctx, cx - (slotW >> 1) + 2, fy + 18, 5, 5, root.AY.statusColor(m.status));

      rects.push({
        kind: 'agent',
        id: room.id + '#' + i,
        x: fx + 3 + i * slotW, y: fy + 17, w: slotW, h: fh - 17,
        data: {
          name: m.name, model: m.model, status: m.status,
          note: m.doing || m.note, ts: m.ts, description: m.description || '',
          annex: null, projectId: null,
        },
      });
    }

    if (room.overflow) {
      const ox = fx + 3 + occ.length * slotW;
      px(ctx, ox + 2, feetY - 20, slotW - 6, 18, P.roomLabelBg);
      ctx.font = '9px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
      ctx.fillStyle = P.textDim;
      ctx.fillText('+' + room.overflow, ox + 6, feetY - 14);
      ctx.font = '8px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
      ctx.fillStyle = P.textFaint;
      ctx.fillText('more', ox + 6, feetY - 6);
    }

    if (selected) {
      ctx.strokeStyle = P.accentTeal;
      ctx.lineWidth = 2;
      ctx.strokeRect(rx - 1, ry - 1, w + 2, h + 2);
    }
    return rects;
  }

  // ---- project annex building (visually distinct from HQ) ----------
  function drawAnnexShell(ctx, ax, ay, aw, ah) {
    px(ctx, ax - 2, ay + 10, aw + 4, ah - 6, P.annexShadow);
    // stepped roof
    for (let i = 0; i < 10; i++) {
      px(ctx, ax + i * 3, ay + i, aw - i * 6, 2, i < 3 ? P.annexRoofHi : P.annexRoof);
    }
    px(ctx, ax, ay + 10, aw, ah - 10, P.annexWall);
    // brick courses
    for (let by = ay + 16; by < ay + ah - 4; by += 8) {
      px(ctx, ax + 2, by, aw - 4, 1, P.annexWallHi);
      const off = ((by - ay) / 8) % 2 ? 6 : 0;
      for (let bx = ax + 4 + off; bx < ax + aw - 4; bx += 12) px(ctx, bx, by, 1, 7, P.annexShadow);
    }
  }

  function drawAnnex(ctx, annex, ax, ay, aw, ah, t, view) {
    drawAnnexShell(ctx, ax, ay, aw, ah);

    // hanging sign
    const title = trunc(ctx, annex.slug || annex.projectId, aw - 24);
    ctx.font = 'bold 10px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    const sw = ctx.measureText(title).width + 14;
    const sx = ax + ((aw - sw) >> 1);
    px(ctx, sx + (sw >> 1) - 1, ay + 8, 2, 4, P.annexShadow);
    px(ctx, sx, ay + 12, sw, 14, P.annexSign);
    px(ctx, sx + 1, ay + 26, sw - 2, 1, P.annexShadow);
    ctx.fillStyle = P.bgTop;
    ctx.textBaseline = 'top';
    ctx.fillText(title, sx + 7, ay + 15);
    ctx.font = '9px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    // §7: while a build runner is live inside this repo, say so on the sign.
    const stageText = annex.building
      ? (annex.buildPhase ? 'building · ' + annex.buildPhase : 'building…')
      : annex.stage;
    ctx.fillStyle = annex.building ? P.working : P.textDim;
    ctx.fillText(trunc(ctx, stageText, aw - 16), ax + 8, ay + 30);

    const rects = [];
    const n = annex.team.length;
    const pad = 7;
    const slotW = Math.floor((aw - pad * 2) / n);
    const slotTop = ay + 44;
    const slotH = ah - 52;

    for (let i = 0; i < n; i++) {
      const m = annex.team[i];
      const sxi = ax + pad + i * slotW;
      const w = slotW - 3;
      const selected = view.selectedId === 'team:' + annex.projectId + ':' + m.name;
      const working = m.status === 'working';
      const blocked = m.status === 'blocked';

      px(ctx, sxi, slotTop, w, slotH, P.annexShadow);
      const fx = sxi + 1, fy = slotTop + 13, fw = w - 2, fh = slotH - 15;
      drawFloor(ctx, fx, fy, fw, fh,
        working ? P.roomFloorWork : P.annexFloor,
        working ? P.roomFloorWorkAlt : P.annexFloorAlt);

      px(ctx, sxi, slotTop, w, 12, P.roomLabelBg);
      px(ctx, sxi, slotTop, w, 2, root.AY.modelColor(m.model));
      px(ctx, sxi + w - 9, slotTop + 3, 6, 6, root.AY.statusColor(m.status));
      ctx.font = '8px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
      ctx.fillStyle = P.text;
      ctx.textBaseline = 'top';
      ctx.fillText(trunc(ctx, m.name, w - 12), sxi + 3, slotTop + 3);

      const deskX = sxi + (w >> 1) - 22;
      const deskY = slotTop + slotH - 30;
      const seatX = deskX + 22;
      const seatFeetY = deskY + 18;
      const lk = look(annex.projectId + '|' + m.name);

      drawDesk(ctx, deskX, deskY, working, t);
      if (working) {
        drawChair(ctx, seatX, seatFeetY);
        drawShadow(ctx, seatX, seatFeetY, 11);
        drawPerson(ctx, seatX, seatFeetY - 4, { ...lk, pose: 'seated', t });
        drawThought(ctx, seatX + 4, deskY - 14, m.note || '…', t);
      } else if (blocked) {
        const bx = deskX - 8;
        const by = deskY + 20;
        drawShadow(ctx, bx, by, 9);
        drawPerson(ctx, bx, by, { ...lk, pose: 'stand', facing: 1, t });
        drawBang(ctx, bx, by - 28, t);
      } else {
        const path = { x: fx + 10, y: fy + 12, w: fw - 20, h: fh - 26 };
        const st = wanderState(lk, t);
        const p = perimeter(path, st.d);
        drawShadow(ctx, p.x, p.y, 8);
        drawPerson(ctx, p.x, p.y, { ...lk, pose: 'walk', frame: st.frame, facing: p.facing, t });
      }

      ctx.font = '8px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
      ctx.fillStyle = P.textFaint;
      ctx.fillText(m.model, sxi + 3, slotTop + slotH - 9);

      if (selected) {
        ctx.strokeStyle = P.accentTeal;
        ctx.lineWidth = 2;
        ctx.strokeRect(sxi - 1, slotTop - 1, w + 2, slotH + 2);
      }

      rects.push({
        kind: 'agent',
        id: 'team:' + annex.projectId + ':' + m.name,
        x: sxi, y: slotTop, w, h: slotH,
        data: { ...m, annex: annex.slug, projectId: annex.projectId },
      });
    }
    return rects;
  }

  // ---- ambient overlay ---------------------------------------------
  function ambient(ctx, w, h, t) {
    // slow day tint, cool <-> warm
    const warm = Math.sin(t / 45000);
    alpha(ctx, 0.05 + 0.025 * warm, () =>
      px(ctx, 0, 0, w, h, warm > 0 ? '#ffd9a0' : '#8fb4ff'));
    // vignette: layered translucent edges (kept pixel-friendly, no gradients)
    for (let i = 0; i < 7; i++) {
      alpha(ctx, 0.05, () => {
        px(ctx, 0, i * 3, w, 3, '#000');
        px(ctx, 0, h - i * 3 - 3, w, 3, '#000');
        px(ctx, i * 3, 0, 3, h, '#000');
        px(ctx, w - i * 3 - 3, 0, 3, h, '#000');
      });
    }
  }

  function render(ctx, office, t, view) {
    const L = layout(office);
    const OFFICE_TOP = L.deptTop;
    ctx.imageSmoothingEnabled = false;

    px(ctx, 0, 0, W, L.height, P.bgFloor);
    px(ctx, 0, LIVE_TOP - 6, W, L.height - LIVE_TOP + 6, P.hallFloor);
    // hallway tiling behind the rooms
    for (let y = LIVE_TOP; y < L.height; y += 12) {
      for (let x = 0; x < W; x += 12) {
        if (((x / 12) + (y / 12)) % 2 === 0) px(ctx, x, y, 11, 11, P.hallTile);
      }
    }

    const pillHit = drawHeader(ctx, office);
    drawBoard(ctx, office);

    const hits = [];

    // --- live activity strip ---
    const rooms = office.liveRooms || [];
    if (rooms.length) {
      ctx.textBaseline = 'top';
      ctx.font = 'bold 10px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
      ctx.fillStyle = P.accentTeal;
      ctx.fillText('LIVE ACTIVITY', MARGIN, L.live.labelY);
      px(ctx, MARGIN + 104, L.live.labelY + 5, W - MARGIN * 2 - 104, 1, '#265');
      rooms.forEach((room, i) => {
        const col = i % COLS;
        const rowN = Math.floor(i / COLS);
        const rx = MARGIN + col * (CELL_W + GAP);
        const ry = L.live.top + rowN * (LIVE_CELL_H + GAP);
        drawLiveRoom(ctx, room, rx, ry, CELL_W, LIVE_CELL_H, t, view).forEach((r) => hits.push(r));
      });
    }

    office.departments.forEach((agent, i) => {
      const col = i % COLS;
      const rowN = Math.floor(i / COLS);
      const rx = MARGIN + col * (CELL_W + GAP);
      const ry = OFFICE_TOP + rowN * (CELL_H + GAP);
      hits.push(drawRoom(ctx, agent, rx, ry, t, view));
    });

    ctx.textBaseline = 'top';
    ctx.font = 'bold 10px ui-monospace, Consolas, "DejaVu Sans Mono", monospace';
    ctx.fillStyle = P.annexSign;
    ctx.fillText('PROJECT ANNEXES', MARGIN, L.annexLabelY);
    px(ctx, MARGIN + 116, L.annexLabelY + 5, W - MARGIN * 2 - 116, 1, '#4a3f30');

    office.annexes.forEach((annex, i) => {
      const col = i % L.annexCols;
      const rowN = Math.floor(i / L.annexCols);
      const ax = MARGIN + col * (L.annexCellW + GAP);
      const ay = L.annexTop + rowN * (L.annexCellH + GAP);
      drawAnnex(ctx, annex, ax, ay, L.annexCellW, L.annexCellH, t, view).forEach((r) => hits.push(r));
    });

    ambient(ctx, W, L.height, t);
    if (pillHit) hits.push(pillHit);
    return { hits, width: W, height: L.height };
  }

  root.AY = root.AY || {};
  root.AY.render = { render, layout, WIDTH: W };
})(window);
