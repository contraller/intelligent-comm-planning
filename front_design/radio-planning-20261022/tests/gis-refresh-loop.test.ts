import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { useResourceReadStore } from '../src/stores/resource-read';
import { previewService } from '../src/services';
import { resourceReadMethods } from '../src/types/resource-read';
import { authFixture, authorizeStore } from './helpers/auth';
import { ApiError } from '../src/services/types';

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => { pinia = createPinia();setActivePinia(pinia); });
afterEach(() => { disposePinia(pinia);vi.restoreAllMocks(); });
async function setup() {
  authorizeStore();const fixture = authFixture();
  for (const key of resourceReadMethods) vi.spyOn(previewService, key).mockImplementation(fixture.raw[key] as never);
  const store = useResourceReadStore();await store.activate('gis');
  return store;
}
describe('地图视口稳定性', () => {
  it('相同已成功查询不会重复读取，细小视口抖动被忽略', async () => {
    const store = await setup(), query = vi.mocked(previewService.queryResourceMap);
    store.setViewport([113, 36, 115, 38], 10);await store.loadMap();const count = query.mock.calls.length;
    expect(store.setViewport([113 + 1e-9, 36, 115, 38], 10.001)).toBe(false);
    for (let i = 0; i < 6; i++) await store.loadMap(false);
    expect(query).toHaveBeenCalledTimes(count);
    store.setViewport([113, 36, 115.1, 38], 10);await store.loadMap();expect(query).toHaveBeenCalledTimes(count + 1);
  });
  it('相同在途查询合并，错误允许显式重试，手动刷新不使用旧缓存', async () => {
    const store = await setup(), query = vi.mocked(previewService.queryResourceMap), frame = store.frame!;
    let finish!: (value: typeof frame) => void;
    query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    store.setViewport([113, 36, 115, 38], 10);const first = store.loadMap(), second = store.loadMap();
    const count = query.mock.calls.length;finish(frame);await Promise.all([first, second]);expect(query).toHaveBeenCalledTimes(count);
    store.setViewport([113, 36, 115.2, 38], 10);query.mockRejectedValueOnce(new ApiError('离线', 'NETWORK_ERROR'));
    await store.loadMap();expect(store.errors.map).toBe('离线');await store.loadMap();expect(store.errors.map).toBeUndefined();
    const before = query.mock.calls.length;await store.refresh();expect(query).toHaveBeenCalledTimes(before + 1);
  });
});
