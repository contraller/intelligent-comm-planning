import { legacyPrincipleFlow, legacyPrincipleMatch } from '../mocks/knowledge-principles';
import type { KnowledgeEntity, KnowledgeIssue, KnowledgePrincipleFlow } from '../types/knowledge';

export const PRINCIPLE_MAX_STEPS = 12;
const text = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.trim().length >= min && value.length <= max;

// 与原实体校验组合使用；非法流程不能被丢弃后冒充保存成功。
export function principleIssues(entity: KnowledgeEntity): KnowledgeIssue[] {
  const flow = entity.principleFlow;
  if (flow === undefined || flow === null) return [];
  const issue = (message: string) => ({ objectId: entity.id, field: 'principleFlow', message });
  if (entity.category !== '设备知识') return [issue('仅设备知识可以设置工作原理流程')];
  if (typeof flow !== 'object' || Array.isArray(flow) || !Array.isArray(flow.steps) || flow.steps.length < 2 || flow.steps.length > PRINCIPLE_MAX_STEPS)
    return [issue('工作原理须包含 2–12 个顺序步骤')];
  const issues: KnowledgeIssue[] = [];
  // 按索引检查，稀疏数组的空位同样视为非法步骤。
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    if (!step || typeof step !== 'object' || Array.isArray(step) || !text(step.title, 1, 40) || !text(step.description, 0, 200))
      issues.push(issue(`第 ${i + 1} 步：标题须为 1–40 字符，说明最多 200 字符`));
  }
  return issues;
}

export function resolveKnowledgePrinciple(entity: KnowledgeEntity): { flow: KnowledgePrincipleFlow; preset: boolean } | null {
  if (entity.principleFlow === null || principleIssues(entity).length) return null;
  if (entity.principleFlow !== undefined)
    return { flow: { steps: entity.principleFlow.steps.map(step => ({ ...step })) }, preset: false };
  // 关联型号和原理正文须仍对应这份预设；缺失资料不借用其他型号或旧文字的图。
  const expected = legacyPrincipleMatch;
  if (entity.id !== expected.id || entity.category !== expected.category || entity.type !== expected.type ||
      entity.description !== expected.description || entity.source !== expected.source ||
      entity.modelIds.length !== expected.modelIds.length || !expected.modelIds.every(id => entity.modelIds.includes(id))) return null;
  return { flow: { steps: legacyPrincipleFlow.steps.map(step => ({ ...step })) }, preset: true };
}

export function describeKnowledgePrinciple(entity: KnowledgeEntity): string {
  const resolved = resolveKnowledgePrinciple(entity);
  if (!resolved) return entity.principleFlow === null ? '工作原理流程：已明确移除' : '工作原理流程：未提供';
  return ['工作原理流程' + (resolved.preset ? '（固定教学示例）' : '（版本内步骤）'),
    ...resolved.flow.steps.map((step, i) => `${i + 1}. ${step.title}${step.description ? '：' + step.description : ''}`)].join('\n');
}
