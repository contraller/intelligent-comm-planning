import type { Station } from '../types/domain';
import type { GisNetwork } from '../types/gis-plan';
import type { ResourceMapFrame, ResourceMapPoint, ResourceMapCluster } from '../types/resource-read';
import { gisDeviceStatus, gisDeviceSummary, type GisDeviceMapFrame, type GisDevicePoint } from './gis-device-display';

// 仅使用本次地图与同版本目录，不读取详情、不补造缺失属性。
export interface GisHoverContext {
  key: string; source: string; models: readonly { id: string; name: string }[];
}
export interface GisHoverSummary {
  key: string; kind: 'device' | 'station' | 'devices' | 'stations'; title: string;
  rows: { label: string; value: string }[]; source: string;
  devices?: {id:string;label:string;rows:{label:string;value:string}[]}[];
}
interface HoverInput {
  context: GisHoverContext; stations: readonly Station[]; devices?: GisDeviceMapFrame;
  resources?: ResourceMapFrame | null; deviceTarget?: { ids: string[]; version: number };
  frozenNetwork?: GisNetwork | null;
  frozenDevices?: GisDeviceMapFrame & { network: GisNetwork };
}
interface HoverFeature { get(key: string): unknown }
const statusText = (status: unknown, alert: unknown) =>
  (status === 'NORMAL' ? '正常' : status === 'FAULT' ? '故障' : status === 'OFFLINE' ? '离线' : '状态未提供')
  + (alert === null || alert === undefined ? ' · 告警未提供' : alert ? ' · 告警' : '');
