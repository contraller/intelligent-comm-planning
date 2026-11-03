import type { Station,InterferenceSource } from '../types/domain';
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
  deviceIds?: string[];
}
interface HoverInput {
  context: GisHoverContext; stations: readonly Station[]; devices?: GisDeviceMapFrame;
  resources?: ResourceMapFrame | null; deviceTarget?: { ids: string[]; version: number };
  frozenNetwork?: GisNetwork|null;
  frozenInterferences?:readonly InterferenceSource[];
}
interface HoverFeature { get(key: string): unknown }
const statusText = (status: unknown, alert: unknown) =>
  (status === 'NORMAL' ? '正常' : status === 'FAULT' ? '故障' : status === 'OFFLINE' ? '离线' : '状态未提供')
  + (alert === null || alert === undefined ? ' · 告警未提供' : alert ? ' · 告警' : '');
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
  const { context, stations, devices, resources, deviceTarget } = input;
  if(feature.get('kind')==='interference-source'){
    const source=feature.get('source') as InterferenceSource|undefined;
    if(!source||!input.frozenInterferences?.includes(source))return null;
    return {key:`${context.key}:interference:${source.id}`,kind:'station',title:source.name+' · 干扰源',source:context.source,rows:[{label:'编号',value:source.id},{label:'生效状态',value:source.active?'生效':'未生效'},{label:'中心频率',value:`${source.centerFreqKhz} kHz`},{label:'带宽',value:`${source.bandwidthKhz} kHz`},{label:'发射功率',value:`${source.txPowerDbm} dBm`} ]};
  }
  if(feature.get('kind')==='frozen-plan-node'){
    const network=input.frozenNetwork,node=network?.nodes.find(row=>row.id===feature.get('objectId'));
    if(!network||!node||feature.get('snapshot')!==network.identity.snapshot_id)return null;
    const members=network.devices.filter(row=>row.station_id===node.id),fmt=(value:number|null,unit:string)=>value===null?'未提供':`${value} ${unit}`;
    return {key:`${network.identity.snapshot_id}:${node.id}`,kind:'station',title:node.name,deviceIds:members.map(row=>row.id),rows:[
      {label:'节点编号',value:node.id},{label:'运行状态',value:statusText(node.status,node.alert)},
      {label:'配置设备',value:`HF ${members.filter(row=>row.device_class==='HF').length} / VUHF ${members.filter(row=>row.device_class==='VUHF').length}`},
      ...members.slice(0,3).map(row=>({label:row.id,value:`${row.device_class} · ${context.models.find(model=>model.id===row.model_id)?.name??row.model_id}；${fmt(row.frequency_khz,'kHz')}；${fmt(row.tx_power_dbm,'dBm')}；挂高 ${fmt(row.antenna_height_m,'m')}`})),
      ...(members.length>3?[{label:'其它设备',value:`另 ${members.length-3} 台，展开菜单可逐台查看覆盖`}]:[])],source:context.source};
  }
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
  const width = Math.max(0, Math.min(320, size[0] - 16)), maxHeight = Math.max(0, Math.min(320, size[1] - 16));
  const clamp = (value: number, max: number) => Math.max(8, Math.min(value, max));
  return { width, maxHeight, left: clamp(pixel[0] + 14 + width <= size[0] - 8 ? pixel[0] + 14 : pixel[0] - width - 14, size[0] - width - 8),
    top: clamp(pixel[1] + 14 + maxHeight <= size[1] - 8 ? pixel[1] + 14 : pixel[1] - maxHeight - 14, size[1] - maxHeight - 8) };
}
