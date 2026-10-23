import type { Coordinate, Device, NetworkLink, PlanVersion, Station } from '../types/domain';
import type { DiagnosisImpactLink, DiagnosisImpactNode, DiagnosisRecord, DiagnosisRegion, DiagnosisPropagationPath, FaultInput, ImpactLevel } from '../types/diagnosis';
import { planStations } from './planning-snapshot';
import { ApiError } from './types';
import { assertPropagationPaths } from './diagnosis-propagation';
import { diagnosisDataOrigins } from './diagnosis-presentation';

export const GIS_DIAGNOSIS_LEVELS: readonly ImpactLevel[] = ['SEVERE', 'MODERATE', 'MINOR'];
export type GisDiagnosisTarget = Pick<FaultInput, 'objectType' | 'objectId'>;
export interface GisDiagnosisDisplay {
  record: DiagnosisRecord;
  stations: Station[];
  devices: Device[];
  links: NetworkLink[];
  faults: FaultInput[];
  nodes: DiagnosisImpactNode[];
  impactLinks: DiagnosisImpactLink[];
  regions: DiagnosisRegion[];
  paths?: DiagnosisPropagationPath[];
  // 来源核实不改变冻结内容身份，用于保留同报告的有效选择与视角。
  contentKey: string;
}
export interface GisDiagnosisObject {
  target: GisDiagnosisTarget;
  station?: Station;
  device?: Device;
  link?: NetworkLink;
  coordinate: Coordinate;
  coordinates: Coordinate[];
  nodeImpact: DiagnosisImpactNode | null;
  linkImpact: DiagnosisImpactLink | null;
}

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nullableNumber = (value: unknown) => value === null || finite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length;
const coordinate = (value: unknown): value is Coordinate => Array.isArray(value) && value.length === 2
  && finite(value[0]) && finite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
const enumeration = (value: unknown, choices: readonly string[], nullable = false) => nullable && value === null || typeof value === 'string' && choices.includes(value);
function requireValid(value: unknown, message: string): asserts value {
  if (!value) throw new ApiError(`诊断快照关联错误：${message}`, 'INVALID_DIAGNOSIS_DISPLAY');
}
function rows(value: unknown, key: string, label: string): Value[] {
  requireValid(Array.isArray(value), `${label}必须为列表`);
  const seen = new Set<string>();
  for (const item of value) {
    requireValid(object(item) && identifier(item[key]), `${label}身份无效`);
    requireValid(!seen.has(item[key] as string), `${label}身份重复：${item[key]}`);
    seen.add(item[key] as string);
  }
  return value as Value[];
}

/** 有参数但无效仍是明确入口，不能让普通 GIS 或监控接管该目标。 */
export function parseGisDiagnosisTarget(query: Record<string, unknown>): { present: boolean; id: string | null; error: string | null } {
  if (!Object.hasOwn(query, 'diagnosisId')) return { present: false, id: null, error: null };
  const value = query.diagnosisId;
  if (!identifier(value) || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value))
    return { present: true, id: null, error: '诊断 ID 必须是单个非空字符串，最多 120 字且不含控制字符' };
  if (['stationId', 'deviceId', 'interferenceId', 'taskId'].some(key => Object.hasOwn(query, key)))
    return { present: true, id: null, error: '诊断快照不能与资源、干扰源或任务定位参数混用' };
  return { present: true, id: value, error: null };
}

