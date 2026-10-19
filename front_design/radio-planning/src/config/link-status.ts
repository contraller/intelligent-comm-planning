import type { NetworkLink } from '../types/domain';

// 链路质量的展示口径共用；不从颜色或指标反推业务状态。
export const LINK_STATUS_STYLES = {
  EXCELLENT: { label: '优秀', color: '#21a366', width: 3 },
  GOOD: { label: '良好', color: '#8ed66b', width: 2.5 },
  WARNING: { label: '预警', color: '#f2cf5b', width: 2 },
  FAULT: { label: '故障', color: '#ef5f64', width: 4 },
} as const satisfies Record<NetworkLink['state'], { label: string; color: string; width: number }>;
