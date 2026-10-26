// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from './random-uuid';
import { initialKnowledgeWorkspace, knowledgeCatalog } from '../mocks/knowledge-presets';
import type { ResourceStorage } from '../types/resource-edit';
import type { AuthIdentity } from '../types/system';
import { canSelfReviewKnowledge, captureKnowledgeIdentity, currentKnowledgeIdentity, presetKnowledgeIdentity } from './knowledge-identity';
import type { Permission } from '../config/permissions';
import type { KnowledgeChangeRequest, KnowledgeIdentitySnapshot, KnowledgeMutation, KnowledgeMutationResult, KnowledgeServices, KnowledgeWorkspace } from '../types/knowledge';
import { ApiError } from './types';
import { readKnowledge, writeKnowledge } from './knowledge-storage';
import { applyKnowledgeDraft, currentKnowledgeChange, knowledgeAssert, knowledgeClone, knowledgeDiff, knowledgeEqual, knowledgeSignature, knowledgeText, knowledgeVersion, requireKnowledgeActor, validateKnowledgeDraft } from './knowledge-validation';
import { deviceKnowledgeSnapshot, knowledgeEntityDetail, queryKnowledgeSnapshot, searchKnowledgeSnapshot } from './knowledge-query';
import { searchKnowledgeSummaries, knowledgeGraphSummary } from './knowledge-query';
import { assertReading, pageItems } from './data-access';
import type { KnowledgeReceipt, KnowledgeVersion, KnowledgeChange, KnowledgeCategory } from '../types/knowledge';

