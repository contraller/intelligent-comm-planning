import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { effectScope, nextTick, ref } from 'vue';
import { createMockService } from '../src/services/mock';
import { createResourceStatusMock } from '../src/services/resource-status-mock';
import { initialResources } from '../src/mocks/resource-presets';
import { initialMeta } from '../src/services/resource-storage';
import { validateStatusBatch, validObservationTime, validateStatusCatalog } from '../src/services/resource-status-validation';
import { deviceStatusDisplay, mergeDeviceStatuses } from '../src/services/resource-status-display';
import { useResourceStatusEntry, useResourceStatusStore } from '../src/stores/resource-status';
import { usePreviewStore } from '../src/stores/preview';
import { previewService } from '../src/services';
import type { DeviceStatusBatch, DeviceStatusQuery } from '../src/types/resource-status';
import { TestStorage } from './helpers/storage';
import { authorizeStore } from './helpers/auth';

const request: DeviceStatusQuery = { context: 'ledger', resourceRevision: 'initial', deviceIds: ['DV-0001', 'DV-0002', 'DV-0004'], exampleId: 'abnormal' };
async function fixture() {
  const storage = new TestStorage(), raw = createMockService(() => storage), data = await raw.loadPreview();
  const batch = await raw.queryDeviceStatuses(request); return { storage, raw, data, batch };
}
describe('设备状态独立 Mock 与回包校验', () => {
  it('414 台固定观测与当前资源/历史快照独立，重复读取采样身份不变且零写入', async () => {
    const s = await fixture(), before = JSON.stringify(s.data), q = { ...request, deviceIds: s.data.resources.devices.map(d => d.id), exampleId: 'normal' };
    const first = await s.raw.queryDeviceStatuses(q), second = await s.raw.queryDeviceStatuses(q);
    expect(first.items).toHaveLength(414); expect(second.items).toEqual(first.items); expect(second.batchId).not.toBe(first.batchId);
    expect(first.items.every(i => i.outcome === 'REPORTED')).toBe(true); expect(JSON.stringify(await s.raw.loadPreview())).toBe(before); expect(s.storage.writes).toBe(0);
  });
  it('异常、缺报、失败均是固定示例，整批失败不返回伪成功', async () => {
    const s = await fixture(); expect(s.batch.items[0]).toMatchObject({ outcome: 'REPORTED', observation: { status: 'FAULT', alert: true } });
    expect(s.batch.items[2]).toMatchObject({ observation: { status: null, alert: null } });
    const partial = await s.raw.queryDeviceStatuses({ ...request, exampleId: 'partial' });
    expect(partial.items.map(i => i.outcome)).toEqual(['NO_REPORT', 'FAILED', 'REPORTED']);
    await expect(s.raw.queryDeviceStatuses({ ...request, exampleId: 'failed' })).rejects.toMatchObject({ code: 'DEVICE_STATUS_READ_FAILED' });
    expect(s.storage.writes).toBe(0);
  });
  it.each(['new', 'station', 'model', 'import'])('%s 设备关联没有预设就明确缺报', async kind => {
    const resources = initialResources(), d = resources.devices[0];
    if (kind === 'new') { d.id = 'NEW'; d.origin = 'MANUAL'; }
    if (kind === 'station') d.stationId = resources.stations[1].id;
    if (kind === 'model') d.modelId = 'OTHER';
    if (kind === 'import') d.origin = 'IMPORT';
    const api = createResourceStatusMock(() => ({ resources, meta: initialMeta() }));
    expect((await api.queryDeviceStatuses({ ...request, deviceIds: [d.id] })).items[0]).toMatchObject({ outcome: 'NO_REPORT' });
  });
  it('请求缺失、重复、未知 ID 和过期版本都拒绝；配置损坏不回退', async () => {
    const s = await fixture();
    for (const patch of [{ deviceIds: [] }, { deviceIds: ['DV-0001', 'DV-0001'] }, { deviceIds: ['NO'] }, { resourceRevision: 'old' }])
      await expect(s.raw.queryDeviceStatuses({ ...request, ...patch })).rejects.toThrow();
    const api = createResourceStatusMock(() => { throw new Error('存储损坏'); });
    await expect(api.loadDeviceStatusContext(request)).rejects.toThrow('存储损坏');
  });
  it.each(['missing', 'extra', 'duplicate', 'station', 'model', 'revision', 'source', 'status', 'alert', 'time', 'sequence', 'failed-observation'])('损坏 %s 拒绝整批', async kind => {
    const s = await fixture(), value = structuredClone(s.batch) as any, row = value.items[0];
    if (kind === 'missing') value.items.pop();
    if (kind === 'extra') value.items.push({ ...row, deviceId: 'EXTRA' });
    if (kind === 'duplicate') value.items[1] = row;
    if (kind === 'station') row.stationId = 'WRONG';
    if (kind === 'model') row.modelId = 'WRONG';
    if (kind === 'revision') value.resourceRevision = 'old';
    if (kind === 'source') value.source.id = 'other';
    if (kind === 'status') row.observation.status = 'DEGRADED';
    if (kind === 'alert') row.observation.alert = undefined;
    if (kind === 'time') row.observation.observedAt = '2026-02-30T10:00:00Z';
    if (kind === 'sequence') row.observation.sequence = -1;
    if (kind === 'failed-observation') { row.outcome = 'FAILED'; row.reason = '失败'; }
    expect(() => validateStatusBatch(value, request, s.data.resources, s.batch.source)).toThrow();
  });
  it('目录和真实带时区日历时间校验', async () => {
    const s = await fixture(), catalog = await s.raw.loadDeviceStatusContext(request);
    expect(() => validateStatusCatalog(catalog, request)).not.toThrow();
    expect(() => validateStatusCatalog({ ...catalog, examples: [catalog.examples![0], catalog.examples![0]] }, request)).toThrow();
    for (const v of ['2026-02-29T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00', '2026-01-01T00:00:00+14:30']) expect(validObservationTime(v)).toBe(false);
    expect(validObservationTime('2024-02-29T23:59:59+08:00')).toBe(true);
  });
});

