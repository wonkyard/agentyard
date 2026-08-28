// Procedural pixel sprites. Everything is axis-aligned fillRect on integer
// coordinates so it stays crisp under image-rendering: pixelated. No spritesheets
// in v0.1 — but idle / working / blocked are visually distinct on purpose.
(function (root) {
  const P = root.PO.palette;

  function px(ctx, x, y, w, h, c) {
    ctx.fillStyle = c;
    ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
  }

  // desk footprint ~ 46 x 26, (x,y) = top-left
  function drawDesk(ctx, x, y, on) {
    px(ctx, x, y + 14, 46, 12, P.desk);
    px(ctx, x, y + 12, 46, 3, P.deskTop);
    px(ctx, x + 2, y + 25, 3, 6, '#5a3c22');
    px(ctx, x + 41, y + 25, 3, 6, '#5a3c22');
    // monitor
    px(ctx, x + 27, y, 15, 12, '#20242f');
    px(ctx, x + 28, y + 1, 13, 9, on ? P.monitorOn : P.monitor);
    if (on) {
      px(ctx, x + 30, y + 3, 8, 1, '#bfefe8');
      px(ctx, x + 30, y + 5, 6, 1, '#bfefe8');
      px(ctx, x + 30, y + 7, 9, 1, '#bfefe8');
    }
    px(ctx, x + 33, y + 12, 3, 2, '#20242f');
    // keyboard
    px(ctx, x + 8, y + 14, 14, 4, '#1b1e27');
  }

  function drawChair(ctx, x, y) {
    px(ctx, x - 4, y - 12, 3, 14, '#20242f');
    px(ctx, x - 4, y - 2, 12, 3, '#20242f');
  }

  // (x,y) = feet anchor (bottom-centre). ~14 wide, ~22 tall standing.
  function drawPerson(ctx, x, y, opts) {
    const shirt = opts.shirt;
    const skin = opts.skin;
    const hair = opts.hair;
    const t = opts.t || 0;
    const phase = opts.phase || 0;

    if (opts.pose === 'seated') {
      const f = Math.floor(t / 120) % 2;
      // body behind desk
      px(ctx, x - 5, y - 20, 10, 10, shirt); // torso
      px(ctx, x - 4, y - 28, 8, 8, skin); // head
      px(ctx, x - 5, y - 30, 10, 4, hair); // hair
      px(ctx, x - 4, y - 29, 8, 1, hair);
      // arms reaching to keyboard, alternating
      px(ctx, x - 8, y - 16 + f, 4, 3, skin);
      px(ctx, x + 4, y - 16 + (1 - f), 4, 3, skin);
      return;
    }

    const bob = opts.pose === 'blocked' ? 0 : Math.round(Math.sin(t / 380 + phase));
    const yy = y - bob;
    // legs
    px(ctx, x - 4, yy - 6, 3, 6, '#2f3346');
    px(ctx, x + 1, yy - 6, 3, 6, '#2f3346');
    // shoes
    px(ctx, x - 5, yy - 1, 4, 2, '#15171f');
    px(ctx, x + 1, yy - 1, 4, 2, '#15171f');
    // torso
    px(ctx, x - 5, yy - 16, 10, 10, shirt);
    // arms
    const swing = opts.pose === 'blocked' ? 0 : Math.round(Math.sin(t / 380 + phase + 1) * 1);
    px(ctx, x - 7, yy - 15 + swing, 3, 8, skin);
    px(ctx, x + 4, yy - 15 - swing, 3, 8, skin);
    // head
    px(ctx, x - 4, yy - 25, 8, 9, skin);
    // hair
    px(ctx, x - 5, yy - 27, 10, 4, hair);
    px(ctx, x - 4, yy - 26, 8, 1, hair);
    // eyes
    px(ctx, x - 2, yy - 20, 1, 2, '#15171f');
    px(ctx, x + 2, yy - 20, 1, 2, '#15171f');
  }

  function drawWorkBubble(ctx, x, y, t) {
    // rounded-ish speech bubble with animated dots
    px(ctx, x - 10, y - 12, 20, 10, '#f4f1e6');
    px(ctx, x - 9, y - 13, 18, 12, '#f4f1e6');
    px(ctx, x - 3, y - 2, 3, 3, '#f4f1e6');
    const n = Math.floor(t / 260) % 3;
    for (let i = 0; i < 3; i++) {
      px(ctx, x - 6 + i * 5, y - 9, 3, 3, i <= n ? '#2b3145' : '#c9c6ba');
    }
  }

  function drawBlockedMark(ctx, x, y, t) {
    const b = Math.round(Math.abs(Math.sin(t / 220)) * 3);
    px(ctx, x - 2, y - 16 - b, 4, 9, P.blocked);
    px(ctx, x - 2, y - 5 - b, 4, 3, P.blocked);
  }

  root.PO = root.PO || {};
  root.PO.sprites = { px, drawDesk, drawChair, drawPerson, drawWorkBubble, drawBlockedMark };
})(window);
