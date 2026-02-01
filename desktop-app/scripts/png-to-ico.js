#!/usr/bin/env node
/**
 * Convert PNG files to ICO format
 * ICO format: header + directory entries + PNG data
 */
const fs = require('fs');
const path = require('path');

function createICO(pngPaths) {
  const images = pngPaths.map(p => fs.readFileSync(p));

  // ICO Header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // Reserved
  header.writeUInt16LE(1, 2);      // Type: 1 = ICO
  header.writeUInt16LE(images.length, 4); // Number of images

  // Directory entries: 16 bytes each
  const dirSize = images.length * 16;
  let dataOffset = 6 + dirSize;

  const entries = [];
  for (const png of images) {
    // Read PNG dimensions from IHDR chunk
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);

    const entry = Buffer.alloc(16);
    entry[0] = width >= 256 ? 0 : width;   // Width (0 = 256)
    entry[1] = height >= 256 ? 0 : height; // Height (0 = 256)
    entry[2] = 0;  // Color palette
    entry[3] = 0;  // Reserved
    entry.writeUInt16LE(1, 4);  // Color planes
    entry.writeUInt16LE(32, 6); // Bits per pixel
    entry.writeUInt32LE(png.length, 8);  // Image size
    entry.writeUInt32LE(dataOffset, 12); // Offset to image data

    entries.push(entry);
    dataOffset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images]);
}

const assetsDir = path.join(__dirname, '..', 'assets');
const ico = createICO([
  path.join(assetsDir, 'icon.png'),
  path.join(assetsDir, 'icon-256.png')
]);
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico);
console.log('ICO file created: assets/icon.ico');
