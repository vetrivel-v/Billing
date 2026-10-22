/**
 * Draws the CommerceBill application icon (a "CB" monogram) and writes apps/desktop/build/icon.ico, with PNG-compressed 256, 64, 48, 32
 * and 16 pixel images. Pure Node (no image library): the output is deterministic, so the icon in Git can be regenerated and compared.
 *
 *   npx tsx scripts/make-icon.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const BG: [number, number, number] = [15, 111, 143]; // brand teal
const FG: [number, number, number] = [255, 255, 255];

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(
  size: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage (0..1) of the monogram at a point in a unit square, plus whether the point is inside the rounded background. */
function shape(u: number, v: number): { bg: boolean; fg: boolean } {
  // rounded square background
  const r = 0.2;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  const bg = dx * dx + dy * dy <= r * r;
  // "C": a ring with an opening to the right, centred at (0.35, 0.5)
  const cx = 0.32;
  const cy = 0.5;
  const rr = Math.hypot(u - cx, v - cy);
  const ang = Math.atan2(v - cy, u - cx);
  const inC = rr >= 0.17 && rr <= 0.27 && Math.abs(ang) > 0.65;
  // "B": a vertical bar and two bowls, to the right
  const bx0 = 0.53;
  const bar = u >= bx0 && u <= bx0 + 0.07 && v >= 0.25 && v <= 0.75;
  const bowl = (cyb: number, r1: number, r2: number) => {
    const d = Math.hypot(u - (bx0 + 0.07), v - cyb);
    return u >= bx0 + 0.07 && d >= r1 && d <= r2;
  };
  const inB =
    bar ||
    bowl(0.375, 0.05, 0.115) ||
    bowl(0.625, 0.05, 0.115) ||
    (u >= bx0 &&
      u <= bx0 + 0.13 &&
      ((v >= 0.25 && v <= 0.29) || (v >= 0.48 && v <= 0.52) || (v >= 0.71 && v <= 0.75)));
  return { bg, fg: bg && (inC || inB) };
}

function pixelFor(size: number) {
  const S = 3; // 3 x 3 samples per pixel
  return (x: number, y: number): [number, number, number, number] => {
    let bg = 0;
    let fg = 0;
    for (let i = 0; i < S; i++)
      for (let j = 0; j < S; j++) {
        const s = shape((x + (i + 0.5) / S) / size, (y + (j + 0.5) / S) / size);
        if (s.bg) bg++;
        if (s.fg) fg++;
      }
    const n = S * S;
    if (bg === 0) return [0, 0, 0, 0];
    const f = fg / bg;
    return [
      Math.round(BG[0] * (1 - f) + FG[0] * f),
      Math.round(BG[1] * (1 - f) + FG[1] * f),
      Math.round(BG[2] * (1 - f) + FG[2] * f),
      Math.round((bg / n) * 255),
    ];
  };
}

const sizes = [256, 64, 48, 32, 16];
const images = sizes.map((s) => png(s, pixelFor(s)));
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = Buffer.concat(
  sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s === 256 ? 0 : s;
    e[1] = s === 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i]!.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i]!.length;
    return e;
  }),
);
const out = resolve(import.meta.dirname, '..', 'apps', 'desktop', 'build');
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'icon.ico'), Buffer.concat([head, dir, ...images]));
writeFileSync(resolve(out, 'icon.png'), images[0]!);
process.stdout.write(`wrote ${resolve(out, 'icon.ico')}\n`);
