import { RESOURCE_SCHEMA_VERSION, RESOURCE_STORAGE_KEY } from '../config/demo';
import type { ResourcesData } from '../types/domain';
import type { ResourceMeta, ResourceRecord, ResourceStorage } from '../types/resource-edit';
import { assertValid, diffResources, resourceIdValid } from './resource-validation';
import { ApiError } from './types';
import { emptyTasks, validateTaskWorkspace } from './task-validation';
import { completeResources, initialCandidateLinks } from '../mocks/resource-presets';

export const initialMeta = (): ResourceMeta => ({
  taskWorkspace:emptyTasks(),
  interferenceVersion:'initial', changedInterferenceIds:[], receipts:[],
  revision: 'initial',
  resourceEpoch: 'initial',
  stationVersions: {},
  deviceVersions: {},
  savedAt: null,
  changedStationIds: [],
  changedDeviceIds: [],
});

// 生产仅访问浏览器存储；测试必须显式注入，不提供内存成功降级。
export function browserResourceStorage(): ResourceStorage {
  try {
    return window.localStorage;
  } catch {
    throw new ApiError('浏览器本地存储不可用，请检查访问权限', 'STORAGE_UNAVAILABLE');
  }
}

export function readResources(
  storage: ResourceStorage,
  source: ResourcesData,
): { resources: ResourcesData; meta: ResourceMeta } {
  source=completeResources(source);
  let text: string | null;
  try {
    text = storage.getItem(RESOURCE_STORAGE_KEY);
  } catch {
    throw new ApiError('无法读取资源存储，请检查浏览器权限后重试', 'STORAGE_READ_FAILED');
  }
  if (text === null) return { resources: structuredClone(source), meta: initialMeta() };
  try {
    const record = JSON.parse(text) as ResourceRecord;
    if (
      !record ||
      ![1, 2, 3, 4, RESOURCE_SCHEMA_VERSION].includes(record.schemaVersion) ||
      record.sourceVersion !== source.version
    )
      throw new ApiError(
        '已保存资源版本不兼容，请明确重置资源演示数据后继续',
        'STORAGE_INCOMPATIBLE',
      );
    const validIds = (ids: unknown, rows: { id: string }[]) =>
      Array.isArray(ids) &&
      ids.every((id) => typeof id === 'string' && rows.some((row) => row.id === id)) &&
      new Set(ids).size === ids.length;
    // 初始数据的无变化请求也可持久回执；不伪造保存时间或资源变更。
    const initialReceiptRecord=record.schemaVersion>=3&&record.revision==='initial'&&record.resourceEpoch==='initial'&&record.savedAt===null&&
      Array.isArray(record.receipts)&&(record.receipts.length>0||record.schemaVersion>=4&&!!record.taskWorkspace)&&record.receipts.every(r=>r.changed===false)&&
      record.changedStationIds?.length===0&&record.changedDeviceIds?.length===0&&record.changedInterferenceIds?.length===0&&
      Object.keys(record.stationVersions??{}).length===0&&Object.keys(record.deviceVersions??{}).length===0&&record.interferenceVersion==='initial';
    if (
      typeof record.revision !== 'string' ||
      !record.revision ||
      (!initialReceiptRecord&&(record.revision === 'initial' || typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt)))) ||
      !validIds(record.changedStationIds, record.stations ?? []) ||
      !validIds(record.changedDeviceIds, record.devices ?? [])
    )
      throw new Error('资源版本或影响标记格式无效');
    const resources = completeResources({
      ...structuredClone(source), stations:record.stations, devices:record.devices,
      interferences:record.schemaVersion>=3?record.interferences:source.interferences,
      // 旧 Mock 记录仅内存补来源；v5 显式空集合保留，缺字段视为损坏。
      candidateLinks:record.schemaVersion>=5?record.candidateLinks:initialCandidateLinks(),
    });
    if(record.schemaVersion>=5&&!Array.isArray(record.candidateLinks))throw new Error('v5 候选字段缺失或无效');
    if(record.schemaVersion>=3&&(
      !Array.isArray(record.interferences)||!record.stations.every(s=>s.origin&&s.subtype&&s.role&&typeof s.remark==='string')||
      !record.devices.every(d=>d.origin&&d.availability&&d.tiltDeg!==undefined&&d.azimuthDeg!==undefined)))
      throw new Error('v3 补充字段缺失');
    if(record.schemaVersion<3&&(record.stations.length!==source.stations.length||record.devices.length!==source.devices.length))
      throw new Error('旧版本不允许新增资源');
    assertValid(resources, resources, source);
    const diff = diffResources(source, resources);
    if (
      [...diff.stations,...diff.newStations??[]].some((row) => !record.changedStationIds.includes(row.id)) ||
      [...diff.devices,...diff.newDevices??[],...diff.availability??[]].some((row) => !record.changedDeviceIds.includes(row.id))
    )
      throw new Error('修改对象缺少来源变更标记');
    // 旧记录只做确定性内存迁移，读取不能覆盖用户保存的数据。
    const legacyVersions = (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, record.revision]));
    const stationVersions =
      record.schemaVersion === 1
        ? legacyVersions(record.changedStationIds)
        : record.stationVersions;
    const deviceVersions =
      record.schemaVersion === 1 ? legacyVersions(record.changedDeviceIds) : record.deviceVersions;
    const resourceEpoch =
      record.schemaVersion === 1 ? `legacy:${record.revision}` : record.resourceEpoch;
    const validVersions = (
      versions: Record<string, string>,
      rows: { id: string }[],
      changed: string[],
    ) =>
      versions &&
      typeof versions === 'object' &&
      !Array.isArray(versions) &&
      Object.entries(versions).every(
        ([id, revision]) =>
          rows.some((row) => row.id === id) && typeof revision === 'string' && !!revision,
      ) &&
      changed.every((id) => Object.hasOwn(versions, id));
    if (
      typeof resourceEpoch !== 'string' ||
      !resourceEpoch ||
      !validVersions(stationVersions, resources.stations, record.changedStationIds) ||
      !validVersions(deviceVersions, resources.devices, record.changedDeviceIds)
    )
      throw new Error('资源对象版本无效');
    const interferenceVersion=record.schemaVersion>=3?record.interferenceVersion:'initial';
    const changedInterferenceIds=record.schemaVersion>=3?record.changedInterferenceIds:[];
    const receipts=record.schemaVersion>=3?record.receipts:[];
    if(typeof interferenceVersion!=='string'||!interferenceVersion||!validIds(changedInterferenceIds,resources.interferences!)||
      !Array.isArray(receipts)||new Set(receipts.map(r=>r.requestId)).size!==receipts.length||
      receipts.some(r=>!resourceIdValid(r.requestId)||typeof r.signature!=='string'||!r.signature||typeof r.revision!=='string'||typeof r.changed!=='boolean'||r.availabilityResult&&(!Array.isArray(r.availabilityResult.updated)||!Array.isArray(r.availabilityResult.unchanged)||!validIds([...r.availabilityResult.updated,...r.availabilityResult.unchanged],resources.devices)))||
      [...diff.interferences??[],...diff.newInterferences??[]].some(r=>!changedInterferenceIds!.includes(r.id))||
      changedInterferenceIds!.length&&interferenceVersion==='initial')throw new Error('干扰源版本或请求回执无效');
    const taskWorkspace=record.schemaVersion>=4?record.taskWorkspace:emptyTasks();
    validateTaskWorkspace(taskWorkspace!);
    const meta: ResourceMeta = {
      taskWorkspace,
      interferenceVersion, changedInterferenceIds, receipts,
      resourceEpoch,
      stationVersions,
      deviceVersions,
      revision: record.revision,
      savedAt: record.savedAt,
      changedStationIds: record.changedStationIds,
      changedDeviceIds: record.changedDeviceIds,
    };
    return { resources, meta };
  } catch (reason) {
    if (reason instanceof ApiError && reason.code === 'STORAGE_INCOMPATIBLE') throw reason;
    throw new ApiError(
      '已保存资源损坏或不符合契约；原记录已保留，可明确重置资源演示数据',
      'STORAGE_CORRUPT',
      reason instanceof ApiError ? reason.data : undefined,
    );
  }
}

export function checkRevision(expected: string, actual: string) {
  if (expected !== actual)
    throw new ApiError(
      '资源版本已变化，当前输入已保留。请重新加载后重新编辑；不会自动合并或覆盖。',
      'REVISION_CONFLICT',
    );
}

export function writeResources(
  storage: ResourceStorage,
  resources: ResourcesData,
  meta: ResourceMeta,
) {
  const record: ResourceRecord = {
    ...meta,
    schemaVersion: RESOURCE_SCHEMA_VERSION,
    sourceVersion: resources.version,
    stations: resources.stations,
    devices: resources.devices,
    interferences:resources.interferences,
    candidateLinks:resources.candidateLinks??[],
  };
  try {
    storage.setItem(RESOURCE_STORAGE_KEY, JSON.stringify(record));
  } catch {
    throw new ApiError(
      '保存失败：浏览器存储被拒绝或空间不足。原数据和当前输入已保留。',
      'STORAGE_WRITE_FAILED',
    );
  }
}
