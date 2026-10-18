// Generates a 1024x1024 PNG app icon (blue rounded square with kanban columns),
// then lets `tauri icon` derive the .ico/.icns and other sizes.
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const SIZE = 1024;

// simple CRC32 (zlib.crc32 is available in Node >=20.15)
const crc32 = zlib.crc32;

function px(x, y) {
  // background: rounded square, blue gradient
  const r = SIZE * 0.22; // corner radius
  const inside = x >= r && x <= SIZE - r || y >= r && y <= SIZE - r;
  const withinCorner =
    x < r && y < r ? (x - r) ** 2 + (y - r) ** 2 <= r * r :
    x > SIZE - r && y < r ? (x - (SIZE - r)) ** 2 + (y - r) ** 2 <= r * r :
    x < r && y > SIZE - r ? (x - r) ** 2 + (y - (SIZE - r)) ** 2 <= r * r :
    x > SIZE - r && y > SIZE - r ? (x - (SIZE - r)) ** 2 + (y - (SIZE - r)) ** 2 <= r * r :
    true;
  const inShape = (inside || withinCorner) &&
    !(x < r && y < r && !withinCorner) &&
    !(x > SIZE - r && y < r && !withinCorner) &&
    !(x < r && y > SIZE - r && !withinCorner) &&
    !(x > SIZE - r && y > SIZE - r && !withinCorner);

  if (!inShape) return [0, 0, 0, 0];

  // vertical gradient blue
  const t = y / SIZE;
  let R = Math.round(0 + t * 20);
  let G = Math.round(120 - t * 40);
  let B = Math.round(200 - t * 20);

  // three white "column" rounded bars (kanban)
  const bars = [
    { x0: 0.24, x1: 0.40, y0: 0.26, y1: 0.60 },
    { x0: 0.45, x1: 0.61, y0: 0.26, y1: 0.74 },
    { x0: 0.66, x1: 0.82, y0: 0.26, y1: 0.50 },
  ];
  for (const b of bars) {
    const bx0 = b.x0 * SIZE, bx1 = b.x1 * SIZE, by0 = b.y0 * SIZE, by1 = b.y1 * SIZE;
    const br = (bx1 - bx0) * 0.28;
    if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) {
      const nearCorner =
        (x < bx0 + br && y < by0 + br && (x - (bx0 + br)) ** 2 + (y - (by0 + br)) ** 2 > br * br) ||
        (x > bx1 - br && y < by0 + br && (x - (bx1 - br)) ** 2 + (y - (by0 + br)) ** 2 > br * br) ||
        (x < bx0 + br && y > by1 - br && (x - (bx0 + br)) ** 2 + (y - (by1 - br)) ** 2 > br * br) ||
        (x > bx1 - br && y > by1 - br && (x - (bx1 - br)) ** 2 + (y - (by1 - br)) ** 2 > br * br);
      if (!nearCorner) {
        R = 255; G = 255; B = 255;
      }
    }
  }
  return [R, G, B, 255];
}

// build raw RGBA scanlines with filter byte 0
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = px(x, y);
    const o = rowStart + 1 + x * 4;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
}

const idat = zlib.deflateSync(raw, { level: 9 });

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data])) >>> 0;
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);

const outDir = path.resolve(process.argv[2] || "app-icon");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "icon.png");
fs.writeFileSync(outPath, png);
console.log("Wrote", outPath, png.length, "bytes");
