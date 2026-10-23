import { deflateSync } from 'node:zlib';

// 只栅格化已写好的教学几何；不推算传播、距离或业务指标。
function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}

export function renderCoveragePng({ coverage, patches }) {
  const { width, height, bbox, colormap } = coverage.raster_png;
  const polygons = coverage.contour.features.flatMap(({ geometry }) =>
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);
  const pixels = Buffer.alloc(height * (1 + width * 4));
  // PNG 自北向南写行；每个面的内环保持透明，支持分离的近区与远区。
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const point = [bbox[0] + (x + 0.5) / width * (bbox[2] - bbox[0]), bbox[3] - (y + 0.5) / height * (bbox[3] - bbox[1])];
    if (!polygons.some(rings => inside(point, rings[0]) && !rings.slice(1).some(ring => inside(point, ring)))) continue;
    let value = colormap[0].value_dbuvm;
    for (const patch of patches) if (inside(point, patch.ring)) value = patch.value_dbuvm;
    const color = colormap.find(entry => entry.value_dbuvm === value);
    if (!color) throw new Error('色块未匹配图例');
    pixels.set(color.rgba, y * (1 + width * 4) + 1 + x * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6; // 8 位 RGBA，无交错、无行滤波。
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
