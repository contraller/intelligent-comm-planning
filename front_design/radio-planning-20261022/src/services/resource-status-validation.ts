import type { ResourcesData } from '../types/domain';
import type { DeviceStatusBatch, DeviceStatusCatalog, DeviceStatusIdentity, DeviceStatusQuery, DeviceStatusRequest, DeviceStatusSource, DeviceStatusSummary } from '../types/resource-status';
import { ApiError } from './types';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const fail = (): never => { throw new ApiError('设备状态回包无效，原观测已保留', 'INVALID_DEVICE_STATUS'); };
// 全库完整性由服务核对，页面只校验回执身份和各结果计数。
export function validateStatusSummary(value:DeviceStatusSummary,request:DeviceStatusQuery,source:DeviceStatusSource){
  if(!value||!text(value.batchId)||!text(value.snapshotId)||value.resourceRevision!==request.resourceRevision||JSON.stringify(value.source)!==JSON.stringify(source)||!value.counts||!['REPORTED','NO_REPORT','FAILED'].every(key=>Number.isSafeInteger(value.counts[key as keyof typeof value.counts])&&value.counts[key as keyof typeof value.counts]>=0)||value.total!==Object.values(value.counts).reduce((sum,n)=>sum+n,0)||request.scope!=='ALL'&&value.total!==request.deviceIds.length)fail();
}
export function validStatusSource(v: unknown): v is DeviceStatusSource {
  return object(v) && text(v.id) && text(v.label) && ['MOCK', 'BACKEND'].includes(String(v.kind));
}
// Date.parse 会归一化越界日期，先验证日历和时区，避免假采集时间。
export function validObservationTime(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  if (!m) return false;
  const [, y, month, day, h, min, s, zone] = m;
  return +month! >= 1 && +month! <= 12 && +day! >= 1 && +day! <= new Date(Date.UTC(+y!, +month!, 0)).getUTCDate()
    && +h! < 24 && +min! < 60 && +s! < 60 && (zone === 'Z' || +zone!.slice(1, 3) <= 14 && +zone!.slice(4) < 60
      && (+zone!.slice(1, 3) < 14 || +zone!.slice(4) === 0)) && Number.isFinite(Date.parse(v));
}
export function validateStatusRequest(request: DeviceStatusRequest, revision: string) {
  if (!request || !['ledger', 'gis'].includes(request.context) || !text(request.resourceRevision))
    throw new ApiError('设备状态读取上下文无效', 'INVALID_DEVICE_STATUS_QUERY');
  if (request.resourceRevision !== revision) throw new ApiError('资源版本已变化，请重新加载资源后同步', 'REVISION_CONFLICT');
}
export function validateStatusCatalog(value: unknown, request: DeviceStatusRequest): asserts value is DeviceStatusCatalog {
  if (!object(value) || value.resourceRevision !== request.resourceRevision || !validStatusSource(value.source)) fail();
  const v = value as Record<string, unknown>;
  if (v.targets !== undefined && (!Array.isArray(v.targets) || v.targets.some(t => !object(t) || !text(t.deviceId) || !text(t.stationId) || !text(t.modelId)) || new Set(v.targets.map(t => t.deviceId)).size !== v.targets.length)) fail();
  if (v.examples !== undefined && (!Array.isArray(v.examples) || !v.examples.length || v.examples.some(e => !object(e)
    || !text(e.id) || !text(e.label) || !validStatusSource(e.source)) || new Set(v.examples.map(e => e.id)).size !== v.examples.length)) fail();
}
export function validateStatusQuery(request: DeviceStatusQuery, resources: ResourcesData, revision: string) {
  validateStatusRequest(request, revision);
  if (request.scope !== undefined && !['ALL', 'IDS'].includes(request.scope)) throw new ApiError('同步范围无效', 'INVALID_DEVICE_STATUS_QUERY');
  if (request.scope === 'ALL') {
    if (!Array.isArray(request.deviceIds) || request.deviceIds.length) throw new ApiError('全库同步不混入显式设备编号', 'INVALID_DEVICE_STATUS_QUERY');
    return;
  }
  if (!Array.isArray(request.deviceIds) || !request.deviceIds.length || new Set(request.deviceIds).size !== request.deviceIds.length
    || request.deviceIds.some(id => !text(id) || !resources.devices.some(d => d.id === id)))
    throw new ApiError('同步目标包含重复、缺失或未保存设备', 'INVALID_DEVICE_STATUS_QUERY');
}
export function validateStatusBatch(value: unknown, request: DeviceStatusQuery, resources: ResourcesData | { targets: DeviceStatusIdentity[] }, source: DeviceStatusSource): asserts value is DeviceStatusBatch {
  const targets = 'targets' in resources ? resources.targets : resources.devices.map(d => ({ deviceId: d.id, stationId: d.stationId, modelId: d.modelId }));
  const ids = request.scope === 'ALL' ? targets.map(d => d.deviceId) : request.deviceIds;
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(id => !targets.some(d => d.deviceId === id))) fail();
  if (!object(value) || !text(value.batchId) || value.resourceRevision !== request.resourceRevision
    || !validStatusSource(value.source) || JSON.stringify(value.source) !== JSON.stringify(source) || !Array.isArray(value.items)) fail();
  const items = (value as Record<string, unknown>).items as unknown[];
  const snapshotId = (value as Record<string, unknown>).snapshotId;
  if (snapshotId !== undefined && !text(snapshotId)) fail();
  const expected = new Set(ids), seen = new Set<string>();
  for (const raw of items) {
    if (!object(raw) || !text(raw.deviceId)) fail();
    const row = raw as Record<string, unknown>, id = row.deviceId as string;
    const device = targets.find(d => d.deviceId === id);
    if (!device || !expected.has(id) || seen.has(id) || row.stationId !== device.stationId || row.modelId !== device.modelId) fail();
    seen.add(id);
    if (row.reason !== undefined && !text(row.reason)) fail();
    if (row.outcome === 'REPORTED') {
      const o = row.observation;
      if (!object(o) || !text(o.observationId) || !Number.isSafeInteger(o.sequence) || (o.sequence as number) < 0
        || !validObservationTime(o.observedAt) || ![null, 'NORMAL', 'FAULT', 'OFFLINE'].includes(o.status as string | null)
        || ![null, true, false].includes(o.alert as boolean | null)) fail();
    } else if (!['NO_REPORT', 'FAILED'].includes(String(row.outcome)) || !text(row.reason) || row.observation !== undefined) fail();
  }
  if (seen.size !== expected.size) fail();
}
