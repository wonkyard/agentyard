// Procedural pixel sprites. Every mark is an axis-aligned fillRect on integer
// coordinates so it stays crisp under image-rendering: pixelated. No art assets.
// Poses are visually distinct on purpose: walk (idle wander), seated (working),
// stand (blocked).
(function (root) {
  const P = root.AY.palette;

  function px(ctx, x, y, w, h, c) {
    ctx.fillStyle = c;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }

  function alpha(ctx, a, fn) {
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = a;
    fn();
    ctx.globalAlpha = prev == null ? 1 : prev;
  }

  // Checkerboard floor. TILE is the one tile size used everywhere.
  const TILE = 12;
  function drawFloor(ctx, x, y, w, h, base, alt) {
    px(ctx, x, y, w, h, base);
    for (let ty = 0; ty < h; ty += TILE) {
      for (let tx = 0; tx < w; tx += TILE) {
        const odd = (((tx / TILE) | 0) + ((ty / TILE) | 0)) % 2;
        if (odd) px(ctx, x + tx, y + ty, Math.min(TILE - 1, w - tx), Math.min(TILE - 1, h - ty), alt);
      }
    }
  }

  function drawRug(ctx, cx, cy, w, h) {
    px(ctx, cx - (w >> 1), cy - (h >> 1), w, h, P.rug1);
    px(ctx, cx - (w >> 1) + 2, cy - (h >> 1) + 2, w - 4, h - 4, P.rug2);
    px(ctx, cx - (w >> 1) + 4, cy - (h >> 1) + 4, w - 8, h - 8, P.rug1);
  }

  // A door set into the bottom wall, (x,y) = its centre on the wall line.
  function drawDoor(ctx, x, y) {
    px(ctx, x - 7, y - 2, 14, 4, P.roomShadow);
    px(ctx, x - 6, y - 15, 12, 15, P.door);
    px(ctx, x - 5, y - 14, 5, 13, P.doorPanel);
    px(ctx, x + 1, y - 14, 5, 13, P.doorPanel);
    px(ctx, x - 1, y - 8, 2, 2, P.brass);
  }

  function drawPlant(ctx, x, y, sway) {
    px(ctx, x - 3, y - 5, 7, 5, P.pot);
    px(ctx, x - 4, y - 6, 9, 2, P.potRim);
    px(ctx, x, y - 10, 1, 5, P.stem);
    px(ctx, x - 4 + sway, y - 13, 4, 5, P.leaf);
    px(ctx, x + 1 + sway, y - 15, 4, 6, P.leafHi);
    px(ctx, x - 2 - sway, y - 17, 3, 5, P.leaf);
    px(ctx, x + 2, y - 11, 3, 4, P.leafHi);
  }

  // A wall window. Sky colour drifts with the day tint so rooms never look dead.
  function drawWindow(ctx, x, y, w, h, t) {
    const day = 0.5 + 0.5 * Math.sin(t / 45000);
    const sky = day > 0.55 ? '#3a4a6a' : day < 0.45 ? '#2a3350' : '#33405f';
    px(ctx, x - 1, y - 1, w + 2, h + 2, P.roomShadow);
    px(ctx, x, y, w, h, sky);
    alpha(ctx, 0.25 + 0.15 * Math.sin(t / 4000 + x), () =>
      px(ctx, x + 2, y + 1, Math.max(2, w - 6), 2, '#cfe0ff'));
    px(ctx, x + (w >> 1), y, 1, h, P.roomShadow);
    px(ctx, x, y + (h >> 1), w, 1, P.roomShadow);
  }

  function drawShelf(ctx, x, y) {
    px(ctx, x, y, 24, 3, P.deskTop);
    px(ctx, x, y + 10, 24, 3, P.deskTop);
    px(ctx, x, y, 2, 13, P.deskLeg);
    px(ctx, x + 22, y, 2, 13, P.deskLeg);
    const books = [P.red, P.accentTeal, P.yellow, P.blue, P.green, P.purple];
    for (let i = 0; i < 6; i++) px(ctx, x + 3 + i * 3, y - 6 + (i % 2), 2, 6 - (i % 2), books[i]);
    for (let i = 0; i < 5; i++) px(ctx, x + 3 + i * 4, y + 4, 3, 6, books[(i + 3) % 6]);
  }

  // Desk + monitor. (x,y) = top-left of the desktop surface. Footprint ~ 44 x 20.
  function drawDesk(ctx, x, y, on, t) {
    // monitor (behind the desk edge)
    px(ctx, x + 25, y - 12, 17, 14, P.monitorCase);
    px(ctx, x + 26, y - 11, 15, 11, on ? P.monitorOn : P.monitor);
    if (on) {
      const f = Math.floor(t / 90) % 3;
      px(ctx, x + 28, y - 9, 10 - f, 1, P.monitorTextHi);
      px(ctx, x + 28, y - 7, 7 + f, 1, P.monitorText);
      px(ctx, x + 28, y - 5, 9, 1, P.monitorText);
      px(ctx, x + 28, y - 3, 5, 1, P.monitorText);
      alpha(ctx, 0.10 + 0.05 * Math.sin(t / 260), () =>
        px(ctx, x + 20, y - 17, 27, 22, P.monitorOn));
    }
    px(ctx, x + 32, y + 2, 4, 3, P.monitorCase);
    // desktop + legs
    px(ctx, x, y + 6, 44, 3, P.deskTop);
    px(ctx, x, y + 9, 44, 4, P.desk);
    px(ctx, x + 2, y + 13, 3, 8, P.deskLeg);
    px(ctx, x + 39, y + 13, 3, 8, P.deskLeg);
    // keyboard + mouse
    px(ctx, x + 6, y + 6, 15, 3, P.keyboard);
    px(ctx, x + 23, y + 7, 3, 2, P.keyboard);
  }

  function drawChair(ctx, x, y) {
    px(ctx, x - 5, y - 15, 3, 13, P.chair);
    px(ctx, x - 6, y - 3, 12, 3, P.chair);
    px(ctx, x - 1, y, 2, 4, P.chairLeg);
  }

  // A person. (x,y) = feet anchor (bottom centre). ~8 wide, ~26 tall standing.
  //   pose: 'walk' | 'stand' | 'seated'
  //   facing: -1 left, 1 right, 0 toward viewer
  //   frame: 0..2 walk cycle
  function drawPerson(ctx, x, y, o) {
    const sh = o.shirt, sk = o.skin, ha = o.hair;
    const t = o.t || 0;

    if (o.pose === 'seated') {
      const f = Math.floor(t / 100) % 2;
      px(ctx, x - 5, y - 19, 10, 12, sh);            // torso
      px(ctx, x - 4, y - 27, 8, 8, sk);              // head
      px(ctx, x - 5, y - 29, 10, 4, ha);             // hair
      px(ctx, x - 4, y - 28, 8, 1, ha);
      px(ctx, x - 2, y - 22, 1, 2, P.eye);
      px(ctx, x + 1, y - 22, 1, 2, P.eye);
      px(ctx, x - 8, y - 14 + f, 4, 3, sk);          // hands typing, alternating
      px(ctx, x + 4, y - 14 + (1 - f), 4, 3, sk);
      return;
    }

    const walk = o.pose === 'walk';
    const fr = walk ? (o.frame | 0) % 3 : 0;
    const lift = fr === 1 ? 1 : fr === 2 ? -1 : 0;
    const bob = walk ? (fr === 0 ? 0 : -1)
      : Math.round(Math.sin(t / 460 + (o.phase || 0)) * 0.5);
    const yy = y + bob;
    const fc = o.facing || 0;

    // legs
    px(ctx, x - 3, yy - 6, 3, 6 + lift, P.pants);
    px(ctx, x + 1, yy - 6, 3, 6 - lift, P.pants);
    px(ctx, x - 4, yy - 1 + lift, 4, 2, P.shoe);
    px(ctx, x + 1, yy - 1 - lift, 4, 2, P.shoe);
    // torso
    px(ctx, x - 4, yy - 16, 9, 10, sh);
    // arms
    const swing = walk ? lift : 0;
    px(ctx, x - 6, yy - 15 + swing, 3, 7, sk);
    px(ctx, x + 4, yy - 15 - swing, 3, 7, sk);
    // head + hair
    px(ctx, x - 4, yy - 25, 8, 9, sk);
    px(ctx, x - 5, yy - 27, 10, 4, ha);
    px(ctx, x - 4, yy - 26, 8, 1, ha);
    px(ctx, x - 5, yy - 24, 1, 5, ha);
    px(ctx, x + 4, yy - 24, 1, 5, ha);
    // eyes follow facing
    if (fc < 0) {
      px(ctx, x - 3, yy - 20, 1, 2, P.eye);
    } else if (fc > 0) {
      px(ctx, x + 2, yy - 20, 1, 2, P.eye);
    } else {
      px(ctx, x - 2, yy - 20, 1, 2, P.eye);
      px(ctx, x + 1, yy - 20, 1, 2, P.eye);
    }
  }

  // Soft contact shadow under a sprite.
  function drawShadow(ctx, x, y, w) {
    alpha(ctx, 0.22, () => px(ctx, x - (w >> 1), y - 1, w, 3, '#000'));
  }

  // Thought bubble carrying the agent's note, wrapped to <= 2 lines.
  function drawThought(ctx, cx, baseY, text, t) {
    ctx.font = '7px "Courier New", monospace';
    ctx.textBaseline = 'top';
    const maxW = 96;
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = w;
        if (lines.length === 2) break;
      } else {
        cur = test;
      }
    }
    if (lines.length < 2 && cur) lines.push(cur);
    if (!lines.length) lines.push('…');
    const truncated = words.length && (lines.join(' ').split(/\s+/).length < words.length);
    if (truncated) {
      let last = lines[lines.length - 1];
      while (last.length && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      lines[lines.length - 1] = last + '…';
    }
    const bw = Math.max(16, ...lines.map((l) => ctx.measureText(l).width)) + 10;
    const bh = lines.length * 8 + 7;
    const bx = Math.round(cx - bw / 2);
    const by = Math.round(baseY - bh);
    px(ctx, bx, by, bw, bh, P.bubble);
    px(ctx, bx + 2, by - 1, bw - 4, 1, P.bubble);
    px(ctx, bx + 2, by + bh, bw - 4, 1, P.bubble);
    px(ctx, bx - 1, by + 2, 1, bh - 4, P.bubble);
    px(ctx, bx + bw, by + 2, 1, bh - 4, P.bubble);
    // tail
    px(ctx, cx - 1, by + bh, 3, 3, P.bubble);
    px(ctx, cx - 2, by + bh + 3, 2, 2, P.bubble);
    ctx.fillStyle = P.bubbleText;
    lines.forEach((l, i) => ctx.fillText(l, bx + 5, by + 4 + i * 8));
    // animated typing dots in the corner
    const n = Math.floor(t / 240) % 3;
    for (let i = 0; i < 3; i++) {
      px(ctx, bx + bw - 12 + i * 3, by + bh - 4, 2, 2, i <= n ? P.accentTeal : P.bubbleDim);
    }
  }

  // Bouncing red "!" for a blocked agent.
  function drawBang(ctx, cx, baseY, t) {
    const b = Math.round(Math.abs(Math.sin(t / 170)) * 4);
    const y = baseY - b;
    px(ctx, cx - 2, y - 13, 4, 9, P.blocked);
    px(ctx, cx - 2, y - 2, 4, 3, P.blocked);
    alpha(ctx, 0.2 + 0.2 * Math.abs(Math.sin(t / 170)), () => {
      px(ctx, cx - 5, y - 15, 10, 2, P.blocked);
      px(ctx, cx - 6, y - 8, 2, 6, P.blocked);
      px(ctx, cx + 4, y - 8, 2, 6, P.blocked);
    });
  }

  root.AY = root.AY || {};
  root.AY.sprites = {
    TILE, px, alpha,
    drawFloor, drawRug, drawDoor, drawWindow, drawPlant, drawShelf, drawDesk, drawChair,
    drawPerson, drawShadow, drawThought, drawBang,
  };
})(window);
