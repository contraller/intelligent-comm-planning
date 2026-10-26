import type { DeviceClass, OperationalStatus } from './domain';
import type { ReadDevice } from './resource-read';
import type { DeviceStatusDisplay } from './resource-status';

// 页面读模型保留缺失值；不能作为可提交的完整资源快照。
export interface ResourceLedgerRow extends ReadDevice {
  region: string | null;
  mobility: string | null;
  nodeRole: string | null;
  relayCapable: boolean | null;
  freqMinKhz: number | null;
  freqMaxKhz: number | null;
  displayedStatus: OperationalStatus | 'UNKNOWN';
  statusDisplay?: DeviceStatusDisplay;
}
export interface LedgerClassification { mobility: string; role: string; relay: string }
export interface LedgerCounts {
  devices: number | null; nodes: number | null; models: number | null; alerts: number | null;
  hf: number | null; vuhf: number | null;
  deployments: Record<DeviceClass, Record<string, number>> | null;
}
