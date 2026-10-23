import type { PlanningCandidateScreening } from '../types/planning-candidates';

const invalid = (field: string): never => { throw new Error(`候选部署点明细无效：${field}`); };
function object(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(label);
  const row = value as Record<string, unknown>;
  if (fields.some(field => !Object.hasOwn(row, field))) invalid(label + ' 缺少字段');
  return row;
}
function number(value: unknown, field: string, min = -Infinity, max = Infinity, integer = false) {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value))) invalid(field);
}
// 数量与评分只做格式校验，不推算总数、推荐等级或可部署结论。
export function assertPlanningCandidateScreening(value: unknown): asserts value is PlanningCandidateScreening {
  const root = object(value, ['sourceLabel', 'candidateCount', 'deployableCount', 'candidates', 'rejectedStats'], '容器');
  if (typeof root.sourceLabel !== 'string' || !root.sourceLabel.trim()) invalid('sourceLabel');
  number(root.candidateCount, 'candidateCount', 0, Infinity, true);
  number(root.deployableCount, 'deployableCount', 0, Infinity, true);
  if (root.rejectedStats !== null) {
    const stats = object(root.rejectedStats, [], 'rejectedStats');
    for (const [key, count] of Object.entries(stats)) { if (!key.trim()) invalid('统计项目'); number(count, key, 0, Infinity, true); }
  }
  if (root.candidates === null) return;
  if (!Array.isArray(root.candidates)) return invalid('candidates');
  const ids = new Set<string>();
  for (const value of root.candidates) {
    const row = object(value, ['siteId', 'coordinate', 'elevationM', 'slopeDeg', 'landcoverType', 'nearestRoadDistanceM',
      'nearestNodeDistanceM', 'visibleNodeCount', 'candidateRole', 'isDeployable', 'recommendationLevel', 'score', 'rejectReason'], '候选');
    if (typeof row.siteId !== 'string' || !row.siteId.trim() || ids.has(row.siteId)) invalid('siteId 缺失或重复');
    ids.add(row.siteId as string);
    if (row.coordinate !== null) {
      if (!Array.isArray(row.coordinate) || row.coordinate.length !== 2 || row.coordinate.some(x => typeof x !== 'number' || !Number.isFinite(x))) invalid('coordinate');
      const point = row.coordinate as number[];
      number(point[0], '经度', -180, 180); number(point[1], '纬度', -90, 90);
    }
    number(row.elevationM, 'elevationM'); number(row.slopeDeg, 'slopeDeg', 0, 90); number(row.score, 'score');
    for (const key of ['nearestRoadDistanceM', 'nearestNodeDistanceM']) number(row[key], key, 0);
    number(row.visibleNodeCount, 'visibleNodeCount', 0, Infinity, true);
    for (const key of ['landcoverType', 'candidateRole', 'recommendationLevel', 'rejectReason'])
      if (row[key] !== null && typeof row[key] !== 'string') invalid(key);
    if (row.isDeployable !== null && typeof row.isDeployable !== 'boolean') invalid('isDeployable');
  }
}
