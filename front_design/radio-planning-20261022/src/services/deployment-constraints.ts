import type { DeploymentConstraints, DeploymentPolygon } from '../types/deployment-constraints';
import type { Coordinate } from '../types/domain';
import type { PlanningIssue } from '../types/planning';

export const deploymentLimits = { points: 100, polygons: 20, coordinates: 2000 };
export const deploymentFields = ['maxSlopeDeg', 'elevationRangeM', 'allowedLandcover', 'roadMaxDistanceM',
  'minSiteSpacingM', 'losRequiredNodeIds', 'gridStepM', 'forcedInclude', 'forcedExcludePolygons'] as const;
export const deploymentLabels: Record<typeof deploymentFields[number], string> = {
  maxSlopeDeg: '最大坡度 / °', elevationRangeM: '海拔范围 / m', allowedLandcover: '允许地物',
  roadMaxDistanceM: '距道路上限 / m', minSiteSpacingM: '最小站间距 / m', losRequiredNodeIds: '全部通视节点',
  gridStepM: '网格间距 / m', forcedInclude: '强制部署点', forcedExcludePolygons: '禁部署区',
};
export const emptyDeploymentConstraints = (): DeploymentConstraints => ({ maxSlopeDeg: null, elevationRangeM: null,
  allowedLandcover: null, roadMaxDistanceM: null, minSiteSpacingM: null, losRequiredNodeIds: [], gridStepM: null,
  forcedInclude: [], forcedExcludePolygons: [] });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export function deploymentPointValid(value: unknown): value is Coordinate {
  return Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1])
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}
export function deploymentPolygonValid(value: unknown): value is DeploymentPolygon {
  if (!record(value) || value.type !== 'Polygon' || !Array.isArray(value.coordinates) || !value.coordinates.length) return false;
  // 只核对坐标环格式，不判断相交、包含、面积或业务可行性。
  return value.coordinates.every(ring => Array.isArray(ring) && ring.length >= 4 && ring.every(deploymentPointValid)
    && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1]
    && new Set(ring.map(point => JSON.stringify(point))).size >= 3);
}
export function deploymentConstraintIssues(value: unknown, nodeIds?: readonly string[]): PlanningIssue[] {
  if (value === undefined || value === null) return [];
  const issues: PlanningIssue[] = [];
  const add = (key: string, message: string) => issues.push({ objectId: 'TASK', field: 'deploymentConstraints.' + key, message });
  if (!record(value)) return [{ objectId: 'TASK', field: 'deploymentConstraints', message: '部署筛选条件须为完整对象或未设置' }];
  if (deploymentFields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !deploymentFields.includes(key as typeof deploymentFields[number])))
    add('shape', '部署筛选条件字段缺失或含不支持字段');
  for (const key of ['maxSlopeDeg', 'roadMaxDistanceM', 'minSiteSpacingM', 'gridStepM'] as const) {
    const number = value[key];
    if (number !== null && (!finite(number) || number < 0 || key === 'maxSlopeDeg' && number > 90 || key === 'gridStepM' && number === 0))
      add(key, deploymentLabels[key] + '格式无效，留空表示未指定');
  }
  const range = value.elevationRangeM;
  if (range !== null && (!Array.isArray(range) || range.length !== 2 || !range.every(finite) || range[0] > range[1]))
    add('elevationRangeM', '海拔上下界须成组填写且下界不大于上界');
  const covers = value.allowedLandcover;
  if (covers !== null && (!Array.isArray(covers) || !covers.length || !covers.every(text) || new Set(covers).size !== covers.length))
    add('allowedLandcover', '地物须为非空且无重复的文字列表，或留空未指定');
  const ids = value.losRequiredNodeIds;
  if (!Array.isArray(ids) || !ids.every(id => text(id) && !/\s/.test(id)) || new Set(ids).size !== ids.length)
    add('losRequiredNodeIds', '通视节点编号不可为空、重复或含空白');
  else if (nodeIds && ids.some(id => !nodeIds.includes(id))) add('losRequiredNodeIds', '通视条件引用的节点尚未保存或已不存在');
  const points = value.forcedInclude;
  if (!Array.isArray(points) || points.length > deploymentLimits.points || points.some(point => !record(point)
    || Object.keys(point).some(key => !['lon', 'lat'].includes(key)) || !deploymentPointValid([point.lon, point.lat])))
    add('forcedInclude', '强制部署点须为合法经纬度，最多100个；不会自动裁剪到任务区域');
  const polygons = value.forcedExcludePolygons;
  if (!Array.isArray(polygons) || polygons.length > deploymentLimits.polygons || polygons.some(polygon => !deploymentPolygonValid(polygon)))
    add('forcedExcludePolygons', '禁区须为Polygon坐标环，环需闭合且至少三个不同顶点，最多20个禁区');
  if (Array.isArray(polygons)) {
    const count = polygons.reduce((sum, polygon) => sum + (Array.isArray(polygon?.coordinates)
      ? polygon.coordinates.reduce((n: number, ring: unknown) => n + (Array.isArray(ring) ? ring.length : 0), 0) : 0), 0);
    if (count > deploymentLimits.coordinates) add('forcedExcludePolygons', '所有禁区坐标总数最多2000个');
  }
  return issues;
}
// 仅供 Mock 预设比较：合法全空与未设置等价，0 和非法值不能当作空值。
export function deploymentConstraintsUnspecified(value: unknown): boolean {
  if (value == null) return true;
  return record(value) && !deploymentConstraintIssues(value).length
    && Object.values(value).every(item => item === null || Array.isArray(item) && item.length === 0);
}
export function readDeploymentConstraints(value: unknown): DeploymentConstraints | null {
  if (value === undefined || deploymentConstraintIssues(value).length) throw new Error('部署筛选条件字段或格式无效');
  return structuredClone(value) as DeploymentConstraints | null;
}
// 比较副本始终有此项；不能让旧预设忽略新增条件，也不写回历史输入。
export function deploymentSignature(value: DeploymentConstraints | null | undefined) {
  return value == null ? null : { ...value,
    allowedLandcover: value.allowedLandcover ? [...value.allowedLandcover].sort() : null,
    losRequiredNodeIds: [...value.losRequiredNodeIds].sort() };
}
export function deploymentValue(value: unknown): string {
  if (value === null || value === undefined) return '未指定';
  if (Array.isArray(value)) return value.length ? value.join('；') : '无';
  return String(value);
}
export const deploymentHeaders = ['max_slope_deg', 'min_elevation_m', 'max_elevation_m', 'allowed_landcover',
  'road_max_distance_m', 'min_site_spacing_m', 'los_required_node_ids', 'grid_step_m', 'forced_include_json', 'forced_exclude_polygons_json'];
