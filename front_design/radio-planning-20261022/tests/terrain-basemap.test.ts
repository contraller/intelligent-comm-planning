import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loadTerrainBasemap } from '../src/services/terrain-basemap';
import type { ResourceTerrain } from '../src/types/resource-read';

// 图片字节与元数据分别构造，确保实际校验内容而非只检查文件名。
const bytes = new Uint8Array([137,80,78,71,13,10,26,10]);
const expected: ResourceTerrain = { sourceSha256: 'a'.repeat(64), bounds: [113,36,115,38], source: '构造 DEM' };
const metadata = () => ({ projection: 'EPSG:4326', extent: expected.bounds, source: expected.source,
  source_sha256: expected.sourceSha256, image_sha256: createHash('sha256').update(bytes).digest('hex') });
function fixture(patch = {}) {
  const fetcher = vi.fn<typeof fetch>(async input => String(input).includes('.json')
    ? new Response(JSON.stringify({ ...metadata(), ...patch })) : new Response(bytes));
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:terrain-test');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return { fetcher, create, revoke };
}
afterEach(() => vi.restoreAllMocks());
describe('DEM 资源完整性与生命周期', () => {
  it('校验哈希及范围后创建图片，按部署前缀加载且只释放一次', async () => {
    const s = fixture(), controller = new AbortController();
    const result = await loadTerrainBasemap(expected, s.fetcher, '/preview', controller.signal);
    expect(result).toMatchObject({ url: 'blob:terrain-test', extent: expected.bounds, source: expected.source });
    expect(s.fetcher.mock.calls[0]).toEqual(['/preview/maps/sr4-terrain.json', { cache: 'no-store', signal: controller.signal }]);
    expect(String(s.fetcher.mock.calls[1][0])).toContain('/preview/maps/sr4-terrain.png?v=' + metadata().image_sha256);
    result.dispose(); result.dispose();
    expect(s.revoke).toHaveBeenCalledExactlyOnceWith(result.url);
  });
  it.each([{ source_sha256: 'b'.repeat(64) }, { extent: [112,36,115,38] }, { projection: 'EPSG:3857' }, { image_sha256: 'bad' }, { extent: [113,38,115,36] }])('错版或无效元数据不加载图片 %j', async patch => {
    const s = fixture(patch);
    await expect(loadTerrainBasemap(expected, s.fetcher, '/')).rejects.toThrow();
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(s.create).not.toHaveBeenCalled();
  });
  it('实际图片损坏时拒绝，即使元数据版本正确', async () => {
    const s = fixture(); s.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(metadata()))).mockResolvedValueOnce(new Response('wrong image'));
    await expect(loadTerrainBasemap(expected, s.fetcher, '/')).rejects.toThrow('图片校验失败');
    expect(s.create).not.toHaveBeenCalled();
  });
  it.each([0, 1])('元数据或图片请求失败时不显示旧图 %s', async index => {
    const s = fixture();
    if (index) s.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(metadata())));
    s.fetcher.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(loadTerrainBasemap(expected, s.fetcher, '/')).rejects.toThrow('加载失败');
    expect(s.create).not.toHaveBeenCalled();
  });
  it('缺少后端版本和提前取消均不发请求', async () => {
    const s = fixture(), controller = new AbortController(); controller.abort();
    await expect(loadTerrainBasemap(null, s.fetcher, '/')).rejects.toThrow('未提供');
    await expect(loadTerrainBasemap(expected, s.fetcher, '/', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('响应忽略取消信号时，也不能创建迟到图片', async () => {
    const s = fixture(), controller = new AbortController();
    s.fetcher.mockImplementationOnce(async () => {
      controller.abort(); return new Response(JSON.stringify(metadata()));
    });
    await expect(loadTerrainBasemap(expected, s.fetcher, '/', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.create).not.toHaveBeenCalled();
  });
});
