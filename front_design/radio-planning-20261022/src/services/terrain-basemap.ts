import type { Bounds, ResourceTerrain } from '../types/resource-read';

export interface TerrainBasemap { url: string; extent: Bounds; source: string; dispose(): void }

const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const bounds = (value: unknown): value is Bounds => Array.isArray(value) && value.length === 4
  && value.every((part) => typeof part === 'number' && Number.isFinite(part))
  && value[0] >= -180 && value[2] <= 180 && value[1] >= -90 && value[3] <= 90
  && value[0] < value[2] && value[1] < value[3];

export async function loadTerrainBasemap(
  expected: ResourceTerrain | null | undefined,
  fetcher: typeof fetch = globalThis.fetch,
  baseUrl: string = import.meta.env.BASE_URL,
  signal?: AbortSignal,
): Promise<TerrainBasemap> {
  if (!expected) throw new Error('后端未提供当前 DEM 版本，地形底图未显示。');
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('地形加载已取消', 'AbortError'); };
  checkAbort();
  const prefix = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const response = await fetcher(`${prefix}maps/sr4-terrain.json`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('地形元数据加载失败，地形底图未显示。');
  const metadata: unknown = await response.json();
  checkAbort();
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('地形元数据无效。');
  const row = metadata as Record<string, unknown>;
  if (row.projection !== 'EPSG:4326' || !bounds(row.extent) || !sha256(row.source_sha256)
    || !sha256(row.image_sha256) || typeof row.source !== 'string' || !row.source.trim())
    throw new Error('地形元数据无效。');
  if (row.source_sha256 !== expected.sourceSha256
    || !row.extent.every((part, index) => Math.abs(part - expected.bounds[index]) <= 1e-8))
    throw new Error('地形底图与后端当前 DEM 版本不一致，请重新生成地形资源。');
  const image = await fetcher(`${prefix}maps/sr4-terrain.png?v=${row.image_sha256}`, { cache: 'no-store', signal });
  if (!image.ok) throw new Error('地形图片加载失败。');
  const bytes = await image.arrayBuffer();
  checkAbort();
  // 校验实际图片字节，不能仅以查询串或元数据声明代替完整性检查。
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  checkAbort();
  const actual = Array.from(new Uint8Array(digest), part => part.toString(16).padStart(2, '0')).join('');
  if (actual !== row.image_sha256) throw new Error('地形图片校验失败，请重新部署地形资源。');
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  let disposed = false;
  return { url, extent: row.extent, source: row.source, dispose() {
    if (!disposed) { disposed = true; URL.revokeObjectURL(url); }
  } };
}
