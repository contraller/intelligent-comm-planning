import { afterEach, describe, expect, it, vi } from 'vitest';
import { createObservationHttp } from '../src/services/observation-http';
import { assertObservationQuery } from '../src/services/observation-validation';
import { OBSERVATION_ORIGIN } from '../src/types/observation';
import type { ObservationFrame, ObservationServices } from '../src/types/observation';
import type { AuthenticatedRequest } from '../src/services/auth-http';

const hash = 'a'.repeat(64), revision = 'observation-' + hash;
const selection = { datasetId: 'obs:A', datasetRevision: revision };
const stamp = '2026-10-05T01:00:00.000000Z';
function summary() {
  return { ...selection, schemaVersion: 1, dataOrigin: OBSERVATION_ORIGIN,
    provenanceNote: '显式构造契约测试，非实测', resourceRevision: 'resource-v1', deviceStatusSnapshotId: null,
    source: { sourceId: 'source:HF', name: '构造短波', configRevision: 'declared-v1', minKhz: 6000, maxKhz: 8000, intervalSeconds: null },
    frameCount: 2, firstObservedAt: stamp, lastObservedAt: null, importedAt: stamp, contentHash: hash };
}
function frame(index = 0): ObservationFrame {
  return { ...selection, dataOrigin: OBSERVATION_ORIGIN, frameId: 'frame:' + index, index,
    observedAt: null, label: '构造未知帧', occupancyPercent: null, abnormalBandCount: null,
    unknownReasons: ['未提供汇总及时间'], bins: [{ binId: 'bin:HF', minKhz: 6000, maxKhz: 7000,
      occupancyPercent: null, powerDbm: null, abnormal: null, reason: null, unknownReasons: ['未提供观测'] }] };
}
function identity() {
  return { ...selection, schemaVersion: 1, dataOrigin: OBSERVATION_ORIGIN, resourceRevision: 'resource-v1',
    sourceId: 'source:HF', configRevision: 'declared-v1', frameCount: 2 };
}
function single(index = 0) {
  return { ...identity(), index, hasPrevious: index > 0, hasNext: index < 1, frame: frame(index) };
}
function context(selected = false) {
  return { schemaVersion: 1, dataOrigin: OBSERVATION_ORIGIN, datasetCount: selected ? 1 : 0,
    selected: selected ? summary() : null, reasons: selected ? [] : ['NO_IMPORTED_DATA'],
    replay: { mode: 'FINITE', loop: false, maxFramesPerDataset: 256, maxBinsPerFrame: 256 } };
}
function response(data: unknown, code = 0, status = 200) {
  return new Response(JSON.stringify({ code, message: code ? '受控错误' : 'success', data }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
function client(data: unknown) {
  const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response(data));
  return { api: createObservationHttp({ baseUrl: () => '/api/v1', fetcher }), fetcher };
}
afterEach(() => { vi.useRealTimers(); });

describe('P07 独立只读频谱适配器', () => {
  it('交付入口只使用已认证请求，保留会话拒绝而不回退裸请求', async () => {
    const bare = vi.fn();
    const request = vi.fn(async () => context());
    const api = createObservationHttp({ baseUrl: () => '/api/v1', fetcher: bare, authenticatedRequest: request as AuthenticatedRequest });
    expect(await api.loadObservationContext()).toEqual(context());
    expect(request).toHaveBeenCalledWith('/observations/spectrum/context', expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }));
    expect(bare).not.toHaveBeenCalled();
    const error = Object.assign(new Error('会话已变化'), { code: 'SESSION_REPLACED' });
    request.mockRejectedValueOnce(error);
    await expect(api.loadObservationContext()).rejects.toBe(error);
    expect(bare).not.toHaveBeenCalled();
  });

  it('空上下文不生成帧；精确 GET 路径和同源选项', async () => {
    const { api, fetcher } = client(context());
    expect(await api.loadObservationContext()).toEqual(context());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/observations/spectrum/context');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
  });

  it('选中集按明确版本读取上下文，不接受默认最新集', async () => {
    const { api, fetcher } = client(context(true));
    const value = await api.loadObservationContext(selection);
    expect(value.selected?.deviceStatusSnapshotId).toBeNull();
    expect(fetcher.mock.calls[0][0]).toContain('/context?dataset_id=obs%3AA&dataset_revision=' + revision);
    const unselected = client(context(true));
    await expect(unselected.api.loadObservationContext()).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_RESPONSE' });
  });

  it('观测集目录分页，保留来源和未知采样周期', async () => {
    const data = { schemaVersion: 1, dataOrigin: OBSERVATION_ORIGIN, items: [summary()], page: 1, pageSize: 20, total: 1 };
    const { api, fetcher } = client(data);
    expect((await api.queryObservationDatasets({ page: 1, pageSize: 20 })).items[0].source.intervalSeconds).toBeNull();
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/observations/spectrum/datasets?page=1&page_size=20');
  });

  it('帧分页严格绑定请求并支持末页、空页', async () => {
    const data = { ...identity(), items: [frame(1)], page: 2, pageSize: 1, total: 2 };
    const { api, fetcher } = client(data);
    expect((await api.queryObservationFrames({ ...selection, page: 2, pageSize: 1 })).items[0].index).toBe(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/observations/spectrum/datasets/obs%3AA/frames?dataset_revision=' + revision + '&page=2&page_size=1');
    const empty = client({ ...identity(), items: [], page: 9, pageSize: 20, total: 2 });
    expect((await empty.api.queryObservationFrames({ ...selection, page: 9, pageSize: 20 })).items).toEqual([]);
  });

  it('按索引读取保留 null，有限回放不循环也不写入', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => response(single(Number(String(url).match(/frames\/(\d+)/)?.[1]))));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', fetcher });
    const indexes: number[] = [];
    let index = 0;
    while (true) {
      const result = await api.getObservationFrame({ ...selection, index });
      indexes.push(result.index);
      expect(result.frame.bins[0].powerDbm).toBeNull();
      expect(result.frame.bins[0].abnormal).toBeNull();
      expect(result.frame.observedAt).toBeNull();
      if (!result.hasNext) break;
      index++;
    }
    expect(indexes).toEqual([0, 1]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][0]).toContain('/frames/0?dataset_revision=' + revision);
  });

  it('四个方法均按发起时查询解码，异步修改原输入不改变归属或页码', async () => {
    const original = new AbortController(), replacement = new AbortController();
    const selected = { ...selection, signal: original.signal };
    const directory = { page: 1, pageSize: 20, signal: original.signal };
    const paged = { ...selection, page: 1, pageSize: 20, signal: original.signal };
    const indexed = { ...selection, index: 0, signal: original.signal };
    const scenarios: { run: (api: ObservationServices) => Promise<unknown>; value: unknown; mutate: () => void; path: string }[] = [
      { run: api => api.loadObservationContext(selected), value: context(true), path: '/context?dataset_id=obs%3AA',
        mutate: () => { selected.datasetId = 'changed'; selected.datasetRevision = 'observation-' + 'b'.repeat(64); selected.signal = replacement.signal; } },
      { run: api => api.queryObservationDatasets(directory), value: { schemaVersion: 1, dataOrigin: OBSERVATION_ORIGIN, items: [summary()], page: 1, pageSize: 20, total: 1 }, path: '/datasets?page=1&page_size=20',
        mutate: () => { directory.page = 2; directory.pageSize = 1; directory.signal = replacement.signal; } },
      { run: api => api.queryObservationFrames(paged), value: { ...identity(), items: [frame(0), frame(1)], page: 1, pageSize: 20, total: 2 }, path: '/datasets/obs%3AA/frames?dataset_revision=' + revision,
        mutate: () => { paged.datasetId = 'changed'; paged.datasetRevision = 'observation-' + 'b'.repeat(64); paged.page = 9; paged.pageSize = 1; paged.signal = replacement.signal; } },
      { run: api => api.getObservationFrame(indexed), value: single(0), path: '/datasets/obs%3AA/frames/0?dataset_revision=' + revision,
        mutate: () => { indexed.datasetId = 'changed'; indexed.datasetRevision = 'observation-' + 'b'.repeat(64); indexed.index = 1; indexed.signal = replacement.signal; } },
    ];
    for (const scenario of scenarios) {
      let finish!: (value: Response) => void;
      const fetcher = vi.fn((_input: string | URL | Request, _init?: RequestInit) => new Promise<Response>(resolve => { finish = resolve; }));
      const api = createObservationHttp({ baseUrl: () => '/api/v1', fetcher });
      const pending = scenario.run(api);
      scenario.mutate();
      expect(String(fetcher.mock.calls[0][0])).toContain(scenario.path);
      finish(response(scenario.value));
      await expect(pending).resolves.toEqual(scenario.value);
    }
  });

  it('查询副本保留原 signal 身份，替换输入 signal 后仍取消并清理原监听', async () => {
    const original = new AbortController();
    const input = { ...selection, index: 0, signal: original.signal };
    const remove = vi.spyOn(original.signal, 'removeEventListener');
    const api = createObservationHttp({ baseUrl: () => '/api/v1', fetcher: vi.fn(() => new Promise<Response>(() => {})) });
    const pending = api.getObservationFrame(input);
    input.signal = new AbortController().signal;
    original.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it.each([
    (value: ReturnType<typeof single>) => { value.dataOrigin = 'MEASURED' as typeof OBSERVATION_ORIGIN; },
    (value: ReturnType<typeof single>) => { value.datasetId = 'another'; },
    (value: ReturnType<typeof single>) => { value.datasetRevision = 'observation-' + 'b'.repeat(64); },
    (value: ReturnType<typeof single>) => { value.frame.datasetId = 'another'; },
    (value: ReturnType<typeof single>) => { value.frame.index = 1; },
    (value: ReturnType<typeof single>) => { value.hasNext = false; },
    (value: ReturnType<typeof single>) => { value.frame.bins[0].unknownReasons = []; },
    (value: ReturnType<typeof single>) => { Object.assign(value.frame.bins[0], { powerDbm: 'unknown' }); },
    (value: ReturnType<typeof single>) => { Object.assign(value.frame, { abnormalBandCount: 0 }); },
    (value: ReturnType<typeof single>) => { value.frame.observedAt = '2026-02-30T01:00:00.000000Z'; },
    (value: ReturnType<typeof single>) => { Object.assign(value.frame, { extra: true }); },
  ])('拒绝来源、归属、索引、未知值或结构损坏 #%#', async mutate => {
    const value = single(); mutate(value);
    await expect(client(value).api.getObservationFrame({ ...selection, index: 0 })).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_RESPONSE' });
  });

  it('拒绝错页码、少帧和不按索引排列的分页', async () => {
    for (const data of [
      { ...identity(), items: [frame(0), frame(1)], page: 2, pageSize: 20, total: 2 },
      { ...identity(), items: [frame(0)], page: 1, pageSize: 20, total: 2 },
      { ...identity(), items: [frame(1), frame(0)], page: 1, pageSize: 20, total: 2 },
    ]) await expect(client(data).api.queryObservationFrames({ ...selection, page: 1, pageSize: 20 })).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_RESPONSE' });
  });

  it.each([
    ['context', { datasetId: 'obs:A' }], ['context', { extra: true }],
    ['datasets', { page: 0, pageSize: 20 }], ['datasets', { page: 1, pageSize: 101 }],
    ['frames', { ...selection, page: 1, pageSize: true }],
    ['index', { ...selection, index: -1 }], ['index', { ...selection, index: Number.NaN }],
  ] as const)('非法查询不发请求：%s', (mode, input) => {
    expect(() => assertObservationQuery(input, mode)).toThrowError(expect.objectContaining({ code: 'INVALID_OBSERVATION_QUERY' }));
  });

  it.each([[1101, 401], [1104, 403], [1106, 409], [1204, 409], [1002, 404], [5002, 503]])('保留业务码 %i 与 HTTP 状态 %i', async (code, status) => {
    const fetcher = vi.fn(async () => response(null, code, status));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', fetcher });
    await expect(api.loadObservationContext()).rejects.toMatchObject({ code, status });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('跨源地址在请求前拒绝，网络失败不降级 Mock', async () => {
    const fetcher = vi.fn(async () => { throw new Error('test network failure'); });
    const cross = createObservationHttp({ baseUrl: () => 'https://other.invalid/api/v1', origin: () => 'https://local.invalid', fetcher });
    await expect(cross.loadObservationContext()).rejects.toMatchObject({ code: 'INVALID_AUTH_BASE_URL' });
    expect(fetcher).not.toHaveBeenCalled();
    const api = createObservationHttp({ baseUrl: () => '/api/v1', fetcher });
    await expect(api.loadObservationContext()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('预先取消不会发请求；进行中取消会终止本次读取', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', fetcher });
    const pending = api.loadObservationContext({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(api.loadObservationContext({ signal: controller.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('超时即失败，不生成重试或下一帧', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', fetcher, timeoutMs: 50 });
    const pending = expect(api.loadObservationContext()).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(51);
    await pending;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
