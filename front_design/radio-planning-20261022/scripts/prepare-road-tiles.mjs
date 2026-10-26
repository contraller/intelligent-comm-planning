import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import GeoJSONVT from 'geojson-vt';
import vtpbf from 'vt-pbf';

export const ROAD_TILE_OPTIONS = Object.freeze({
  minZoom: 0,
  maxZoom: 14,
  tileSize: 256,
  extent: 4096,
  buffer: 64,
  tolerance: 3,
});

// XYZ 使用世界墨卡托网格；原始文件始终保留 WGS84 经纬度。
export function roadTileRange(bounds, z) {
  const size = 2 ** z;
  const x = (lon) => Math.max(0, Math.min(size - 1, Math.floor(((lon + 180) / 360) * size)));
  const y = (lat) =>
    Math.max(
      0,
      Math.min(
        size - 1,
        Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * size),
      ),
    );
  return [x(bounds[0]), y(bounds[3]), x(bounds[2]), y(bounds[1])];
}

export function indexRoadTiles(data) {
  if (data?.type !== 'FeatureCollection' || !data.features?.length)
    throw new Error('道路必须为非空 FeatureCollection');
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  let points = 0;
  for (const feature of data.features) {
    if (feature.geometry?.type !== 'LineString' || feature.geometry.coordinates.length < 2)
      throw new Error('道路几何格式无效');
    for (const point of feature.geometry.coordinates) {
      if (
        point.length !== 2 ||
        !point.every(Number.isFinite) ||
        Math.abs(point[0]) > 180 ||
        Math.abs(point[1]) > 85.05112878
      )
        throw new Error('道路坐标超出 XYZ 支持范围');
      bounds[0] = Math.min(bounds[0], point[0]);
      bounds[1] = Math.min(bounds[1], point[1]);
      bounds[2] = Math.max(bounds[2], point[0]);
      bounds[3] = Math.max(bounds[3], point[1]);
      points++;
    }
  }
  // 只生成部署产物；切片和编码依赖不进入浏览器代码。
  const index = new GeoJSONVT(data, { ...ROAD_TILE_OPTIONS, generateId: true });
  return { index, bounds, points };
}

export function encodeRoadTile(index, z, x, y) {
  const tile = index.getTile(z, x, y);
  // 范围内的无道路格也输出有效空瓦片，404 始终代表部署缺失。
  return vtpbf.fromGeojsonVt(
    { roads: tile ?? { features: [] } },
    {
      version: 2,
      extent: ROAD_TILE_OPTIONS.extent,
    },
  );
}

export async function prepareRoadTiles() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const source = await readFile(path.join(root, 'public/maps/demo-roads.geojson'));
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source));
  const { index, bounds, points } = indexRoadTiles(data);
  const version = createHash('sha256')
    .update(sourceHash)
    .update(JSON.stringify(ROAD_TILE_OPTIONS))
    .update('geojson-vt@5.0.4/vt-pbf@3.1.3/mvt-v2')
    .digest('hex')
    .slice(0, 16);
  const output = path.join(root, 'public/maps/demo-roads-tiles');
  const ranges = [];
  const byZoom = [];
  let totalBytes = 0,
    tileCount = 0,
    maxTileBytes = 0,
    maxTile = '';
  for (let z = ROAD_TILE_OPTIONS.minZoom; z <= ROAD_TILE_OPTIONS.maxZoom; z++) {
    const range = roadTileRange(bounds, z);
    ranges.push(range);
    let bytes = 0,
      count = 0;
    for (let x = range[0]; x <= range[2]; x++) {
      const directory = path.join(output, version, String(z), String(x));
      await mkdir(directory, { recursive: true });
      for (let y = range[1]; y <= range[3]; y++) {
        const tile = encodeRoadTile(index, z, x, y);
        await writeFile(path.join(directory, `${y}.mvt`), tile);
        bytes += tile.byteLength;
        count++;
        if (tile.byteLength > maxTileBytes) {
          maxTileBytes = tile.byteLength;
          maxTile = `${z}/${x}/${y}`;
        }
      }
    }
    byZoom.push({ zoom: z, tileCount: count, bytes });
    tileCount += count;
    totalBytes += bytes;
  }
  const manifest = {
    format: 'mvt',
    version,
    layer: 'roads',
    ...ROAD_TILE_OPTIONS,
    bounds,
    ranges,
    tiles: `${version}/{z}/{x}/{y}.mvt`,
    source: {
      file: 'demo-roads.geojson',
      sha256: sourceHash,
      featureCount: data.features.length,
      pointCount: points,
      classes: [...new Set(data.features.map((feature) => feature.properties.fclass))].sort(),
    },
    statistics: { tileCount, totalBytes, maxTileBytes, maxTile, byZoom },
  };
  // 全部瓦片成功写入后才更新入口；旧版本目录保留，不物理删除文件。
  await writeFile(
    path.join(output, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareRoadTiles();
