import type { KnowledgeEntity, KnowledgeIssue, KnowledgeNetworkRule } from '../types/knowledge';

export const networkRuleStates = ['EXCELLENT', 'GOOD', 'WARNING', 'FAULT'] as const;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === 'string' && !!v.trim() && v.length <= max;
const state = (v: unknown) => networkRuleStates.includes(v as typeof networkRuleStates[number]);
// 保留非法输入交给保存校验，不通过 JSON 将无效数值转换为空值。
export function networkRuleIssues(entity: KnowledgeEntity): KnowledgeIssue[] {
  const rule = entity.networkRule;
  if (rule == null) return [];
  const fail = (message: string) => [{ objectId: entity.id, field: 'networkRule', message }];
  if (entity.type !== 'NetRule' || entity.category !== '网络态势知识') return fail('仅网络态势的组网规则可以设置状态规则说明，请先移除不适用内容');
  if (!object(rule) || !text(rule.scope, 500) || !text(rule.source, 200)) return fail('规则适用范围须为 1–500 字符，来源须为 1–200 字符');
  if (!Array.isArray(rule.criteria) || rule.criteria.length !== 4 || Array.from(rule.criteria).some(r => !object(r) || !state(r.state)
    || !text(r.condition, 500) || !text(r.meaning, 500)) || new Set(rule.criteria.map(r => r.state)).size !== 4)
    return fail('须提供四个不重复状态的条件和含义，每项为 1–500 字符');
  if (!Array.isArray(rule.transitions) || rule.transitions.length > 12 || Array.from(rule.transitions).some(r => !object(r) || !state(r.from) || !state(r.to) || !text(r.description, 500)))
    return fail('状态变化说明最多 12 条，状态须有效，说明须为 1–500 字符');
  return [];
}
export function copyNetworkRule(rule: KnowledgeNetworkRule): KnowledgeNetworkRule {
  return { scope: rule.scope, source: rule.source, criteria: rule.criteria.map(r => ({ ...r })), transitions: rule.transitions.map(r => ({ ...r })) };
}
// 规则仅取自当前实体，历史与回滚不会读取版本外的附件。
export function resolveNetworkRule(entity: KnowledgeEntity): { rule: KnowledgeNetworkRule } | null {
  if (entity.networkRule === null || networkRuleIssues(entity).length) return null;
  if (entity.networkRule !== undefined) return { rule: copyNetworkRule(entity.networkRule) };
  return null;
}
export function describeNetworkRule(entity: KnowledgeEntity): string {
  const value = resolveNetworkRule(entity);
  if (!value) return entity.networkRule === null ? '状态规则说明：已明确移除' : '状态规则说明：未提供';
  return ['状态规则说明', value.rule.scope, '规则来源：' + value.rule.source,
    ...value.rule.criteria.map(r => `${r.state}：${r.condition}；${r.meaning}`),
    ...value.rule.transitions.map(r => `${r.from} → ${r.to}：${r.description}`),
    ...(value.rule.transitions.length ? [] : ['暂无状态变化说明'])].join('\n');
}
