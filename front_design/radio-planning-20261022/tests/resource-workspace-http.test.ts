import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { createResourceWorkspaceHttp } from '../src/services/resource-workspace-http';
import { workspaceSource } from '../src/services/resource-workspace-validation';
import { ApiError } from '../src/services/types';
import type { ResourcesData } from '../src/types/domain';
import type { ResourceCommit, ResourceMeta } from '../src/types/resource-edit';
import type { CandidateLink } from '../src/types/candidate-link';

const old = 'resource-1111111111111111', next = 'resource-2222222222222222';
function resources(revision = old): ResourcesData {
  return { version: revision, source: workspaceSource,
    stations: [{ id: 'N1', name: '节点一', echelon: 'I', parentIds: [], coordinate: [114, 37], elevationM: null, region: '', classes: ['HF'],
      status: null, alert: null, relayCapable: true, key: false, mobility: 'FIXED', origin: 'SOURCE', remark: '' }],
    devices: [{ id: 'D1', stationId: 'N1', modelId: 'M1', antennaId: 'A1', status: null, alert: null, origin: 'SOURCE', availability: 'ACTIVE',
      antennaHeightM: null, txPowerDbm: null, workFreqKhz: null, installedAt: '', tiltDeg: null, azimuthDeg: null, currentWorkMode: null }],
    models: [{ id: 'M1', name: '型号一', manufacturer: '', deviceClass: 'HF', freqMinKhz: 2000, freqMaxKhz: 30000, txPowerMaxDbm: 50, modulation: [], workMode: [] }],
    antennas: [{ id: 'A1', name: '天线一' }], interferences: [], candidateLinks: [] };
}
function meta(data: ResourcesData): ResourceMeta {
  return { revision: data.version, resourceEpoch: data.version, stationVersions: Object.fromEntries(data.stations.map(row => [row.id, data.version])),
    deviceVersions: Object.fromEntries(data.devices.map(row => [row.id, data.version])), savedAt: null, changedStationIds: [], changedDeviceIds: [], receipts: [] };
}
function context() {
  const data = resources(), metadata = meta(data);
  return { revision: old, baseRevision: old, device: null, stations: data.stations, models: data.models, antennas: data.antennas,
    resources: data, meta: metadata, resourceMeta: structuredClone(metadata), validationSource: structuredClone(data),
    situation: { title: '当前资源编辑上下文', snapshotId: old, updatedAt: '2026-10-23T00:00:00Z', links: [], candidateLinks: [], regions: [], alerts: [], spectrum: [] },
    impact: { planIds: [], linkIds: [], description: '保留历史，不自动重算' } };
}
function mutation(changed = true) {
  const data = resources(changed ? next : old);
  data.devices[0].antennaHeightM = 9;
  return { receipt: { objectId: 'D1', changed, revision: data.version, readRevision: data.version, warnings: [], affectedIds: changed ? ['D1'] : [], device: data.devices[0] },
    result: { resources: data, meta: meta(data), changed, warnings: [] } };
}
const input = (): ResourceCommit => ({ context: 'ledger', baseRevision: old, requestId: 'request-1', stations: [], devices: [{ id: 'D1', antennaHeightM: 9 }] });
function service(value: unknown) {
  const request = vi.fn<AuthenticatedRequest>().mockResolvedValue(value);
  return { request, api: createResourceWorkspaceHttp(request as AuthenticatedRequest) };
}
function body(call: [string, RequestInit?, ('json' | 'blob')?]) { return JSON.parse(String(call[1]?.body)); }

