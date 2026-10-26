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
import type { DeviceStatusBatch, DeviceStatusQuery } from '../src/types/resource-status';
import { TestStorage } from './helpers/storage';
import { authorizeStore } from './helpers/auth';
import { ApiError } from '../src/services/types';
import type { DeviceStatusClient } from '../src/services/device-status-http';
import { deviceStatusSchema, type DeviceStatusHeader, type DeviceStatusItem, type DeviceStatusImport, type DeviceStatusReceipt, type StatusPage, type StatusDevices } from '../src/types/device-status-snapshot';

const request: Omit<DeviceStatusQuery, 'resourceRevision'> = { context: 'ledger', deviceIds: ['DV-0001', 'DV-0002', 'DV-0004'], exampleId: 'abnormal' };
async function fixture() {
  const storage = new TestStorage(), raw = createMockService(() => storage), data = await raw.loadPreview();
  // 读取版本由服务返回，不使用保存事务的内部修订或手工拼接版本。
  const workspace = await raw.loadResourceReadContext({ context: 'ledger' });
  const query: DeviceStatusQuery = { ...request, resourceRevision: workspace.revision };
  const batch = await raw.queryDeviceStatuses(query); return { storage, raw, data, batch, query };
}
describe('设备状态独立 Mock 与回包校验', () => {
  it('414 台固定观测与当前资源/历史快照独立，重复读取采样身份不变且零写入', async () => {
    const s = await fixture(), before = JSON.stringify(s.data), q = { ...s.query, deviceIds: s.data.resources.devices.map(d => d.id), exampleId: 'normal' };
    const first = await s.raw.queryDeviceStatuses(q), second = await s.raw.queryDeviceStatuses(q);
    expect(first.items).toHaveLength(414); expect(second.items).toEqual(first.items); expect(second.batchId).not.toBe(first.batchId);
    expect(first.items.every(i => i.outcome === 'REPORTED')).toBe(true); expect(JSON.stringify(await s.raw.loadPreview())).toBe(before); expect(s.storage.writes).toBe(0);
  });
  it('异常、缺报、失败均是固定示例，整批失败不返回伪成功', async () => {
    const s = await fixture(); expect(s.batch.items[0]).toMatchObject({ outcome: 'REPORTED', observation: { status: 'FAULT', alert: true } });
    expect(s.batch.items[2]).toMatchObject({ observation: { status: null, alert: null } });
    const partial = await s.raw.queryDeviceStatuses({ ...s.query, exampleId: 'partial' });
    expect(partial.items.map(i => i.outcome)).toEqual(['NO_REPORT', 'FAILED', 'REPORTED']);
    await expect(s.raw.queryDeviceStatuses({ ...s.query, exampleId: 'failed' })).rejects.toMatchObject({ code: 'DEVICE_STATUS_READ_FAILED' });
    expect(s.storage.writes).toBe(0);
  });
  it.each(['new', 'station', 'model', 'import'])('%s 设备关联没有预设就明确缺报', async kind => {
    const { query } = await fixture();
    const resources = initialResources(), d = resources.devices[0];
    if (kind === 'new') { d.id = 'NEW'; d.origin = 'MANUAL'; }
    if (kind === 'station') d.stationId = resources.stations[1].id;
    if (kind === 'model') d.modelId = 'OTHER';
    if (kind === 'import') d.origin = 'IMPORT';
    const api = createResourceStatusMock(() => ({ resources, meta: initialMeta() }));
    expect((await api.queryDeviceStatuses({ ...query, deviceIds: [d.id] })).items[0]).toMatchObject({ outcome: 'NO_REPORT' });
  });
  it('请求缺失、重复、未知 ID 和过期版本都拒绝；配置损坏不回退', async () => {
    const s = await fixture();
    for (const patch of [{ deviceIds: [] }, { deviceIds: ['DV-0001', 'DV-0001'] }, { deviceIds: ['NO'] }, { resourceRevision: 'old' }])
      await expect(s.raw.queryDeviceStatuses({ ...s.query, ...patch })).rejects.toThrow();
    const api = createResourceStatusMock(() => { throw new Error('存储损坏'); });
    await expect(api.loadDeviceStatusContext(s.query)).rejects.toThrow('存储损坏');
  });
  it.each(['initial', 'saved'] as const)('%s 仅接受当前读取版本，拒绝原始修订且同步不写存储', async phase => {
    const s = await fixture();
    // 保存只用于准备不同修订的资源；随后目录、同步与分页均应保持只读。
    if (phase === 'saved') await s.raw.commitResources({ baseRevision: s.data.resourceMeta.revision, context: 'ledger', stations: [], devices: [{ id: 'DV-0001', antennaHeightM: 19 }] });
    const data = await s.raw.loadPreview(), workspace = await s.raw.loadResourceReadContext({ context: 'ledger' });
    if (phase === 'saved') expect(workspace.revision).not.toBe(s.query.resourceRevision);
    expect(workspace.revision).not.toBe(data.resourceMeta.revision);
    const before = new Map(s.storage.entries), writes = s.storage.writes;
    for (const context of ['ledger', 'gis'] as const) {
      const current = { ...s.query, context, resourceRevision: workspace.revision };
      const original = { ...current, resourceRevision: data.resourceMeta.revision };
      await expect(s.raw.loadDeviceStatusContext(original)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      await expect(s.raw.queryDeviceStatuses(original)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      expect((await s.raw.loadDeviceStatusOptions(current)).resourceRevision).toBe(workspace.revision);
      const summary = await s.raw.synchronizeDeviceStatuses(current);
      expect(summary).toMatchObject({ resourceRevision: workspace.revision, total: current.deviceIds.length });
      const page = await s.raw.queryDeviceStatusBatch({ ...current, batchId: summary.batchId, pageNum: 1, pageSize: 20 });
      expect(page.items.map(row => row.deviceId)).toEqual(current.deviceIds);
    }
    expect(s.storage.entries).toEqual(before); expect(s.storage.writes).toBe(writes);
  });
  it.each(['missing', 'extra', 'duplicate', 'station', 'model', 'revision', 'source', 'status', 'alert', 'time', 'sequence', 'snapshot', 'failed-observation'])('损坏 %s 拒绝整批', async kind => {
    const s = await fixture(), value = { ...structuredClone(s.batch), items: s.batch.items.map((item): Record<string, unknown> => ({ ...structuredClone(item) })) }, row = value.items[0];
    const raw = row.observation;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('测试夹具缺少首条观测');
    const observation = raw as Record<string, unknown>;
    if (kind === 'missing') value.items.pop();
    if (kind === 'extra') value.items.push({ ...row, deviceId: 'EXTRA' });
    if (kind === 'duplicate') value.items[1] = row;
    if (kind === 'station') row.stationId = 'WRONG';
    if (kind === 'model') row.modelId = 'WRONG';
    if (kind === 'revision') value.resourceRevision = 'old';
    if (kind === 'source') value.source.id = 'other';
    if (kind === 'status') observation.status = 'DEGRADED';
    if (kind === 'alert') observation.alert = undefined;
    if (kind === 'time') observation.observedAt = '2026-02-30T10:00:00Z';
    if (kind === 'sequence') observation.sequence = -1;
    if (kind === 'snapshot') value.snapshotId = ' ';
    if (kind === 'failed-observation') { row.outcome = 'FAILED'; row.reason = '失败'; }
    expect(() => validateStatusBatch(value, s.query, s.data.resources, s.batch.source)).toThrow();
  });
  it('目录和真实带时区日历时间校验', async () => {
    const s = await fixture(), catalog = await s.raw.loadDeviceStatusContext(s.query);
    expect(() => validateStatusCatalog(catalog, s.query)).not.toThrow();
    expect(() => validateStatusCatalog({ ...catalog, examples: [catalog.examples![0], catalog.examples![0]] }, s.query)).toThrow();
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
const snapshotRevision = 'resource-1111111111111111';
function snapshotHeader(): DeviceStatusHeader {
  return { schema_version: deviceStatusSchema, snapshot_id: 'DSS-' + 'a'.repeat(32), snapshot_revision: 'device-status-' + 'b'.repeat(64),
    content_hash: 'b'.repeat(64), resource_revision: snapshotRevision, resource_content_hash: 'c'.repeat(64), data_origin: 'SYNTHETIC_INTEGRATION',
    source_label: '单测显式构造快照', provenance_note: '非设备遥测', imported_at: '2026-10-23T10:00:00.000000Z', actor_id: 'editor', total: 1,
    counts: { NORMAL: 0, FAULT: 1, OFFLINE: 0, UNKNOWN: 0, total: 1 }, first_observed_at: null, last_observed_at: null };
}
function snapshotItem(): DeviceStatusItem {
  return { device_id: 'DV-0001', node_id: 'ND-0001', model_id: 'DM-0004', availability: 'OFF_SHELF',
    status: 'FAULT', alert: false, observed_at: null, unknown_reasons: ['构造来源未提供采集时间'] };
}
function headerPage(): StatusPage<DeviceStatusHeader> {
  return { schema_version: deviceStatusSchema, items: [snapshotHeader()], total: 1, page: 1, page_size: 20 };
}
function devicePage(): StatusDevices {
  const header = snapshotHeader();
  return { schema_version: deviceStatusSchema, snapshot_id: header.snapshot_id, snapshot_revision: header.snapshot_revision,
    resource_revision: header.resource_revision, items: [snapshotItem()], total: 1, page: 1, page_size: 20 };
}
function importBody(): DeviceStatusImport {
  const { availability: _, ...record } = snapshotItem(), header = snapshotHeader();
  return { schema_version: deviceStatusSchema, context: 'ledger', request_id: 'explicit-import-one', base_revision: snapshotRevision,
    data_origin: 'SYNTHETIC_INTEGRATION', source_label: header.source_label, provenance_note: header.provenance_note, records: [record] };
}
function storeFixture() {
  pinia = createPinia(); setActivePinia(pinia);
  const auth = authorizeStore();
  const permissions = auth.identity!.permissions as string[];
  if (!permissions.includes('resources.device.status.import')) permissions.push('resources.device.status.import');
  const header = snapshotHeader();
  const receipt = (input: DeviceStatusImport): DeviceStatusReceipt => ({
    schema_version: deviceStatusSchema, request_id: input.request_id, snapshot_id: header.snapshot_id, snapshot_revision: header.snapshot_revision,
    resource_revision: input.base_revision, imported_at: header.imported_at, total: input.records.length, content_hash: header.content_hash, data_origin: header.data_origin,
  });
  const client = {
    listSnapshots: vi.fn<DeviceStatusClient['listSnapshots']>().mockResolvedValue(headerPage()),
    getSnapshot: vi.fn<DeviceStatusClient['getSnapshot']>().mockResolvedValue(header),
    queryDevices: vi.fn<DeviceStatusClient['queryDevices']>().mockResolvedValue(devicePage()),
    importSnapshot: vi.fn<DeviceStatusClient['importSnapshot']>().mockImplementation(async input => receipt(input)),
    getImport: vi.fn<DeviceStatusClient['getImport']>().mockResolvedValue(receipt(importBody())),
  } satisfies DeviceStatusClient;
  const status = useResourceStatusStore(); status.bind(client, snapshotRevision, true);
  return { auth, client, status, header };
}
describe('冻结快照状态生命周期', () => {
  it('明确选择批次才进入观测来源，null时间与false告警不补造，切换来源不发写请求', async () => {
    const s = storeFixture(), device = initialResources().devices[0], before = JSON.stringify(device);
    await s.status.list(); expect(s.status.mode).toBe('baseline'); expect(s.status.project(device.id, snapshotRevision)).toBeNull();
    await s.status.select(s.header);
    expect(s.status.display(device)).toMatchObject({ status: 'FAULT', alert: false, observedAt: undefined, retained: false });
    expect(s.status.project(device.id, snapshotRevision)).toMatchObject({
      ref: { snapshotId: s.header.snapshot_id, snapshotRevision: s.header.snapshot_revision, resourceRevision: snapshotRevision, deviceId: device.id },
      status: 'FAULT', alert: false, observedAt: null,
    });
    expect(s.status.project('uncovered', snapshotRevision)).toBeNull();
    s.status.setMode('baseline'); s.status.setMode('observed');
    expect(s.client.queryDevices).toHaveBeenCalledTimes(1); expect(s.client.importSnapshot).not.toHaveBeenCalled();
    expect(JSON.stringify(device)).toBe(before);
  });
  it('初次读取失败保留基线，明细刷新失败保留原已核验记录且显示错误', async () => {
    const s = storeFixture();
    s.client.getSnapshot.mockRejectedValueOnce(new Error('不可读'));
    await s.status.select(s.header); expect(s.status.mode).toBe('baseline'); expect(s.status.error).toContain('不可读');
    await s.status.select(s.header); const before = JSON.stringify(s.status.snapshotRecords);
    s.client.queryDevices.mockRejectedValueOnce(new Error('明细暂不可用')); await s.status.loadBatch(2);
    expect(s.status.error).toContain('明细暂不可用'); expect(JSON.stringify(s.status.snapshotRecords)).toBe(before);
    expect(s.status.mode).toBe('observed');
  });
  it.each(['resource', 'session', 'permission', 'generation', 'leave'])('%s 变化取消并隔离迟到响应', async kind => {
    const s = storeFixture(); let finish!: (header: DeviceStatusHeader) => void;
    s.client.getSnapshot.mockImplementationOnce(() => new Promise<DeviceStatusHeader>(resolve => { finish = resolve; }));
    const pending = s.status.select(s.header); expect(s.status.busy).toBe(true);
    const signal = s.client.getSnapshot.mock.calls[0]?.[1]?.signal;
    if (kind === 'resource') s.status.bind(s.client, 'resource-2222222222222222');
    if (kind === 'session') s.auth.accept({ ...s.auth.identity!, sessionId: 'another' });
    if (kind === 'permission') s.auth.accept({ ...s.auth.identity!, permissions: [] });
    if (kind === 'generation') s.auth.generation++;
    if (kind === 'leave') s.status.cancel();
    finish(s.header); await pending;
    expect(signal?.aborted).toBe(true); expect(s.status.snapshotRecords).toEqual({}); expect(s.status.mode).toBe('baseline');
    expect(s.status.busy).toBe(false); expect(s.client.queryDevices).not.toHaveBeenCalled();
  });
  it('入口暂停/离开取消迟到列表，同版已读取快照保留；重复操作不产生并发请求', async () => {
    const s = storeFixture(); await s.status.select(s.header);
    const before = JSON.stringify(s.status.snapshotRecords), enabled = ref(true), scope = effectScope(); scopes.push(scope);
    const entry = scope.run(() => useResourceStatusEntry(() => enabled.value, () => snapshotRevision, () => s.client))!;
    for (let i = 0; i < 6; i++) await nextTick();
    enabled.value = false; await nextTick(); expect(entry.available.value).toBe(false); expect(s.status.mode).toBe('observed');
    enabled.value = true; for (let i = 0; i < 6; i++) await nextTick();
    let finish!: (value: StatusPage<DeviceStatusHeader>) => void;
    s.client.listSnapshots.mockImplementationOnce(() => new Promise<StatusPage<DeviceStatusHeader>>(resolve => { finish = resolve; }));
    const calls = s.client.listSnapshots.mock.calls.length, pending = entry.retry(); await entry.retry();
    expect(s.client.listSnapshots).toHaveBeenCalledTimes(calls + 1);
    scope.stop(); finish(headerPage()); await pending;
    expect(JSON.stringify(s.status.snapshotRecords)).toBe(before); expect(s.status.busy).toBe(false);
  });
  it('显式导入超时保留原号，经404核实才允许同号重试，受理不修改资源', async () => {
    const s = storeFixture(), input = importBody(), resources = initialResources(), before = JSON.stringify(resources);
    s.client.importSnapshot.mockRejectedValueOnce(new Error('timeout'));
    await s.status.submitImport(input); expect(s.status.pendingImport?.request_id).toBe(input.request_id);
    s.client.getImport.mockRejectedValueOnce(new ApiError('not found', 'DEVICE_STATUS_NOT_FOUND'));
    await s.status.verifyImport(); expect(s.status.importNotFound).toBe(true);
    await s.status.submitImport(s.status.pendingImport!);
    expect(s.client.importSnapshot.mock.calls[1]?.[0]).toEqual(input); expect(s.status.pendingImport).toBeNull();
    expect(s.status.receipt?.request_id).toBe(input.request_id); expect(JSON.stringify(resources)).toBe(before);
  });
  it('冻结历史入口与缺权限账号均不能导入，未知状态不借用台账正常', async () => {
    const s = storeFixture(); s.status.bind(s.client, snapshotRevision, false);
    await s.status.submitImport(importBody()); expect(s.client.importSnapshot).not.toHaveBeenCalled();
    s.status.bind(s.client, snapshotRevision, true);
    const unknown: DeviceStatusItem = { ...snapshotItem(), status: null, alert: null, observed_at: null, unknown_reasons: ['全部观测未知'] };
    s.client.getSnapshot.mockResolvedValueOnce({ ...s.header, counts: { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: 1, total: 1 } });
    s.client.queryDevices.mockResolvedValueOnce({ ...devicePage(), items: [unknown] });
    await s.status.select(s.header); expect(s.status.display(initialResources().devices[0])).toMatchObject({ status: null, alert: null });
    s.auth.accept({ ...s.auth.identity!, permissions: [] });
    expect(s.status.project('DV-0001', snapshotRevision)).toBeNull(); expect(s.status.mode).toBe('baseline');
    await s.status.submitImport(importBody()); expect(s.client.importSnapshot).not.toHaveBeenCalled();
  });
});
