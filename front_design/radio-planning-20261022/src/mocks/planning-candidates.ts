import { freezeMockData as freeze } from './freeze';
import { planningResultDetailsCatalog, PLANNING_RESULT_DETAILS_ASSET_VERSION } from './planning-result-details';
import type { PlanningCandidateScreening, PlanningCandidateSite } from '../types/planning-candidates';
import type { PlanningResultDetails } from '../types/planning-result-details';

export const PLANNING_CANDIDATES_ASSET_VERSION = 'planning-result-details-demo-2';
// 独立教学常量，不读取候选附件、地形、设备参数来推算位置或结论。
const sites: PlanningCandidateSite[] = [
  { siteId: 'CS-DEMO-01', coordinate: [114.88, 37.21], elevationM: 862.4, slopeDeg: 6.2, landcoverType: '草地',
    nearestRoadDistanceM: 740, nearestNodeDistanceM: 3100, visibleNodeCount: null, candidateRole: 'RELAY',
    isDeployable: true, recommendationLevel: 'A', score: 85.17, rejectReason: '' },
  { siteId: 'CS-DEMO-02', coordinate: [114.72, 37.35], elevationM: 420, slopeDeg: 0, landcoverType: '耕地',
    nearestRoadDistanceM: 0, nearestNodeDistanceM: 5200, visibleNodeCount: 0, candidateRole: 'RELAY',
    isDeployable: true, recommendationLevel: 'B', score: 72.5, rejectReason: '' },
  { siteId: 'CS-DEMO-03', coordinate: [114.9, 37.4], elevationM: 510, slopeDeg: 28, landcoverType: '林地',
    nearestRoadDistanceM: 3600, nearestNodeDistanceM: 2300, visibleNodeCount: null, candidateRole: 'CANDIDATE',
    isDeployable: false, recommendationLevel: null, score: 0, rejectReason: '教学预设：服务标记坡度条件未通过' },
  { siteId: 'CS-DEMO-04', coordinate: null, elevationM: null, slopeDeg: null, landcoverType: null,
    nearestRoadDistanceM: null, nearestNodeDistanceM: null, visibleNodeCount: null, candidateRole: null,
    isDeployable: null, recommendationLevel: null, score: null, rejectReason: null },
];
const screening: PlanningCandidateScreening = { sourceLabel: '独立教学预生成候选结果 · 三站场景', candidateCount: 4, deployableCount: 2,
  candidates: sites, rejectedStats: { slope: 1, elevation: 0, landcover: 0, road: 0, spacing: 0, source_rule: 0, outside_bbox: 0 } };
const original = planningResultDetailsCatalog[PLANNING_RESULT_DETAILS_ASSET_VERSION];
// 新版本只复制旧明细常量；旧发布目录保持原字节与原语义。
const extend = (rows: Record<string, PlanningResultDetails>, candidates: PlanningCandidateScreening | null) =>
  Object.fromEntries(Object.entries(rows).map(([id, detail]) => [id, { ...structuredClone(detail),
    assetVersion: PLANNING_CANDIDATES_ASSET_VERSION, candidateScreening: structuredClone(candidates) }]));
export const planningCandidatesCatalog = freeze({ [PLANNING_CANDIDATES_ASSET_VERSION]: {
  presets: extend(original.presets, screening),
  // 抗干扰措施未提供独立候选筛选，不能继承措施前的结论。
  variants: extend(original.variants, null),
} });
