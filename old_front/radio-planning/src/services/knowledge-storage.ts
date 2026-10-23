import { KNOWLEDGE_PRESET_VERSION, KNOWLEDGE_SCHEMA_VERSION, KNOWLEDGE_STORAGE_KEY } from '../config/demo';
import { initialKnowledgeWorkspace } from '../mocks/knowledge-presets';
import type { ResourceStorage } from '../types/resource-edit';
import type { KnowledgeWorkspace } from '../types/knowledge';
import { ApiError } from './types';
import { historicalKnowledgeIdentity, upgradeKnowledgeIdentity, validateKnowledgeIdentities } from './knowledge-identity';
import { applyKnowledgeDraft, assertKnowledgeSnapshot, knowledgeAssert, knowledgeEqual, knowledgeText, knowledgeVersion, requireKnowledgeActor, validateKnowledgeDraft } from './knowledge-validation';

const timeValid = (s: unknown) => typeof s === 'string' && Number.isFinite(Date.parse(s));
export function validateKnowledgeWorkspace(w: KnowledgeWorkspace) {
  knowledgeAssert(w && [1,KNOWLEDGE_SCHEMA_VERSION].includes(w.schemaVersion) && w.presetVersion === KNOWLEDGE_PRESET_VERSION,'知识存储版本不兼容，请确认后重置','KNOWLEDGE_INCOMPATIBLE');
  knowledgeAssert(knowledgeText(w.revision,1,120) && Array.isArray(w.versions) && Array.isArray(w.changes) && Array.isArray(w.logs) && Array.isArray(w.receipts),'知识存储结构无效');
  const seed = initialKnowledgeWorkspace();
  knowledgeAssert(w.versions.length >= 2 && knowledgeEqual(w.versions.slice(0,2),seed.versions),'教学基线快照不完整或已被篡改');
  const ids = new Set<string>();
  const unique = (id: string) => { knowledgeAssert(knowledgeText(id,1,120) && !ids.has(id),'记录 ID 重复或无效'); ids.add(id); };
  for (const [i,v] of w.versions.entries()) {
    unique(v.id); assertKnowledgeSnapshot(v); historicalKnowledgeIdentity(w,'version:'+v.id,v.actorId,'REVIEWER');
    knowledgeAssert(v.number === i+1 && timeValid(v.time) && knowledgeText(v.summary,1,500),'版本元数据无效');
    knowledgeAssert(v.parentId === (i ? w.versions[i-1].id : null),'发布版本父链不连续');
    knowledgeAssert(['BASELINE','PUBLISH','ROLLBACK'].includes(v.kind) && (i === 0 ? v.kind === 'BASELINE' : v.kind !== 'BASELINE'),'发布类型无效');
    if (v.kind === 'ROLLBACK') {
      const parent = knowledgeVersion(w,v.parentId!); const target = knowledgeVersion(w,v.restoredFromVersionId!);
      knowledgeAssert(parent.parentId === target.id && v.changeId === null && knowledgeEqual({entities:v.entities,relations:v.relations},{entities:target.entities,relations:target.relations}),'回滚目标或内容不一致');
    } else knowledgeAssert(v.restoredFromVersionId === null,'普通发布不能含回滚目标');
  }
  knowledgeAssert(w.currentVersionId === w.versions.at(-1)!.id,'当前指针必须指向最后发布版本');
  for (const c of w.changes) {
    unique(c.id); historicalKnowledgeIdentity(w,'change:'+c.id,c.authorId,'EDITOR');
    knowledgeAssert(['DRAFT','PENDING','APPROVED','REJECTED','PUBLISHED'].includes(c.state) && Number.isInteger(c.revision) && c.revision > 0 && timeValid(c.createdAt) && timeValid(c.updatedAt) && Array.isArray(c.submissions),'变更单状态无效');
    const base = knowledgeVersion(w,c.content.baseVersionId); validateKnowledgeDraft(base,c.content);
    for (const [i,s] of c.submissions.entries()) {
      knowledgeAssert(s.number === i+1 && Number.isInteger(s.revision) && s.revision > 0 && s.revision <= c.revision && (i === 0 || s.revision >= c.submissions[i-1].revision) && s.actorId === c.authorId && timeValid(s.time),'送审身份或修订无效');
      knowledgeAssert(s.content.baseVersionId === base.id && ['PENDING','APPROVED','REJECTED','WITHDRAWN'].includes(s.outcome),'送审基线或结果无效'); validateKnowledgeDraft(base,s.content);
      knowledgeAssert(i === c.submissions.length-1 || ['REJECTED','WITHDRAWN'].includes(s.outcome),'旧送审必须已驳回或撤回');
      if (s.outcome === 'PENDING') knowledgeAssert(s.review === null,'待审核不能存在审核结果');
      else {
        knowledgeAssert(s.review && timeValid(s.review.time) && knowledgeText(s.review.opinion,s.outcome === 'REJECTED' ? 1 : 0,500),'审核记录无效');
        if (s.outcome === 'WITHDRAWN') knowledgeAssert(s.review.actorId === c.authorId,'撤回人必须为作者');
        else { historicalKnowledgeIdentity(w,'review:'+c.id+':'+s.number,s.review.actorId,'REVIEWER'); knowledgeAssert(s.review.actorId !== s.actorId && s.review.actorId !== c.authorId,'不能审核自己的变更'); }
      }
    }
    const last = c.submissions.at(-1);
    if (c.state === 'DRAFT') knowledgeAssert(!last || ['WITHDRAWN','REJECTED'].includes(last.outcome),'草稿保留了未结束的审核');
    else knowledgeAssert(last && last.outcome === (c.state === 'PUBLISHED' ? 'APPROVED' : c.state) && last.revision === c.revision && knowledgeEqual(last.content,c.content),'变更内容与送审修订不一致');
    if (c.state === 'PUBLISHED') {
      const v = knowledgeVersion(w,c.publishedVersionId!);
      knowledgeAssert(v.kind === 'PUBLISH' && v.changeId === c.id && v.parentId === base.id && knowledgeEqual(applyKnowledgeDraft(base,c.content),{entities:v.entities,relations:v.relations}),'发布内容与已审核变更不一致');
    } else knowledgeAssert(c.publishedVersionId === null,'未发布变更不能指向发布版本');
  }
  for (const v of w.versions) if (v.kind === 'PUBLISH') knowledgeAssert(w.changes.some(c => c.id === v.changeId && c.publishedVersionId === v.id),'发布缺少审核来源');
  for (const l of w.logs) {
    unique(l.id); historicalKnowledgeIdentity(w,'log:'+l.id,l.actorId); knowledgeVersion(w,l.versionId);
    knowledgeAssert(timeValid(l.time) && ['SAVE','SUBMIT','WITHDRAW','APPROVE','REJECT','PUBLISH','ROLLBACK','RESET'].includes(l.action) && knowledgeText(l.objectId,1,120) && typeof l.before === 'string' && typeof l.after === 'string' && knowledgeText(l.opinion,0,500),'知识操作日志无效');
    knowledgeAssert(w.changes.some(c => c.id === l.objectId) || w.versions.some(v => v.id === l.objectId),'日志对象引用无效');
  }
  validateKnowledgeIdentities(w);
  const requests = new Set<string>();
  for (const r of w.receipts) {
    knowledgeAssert(r && knowledgeText(r.requestId,1,120) && !requests.has(r.requestId) && knowledgeText(r.signature,1,500000) && typeof r.changed === 'boolean' && (w.changes.some(c => c.id === r.entityId) || w.versions.some(v => v.id === r.entityId)),'请求回执无效'); requests.add(r.requestId);
  }
}
export function readKnowledge(storage: ResourceStorage): KnowledgeWorkspace {
  let value: string | null;
  try { value = storage.getItem(KNOWLEDGE_STORAGE_KEY); } catch { throw new ApiError('知识存储读取失败，请检查浏览器权限','KNOWLEDGE_READ_FAILED'); }
  if (value === null) return initialKnowledgeWorkspace();
  // 合法旧版先按原身份规则校验，再在内存兼容；失败或只读不写回旧记录。
  try { const w = JSON.parse(value) as KnowledgeWorkspace; validateKnowledgeWorkspace(w); return w.schemaVersion === 1 ? upgradeKnowledgeIdentity(w) : w; }
  catch (reason) { if (reason instanceof ApiError && reason.code === 'KNOWLEDGE_INCOMPATIBLE') throw reason; throw new ApiError('知识记录损坏或关联不一致，原记录已保留；可由审核人确认重置','KNOWLEDGE_CORRUPT'); }
}
export function writeKnowledge(storage: ResourceStorage,w: KnowledgeWorkspace) {
  validateKnowledgeWorkspace(w);
  try { storage.setItem(KNOWLEDGE_STORAGE_KEY,JSON.stringify(w)); }
  catch { throw new ApiError('知识保存失败，当前版本和输入已保留；请检查存储权限或空间','KNOWLEDGE_WRITE_FAILED'); }
}
