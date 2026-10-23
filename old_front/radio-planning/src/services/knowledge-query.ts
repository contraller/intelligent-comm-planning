import { KNOWLEDGE_MAX_EDGES, KNOWLEDGE_MAX_NODES, KNOWLEDGE_PAGE_SIZE } from '../config/demo';
import { knowledgeModels, knowledgeRecommendations } from '../mocks/knowledge-presets';
import type { DeviceKnowledge, KnowledgeDetail, KnowledgeEntity, KnowledgeGraph, KnowledgeQuery, KnowledgeSearch, KnowledgeVersion, KnowledgeWorkspace } from '../types/knowledge';
import { knowledgeAssert, knowledgeClone, knowledgeVersion } from './knowledge-validation';
import { resolveKnowledgePrinciple } from './knowledge-principle';
import { resolveNetworkRule } from './knowledge-network-rule';

// 只加入实际可读内容，缺失提示不作为所有实体的检索关键词。
const ruleText = (entity: KnowledgeEntity) => {
  const value = resolveNetworkRule(entity)?.rule;
  return value ? [value.scope, value.source, ...value.criteria.flatMap(r => [r.state, r.condition, r.meaning]),
    ...value.transitions.flatMap(r => [r.from, r.to, r.description])] : [];
};

// 只检索当前实体所属版本的步骤；不读取草稿或其他型号的流程。
export const matchesKnowledge = (e: KnowledgeEntity,query = '') => [e.id,e.name,e.description,...e.keywords,
  ...(resolveKnowledgePrinciple(e)?.flow.steps.flatMap(step => [step.title,step.description]) ?? []), ...ruleText(e)
].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
function filtered(v: KnowledgeVersion,q: KnowledgeQuery) {
  knowledgeAssert(Array.isArray(q.categories) && q.categories.every(c => ['设备知识','网络态势知识','故障运维知识'].includes(c)),'请选择有效图谱分类');
  knowledgeAssert(q.query === undefined || typeof q.query === 'string','检索词格式无效');
  return v.entities.filter(e => q.categories.includes(e.category) && (!q.type || e.type === q.type) && matchesKnowledge(e,q.query));
}
export function searchKnowledgeSnapshot(w: KnowledgeWorkspace,q: KnowledgeQuery): KnowledgeSearch {
  const v = knowledgeVersion(w,q.versionId), rows = filtered(v,q); const requested = q.page ?? 1;
  knowledgeAssert(Number.isInteger(requested) && requested > 0,'页码须为正整数');
  const page = Math.min(requested,Math.max(1,Math.ceil(rows.length/KNOWLEDGE_PAGE_SIZE)));
  const ids = knowledgeRecommendations[q.query?.trim().toLocaleLowerCase() ?? ''] ?? [];
  return knowledgeClone({versionId:v.id,items:rows.slice((page-1)*KNOWLEDGE_PAGE_SIZE,page*KNOWLEDGE_PAGE_SIZE),total:rows.length,page,code:rows.length ? 0 : 4001,similar:rows.length ? [] : v.entities.filter(e => ids.includes(e.id) && q.categories.includes(e.category) && (!q.type || e.type === q.type))});
}
export function knowledgeEntityDetail(w: KnowledgeWorkspace,versionId: string,id: string): KnowledgeDetail {
  const v = knowledgeVersion(w,versionId), entity = v.entities.find(e => e.id === id);
  knowledgeAssert(entity,'该实体不在所选发布版本中','KNOWLEDGE_ENTITY_MISSING');
  const relations = v.relations.filter(r => r.head === id || r.tail === id), neighbors = v.entities.filter(e => e.id !== id && relations.some(r => r.head === e.id || r.tail === e.id));
  return knowledgeClone({versionId:v.id,entity,relations,neighbors});
}
export function queryKnowledgeSnapshot(w: KnowledgeWorkspace,q: KnowledgeQuery & { focusId?: string; expandedIds?: string[] }): KnowledgeGraph {
  const v = knowledgeVersion(w,q.versionId); const matches = filtered(v,q);
  let rows = matches;
  if (q.focusId) {
    knowledgeAssert(q.expandedIds === undefined || (Array.isArray(q.expandedIds) && q.expandedIds.every(id => typeof id === 'string' && v.entities.some(e => e.id === id))),'展开对象不存在于指定版本');
    const root = v.entities.find(e => e.id === q.focusId); knowledgeAssert(root,'聚焦实体不存在','KNOWLEDGE_ENTITY_MISSING');
    // 聚焦对象须在明确选择的类别中；关键字仅控制列表，不隐藏被选中的根节点。
    knowledgeAssert(q.categories.includes(root.category),'请先选择实体所属图谱');
    const ids = new Set([q.focusId]);
    for (const id of q.expandedIds ?? []) {
      if (!ids.has(id)) continue;
      for (const r of v.relations.filter(r => r.head === id || r.tail === id)) {
        const neighborId = r.head === id ? r.tail : r.head;
        if (v.entities.some(e => e.id === neighborId && q.categories.includes(e.category))) ids.add(neighborId);
      }
    }
    rows = [...ids].map(id => v.entities.find(e => e.id === id)!);
  }
  const allIds = new Set(rows.map(e => e.id)); const allEdges = v.relations.filter(r => allIds.has(r.head) && allIds.has(r.tail));
  const entities = rows.slice(0,KNOWLEDGE_MAX_NODES), visible = new Set(entities.map(e => e.id));
  return knowledgeClone({versionId:v.id,entities,relations:allEdges.filter(r => visible.has(r.head) && visible.has(r.tail)).slice(0,KNOWLEDGE_MAX_EDGES),totalNodes:rows.length,totalEdges:allEdges.length});
}
export function deviceKnowledgeSnapshot(w: KnowledgeWorkspace,q: {versionId:string;modelId:string;query?:string}): DeviceKnowledge {
  const v = knowledgeVersion(w,q.versionId); knowledgeAssert(knowledgeModels.some(m => m.id === q.modelId),'设备型号不存在','KNOWLEDGE_MODEL_MISSING');
  const items = v.entities.filter(e => e.category === '设备知识' && e.modelIds.includes(q.modelId) && matchesKnowledge(e,q.query)).map(e => knowledgeEntityDetail(w,v.id,e.id));
  return {versionId:v.id,modelId:q.modelId,items};
}
