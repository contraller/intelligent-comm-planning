import type { Device, DeviceClass, MapRegion, Station } from './domain';
import type { CoverageRaster, PlanningCoverage } from './coverage';

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
  // 热力图独立提供；null 明确表示未提供，不能借用场强图补齐。
  heatmapPng: CoverageRaster | null;
  regions: MapRegion[];
}
export interface DeviceCoverageCatalog {
  version: string;
  source: string;
  samples: DeviceCoverageSample[];
}
export type DeviceCoverageMode = 'network' | 'single' | 'multiple';
export type DeviceCoverageRepresentation = 'field' | 'heatmap';
export interface DeviceCoverageOverlay {
  sample: DeviceCoverageSample;
  representation: DeviceCoverageRepresentation;
  visible: boolean;
  opacity: number;
}
