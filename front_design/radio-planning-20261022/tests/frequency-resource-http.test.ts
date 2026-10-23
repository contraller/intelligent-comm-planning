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
