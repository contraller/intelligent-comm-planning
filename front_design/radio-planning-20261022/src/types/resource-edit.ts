import type { Antenna, Availability, Device, DeviceModel, InterferenceSource, ResourcesData, Station } from './domain';
import type { ResourceReadFilter } from './resource-read';
import type { CandidateLink, CandidateLinkPatch } from './candidate-link';
import type { MutationReceipt } from './data-access';

export type StationFields = Pick<Station, 'name' | 'coordinate' | 'elevationM' | 'region' | 'remark'>;
export type DeviceFields = Pick<Device, 'antennaHeightM' | 'txPowerDbm' | 'workFreqKhz' | 'currentWorkMode' | 'ports'>;
export interface ResourceChanges {
  newCandidateLinks?: CandidateLink[];
  candidateLinks?: CandidateLinkPatch[];
  // 导入服务返回的完整行保留来源与参考，统一保存时不误当手工改配置。
  importedCandidateLinks?: CandidateLink[];
  newStations?: Station[];
  newDevices?: Device[];
  newInterferences?: InterferenceSource[];
  interferences?: (Partial<Omit<InterferenceSource, 'origin'>> & { id: string })[];
  availability?: { id: string; availability: Availability }[];
  stations: (Partial<StationFields> & { id: string })[];
  devices: (Partial<DeviceFields> & { id: string })[];
}
export interface ResourceCommit extends ResourceChanges {
  // 恢复仍走普通保存；服务复核历史归属及候选，不能借标识覆盖保护字段。
  restoreFrom?: Record<string, string>;
  baseRevision: string;
  requestId?: string;
  context?: 'gis' | 'ledger';
}
export interface ResourceIssue {
  // 错误可来自文件级或未知工作表，不能伪装成某一资源类型。
  sheet?: string;
  row?: number;
  objectId: string;
  field: string;
  message: string;
}
export interface ResourceMeta {
  deviceHistory?: import('./device-maintenance').DeviceHistory[];
  // 与资源同条记录保存，任务维护不提升资源业务版本。
  taskWorkspace?: import('./task').TaskWorkspace;
  interferenceVersion?: string;
  changedInterferenceIds?: string[];
  receipts?: ResourceReceipt[];
  revision: string;
  resourceEpoch: string;
  stationVersions: Record<string, string>;
  deviceVersions: Record<string, string>;
  savedAt: string | null;
  // 累计受影响对象；手工改回原值不能重新认证旧结果。
  changedStationIds: string[];
  changedDeviceIds: string[];
}
export interface ResourceSaveResult {
  resources: ResourcesData;
  meta: ResourceMeta;
  changed: boolean;
  warnings: ResourceIssue[];
}
// 页面回执不携带资源库、累积版本表或幂等历史；单设备保存可返回规范化后的本对象。
export interface ResourceMutationReceipt extends MutationReceipt {
  readRevision: string;
  warnings: ResourceIssue[];
  affectedIds: string[];
  device?: Device;
  updated?: string[];
  unchanged?: string[];
}
export interface ResourceRecord extends ResourceMeta {
  // 保存记录使用完整当前结构；轻量页面 DTO 仍可省略非展示字段。
  candidateLinks: CandidateLink[];
  taskWorkspace: import('./task').TaskWorkspace;
  interferenceVersion: string;
  changedInterferenceIds: string[];
  receipts: ResourceReceipt[];
  deviceHistory: import('./device-maintenance').DeviceHistory[];
  schemaVersion: number;
  sourceVersion: string;
  stations: Station[];
  devices: Device[];
  interferences: InterferenceSource[];
}
export interface ResourceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface EditForm {
  restoreFrom?: string;
  kind: 'station' | 'device' | 'interference' | 'candidate';
  creating?: boolean;
  id: string;
  fields: Record<string, string>;
  initial: Record<string, string>;
}
export type Decision = 'save' | 'discard' | 'cancel';
export interface DecisionRequest {
  title: string;
  message: string;
  saveLabel?: string;
  discardLabel?: string;
  cancelLabel?: string;
}

