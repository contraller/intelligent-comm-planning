import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { createFrequencyResourceHttp } from '../src/services/frequency-resource-http';
import { ApiError } from '../src/services/types';

const base = 'resource-1111111111111111', next = 'resource-2222222222222222';
const origin = { data_origin: 'SYNTHETIC_INTEGRATION', source: '项目构造资源基线，非生产、非实测' };
const query = () => ({ context: 'ledger' as const, revision: base });
const validationInput = () => ({ ...query(), ids: ['FQ-0002', 'FQ-0001'] });
const input = () => ({ context: 'ledger' as const, baseRevision: base, requestId: 'disable-1', ids: ['FQ-0002', 'FQ-0001'] });
const item = (id: string, available = true) => ({
  freq_id: id, device_class: 'HF', center_freq_khz: 3000, bandwidth_khz: null, channel_no: null,
  is_available: available, occupied_by: null, reuse_min_distance_m: null, adjacent_guard_khz: null, note: null,
});

const pagedInput = () => ({ context: 'ledger' as const, revision: base, page: 1, pageSize: 5 as const });
const paged = () => ({ ...snapshot(), page: 1, page_size: 5, total: 2 });
const summary = () => ({ operation: 'FREQUENCY_DISABLE', request_id: 'disable-1', created_at: '2026-10-23T00:00:00Z',
  base_revision: base, revision: next, changed: true, selected_count: 2, updated_count: 1, unchanged_count: 1 });