// 不依赖结构化克隆对响应式代理的支持；仅复制接口值，不写回原报告。
function copyValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyValue) as T;
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyValue(item)])) as T;
  return value;
}
function contentSignature(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => object(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

/** 只核对展示所用身份、关联和几何；完整门槛由 getDiagnosisReport 服务决定。 */
export function projectGisDiagnosisReport(value: unknown, expectedId: string): GisDiagnosisDisplay {
  requireValid(identifier(expectedId) && object(value) && value.id === expectedId, '响应报告与请求 ID 不一致');
  requireValid(typeof value.legacy === 'boolean' && identifier(value.scenarioId) && identifier(value.scenarioVersion)
    && typeof value.name === 'string' && typeof value.description === 'string'
    && nullableText(value.startedAt) && nullableText(value.completedAt)
    && nullableText(value.diagnoseTaskId) && nullableText(value.impactTaskId), '报告必要字段无效');
  requireValid(object(value.source) && enumeration(value.source.state, ['CURRENT', 'HISTORICAL', 'UNKNOWN'])
    && strings(value.source.reasons), '来源状态或原因无效');
  // 老报告允许缺省；已提供的数据属性必须是已确认枚举。
  requireValid(value.dataOrigin === undefined || enumeration(value.dataOrigin, diagnosisDataOrigins), '数据来源无效');
  const network = value.network;
  requireValid(object(network) && identifier(network.id) && identifier(network.snapshotId) && identifier(network.taskId)
    && typeof network.name === 'string' && identifier(network.version) && object(network.inputSnapshot), '冻结网络或快照身份无效');
  const stations = rows(network.inputSnapshot.stations, 'id', '冻结节点');
  const devices = rows(network.inputSnapshot.devices, 'id', '冻结设备');
  const links = rows(network.links, 'id', '冻结链路');
  const stationIds = new Set(stations.map(row => row.id as string));
  const deviceById = new Map(devices.map(row => [row.id as string, row]));
  const linkIds = new Set(links.map(row => row.id as string));
  requireValid(ids(network.stationIds) && network.stationIds.length === stations.length
    && network.stationIds.every(id => stationIds.has(id)), '网络节点身份与冻结节点集合不一致');
  for (const station of stations) {
    requireValid(typeof station.name === 'string' && typeof station.echelon === 'string' && strings(station.parentIds)
      && coordinate(station.coordinate) && nullableNumber(station.elevationM) && typeof station.region === 'string'
      && Array.isArray(station.classes) && station.classes.every(item => enumeration(item, ['HF', 'VUHF']))
      && enumeration(station.status, ['NORMAL', 'FAULT', 'OFFLINE'], true) && (station.alert === null || typeof station.alert === 'boolean')
      && typeof station.relayCapable === 'boolean' && typeof station.key === 'boolean' && typeof station.mobility === 'string',
    `节点 ${station.id} 的展示字段或 WGS84 坐标无效`);
  }
  for (const device of devices) {
    requireValid(identifier(device.stationId) && stationIds.has(device.stationId), `设备 ${device.id} 缺少冻结所属节点`);
    requireValid(identifier(device.modelId) && identifier(device.antennaId) && enumeration(device.status, ['NORMAL', 'FAULT', 'OFFLINE'], true)
      && (device.alert === null || typeof device.alert === 'boolean') && nullableNumber(device.antennaHeightM) && nullableNumber(device.txPowerDbm)
      && nullableNumber(device.workFreqKhz) && typeof device.installedAt === 'string', `设备 ${device.id} 展示字段无效`);
  }
  for (const link of links) {
    requireValid(identifier(link.a) && stationIds.has(link.a) && identifier(link.b) && stationIds.has(link.b), `链路 ${link.id} 缺少冻结端点`);
    requireValid(identifier(link.deviceA) && deviceById.get(link.deviceA)?.stationId === link.a
      && identifier(link.deviceB) && deviceById.get(link.deviceB)?.stationId === link.b, `链路 ${link.id} 的设备与端点归属不一致`);
    requireValid(enumeration(link.state, ['EXCELLENT', 'GOOD', 'WARNING', 'FAULT']) && enumeration(link.deviceClass, ['HF', 'VUHF'])
      && finite(link.frequencyKhz) && typeof link.backup === 'boolean'
      && (link.isBackbone === undefined || link.isBackbone === null || typeof link.isBackbone === 'boolean'), `链路 ${link.id} 展示字段无效`);
  }
  // 已提供输出部署时逐条核对，不能静默忽略错误行后回退输入坐标。
  if (network.workflow !== undefined) {
    requireValid(object(network.workflow) && object(network.workflow.configuration), '规划输出配置无效');
    for (const row of rows(network.workflow.configuration.deployment, 'stationId', '规划部署')) {
      requireValid(stationIds.has(row.stationId as string) && ids(row.deviceIds)
        && row.deviceIds.every(id => deviceById.get(id)?.stationId === row.stationId), `规划部署 ${row.stationId} 的节点或设备归属无效`);
      requireValid(row.plannedCoordinate === undefined || coordinate(row.plannedCoordinate), `规划部署 ${row.stationId} 的 WGS84 输出坐标无效`);
    }
  }
  requireValid(Array.isArray(value.faults), '故障输入必须为列表');
  const faultKeys = new Set<string>();
  for (const fault of value.faults) {
    requireValid(object(fault) && enumeration(fault.objectType, ['NODE', 'DEVICE', 'LINK']) && identifier(fault.objectId)
      && enumeration(fault.faultType, ['HW_FAILURE', 'LINK_DOWN', 'SW_CONFIG', 'EMI']) && strings(fault.symptomIds)
      && nullableText(fault.occurTime) && nullableText(fault.interferenceId), '故障输入必要字段无效');
    const exists = fault.objectType === 'NODE' ? stationIds.has(fault.objectId)
      : fault.objectType === 'DEVICE' ? deviceById.has(fault.objectId) : linkIds.has(fault.objectId);
    requireValid(exists, `故障对象 ${fault.objectType}:${fault.objectId} 不属于本报告网络`);
    const key = `${fault.objectType}:${fault.objectId}`;
    requireValid(!faultKeys.has(key), `故障对象身份重复：${key}`); faultKeys.add(key);
  }
  const result = value.result;
  requireValid(object(result), '影响结果缺失');
  // 新字段已提供时严格校验，历史缺省不补写为空集合。
  assertPropagationPaths(result.propagationPaths,network as unknown as PlanVersion,value.faults as FaultInput[]);
  const nodes = rows(result.nodes, 'nodeId', '受影响节点'), impactLinks = rows(result.links, 'linkId', '受影响链路');
  const regions = rows(result.regions, 'id', '影响区域');
  const validFault = (key: unknown) => key === null || typeof key === 'string' && faultKeys.has(key);
  for (const node of nodes) {
    requireValid(stationIds.has(node.nodeId as string) && enumeration(node.affectType, ['DIRECT', 'INDIRECT'], true)
      && enumeration(node.level, GIS_DIAGNOSIS_LEVELS, true) && enumeration(node.state, ['INTERRUPTED', 'DEGRADED', 'NORMAL'], true)
      && typeof node.reason === 'string' && strings(node.detourRoute) && node.detourRoute.every(id => stationIds.has(id)),
    `受影响节点 ${node.nodeId} 的关联或字段无效`);
  }
  for (const link of impactLinks) {
    requireValid(linkIds.has(link.linkId as string) && enumeration(link.level, GIS_DIAGNOSIS_LEVELS, true)
      && enumeration(link.state, ['INTERRUPTED', 'DEGRADED', 'NORMAL'], true) && validFault(link.faultKey)
      && nullableNumber(link.bandwidthLossKbps) && (link.bandwidthLossKbps === null || (link.bandwidthLossKbps as number) >= 0)
      && (link.isBackbone === null || typeof link.isBackbone === 'boolean') && typeof link.reason === 'string',
    `受影响链路 ${link.linkId} 的关联或字段无效`);
  }
  for (const region of regions) {
    requireValid(typeof region.label === 'string' && enumeration(region.kind, ['coverage', 'blind', 'uncalculated', 'impact'])
      && enumeration(region.level, GIS_DIAGNOSIS_LEVELS, true) && validFault(region.faultKey), `影响区域 ${region.id} 的关联或字段无效`);
    requireValid(Array.isArray(region.rings) && region.rings.length > 0 && region.rings.every(ring => Array.isArray(ring)
      && ring.length >= 4 && ring.every(coordinate) && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1]),
    `影响区域 ${region.id} 需要有效 WGS84 闭合环`);
  }
  if (result.summary !== null) {
    requireValid(object(result.summary), '影响统计格式无效');
    for (const key of ['affectedNodeCount', 'directCount', 'indirectCount', 'interruptedNodeCount', 'degradedNodeCount', 'affectedLinkCount'])
      requireValid(Number.isInteger(result.summary[key]) && (result.summary[key] as number) >= 0, `影响统计 ${key} 无效`);
    requireValid(finite(result.summary.totalBandwidthLossKbps) && result.summary.totalBandwidthLossKbps >= 0
      && ids(result.summary.affectedDemandIds), '影响统计的带宽或需求 ID 无效');
  }
  const record = copyValue(value) as unknown as DiagnosisRecord;
  const { source: _source, ...content } = record;
  return { record, stations: planStations(record.network), devices: record.network.inputSnapshot.devices,
    links: record.network.links, faults: record.faults, nodes: record.result.nodes, impactLinks: record.result.links,
    regions: record.result.regions, paths:record.result.propagationPaths, contentKey: contentSignature(content) };
}

/** 合法 null 表示资料未分级，筛选时保留；统计值仍由完整报告提供。 */
export function filterGisDiagnosisImpact(display: GisDiagnosisDisplay, levels: readonly ImpactLevel[]) {
  const visible = (item: { level: ImpactLevel | null }) => item.level === null || levels.includes(item.level);
  return { nodes: display.nodes.filter(visible), links: display.impactLinks.filter(visible), regions: display.regions.filter(visible),paths:display.paths?.filter(visible) };
}

/** 只在同一冻结网络中按类型与 ID 定位，不从当前台账补关联。 */
export function gisDiagnosisObject(display: GisDiagnosisDisplay, target: GisDiagnosisTarget): GisDiagnosisObject | null {
  let station: Station | undefined, device: Device | undefined, link: NetworkLink | undefined, coordinates: Coordinate[];
  if (target.objectType === 'NODE') station = display.stations.find(row => row.id === target.objectId);
  else if (target.objectType === 'DEVICE') {
    device = display.devices.find(row => row.id === target.objectId);
    station = device && display.stations.find(row => row.id === device!.stationId);
  } else if (target.objectType === 'LINK') link = display.links.find(row => row.id === target.objectId);
  else return null;
  if (link) {
    const a = display.stations.find(row => row.id === link!.a), b = display.stations.find(row => row.id === link!.b);
    if (!a || !b) return null;
    coordinates = [[...a.coordinate], [...b.coordinate]];
  } else {
    if (!station || target.objectType === 'DEVICE' && !device) return null;
    coordinates = [[...station.coordinate]];
  }
  // 链路中点只用作定位锚点；两个冻结端点仍完整传给地图视角。
  const anchor: Coordinate = link ? [(coordinates[0][0] + coordinates[1][0]) / 2, (coordinates[0][1] + coordinates[1][1]) / 2] : [...coordinates[0]];
  return { target: { ...target }, station, device, link, coordinate: anchor, coordinates,
    // 设备只借所属节点定位，不把节点影响推断为该设备的影响结论。
    nodeImpact: target.objectType === 'NODE' && station ? display.nodes.find(row => row.nodeId === station!.id) ?? null : null,
    linkImpact: link ? display.impactLinks.find(row => row.linkId === link!.id) ?? null : null };
}
