import type { OperationalStatus } from './domain';

// 观测独立于可保存的 Device；空值表示服务未提供结论。
export type DeviceStatusContext = 'ledger' | 'gis';
export interface DeviceStatusSource { id: string; label: string; kind: 'MOCK' | 'BACKEND' }
export interface DeviceStatusRequest { context: DeviceStatusContext; resourceRevision: string }
export interface DeviceStatusCatalog {
  resourceRevision: string; source: DeviceStatusSource;
  examples?: { id: string; label: string; source: DeviceStatusSource }[];
}
export interface DeviceStatusQuery extends DeviceStatusRequest { deviceIds: string[]; exampleId?: string }
export interface DeviceObservation {
  observationId: string; sequence: number; observedAt: string;
  status: OperationalStatus | null; alert: boolean | null;
}
interface DeviceStatusIdentity { deviceId: string; stationId: string; modelId: string }
export type DeviceStatusItem = DeviceStatusIdentity & (
  { outcome: 'REPORTED'; observation: DeviceObservation; reason?: string }
  | { outcome: 'NO_REPORT' | 'FAILED'; reason: string; observation?: never }
);
export interface DeviceStatusBatch {
  batchId: string; resourceRevision: string; source: DeviceStatusSource; items: DeviceStatusItem[];
}
export interface ResourceStatusServices {
  loadDeviceStatusContext(request: DeviceStatusRequest): Promise<DeviceStatusCatalog>;
  queryDeviceStatuses(request: DeviceStatusQuery): Promise<DeviceStatusBatch>;
}
export interface DeviceStatusRecord {
  source: DeviceStatusSource; observation?: DeviceObservation; outcome: DeviceStatusItem['outcome'];
  reason?: string; fetchedAt: string; retained: boolean;
}
export interface DeviceStatusDisplay {
  mode: 'baseline' | 'observed'; status: OperationalStatus | null; alert: boolean | null;
  sourceLabel: string; observedAt?: string; fetchedAt?: string; note: string; retained: boolean;
}
