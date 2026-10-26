import type { NetworkLink } from './domain';
import type { LinkStateAssessment } from './link-assessment';

export type LinkMetricKey = 'snrDb' | 'ber' | 'packetLossRate' | 'delayMs' | 'throughputKbps';
export type LinkMetricStatus = 'NORMAL' | 'WARNING' | 'FAULT' | 'MISSING';
// 状态和原因由资料提供；数值只用于展示，不在前端判断越限。
export interface LinkMetric {
  value: number | null;
  status: LinkMetricStatus;
  reason: string;
}
export interface LinkHistorySample {
  // 可选说明独立校验，缺失不影响原指标和趋势。
  assessment?: LinkStateAssessment | null;
  timestamp: string;
  linkState: NetworkLink['state'];
  metrics: Record<LinkMetricKey, LinkMetric>;
}
export interface LinkDetail {
  linkId: string;
  a: string;
  b: string;
  deviceA: string;
  deviceB: string;
  bandwidthKhz: number;
  samples: LinkHistorySample[];
}
export interface LinkDetailCatalog {
  version: 'link-detail-v1';
  snapshotId: string;
  source: string;
  records: LinkDetail[];
}
export interface LinkDetailContext {
  state: 'ready' | 'missing' | 'invalid' | 'stale';
  message: string;
  snapshotId: string;
  source: string;
  records: LinkDetail[];
}
