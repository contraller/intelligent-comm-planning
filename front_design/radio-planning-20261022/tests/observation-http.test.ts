import { afterEach, describe, expect, it, vi } from 'vitest';
import { createObservationHttp } from '../src/services/observation-http';
import { assertObservationQuery } from '../src/services/observation-validation';
import { OBSERVATION_ORIGIN } from '../src/types/observation';
import type { ObservationFrame, ObservationServices } from '../src/types/observation';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import type { ObservationImportFile, ObservationImportFileV2 } from '../src/types/observation';

describe('R2显式导入已认证适配', () => {
  function file(): ObservationImportFile {
    const { datasetId: _id, datasetRevision: _rev, dataOrigin: _origin, ...raw } = frame();
    return { schemaVersion: 1, fileKind: 'SPECTRUM_OBSERVATION_DATASET', dataOrigin: OBSERVATION_ORIGIN,
      dataset: { datasetId: selection.datasetId, provenanceNote: '显式构造，非实测', resourceRevision: 'resource-v1',
        deviceStatusSnapshotId: null, source: summary().source, frames: [raw] } };
  }
  it('新增写入口禁止无会话工厂降级fetch', async () => {
    const fetcher = vi.fn(), api = createObservationHttp({ baseUrl: () => '/api/v1', fetcher });
    await expect(api.previewObservationImport({ file: file() })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it('预检发起时冻结嵌套文件，保留同一signal', async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn((_path: string, _init?: RequestInit) => new Promise(resolve => { finish = resolve; }));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', authenticatedRequest: request as AuthenticatedRequest });
    const controller = new AbortController(), input = { file: file(), signal: controller.signal }, original = structuredClone(input.file);
    const pending = api.previewObservationImport(input); input.file.dataset.source.name = '晚到修改'; input.file.dataset.frames[0].label = '晚到修改';
    finish({ schemaVersion: 1, dataOrigin: OBSERVATION_ORIGIN, previewHash: hash, datasetId: original.dataset.datasetId, resourceRevision: original.dataset.resourceRevision,
      source: original.dataset.source, frameCount: 1, sourceBinding: 'DECLARED_ONLY', warnings: ['来源声明，非实测'] });
    expect((await pending).source.name).toBe(original.dataset.source.name);
    expect(request.mock.calls[0][1]?.signal).toBe(controller.signal); expect(JSON.parse(request.mock.calls[0][1]?.body as string).file).toEqual(original);
  });
});

const hash = 'a'.repeat(64), revision = 'observation-' + hash;
const selection = { datasetId: 'obs:A', datasetRevision: revision };
const stamp = '2026-10-05T01:00:00.000000Z';
function statusFile(): ObservationImportFileV2 {
  const { datasetId: _id, datasetRevision: _revision, dataOrigin: _origin, ...raw } = frame();
  return { schemaVersion: 2, fileKind: 'SPECTRUM_OBSERVATION_DATASET', dataOrigin: OBSERVATION_ORIGIN,
    dataset: { datasetId: selection.datasetId, provenanceNote: '显式构造，非实测', resourceRevision: 'resource-v1', deviceStatusSnapshotId: null, source: summary().source, frames: [raw] },
    deviceStatusRef: { snapshotId: 'DSS-' + 'b'.repeat(32), snapshotRevision: 'device-status-' + 'c'.repeat(64), resourceRevision: 'resource-v1', deviceIds: ['device-B', 'device-A'] } };
}
function statusWire() { return { ...statusFile().deviceStatusRef, deviceIds: ['device-A', 'device-B'], refRevision: 'OSR-' + 'd'.repeat(64), contentHash: 'd'.repeat(64) }; }
function statusOperation(requestId: string) { return { schemaVersion: 2, dataOrigin: OBSERVATION_ORIGIN, requestId, operationType: 'OBSERVATION_IMPORT', status: 'COMMITTED',
  receipt: { requestId, actorId: 'actor', ...selection, dataOrigin: OBSERVATION_ORIGIN, resourceRevision: 'resource-v1', frameCount: 1, changed: true, importedAt: stamp }, deviceStatusRef: statusWire() }; }
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

describe('V2冻结状态关联与V1兼容', () => {
  it('预检冻结嵌套Ref/成员，返回正文hash不等于预检hash', async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn((_path: string, _init?: RequestInit) => new Promise(done => { finish = done; }));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', authenticatedRequest: request as AuthenticatedRequest });
    const input = { file: statusFile(), signal: new AbortController().signal }, original = structuredClone(input.file);
    const pending = api.previewObservationImport(input); input.file.deviceStatusRef.deviceIds.push('late'); input.file.deviceStatusRef.snapshotId = 'DSS-' + '0'.repeat(32);
    finish({ schemaVersion: 2, dataOrigin: OBSERVATION_ORIGIN, previewHash: 'e'.repeat(64), datasetContentHash: hash, datasetRevision: revision,
      datasetId: selection.datasetId, resourceRevision: 'resource-v1', source: original.dataset.source, frameCount: 1, sourceBinding: 'DECLARED_ONLY', warnings: ['构造非实测'], deviceStatusRef: statusWire() });
    expect((await pending).schemaVersion).toBe(2); expect(JSON.parse(request.mock.calls[0][1]!.body as string).file).toEqual(original); expect(request.mock.calls[0][1]!.signal).toBe(input.signal);
  });
  it('提交只把datasetContentHash当正文版本，并精确核对绑定', async () => {
    const request = vi.fn(async () => statusOperation('v2-request'));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', authenticatedRequest: request as AuthenticatedRequest });
    const input = { file: statusFile(), requestId: 'v2-request', previewHash: 'e'.repeat(64), datasetContentHash: hash };
    expect((await api.importObservation(input)).receipt?.datasetRevision).toBe(revision);
    request.mockResolvedValueOnce({ ...statusOperation('v2-request'), deviceStatusRef: { ...statusWire(), deviceIds: ['device-A'] } });
    await expect(api.importObservation(input)).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_RESPONSE' });
    request.mockResolvedValueOnce({ ...statusOperation('v2-request'), receipt: { ...statusOperation('v2-request').receipt, datasetRevision: 'observation-' + input.previewHash } });
    await expect(api.importObservation(input)).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_RESPONSE' });
  });
  it('回执投影和新GET保持发起查询，跨协议回执拒绝', async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn((_path: string, _init?: RequestInit) => new Promise(done => { finish = done; }));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', authenticatedRequest: request as AuthenticatedRequest });
    const input = { requestId: 'original', includeDeviceStatusRef: true, signal: new AbortController().signal };
    const pending = api.getObservationImportReceipt(input); input.requestId = 'late'; input.includeDeviceStatusRef = false;
    finish(statusOperation('original')); expect((await pending).schemaVersion).toBe(2); expect(request.mock.calls[0][0]).toContain('/imports/original?include_device_status_ref=true');
    const query = { ...selection, signal: input.signal }, refRead = api.getObservationDeviceStatusRef(query); query.datasetId = 'late';
    finish({ ...selection, schemaVersion: 1, dataOrigin: OBSERVATION_ORIGIN, resourceRevision: 'resource-v1', deviceStatusRef: statusWire() });
    expect((await refRead).datasetId).toBe(selection.datasetId); expect(request.mock.calls[1][1]!.signal).toBe(input.signal);
    const cross = api.getObservationImportReceipt({ requestId: 'cross', includeDeviceStatusRef: true });
    const { deviceStatusRef: _ref, ...old } = statusOperation('cross'); finish({ ...old, schemaVersion: 1 });
    await expect(cross).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_RESPONSE' });
  });
  it('导出显式要求完整关联，默认V1不可悄悄变V2', async () => {
    const request = vi.fn(async (_path: string, _init?: RequestInit, _responseType?: string) => new Blob([JSON.stringify(statusFile())]));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', authenticatedRequest: request as AuthenticatedRequest });
    expect((await api.exportObservationDataset({ ...selection, includeDeviceStatusRef: true })).size).toBeGreaterThan(0);
    expect(request.mock.calls[0][0]).toContain('include_device_status_ref=true');
    await expect(api.exportObservationDataset(selection)).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_RESPONSE' });
  });
});

