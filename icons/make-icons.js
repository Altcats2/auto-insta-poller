// Generates the extension icons as PNGs (no dependencies).
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Burnt orange tile with a white exclamation mark.
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const barX0 = size * 0.435, barX1 = size * 0.565;
  const barY0 = size * 0.20, barY1 = size * 0.60;
  const dotCx = size * 0.5, dotCy = size * 0.735, dotR = size * 0.082;

  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const i = (y * size + x) * 4;
      if (!inRounded(px, py)) continue;
      const onBar = px >= barX0 && px <= barX1 && py >= barY0 && py <= barY1;
      const onDot = (px - dotCx) ** 2 + (py - dotCy) ** 2 <= dotR * dotR;
      if (onBar || onDot) {
        buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = 255;
      } else {
        buf[i] = 0xbf; buf[i + 1] = 0x57; buf[i + 2] = 0x00; buf[i + 3] = 255;
      }
    }
  }
  return png(size, size, buf);
}

for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(__dirname, `icon${size}.png`), draw(size));
  console.log(`icon${size}.png`);
}
