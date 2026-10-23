import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = resolve(appRoot, '..', '..');
const resultDir = resolve(projectRoot, 'data', 'results', 'current_dem');
const demo = JSON.parse(readFileSync(resolve(resultDir, 'demo_data.json'), 'utf8'));
const source = JSON.parse(readFileSync(resolve(resultDir, 'source.json'), 'utf8'));
const activeDem = JSON.parse(readFileSync(resolve(projectRoot, 'data', 'raw', 'dem', 'dem_current.json'), 'utf8'));
const { extent, size, terrain } = demo.basemap;

if (!Array.isArray(extent) || extent.length !== 4 || !extent.every(Number.isFinite)
  || !Array.isArray(size) || size.length !== 2 || !size.every(Number.isInteger)
  || !terrain?.startsWith('data:image/png;base64,')) {
  throw new Error('Current DEM basemap metadata is invalid');
}
if (source.source_sha256 !== demo.meta.dem.source_sha256
  || activeDem.source_sha256 !== source.source_sha256
  || extent.some((value, index) => Math.abs(value - source.bbox[index]) > 1e-8)) {
  throw new Error('Current DEM basemap does not match source metadata');
}

const png = Buffer.from(terrain.slice('data:image/png;base64,'.length), 'base64');
if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  || png.readUInt32BE(16) !== size[0] || png.readUInt32BE(20) !== size[1]) {
  throw new Error('Current DEM basemap image does not match declared dimensions');
}

const targetDir = resolve(appRoot, 'public', 'maps');
mkdirSync(targetDir, { recursive: true });
writeFileSync(resolve(targetDir, 'sr4-terrain.png'), png);
writeFileSync(resolve(targetDir, 'sr4-terrain.json'), JSON.stringify({
  extent,
  size,
  projection: 'EPSG:4326',
  source: demo.meta.dem.source,
  source_sha256: demo.meta.dem.source_sha256,
  image_sha256: createHash('sha256').update(png).digest('hex'),
}, null, 2) + '\n');
console.log(`Exported current DEM terrain: ${size[0]}x${size[1]}, ${png.length} bytes`);