describe('P07 独立只读频谱适配器', () => {
  it('默认仍为15000ms，且超时终止已认证读取', async () => {
    vi.useFakeTimers();
    const request = vi.fn((_path: string, _init?: RequestInit) => new Promise(() => {}));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', authenticatedRequest: request as AuthenticatedRequest });
    const pending = expect(api.loadObservationContext()).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(14999); expect(request.mock.calls[0][1]!.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(request.mock.calls[0][1]!.signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('动态超时按请求捕获一次，大于15秒不截断，后续变更只影响下一请求', async () => {
    vi.useFakeTimers();
    let budget = 30000, finish!: (value: unknown) => void;
    const timeoutMs = vi.fn(() => budget);
    const request = vi.fn((_path: string, _init?: RequestInit) => new Promise(resolve => { finish = resolve; }));
    const api = createObservationHttp({ baseUrl: () => '/api/v1', timeoutMs, authenticatedRequest: request as AuthenticatedRequest });
    expect(timeoutMs).not.toHaveBeenCalled();
    const first = expect(api.loadObservationContext()).resolves.toEqual(context());
    expect(timeoutMs).toHaveBeenCalledTimes(1); budget = 10;
    await vi.advanceTimersByTimeAsync(15001); expect(request.mock.calls[0][1]!.signal?.aborted).toBe(false);
    finish(context()); await first; expect(vi.getTimerCount()).toBe(0);
    const second = expect(api.loadObservationContext()).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(timeoutMs).toHaveBeenCalledTimes(2); budget = 60000;
    await vi.advanceTimersByTimeAsync(10); await second;
    expect(request.mock.calls[1][1]!.signal?.aborted).toBe(true); expect(timeoutMs).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('四个只读方法都在请求首次await前取当前超时值', async () => {
    const values = [context(), { schemaVersion: 1, dataOrigin: OBSERVATION_ORIGIN, items: [summary()], page: 1, pageSize: 20, total: 1 },
      { ...identity(), items: [frame(0), frame(1)], page: 1, pageSize: 20, total: 2 }, single()];
    const timeoutMs = vi.fn(() => 25000), request = vi.fn(async () => values.shift());
    const api = createObservationHttp({ baseUrl: () => '/api/v1', timeoutMs, authenticatedRequest: request as AuthenticatedRequest });
    const runs = [() => api.loadObservationContext(), () => api.queryObservationDatasets({ page: 1, pageSize: 20 }),
      () => api.queryObservationFrames({ ...selection, page: 1, pageSize: 20 }), () => api.getObservationFrame({ ...selection, index: 0 })];
    for (const [index, run] of runs.entries()) {
      const pending = run(); expect(timeoutMs).toHaveBeenCalledTimes(index + 1); expect(request).toHaveBeenCalledTimes(index + 1); await pending;
    }
  });

  it.each([0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '15000', null, undefined, true])('回调非法超时%j在网络和计时器创建前拒绝', async value => {
    vi.useFakeTimers();
    const request = vi.fn(), fetcher = vi.fn(), timeoutMs = vi.fn(() => value as number);
    const api = createObservationHttp({ baseUrl: () => '/api/v1', timeoutMs, authenticatedRequest: request as AuthenticatedRequest, fetcher });
    await expect(api.loadObservationContext()).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_QUERY' });
    expect(timeoutMs).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('回调异常明确失败且不回退默认值，之后请求可读取恢复后的设置', async () => {
    vi.useFakeTimers();
    const timeoutMs = vi.fn((): number => { throw new Error('构造运行快照读取异常'); }), request = vi.fn(async () => context());
    const api = createObservationHttp({ baseUrl: () => '/api/v1', timeoutMs, authenticatedRequest: request as AuthenticatedRequest });
    await expect(api.loadObservationContext()).rejects.toMatchObject({ code: 'INVALID_OBSERVATION_QUERY', message: '读取观测超时设置失败' });
    expect(request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    timeoutMs.mockReturnValue(25000); expect(await api.loadObservationContext()).toEqual(context()); expect(timeoutMs).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('数字超时%j保留构造期严格校验', timeoutMs => {
    expect(() => createObservationHttp({ baseUrl: () => '/api/v1', timeoutMs })).toThrowError(expect.objectContaining({ code: 'INVALID_OBSERVATION_QUERY' }));
  });

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
