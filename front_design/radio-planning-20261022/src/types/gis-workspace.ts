import type { ResourceObjectDetail, ResourcePage } from './resource-read';
import type { Availability, Device, DeviceModel, ResourceOrigin, ResourcesData, SituationData, Station } from './domain';
import type { ResourceMeta } from './resource-edit';
import type { DeviceDetailCatalog } from './device-detail';
import type { GisDeviceMapPoint } from '../maps/gis-device-display';
import type { DeviceNetworkContext } from './device-network';
import type { LinkDetailContext } from './link-detail';

// 目录只保留检索、分组与身份关联字段，完整参数在选中后读取。
export interface GisDeviceReference extends Pick<Device, 'id' | 'stationId' | 'modelId' | 'status'> {
  alert: boolean | null; availability?: Availability | null; origin?: ResourceOrigin | null;
}
export interface GisNodeReference extends Omit<Station, 'alert' | 'origin'> { alert: boolean | null; origin?: ResourceOrigin | null }
export interface GisResourceIndex extends Omit<ResourcesData, 'stations' | 'devices' | 'models' | 'antennas'> {
  stations: GisNodeReference[];
  devices: GisDeviceReference[];
  models: Pick<DeviceModel, 'id' | 'name' | 'deviceClass'>[];
}
export interface GisResourceDirectory { revision: string; resources: GisResourceIndex }
// 地图资料独立于目录和详情；设备点仅携带绘制及已有频率筛选所需字段。
export interface GisResourceScene {
  revision: string;
  resourceMeta: ResourceMeta;
  situation: SituationData;
  map: { stations: Station[]; interferences?: ResourcesData['interferences']; devices: GisDeviceMapPoint[]; missingCount: number };
  network: DeviceNetworkContext;
  linkDetails: LinkDetailContext;
}
// 完整编辑基线只能由编辑服务返回，不能从目录或地图反向拼装。
export interface GisResourceEditContext {
  revision: string;
  resources: ResourcesData;
  resourceMeta: ResourceMeta;
  situation: SituationData;
  deviceDetails?: DeviceDetailCatalog;
  baseRevision: string;
  // 原始合法值的容忍范围由服务提供，不能借用另一数据源的初始化资料。
  validationSource: ResourcesData;
}
export interface GisSceneRequest { context: 'gis'; revision: string; signal?: AbortSignal }
export interface GisResourceServices {
  getGisCoverageCatalog(input: GisSceneRequest): Promise<import('./device-coverage').DeviceCoverageCatalog | null>;
  getGisLinkDetails(input: GisSceneRequest & { id: string; snapshotId: string }): Promise<LinkDetailContext>;
  loadGisResourceDirectory(input: GisSceneRequest): Promise<GisResourceDirectory>;
  loadGisResourceScene(input: GisSceneRequest): Promise<GisResourceScene>;
  loadGisResourceEditContext(input: GisSceneRequest): Promise<GisResourceEditContext>;
}

// 轻目录和地图不作为完整编辑快照，也不把缺失数量当作零。
export type GisCategory = 'all' | 'HF' | 'VUHF' | 'links' | 'candidates' | 'interferences';
export type GisBrowse = 'devices' | 'stations';
export interface GisClassification {
  mobility: '' | 'FIXED' | 'VEHICLE' | 'MANPACK';
  role: '' | 'TASK' | 'FIXED_STATION' | 'RELAY' | 'CANDIDATE';
  relay: '' | 'YES' | 'NO';
}
export interface GisCounts { nodes: number | null; devices: number | null; hf: number | null; vuhf: number | null; interferences: number | null }
export interface GisDetailContext {
  detail: ResourceObjectDetail; devices: ResourcePage<import('./resource-read').ReadDevice> | null;
}
