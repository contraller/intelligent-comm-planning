import type { NetworkLink } from './domain';
import type { LinkMetricKey } from './link-detail';

// 解释冻结到一次采样，不能凭相同链路 ID 借用其他网络的结论。
export interface LinkAssessmentOwner {
  networkKey: string;
  linkId: string;
  a: string; b: string; deviceA: string; deviceB: string;
  observedAt: string;
  metrics: Record<LinkMetricKey, number | null>;
}
export interface LinkStateAssessment {
  owner: LinkAssessmentOwner;
  state: NetworkLink['state'];
  source: string;
  version: string;
  confidence?: number | null;
  matchedRuleIds?: string[] | null;
  dominantMetric?: LinkMetricKey | null;
  explanation?: string | null;
  rules?: { ruleId: string; title: string; conditionText: string; source: string; version: string | null }[] | null;
}
export interface LinkAssessmentDisplay {
  state: 'ready' | 'missing' | 'invalid' | 'stale';
  message: string;
  assessment: LinkStateAssessment | null;
}
