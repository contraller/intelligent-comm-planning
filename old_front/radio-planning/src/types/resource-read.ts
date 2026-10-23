import type { Antenna, Availability, Coordinate, Device, DeviceClass, DeviceModel, InterferenceSource, OperationalStatus, ResourceOrigin, Station } from './domain';

// 读取工作区不冒充全量编辑快照；未知补充字段在边界显式保留为 null。
export type ResourceReadContext = 'ledger' | 'gis' | 'planning';
export type ResourceObjectKind = 'node' | 'device' | 'interference';
export type Bounds = [number, number, number, number];
export interface ReadNode extends Omit<Station, 'alert' | 'origin'> {
  kind: 'node'; alert: boolean | null; origin: ResourceOrigin | null;
  childCount: number; deviceCount: number;
}
export interface ReadDevice extends Omit<Device, 'alert' | 'origin' | 'availability'> {
  kind: 'device'; alert: boolean | null; origin: ResourceOrigin | null; availability: Availability | null;
  stationName: string; stationCoordinate: Coordinate; modelName: string; deviceClass: DeviceClass; antennaName: string;
}
export interface ReadInterference extends Omit<InterferenceSource, 'origin'> { kind: 'interference'; origin: ResourceOrigin | null }
export type ReadObject = ReadNode | ReadDevice | ReadInterference;
export interface ResourceReadStats {
  nodes: number; devices: number; models: number; interferences: number;
  hf: number; vuhf: number; alerts: number | null; unknownAlerts: number | null;
  active: number | null; offShelf: number | null; unknownAvailability: number | null;
}
export interface ResourceTerrain { sourceSha256: string; bounds: Bounds; source: string }
export interface ResourceReadWorkspace { revision: string; bounds: Bounds; updatedAt: string; source: string; stats: ResourceReadStats; terrain?: ResourceTerrain | null }
export interface ReadOptions { context: ResourceReadContext; signal?: AbortSignal }
export interface VersionedRead extends ReadOptions { revision: string }
export interface ResourceReadFilter {
  search?: string; deviceClass?: DeviceClass; status?: OperationalStatus;
  availability?: Availability | 'UNKNOWN'; alert?: 'YES' | 'NO' | 'UNKNOWN';
}
export interface ResourcePageQuery extends VersionedRead, ResourceReadFilter {
  page: number; pageSize: number; sort?: 'id' | 'name' | 'status'; order?: 'asc' | 'desc';
  nodeId?: string; parentId?: string | null; clusterId?: string;
}
export interface ResourcePage<T> { revision: string; items: T[]; total: number; page: number; pageSize: number }
export interface ResourceObjectQuery extends VersionedRead { kind: ResourceObjectKind; id: string }
export interface ResourceObjectDetail { revision: string; object: ReadObject; model: DeviceModel | null; antenna: Antenna | null }
export interface ResourceMapQuery extends VersionedRead, ResourceReadFilter { bbox: Bounds; zoom: number; showNodes: boolean; showInterferences: boolean }
export interface ResourceMapPoint {
  kind: 'node' | 'interference'; id: string; name: string; coordinate: Coordinate;
  status: OperationalStatus | null; alert: boolean | null; active: boolean | null;
}
export interface ResourceMapCluster {
  kind: 'node' | 'interference'; id: string; coordinate: Coordinate; count: number;
  bounds: Bounds; expansionZoom: number | null;
}
export interface ResourceMapFrame {
  revision: string; bbox: Bounds; zoom: number; points: ResourceMapPoint[]; clusters: ResourceMapCluster[];
  totalNodes: number; totalInterferences: number;
}
export interface ResourceReadServices {
  loadResourceReadContext(input: ReadOptions): Promise<ResourceReadWorkspace>;
  queryResourceDevices(input: ResourcePageQuery): Promise<ResourcePage<ReadDevice>>;
  queryResourceNodes(input: ResourcePageQuery): Promise<ResourcePage<ReadNode>>;
  queryResourceInterferences(input: ResourcePageQuery): Promise<ResourcePage<ReadInterference>>;
  getResourceObject(input: ResourceObjectQuery): Promise<ResourceObjectDetail>;
  queryResourceMap(input: ResourceMapQuery): Promise<ResourceMapFrame>;
}

export const resourceReadMethods = ['loadResourceReadContext', 'queryResourceDevices', 'queryResourceNodes', 'queryResourceInterferences', 'getResourceObject', 'queryResourceMap'] as const;
