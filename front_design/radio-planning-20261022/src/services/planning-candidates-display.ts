import type { CandidateFilter, PlanningCandidateScreening, PlanningCandidateSite } from '../types/planning-candidates';

// 原始评分不转百分比，空字符串也不冒充服务给出的正常结论。
export const candidateValue = (value: string | number | null | undefined) => value == null ? '未提供' : value === '' ? '未给出内容' : String(value);
export const candidateConclusion = (value: boolean | null) => value === true ? '可部署' : value === false ? '不可部署' : '未提供结论';
export function filterCandidates(rows: readonly PlanningCandidateSite[], search: string, filter: CandidateFilter) {
  const term = search.trim().toLocaleLowerCase();
  return rows.filter(row => (!term || [row.siteId, row.candidateRole, row.rejectReason].some(value => value?.toLocaleLowerCase().includes(term)))
    && (filter === 'all' || filter === 'yes' && row.isDeployable === true || filter === 'no' && row.isDeployable === false || filter === 'unknown' && row.isDeployable === null));
}
export const candidateColumns = [{ field: 'siteId', header: '候选编号' }, { field: 'candidateRole', header: '候选角色' },
  { field: 'isDeployable', header: '服务结论' }, { field: 'recommendationLevel', header: '推荐等级' }, { field: 'score', header: '评分（原值）' }];
export const candidateDetailFields = [
  ['elevationM', '高程 / m'], ['slopeDeg', '坡度 / °'], ['landcoverType', '地物类型'],
  ['nearestRoadDistanceM', '最近道路距离 / m'], ['nearestNodeDistanceM', '最近节点距离 / m'], ['visibleNodeCount', '可见节点数'],
  ['candidateRole', '候选角色'], ['recommendationLevel', '推荐等级'], ['score', '评分（原值）'], ['rejectReason', '拒绝原因'],
] as const;
const rejectionLabels: Record<string, string> = { slope: '坡度', elevation: '海拔', landcover: '地物', road: '距路', spacing: '间距', source_rule: '来源规则', outside_bbox: '范围外' };
export function candidateRejections(screening: PlanningCandidateScreening) {
  return Object.entries(screening.rejectedStats ?? {}).map(([id, count]) => ({ id, label: Object.hasOwn(rejectionLabels, id) ? rejectionLabels[id] : id, count }));
}
