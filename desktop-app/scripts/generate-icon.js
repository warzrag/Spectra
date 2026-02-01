#!/usr/bin/env node
/**
 * Generates app icon PNG files for electron-builder
 * Creates a professional shield icon with gradient background
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crcBuf]);
}

function createPNG(w, h, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // no filter
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = y * (w * 4 + 1) + 1 + x * 4;
      raw[di] = pixels[si]; raw[di+1] = pixels[si+1]; raw[di+2] = pixels[si+2]; raw[di+3] = pixels[si+3];
    }
  }
  return Buffer.concat([
    sig,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    createChunk('IEND', Buffer.alloc(0))
  ]);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function smoothstep(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

function roundedRectSDF(px, py, cx, cy, hw, hh, r) {
  const dx = Math.max(Math.abs(px - cx) - hw + r, 0);
  const dy = Math.max(Math.abs(py - cy) - hh + r, 0);
  return Math.sqrt(dx * dx + dy * dy) - r;
}

function shieldSDF(px, py, cx, cy, size) {
  // Shield shape: rounded top, pointed bottom
  const nx = (px - cx) / size;
  const ny = (py - cy) / size;

  // Top half: rounded rectangle
  if (ny < 0) {
    const dx = Math.max(Math.abs(nx) - 0.55, 0);
    const dy = Math.max(Math.abs(ny + 0.15) - 0.45, 0);
    return (Math.sqrt(dx * dx + dy * dy) - 0.08) * size;
  }

  // Bottom half: pointed triangle
  const bottomY = 0.65;
  const t = clamp(ny / bottomY, 0, 1);
  const halfWidth = 0.55 * (1 - t * t);
  const dx = Math.abs(nx) - halfWidth;
  if (dx <= 0 && ny <= bottomY) return Math.max(dx, 0) * size - 2;
  return Math.max(dx, ny - bottomY) * size;
}

function generateIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const bgRadius = size * 0.18;
  const bgHalf = size * 0.42;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;

      // Background: rounded rectangle with gradient
      const bgDist = roundedRectSDF(x, y, center, center, bgHalf, bgHalf, bgRadius);
      const bgAlpha = clamp(1 - smoothstep(-1.5, 1.5, bgDist), 0, 1);

      if (bgAlpha <= 0) {
        pixels[i] = 0; pixels[i+1] = 0; pixels[i+2] = 0; pixels[i+3] = 0;
        continue;
      }

      // Gradient: top-left indigo (#4f46e5) to bottom-right violet (#7c3aed)
      const gradT = clamp(((x + y) / size - 0.3) / 0.8, 0, 1);
      const bgR = Math.round(lerp(79, 124, gradT));
      const bgG = Math.round(lerp(70, 58, gradT));
      const bgB = Math.round(lerp(229, 237, gradT));

      // Shield shape
      const shieldDist = shieldSDF(x, y, center, center * 0.95, size * 0.32);
      const shieldAlpha = clamp(1 - smoothstep(-1.5, 1.5, shieldDist), 0, 1);

      // Inner shield (cutout for hollow effect)
      const innerShieldDist = shieldSDF(x, y, center, center * 0.95, size * 0.22);
      const innerAlpha = clamp(1 - smoothstep(-1.5, 1.5, innerShieldDist), 0, 1);

      // Lock/keyhole circle in center of shield
      const lockCx = center;
      const lockCy = center * 0.88;
      const lockR = size * 0.06;
      const lockDist = Math.sqrt((x - lockCx) ** 2 + (y - lockCy) ** 2) - lockR;
      const lockAlpha = clamp(1 - smoothstep(-1, 1, lockDist), 0, 1);

      // Lock bottom bar
      const barW = size * 0.025;
      const barH = size * 0.07;
      const barDist = roundedRectSDF(x, y, lockCx, lockCy + lockR + barH * 0.5, barW, barH, barW * 0.5);
      const barAlpha = clamp(1 - smoothstep(-1, 1, barDist), 0, 1);

      // Combine: white shield outline with keyhole
      const whiteAmount = clamp(shieldAlpha - innerAlpha + lockAlpha + barAlpha, 0, 1);

      // Subtle glow on shield
      const glowDist = shieldSDF(x, y, center, center * 0.95, size * 0.35);
      const glow = clamp(1 - smoothstep(-size * 0.04, size * 0.06, glowDist), 0, 1) * 0.15;

      let r = bgR, g = bgG, b = bgB;

      // Apply white shield
      r = Math.round(lerp(r, 255, whiteAmount));
      g = Math.round(lerp(g, 255, whiteAmount));
      b = Math.round(lerp(b, 255, whiteAmount));

      // Apply glow
      r = Math.round(lerp(r, 255, glow));
      g = Math.round(lerp(g, 255, glow));
      b = Math.round(lerp(b, 255, glow));

      pixels[i] = clamp(r, 0, 255);
      pixels[i+1] = clamp(g, 0, 255);
      pixels[i+2] = clamp(b, 0, 255);
      pixels[i+3] = Math.round(bgAlpha * 255);
    }
  }

  return createPNG(size, size, pixels);
}

// Generate icons
const assetsDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

console.log('Generating 512x512 icon...');
fs.writeFileSync(path.join(assetsDir, 'icon.png'), generateIcon(512));
console.log('Generating 256x256 icon...');
fs.writeFileSync(path.join(assetsDir, 'icon-256.png'), generateIcon(256));

console.log('Done! Icons saved to assets/');
