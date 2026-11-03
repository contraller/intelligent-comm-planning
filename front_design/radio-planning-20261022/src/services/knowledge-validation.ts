import { KNOWLEDGE_MAX_OPERATIONS } from '../config/demo';
import { knowledgeActors, knowledgeModels, knowledgeRelationTypes, knowledgeTypes } from '../mocks/knowledge-presets';
import type { KnowledgeChange, KnowledgeDraft, KnowledgeEntity, KnowledgeIssue, KnowledgeSnapshot, KnowledgeWorkspace } from '../types/knowledge';
import { ApiError } from './types';
import { principleIssues } from './knowledge-principle';
import { networkRuleIssues } from './knowledge-network-rule';

// 递归复制普通契约数据，保留 NaN 等非法输入给校验器拒绝，不通过 JSON 把它变成 null。
export function knowledgeClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => knowledgeClone(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,knowledgeClone(item)])) as T;
  return value;
}
// 只规范对象键顺序，数组顺序作为有序字段保留；不执行任何业务表达式。
export function knowledgeSignature(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) return '#invalidNumber:'+String(value);
  if (Array.isArray(value)) return '['+value.map(knowledgeSignature).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k)+':'+knowledgeSignature(v)).join(',')+'}';
  return JSON.stringify(value) ?? 'undefined';
}
export const knowledgeEqual = (a: unknown,b: unknown) => knowledgeSignature(a) === knowledgeSignature(b);
export function knowledgeAssert(condition: unknown, message: string, code = 'KNOWLEDGE_INVALID'): asserts condition {
  if (!condition) throw new ApiError(message,code);
}
export const knowledgeText = (s: unknown,min: number,max: number): s is string => typeof s === 'string' && s.trim().length >= min && s.length <= max;
// 固定身份仅用于隔离工厂；应用当前操作由统一登录上下文授权。
export function requireKnowledgeActor(id: string,role?: 'EDITOR' | 'REVIEWER') {
  const actor = knowledgeActors.find(a => a.id === id);
  knowledgeAssert(actor && (!role || actor.role === role),'当前身份无权执行此操作','KNOWLEDGE_FORBIDDEN'); return actor;
}
export function knowledgeVersion(w: KnowledgeWorkspace,id: string) {
  const v = w.versions.find(v => v.id === id); knowledgeAssert(v,'知识版本不存在或已被重置','KNOWLEDGE_VERSION_MISSING'); return v;
}
export function knowledgeIssues(snapshot: KnowledgeSnapshot): KnowledgeIssue[] {
  const errors: KnowledgeIssue[] = [];
  const add = (objectId: string,field: string,message: string) => errors.push({objectId,field,message});
  if (!snapshot || !Array.isArray(snapshot.entities) || !Array.isArray(snapshot.relations)) return [{objectId:'工作区',field:'结构',message:'实体和关系必须是数组'}];
  const ids = new Set<string>();
  for (const e of snapshot.entities) {
    if (!e || !knowledgeText(e.id,1,120)) { add('实体','id','实体 ID 无效'); continue; }
    if (ids.has(e.id)) add(e.id,'id','实体 ID 重复'); ids.add(e.id);
    if (!knowledgeText(e.name,1,80)) add(e.id,'name','名称须为 1–80 字符');
    if (!knowledgeText(e.description,0,2000)) add(e.id,'description','描述最多 2000 字符');
    if (!knowledgeText(e.source,1,200)) add(e.id,'source','来源说明须为 1–200 字符');
    if (!knowledgeTypes.some(t => t.id === e.type && t.category === e.category)) add(e.id,'type','类型与图谱分类不匹配');
    if (!Array.isArray(e.keywords) || e.keywords.length > 10 || e.keywords.some(k => !knowledgeText(k,1,30)) || new Set(e.keywords).size !== e.keywords.length) add(e.id,'keywords','关键词最多 10 项，每项 1–30 字符且不重复');
    if (!Array.isArray(e.attributes) || e.attributes.length > 20 || e.attributes.some(a => !a || !knowledgeText(a.name,1,40) || !knowledgeText(a.value,0,500) || (a.unit !== null && !knowledgeText(a.unit,0,20)))) add(e.id,'attributes','属性最多 20 项，检查字段名、值和单位长度');
    if (!Array.isArray(e.modelIds) || new Set(e.modelIds).size !== e.modelIds.length || e.modelIds.some(id => !knowledgeModels.some(m => m.id === id)) || (e.category !== '设备知识' && e.modelIds.length)) add(e.id,'modelIds','仅设备知识可关联有效型号，型号不能重复');
    // 步骤随实体进入草稿、送审和版本快照，复用原有状态与存储校验。
    errors.push(...principleIssues(e));
    // 文本规则随同一实体的草稿及版本校验，不运行状态判定。
    errors.push(...networkRuleIssues(e));
  }
  const relationIds = new Set<string>(), triples = new Set<string>();
  for (const r of snapshot.relations) {
    if (!r || !knowledgeText(r.id,1,120)) { add('关系','id','关系 ID 无效'); continue; }
    if (relationIds.has(r.id) || ids.has(r.id)) add(r.id,'id','关系 ID 重复或与实体冲突'); relationIds.add(r.id);
    if (!ids.has(r.head) || !ids.has(r.tail) || r.head === r.tail) add(r.id,'endpoints','关系端点必须存在且不能自指');
    if (!knowledgeRelationTypes.some(t => t.id === r.type)) add(r.id,'type','关系类型不在字典中');
    if (r.weight !== null && (typeof r.weight !== 'number' || !Number.isFinite(r.weight) || r.weight < 0 || r.weight > 1)) add(r.id,'weight','权重为空或 0–1 有限数值');
    if (!knowledgeText(r.source,1,200)) add(r.id,'source','来源说明须为 1–200 字符');
    const key = JSON.stringify([r.head,r.type,r.tail]); if (triples.has(key)) add(r.id,'endpoints','头实体/关系类型/尾实体重复'); triples.add(key);
  }
  return errors;
}
export function assertKnowledgeSnapshot(snapshot: KnowledgeSnapshot) {
  const issues = knowledgeIssues(snapshot); if (issues.length) throw new ApiError('知识内容校验失败','KNOWLEDGE_VALIDATION',issues);
}
export function applyKnowledgeDraft(base: KnowledgeSnapshot,draft: KnowledgeDraft): KnowledgeSnapshot {
  const entities = new Map(base.entities.map(e => [e.id,knowledgeClone(e)]));
  const relations = new Map(base.relations.map(r => [r.id,knowledgeClone(r)]));
  for (const e of draft.entities) entities.set(e.id,knowledgeClone(e));
  for (const r of draft.relations) relations.set(r.id,knowledgeClone(r));
  return {entities:[...entities.values()],relations:[...relations.values()]};
}
export function validateKnowledgeDraft(base: KnowledgeSnapshot,draft: KnowledgeDraft,previous?: KnowledgeDraft) {
  knowledgeAssert(draft && knowledgeText(draft.summary,1,120) && knowledgeText(draft.baseVersionId,1,120),'变更摘要须为 1–120 字符，且必须指定基线版本');
  knowledgeAssert(Array.isArray(draft.entities) && Array.isArray(draft.relations),'变更内容须为实体和关系数组');
  knowledgeAssert(draft.entities.length+draft.relations.length > 0 && draft.entities.length+draft.relations.length <= KNOWLEDGE_MAX_OPERATIONS,'每单须包含 1–30 项实体/关系操作');
  const all = [...draft.entities,...draft.relations]; knowledgeAssert(all.every(x => x && knowledgeText(x.id,1,120)) && new Set(all.map(x => x.id)).size === all.length,'变更对象 ID 无效或重复');
  for (const e of draft.entities) {
    const old: KnowledgeEntity | undefined = previous?.entities.find(x => x.id === e.id) ?? base.entities.find(x => x.id === e.id);
    knowledgeAssert(!old || (old.type === e.type && old.category === e.category),'已保存实体的类型和分类不能修改');
  }
  if (previous) knowledgeAssert([...previous.entities,...previous.relations].every(x => all.some(y => y.id === x.id)),'已保存变更行不能移除；可新建当前版本变更单');
  const candidate = applyKnowledgeDraft(base,draft); assertKnowledgeSnapshot(candidate); return candidate;
}
export function currentKnowledgeChange(w: KnowledgeWorkspace,id: string,revision: number,states: KnowledgeChange['state'][]) {
  const c = w.changes.find(c => c.id === id); knowledgeAssert(c,'变更单不存在');
  knowledgeAssert(c.revision === revision,'变更修订已变化，请重新加载','KNOWLEDGE_CONFLICT');
  knowledgeAssert(states.includes(c.state),'当前状态不允许此操作','KNOWLEDGE_STATE');
  knowledgeAssert(c.content.baseVersionId === w.currentVersionId,'基线已过期，请以当前版本重新新建并送审','KNOWLEDGE_STALE'); return c;
}
export function knowledgeDiff(before: KnowledgeSnapshot,after: KnowledgeSnapshot) {
  return (['entities','relations'] as const).flatMap(kind => {
    const ids = new Set([...before[kind],...after[kind]].map(x => x.id));
    return [...ids].flatMap(id => { const a = before[kind].find(x => x.id === id),b = after[kind].find(x => x.id === id); return knowledgeEqual(a,b) ? [] : [{id,kind,action:!a?'新增':!b?'恢复时移出':'修改',before:a ?? null,after:b ?? null}]; });
  });
}
