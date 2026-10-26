import type { ResourcesData } from '../types/domain';
import type { GisClassification, GisResourceScene, GisResourceEditContext, GisResourceIndex, GisResourceDirectory } from '../types/gis-workspace';
import { ApiError } from './types';
import { requireRevision } from './resource-read-validation';
import { buildGisResourceTree } from './gis-resource-tree';
import type { GisResourceFilter } from './gis-resource-tree';
import type { NetworkLink } from '../types/domain';

// 校验完整上下文身份；分页缓存和不同版本的补充资料不能进入编辑基线。
export function validateGisScene<T extends GisResourceScene | GisResourceEditContext>(scene: T, revision: string): T {
  requireRevision(scene?.revision, revision);
  if (!scene.resourceMeta?.revision || !scene.situation?.snapshotId
    || ('baseRevision' in scene ? !scene.resources || !scene.validationSource
      || ['stations', 'devices', 'models', 'antennas'].some(key => !Array.isArray(scene.resources[key as keyof ResourcesData]))
      || scene.baseRevision !== scene.resourceMeta.revision
      : !scene.map || !Array.isArray(scene.map.stations) || !Array.isArray(scene.map.devices) || !scene.network || !scene.linkDetails)) {
    throw new ApiError('GIS 完整上下文不完整或提交版本不一致', 'INVALID_RESOURCE_RESPONSE');
  }
  return scene;
}

export function validateGisDirectory(value: GisResourceDirectory, revision: string) {
  requireRevision(value?.revision, revision);
  const r = value.resources;
  if (!r || !Array.isArray(r.stations) || !Array.isArray(r.devices) || !Array.isArray(r.models)
    || new Set(r.devices.map(d => d.id)).size !== r.devices.length
    || r.devices.some(d => !d.id || !r.stations.some(n => n.id === d.stationId) || !r.models.some(m => m.id === d.modelId)))
    throw new ApiError('GIS 资源目录或设备归属不完整', 'INVALID_RESOURCE_RESPONSE');
  return value;
}

// 白名单投影防止完整实例参数随浏览目录返回；编辑仍保留原始完整对象。
export function gisResourceIndex(resources: ResourcesData): GisResourceIndex {
  return { stations: resources.stations, interferences: resources.interferences, candidateLinks: resources.candidateLinks,
    source: resources.source, version: resources.version, devices: resources.devices.map(({ id, stationId, modelId, status, alert, availability, origin }) =>
    ({ id, stationId, modelId, status, alert, availability, origin })),
    models: resources.models.map(({ id, name, deviceClass }) => ({ id, name, deviceClass })) };
}

export function matchesGisClassification(station: Pick<ResourcesData['stations'][number], 'mobility' | 'role' | 'relayCapable'>, filter: GisClassification) {
  return (!filter.mobility || station.mobility === filter.mobility)
    && (!filter.role || station.role === filter.role)
    && (!filter.relay || station.relayCapable === (filter.relay === 'YES'));
}

// 仅投影目录与地图显示成员，不修改资源、关联身份或业务计算结果。
export function projectGisTree(resources: GisResourceIndex, links: NetworkLink[], query: string,
  filter: GisResourceFilter, available: boolean, browse: 'devices' | 'stations', classification: GisClassification) {
  const tree = buildGisResourceTree(resources, links, query, browse === 'devices' && filter !== '告警' ? '全部' : filter, available);
  const models = new Map(resources.models.map(model => [model.id, model]));
  const stations = new Map(resources.stations.map(station => [station.id, station]));
  const devices = tree.devices.filter(device => {
    const station = stations.get(device.stationId);
    return station && matchesGisClassification(station, classification)
      && (browse !== 'devices' || filter === '全部' || filter === '告警' || models.get(device.modelId)?.deviceClass === filter);
  });
  const deviceIds = new Set(devices.map(device => device.id));
  const stationIds = new Set(browse === 'devices' ? devices.map(device => device.stationId)
    : tree.stations.filter(station => matchesGisClassification(station, classification)).map(station => station.id));
  const linkRows = tree.linkRows.filter(row => stationIds.has(row.link.a) && stationIds.has(row.link.b)
    && (filter === '全部' || filter === '告警' || row.link.deviceClass === filter));
  // 频段快捷条件也约束候选目录；不因设备分组采用全量底树而漏掉原筛选。
  const candidateRows = tree.candidateRows.filter(row => filter !== '告警'
    && (filter === '全部' || row.link.deviceClass === filter));
  return { ...tree, candidateRows, candidateLinks: candidateRows.filter(row => row.valid).map(row => row.link),
    candidateLinkIds: candidateRows.map(row => row.link.id), devices, deviceIds: [...deviceIds], stations: tree.stations.filter(station => stationIds.has(station.id)),
    stationIds: [...stationIds], stationRows: tree.stationRows.filter(row => stationIds.has(row.station.id))
      .map(row => ({ ...row, devices: row.devices.filter(device => deviceIds.has(device.id)) })),
    linkRows, links: linkRows.filter(row => row.available).map(row => row.link) };
}