export function deploymentFileValues(value?: DeploymentConstraints | null): unknown[] {
  if (!value) return deploymentHeaders.map(() => '');
  return [value.maxSlopeDeg, value.elevationRangeM?.[0], value.elevationRangeM?.[1], value.allowedLandcover?.join(';'),
    value.roadMaxDistanceM, value.minSiteSpacingM, value.losRequiredNodeIds.join(';'), value.gridStepM,
    JSON.stringify(value.forcedInclude), JSON.stringify(value.forcedExcludePolygons)];
}
export function readDeploymentFile(row: Record<string, string>, add: (field: string, message: string) => void): DeploymentConstraints | undefined {
  if (!deploymentHeaders.some(key => row[key]?.trim())) return undefined;
  const numeric = (key: string) => !row[key]?.trim() ? null : /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(row[key].trim()) ? Number(row[key]) : NaN;
  const list = (key: string) => row[key]?.trim() ? row[key].split(';').map(value => value.trim()) : [];
  const json = (key: string) => { try { return row[key]?.trim() ? JSON.parse(row[key]) : []; } catch { add(key, 'JSON格式无效'); return []; } };
  const min = numeric('min_elevation_m'), max = numeric('max_elevation_m');
  const value: DeploymentConstraints = { maxSlopeDeg: numeric('max_slope_deg'), elevationRangeM: min === null && max === null ? null : [min ?? NaN, max ?? NaN],
    allowedLandcover: row.allowed_landcover?.trim() ? list('allowed_landcover') : null, roadMaxDistanceM: numeric('road_max_distance_m'),
    minSiteSpacingM: numeric('min_site_spacing_m'), losRequiredNodeIds: list('los_required_node_ids'), gridStepM: numeric('grid_step_m'),
    forcedInclude: json('forced_include_json'), forcedExcludePolygons: json('forced_exclude_polygons_json') };
  for (const issue of deploymentConstraintIssues(value)) add(issue.field, issue.message);
  return value;
}