describe('资源工作区 HTTP 请求桩契约', () => {
  it('完整 canonical 台账上下文保留未知值和真实来源，不读本地资料', async () => {
    const s = service(context());
    const result = await s.api.loadResourceMaintenanceContext({ context: 'ledger', revision: old });
    expect(s.request.mock.calls[0][0]).toBe(`/resource/edit-context?context=ledger&revision=${old}`);
    expect(result.resources.devices[0]).toMatchObject({ antennaHeightM: null, txPowerDbm: null, workFreqKhz: null, status: null, alert: null, origin: 'SOURCE' });
    expect(result.meta).toEqual(meta(result.resources));
    expect(result.device).toBeNull();
    for (const origin of ['SOURCE', 'MANUAL', 'IMPORT'] as const) {
      const value = context(); value.resources.devices[0].origin = origin; value.validationSource.devices[0].origin = origin;
      expect((await service(value).api.loadResourceMaintenanceContext({ context: 'ledger', revision: old })).resources.devices[0].origin).toBe(origin);
    }
  });
  it('loadWorkspace 允许省略版本；GIS 精确返回完整编辑基线并传递取消信号', async () => {
    const s = service(context()), signal = new AbortController().signal;
    await s.api.loadWorkspace('ledger');
    expect(s.request.mock.calls[0][0]).toBe('/resource/edit-context?context=ledger');
    const result = await s.api.loadGisResourceEditContext({ context: 'gis', revision: old, signal });
    expect(s.request.mock.calls[1][1]?.signal).toBe(signal);
    expect(result).toEqual({ revision: old, baseRevision: old, resources: resources(), resourceMeta: meta(resources()), situation: context().situation, validationSource: resources() });
  });
  it('单设备与选择列表留给旧 dispatch，非法查询发送前拒绝', async () => {
    const s = service(context());
    for (const patch of [{ deviceId: 'D1' }, { ids: [] }, { context: 'gis' }, { revision: 'latest' }, { revision: undefined }, { unexpected: true }]) {
      await expect(s.api.loadResourceMaintenanceContext({ context: 'ledger', revision: old, ...patch } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    const controller = new AbortController(); controller.abort();
    await expect(s.api.loadGisResourceEditContext({ context: 'gis', revision: old, signal: controller.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(s.request).not.toHaveBeenCalled();
  });
  it('拒绝错版、假来源、字典不一致、缺引用、空值替代和父级环', async () => {
    const corruptions: ((v: ReturnType<typeof context>) => void)[] = [
      v => { v.revision = next; }, v => { v.baseRevision = next; }, v => { v.resources.version = next; },
      v => { v.resources.source = 'PRODUCTION'; }, v => { v.meta.revision = next; },
      v => { v.models = []; }, v => { v.resources.devices[0].stationId = 'missing'; },
      v => { v.resources.devices[0].modelId = 'missing'; }, v => { v.resources.devices[0].antennaId = 'missing'; },
      v => { v.resources.stations[0].parentIds = ['N1']; }, v => { v.resources.devices.push(structuredClone(v.resources.devices[0])); },
      v => { Object.assign(v.resources.devices[0], { txPowerDbm: '' }); }, v => { Object.assign(v.resources.devices[0], { origin: null }); },
      v => { Object.assign(v.resources.devices[0], { status: 'UNKNOWN' }); }, v => { Object.assign(v.resources.devices[0], { alert: 0 }); },
      v => { v.meta.stationVersions = {}; },
    ];
    for (const corrupt of corruptions) {
      const value = context(); corrupt(value);
      await expect(service(value).api.loadWorkspace('ledger', old)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
  });
  it('GIS 不接纳正式网络、不同版 validationSource 和缺少额外字段的响应', async () => {
    for (const patch of [{ situation: { ...context().situation, snapshotId: 'plan-1' } },
      { situation: { ...context().situation, links: [{}] } }, { validationSource: resources(next) }, { resourceMeta: meta(resources(next)) }, { situation: undefined }]) {
      await expect(service({ ...context(), ...patch }).api.loadGisResourceEditContext({ context: 'gis', revision: old })).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
  });
  it('workspace POST 剥离提交元数据；轻量入口和完整入口分别取 receipt/result', async () => {
    const value = mutation(), s = service(value);
    expect(await s.api.saveResourceChanges(input())).toEqual(value.receipt);
    expect(body(s.request.mock.calls[0])).toEqual({ context: 'ledger', base_revision: old, request_id: 'request-1', changes: { stations: [], devices: [{ id: 'D1', antennaHeightM: 9 }] } });
    expect(s.request.mock.calls[0][0]).toBe('/resource/workspace/changes');
    expect(await s.api.commitResources({ ...input(), context: 'gis' })).toEqual(value.result);
    expect(await service(mutation(false)).api.saveResourceChanges(input())).toMatchObject({ changed: false, revision: old });
  });
  it('异步响应按发起时版本解释，不跟随页面后续修改请求', async () => {
    const s = service(mutation()), original = input();
    let resolve: (value: unknown) => void = () => {};
    s.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }) as ReturnType<AuthenticatedRequest>);
    const pending = s.api.saveResourceChanges(original);
    original.baseRevision = next; original.devices[0].antennaHeightM = 99;
    resolve(mutation());
    expect(await pending).toMatchObject({ revision: next, device: { antennaHeightM: 9 } });
    expect(body(s.request.mock.calls[0]).base_revision).toBe(old);
  });
  it('校验完整保存结果和原回执同版，拒绝来源与本对象不匹配', async () => {
    const invalid: ((v: ReturnType<typeof mutation>) => void)[] = [
      v => { v.receipt.readRevision = old; }, v => { v.result.resources.version = old; }, v => { v.result.meta.revision = old; },
      v => { v.result.changed = false; }, v => { v.receipt.changed = false; }, v => { v.receipt.affectedIds = ['missing']; },
      v => { v.receipt.objectId = 'other'; }, v => { v.receipt.affectedIds = ['N1']; },
      v => { v.result.resources.source = 'other'; }, v => { v.receipt.device = { ...v.receipt.device, antennaHeightM: 11 }; },
    ];
    for (const corrupt of invalid) {
      const value = mutation(); corrupt(value);
      await expect(service(value).api.commitResources(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
  });
  it('完整候选保留 nullable 评估和来源参考，拒绝缺引用和伪造手工评估', async () => {
    const data = resources();
    data.stations.push({ ...structuredClone(data.stations[0]), id: 'N2' });
    data.devices.push({ ...structuredClone(data.devices[0]), id: 'D2', stationId: 'N2' });
    const link: CandidateLink = { id: 'C1', nodeAId: 'N1', nodeBId: 'N2', deviceAId: 'D1', deviceBId: 'D2', deviceClass: 'HF',
      freqKhz: null, bandwidthKhz: null, isBackup: null, distanceM: null, pathLossDb: null, rxPowerDbm: null, linkMarginDb: null,
      isAvailable: null, linkState: null, assessmentState: 'PENDING', source: { kind: 'MANUAL', file: null, row: null }, reference: null };
    data.candidateLinks = [link];
    const value = { ...context(), resources: data, validationSource: structuredClone(data), stations: data.stations, meta: meta(data), resourceMeta: meta(data) };
    expect((await service(value).api.loadWorkspace('ledger', old)).resources.candidateLinks).toEqual([link]);
    for (const change of [{ deviceBId: 'missing' }, { deviceBId: 'D1' }, { distanceM: 0 }, { source: { kind: 'IMPORT', file: null, row: 2 } }]) {
      const corrupt = structuredClone(value); Object.assign(corrupt.resources.candidateLinks![0], change);
      await expect(service(corrupt).api.loadWorkspace('ledger', old)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    }
  });
  it('新增单设备返回 canonical device，混合批次使用工作区回执', async () => {
    const created = { ...resources(next).devices[0], id: 'D2', origin: 'MANUAL' as const };
    const data = resources(next); data.devices.push(created);
    const value = { receipt: { objectId: 'D2', changed: true, revision: next, readRevision: next, warnings: [], affectedIds: ['D2'], device: created },
      result: { resources: data, meta: meta(data), changed: true, warnings: [] } };
    const s = service(value);
    expect(await s.api.saveResourceChanges({ context: 'ledger', baseRevision: old, requestId: 'create-1', stations: [], devices: [], newDevices: [created] })).toEqual(value.receipt);
    const mixed = mutation(); mixed.receipt.objectId = 'resource-workspace'; mixed.receipt.affectedIds = ['D1', 'N1'];
    const batch = service(mixed);
    await batch.api.saveResourceChanges({ ...input(), stations: [{ id: 'N1', name: '节点一' }] });
    expect(body(batch.request.mock.calls[0]).changes.stations).toEqual([{ id: 'N1', name: '节点一' }]);
  });
  it('拒绝未知/只读字段、非有限数、伪造来源、重复对象和 restoreFrom', async () => {
    const s = service(mutation());
    for (const patch of [{ requestId: undefined }, { context: 'planning' }, { restoreFrom: {} }, { availability: [{ id: 'D1', availability: 'ACTIVE' }] },
      { devices: [{ id: 'D1', status: 'NORMAL' }] }, { devices: [{ id: 'D1', antennaHeightM: NaN }] },
      { devices: [{ id: 'D1', antennaHeightM: 9 }, { id: 'D1', antennaHeightM: 8 }] },
      { newDevices: [{ ...resources().devices[0], id: 'D2', origin: 'SOURCE' }] }]) {
      await expect(s.api.saveResourceChanges({ ...input(), ...patch } as ResourceCommit)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(s.request).not.toHaveBeenCalled();
  });
  it.each([[1001, 'VALIDATION_ERROR'], [1002, 'RESOURCE_NOT_FOUND'], [1205, 'RESOURCE_VERSION_CHANGED'], [1206, 'REQUEST_CONFLICT'], ['REQUEST_TIMEOUT', 'REQUEST_TIMEOUT']])('错误 %s 保留追踪信息且不重发', async (code, expected) => {
    const s = service(null), error = new ApiError('明确失败', code, { detail: 1 }, 'trace-1', 409);
    s.request.mockRejectedValue(error);
    await expect(s.api.saveResourceChanges(input())).rejects.toMatchObject({ code: expected, requestId: 'trace-1', status: 409, data: { detail: 1 } });
    expect(s.request).toHaveBeenCalledTimes(1);
  });
});