const platformText = (value: unknown) => value === 'FIXED' ? '固定部署' : value === 'VEHICLE' ? '车载部署' : value === 'MANPACK' ? '背负部署' : '未提供';
function frozenDeviceDetail(device: GisNetwork['devices'][number], network: GisNetwork) {
  const node = network.nodes.find(row => row.id === device.station_id);
  return { id: device.id, label: `${device.device_class} · ${device.id}`, rows: [
    { label: '所属节点', value: node ? `${node.name}（${node.id}）` : device.station_id },
    { label: '平台类型', value: platformText(node?.mobility) },
    { label: '设备型号', value: device.model_id },
    // 节点状态不能代替设备观测，现有方案设备响应尚未提供运行状态。
    { label: '设备状态', value: '状态与告警未提供' },
    { label: '频率 / kHz', value: device.frequency_khz === null ? '未提供' : String(device.frequency_khz) },
    { label: '功率 / dBm', value: device.tx_power_dbm === null ? '未提供' : String(device.tx_power_dbm) },
    { label: '挂高 / m', value: device.antenna_height_m === null ? '未提供' : String(device.antenna_height_m) },
    { label: '节点坐标', value: node ? node.coordinate.map(value => value.toFixed(5)).join(', ') : '未提供' },
  ] };
}
function deviceRows(points: readonly GisDevicePoint[]) {
  const count = gisDeviceSummary(points), rows = [
    { label: '类别分布', value: `HF ${count.HF} 台 / VUHF ${count.VUHF} 台` },
    { label: '状态摘要', value: `正常 ${points.filter(p => p.status === 'NORMAL').length} / 故障 ${count.faults} / 离线 ${points.filter(p => p.status === 'OFFLINE').length} 台` },
    { label: '告警数量', value: `${count.alerts} 台` },
  ];
  const missingStatus = points.filter(p => p.status === null).length, missingAlert = points.filter(p => p.alert === null).length;
  if (missingStatus || missingAlert) rows.push({ label: '未提供', value: `状态 ${missingStatus} 台 / 告警 ${missingAlert} 台` });
  return rows;
}
function stationDevices(stationId: string, devices?: GisDeviceMapFrame) {
  if (!devices) return [{ label: '当前显示设备', value: '未提供' }];
  const visible = devices.points.filter(p => p.stationId === stationId && devices.settings[p.deviceClass].visible && devices.settings[p.deviceClass].opacity > 0);
  const summary = gisDeviceSummary(visible);
  // 站点卡合并数量与类别，低高度地图仍可看到设备状态和来源。
  return [{ label: '当前显示设备', value: `${visible.length} 台（HF ${summary.HF} / VUHF ${summary.VUHF}）` }, ...deviceRows(visible).filter(row => row.label !== '类别分布')];
}
export function gisHoverSummary(feature: HoverFeature, input: HoverInput): GisHoverSummary | null {
  const network=input.frozenNetwork;
  if (network && feature.get('kind') === 'gis-device-cluster') {
    const frame = input.frozenDevices, target = input.deviceTarget;
    // 只接受同一方案、同一代设备帧；当前台账或旧聚合不能借同名编号拼入方案。
    if (frame?.network !== network || !target?.ids.length || target.version !== frame.version) return null;
    const ids = [...new Set(target.ids)], members = ids.map(id => network.devices.find(device => device.id === id));
    if (members.some(device => !device || !frame.points.some(point => point.id === device.id)
      || !frame.settings[device.device_class].visible || frame.settings[device.device_class].opacity <= 0)) return null;
    const devices = members as GisNetwork['devices'];
    const nodeIds = new Set(devices.map(device => device.station_id));
    const nodes = network.nodes.filter(node => nodeIds.has(node.id));
    if (nodes.length !== nodeIds.size) return null;
    const hf = devices.filter(device => device.device_class === 'HF').length;
    return {
      key: JSON.stringify(['frozen-devices', network.identity.task_id, network.identity.plan_id, network.identity.snapshot_id, frame.version, [...ids].sort()]),
      kind: devices.length === 1 ? 'device' : 'devices', title: devices.length === 1 ? devices[0].id : `设备聚合（${devices.length} 台）`,
      source: `${input.context.source} · 冻结方案`,
      rows: [
        { label: '类别分布', value: `HF ${hf} 台 / VUHF ${devices.length - hf} 台` },
        { label: '所属节点', value: nodes.length === 1 ? `${nodes[0].name}（${nodes[0].id}）` : `${nodes.length} 个，选择设备查看所属节点` },
        { label: '平台类型', value: nodes.length === 1 ? platformText(nodes[0].mobility) : [...new Set(nodes.map(node => platformText(node.mobility)))].join(' / ') },
        { label: '设备状态', value: '状态与告警未提供' },
        ...(nodes.length === 1 ? [{ label: '节点坐标', value: nodes[0].coordinate.map(value => value.toFixed(5)).join(', ') }] : []),
      ],
      devices: devices.map(device => frozenDeviceDetail(device, network)),
    };
  }
  if(network&&feature.get('snapshot')===network.identity.snapshot_id){
    const id=feature.get('objectId');
    if(feature.get('kind')==='frozen-plan-node'){
      const node=network.nodes.find(n=>n.id===id);if(!node)return null;
      // 历史平台字段缺失时不借当前资源中的同名节点补齐。
      return {key:`frozen:${network.identity.plan_id}:${network.identity.snapshot_id}:${node.id}`,kind:'station',title:node.name,source:input.context.source+' · 冻结方案',rows:[{label:'节点编号',value:node.id},{label:'冻结状态',value:statusText(node.status,node.alert)},{label:'平台类型',value:platformText(node.mobility)},{label:'节点角色',value:node.node_role?.trim()||'未提供'},{label:'节点子类',value:node.node_subtype?.trim()||'未提供'},{label:'坐标',value:node.coordinate.map(v=>v.toFixed(5)).join(', ')}],devices:network.devices.filter(d=>d.station_id===id).map(d=>frozenDeviceDetail(d,network))};
    }
    if(feature.get('kind')==='frozen-plan-link'){
      const link=network.links.find(l=>l.id===id);if(!link)return null;
      return {key:`link:${network.identity.snapshot_id}:${link.id}`,kind:'station',title:link.id,source:input.context.source+' · 规划预测',rows:[{label:'端点',value:`${link.a} → ${link.b}`},{label:'链路类型',value:link.backup?'备用链路':'主链路'},{label:'预测等级',value:link.planned_state??'未提供'},{label:'频率 / kHz',value:link.frequency_khz===null?'未提供':String(link.frequency_khz)}]};
    }
  }
  const { context, stations, devices, resources, deviceTarget } = input;
  if (feature.get('kind') === 'gis-device-cluster') {
    if (!devices || !deviceTarget?.ids.length || deviceTarget.version !== devices.version) return null;
    const ids = [...new Set(deviceTarget.ids)], points = ids.map(id => devices.points.find(p => p.id === id));
    if (points.some(p => !p || !devices.settings[p.deviceClass].visible || devices.settings[p.deviceClass].opacity <= 0)) return null;
    const rows = points as GisDevicePoint[], row = rows[0];
    if (rows.length > 1) return { key: 'devices:' + ids.join(','), kind: 'devices', title: `设备聚合（${rows.length} 台）`, rows: deviceRows(rows), source: `${context.source} · 当前地图状态` };
    const model = context.models.find(m => m.id === row.modelId);
    return { key: 'device:' + row.id, kind: 'device', title: row.id, rows: [
      { label: '型号', value: `${model?.name || '名称未提供'}（${row.modelId}）` },
      { label: '类别', value: row.deviceClass }, { label: '运行状态', value: gisDeviceStatus(row) },
      { label: '所属站点', value: `${row.stationName || '名称未提供'}（${row.stationId}）` },
      ...(row.offShelf ? [{ label: '在架状态', value: '已下架' }] : []),
    ], source: `${context.source} · 当前地图状态` };
  }
  if (feature.get('kind') === 'resource-read-point') {
    const point = feature.get('object') as ResourceMapPoint | undefined;
    // 旧图层的同名 ID 不能借当前帧生成摘要。
    if (!point || point.kind !== 'node' || !resources?.points.includes(point)) return null;
    return { key: 'station:' + point.id, kind: 'station', title: point.name, rows: [
      { label: '站点编号', value: point.id },
      ...(!devices ? [{ label: '运行状态', value: statusText(point.status, point.alert) }] : []),
      ...stationDevices(point.id, devices),
    ], source: context.source };
  }
  if (feature.get('kind') === 'resource-read-cluster') {
    const cluster = feature.get('cluster') as ResourceMapCluster | undefined;
    if (!cluster || cluster.kind !== 'node' || !resources?.clusters.includes(cluster)) return null;
    return { key: 'stations:' + cluster.id, kind: 'stations', title: `站点聚合（${cluster.count} 个）`, rows: [], source: context.source };
  }
  const members = feature.get('features') as HoverFeature[] | undefined;
  if (!Array.isArray(members) || !members.length) return null;
  const nodes = members.map(m => m.get('station') as Station | undefined);
  if (nodes.some(node => !node || !stations.includes(node))) return null;
  const current = nodes as Station[];
  if (current.length > 1) return { key: 'stations:' + current.map(s => s.id).join(','), kind: 'stations', title: `站点聚合（${current.length} 个）`, rows: [], source: context.source };
  const node = current[0];
  return { key: 'station:' + node.id, kind: 'station', title: node.name, rows: [
    { label: '站点编号', value: node.id },
    ...(!devices ? [{ label: '运行状态', value: statusText(node.status, node.alert) }] : []),
    ...stationDevices(node.id, devices),
  ], source: context.source };
}

// 位置相对地图容器计算；窄小地图也不撑开页面或越过地图边界。
export function gisHoverPlacement(pixel: number[], size: number[]) {
  const width = Math.max(0, Math.min(280, size[0] - 16)), maxHeight = Math.max(0, Math.min(220, size[1] - 16));
  const clamp = (value: number, max: number) => Math.max(8, Math.min(value, max));
  return { width, maxHeight, left: clamp(pixel[0] + 14 + width <= size[0] - 8 ? pixel[0] + 14 : pixel[0] - width - 14, size[0] - width - 8),
    top: clamp(pixel[1] + 14 + maxHeight <= size[1] - 8 ? pixel[1] + 14 : pixel[1] - maxHeight - 14, size[1] - maxHeight - 8) };
}
