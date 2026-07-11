import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size) {
  const data = Buffer.alloc((size * 4 + 1) * size);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = y * (size * 4 + 1) + 1 + x * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  };
  const inRoundRect = (x, y, x0, y0, x1, y1, rad) => {
    if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
    const lx = x - x0;
    const ly = y - y0;
    const w = x1 - x0;
    const h = y1 - y0;
    if (lx >= rad && lx < w - rad) return true;
    if (ly >= rad && ly < h - rad) return true;
    const cx = lx < rad ? rad : w - rad - 1;
    const cy = ly < rad ? rad : h - rad - 1;
    const dx = lx - cx;
    const dy = ly - cy;
    return dx * dx + dy * dy <= rad * rad;
  };
  const stroke = (pts, r, g, b, w) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1) * 3;
      for (let t = 0; t <= steps; t++) {
        const x = x0 + ((x1 - x0) * t) / steps;
        const y = y0 + ((y1 - y0) * t) / steps;
        for (let dy = -w; dy <= w; dy++) {
          for (let dx = -w; dx <= w; dx++) {
            if (dx * dx + dy * dy <= w * w) set(Math.round(x + dx), Math.round(y + dy), r, g, b);
          }
        }
      }
    }
  };

  const s = size;
  const pad = Math.round(s * 0.06);
  const rad = Math.round(s * 0.22);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (inRoundRect(x, y, pad, pad, s - pad, s - pad, rad)) set(x, y, 0x17, 0x21, 0x1b);
    }
  }
  const tx0 = Math.round(s * 0.18);
  const ty0 = Math.round(s * 0.28);
  const tx1 = Math.round(s * 0.82);
  const ty1 = Math.round(s * 0.72);
  const trad = Math.round(s * 0.06);
  for (let y = ty0; y < ty1; y++) {
    for (let x = tx0; x < tx1; x++) {
      if (inRoundRect(x, y, tx0, ty0, tx1, ty1, trad)) set(x, y, 0xf2, 0xea, 0xdb);
    }
  }
  const cx = Math.round(s * 0.34);
  const cy = Math.round(s * 0.5);
  const arm = Math.round(s * 0.11);
  const sw = Math.max(2, Math.round(s * 0.045));
  stroke(
    [
      [cx - arm * 0.1, cy - arm],
      [cx + arm, cy],
      [cx - arm * 0.1, cy + arm]
    ],
    0xe2,
    0x58,
    0x32,
    sw
  );
  stroke(
    [
      [Math.round(s * 0.48), Math.round(s * 0.62)],
      [Math.round(s * 0.72), Math.round(s * 0.62)]
    ],
    0x2d,
    0x76,
    0x53,
    sw
  );
  const dx = Math.round(s * 0.74);
  const dy = Math.round(s * 0.36);
  const dr = Math.max(2, Math.round(s * 0.035));
  for (let y = dy - dr; y <= dy + dr; y++) {
    for (let x = dx - dr; x <= dx + dr; x++) {
      if ((x - dx) * (x - dx) + (y - dy) * (y - dy) <= dr * dr) set(x, y, 0x3b, 0xab, 0x70);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = zlib.deflateSync(data, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="AnytimeVibe">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1d2922"/>
      <stop offset="100%" stop-color="#121914"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <rect x="86" y="140" width="340" height="232" rx="36" fill="#f2eadb"/>
  <path d="M156 206 L232 256 L156 306" fill="none" stroke="#e25832" stroke-width="36" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M250 308 H356" stroke="#2d7653" stroke-width="36" stroke-linecap="round"/>
  <circle cx="372" cy="186" r="18" fill="#3bab70"/>
</svg>
`;

const roots = ["assets", "apps/agent/assets", "apps/web/public"];
for (const root of roots) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "icon.svg"), svg);
}
fs.writeFileSync("assets/icon.png", makePng(512));
fs.writeFileSync("apps/agent/assets/icon.png", makePng(512));
fs.writeFileSync("apps/agent/assets/icon-256.png", makePng(256));
fs.writeFileSync("apps/web/public/icon-192.png", makePng(192));
fs.writeFileSync("apps/web/public/icon-512.png", makePng(512));
console.log("icons written");
