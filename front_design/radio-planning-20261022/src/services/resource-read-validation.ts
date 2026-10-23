import { ApiError } from './types';
import type { Coordinate, DeviceModel, ResourceOrigin } from '../types/domain';
import type { Bounds, ReadDevice, ReadInterference, ReadNode, ReadObject, ReadOptions, ResourceMapFrame, ResourceMapQuery, ResourceObjectKind, ResourcePage, ResourcePageQuery, ResourceReadStats, ResourceReadWorkspace, VersionedRead } from '../types/resource-read';
import { matchesLedgerQuery, projectReadLedgerRows } from './resource-ledger-workspace';
import { validPageQuery } from './data-access';

const fail = (field: string): never => { throw new ApiError(`资源读取数据不完整或无效：${field}`, 'INVALID_RESOURCE_RESPONSE'); };
export const readRecord = (v: unknown, field = 'data'): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail(field);
export const readText = (v: unknown, field: string): string => typeof v === 'string' && !!v.trim() && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v) ? v : fail(field);
const textOrEmpty = (v: unknown, field: string) => v == null || v === '' ? '' : readText(v, field);
const numeric = (v: unknown, field: string): number => typeof v === 'number' && Number.isFinite(v) ? v : fail(field);
const count = (v: unknown, field: string): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fail(field);
const nullableNumber = (v: unknown, field: string) => v == null || v === '' ? null : numeric(v, field);
const nullableCount = (v: unknown, field: string) => v == null ? null : count(v, field);
const bool = (v: unknown, field: string): boolean => typeof v === 'boolean' ? v : fail(field);
const optionalBool = (v: unknown, field: string) => v == null ? null : bool(v, field);
function choice<const T extends string>(v: unknown, choices: readonly T[], field: string): T { return choices.includes(v as T) ? v as T : fail(field); }
const origin = (v: unknown): ResourceOrigin | null => v == null || v === '' ? null : choice(v, ['SOURCE', 'MANUAL', 'IMPORT'], 'origin');
const status = (v: unknown) => choice(v, ['NORMAL', 'FAULT', 'OFFLINE'], 'status');
const deviceClass = (v: unknown) => choice(v, ['HF', 'VUHF'], 'device_class');
function strings(v: unknown, field: string): string[] {
  // 兼容来源 CSV 的分号多值，仅在传输边界转换。
  const values = typeof v === 'string' ? v.split(';').map(s => s.trim()).filter(Boolean) : v;
  if (!Array.isArray(values)) return fail(field);
  const result = values.map(s => readText(s, field));
  if (new Set(result).size !== result.length) fail(field);
  return result;
}
export function readCoordinate(lon: unknown, lat: unknown): Coordinate {
  const point: Coordinate = [numeric(lon, 'lon'), numeric(lat, 'lat')];
  if (Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) fail('coordinate');
  return point;
}
export function readBounds(v: unknown): Bounds {
  if (!Array.isArray(v) || v.length !== 4) return fail('bbox');
  const a = readCoordinate(v[0], v[1]), b = readCoordinate(v[2], v[3]);
  if (a[0] >= b[0] || a[1] >= b[1]) fail('bbox');
  return [...a, ...b];
}
export function assertReadOptions(input: ReadOptions, versioned = false): void {
  if (!input || !['ledger', 'gis', 'planning'].includes(input.context)) throw new ApiError('缺少有效的资源读取页面上下文', 'INVALID_RESOURCE_QUERY');
  if (versioned) readText((input as VersionedRead).revision, 'revision');
  if (input.signal?.aborted) throw new ApiError('读取已取消', 'REQUEST_ABORTED');
}
function assertFilter(input: ResourcePageQuery | ResourceMapQuery) {
  if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 120 || /[\u0000-\u001f\u007f]/.test(input.search))) fail('search');
  if (input.deviceClass !== undefined) deviceClass(input.deviceClass);
  if (input.status !== undefined) choice(input.status, ['NORMAL', 'FAULT', 'OFFLINE', 'UNKNOWN'], 'status');
  if (input.availability !== undefined) choice(input.availability, ['ACTIVE', 'OFF_SHELF', 'UNKNOWN'], 'availability');
  if (input.alert !== undefined) choice(input.alert, ['YES', 'NO', 'UNKNOWN'], 'alert');
  for (const key of ['mobility', 'nodeRole', 'observationSnapshotId'] as const) if (input[key] !== undefined) readText(input[key], key);
  if (input.relayCapable !== undefined) bool(input.relayCapable, 'relayCapable');
  if (input.statusMode !== undefined) choice(input.statusMode, ['baseline', 'observed'], 'statusMode');
  if (input.statusMode === 'observed' && !input.observationSnapshotId) fail('observationSnapshotId');
  if (input.frequency !== undefined) {
    const f = readRecord(input.frequency, 'frequency');
    choice(f.mode, ['ALL', 'MODEL', 'DEVICE'], 'frequency.mode'); choice(f.presence, ['ALL', 'PRESENT', 'MISSING'], 'frequency.presence');
    const min = nullableNumber(f.minKhz, 'minKhz'), max = nullableNumber(f.maxKhz, 'maxKhz');
    if (min !== null && min < 0 || max !== null && max < 0 || min !== null && max !== null && min > max) fail('frequency.range');
  }
}
export function assertPageQuery(input: ResourcePageQuery) {
  assertReadOptions(input, true); assertFilter(input);
  if (!validPageQuery(input)) fail('pageNum/pageSize');
  if (input.sort !== undefined) choice(input.sort, ['id', 'name', 'status', 'workFreqKhz'], 'sort');
  if (input.order !== undefined) choice(input.order, ['asc', 'desc'], 'order');
  for (const key of ['nodeId', 'parentId', 'clusterId'] as const) if (input[key] != null) readText(input[key], key);
}
export function assertMapQuery(input: ResourceMapQuery) {
  assertReadOptions(input, true); assertFilter(input); readBounds(input.bbox);
  if (!Number.isFinite(input.zoom) || input.zoom < 0 || input.zoom > 20) fail('zoom');
  bool(input.showNodes, 'show_nodes'); bool(input.showInterferences, 'show_interferences');
}
export function requireRevision(v: unknown, expected?: string): string {
  const revision = readText(v, 'revision');
  if (expected && revision !== expected) throw new ApiError('资源版本已变化，请刷新后继续浏览', 'RESOURCE_VERSION_CHANGED', { expected, actual: revision });
  return revision;
}
export function decodeWorkspace(value: unknown): ResourceReadWorkspace {
  const v = readRecord(value);
  const updatedAt = readText(v.updated_at, 'updated_at');
  if (!Number.isFinite(Date.parse(updatedAt)) || !/(Z|[+-]\d{2}:\d{2})$/.test(updatedAt)) fail('updated_at');
  const terrain = v.terrain == null ? null : readRecord(v.terrain, 'terrain');
  if (terrain && (typeof terrain.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(terrain.source_sha256))) fail('terrain.source_sha256');
  return { revision: requireRevision(v.revision), bounds: readBounds(v.bounds), updatedAt, source: readText(v.source, 'source'), stats: decodeReadStats(v.stats),
    terrain: terrain ? { sourceSha256: terrain.source_sha256 as string, bounds: readBounds(terrain.bbox), source: readText(terrain.source, 'terrain.source') } : null };
}
// 工作区及分页结果复用全库统计校验，分页数量不能代替全库数量。
function decodeReadStats(value: unknown): ResourceReadStats {
  const s = readRecord(value, 'stats');
  const stats = { nodes: count(s.nodes, 'nodes'), devices: count(s.devices, 'devices'), models: count(s.models, 'models'), interferences: count(s.interferences, 'interferences'),
    hf: count(s.hf, 'hf'), vuhf: count(s.vuhf, 'vuhf'), alerts: nullableCount(s.alerts, 'alerts'), unknownAlerts: nullableCount(s.unknown_alerts, 'unknown_alerts'),
    active: nullableCount(s.active, 'active'), offShelf: nullableCount(s.off_shelf, 'off_shelf'), unknownAvailability: nullableCount(s.unknown_availability, 'unknown_availability') };
  if (stats.hf + stats.vuhf !== stats.devices || Object.values(stats).some(n => n !== null && n < 0)) fail('stats');
  if ([stats.active, stats.offShelf, stats.unknownAvailability].every(n => n !== null) && stats.active! + stats.offShelf! + stats.unknownAvailability! !== stats.devices) fail('availability stats');
  if (stats.alerts !== null && stats.alerts > stats.devices || stats.unknownAlerts !== null && stats.unknownAlerts > stats.devices || stats.alerts !== null && stats.unknownAlerts !== null && stats.alerts + stats.unknownAlerts > stats.devices) fail('alert stats');
  const deployments = s.deployments == null ? null : Object.fromEntries(['HF', 'VUHF'].map(c => {
    const group = readRecord(readRecord(s.deployments)[c], 'deployments.' + c);
    const entries = Object.entries(group).map(([key, value]) => [key, count(value, 'deployments.' + key)] as const);
    if (entries.reduce((n, [, value]) => n + value, 0) !== (c === 'HF' ? stats.hf : stats.vuhf)) fail('deployments total');
    return [c, Object.fromEntries(entries)];
  })) as ResourceReadStats['deployments'];
  return { ...stats, deployments };
}
export function decodeObject(kind: ResourceObjectKind, value: unknown): ReadObject {
  const v = readRecord(value), id = readText(v[kind === 'node' ? 'node_id' : kind === 'device' ? 'device_id' : 'interference_id'], 'id');
  if (kind === 'device') return {
    kind, id, stationId: readText(v.node_id, 'node_id'), modelId: readText(v.model_id, 'model_id'), antennaId: readText(v.antenna_id, 'antenna_id'),
    stationName: readText(v.node_name, 'node_name'), stationCoordinate: readCoordinate(v.node_lon, v.node_lat), modelName: readText(v.model_name, 'model_name'), antennaName: readText(v.antenna_name, 'antenna_name'), deviceClass: deviceClass(v.device_class),
    status: status(v.status), alert: optionalBool(v.alert, 'alert'), origin: origin(v.origin), availability: v.availability == null ? null : choice(v.availability, ['ACTIVE', 'OFF_SHELF'], 'availability'),
    antennaHeightM: nullableNumber(v.antenna_height_m, 'antenna_height_m'), txPowerDbm: nullableNumber(v.tx_power_dbm, 'tx_power_dbm'), workFreqKhz: nullableNumber(v.work_freq_khz, 'work_freq_khz'),
    currentWorkMode: v.current_work_mode == null ? null : readText(v.current_work_mode,'current_work_mode'),
    tiltDeg: nullableNumber(v.tilt_deg, 'tilt_deg'), azimuthDeg: nullableNumber(v.azimuth_deg, 'azimuth_deg'), installedAt: textOrEmpty(v.install_time, 'install_time'),
    region: v.region == null ? null : textOrEmpty(v.region, 'region'), mobility: v.mobility == null ? null : readText(v.mobility, 'mobility'),
    nodeRole: v.node_role == null ? null : textOrEmpty(v.node_role, 'node_role'), relayCapable: optionalBool(v.relay_capable, 'relay_capable'),
    freqMinKhz: nullableNumber(v.freq_min_khz, 'freq_min_khz'), freqMaxKhz: nullableNumber(v.freq_max_khz, 'freq_max_khz'),
  } satisfies ReadDevice;
  const coordinate = readCoordinate(v.lon, v.lat), elevationM = nullableNumber(v.elevation_m, 'elevation_m');
  if (kind === 'node') {
    const parentIds = strings(v.parent_node_id, 'parent_node_id');
    if (parentIds.includes(id)) fail('self parent');
    return { kind, id, name: readText(v.node_name, 'node_name'), coordinate, elevationM, parentIds,
      echelon: readText(v.echelon, 'echelon'), subtype: textOrEmpty(v.node_subtype, 'node_subtype'), role: textOrEmpty(v.node_role, 'node_role'), mobility: readText(v.mobility, 'mobility'), region: textOrEmpty(v.region, 'region'), remark: textOrEmpty(v.remark, 'remark'),
      classes: strings(v.device_class, 'device_class').map(deviceClass), status: status(v.status), alert: optionalBool(v.alert, 'alert'), origin: origin(v.origin), relayCapable: bool(v.relay_capable, 'relay_capable'), key: bool(v.is_key, 'is_key'),
      childCount: count(v.child_count, 'child_count'), deviceCount: count(v.device_count, 'device_count') } satisfies ReadNode;
  }
  return { kind, id, name: readText(v.interference_name, 'interference_name'), coordinate, elevationM, origin: origin(v.origin),
    antennaHeightM: numeric(v.antenna_height_m, 'antenna_height_m'), centerFreqKhz: numeric(v.center_freq_khz, 'center_freq_khz'), bandwidthKhz: numeric(v.bandwidth_khz, 'bandwidth_khz'), txPowerDbm: numeric(v.tx_power_dbm, 'tx_power_dbm'),
    antennaGainDbi: nullableNumber(v.antenna_gain_dbi, 'antenna_gain_dbi'), interferenceType: readText(v.interference_type, 'interference_type'), patternType: textOrEmpty(v.pattern_type, 'pattern_type') || null,
    azimuthDeg: nullableNumber(v.azimuth_deg, 'azimuth_deg'), dutyCycle: nullableNumber(v.duty_cycle, 'duty_cycle'), active: bool(v.active, 'active') } satisfies ReadInterference;
}
export function decodePage<T extends ReadObject>(kind: ResourceObjectKind, value: unknown, query: ResourcePageQuery): ResourcePage<T> {
  const v = readRecord(value), revision = requireRevision(v.revision, query.revision);
  // 既有 HTTP 草案仍用 page/page_size，只在边界映射一次。
  if (!Array.isArray(v.items) || v.items.length > query.pageSize || v.page !== query.pageNum || v.page_size !== query.pageSize) fail('page');
  const items = (v.items as unknown[]).map(x => decodeObject(kind, x) as T), total = count(v.total, 'total');
  // 全库筛选由服务端执行；不能接纳未过滤的当前页再假报匹配总数。
  if (kind === 'device' && query.availability && items.some(row => row.kind !== 'device'
    || (row.availability ?? 'UNKNOWN') !== query.availability)) fail('availability filter result');
  // 新增条件若被服务忽略，拒绝错误结果；不能在当前页补筛后宣称全库匹配。
  if (kind === 'device' && (query.mobility || query.nodeRole || query.relayCapable !== undefined || query.frequency)
    && items.some(row => row.kind === 'device' && !matchesLedgerQuery(projectReadLedgerRows([row])[0]!, { mobility: query.mobility, nodeRole: query.nodeRole, relayCapable: query.relayCapable, frequency: query.frequency }))) fail('ledger filter result');
  if (kind === 'node' && items.some(row => row.kind === 'node' && (query.mobility && row.mobility !== query.mobility || query.nodeRole && row.role !== query.nodeRole || query.relayCapable !== undefined && row.relayCapable !== query.relayCapable))) fail('node classification result');
  if (new Set(items.map(x => x.id)).size !== items.length || items.length !== Math.min(query.pageSize, Math.max(0, total - (query.pageNum - 1) * query.pageSize))) fail('page items/total');
  if (query.nodeId && items.some(x => x.kind !== 'device' || x.stationId !== query.nodeId)) fail('node_id association');
  const parentId = query.parentId;
  if (parentId !== undefined && items.some(x => x.kind !== 'node' || (parentId === null ? x.parentIds.length !== 0 : !x.parentIds.includes(parentId)))) fail('parent association');
  return { revision, items, total, pageNum: query.pageNum, pageSize: query.pageSize, ...(v.stats === undefined ? {} : { stats: decodeReadStats(v.stats) }) };
}
export function decodeModel(value: unknown): DeviceModel {
  const v = readRecord(value);
  const result = { id: readText(v.model_id, 'model_id'), name: readText(v.model_name, 'model_name'), manufacturer: textOrEmpty(v.manufacturer, 'manufacturer'), deviceClass: deviceClass(v.device_class), freqMinKhz: numeric(v.freq_min_khz, 'freq_min_khz'), freqMaxKhz: numeric(v.freq_max_khz, 'freq_max_khz'), txPowerMaxDbm: numeric(v.tx_power_max_dbm, 'tx_power_max_dbm'), modulation: strings(v.modulation, 'modulation'), workMode: strings(v.work_mode, 'work_mode') };
  if (result.freqMinKhz > result.freqMaxKhz) fail('frequency range');
  return result;
}
export function decodeMap(value: unknown, query: ResourceMapQuery): ResourceMapFrame {
  const v = readRecord(value), revision = requireRevision(v.revision, query.revision), bbox = readBounds(v.bbox);
  if (bbox.some((n, i) => n !== query.bbox[i]) || v.zoom !== query.zoom || !Array.isArray(v.points) || !Array.isArray(v.clusters) || v.points.length + v.clusters.length > 2000) fail('map envelope');
  const inside = (p: Coordinate, b = bbox) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
  const points = (v.points as unknown[]).map(value => {
    const p = readRecord(value), kind = choice(p.kind, ['node', 'interference'], 'point.kind'), coordinate = readCoordinate(p.lon, p.lat);
    if (!inside(coordinate)) fail('point outside bbox');
    return { kind, id: readText(p.id, 'point.id'), name: readText(p.name, 'point.name'), coordinate,
      status: kind === 'node' ? status(p.status) : null, alert: kind === 'node' ? optionalBool(p.alert, 'alert') : null, active: kind === 'interference' ? bool(p.active, 'active') : null };
  });
  const clusters = (v.clusters as unknown[]).map(value => {
    const c = readRecord(value), coordinate = readCoordinate(c.lon, c.lat), bounds = readBounds(c.bounds), n = count(c.count, 'cluster.count');
    const expansionZoom = c.expansion_zoom == null ? null : numeric(c.expansion_zoom, 'expansion_zoom');
    if (n < 2 || !inside(coordinate) || !inside(coordinate, bounds) || expansionZoom !== null && (expansionZoom <= query.zoom || expansionZoom > 17)) fail('cluster');
    return { kind: choice(c.kind, ['node', 'interference'], 'cluster.kind'), id: readText(c.cluster_id, 'cluster_id'), coordinate, bounds, count: n, expansionZoom };
  });
  const keys = [...points.map(p => `p:${p.kind}:${p.id}`), ...clusters.map(c => `c:${c.kind}:${c.id}`)];
  if (new Set(keys).size !== keys.length) fail('duplicate map object');
  const totalNodes = count(v.total_nodes, 'total_nodes'), totalInterferences = count(v.total_interferences, 'total_interferences');
  for (const kind of ['node', 'interference'] as const) {
    const actual = points.filter(p => p.kind === kind).length + clusters.filter(c => c.kind === kind).reduce((n, c) => n + c.count, 0);
    if (actual !== (kind === 'node' ? totalNodes : totalInterferences) || actual && !(kind === 'node' ? query.showNodes : query.showInterferences)) fail('map totals/layers');
  }
  return { revision, bbox, zoom: query.zoom, points, clusters, totalNodes, totalInterferences };
}