export type ResourceKind = 'nodes' | 'devices' | 'interference_sources' | 'topology_links';
export type ResourceFormat = 'csv' | 'xlsx';
export interface ResourceFile { name: string; mime: string; bytes: Uint8Array }
export interface ResourceReceipt { requestId: string; signature: string; revision: string; changed: boolean; availabilityResult?: { updated:string[]; unchanged:string[] } }
export interface ResourceImportRequest {
  file: { name: string; bytes: Uint8Array }; kind: ResourceKind; baseRevision: string;
  context: 'gis' | 'ledger'; draftChanges?: ResourceChanges;
}
export interface ResourceImportRow {
  sheet: ResourceKind; row: number; id: string; action: 'NEW' | 'UPDATE' | 'UNCHANGED';
  differences: { field: string; before: unknown; after: unknown }[];
}
export interface ResourceImportPreview {
  warnings?: ResourceIssue[];
  request: ResourceImportRequest; rows: ResourceImportRow[]; issues: ResourceIssue[];
  candidate: ResourcesData; changes: ResourceChanges; signature: string;
}
export interface ResourceExportRequest {
  format: ResourceFormat; kinds: ResourceKind[];
  ids?: Partial<Record<ResourceKind, string[]>>; context?: 'gis' | 'ledger';
  // 台账按查询范围导出；all/selected 的 filter 仅允许明确的状态来源，不接收业务筛选。
  ledger?: { revision: string; range: 'all' | 'filtered' | 'selected'; filter?: ResourceReadFilter; selectedIds?: string[] };
  // GIS 按保存版本与查询条件导出，目录分页不负责收集全库 ID。
  gis?: { revision: string; range: 'all' | 'filtered' | 'selected'; filter?: ResourceReadFilter;
    browse: 'devices' | 'stations'; selectedIds?: Partial<Record<ResourceKind, string[]>> };
}
export interface ResourceMaintenanceRequest { context: 'ledger'; revision: string; deviceId?: string; ids?: string[] }
export interface ResourceMaintenanceContext {
  revision: string; baseRevision: string; device: Device | null;
  // 仅完整编辑接口提供；单设备上下文不能被当作整库。
  resources?: ResourcesData;
  meta?: ResourceMeta;
  // 批量上下架预览回显已核验清单，不把单条详情当作整批预览。
  selectedIds?: string[];
  stations: Station[]; models: DeviceModel[]; antennas: Antenna[];
  impact: { planIds: string[]; linkIds: string[]; description: string };
}
export interface ResourceExportObservation {
  snapshotId: string; snapshotRevision: string; resourceRevision: string;
  dataOrigin: 'SYNTHETIC_INTEGRATION'; sourceLabel: string;
}
export interface ResourceExportPreview {
  tables: { kind: ResourceKind; count: number }[]; added: number;
  warnings?: string[];
  statusMode?: 'observed'; observation?: ResourceExportObservation; nodeStatusMode?: 'baseline';
}
export interface ResourceServices {
  saveResourceChanges(request: ResourceCommit): Promise<ResourceMutationReceipt>;
  applyResourceImport(request: { baseRevision: string; requestId: string; preview: ResourceImportPreview }): Promise<ResourceMutationReceipt>;
  updateDeviceAvailability(request: { baseRevision: string; requestId: string; ids: string[]; availability: Availability }): Promise<ResourceMutationReceipt & { updated: string[]; unchanged: string[] }>;
  resetResourceData(request: { baseRevision: string | null; requestId?: string }): Promise<ResourceMutationReceipt>;
  loadResourceMaintenanceContext(request: ResourceMaintenanceRequest): Promise<ResourceMaintenanceContext>;
  previewResourceExport(request: ResourceExportRequest): Promise<ResourceExportPreview>;
  getResourceTemplate(format: ResourceFormat, kind?: ResourceKind): Promise<ResourceFile>;
  previewResourceImport(request: ResourceImportRequest): Promise<ResourceImportPreview>;
  commitResourceImport(request: { baseRevision: string; requestId: string; preview: ResourceImportPreview }): Promise<ResourceSaveResult>;
  exportResources(request: ResourceExportRequest): Promise<ResourceFile>;
  setDeviceAvailability(request: { baseRevision: string; requestId: string; ids: string[]; availability: Availability }): Promise<ResourceSaveResult & { updated: string[]; unchanged: string[] }>;
}
