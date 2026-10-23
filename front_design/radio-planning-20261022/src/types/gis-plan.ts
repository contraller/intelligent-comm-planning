// 冻结方案专用传输类型；计划配置不表示设备在线或实测状态。
export interface GisPlanQuery {
  planId: string;
  taskId: string;
  snapshotId?: string;
}
export interface GisLinkQuery extends GisPlanQuery {
  snapshotId: string;
  linkId: string;
}
export interface GisPathsQuery extends GisPlanQuery {
  snapshotId: string;
  demandId?: string;
}
export interface GisPlanIdentity {
  plan_id: string;
  task_id: string;
  snapshot_id: string;
  input_version: string;
  condition_version: string;
  resource_revision: string;
  state: 'SAVED' | 'REFERENCE' | 'CONFIRMED';
  source_changed: boolean;
  data_origin: 'SYNTHETIC_INTEGRATION';
  source: 'SR4';
}
export interface GisFrozenNode {
  id: string;
  name: string;
  coordinate: [number, number];
  status: 'NORMAL' | 'FAULT' | 'OFFLINE' | null;
  alert: boolean | null;
}
export interface GisFrozenDevice {
  id: string;
  station_id: string;
  model_id: string;
  device_class: 'HF' | 'VUHF';
  frequency_khz: number | null;
  tx_power_dbm: number | null;
  antenna_height_m: number | null;
}
export interface GisFrozenLink {
  id: string;
  a: string;
  b: string;
  device_a: string;
  device_b: string;
  device_class: 'HF' | 'VUHF';
  frequency_khz: number | null;
  backup: boolean;
  planned_state: 'EXCELLENT' | 'GOOD' | 'WARNING' | 'FAULT' | null;
}
export interface GisFrozenDemand {
  id: string;
  source_id: string;
  target_id: string;
  source_device_id: string | null;
  target_device_id: string | null;
  service: '' | '话音' | '数据' | '短消息' | null;
  mandatory: boolean | null;
  required_rate_kbps: number | null;
  min_reliability: number | null;
}
export interface GisFrozenRoute {
  id: string;
  demand_id: string;
  node_ids: string[];
  link_ids: string[];
  backup: boolean;
}
export interface GisPaths {
  identity: GisPlanIdentity;
  demands: GisFrozenDemand[];
  routes: GisFrozenRoute[];
  paths_state: 'ready' | 'missing';
  paths_message: string;
}
export interface GisNetwork extends GisPaths {
  nodes: GisFrozenNode[];
  devices: GisFrozenDevice[];
  links: GisFrozenLink[];
}
export interface GisLinkDetail {
  identity: GisPlanIdentity;
  link: GisFrozenLink;
  endpoint_devices: [GisFrozenDevice, GisFrozenDevice];
  demand_ids: string[];
  route_ids: string[];
  observation: { state: 'missing'; message: string; samples: [] };
}
export interface GisPlanSurface {
  identity: GisPlanIdentity;
  terrain: import('./resource-read').ResourceTerrain | null;
  terrain_notice: string;
  coverage: import('./coverage').PlanningCoverage | null;
  coverage_notice: string;
}
export interface GisPlanServices {
  getNetwork(query: GisPlanQuery, signal?: AbortSignal): Promise<GisNetwork>;
  getLink(query: GisLinkQuery, network: GisNetwork, signal?: AbortSignal): Promise<GisLinkDetail>;
  getPaths(query: GisPathsQuery, network: GisNetwork, signal?: AbortSignal): Promise<GisPaths>;
  getSurface(query: GisPlanQuery & { snapshotId: string }, network: GisNetwork, signal?: AbortSignal): Promise<GisPlanSurface>;
}
