import { describe, expect, it, vi } from 'vitest';
import { loadTerrainBasemap } from '../src/services/terrain-basemap';
import type { ResourceTerrain } from '../src/types/resource-read';

const expected: ResourceTerrain = { sourceSha256: 'a'.repeat(64), bounds: [113, 36, 115, 38], source: '当前 DEM' };
const metadata = () => ({
  projection: 'EPSG:4326', extent: [113, 36, 115, 38], source: '当前 DEM',
  source_sha256: 'a'.repeat(64), image_sha256: 'b'.repeat(64),
});
const fetcher = (data: unknown, status = 200) => vi.fn<typeof fetch>(async () =>
  new Response(JSON.stringify(data), { status }));

describe('规划地形底图版本校验', () => {
  it('只将与后端 DEM 同版本同范围的图片交给地图', async () => {
    const request = fetcher(metadata());
    const terrain = await loadTerrainBasemap(expected, request, '/app/');
    expect(terrain).toEqual({
      url: `/app/maps/sr4-terrain.png?v=${'b'.repeat(64)}`,
      extent: [113, 36, 115, 38], source: '当前 DEM',
    });
    expect(request).toHaveBeenCalledWith('/app/maps/sr4-terrain.json', { cache: 'no-store' });
  });
  it('旧图片、错位范围和错误坐标系均不显示', async () => {
    for (const changed of [
      { source_sha256: 'c'.repeat(64) },
      { extent: [113, 36, 115.1, 38] },
      { projection: 'EPSG:3857' },
    ]) {
      await expect(loadTerrainBasemap(expected, fetcher({ ...metadata(), ...changed }), '/'))
        .rejects.toThrow();
    }
  });
  it('后端缺少版本或静态元数据不可用时保留无地形状态', async () => {
    const request = fetcher(metadata());
    await expect(loadTerrainBasemap(null, request, '/')).rejects.toThrow('后端未提供');
    expect(request).not.toHaveBeenCalled();
    await expect(loadTerrainBasemap(expected, fetcher(null, 404), '/')).rejects.toThrow('加载失败');
    await expect(loadTerrainBasemap(expected, fetcher({ ...metadata(), image_sha256: '' }), '/'))
      .rejects.toThrow('元数据无效');
  });
});