export function createKnowledgeMock(getStorage: () => ResourceStorage,now = () => new Date().toISOString(),getIdentity?: () => AuthIdentity | null): KnowledgeServices {
  const id = (prefix: string) => prefix+'-'+randomUuid();
  // 公开应用注入经过系统配置校验的身份；无注入仅用于旧业务工厂的隔离测试。
  function authorize(kind:string,actorId:string,role:'EDITOR'|'REVIEWER') {
    if(!getIdentity){requireKnowledgeActor(actorId,role);return presetKnowledgeIdentity(actorId,role);}
    const actor=getIdentity();
    const codes:Record<string,Permission>={SAVE:'knowledge.edit',SUBMIT:'knowledge.edit',WITHDRAW:'knowledge.edit',REVIEW:'knowledge.review',PUBLISH:'knowledge.publish',ROLLBACK:'knowledge.rollback',RESET:'knowledge.reset'};
    knowledgeAssert(actor&&actor.id===actorId&&actor.permissions.includes(codes[kind]),'登录身份没有此知识操作权限','KNOWLEDGE_FORBIDDEN');
    return currentKnowledgeIdentity(actor,role);
  }
  function log(w: KnowledgeWorkspace,actorId: string,action: string,objectId: string,before: string,after: string,opinion = '') {
    w.logs.push({id:id('KGL'),actorId,action,objectId,before,after,opinion,versionId:w.currentVersionId,time:now()});
  }
  function transact<T extends KnowledgeMutation>(kind: string,request: T,role: 'EDITOR' | 'REVIEWER',action: (w:KnowledgeWorkspace,actor:KnowledgeIdentitySnapshot) => {entityId:string;changed:boolean}): KnowledgeMutationResult {
    const actor=authorize(kind,request.actorId,role); knowledgeAssert(knowledgeText(request.requestId,1,120),'缺少有效请求标识');
    const storage = getStorage(); const w = readKnowledge(storage);
    // 回执先于 revision 检查，重试已成功的请求不会重复发布或审核。
    const signature = knowledgeSignature({kind,request}); const receipt = w.receipts.find(r => r.requestId === request.requestId);
    if (receipt) { knowledgeAssert(receipt.signature === signature,'相同请求标识不能用于不同内容','KNOWLEDGE_REQUEST_CONFLICT'); return {workspace:w,entityId:receipt.entityId,changed:receipt.changed}; }
    knowledgeAssert(w.revision === request.baseRevision,'知识工作区已变化，请保留输入并重新加载','KNOWLEDGE_CONFLICT');
    const result = action(w,actor);
    if (result.changed) {
      captureKnowledgeIdentity(w,actor);
      w.receipts.push({requestId:request.requestId,signature,...result}); w.revision = id('KGM');
      writeKnowledge(storage,w);
    }
    return {workspace:knowledgeClone(w),...result};
  }
  function own(w:KnowledgeWorkspace,r:KnowledgeChangeRequest,states: ('DRAFT'|'PENDING'|'REJECTED')[]) {
    const c = currentKnowledgeChange(w,r.changeId,r.revision,states);
    knowledgeAssert(c.authorId === r.actorId,'只能处理自己提交的变更','KNOWLEDGE_FORBIDDEN'); return c;
  }
  const versionHeader=({entities,relations,...header}:KnowledgeVersion)=>header;
  const changeHeader=({content,submissions,...header}:KnowledgeChange)=>({...header,summary:content.summary,baseVersionId:content.baseVersionId});
  function compact(value:KnowledgeMutationResult):KnowledgeReceipt {
    return {objectId:value.entityId,entityId:value.entityId,changed:value.changed,revision:value.workspace.revision,currentVersionId:value.workspace.currentVersionId};
  }
  const service:KnowledgeServices = {
    async loadKnowledgeMetadata(input) {
      assertReading(input);const catalog=knowledgeCatalog();
      try { const w=readKnowledge(getStorage()),current=knowledgeVersion(w,w.currentVersionId);
        for(const s of w.identitySnapshots??[])if(!catalog.actors.some(a=>a.id===s.id))catalog.actors.push({id:s.id,name:s.name,role:s.role});
        const counts=Object.fromEntries(['设备知识','网络态势知识','故障运维知识'].map(c=>[c,current.entities.filter(e=>e.category===c).length])) as Record<KnowledgeCategory,number>;
        return {...catalog,error:null,workspace:{revision:w.revision,currentVersionId:w.currentVersionId,current:versionHeader(current),counts,identitySnapshots:knowledgeClone(w.identitySnapshots??[])}};
      } catch(e) {return {...catalog,error:e instanceof Error?e.message:'知识读取失败',workspace:null};}
    },
    async searchKnowledgeSummaries(q) {assertReading(q);return searchKnowledgeSummaries(readKnowledge(getStorage()),q);},
    async getKnowledgeGraph(q) {assertReading(q);return knowledgeGraphSummary(readKnowledge(getStorage()),q);},
    async queryKnowledgeChanges(q) {assertReading(q);return pageItems(readKnowledge(getStorage()).changes.filter(c=>!q.state||c.state===q.state).slice().reverse().map(changeHeader),q);},
    async queryKnowledgeVersions(q) {assertReading(q);return pageItems(readKnowledge(getStorage()).versions.slice().reverse().map(versionHeader),q);},
    async queryKnowledgeLogs(q) {assertReading(q);return pageItems(readKnowledge(getStorage()).logs.slice().reverse(),q);},
    async getKnowledgeChange(q) {assertReading(q);const c=readKnowledge(getStorage()).changes.find(c=>c.id===q.id);knowledgeAssert(c,'知识变更不存在','KNOWLEDGE_CHANGE_MISSING');return knowledgeClone(c);},
    async getKnowledgeVersion(q) {assertReading(q);return knowledgeClone(knowledgeVersion(readKnowledge(getStorage()),q.id));},
    async saveKnowledgeReceipt(r) {return compact(await service.saveKnowledgeChange(r));},
    async submitKnowledgeReceipt(r) {return compact(await service.submitKnowledgeChange(r));},
    async withdrawKnowledgeReceipt(r) {return compact(await service.withdrawKnowledgeChange(r));},
    async reviewKnowledgeReceipt(r) {return compact(await service.reviewKnowledgeChange(r));},
    async publishKnowledgeReceipt(r) {return compact(await service.publishKnowledgeChange(r));},
    async rollbackKnowledgeReceipt(r) {return compact(await service.rollbackKnowledgeVersion(r));},
    async resetKnowledgeReceipt(r) {return compact(await service.resetKnowledgeWorkspace(r));},
    async loadKnowledgeWorkspace() {
      const catalog = knowledgeCatalog();
      try { const workspace=readKnowledge(getStorage());
        for(const s of workspace.identitySnapshots??[])if(!catalog.actors.some(a=>a.id===s.id))catalog.actors.push({id:s.id,name:s.name,role:s.role});
        return {...catalog,workspace,error:null}; }
      catch (reason) { return {...catalog,workspace:null,error:reason instanceof Error ? reason.message : '知识加载失败'}; }
    },
    async searchKnowledge(q) { return searchKnowledgeSnapshot(readKnowledge(getStorage()),q); },
    async getKnowledgeEntity(q) { assertReading(q); return knowledgeEntityDetail(readKnowledge(getStorage()),q.versionId,q.entityId); },
    async queryKnowledgeGraph(q) { return queryKnowledgeSnapshot(readKnowledge(getStorage()),q); },
    async getDeviceKnowledge(q) { assertReading(q); return deviceKnowledgeSnapshot(readKnowledge(getStorage()),q); },
    async saveKnowledgeChange(r) {
      return transact('SAVE',r,'EDITOR',w => {
        const previous = r.changeId ? own(w,{...r,changeId:r.changeId,revision:r.revision!},['DRAFT','REJECTED']) : null;
        const draft = knowledgeClone(r.draft); knowledgeAssert(draft.baseVersionId === w.currentVersionId,'草稿基线已过期，请基于当前版本新建','KNOWLEDGE_STALE');
        const base = knowledgeVersion(w,draft.baseVersionId);
        validateKnowledgeDraft(base,draft,previous?.content);
        // 临时行 ID 只用于表单内互相引用，真正的实体/关系 ID 在服务保存时分配。
        const assigned = new Map<string,string>();
        for (const row of [...draft.entities,...draft.relations]) {
          const exists = [...base.entities,...base.relations,...(previous?.content.entities ?? []),...(previous?.content.relations ?? [])].some(x => x.id === row.id);
          knowledgeAssert(exists || row.id.startsWith('new:'),'新增行必须使用临时引用，不能冒用已有身份');
          if (!exists) assigned.set(row.id,id('head' in row ? 'KGR' : 'KGE'));
        }
        for (const e of draft.entities) e.id = assigned.get(e.id) ?? e.id;
        for (const edge of draft.relations) { edge.id = assigned.get(edge.id) ?? edge.id; edge.head = assigned.get(edge.head) ?? edge.head; edge.tail = assigned.get(edge.tail) ?? edge.tail; }
        const candidate = validateKnowledgeDraft(base,draft,previous?.content);
        if (previous && knowledgeEqual(previous.content,draft) && previous.state === 'DRAFT') return {entityId:previous.id,changed:false};
        knowledgeAssert(knowledgeDiff(base,candidate).length,'没有相对已发布基线的实际修改','KNOWLEDGE_NO_CHANGE');
        if (previous) {
          const before = previous.state; previous.content = draft; previous.revision++; previous.state = 'DRAFT'; previous.updatedAt = now(); log(w,r.actorId,'SAVE',previous.id,before,'DRAFT'); return {entityId:previous.id,changed:true};
        }
        const changeId = id('KGC'); w.changes.push({id:changeId,authorId:r.actorId,state:'DRAFT',revision:1,content:draft,createdAt:now(),updatedAt:now(),submissions:[],publishedVersionId:null}); log(w,r.actorId,'SAVE',changeId,'','DRAFT'); return {entityId:changeId,changed:true};
      });
    },
    async submitKnowledgeChange(r) {
      return transact('SUBMIT',r,'EDITOR',w => {
        const c = own(w,r,['DRAFT']); validateKnowledgeDraft(knowledgeVersion(w,c.content.baseVersionId),c.content);
        c.submissions.push({number:c.submissions.length+1,revision:c.revision,actorId:r.actorId,time:now(),content:knowledgeClone(c.content),outcome:'PENDING',review:null}); c.state = 'PENDING'; c.updatedAt = now(); log(w,r.actorId,'SUBMIT',c.id,'DRAFT','PENDING'); return {entityId:c.id,changed:true};
      });
    },
    async withdrawKnowledgeChange(r) {
      return transact('WITHDRAW',r,'EDITOR',w => {
        const c = own(w,r,['PENDING']); c.submissions.at(-1)!.outcome = 'WITHDRAWN'; c.submissions.at(-1)!.review = {actorId:r.actorId,time:now(),opinion:'作者撤回'}; c.state = 'DRAFT'; c.updatedAt = now(); log(w,r.actorId,'WITHDRAW',c.id,'PENDING','DRAFT'); return {entityId:c.id,changed:true};
      });
    },
    async reviewKnowledgeChange(r) {
      return transact('REVIEW',r,'REVIEWER',(w,actor) => {
        const c = currentKnowledgeChange(w,r.changeId,r.revision,['PENDING']), s = c.submissions.at(-1)!;
        // 例外依据已授权身份，不能只信任请求中的 actorId。
        knowledgeAssert(canSelfReviewKnowledge(actor)||(r.actorId !== c.authorId && r.actorId !== s.actorId),'提交人和作者不能自审','KNOWLEDGE_FORBIDDEN');
        knowledgeAssert(s.number === r.submission && knowledgeEqual(s.content,c.content),'送审修订已变化','KNOWLEDGE_CONFLICT');
        knowledgeAssert(typeof r.approved === 'boolean' && knowledgeText(r.opinion,r.approved?0:1,500),'驳回须填写原因；审核意见最多 500 字符');
        c.state = r.approved ? 'APPROVED':'REJECTED'; s.outcome = c.state; s.review = {actorId:r.actorId,time:now(),opinion:r.opinion.trim()}; c.updatedAt = now(); log(w,r.actorId,r.approved?'APPROVE':'REJECT',c.id,'PENDING',c.state,r.opinion.trim()); return {entityId:c.id,changed:true};
      });
    },
    async publishKnowledgeChange(r) {
      return transact('PUBLISH',r,'REVIEWER',w => {
        const c = currentKnowledgeChange(w,r.changeId,r.revision,['APPROVED']), base = knowledgeVersion(w,w.currentVersionId);
        const candidate = validateKnowledgeDraft(base,c.content); knowledgeAssert(knowledgeDiff(base,candidate).length,'没有可发布的实际修改');
        const versionId = id('KGV'); w.versions.push({...candidate,id:versionId,number:w.versions.length+1,parentId:base.id,restoredFromVersionId:null,kind:'PUBLISH',actorId:r.actorId,time:now(),summary:c.content.summary,changeId:c.id});
        w.currentVersionId = versionId; c.state = 'PUBLISHED'; c.publishedVersionId = versionId; c.updatedAt = now(); log(w,r.actorId,'PUBLISH',c.id,'APPROVED','PUBLISHED'); return {entityId:c.id,changed:true};
      });
    },
    async rollbackKnowledgeVersion(r) {
      return transact('ROLLBACK',r,'REVIEWER',w => {
        knowledgeAssert(w.currentVersionId === r.versionId,'当前发布版本已变化','KNOWLEDGE_CONFLICT'); knowledgeAssert(knowledgeText(r.reason,1,500),'回滚原因须为 1–500 字符');
        const current = knowledgeVersion(w,w.currentVersionId); knowledgeAssert(current.parentId,'没有上一完整发布版本'); const target = knowledgeVersion(w,current.parentId);
        knowledgeAssert(knowledgeDiff(current,target).length,'上一版与当前内容相同，无需回滚');
        const versionId = id('KGV'); w.versions.push({entities:knowledgeClone(target.entities),relations:knowledgeClone(target.relations),id:versionId,number:w.versions.length+1,parentId:current.id,restoredFromVersionId:target.id,kind:'ROLLBACK',actorId:r.actorId,time:now(),summary:'恢复 v'+target.number+'：'+r.reason.trim().slice(0,100),changeId:null});
        w.currentVersionId = versionId; log(w,r.actorId,'ROLLBACK',versionId,current.id,versionId,r.reason.trim()); return {entityId:versionId,changed:true};
      });
    },
    async resetKnowledgeWorkspace(r) {
      const actor=authorize('RESET',r.actorId,'REVIEWER'); knowledgeAssert(knowledgeText(r.requestId,1,120),'缺少请求标识'); const storage = getStorage();
      let current: KnowledgeWorkspace | null = null;
      try { current = readKnowledge(storage); } catch (e) { if (!(e instanceof ApiError) || !['KNOWLEDGE_CORRUPT','KNOWLEDGE_INCOMPATIBLE'].includes(String(e.code))) throw e; }
      const signature = knowledgeSignature({kind:'RESET',request:r}), receipt = current?.receipts.find(x => x.requestId === r.requestId);
      if (receipt) { knowledgeAssert(receipt.signature === signature,'请求标识已用于其他内容'); return {workspace:current!,entityId:receipt.entityId,changed:true}; }
      knowledgeAssert(!current || current.revision === r.baseRevision,'知识版本已变化，请重新加载后再重置','KNOWLEDGE_CONFLICT');
      const w = initialKnowledgeWorkspace(); w.revision = id('KGM'); log(w,r.actorId,'RESET',w.currentVersionId,current?.currentVersionId ?? '损坏记录',w.currentVersionId,'用户确认恢复知识初始数据'); captureKnowledgeIdentity(w,actor); w.receipts.push({requestId:r.requestId,signature,entityId:w.currentVersionId,changed:true}); writeKnowledge(storage,w); return {workspace:w,entityId:w.currentVersionId,changed:true};
    },
  };
  return service;
}
