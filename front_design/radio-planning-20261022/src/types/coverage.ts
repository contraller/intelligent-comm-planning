import type { Coordinate } from './domain';
import type { Bounds } from './resource-read';

// 显示方式仅属于页面偏好，不写入接口数据或方案快照。
export type CoverageDisplay = 'auto' | 'raster' | 'contour';

// 所有外部几何都是 WGS84；不把多个面压成一个外环。
export interface CoverageFeature {
  type: 'Feature'; id: string;
  properties: { level: string; field_strength_dbuvm_min: number | null };
  geometry: { type: 'Polygon'; coordinates: Coordinate[][] } | { type: 'MultiPolygon'; coordinates: Coordinate[][][] };
}
export interface CoverageRaster {
  url: string; bbox: Bounds; crs: 'EPSG:4326'; width: number; height: number;
  colormap: { value_dbuvm: number; rgba: [number, number, number, number] }[];
}
export interface PlanningCoverage {
  contour: { type: 'FeatureCollection'; features: CoverageFeature[] } | null;
  rasterPng: CoverageRaster | null;
}
