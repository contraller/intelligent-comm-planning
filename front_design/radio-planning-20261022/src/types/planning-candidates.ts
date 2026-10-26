import type { Coordinate } from './domain';

// 候选身份只属于当前规划结果，不与正式节点或候选链路共用身份。
export interface PlanningCandidateSite {
  siteId: string;
  coordinate: Coordinate | null;
  elevationM: number | null;
  slopeDeg: number | null;
  landcoverType: string | null;
  nearestRoadDistanceM: number | null;
  nearestNodeDistanceM: number | null;
  visibleNodeCount: number | null;
  candidateRole: string | null;
  isDeployable: boolean | null;
  recommendationLevel: string | null;
  score: number | null;
  rejectReason: string | null;
}
export interface PlanningCandidateScreening {
  dataSources?: string[] | null;
  unavailableReasons?: string[] | null;
  sourceLabel: string;
  candidateCount: number | null;
  deployableCount: number | null;
  candidates: PlanningCandidateSite[] | null;
  rejectedStats: Record<string, number | null> | null;
}
export type CandidateFilter = 'all' | 'yes' | 'no' | 'unknown';
export interface CandidateSelection { owner: string; epoch: number; siteId: string }
export interface CandidateRow extends PlanningCandidateSite, CandidateSelection { id: string }
export interface CandidateMapFrame {
  owner: string; epoch: number; visible: boolean;
  points: PlanningCandidateSite[]; selectedId: string;
}
// 控件与地图复用同一组带代次的动作，迟到事件不可选择另一个结果。
export interface PlanningCandidatesView {
  screening: PlanningCandidateScreening | null | undefined;
  rows: CandidateRow[]; selected: CandidateRow | null;
  search: string; filter: CandidateFilter; visible: boolean; enabled: boolean; notice: string;
  actions: {
    search(event: Event): void; filter(event: Event): void; visible(event: Event): void;
    select(row: CandidateSelection): void; locate(row: CandidateSelection): void; clear(): void;
  };
}
