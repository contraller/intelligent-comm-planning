import type { Coordinate } from './domain';

// 输入约束与候选结果、正式资源分别建模；空值表示未指定，不是零。
export interface DeploymentPolygon { type: 'Polygon'; coordinates: Coordinate[][] }
export interface DeploymentConstraints {
  maxSlopeDeg: number | null;
  elevationRangeM: [number, number] | null;
  allowedLandcover: string[] | null;
  roadMaxDistanceM: number | null;
  minSiteSpacingM: number | null;
  losRequiredNodeIds: string[];
  gridStepM: number | null;
  forcedInclude: { lon: number; lat: number }[];
  forcedExcludePolygons: DeploymentPolygon[];
}
export interface DeploymentConstraintFrame {
  owner: string;
  label: string;
  constraints: DeploymentConstraints | null | undefined;
}
