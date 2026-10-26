import type { Device, DeviceModel, OperationalStatus } from './domain';
import type { PageQuery, PageResult } from './data-access';
import type { ActorSnapshot } from './system';

// 实例端口配置与采集观测分开，身份和接线不属于维护字段。
export interface DevicePort {
  id: string; number: string; type: 'RF' | 'BUSINESS';
  freqMinKhz: number | null; freqMaxKhz: number | null; rateKbps: number | null;
  gainDbi: number | null; heightM: number | null; azimuthDeg: number | null; tiltDeg: number | null;
}
export interface PortObservation { portId: string; status: OperationalStatus | null; observedAt: string; source: string }
export interface MaintenanceQuery { context: 'gis' | 'ledger'; deviceId: string; revision: string; signal?: AbortSignal }
export interface MaintenanceBinding { context: 'gis' | 'ledger'; revision: string; editable: boolean }
export interface DeviceMaintenanceContext {
  revision: string; device: Device; model: DeviceModel; modeOptions: { value: string; label: string }[];
  observations: PortObservation[]; source: string;
}
export interface DeviceFieldChange { field: string; before: unknown; after: unknown }
export interface DeviceHistory {
  id: string; deviceId: string; revision: string; previousRevision: string; epoch: string;
  time: string; actor: ActorSnapshot | null; source: string; requestId: string | null;
  restoredFrom: string | null; before: Device | null; after: Device; changes: DeviceFieldChange[];
}
export type DeviceHistorySummary = Omit<DeviceHistory, 'before' | 'after' | 'changes'> & { fields: string[] };
export interface DeviceRestorePreview {
  historyId: string; revision: string; compatible: boolean; reasons: string[];
  changes: DeviceFieldChange[]; values: Partial<Pick<Device, 'antennaHeightM' | 'txPowerDbm' | 'workFreqKhz' | 'currentWorkMode' | 'ports'>>;
}
export interface DeviceMaintenanceServices {
  getDeviceMaintenance(input: MaintenanceQuery): Promise<DeviceMaintenanceContext>;
  queryDeviceHistory(input: MaintenanceQuery & PageQuery): Promise<PageResult<DeviceHistorySummary>>;
  getDeviceHistory(input: MaintenanceQuery & { historyId: string }): Promise<DeviceHistory>;
  previewDeviceRestore(input: MaintenanceQuery & { historyId: string }): Promise<DeviceRestorePreview>;
}
