import { ApiError } from './types';
import type {
  GisFrozenDemand, GisFrozenDevice, GisFrozenLink, GisFrozenNode, GisFrozenRoute,
  GisLinkDetail, GisLinkQuery, GisNetwork, GisPaths, GisPathsQuery, GisPlanIdentity, GisPlanQuery,
} from '../types/gis-plan';

const invalid = () => new ApiError('冻结 GIS 方案响应不符合契约，请重新打开方案', 'INVALID_GIS_PLAN_RESPONSE');
const badQuery = () => new ApiError('请选择明确的任务、方案和快照', 'INVALID_GIS_PLAN_QUERY');
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 120 && !/[\s\u0000-\u001f\u007f]/u.test(value);
function id(value: unknown): string { if (!isId(value)) throw invalid(); return value; }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) throw invalid();
  return row;
}
function array<T>(value: unknown, read: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map(read);
}
function text(value: unknown): string { if (typeof value !== 'string') throw invalid(); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw invalid(); return value; }
function number(value: unknown, min = -Infinity, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid();
  return value;
}
function positive(value: unknown): number { const result = number(value, 0); if (result === 0) throw invalid(); return result; }
function nullable<T>(value: unknown, read: (item: unknown) => T): T | null { return value === null ? null : read(value); }
function literal<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw invalid();
  return value as T;
}
function unique<T extends { id: string }>(rows: T[]): Map<string, T> {
  const result = new Map(rows.map(row => [row.id, row]));
  if (result.size !== rows.length) throw invalid();
  return result;
}
function ids(value: unknown): string[] {
  const result = array(value, id);
  if (new Set(result).size !== result.length) throw invalid();
  return result;
}
function same(left: unknown, right: unknown): boolean {
  // 只比较已经解码的专用 DTO，不比较属性插入顺序或当前资源状态。
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, i) => same(item, right[i]));
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}

