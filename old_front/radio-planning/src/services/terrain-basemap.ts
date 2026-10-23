import type { Bounds, ResourceTerrain } from '../types/resource-read';

export interface TerrainBasemap { url: string; extent: Bounds; source: string }

const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const bounds = (value: unknown): value is Bounds => Array.isArray(value) && value.length === 4
  && value.every((part) => typeof part === 'number' && Number.isFinite(part))
  && value[0] >= -180 && value[2] <= 180 && value[1] >= -90 && value[3] <= 90
  && value[0] < value[2] && value[1] < value[3];

export async function loadTerrainBasemap(
  expected: ResourceTerrain | null | undefined,
  fetcher: typeof fetch = globalThis.fetch,
  baseUrl: string = import.meta.env.BASE_URL,
): Promise<TerrainBasemap> {
  if (!expected) throw new Error('后端未提供当前 DEM 版本，地形底图未显示。');
  const prefix = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const response = await fetcher(`${prefix}maps/sr4-terrain.json`, { cache: 'no-store' });
  if (!response.ok) throw new Error('地形元数据加载失败，地形底图未显示。');
  const metadata: unknown = await response.json();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('地形元数据无效，地形底图未显示。');
  const row = metadata as Record<string, unknown>;
  if (row.projection !== 'EPSG:4326' || !bounds(row.extent) || !sha256(row.source_sha256)
    || !sha256(row.image_sha256) || typeof row.source !== 'string')
    throw new Error('地形元数据无效，地形底图未显示。');
  if (row.source_sha256 !== expected.sourceSha256
    || !row.extent.every((part, index) => Math.abs(part - expected.bounds[index]) <= 1e-8))
    throw new Error('地形底图与后端当前 DEM 版本不一致，请重新生成地形资源。');
  return {
    url: `${prefix}maps/sr4-terrain.png?v=${row.image_sha256}`,
    extent: row.extent,
    source: row.source,
  };
}