describe('观测显示合并', () => {
  it('无上报/失败保留上次值并标记，未同步不借基线；未知告警不补 false', async () => {
    const s = await fixture(), records = mergeDeviceStatuses({}, s.batch, 'fetch-1');
    const batch: DeviceStatusBatch = { ...s.batch, items: s.batch.items.map(i => ({ deviceId: i.deviceId, stationId: i.stationId, modelId: i.modelId, outcome: 'FAILED', reason: '断开' })) };
    const next = mergeDeviceStatuses(records, batch, 'fetch-2');
    expect(deviceStatusDisplay(s.data.resources.devices[0], 'observed', next['DV-0001'])).toMatchObject({ status: 'FAULT', retained: true, fetchedAt: 'fetch-2' });
    expect(deviceStatusDisplay(s.data.resources.devices[0], 'observed')).toMatchObject({ status: null, alert: null });
    expect(deviceStatusDisplay(s.data.resources.devices[3], 'observed', records['DV-0004'])).toMatchObject({ status: null, alert: null });
  });
  it('旧序号保留新记录，同序号内容冲突整批拒绝且原输入不变', async () => {
    const s = await fixture(), records = mergeDeviceStatuses({}, s.batch, 'fetch-1'), before = JSON.stringify(records);
    const old = structuredClone(s.batch); if (old.items[0].outcome === 'REPORTED') old.items[0].observation.sequence = 0;
    expect(mergeDeviceStatuses(records, old, 'fetch-2')['DV-0001']).toMatchObject({ retained: true, observation: { sequence: 1 } });
    const bad = structuredClone(s.batch); if (bad.items[1].outcome === 'REPORTED') bad.items[1].observation.status = 'FAULT';
    expect(() => mergeDeviceStatuses(records, bad, 'fetch-2')).toThrow('冲突'); expect(JSON.stringify(records)).toBe(before);
  });
});

