import type { CandidateLink, CandidateLinkData, CandidateLinkSource } from '../types/candidate-link';
import type { DevicePort } from '../types/device-maintenance';
import type { Antenna, Coordinate, Device, DeviceModel, InterferenceSource, ResourcesData, SituationData, Station } from '../types/domain';
import type { GisResourceEditContext } from '../types/gis-workspace';
import type { ResourceChanges, ResourceCommit, ResourceIssue, ResourceMaintenanceContext, ResourceMeta, ResourceMutationReceipt, ResourceSaveResult } from '../types/resource-edit';
import { ApiError } from './types';
import { validPlanningBounds } from './resource-geography';

export const workspaceSource = '项目构造资源基线，非生产、非实测';
export function workspaceFailure(field: string): never {
  throw new ApiError('资源工作区响应不符合契约：' + field, 'INVALID_RESOURCE_RESPONSE');
}
export function workspaceRecord(value: unknown, field = 'data'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return workspaceFailure(field);
  return value as Record<string, unknown>;
}
export function workspaceKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) workspaceFailure('fields');
}
export function workspaceText(value: unknown, field: string, empty = false, max = 512): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return workspaceFailure(field);
  return value;
}
export function workspaceId(value: unknown): string {
  const id = workspaceText(value, 'id', false, 120);
  if (id.trim() !== id) workspaceFailure('id');
  return id;
}
export function workspaceRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^resource-[0-9a-f]{16}$/.test(value)) return workspaceFailure('revision');
  return value;
}
function choice<const T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) return workspaceFailure('enum');
  return value as T;
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return workspaceFailure('number');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return workspaceFailure('boolean');
  return value;
}
const nullableNumber = (value: unknown) => value === null ? null : numeric(value);
const nullableBoolean = (value: unknown) => value === null ? null : boolean(value);
const status = (value: unknown) => value === null ? null : choice(value, ['NORMAL', 'FAULT', 'OFFLINE']);
const origin = (value: unknown) => choice(value, ['SOURCE', 'MANUAL', 'IMPORT']);
const deviceClass = (value: unknown) => choice(value, ['HF', 'VUHF']);
function array<T>(value: unknown, decode: (row: unknown) => T): T[] {
  if (!Array.isArray(value)) return workspaceFailure('array');
  return Array.from(value, decode);
}
export function workspaceIds(value: unknown): string[] {
  const result = array(value, workspaceId);
  if (new Set(result).size !== result.length) workspaceFailure('duplicate ids');
  return result;
}
function unique<T extends { id: string }>(rows: T[]): T[] {
  if (new Set(rows.map(row => row.id)).size !== rows.length) workspaceFailure('duplicate ids');
  return rows;
}
function coordinate(value: unknown): Coordinate {
  if (!Array.isArray(value) || value.length !== 2) return workspaceFailure('coordinate');
  const lon = numeric(value[0]), lat = numeric(value[1]);
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) workspaceFailure('coordinate');
  return [lon, lat];
}
function timestamp(value: unknown): string {
  const result = workspaceText(value, 'time');
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(result) || !Number.isFinite(Date.parse(result))) workspaceFailure('time');
  return result;
}
const stationRequired = ['id', 'name', 'echelon', 'parentIds', 'coordinate', 'elevationM', 'region', 'classes', 'status', 'alert', 'relayCapable', 'key', 'mobility', 'origin'];
const stationOptional = ['subtype', 'role', 'remark'];
function station(value: unknown): Station {
  const v = workspaceRecord(value); workspaceKeys(v, stationRequired, stationOptional);
  const result: Station = {
    id: workspaceId(v.id), name: workspaceText(v.name, 'name'), echelon: workspaceText(v.echelon, 'echelon'),
    parentIds: workspaceIds(v.parentIds), coordinate: coordinate(v.coordinate), elevationM: nullableNumber(v.elevationM),
    region: workspaceText(v.region, 'region', true), classes: array(v.classes, deviceClass), status: status(v.status), alert: nullableBoolean(v.alert),
    relayCapable: boolean(v.relayCapable), key: boolean(v.key), mobility: workspaceText(v.mobility, 'mobility'), origin: origin(v.origin),
  };
  for (const key of stationOptional as ('subtype' | 'role' | 'remark')[]) if (Object.hasOwn(v, key)) result[key] = workspaceText(v[key], key, true);
  if (new Set(result.classes).size !== result.classes.length) workspaceFailure('classes');
  return result;
}
const deviceRequired = ['id', 'stationId', 'modelId', 'antennaId', 'status', 'alert', 'antennaHeightM', 'txPowerDbm', 'workFreqKhz', 'installedAt', 'origin'];
const deviceOptional = ['availability', 'tiltDeg', 'azimuthDeg', 'currentWorkMode', 'ports'];
function ports(value: unknown): DevicePort[] | null {
  if (value === null) return null;
  return unique(array(value, item => {
    const v = workspaceRecord(item);
    const fields = ['freqMinKhz', 'freqMaxKhz', 'rateKbps', 'gainDbi', 'heightM', 'azimuthDeg', 'tiltDeg'] as const;
    workspaceKeys(v, ['id', 'number', 'type', ...fields]);
    return { id: workspaceId(v.id), number: workspaceText(v.number, 'port.number'), type: choice(v.type, ['RF', 'BUSINESS']),
      freqMinKhz: nullableNumber(v.freqMinKhz), freqMaxKhz: nullableNumber(v.freqMaxKhz), rateKbps: nullableNumber(v.rateKbps),
      gainDbi: nullableNumber(v.gainDbi), heightM: nullableNumber(v.heightM), azimuthDeg: nullableNumber(v.azimuthDeg), tiltDeg: nullableNumber(v.tiltDeg) };
  }));
}
function device(value: unknown): Device {
  const v = workspaceRecord(value); workspaceKeys(v, deviceRequired, deviceOptional);
  const result: Device = { id: workspaceId(v.id), stationId: workspaceId(v.stationId), modelId: workspaceId(v.modelId), antennaId: workspaceId(v.antennaId),
    status: status(v.status), alert: nullableBoolean(v.alert), antennaHeightM: nullableNumber(v.antennaHeightM), txPowerDbm: nullableNumber(v.txPowerDbm),
    workFreqKhz: nullableNumber(v.workFreqKhz), installedAt: v.installedAt === '' ? '' : timestamp(v.installedAt), origin: origin(v.origin) };
  if (Object.hasOwn(v, 'availability')) result.availability = choice(v.availability, ['ACTIVE', 'OFF_SHELF']);
  for (const key of ['tiltDeg', 'azimuthDeg'] as const) if (Object.hasOwn(v, key)) result[key] = nullableNumber(v[key]);
  if (Object.hasOwn(v, 'currentWorkMode')) result.currentWorkMode = v.currentWorkMode === null ? null : workspaceText(v.currentWorkMode, 'currentWorkMode');
  if (Object.hasOwn(v, 'ports')) result.ports = ports(v.ports);
  return result;
}
function model(value: unknown): DeviceModel {
  const v = workspaceRecord(value);
  workspaceKeys(v, ['id', 'name', 'manufacturer', 'deviceClass', 'freqMinKhz', 'freqMaxKhz', 'txPowerMaxDbm', 'modulation', 'workMode']);
  const result = { id: workspaceId(v.id), name: workspaceText(v.name, 'name'), manufacturer: workspaceText(v.manufacturer, 'manufacturer', true),
    deviceClass: deviceClass(v.deviceClass), freqMinKhz: numeric(v.freqMinKhz), freqMaxKhz: numeric(v.freqMaxKhz), txPowerMaxDbm: numeric(v.txPowerMaxDbm),
    modulation: array(v.modulation, s => workspaceText(s, 'modulation')), workMode: array(v.workMode, s => workspaceText(s, 'workMode')) };
  if (result.freqMinKhz > result.freqMaxKhz) workspaceFailure('model frequency');
  return result;
}
function antenna(value: unknown): Antenna {
  const v = workspaceRecord(value); workspaceKeys(v, ['id', 'name']);
  return { id: workspaceId(v.id), name: workspaceText(v.name, 'name') };
}
const interferenceFields = ['name', 'coordinate', 'elevationM', 'antennaHeightM', 'centerFreqKhz', 'bandwidthKhz', 'txPowerDbm', 'antennaGainDbi', 'interferenceType', 'patternType', 'azimuthDeg', 'dutyCycle', 'active'] as const;
function interference(value: unknown): InterferenceSource {
  const v = workspaceRecord(value); workspaceKeys(v, ['id', 'origin', ...interferenceFields]);
  return { id: workspaceId(v.id), origin: origin(v.origin), name: workspaceText(v.name, 'name'), coordinate: coordinate(v.coordinate), elevationM: nullableNumber(v.elevationM),
    antennaHeightM: numeric(v.antennaHeightM), centerFreqKhz: numeric(v.centerFreqKhz), bandwidthKhz: numeric(v.bandwidthKhz), txPowerDbm: numeric(v.txPowerDbm),
    antennaGainDbi: nullableNumber(v.antennaGainDbi), interferenceType: workspaceText(v.interferenceType, 'interferenceType'),
    patternType: v.patternType === null ? null : workspaceText(v.patternType, 'patternType'), azimuthDeg: nullableNumber(v.azimuthDeg), dutyCycle: nullableNumber(v.dutyCycle), active: boolean(v.active) };
}
const candidateConfig = ['nodeAId', 'nodeBId', 'deviceAId', 'deviceBId', 'deviceClass', 'freqKhz', 'bandwidthKhz', 'isBackup'] as const;
const candidateAssessment = ['distanceM', 'pathLossDb', 'rxPowerDbm', 'linkMarginDb', 'isAvailable', 'linkState'] as const;
function candidateData(v: Record<string, unknown>): CandidateLinkData {
  const result = { id: workspaceId(v.id), nodeAId: workspaceId(v.nodeAId), nodeBId: workspaceId(v.nodeBId), deviceAId: workspaceId(v.deviceAId), deviceBId: workspaceId(v.deviceBId),
    deviceClass: deviceClass(v.deviceClass), freqKhz: nullableNumber(v.freqKhz), bandwidthKhz: nullableNumber(v.bandwidthKhz), isBackup: nullableBoolean(v.isBackup),
    distanceM: nullableNumber(v.distanceM), pathLossDb: nullableNumber(v.pathLossDb), rxPowerDbm: nullableNumber(v.rxPowerDbm), linkMarginDb: nullableNumber(v.linkMarginDb),
    isAvailable: nullableBoolean(v.isAvailable), linkState: v.linkState === null ? null : choice(v.linkState, ['EXCELLENT', 'GOOD', 'WARNING', 'FAULT']) };
  if (result.nodeAId === result.nodeBId || result.deviceAId === result.deviceBId
    || [result.freqKhz, result.bandwidthKhz].some(value => value !== null && value <= 0)) workspaceFailure('candidate config');
  return result;
}
function candidateSource(value: unknown): CandidateLinkSource {
  const v = workspaceRecord(value); workspaceKeys(v, ['kind', 'file', 'row']);
  const kind = origin(v.kind), file = v.file === null ? null : workspaceText(v.file, 'source.file', false, 255);
  if (v.row !== null && (typeof v.row !== 'number' || !Number.isSafeInteger(v.row) || v.row < 2)) workspaceFailure('source.row');
  if (kind === 'MANUAL' ? file !== null || v.row !== null : file === null || v.row === null) workspaceFailure('source');
  if (file !== null && file !== file.trim()) workspaceFailure('source.file');
  return { kind, file, row: v.row as number | null };
}
function candidate(value: unknown): CandidateLink {
  const v = workspaceRecord(value); workspaceKeys(v, ['id', ...candidateConfig, ...candidateAssessment, 'assessmentState', 'source', 'reference'], ['notices']);
  const result: CandidateLink = { ...candidateData(v), assessmentState: choice(v.assessmentState, ['REFERENCE', 'PENDING']), source: candidateSource(v.source), reference: null };
  if (v.reference !== null) {
    const ref = workspaceRecord(v.reference); workspaceKeys(ref, ['data', 'source']);
    const data = workspaceRecord(ref.data); workspaceKeys(data, ['id', ...candidateConfig, ...candidateAssessment]);
    result.reference = { data: candidateData(data), source: candidateSource(ref.source) };
    if (result.reference.data.id !== result.id || result.reference.source.kind === 'MANUAL'
      || !candidateAssessment.some(key => result.reference!.data[key] !== null)) workspaceFailure('reference');
  }
  if (v.notices !== undefined) result.notices = array(v.notices, s => workspaceText(s, 'notice'));
  const evaluated = candidateAssessment.some(key => result[key] !== null);
  if (result.assessmentState === 'PENDING' && evaluated || result.assessmentState === 'REFERENCE' && (!evaluated || !result.reference
    || [...candidateConfig.filter(key => key !== 'isBackup'), ...candidateAssessment].some(key => result[key] !== result.reference!.data[key])
    || !workspaceEqual(result.source, result.reference.source))
    || result.source.kind === 'MANUAL' && (result.assessmentState !== 'PENDING' || evaluated || result.reference !== null)) workspaceFailure('candidate assessment');
  return result;
}
export function readWorkspaceResources(value: unknown, expectedRevision?: string): ResourcesData {
  const v = workspaceRecord(value); workspaceKeys(v, ['stations', 'devices', 'models', 'antennas', 'source', 'version'], ['interferences', 'candidateLinks', 'planningBounds']);
  const version = workspaceRevision(v.version);
  if (expectedRevision !== undefined && version !== expectedRevision || v.source !== workspaceSource) workspaceFailure('resource version/source');
  const resources: ResourcesData = { stations: unique(array(v.stations, station)), devices: unique(array(v.devices, device)), models: unique(array(v.models, model)),
    antennas: unique(array(v.antennas, antenna)), source: v.source, version };
  if (Object.hasOwn(v, 'interferences')) resources.interferences = unique(array(v.interferences, interference));
  if (Object.hasOwn(v, 'candidateLinks')) resources.candidateLinks = unique(array(v.candidateLinks, candidate));
  if (Object.hasOwn(v, 'planningBounds')) {
    if (v.planningBounds !== null && !validPlanningBounds(v.planningBounds)) workspaceFailure('planningBounds');
    resources.planningBounds = v.planningBounds === null ? null : [...v.planningBounds as NonNullable<ResourcesData['planningBounds']>];
  }
  const nodes = new Map(resources.stations.map(row => [row.id, row])), devices = new Map(resources.devices.map(row => [row.id, row]));
  const models = new Map(resources.models.map(row => [row.id, row])), antennas = new Set(resources.antennas.map(row => row.id));
  for (const row of resources.stations) if (row.parentIds.some(id => id === row.id || !nodes.has(id))) workspaceFailure('parent reference');
  // 拓扑仅核验引用及环，不在浏览器重做规划或导入差异计算。
  const completed = new Set<string>();
  for (const row of resources.stations) {
    const active = new Set<string>(), stack: { id: string; exit: boolean }[] = [{ id: row.id, exit: false }];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.exit) { active.delete(item.id); completed.add(item.id); continue; }
      if (active.has(item.id)) workspaceFailure('parent cycle');
      if (completed.has(item.id)) continue;
      active.add(item.id); stack.push({ id: item.id, exit: true });
      for (const id of nodes.get(item.id)!.parentIds) stack.push({ id, exit: false });
    }
  }
  for (const row of resources.devices) if (!nodes.has(row.stationId) || !models.has(row.modelId) || !antennas.has(row.antennaId)) workspaceFailure('device reference');
  for (const row of resources.candidateLinks ?? []) {
    for (const [nodeId, deviceId] of [[row.nodeAId, row.deviceAId], [row.nodeBId, row.deviceBId]]) {
      const endpoint = devices.get(deviceId);
      if (!nodes.has(nodeId) || endpoint?.stationId !== nodeId || models.get(endpoint.modelId)?.deviceClass !== row.deviceClass) workspaceFailure('candidate reference');
    }
  }
  return resources;
}
export function readWorkspaceMeta(value: unknown, resources: ResourcesData): ResourceMeta {
  const v = workspaceRecord(value);
  workspaceKeys(v, ['revision', 'resourceEpoch', 'stationVersions', 'deviceVersions', 'savedAt', 'changedStationIds', 'changedDeviceIds'], ['interferenceVersion', 'changedInterferenceIds', 'receipts']);
  if (workspaceRevision(v.revision) !== resources.version) workspaceFailure('meta revision');
  const versions = (value: unknown, ids: string[]) => {
    const rows = workspaceRecord(value);
    if (Object.keys(rows).length !== ids.length || ids.some(id => !Object.hasOwn(rows, id))) workspaceFailure('version references');
    return Object.fromEntries(Object.entries(rows).map(([id, rev]) => [id, workspaceRevision(rev)]));
  };
  const changedStationIds = workspaceIds(v.changedStationIds), changedDeviceIds = workspaceIds(v.changedDeviceIds);
  const stationIds = resources.stations.map(row => row.id), deviceIds = resources.devices.map(row => row.id);
  if (changedStationIds.some(id => !stationIds.includes(id)) || changedDeviceIds.some(id => !deviceIds.includes(id))) workspaceFailure('changed references');
  const meta: ResourceMeta = { revision: resources.version, resourceEpoch: workspaceRevision(v.resourceEpoch), stationVersions: versions(v.stationVersions, stationIds),
    deviceVersions: versions(v.deviceVersions, deviceIds), savedAt: v.savedAt === null ? null : timestamp(v.savedAt), changedStationIds, changedDeviceIds };
  if (Object.hasOwn(v, 'interferenceVersion')) meta.interferenceVersion = workspaceRevision(v.interferenceVersion);
  if (Object.hasOwn(v, 'changedInterferenceIds')) {
    meta.changedInterferenceIds = workspaceIds(v.changedInterferenceIds);
    if (meta.changedInterferenceIds.some(id => !resources.interferences?.some(row => row.id === id))) workspaceFailure('interference references');
  }
  if (Object.hasOwn(v, 'receipts')) {
    meta.receipts = array(v.receipts, item => {
      const receipt = workspaceRecord(item); workspaceKeys(receipt, ['requestId', 'signature', 'revision', 'changed']);
      if (typeof receipt.signature !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.signature)) workspaceFailure('meta receipt signature');
      return { requestId: workspaceId(receipt.requestId), signature: receipt.signature, revision: workspaceRevision(receipt.revision), changed: boolean(receipt.changed) };
    });
  }
  return meta;
}
export function readWorkspaceIssues(value: unknown): ResourceIssue[] {
  return array(value, item => {
    const v = workspaceRecord(item); workspaceKeys(v, ['objectId', 'field', 'message'], ['sheet', 'row']);
    const issue: ResourceIssue = { objectId: workspaceText(v.objectId, 'objectId', true), field: workspaceText(v.field, 'field'), message: workspaceText(v.message, 'message', false, 4096) };
    if (v.sheet !== undefined) {
      const sheet = workspaceText(v.sheet, 'issue.sheet', true, 128);
      if (/[\u0080-\u009f]/.test(sheet)) workspaceFailure('issue.sheet');
      issue.sheet = sheet;
    }
    if (v.row !== undefined) {
      if (typeof v.row !== 'number' || !Number.isSafeInteger(v.row) || v.row < 0) workspaceFailure('issue.row');
      issue.row = v.row;
    }
    return issue;
  });
}
const stationPatch = ['name', 'coordinate', 'elevationM', 'region', 'remark'];
const devicePatch = ['antennaHeightM', 'txPowerDbm', 'workFreqKhz', 'currentWorkMode', 'ports'];
function patch(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const v = workspaceRecord(value); workspaceKeys(v, ['id'], fields); workspaceId(v.id);
  if (Object.keys(v).length < 2) workspaceFailure('empty patch');
  for (const [key, value] of Object.entries(v)) {
    if (key === 'id') continue;
    if (key === 'coordinate') coordinate(value);
    else if (key === 'ports') ports(value);
    else if (['active'].includes(key)) boolean(value);
    else if (key === 'isBackup') nullableBoolean(value);
    else if (key === 'deviceClass') deviceClass(value);
    else if (key.endsWith('Id')) workspaceId(value);
    else if (['name', 'region', 'remark', 'interferenceType'].includes(key)) workspaceText(value, key, key === 'region' || key === 'remark');
    else if (['currentWorkMode', 'patternType'].includes(key)) { if (value !== null) workspaceText(value, key); }
    else if (fields === interferenceFields && ['antennaHeightM', 'centerFreqKhz', 'bandwidthKhz', 'txPowerDbm'].includes(key)) numeric(value);
    else {
      const number = nullableNumber(value);
      if (fields === candidateConfig && number !== null && number <= 0) workspaceFailure('candidate frequency/bandwidth');
    }
  }
  return structuredClone(v);
}
export const workspaceChangeKeys = ['stations', 'devices', 'newStations', 'newDevices', 'newInterferences', 'interferences', 'candidateLinks', 'newCandidateLinks', 'importedCandidateLinks'] as const;
export function readWorkspaceChanges(value: unknown, newOrigin: 'MANUAL' | 'IMPORT'): ResourceChanges {
  const v = workspaceRecord(value); workspaceKeys(v, ['stations', 'devices'], workspaceChangeKeys);
  if (newOrigin === 'MANUAL' && Object.hasOwn(v, 'importedCandidateLinks')) workspaceFailure('imported candidate');
  for (const [key, rows] of Object.entries(v)) {
    let decoded: { id: string }[];
    if (key === 'stations' || key === 'devices' || key === 'interferences' || key === 'candidateLinks') {
      decoded = array(rows, row => patch(row, key === 'stations' ? stationPatch : key === 'devices' ? devicePatch : key === 'interferences' ? interferenceFields : candidateConfig) as { id: string });
    } else {
      decoded = array(rows, row => {
        const result = key === 'newStations' ? station(row) : key === 'newDevices' ? device(row) : key === 'newInterferences' ? interference(row) : candidate(row);
        if ('source' in result ? result.source.kind !== newOrigin : result.origin !== newOrigin) workspaceFailure('new object origin');
        return result;
      });
    }
    unique(decoded);
  }
  for (const [created, updated] of [['newStations', 'stations'], ['newDevices', 'devices'], ['newInterferences', 'interferences'], ['newCandidateLinks', 'candidateLinks']] as const) {
    const additions = (v[created] ?? []) as { id: string }[], patches = (v[updated] ?? []) as { id: string }[];
    if (additions.some(row => patches.some(p => p.id === row.id))) workspaceFailure('duplicate changed object');
  }
  const candidateIds = ['newCandidateLinks', 'candidateLinks', 'importedCandidateLinks'].flatMap(key => ((v[key] ?? []) as { id: string }[]).map(row => row.id));
  if (new Set(candidateIds).size !== candidateIds.length) workspaceFailure('duplicate changed candidate');
  // 所有嵌套字段已校验，复制后不保留页面可变对象。
  return structuredClone(v) as unknown as ResourceChanges;
}
export function workspaceCommitBody(input: ResourceCommit) {
  try {
    const v = workspaceRecord(input); workspaceKeys(v, ['context', 'baseRevision', 'requestId', 'stations', 'devices'], workspaceChangeKeys);
    const context = choice(v.context, ['ledger', 'gis']), baseRevision = workspaceRevision(v.baseRevision), requestId = workspaceId(v.requestId);
    if (context !== 'gis' && ['newCandidateLinks', 'candidateLinks'].some(key => Object.hasOwn(v, key))) workspaceFailure('candidate context');
    const submitted = structuredClone(Object.fromEntries(Object.entries(v).filter(([key]) => workspaceChangeKeys.includes(key as typeof workspaceChangeKeys[number]))));
    for (const key of ['devices', 'newDevices']) {
      if (!Array.isArray(submitted[key])) continue;
      for (const value of submitted[key]) {
        const row = workspaceRecord(value);
        if (row.currentWorkMode != null) throw new ApiError('工作模式协议待确认，HTTP暂不支持修改', 'VALIDATION_ERROR');
        delete row.currentWorkMode;
      }
    }
    const changes = readWorkspaceChanges(submitted, 'MANUAL');
    return { context, base_revision: baseRevision, request_id: requestId, changes };
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'INVALID_RESOURCE_RESPONSE') throw error;
    throw new ApiError('资源工作区请求字段无效', 'VALIDATION_ERROR');
  }
}
export function assertWorkspaceCandidateSave(resources: ResourcesData, changes: ResourceChanges): void {
  for (const expected of [...changes.newCandidateLinks ?? [], ...changes.candidateLinks ?? []]) {
    const saved = resources.candidateLinks?.find(row => row.id === expected.id);
    if (!saved || candidateConfig.some(key => Object.hasOwn(expected, key) && saved[key] !== expected[key])) workspaceFailure('saved candidate config');
  }
  for (const expected of changes.newCandidateLinks ?? []) {
    const saved = resources.candidateLinks!.find(row => row.id === expected.id)!;
    if (saved.source.kind !== 'MANUAL' || saved.assessmentState !== 'PENDING' || saved.reference !== null) workspaceFailure('saved manual candidate');
  }
}
export type WorkspaceContext = ResourceMaintenanceContext & { resources: ResourcesData; meta: ResourceMeta };
export function readWorkspaceContext(value: unknown, context: 'ledger' | 'gis', expectedRevision?: string): WorkspaceContext & Partial<GisResourceEditContext> {
  const v = workspaceRecord(value);
  workspaceKeys(v, ['revision', 'baseRevision', 'device', 'stations', 'models', 'antennas', 'impact', 'resources', 'meta'],
    ['resourceMeta', 'situation', 'validationSource']);
  const revision = workspaceRevision(v.revision);
  if (expectedRevision !== undefined && expectedRevision !== revision || v.baseRevision !== revision || v.device !== null) workspaceFailure('context revision/device');
  const resources = readWorkspaceResources(v.resources, revision), meta = readWorkspaceMeta(v.meta, resources);
  const stations = unique(array(v.stations, station)), models = unique(array(v.models, model)), antennas = unique(array(v.antennas, antenna));
  if (!workspaceEqual(stations, resources.stations) || !workspaceEqual(models, resources.models) || !workspaceEqual(antennas, resources.antennas)) workspaceFailure('context dictionaries');
  const impact = workspaceRecord(v.impact); workspaceKeys(impact, ['planIds', 'linkIds', 'description']);
  const result: WorkspaceContext & Partial<GisResourceEditContext> = { revision, baseRevision: revision, device: null, resources, meta, stations, models, antennas,
    impact: { planIds: workspaceIds(impact.planIds), linkIds: workspaceIds(impact.linkIds), description: workspaceText(impact.description, 'impact.description') } };
  if (context === 'gis' || ['resourceMeta', 'situation', 'validationSource'].some(key => Object.hasOwn(v, key))) {
    result.resourceMeta = readWorkspaceMeta(v.resourceMeta, resources);
    result.validationSource = readWorkspaceResources(v.validationSource, revision);
    if (!workspaceEqual(result.resourceMeta, meta) || !workspaceEqual(result.validationSource, resources)) workspaceFailure('GIS baseline');
    const s = workspaceRecord(v.situation); workspaceKeys(s, ['title', 'snapshotId', 'updatedAt', 'links', 'candidateLinks', 'regions', 'alerts', 'spectrum']);
    if (s.snapshotId !== revision || ['links', 'candidateLinks', 'regions', 'alerts', 'spectrum'].some(key => !Array.isArray(s[key]) || s[key].length !== 0)) workspaceFailure('GIS unbound situation');
    result.situation = { title: workspaceText(s.title, 'situation.title'), snapshotId: revision, updatedAt: timestamp(s.updatedAt), links: [], candidateLinks: [], regions: [], alerts: [], spectrum: [] } satisfies SituationData;
  }
  return result;
}
export function workspaceEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array) return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((v, i) => v === b[i]);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => workspaceEqual(v, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && workspaceEqual(left[key], right[key]));
}
export function readWorkspaceMutation(value: unknown, baseRevision: string, expectedObjectId: string, submittedIds: string[]): { receipt: ResourceMutationReceipt; result: ResourceSaveResult } {
  const v = workspaceRecord(value); workspaceKeys(v, ['receipt', 'result']);
  const r = workspaceRecord(v.receipt); workspaceKeys(r, ['objectId', 'changed', 'revision', 'readRevision', 'warnings', 'affectedIds'], ['device', 'updated', 'unchanged']);
  const revision = workspaceRevision(r.revision), changed = boolean(r.changed);
  if (r.readRevision !== revision || changed === (revision === baseRevision) || r.objectId !== expectedObjectId) workspaceFailure('receipt revision/object');
  const receipt: ResourceMutationReceipt = { objectId: workspaceId(r.objectId), changed, revision, readRevision: revision, warnings: readWorkspaceIssues(r.warnings), affectedIds: workspaceIds(r.affectedIds) };
  if (Object.hasOwn(r, 'device')) receipt.device = device(r.device);
  if (Object.hasOwn(r, 'updated')) receipt.updated = workspaceIds(r.updated);
  if (Object.hasOwn(r, 'unchanged')) receipt.unchanged = workspaceIds(r.unchanged);
  if (changed !== (receipt.affectedIds.length > 0) || receipt.affectedIds.some(id => !submittedIds.includes(id))) workspaceFailure('receipt affected objects');
  const saved = workspaceRecord(v.result); workspaceKeys(saved, ['resources', 'meta', 'changed', 'warnings']);
  const resources = readWorkspaceResources(saved.resources, revision), meta = readWorkspaceMeta(saved.meta, resources), warnings = readWorkspaceIssues(saved.warnings);
  if (saved.changed !== changed || !workspaceEqual(warnings, receipt.warnings)) workspaceFailure('save result');
  const ids = new Set([...resources.stations, ...resources.devices, ...resources.interferences ?? [], ...resources.candidateLinks ?? []].map(row => row.id));
  if (receipt.affectedIds.some(id => !ids.has(id)) || receipt.device && !workspaceEqual(receipt.device, resources.devices.find(row => row.id === receipt.device!.id))) workspaceFailure('receipt references');
  return { receipt, result: { resources, meta, changed, warnings } };
}
