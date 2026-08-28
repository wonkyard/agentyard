// Scene layout + drawing. Pure function of (office model, time, view state) ->
// paints the canvas and returns the clickable hit-rects for this frame.
(function (root) {
  const P = root.PO.palette;
  const S = root.PO.sprites;
  const { px, drawDesk, drawChair, drawPerson, drawWorkBubble, drawBlockedMark } = S;

  const W = 900;
  const MARGIN = 16;
  const HEADER_H = 44;
  const BOARD_H = 70;
  const OFFICE_TOP = HEADER_H + BOARD_H + 10;
  const COLS = 4;
  const GAP = 12;
  const CELL_W = Math.floor((W - MARGIN * 2 - GAP * (COLS - 1)) / COLS);
  const CELL_H = 130;

  function layout(office) {
    const nDept = office.departments.length;
    const rows = Math.max(1, Math.ceil(nDept / COLS));
    const officeBottom = OFFICE_TOP + rows * CELL_H + (rows - 1) * GAP;
    const annexLabelY = officeBottom + 12;
    const annexTop = annexLabelY + 20;
    const nAnnex = Math.max(1, office.annexes.length);
    const annexCols = Math.min(2, nAnnex);
    const annexRows = Math.ceil(nAnnex / annexCols);
    const annexCellW = Math.floor((W - MARGIN * 2 - GAP * (annexCols - 1)) / annexCols);
    const annexCellH = 172;
    const annexBottom = annexTop + annexRows * annexCellH + (annexRows - 1) * GAP;
    return {
      rows,
      officeBottom,
      annexLabelY,
      annexTop,
      annexCols,
      annexCellW,
      annexCellH,
      height: annexBottom + MARGIN,
    };
  }

  function trunc(ctx, str, maxW) {
    str = String(str == null ? '' : str);
    if (ctx.measureText(str).width <= maxW) return str;
    while (str.length > 1 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1);
    return str + '…';
  }

  function personLook(name) {
    return {
      shirt: root.PO.pick(P.shirts, name),
      skin: root.PO.pick(P.skin, name + 's'),
      hair: root.PO.pick(P.hair, name + 'h'),
      phase: (root.PO.hash(name) % 628) / 100,
    };
  }

  function drawHeader(ctx, office, t) {
    px(ctx, 0, 0, W, HEADER_H, P.roomWall);
    px(ctx, 0, HEADER_H - 2, W, 2, P.teal);
    ctx.textBaseline = 'top';
    ctx.font = 'bold 15px "Courier New", monospace';
    ctx.fillStyle = P.text;
    const title = 'WONKYARD  //  PIXEL OFFICE';
    ctx.fillText(title, MARGIN, 8);
    const tw = ctx.measureText(title).width;
    ctx.font = '10px "Courier New", monospace';
    ctx.fillStyle = P.textDim;
    ctx.fillText('v0.1', MARGIN + tw + 10, 13);
    if (office.dataMode === 'demo') {
      const dl = 'DEMO DATA';
      ctx.font = 'bold 9px "Courier New", monospace';
      const dw = ctx.measureText(dl).width + 12;
      px(ctx, MARGIN + tw + 42, 11, dw, 14, P.purple);
      ctx.fillStyle = '#12141c';
      ctx.fillText(dl, MARGIN + tw + 48, 14);
    }

    const c = office.counts;
    const chips = [
      ['working ' + (c.working || 0), P.working],
      ['idle ' + (c.idle || 0), P.idle],
      ['blocked ' + (c.blocked || 0), P.blocked],
    ];
    let x = W - MARGIN;
    ctx.font = '10px "Courier New", monospace';
    for (let i = chips.length - 1; i >= 0; i--) {
      const [label, col] = chips[i];
      const w = ctx.measureText(label).width + 16;
      x -= w;
      px(ctx, x, 12, w, 20, '#20242f');
      px(ctx, x + 5, 19, 6, 6, col);
      ctx.fillStyle = P.text;
      ctx.fillText(label, x + 14, 16);
      x -= 6;
    }
  }

  function stageColor(stage) {
    if (/kill/i.test(stage)) return P.red;
    if (/done|ready|launch/i.test(stage)) return P.green;
    if (/build|engineer/i.test(stage)) return P.blue;
    return P.yellow;
  }

  function drawBoard(ctx, office) {
    const y0 = HEADER_H + 4;
    px(ctx, 0, HEADER_H, W, BOARD_H, P.bgTop);
    ctx.textBaseline = 'top';
    ctx.font = '9px "Courier New", monospace';
    ctx.fillStyle = P.textDim;
    ctx.fillText('COMPANY BOARD', MARGIN, y0 + 2);

    let x = MARGIN;
    let y = y0 + 14;
    let rowsUsed = 1;
    ctx.font = '9px "Courier New", monospace';
    for (const b of office.board) {
      const kind = b.projectId.slice(0, 4);
      const label = kind + ' ' + b.projectId.replace(/^IDEA-|^TOOL-/, '') + '  ' + b.stage;
      const w = ctx.measureText(label).width + 24;
      if (x + w > W - MARGIN && x > MARGIN) {
        if (rowsUsed >= 2) break;
        x = MARGIN;
        y += 22;
        rowsUsed++;
      }
      px(ctx, x, y, w, 18, '#20242f');
      px(ctx, x, y, 3, 18, stageColor(b.stage));
      px(ctx, x + w - 11, y + 6, 6, 6, b.hasRepo ? P.teal : '#3a3f4f');
      ctx.fillStyle = P.text;
      ctx.fillText(label, x + 8, y + 5);
      x += w + 7;
    }
  }

  function drawRoom(ctx, agent, rx, ry, t, view) {
    const working = agent.status === 'working';
    const blocked = agent.status === 'blocked';
    const selected = view.selectedId === 'dept:' + agent.name;

    px(ctx, rx - 2, ry - 2, CELL_W + 4, CELL_H + 4, P.roomWall);
    px(ctx, rx, ry, CELL_W, CELL_H, working ? P.roomFillWork : P.roomFill);
    // floor tiles
    for (let ty = ry + 18; ty < ry + CELL_H - 4; ty += 10) {
      for (let tx = rx + 4; tx < rx + CELL_W - 4; tx += 12) {
        px(ctx, tx, ty, 10, 8, P.floorTile);
      }
    }
    // label bar
    px(ctx, rx, ry, CELL_W, 16, P.roomLabelBg);
    px(ctx, rx, ry, 4, 16, root.PO.modelColor(agent.model));
    ctx.textBaseline = 'top';
    ctx.font = '10px "Courier New", monospace';
    ctx.fillStyle = P.text;
    ctx.fillText(trunc(ctx, agent.name, CELL_W - 34), rx + 8, ry + 3);
    // status pip
    px(ctx, rx + CELL_W - 14, ry + 5, 7, 7, root.PO.statusColor(agent.status));

    // desk + person
    const deskX = rx + Math.floor(CELL_W / 2) - 23;
    const deskY = ry + CELL_H - 46;
    const feetX = deskX + 23;
    const feetY = deskY + 30;
    const look = personLook(agent.name);

    if (working) {
      drawChair(ctx, feetX, feetY - 2);
      drawPerson(ctx, feetX, feetY - 6, { ...look, pose: 'seated', t });
      drawDesk(ctx, deskX, deskY, true);
      drawWorkBubble(ctx, feetX + 20, deskY - 2, t);
    } else if (blocked) {
      drawDesk(ctx, deskX, deskY, false);
      drawPerson(ctx, feetX - 30, feetY, { ...look, pose: 'blocked', t });
      drawBlockedMark(ctx, feetX - 30, feetY - 26, t);
    } else {
      // idle: wander a little near the desk, monitor off
      const wander = Math.round(Math.sin(t / 1600 + look.phase) * 10);
      drawDesk(ctx, deskX, deskY, false);
      drawPerson(ctx, feetX - 28 + wander, feetY, { ...look, pose: 'idle', t });
    }

    // model label (bottom-left, dim)
    ctx.font = '8px "Courier New", monospace';
    ctx.fillStyle = P.textDim;
    ctx.fillText(agent.model, rx + 6, ry + CELL_H - 11);

    if (selected) {
      ctx.strokeStyle = P.teal;
      ctx.lineWidth = 2;
      ctx.strokeRect(rx - 1, ry - 1, CELL_W + 2, CELL_H + 2);
    }

    return { kind: 'agent', id: 'dept:' + agent.name, x: rx, y: ry, w: CELL_W, h: CELL_H, data: agent };
  }

  function drawAnnex(ctx, annex, ax, ay, aw, ah, t, view) {
    px(ctx, ax - 2, ay - 2, aw + 4, ah + 4, P.roomWall);
    px(ctx, ax, ay, aw, ah, '#2c3348');
    // roof / title
    px(ctx, ax, ay, aw, 18, '#1c2130');
    px(ctx, ax, ay, aw, 3, P.purple);
    ctx.textBaseline = 'top';
    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.fillStyle = P.text;
    ctx.fillText(trunc(ctx, annex.slug || annex.projectId, aw - 120), ax + 8, ay + 4);
    ctx.font = '9px "Courier New", monospace';
    ctx.fillStyle = P.textDim;
    ctx.fillText(trunc(ctx, annex.stage, 108), ax + aw - 112, ay + 5);

    const rects = [];
    const n = annex.team.length;
    const pad = 8;
    const slotW = Math.floor((aw - pad * 2) / n);
    const slotTop = ay + 22;
    const slotH = ah - 30;
    for (let i = 0; i < n; i++) {
      const m = annex.team[i];
      const sx = ax + pad + i * slotW;
      const w = slotW - 3;
      const selected = view.selectedId === 'team:' + annex.projectId + ':' + m.name;
      const working = m.status === 'working';

      px(ctx, sx, slotTop, w, slotH, working ? P.roomFillWork : P.roomFill);
      px(ctx, sx, slotTop, w, 3, root.PO.modelColor(m.model));
      // floor tiles
      for (let ty = slotTop + 16; ty < slotTop + slotH - 4; ty += 10) {
        for (let tx = sx + 3; tx < sx + w - 3; tx += 12) px(ctx, tx, ty, 10, 8, P.floorTile);
      }
      // name + status pip
      px(ctx, sx, slotTop + 4, w, 12, P.roomLabelBg);
      px(ctx, sx + w - 10, slotTop + 6, 7, 7, root.PO.statusColor(m.status));
      ctx.font = '7px "Courier New", monospace';
      ctx.fillStyle = P.text;
      ctx.textBaseline = 'top';
      ctx.fillText(trunc(ctx, m.name, w - 14), sx + 3, slotTop + 6);

      const feetX = sx + Math.floor(w / 2);
      const deskY = slotTop + slotH - 40;
      const deskX = feetX - 23;
      const feetY = deskY + 30;
      const look = personLook(annex.projectId + m.name);

      if (working) {
        drawChair(ctx, feetX, feetY - 4);
        drawPerson(ctx, feetX, feetY - 8, { ...look, pose: 'seated', t });
        drawDesk(ctx, deskX, deskY, true);
        drawWorkBubble(ctx, feetX + 16, deskY - 4, t);
      } else if (m.status === 'blocked') {
        drawDesk(ctx, deskX, deskY, false);
        drawPerson(ctx, feetX, feetY, { ...look, pose: 'blocked', t });
        drawBlockedMark(ctx, feetX, feetY - 26, t);
      } else {
        const wander = Math.round(Math.sin(t / 1700 + look.phase) * 4);
        drawDesk(ctx, deskX, deskY, false);
        drawPerson(ctx, feetX + wander, feetY, { ...look, pose: 'idle', t });
      }

      ctx.font = '7px "Courier New", monospace';
      ctx.fillStyle = P.textDim;
      ctx.fillText(m.model, sx + 3, slotTop + slotH - 10);

      if (selected) {
        ctx.strokeStyle = P.teal;
        ctx.lineWidth = 2;
        ctx.strokeRect(sx - 1, slotTop - 1, w + 2, slotH + 2);
      }

      rects.push({
        kind: 'agent',
        id: 'team:' + annex.projectId + ':' + m.name,
        x: sx,
        y: slotTop,
        w,
        h: slotH,
        data: { ...m, annex: annex.slug, projectId: annex.projectId },
      });
    }
    return rects;
  }

  function render(ctx, office, t, view) {
    const L = layout(office);
    ctx.imageSmoothingEnabled = false;

    // background
    px(ctx, 0, 0, W, L.height, P.bgFloor);
    px(ctx, 0, OFFICE_TOP - 6, W, L.height - OFFICE_TOP + 6, P.bgFloor);

    drawHeader(ctx, office, t);
    drawBoard(ctx, office);

    const hits = [];
    office.departments.forEach((agent, i) => {
      const col = i % COLS;
      const rowN = Math.floor(i / COLS);
      const rx = MARGIN + col * (CELL_W + GAP);
      const ry = OFFICE_TOP + rowN * (CELL_H + GAP);
      hits.push(drawRoom(ctx, agent, rx, ry, t, view));
    });

    // annex label
    ctx.textBaseline = 'top';
    ctx.font = 'bold 10px "Courier New", monospace';
    ctx.fillStyle = P.textDim;
    ctx.fillText('PROJECT ANNEXES', MARGIN, L.annexLabelY);
    px(ctx, MARGIN + 118, L.annexLabelY + 4, W - MARGIN * 2 - 118, 1, '#3a3f4f');

    office.annexes.forEach((annex, i) => {
      const col = i % L.annexCols;
      const rowN = Math.floor(i / L.annexCols);
      const ax = MARGIN + col * (L.annexCellW + GAP);
      const ay = L.annexTop + rowN * (L.annexCellH + GAP);
      drawAnnex(ctx, annex, ax, ay, L.annexCellW, L.annexCellH, t, view).forEach((r) => hits.push(r));
    });

    return { hits, width: W, height: L.height };
  }

  root.PO = root.PO || {};
  root.PO.render = { render, layout, WIDTH: W };
})(window);
