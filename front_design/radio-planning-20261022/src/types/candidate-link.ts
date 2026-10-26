import type { DeviceClass } from './domain';

// 候选输入与正式 NetworkLink 分开；所有评估字段都由服务或外部文件提供。
export interface CandidateLinkConfig {
  id: string;
  nodeAId: string; nodeBId: string; deviceAId: string; deviceBId: string;
  deviceClass: DeviceClass;
  freqKhz: number | null; bandwidthKhz: number | null; isBackup: boolean | null;
}
export interface CandidateLinkAssessment {
  distanceM: number | null; pathLossDb: number | null; rxPowerDbm: number | null;
  linkMarginDb: number | null; isAvailable: boolean | null;
  linkState: 'EXCELLENT' | 'GOOD' | 'WARNING' | 'FAULT' | null;
}
export interface CandidateLinkData extends CandidateLinkConfig, CandidateLinkAssessment {}
export interface CandidateLinkSource {
  kind: 'SOURCE' | 'IMPORT' | 'MANUAL'; file: string | null; row: number | null;
}
export interface CandidateLink extends CandidateLinkData {
  assessmentState: 'REFERENCE' | 'PENDING';
  source: CandidateLinkSource;
  // 保留参考当时的完整配置，不能将旧数值拼到新端点上。
  reference: { data: CandidateLinkData; source: CandidateLinkSource } | null;
  notices?: string[];
}
export type CandidateLinkPatch = Partial<Omit<CandidateLinkConfig, 'id'>> & { id: string };
