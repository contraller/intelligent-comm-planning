export const deviceStatusSchema = 'device-status-snapshot-a1' as const;
export type SnapshotStatus = 'NORMAL' | 'FAULT' | 'OFFLINE';
export type StatusFilter = SnapshotStatus | 'UNKNOWN' | 'ALL';
export interface ImportedDeviceStatus {
  device_id: string; node_id: string; model_id: string; observed_at: string | null;
  status: SnapshotStatus | null; alert: boolean | null; unknown_reasons: string[];
}
export interface DeviceStatusImport {
  schema_version: typeof deviceStatusSchema; context: 'ledger'; request_id: string; base_revision: string;
  data_origin: 'SYNTHETIC_INTEGRATION'; source_label: string; provenance_note: string; records: ImportedDeviceStatus[];
}
export interface DeviceStatusItem extends ImportedDeviceStatus { availability: 'ACTIVE' | 'OFF_SHELF' }
export interface DeviceStatusHeader {
  schema_version: typeof deviceStatusSchema; snapshot_id: string; snapshot_revision: string; content_hash: string;
  resource_revision: string; resource_content_hash: string; data_origin: 'SYNTHETIC_INTEGRATION';
  source_label: string; provenance_note: string; imported_at: string; actor_id: string; total: number;
  counts: Record<SnapshotStatus | 'UNKNOWN' | 'total', number>;
  first_observed_at: string | null; last_observed_at: string | null;
}
export interface DeviceStatusReceipt {
  schema_version: typeof deviceStatusSchema; request_id: string; snapshot_id: string; snapshot_revision: string;
  resource_revision: string; imported_at: string; total: number; content_hash: string; data_origin: 'SYNTHETIC_INTEGRATION';
}
export interface StatusPage<T> { schema_version: typeof deviceStatusSchema; items: T[]; total: number; page: number; page_size: number }
export interface StatusSnapshotQuery { context: 'ledger'; snapshot_id: string; snapshot_revision: string }
export interface StatusListQuery { context: 'ledger'; resource_revision?: string; page?: number; page_size?: number }
export interface StatusDeviceQuery extends StatusSnapshotQuery { device_id?: string; status_filter?: StatusFilter; page?: number; page_size?: number }
export interface StatusDevices extends StatusPage<DeviceStatusItem> { snapshot_id: string; snapshot_revision: string; resource_revision: string }
// 四字段必须取自同一持久化记录；没有该设备或跨资源版本时整体为 null。
export interface DeviceStatusSnapshotRef { snapshotId: string; snapshotRevision: string; resourceRevision: string; deviceId: string }
export interface DeviceStatusProjection {
  ref: DeviceStatusSnapshotRef; status: SnapshotStatus | null; alert: boolean | null;
  observedAt: string | null; unknownReasons: string[]; dataOrigin: 'SYNTHETIC_INTEGRATION';
}