let pinia: ReturnType<typeof createPinia> | undefined;
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { scopes.splice(0).forEach(s => s.stop()); if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); });
async function storeFixture() {
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore(); const s = await fixture();
  const preview = usePreviewStore(); preview.data = s.data;
  vi.spyOn(previewService, 'loadDeviceStatusContext').mockImplementation(s.raw.loadDeviceStatusContext);
  vi.spyOn(previewService, 'queryDeviceStatuses').mockImplementation(s.raw.queryDeviceStatuses);
  const status = useResourceStatusStore(), key = Symbol(); await status.load('ledger', key, () => true);
  return { ...s, auth, preview, status, key, sync: () => status.sync('ledger', request.deviceIds, key, () => true) };
}
describe('同标签页状态生命周期', () => {
  it('有效同步才切来源，改示例清缓存，基线切换不请求、不改资源历史', async () => {
    const s = await storeFixture(), before = JSON.stringify(s.preview.data); expect(s.status.mode).toBe('baseline');
    s.status.setExample('abnormal'); await s.sync(); expect(s.status.mode).toBe('observed');
    expect(s.status.display(s.data.resources.devices[0]).status).toBe('FAULT');
    s.status.setMode('baseline'); s.status.setMode('observed'); expect(previewService.queryDeviceStatuses).toHaveBeenCalledTimes(1);
    s.status.setExample('partial'); expect(s.status.records).toEqual({}); expect(s.status.mode).toBe('baseline');
    expect(JSON.stringify(s.preview.data)).toBe(before); expect(s.storage.writes).toBe(0);
  });
  it('损坏批次和整批失败保持原观测；初次失败保留基线', async () => {
    const s = await storeFixture(); vi.mocked(previewService.queryDeviceStatuses).mockRejectedValueOnce(new Error('不可读'));
    await s.sync(); expect(s.status.mode).toBe('baseline'); expect(s.status.error).toContain('不可读');
    await s.sync(); const before = JSON.stringify(s.status.records);
    vi.mocked(previewService.queryDeviceStatuses).mockResolvedValueOnce({ ...s.batch, items: [] }); await s.sync();
    expect(s.status.error).not.toBe(''); expect(JSON.stringify(s.status.records)).toBe(before); expect(s.status.mode).toBe('observed');
  });
  it.each(['resource', 'session', 'permission', 'example', 'leave'])('%s 变化隔离迟到响应', async kind => {
    const s = await storeFixture(); let finish!: (b: DeviceStatusBatch) => void;
    vi.mocked(previewService.queryDeviceStatuses).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = s.sync(); expect(s.status.busy).toBe(true);
    if (kind === 'resource') s.preview.data!.resourceMeta.revision = 'changed';
    if (kind === 'session') s.auth.accept({ ...s.auth.identity!, sessionId: 'another' });
    if (kind === 'permission') s.auth.accept({ ...s.auth.identity!, permissions: [] });
    if (kind === 'example') s.status.setExample('partial');
    if (kind === 'leave') s.status.cancel(s.key);
    finish(s.batch); await pending; expect(s.status.records).toEqual({}); expect(s.status.mode).toBe('baseline'); expect(s.status.busy).toBe(false);
  });
  it('同入口重复请求合并为一次；关闭后共享已完成缓存，GIS 编辑暂停不丢偏好', async () => {
    const s = await storeFixture(); await s.sync(); const records = JSON.stringify(s.status.records);
    const enabled = ref(true), scope = effectScope(); scopes.push(scope);
    const entry = scope.run(() => useResourceStatusEntry('gis', () => enabled.value))!;
    expect(entry.status.mode).toBe('observed'); expect(JSON.stringify(entry.status.records)).toBe(records);
    enabled.value = false; await nextTick(); expect(entry.available.value).toBe(false); expect(s.status.mode).toBe('observed');
    enabled.value = true; await nextTick();
    let finish!: (b: DeviceStatusBatch) => void;
    vi.mocked(previewService.queryDeviceStatuses).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = entry.sync(request.deviceIds); await entry.sync(request.deviceIds); expect(previewService.queryDeviceStatuses).toHaveBeenCalledTimes(2);
    scope.stop(); finish(s.batch); await pending; expect(JSON.stringify(s.status.records)).toBe(records);
  });
});