const operation = () => ({ operation: 'FREQUENCY_DISABLE', request_id: 'disable-1', created_at: '2026-10-23T00:00:00Z', receipt: receipt() });
describe('R2 频点服务器查询及原回执', () => {
  it('严格序列化筛选分页，使用服务器总数和同版原值', async () => {
    const f = fixture(paged());
    const result = await f.api.queryFrequencyResources({ ...pagedInput(), deviceClass: 'HF', minKhz: 3000, maxKhz: 3000, search: 'FQ' });
    const url = new URL('http://example.test' + f.request.mock.calls[0][0]);
    expect(url.pathname).toBe('/resource/frequency-resources/query');
    expect(Object.fromEntries(url.searchParams)).toEqual({ context: 'ledger', revision: base, page: '1', page_size: '5',
      device_class: 'HF', min_khz: '3000', max_khz: '3000', search: 'FQ' });
    expect(result).toMatchObject({ total: 2, page: 1, pageSize: 5, revision: base });
  });
  it('空筛选与越界页是有效服务器结果，不补造记录', async () => {
    const f = fixture({ ...paged(), page: 99, items: [] });
    expect((await f.api.queryFrequencyResources({ ...pagedInput(), page: 99 })).items).toEqual([]);
    expect((await fixture({ ...paged(), total: 0, items: [] }).api.queryFrequencyResources(pagedInput())).total).toBe(0);
  });
  it.each([{ page: 0 }, { page: 1.5 }, { pageSize: 7 }, { pageSize: '5' }, { search: '\n' }, { search: 'x'.repeat(121) },
    { minKhz: NaN }, { maxKhz: Infinity }, { minKhz: 5000, maxKhz: 3000 }, { availability: 'ALL' }, { deviceClass: 'OTHER' }, { actorId: 'admin' }])('拒绝非法分页筛选 %j', async patch => {
    const f = fixture(paged());
    await expect(f.api.queryFrequencyResources({ ...pagedInput(), ...patch } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([{ page: 2 }, { page_size: 10 }, { total: 0 }, { items: [] }, { total: 2.1 }, { total: 8 }, { revision: next }])('分页结果不能错页、错版或伪报数量 %j', async patch => {
    await expect(fixture({ ...paged(), ...patch }).api.queryFrequencyResources(pagedInput())).rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });
  it('拒绝返回不符合筛选的行', async () => {
    for (const filters of [{ availability: 'AVAILABLE' as const }, { deviceClass: 'VUHF' as const }, { minKhz: 4000 }, { maxKhz: 2000 }, { search: 'missing' }])
      await expect(fixture(paged()).api.queryFrequencyResources({ ...pagedInput(), ...filters })).rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });
  it('历史分页及原回执不绑定当前资源版本', async () => {
    const f = fixture({ page: 1, page_size: 5, total: 1, items: [summary()] });
    const history = await f.api.queryFrequencyOperations({ context: 'ledger', page: 1, pageSize: 5, search: 'disable' });
    expect(f.request.mock.calls[0][0]).toBe('/resource/frequency-resources/operations?context=ledger&page=1&page_size=5&search=disable');
    expect(history.items[0]).toMatchObject({ requestId: 'disable-1', selectedCount: 2, updatedCount: 1, unchangedCount: 1 });
    const value = await fixture(operation()).api.getFrequencyOperation({ context: 'ledger', requestId: 'disable-1' });
    expect(value.receipt.baseRevision).toBe(base); expect(value.receipt.revision).toBe(next);
  });
  it('回执路径编码合法的斜线和百分号编号', async () => {
    const requestId = 'request/id%_';
    const f = fixture({ ...operation(), request_id: requestId, receipt: { ...receipt(), request_id: requestId } });
    await f.api.getFrequencyOperation({ context: 'ledger', requestId });
    expect(f.request.mock.calls[0][0]).toBe('/resource/frequency-resources/operations/request%2Fid%25_?context=ledger');
  });
  it.each([{ updated_count: 3 }, { selected_count: 0 }, { changed: false }, { operation: 'DEVICE' }, { created_at: 'unknown' }])('损坏历史摘要必须拒绝 %j', async patch => {
    await expect(fixture({ page: 1, page_size: 5, total: 1, items: [{ ...summary(), ...patch }] }).api.queryFrequencyOperations({ context: 'ledger', page: 1, pageSize: 5 }))
      .rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });
  it('历史摘要拒绝重复、错序和搜索不匹配', async () => {
    const data = { page: 1, page_size: 5, total: 2, items: [summary(), summary()] };
    await expect(fixture(data).api.queryFrequencyOperations({ context: 'ledger', page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
    data.items[1] = { ...summary(), request_id: 'later', created_at: '2026-10-24T00:00:00Z' };
    await expect(fixture(data).api.queryFrequencyOperations({ context: 'ledger', page: 1, pageSize: 5 })).rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
    await expect(fixture({ ...data, total: 1, items: [summary()] }).api.queryFrequencyOperations({ context: 'ledger', page: 1, pageSize: 5, search: 'missing' })).rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });
  it('历史顺序保留微秒而不在同毫秒错误比较请求号', async () => {
    const data = { page: 1, page_size: 5, total: 2, items: [
      { ...summary(), request_id: 'z-first', created_at: '2026-10-23T00:00:00.123456+00:00' },
      { ...summary(), request_id: 'a-second', created_at: '2026-10-23T00:00:00.123455Z' },
    ] };
    await expect(fixture(data).api.queryFrequencyOperations({ context: 'ledger', page: 1, pageSize: 5 })).resolves.toMatchObject({ total: 2 });
    await expect(fixture({ ...data, items: [...data.items].reverse() }).api.queryFrequencyOperations({ context: 'ledger', page: 1, pageSize: 5 }))
      .rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });
  it('同一时刻的不同ISO表示使用真实时刻及后端Unicode编号顺序', async () => {
    const data = { page: 1, page_size: 5, total: 2, items: [
      { ...summary(), request_id: '\ue000', created_at: '2026-10-23T08:00:00.1234+08:00' },
      { ...summary(), request_id: '\u{10000}', created_at: '2026-10-23T00:00:00.123400Z' },
    ] };
    await expect(fixture(data).api.queryFrequencyOperations({ context: 'ledger', page: 1, pageSize: 5 })).resolves.toMatchObject({ total: 2 });
    await expect(fixture({ ...data, items: [...data.items].reverse() }).api.queryFrequencyOperations({ context: 'ledger', page: 1, pageSize: 5 }))
      .rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });
  it.each([{ request_id: 'other' }, { operation: 'DEVICE' }, { created_at: 'bad' }, { receipt: { ...receipt(), request_id: 'other' } },
    { receipt: { ...receipt(), items: [] } }])('读取原回执拒绝错归属或损坏 %j', async patch => {
    await expect(fixture({ ...operation(), ...patch }).api.getFrequencyOperation({ context: 'ledger', requestId: 'disable-1' })).rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });
  it('三个新方法冻结等待前的筛选与请求号', async () => {
    const list = deferredFixture(), q = pagedInput(); const listPromise = list.api.queryFrequencyResources(q);
    q.page = 99; q.revision = next; list.complete(paged());
    expect((await listPromise).page).toBe(1);
    const history = deferredFixture(), h = { context: 'ledger' as const, page: 1, pageSize: 5 as const, search: 'disable' };
    const historyPromise = history.api.queryFrequencyOperations(h); h.page = 9; h.search = 'other';
    history.complete({ page: 1, page_size: 5, total: 1, items: [summary()] }); expect((await historyPromise).items[0].requestId).toBe('disable-1');
    const detail = deferredFixture(), d = { context: 'ledger' as const, requestId: 'disable-1' };
    const detailPromise = detail.api.getFrequencyOperation(d); d.requestId = 'other'; detail.complete(operation());
    expect((await detailPromise).requestId).toBe('disable-1');
  });
});
const snapshot = () => ({ ...origin, revision: base, base_revision: base, content_hash: 'a'.repeat(64),
  items: [item('FQ-0001', false), item('FQ-0002')] });
const preview = () => ({ ...snapshot(), selected_ids: ['FQ-0001', 'FQ-0002'], would_disable: ['FQ-0002'], unchanged: ['FQ-0001'],
  impact: { resource_revision_will_change: true, historical_resources_preserved: true,
    saved_plans_require_recompute: true, link_impact: 'UNKNOWN' } });
const receipt = () => ({ ...origin, object_id: 'resource-frequency-disable', request_id: 'disable-1', base_revision: base,
  revision: next, read_revision: next, selected_ids: ['FQ-0001', 'FQ-0002'], updated: ['FQ-0002'], unchanged: ['FQ-0001'],
  affected_ids: ['FQ-0002'], items: [item('FQ-0001', false), item('FQ-0002', false)], warnings: [], changed: true });
function fixture(data: unknown) {
  const request = vi.fn<AuthenticatedRequest>().mockResolvedValue(data);
  return { request, api: createFrequencyResourceHttp(request as AuthenticatedRequest) };
}
function deferredFixture() {
  let complete!: (data: unknown) => void;
  const response = new Promise<unknown>(resolve => { complete = resolve; });
  const result = fixture(null);
  result.request.mockReturnValue(response);
  return { ...result, complete };
}

describe('规划频点停用独立 HTTP 契约', () => {
  it('读取明确版本，保留原禁用频点及未知数据', async () => {
    const f = fixture(snapshot()), signal = new AbortController().signal;
    const result = await f.api.loadFrequencyResources(query(), signal);
    expect(f.request).toHaveBeenCalledExactlyOnceWith(`/resource/frequency-resources?context=ledger&revision=${base}`, { signal });
    expect(result).toMatchObject({ revision: base, baseRevision: base, dataOrigin: origin.data_origin,
      items: [{ freqId: 'FQ-0001', isAvailable: false, bandwidthKhz: null, channelNo: null, occupiedBy: null,
        reuseMinDistanceM: null, adjacentGuardKhz: null, note: null }, { freqId: 'FQ-0002', isAvailable: true }] });
  });

  it('只读校验序列化精确字段，输入清单不被排序改写', async () => {
    const f = fixture(preview()), request = validationInput(), before = [...request.ids];
    const result = await f.api.validateFrequencyDisable(request);
    expect(request.ids).toEqual(before);
    const [path, init] = f.request.mock.calls[0];
    expect(path).toBe('/resource/frequency-resources/disable/validate');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ context: 'ledger', revision: base, ids: ['FQ-0001', 'FQ-0002'] });
    expect(result).toMatchObject({ selectedIds: ['FQ-0001', 'FQ-0002'], wouldDisable: ['FQ-0002'], unchanged: ['FQ-0001'],
      impact: { linkImpact: 'UNKNOWN', resourceRevisionWillChange: true, historicalResourcesPreserved: true } });
  });

  it('保存只发送停用所需字段，并严格关联回执与输入', async () => {
    const f = fixture(receipt()), request = input(), signal = new AbortController().signal;
    const result = await f.api.disableFrequencyResources(request, signal);
    const [path, init] = f.request.mock.calls[0];
    expect(path).toBe('/resource/frequency-resources/disable');
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBe(signal);
    expect(JSON.parse(init?.body as string)).toEqual({ context: 'ledger', base_revision: base,
      request_id: 'disable-1', ids: ['FQ-0001', 'FQ-0002'] });
    expect(result).toMatchObject({ objectId: 'resource-frequency-disable', requestId: 'disable-1', baseRevision: base,
      revision: next, readRevision: next, changed: true, updated: ['FQ-0002'], unchanged: ['FQ-0001'], affectedIds: ['FQ-0002'] });
    expect(result.items.every(row => row.isAvailable === false)).toBe(true);
  });

  it.each([false, true])('读取等待期间改变版本，仍按发起快照核验：返回改后版本=%s', async changedResponse => {
    const f = deferredFixture(), request = query();
    const pending = f.api.loadFrequencyResources(request);
    request.revision = next;
    expect(f.request.mock.calls[0][0]).toBe(`/resource/frequency-resources?context=ledger&revision=${base}`);
    f.complete(changedResponse ? { ...snapshot(), revision: next, base_revision: next } : snapshot());
    if (changedResponse) await expect(pending).rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
    else await expect(pending).resolves.toMatchObject({ revision: base, baseRevision: base });
  });

  it.each([false, true])('预检等待期间改版本和清单，仍按发起快照核验：返回改后输入=%s', async changedResponse => {
    const f = deferredFixture(), request = validationInput(), originalIds = request.ids;
    const pending = f.api.validateFrequencyDisable(request);
    originalIds.splice(0, originalIds.length, 'FQ-9001');
    request.ids = ['FQ-9002'];
    request.revision = next;
    expect(originalIds).toEqual(['FQ-9001']);
    expect(JSON.parse(f.request.mock.calls[0][1]?.body as string)).toEqual({
      context: 'ledger', revision: base, ids: ['FQ-0001', 'FQ-0002'],
    });
    f.complete(changedResponse ? { ...preview(), revision: next, base_revision: next,
      selected_ids: ['FQ-9002'], would_disable: ['FQ-9002'], unchanged: [], items: [item('FQ-9002')] } : preview());
    if (changedResponse) await expect(pending).rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
    else await expect(pending).resolves.toMatchObject({ revision: base, selectedIds: ['FQ-0001', 'FQ-0002'] });
  });

  it.each([false, true])('保存等待期间改版本、请求号和清单，仍按发起快照核验：返回改后输入=%s', async changedResponse => {
    const f = deferredFixture(), request = input(), originalIds = request.ids;
    const pending = f.api.disableFrequencyResources(request);
    originalIds.splice(0, originalIds.length, 'FQ-9001');
    request.ids = ['FQ-9002'];
    request.baseRevision = 'resource-3333333333333333';
    request.requestId = 'changed-request';
    expect(originalIds).toEqual(['FQ-9001']);
    expect(JSON.parse(f.request.mock.calls[0][1]?.body as string)).toEqual({ context: 'ledger',
      base_revision: base, request_id: 'disable-1', ids: ['FQ-0001', 'FQ-0002'] });
    f.complete(changedResponse ? { ...receipt(), base_revision: request.baseRevision, request_id: request.requestId,
      selected_ids: ['FQ-9002'], updated: ['FQ-9002'], unchanged: [], affected_ids: ['FQ-9002'],
      items: [item('FQ-9002', false)] } : receipt());
    if (changedResponse) await expect(pending).rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
    else await expect(pending).resolves.toMatchObject({ baseRevision: base, requestId: 'disable-1',
      selectedIds: ['FQ-0001', 'FQ-0002'], revision: next });
  });

  it('无变化回执保留版本，预检没有虚构影响或新版本', async () => {
    const noChange = { ...receipt(), changed: false, revision: base, read_revision: base,
      updated: [], affected_ids: [], unchanged: ['FQ-0001', 'FQ-0002'] };
    expect((await fixture(noChange).api.disableFrequencyResources(input())).changed).toBe(false);
    const noChangePreview = { ...preview(), items: noChange.items, would_disable: [], unchanged: noChange.unchanged,
      impact: { ...preview().impact, resource_revision_will_change: false, saved_plans_require_recompute: false } };
    expect((await fixture(noChangePreview).api.validateFrequencyDisable(validationInput())).wouldDisable).toEqual([]);
    await expect(fixture({ ...noChange, revision: next, read_revision: next }).api.disableFrequencyResources(input()))
      .rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });

  it.each([
    { ids: [] }, { ids: ['FQ-0002', 'FQ-0002'] }, { ids: Array.from({ length: 51 }, (_, i) => `FQ-${i}`) },
    { ids: [1] }, { ids: [true] }, { ids: [null] }, { ids: 'FQ-0002' }, { ids: ['bad id'] }, { ids: ['x'.repeat(121)] },
    { context: 'gis' }, { baseRevision: 'old' }, { baseRevision: base + '\n' }, { baseRevision: 1 }, { requestId: '' }, { requestId: null },
    { requestId: 'has space' }, { isAvailable: true }, { centerFreqKhz: 4000 }, { actorId: 'admin' }, { source: 'REAL' },
  ])('非法保存请求发送前拒绝 %j', async patch => {
    const f = fixture(receipt());
    await expect(f.api.disableFrequencyResources({ ...input(), ...patch } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([null, [], true, {}, { ...query(), extra: 1 }, { context: 'ledger', revision: 'catalog-' + base },
    { context: 'ledger', revision: undefined }])('非法读取请求拒绝 %j', async value => {
    const f = fixture(snapshot());
    await expect(f.api.loadFrequencyResources(value as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([{ ...validationInput(), ids: [] }, { ...validationInput(), requestId: 'not-allowed' },
    { ...validationInput(), revision: null }, { ...validationInput(), context: 'planning' }])('非法预检请求拒绝 %j', async value => {
    const f = fixture(preview());
    await expect(f.api.validateFrequencyDisable(value as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    { revision: next }, { base_revision: next }, { content_hash: 'bad' }, { content_hash: 'a'.repeat(64) + '\n' },
    { revision: base + '\n', base_revision: base + '\n' }, { data_origin: 'REAL' }, { source: '' },
    { items: {} }, { items: [] }, { items: [item('same'), item('same')] }, { items: [item('FQ-0002'), item('FQ-0001')] }, { extra: 1 },
  ])('拒绝错版、错源、非排序或重复读取结果 %j', async patch => {
    await expect(fixture({ ...snapshot(), ...patch }).api.loadFrequencyResources(query()))
      .rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });

  it.each([
    { center_freq_khz: null }, { center_freq_khz: '3000' }, { center_freq_khz: 0 }, { center_freq_khz: Infinity },
    { bandwidth_khz: -1 }, { bandwidth_khz: 0 }, { channel_no: 1.5 }, { channel_no: -1 }, { channel_no: Number.MAX_SAFE_INTEGER + 1 },
    { is_available: 'false' }, { occupied_by: undefined }, { reuse_min_distance_m: NaN }, { adjacent_guard_khz: -1 },
    { note: 1 }, { device_class: 'UNKNOWN' }, { freq_id: '' },
  ])('逐频点非法字段不能补零或放行 %j', async patch => {
    const data = { ...snapshot(), items: [{ ...item('FQ-0001'), ...patch }] };
    await expect(fixture(data).api.loadFrequencyResources(query())).rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });

  it.each([
    { selected_ids: ['FQ-0001'] }, { would_disable: ['FQ-0001'] }, { unchanged: ['FQ-0002'] },
    { would_disable: ['FQ-0002', 'FQ-0002'] }, { items: [item('FQ-0001'), item('FQ-0002')] },
    { impact: { ...preview().impact, link_impact: 0 } },
    { impact: { ...preview().impact, resource_revision_will_change: false } },
    { impact: { ...preview().impact, historical_resources_preserved: false } },
    { impact: { ...preview().impact, saved_plans_require_recompute: false } },
  ])('预检分区、当前状态和未知影响必须一致 %j', async patch => {
    await expect(fixture({ ...preview(), ...patch }).api.validateFrequencyDisable(validationInput()))
      .rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });

  it.each([
    { object_id: 'device' }, { request_id: 'other' }, { base_revision: next }, { read_revision: base },
    { revision: base, read_revision: base }, { changed: false }, { changed: 'true' },
    { selected_ids: ['FQ-0001', 'other'] }, { affected_ids: [] }, { updated: ['FQ-0001'] },
    { unchanged: [] }, { unchanged: ['FQ-0002'] }, { items: [item('FQ-0001', false), item('FQ-0002', true)] },
    { items: [item('FQ-0001', false)] }, { warnings: [{}] }, { data_origin: 'UNKNOWN' },
  ])('拒绝回执错关联、漏项、假变更或启用点 %j', async patch => {
    await expect(fixture({ ...receipt(), ...patch }).api.disableFrequencyResources(input()))
      .rejects.toMatchObject({ code: 'INVALID_FREQUENCY_RESOURCE_RESPONSE' });
  });

  it.each([1002, 1104, 1105, 1106, 1205, 1206, 5002])('原样传递错误 %s，不重发保存', async code => {
    const f = fixture(null), error = new ApiError('明确拒绝', code, null, 'p04-trace', 409);
    f.request.mockRejectedValue(error);
    await expect(f.api.disableFrequencyResources(input())).rejects.toBe(error);
    expect(f.request).toHaveBeenCalledOnce();
  });
});
