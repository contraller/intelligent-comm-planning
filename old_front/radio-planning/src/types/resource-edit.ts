import type { Availability, Device, InterferenceSource, ResourcesData, Station } from './domain';
import type { CandidateLink, CandidateLinkPatch } from './candidate-link';

export type StationFields = Pick<Station, 'name' | 'coordinate' | 'elevationM' | 'region' | 'remark'>;
export type DeviceFields = Pick<Device, 'antennaHeightM' | 'txPowerDbm' | 'workFreqKhz'>;
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
  baseRevision: string;
  requestId?: string;
  context?: 'gis' | 'ledger';
}
export interface ResourceIssue {
  sheet?: ResourceKind;
  row?: number;
  objectId: string;
  field: string;
  message: string;
}
export interface ResourceMeta {
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
export interface ResourceRecord extends ResourceMeta {
  candidateLinks?: CandidateLink[];
  schemaVersion: number;
  sourceVersion: string;
  stations: Station[];
  devices: Device[];
  interferences?: InterferenceSource[];
}
// v1–v4 只在读取边界兼容；成功提交统一使用 v5，无变化回执不升业务版本。
export type LegacyResourceRecord = Omit<
  ResourceRecord,
  'resourceEpoch' | 'stationVersions' | 'deviceVersions'
>;
export interface ResourceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface EditForm {
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
}
export interface ResourceServices {
  getResourceTemplate(format: ResourceFormat, kind?: ResourceKind): Promise<ResourceFile>;
  previewResourceImport(request: ResourceImportRequest): Promise<ResourceImportPreview>;
  commitResourceImport(request: { baseRevision: string; requestId: string; preview: ResourceImportPreview }): Promise<ResourceSaveResult>;
  exportResources(request: ResourceExportRequest): Promise<ResourceFile>;
  setDeviceAvailability(request: { baseRevision: string; requestId: string; ids: string[]; availability: Availability }): Promise<ResourceSaveResult & { updated: string[]; unchanged: string[] }>;
}
