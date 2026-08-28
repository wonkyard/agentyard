// Generates media/icon.png — a 128x128 pixel-art extension icon, drawn from a
// 32x32 logical grid scaled 4x. Pure Node: a tiny PNG encoder, no dependencies,
// no canvas. Re-run with `npm run icon`.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'media', 'icon.png');

const GRID = 32;
const SCALE = 4;
const SIZE = GRID * SCALE;

// --- palette (matches webview/js/palette.js in spirit) ---
const C = {
  bg: [13, 15, 22, 255],
  panel: [27, 32, 48, 255],
  wall: [44, 51, 72, 255],
  wallHi: [58, 68, 96, 255],
  roof: [46, 196, 182, 255],
  roofHi: [120, 226, 214, 255],
  winWarm: [255, 209, 102, 255],
  winTeal: [87, 199, 184, 255],
  winOff: [14, 21, 32, 255],
  door: [138, 98, 61, 255],
  brass: [202, 161, 90, 255],
  person: [232, 230, 223, 255],
  ground: [30, 33, 48, 255],
  shadow: [22, 26, 40, 255],
};

const grid = Array.from({ length: GRID }, () => Array(GRID).fill(C.bg));
const put = (x, y, c) => {
  if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y][x] = c;
};
const rect = (x, y, w, h, c) => {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c);
};

// inner panel with a 1px inset frame
rect(1, 1, 30, 30, C.panel);
rect(2, 2, 28, 2, C.wallHi);

// stepped teal roof, sitting on a wide eave
for (let i = 0; i < 3; i++) rect(9 - i, 4 + i, 14 + i * 2, 1, i === 0 ? C.roofHi : C.roof);
rect(4, 7, 24, 2, C.roof);
rect(4, 7, 24, 1, C.roofHi);

// building body
rect(6, 9, 20, 20, C.wall);
rect(6, 9, 20, 1, C.wallHi);
rect(6, 9, 1, 20, C.shadow);
rect(25, 9, 1, 20, C.shadow);

// windows: 3 x 3, one teal, one dark, rest warm
const winColors = [
  [C.winWarm, C.winTeal, C.winWarm],
  [C.winWarm, C.winWarm, C.winOff],
  [C.winWarm, C.winOff, C.winWarm],
];
for (let r = 0; r < 3; r++) {
  for (let col = 0; col < 3; col++) {
    const x = 8 + col * 6;
    const y = 11 + r * 5;
    rect(x, y, 4, 4, winColors[r][col]);
    rect(x, y, 4, 1, C.shadow);
    // a tiny silhouette in two of the lit windows
    if ((r === 0 && col === 0) || (r === 1 && col === 1)) rect(x + 1, y + 1, 2, 3, C.wall);
  }
}

// door + step
rect(13, 24, 6, 5, C.door);
rect(13, 24, 6, 1, C.shadow);
put(17, 26, C.brass);
rect(12, 29, 8, 1, C.ground);

// little figure walking up to the door
rect(11, 26, 2, 3, C.person);
put(11, 29, C.shadow);
put(12, 29, C.shadow);

// ground line
rect(2, 30, 28, 1, C.roof);

// --- scale up ---
const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const c = grid[(y / SCALE) | 0][(x / SCALE) | 0];
    const o = (y * SIZE + x) * 4;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3];
  }
}

// --- minimal PNG encoder (RGBA, 8-bit, filter 0) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // colour type RGBA
ihdr[10] = 0;  // compression
ihdr[11] = 0;  // filter
ihdr[12] = 0;  // interlace

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter type 0
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log('wrote media/icon.png  (' + SIZE + 'x' + SIZE + ', ' + png.length + ' bytes)');
