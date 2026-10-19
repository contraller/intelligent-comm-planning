import type { NetworkLink } from '../types/domain';
import type { LinkAssessmentDisplay, LinkAssessmentOwner, LinkStateAssessment } from '../types/link-assessment';
import type { LinkMetricKey } from '../types/link-detail';

export const assessmentMetrics: LinkMetricKey[] = ['snrDb', 'ber', 'packetLossRate', 'delayMs', 'throughputKbps'];
const states = ['EXCELLENT', 'GOOD', 'WARNING', 'FAULT'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
// 不接受 Date 自动进位的无效日期，采样时间必须包含明确时区。
const time = (v: unknown) => {
  if (!text(v) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) return false;
  const [year, month, day] = v.slice(0, 10).split('-').map(Number), date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && Number(v.slice(11, 13)) < 24;
};
export function assessmentOwner(networkKey: string, link: Pick<NetworkLink, 'id' | 'a' | 'b' | 'deviceA' | 'deviceB'>,
  observedAt: string, metrics: LinkAssessmentOwner['metrics']): LinkAssessmentOwner {
  return { networkKey, linkId: link.id, a: link.a, b: link.b, deviceA: link.deviceA, deviceB: link.deviceB, observedAt,
    metrics: Object.fromEntries(assessmentMetrics.map(key => [key, metrics[key]])) as LinkAssessmentOwner['metrics'] };
}
function validOwner(v: unknown): v is LinkAssessmentOwner {
  if (!object(v) || !['networkKey', 'linkId', 'a', 'b', 'deviceA', 'deviceB'].every(k => text(v[k])) || !time(v.observedAt) || !object(v.metrics)) return false;
  const metrics = v.metrics;
  return assessmentMetrics.every(key => metrics[key] === null || typeof metrics[key] === 'number' && Number.isFinite(metrics[key])
    && (key === 'snrDb' || metrics[key] >= 0) && (!['ber', 'packetLossRate'].includes(key) || metrics[key] <= 1));
}
// 仅比较服务声明的采样身份和值，不以任何门限推算业务结论。
export function sameAssessmentOwner(a: LinkAssessmentOwner, b: LinkAssessmentOwner) {
  return validOwner(a) && validOwner(b) && ['networkKey', 'linkId', 'a', 'b', 'deviceA', 'deviceB', 'observedAt'].every(k => a[k as keyof LinkAssessmentOwner] === b[k as keyof LinkAssessmentOwner])
    && assessmentMetrics.every(k => a.metrics[k] === b.metrics[k]);
}
export function selectLinkAssessment(value: unknown, owner: LinkAssessmentOwner | null): LinkAssessmentDisplay {
  const result = (state: LinkAssessmentDisplay['state'], message: string): LinkAssessmentDisplay => ({ state, message, assessment: null });
  if (!owner) return result('stale', '当前采样不可用，暂停展示判定依据。');
  if (value == null) return result('missing', '未提供此采样的判定依据。');
  if (!object(value) || !validOwner(value.owner) || typeof value.state !== 'string' || !states.includes(value.state) || !text(value.source) || !text(value.version)
    || value.confidence != null && (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1)
    || value.dominantMetric != null && !assessmentMetrics.includes(value.dominantMetric as LinkMetricKey)
    || value.explanation != null && !text(value.explanation)) return result('invalid', '判定依据字段无效；原观测数据保留。');
  const ids = value.matchedRuleIds;
  if (ids != null && (!Array.isArray(ids) || Array.from(ids).some(id => !text(id)) || new Set(ids).size !== ids.length))
    return result('invalid', '命中规则列表无效；原观测数据保留。');
  const rules = value.rules;
  if (rules != null && (!Array.isArray(rules) || Array.from(rules).some(r => !object(r) || !text(r.ruleId) || !Array.isArray(ids) || !ids.includes(r.ruleId)
    || !text(r.title) || !text(r.conditionText) || !text(r.source) || r.version !== null && !text(r.version))
    || new Set(rules.map(r => r.ruleId)).size !== rules.length)) return result('invalid', '规则摘录与命中列表不匹配；原观测数据保留。');
  if (!sameAssessmentOwner(value.owner, owner)) return result('stale', '判定依据与当前网络、端点或采样不匹配，已停止展示。');
  return { state: 'ready', message: '', assessment: value as unknown as LinkStateAssessment };
}
