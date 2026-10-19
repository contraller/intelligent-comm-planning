import type { KnowledgeEntity, KnowledgePrincipleFlow } from '../types/knowledge';

// 只补充既有教学文字的固定展示，不修改知识基线，也不解析任意文字生成流程。
export const legacyPrincipleMatch: Pick<KnowledgeEntity, 'id' | 'category' | 'type' | 'description' | 'source' | 'modelIds'> = {
  id: 'KGE-PRINCIPLE', category: '设备知识', type: 'Function',
  description: '教学流程：输入信号 → 信号处理 → 射频传输 → 接收还原。',
  source: '独立教学预设 · 非厂家操作手册', modelIds: ['DM-0001', 'DM-0002'],
};
export const legacyPrincipleFlow: KnowledgePrincipleFlow = {
  steps: ['输入信号', '信号处理', '射频传输', '接收还原'].map(title => ({ title, description: '' })),
};
