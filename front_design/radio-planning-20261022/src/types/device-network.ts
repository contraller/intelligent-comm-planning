import type { NetworkLink } from './domain';
import type { MaintenanceQuery } from './device-maintenance';

// 下钻端点与指标来自同一网络快照，不能用当前资源补旧快照。
export interface DeviceNetworkDetail {
  snapshotId:string; source:string; kind:'link'|'service';
  link:NetworkLink|null; service:NetworkService|null; routes:NetworkServiceRoute[];
  resources:import('./gis-workspace').GisResourceIndex;
  stations:import('./domain').Station[]; links:NetworkLink[];
  linkDetails:import('./link-detail').LinkDetailContext;
}
export interface DeviceNetworkDetailServices {
  getDeviceNetworkDetail(input:MaintenanceQuery & {snapshotId:string;kind:'link'|'service';id:string}):Promise<DeviceNetworkDetail>;
}

// 业务与路径属于指定网络快照，不是设备型号能力，也不写入资源记录。
export interface NetworkService {
  id: string;
  name: string;
  serviceType: '话音' | '数据';
  sourceDeviceId: string;
  targetDeviceId: string;
}
export interface NetworkServiceRoute {
  id: string;
  demandId: string;
  routeType: 'PRIMARY' | 'BACKUP';
  nodeIds: string[];
  linkIds: string[];
}
export interface DeviceNetworkCatalog {
  // 角色只在所属网络内有效，不作为设备台账配置。
  roles?: DeviceNetworkRoles | null;
  version: string;
  snapshotId: string;
  source: string;
  services: NetworkService[];
  routes: NetworkServiceRoute[];
}
export interface DeviceNetworkContext {
  roleData?: DeviceNetworkRoleContext;
  state: 'ready' | 'missing' | 'invalid' | 'stale';
  message: string;
  title: string;
  snapshotId: string;
  source: string;
  links: NetworkLink[];
  services: NetworkService[];
  routes: NetworkServiceRoute[];
}

export interface DeviceNetworkRole {
  deviceId: string; role: string; description: string | null; source: string;
}
export interface DeviceNetworkRoles {
  version: 'device-network-roles-v1'; snapshotId: string; source: string; items: DeviceNetworkRole[];
}
export interface DeviceNetworkRoleContext {
  state: 'ready' | 'missing' | 'invalid'; message: string; source: string; items: DeviceNetworkRole[];
}
