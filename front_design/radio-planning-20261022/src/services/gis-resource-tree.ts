import type { NetworkLink } from '../types/domain';
import type { GisDeviceReference, GisNodeReference, GisResourceIndex } from '../types/gis-workspace';
import type { CandidateLink } from '../types/candidate-link';

export type GisResourceFilter = '全部' | 'HF' | 'VUHF' | '告警';
export interface GisStationRow {
  station: GisNodeReference;
  devices: GisDeviceReference[];
  direct: boolean;
  expanded: boolean;
}
export interface GisLinkRow {
  link: NetworkLink;
  endpointLabel: string;
  valid: boolean;
  available: boolean;
  reason: string;
  direct: boolean;
}
export interface GisCandidateLinkRow {
  link: CandidateLink;
  endpointLabel: string;
  valid: boolean;
  reason: string;
}

// 目录和普通资源地图只对同一批输入作匹配，不修改资源或计算业务结果。
export function buildGisResourceTree(resources: GisResourceIndex, links: NetworkLink[], query = '',
  filter: GisResourceFilter = '全部', linksAvailable = true) {
  const keyword = query.trim().toLowerCase();
  const matches = (...values: string[]) => values.some(value => value.toLowerCase().includes(keyword));
  const stationById = new Map(resources.stations.map(row => [row.id, row]));
  const deviceById = new Map(resources.devices.map(row => [row.id, row]));
  const modelById = new Map(resources.models.map(row => [row.id, row]));
  const eligible = new Set(resources.stations.filter(row => filter === '全部'
    || (filter === '告警' ? row.alert : row.classes.includes(filter))).map(row => row.id));
  const directStations = new Set(resources.stations.filter(row => eligible.has(row.id) && matches(row.id, row.name)).map(row => row.id));
  const directDevices = new Set(resources.devices.filter(row => eligible.has(row.stationId)
    && matches(row.id, row.modelId, modelById.get(row.modelId)?.name ?? '')).map(row => row.id));
  const stationIds = new Set(directStations), deviceIds = new Set<string>(), expanded = new Set<string>();
  for (const device of resources.devices) {
    if (directStations.has(device.stationId) || directDevices.has(device.id)) {
      stationIds.add(device.stationId); deviceIds.add(device.id);
      if (keyword && directDevices.has(device.id)) expanded.add(device.stationId);
    }
  }
  // 链路仅按自身编号检索；节点名称不会意外命中所有邻接链路。
  const matchedStationIds = new Set(stationIds);
  const candidates: GisLinkRow[] = links.map(link => {
    const a = stationById.get(link.a), b = stationById.get(link.b);
    const deviceA = deviceById.get(link.deviceA), deviceB = deviceById.get(link.deviceB);
    const valid = !!a && !!b && deviceA?.stationId === link.a && deviceB?.stationId === link.b
      && modelById.get(deviceA.modelId)?.deviceClass === link.deviceClass
      && modelById.get(deviceB.modelId)?.deviceClass === link.deviceClass;
    return { link, direct: !!keyword && matches(link.id), valid, available: valid && linksAvailable,
      endpointLabel: `${a?.name ?? link.a} ↔ ${b?.name ?? link.b}`,
      reason: !valid ? '端点或设备归属不完整，暂不可用' : !linksAvailable ? '资源已有修改，旧链路暂不可用' : '' };
  });
  for (const row of candidates) {
    const link = row.link;
    // 失配链路不能补入错误资源；已失效但关系完整的旧链路仍可作为只读目录。
    if (!row.direct || !row.valid || !eligible.has(link.a) || !eligible.has(link.b)) continue;
    stationIds.add(link.a); stationIds.add(link.b); deviceIds.add(link.deviceA); deviceIds.add(link.deviceB);
    expanded.add(link.a); expanded.add(link.b);
  }
  const linkRows = candidates.filter(row => {
    const bothVisible = stationIds.has(row.link.a) && stationIds.has(row.link.b);
    return (bothVisible && (!keyword || row.direct || (matchedStationIds.has(row.link.a) && matchedStationIds.has(row.link.b))))
      || ((!keyword || row.direct) && !row.valid
      && eligible.has(row.link.a) && eligible.has(row.link.b));
  });
  const stations = resources.stations.filter(row => stationIds.has(row.id));
  const devices = resources.devices.filter(row => deviceIds.has(row.id));
  const interferences = (resources.interferences ?? []).filter(row => matches(row.id, row.name));
  const stationRows: GisStationRow[] = stations.map(station => ({ station,
    devices: devices.filter(row => row.stationId === station.id),
    direct: directStations.has(station.id), expanded: expanded.has(station.id) }));
  // 候选参考等级不是运行告警；独立匹配不扩大原节点、设备和正式链路的搜索范围。
  const candidateRows: GisCandidateLinkRow[] = (resources.candidateLinks ?? []).filter(link => filter !== '告警'
    && (filter === '全部' || link.deviceClass === filter)
    && matches(link.id, link.nodeAId, link.nodeBId, link.deviceAId, link.deviceBId,
      stationById.get(link.nodeAId)?.name ?? '', stationById.get(link.nodeBId)?.name ?? '')).map(link => {
    const a = stationById.get(link.nodeAId), b = stationById.get(link.nodeBId);
    const da = deviceById.get(link.deviceAId), db = deviceById.get(link.deviceBId);
    const valid = !!a && !!b && a.id !== b.id && da?.stationId === a.id && db?.stationId === b.id
      && modelById.get(da.modelId)?.deviceClass === link.deviceClass
      && modelById.get(db.modelId)?.deviceClass === link.deviceClass;
    return { link, valid, endpointLabel: `${a?.name ?? link.nodeAId} ↔ ${b?.name ?? link.nodeBId}`,
      reason: valid ? '' : '端点或设备归属不完整，请查看并修正配置' };
  });
  return { stationRows, stations, devices, interferences, linkRows, candidateRows,
    candidateLinks: candidateRows.filter(row => row.valid).map(row => row.link),
    candidateLinkIds: candidateRows.map(row => row.link.id),
    links: linkRows.filter(row => row.available).map(row => row.link),
    stationIds: stations.map(row => row.id), deviceIds: devices.map(row => row.id),
    directDeviceIds: [...directDevices] };
}
export type GisResourceTree = ReturnType<typeof buildGisResourceTree>;

// 导出只保留已保存对象及有效归属，不将草稿设备或同站无关设备扩入范围。
export function gisResourceExportIds(tree: GisResourceTree, saved: GisResourceIndex) {
  const nodes = saved.stations.filter(row => tree.stationIds.includes(row.id)).map(row => row.id);
  return { nodes,
    devices: saved.devices.filter(row => tree.deviceIds.includes(row.id) && nodes.includes(row.stationId)).map(row => row.id),
    interference_sources: (saved.interferences ?? []).filter(row => tree.interferences.some(source => source.id === row.id)).map(row => row.id) };
}

// 候选单独形成文件范围，不向原三类导出请求偷偷追加字段。
export function gisCandidateExportIds(tree: GisResourceTree, saved: GisResourceIndex) {
  return { topology_links: (saved.candidateLinks ?? []).filter(row => tree.candidateLinkIds.includes(row.id)).map(row => row.id) };
}
export function gisSelectedCandidateExportIds(id: string, saved: GisResourceIndex) {
  return { topology_links: (saved.candidateLinks ?? []).filter(row => row.id === id).map(row => row.id) };
}