export function validateGisPlanQuery(query: GisPlanQuery, kind: 'network' | 'link' | 'paths'): void {
  const row = query as unknown as Record<string, unknown>;
  const allowed = ['planId', 'taskId', 'snapshotId', ...(kind === 'link' ? ['linkId'] : kind === 'paths' ? ['demandId'] : [])];
  if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !allowed.includes(key))
    || !isId(row.planId) || !isId(row.taskId) || (row.snapshotId !== undefined && !isId(row.snapshotId))
    || (kind !== 'network' && !isId(row.snapshotId)) || (kind === 'link' && !isId(row.linkId))
    || (kind === 'paths' && row.demandId !== undefined && !isId(row.demandId))) throw badQuery();
}
function identity(value: unknown, query: GisPlanQuery): GisPlanIdentity {
  const row = object(value, ['plan_id', 'task_id', 'snapshot_id', 'input_version', 'condition_version', 'resource_revision', 'state', 'source_changed', 'data_origin', 'source']);
  const result: GisPlanIdentity = {
    plan_id: id(row.plan_id), task_id: id(row.task_id), snapshot_id: id(row.snapshot_id),
    input_version: id(row.input_version), condition_version: id(row.condition_version), resource_revision: id(row.resource_revision),
    state: literal(row.state, ['SAVED', 'REFERENCE', 'CONFIRMED']), source_changed: bool(row.source_changed),
    data_origin: literal(row.data_origin, ['SYNTHETIC_INTEGRATION']), source: literal(row.source, ['SR4']),
  };
  if (result.plan_id !== query.planId || result.task_id !== query.taskId
    || (query.snapshotId !== undefined && result.snapshot_id !== query.snapshotId)) throw invalid();
  return result;
}
function node(value: unknown): GisFrozenNode {
  const row = object(value, ['id', 'name', 'coordinate', 'status', 'alert']);
  const name = text(row.name), coordinate = array(row.coordinate, item => number(item));
  if (!name.length || name.length > 512 || coordinate.length !== 2 || Math.abs(coordinate[0]) > 180 || Math.abs(coordinate[1]) > 90) throw invalid();
  return { id: id(row.id), name, coordinate: [coordinate[0], coordinate[1]],
    status: nullable(row.status, item => literal(item, ['NORMAL', 'FAULT', 'OFFLINE'])), alert: nullable(row.alert, bool) };
}
function device(value: unknown): GisFrozenDevice {
  const row = object(value, ['id', 'station_id', 'model_id', 'device_class', 'frequency_khz', 'tx_power_dbm', 'antenna_height_m']);
  return { id: id(row.id), station_id: id(row.station_id), model_id: id(row.model_id), device_class: literal(row.device_class, ['HF', 'VUHF']),
    frequency_khz: nullable(row.frequency_khz, positive), tx_power_dbm: nullable(row.tx_power_dbm, item => number(item)),
    antenna_height_m: nullable(row.antenna_height_m, item => number(item, 0)) };
}
function link(value: unknown): GisFrozenLink {
  const row = object(value, ['id', 'a', 'b', 'device_a', 'device_b', 'device_class', 'frequency_khz', 'backup', 'planned_state']);
  return { id: id(row.id), a: id(row.a), b: id(row.b), device_a: id(row.device_a), device_b: id(row.device_b),
    device_class: literal(row.device_class, ['HF', 'VUHF']), frequency_khz: nullable(row.frequency_khz, positive), backup: bool(row.backup),
    planned_state: nullable(row.planned_state, item => literal(item, ['EXCELLENT', 'GOOD', 'WARNING', 'FAULT'])) };
}
function demand(value: unknown): GisFrozenDemand {
  const row = object(value, ['id', 'source_id', 'target_id', 'source_device_id', 'target_device_id', 'service', 'mandatory', 'required_rate_kbps', 'min_reliability']);
  return { id: id(row.id), source_id: id(row.source_id), target_id: id(row.target_id), source_device_id: nullable(row.source_device_id, id),
    target_device_id: nullable(row.target_device_id, id), service: nullable(row.service, item => literal(item, ['', '话音', '数据', '短消息'])),
    mandatory: nullable(row.mandatory, bool), required_rate_kbps: nullable(row.required_rate_kbps, positive),
    min_reliability: nullable(row.min_reliability, item => number(item, 0, 1)) };
}
function route(value: unknown): GisFrozenRoute {
  const row = object(value, ['id', 'demand_id', 'node_ids', 'link_ids', 'backup']);
  const nodeIds = array(row.node_ids, id), linkIds = array(row.link_ids, id);
  if (!nodeIds.length || nodeIds.length !== linkIds.length + 1) throw invalid();
  return { id: id(row.id), demand_id: id(row.demand_id), node_ids: nodeIds, link_ids: linkIds, backup: bool(row.backup) };
}
function pathFields(row: Record<string, unknown>) {
  const state = literal(row.paths_state, ['ready', 'missing']), message = text(row.paths_message);
  if ((state === 'missing' && !message.trim()) || (state === 'ready' && message !== '')) throw invalid();
  return { paths_state: state, paths_message: message };
}
function associations(network: GisNetwork): void {
  const nodes = unique(network.nodes), devices = unique(network.devices), links = unique(network.links), demands = unique(network.demands);
  unique(network.routes);
  if (!nodes.size || network.devices.some(row => !nodes.has(row.station_id))) throw invalid();
  for (const edge of links.values()) {
    const a = devices.get(edge.device_a), b = devices.get(edge.device_b);
    if (edge.a === edge.b || !nodes.has(edge.a) || !nodes.has(edge.b) || !a || !b || a.station_id !== edge.a || b.station_id !== edge.b
      || a.device_class !== edge.device_class || b.device_class !== edge.device_class) throw invalid();
  }
  for (const row of demands.values()) {
    if (!nodes.has(row.source_id) || !nodes.has(row.target_id)
      || (row.source_device_id !== null && devices.get(row.source_device_id)?.station_id !== row.source_id)
      || (row.target_device_id !== null && devices.get(row.target_device_id)?.station_id !== row.target_id)) throw invalid();
  }
  const kinds = new Set<string>();
  for (const row of network.routes) {
    const owner = demands.get(row.demand_id), kind = JSON.stringify([row.demand_id, row.backup]);
    if (!owner || kinds.has(kind) || row.node_ids[0] !== owner.source_id || row.node_ids.at(-1) !== owner.target_id
      || row.node_ids.some(key => !nodes.has(key))) throw invalid();
    kinds.add(kind);
    for (let i = 0; i < row.link_ids.length; i++) {
      const edge = links.get(row.link_ids[i]), a = row.node_ids[i], b = row.node_ids[i + 1];
      if (!edge || !((edge.a === a && edge.b === b) || (edge.a === b && edge.b === a))) throw invalid();
    }
  }
  if ((network.paths_state === 'ready') !== (network.routes.length > 0)) throw invalid();
}
export function readGisNetwork(value: unknown, query: GisPlanQuery): GisNetwork {
  validateGisPlanQuery(query, 'network');
  const row = object(value, ['identity', 'nodes', 'devices', 'links', 'demands', 'routes', 'paths_state', 'paths_message']);
  const result: GisNetwork = { identity: identity(row.identity, query), nodes: array(row.nodes, node), devices: array(row.devices, device),
    links: array(row.links, link), demands: array(row.demands, demand), routes: array(row.routes, route), ...pathFields(row) };
  associations(result);
  return result;
}
function referenceIdentity(result: GisPlanIdentity, reference: GisPlanIdentity): void {
  // 当前资源变化与方案状态可更新；冻结版本和来源必须仍与打开的网络一致。
  const { source_changed: _changed, state: _state, ...fixed } = result;
  const { source_changed: _referenceChanged, state: _referenceState, ...expected } = reference;
  if (!same(fixed, expected)) throw invalid();
}
export function readGisLinkDetail(value: unknown, query: GisLinkQuery, network: GisNetwork): GisLinkDetail {
  validateGisPlanQuery(query, 'link');
  const source = readGisNetwork(network, { planId: query.planId, taskId: query.taskId, snapshotId: query.snapshotId });
  const row = object(value, ['identity', 'link', 'endpoint_devices', 'demand_ids', 'route_ids', 'observation']);
  const observation = object(row.observation, ['state', 'message', 'samples']);
  const endpointDevices = array(row.endpoint_devices, device), message = text(observation.message);
  const result: GisLinkDetail = { identity: identity(row.identity, query), link: link(row.link),
    endpoint_devices: endpointDevices as [GisFrozenDevice, GisFrozenDevice], demand_ids: ids(row.demand_ids), route_ids: ids(row.route_ids),
    observation: { state: literal(observation.state, ['missing']), message, samples: [] } };
  referenceIdentity(result.identity, source.identity);
  const selected = source.links.find(edge => edge.id === query.linkId), paths = source.routes.filter(path => path.link_ids.includes(query.linkId));
  if (!selected || !same(result.link, selected) || endpointDevices.length !== 2
    || !same(endpointDevices, [source.devices.find(item => item.id === selected.device_a), source.devices.find(item => item.id === selected.device_b)])
    || !same([...result.route_ids].sort(), paths.map(path => path.id).sort())
    || !same([...result.demand_ids].sort(), [...new Set(paths.map(path => path.demand_id))].sort())
    || !message.trim() || !Array.isArray(observation.samples) || observation.samples.length !== 0) throw invalid();
  return result;
}
export function readGisPaths(value: unknown, query: GisPathsQuery, network: GisNetwork): GisPaths {
  validateGisPlanQuery(query, 'paths');
  const source = readGisNetwork(network, { planId: query.planId, taskId: query.taskId, snapshotId: query.snapshotId });
  const row = object(value, ['identity', 'demands', 'routes', 'paths_state', 'paths_message']);
  const result: GisPaths = { identity: identity(row.identity, query), demands: array(row.demands, demand), routes: array(row.routes, route), ...pathFields(row) };
  referenceIdentity(result.identity, source.identity);
  const demands = source.demands.filter(item => query.demandId === undefined || item.id === query.demandId);
  const routes = source.routes.filter(item => query.demandId === undefined || item.demand_id === query.demandId);
  if ((query.demandId !== undefined && !demands.length) || !same(result.demands, demands) || !same(result.routes, routes)
    || result.paths_state !== source.paths_state || result.paths_message !== source.paths_message) throw invalid();
  return result;
}
