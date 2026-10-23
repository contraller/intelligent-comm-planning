import type { Device, DeviceClass, MapRegion, Station } from './domain';
import type { PlanningCoverage } from './coverage';

// 教学样例按设备和版本归属，不作为实时覆盖或合成网络结果。
export interface DeviceCoverageSample {
  snapshotId: string;
  deviceId: string;
  stationId: string;
  deviceClass: DeviceClass;
  label: string;
  color: string;
  inputSnapshot: { station: Station; device: Device };
  coverage: PlanningCoverage;
  regions: MapRegion[];
}
export interface DeviceCoverageCatalog {
  version: string;
  source: string;
  samples: DeviceCoverageSample[];
}
export type DeviceCoverageMode = 'network' | 'single' | 'multiple';
export interface DeviceCoverageOverlay {
  sample: DeviceCoverageSample;
  visible: boolean;
  opacity: number;
}
