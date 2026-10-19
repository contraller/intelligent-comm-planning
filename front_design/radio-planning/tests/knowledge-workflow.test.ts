import { authorizeStore } from './helpers/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createKnowledgeMock } from '../src/services/knowledge-mock';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { knowledgeClone } from '../src/services/knowledge-validation';
import { previewService } from '../src/services';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { TestStorage } from './helpers/storage';
import type { KnowledgeChange, KnowledgeWorkspace } from '../src/types/knowledge';

afterEach(()=>vi.restoreAllMocks());
function setup(){const storage=new TestStorage(),service=createKnowledgeMock(()=>storage);let counter=0;return {storage,service,request:(w:KnowledgeWorkspace,actorId='KG-EDITOR')=>({actorId,baseRevision:w.revision,requestId:'request-'+(++counter)}),change:(w:KnowledgeWorkspace)=>w.changes.find(c=>c.id==='KGC-SEED-DRAFT')!};}
async function approveDraft(s:ReturnType<typeof setup>){let w=(await s.service.loadKnowledgeWorkspace()).workspace!;let c=s.change(w);w=(await s.service.submitKnowledgeChange({...s.request(w),changeId:c.id,revision:c.revision})).workspace;c=s.change(w);w=(await s.service.reviewKnowledgeChange({...s.request(w,'KG-REVIEWER'),changeId:c.id,revision:c.revision,submission:1,approved:true,opinion:''})).workspace;return w;}
describe('知识编辑、审核与版本流程',()=>{
  it('送审和审核不改变发布库，单独发布仅合入选中变更',async()=>{const s=setup();const w=await approveDraft(s),c=s.change(w);expect(w.currentVersionId).toBe('KGV-SEED-2');const r=await s.service.publishKnowledgeChange({...s.request(w,'KG-REVIEWER'),changeId:c.id,revision:c.revision});expect(r.workspace.versions).toHaveLength(3);expect(r.workspace.changes.find(c=>c.id==='KGC-SEED-PENDING')!.state).toBe('PENDING');expect(r.workspace.versions[2].entities.find(e=>e.id==='KGE-OPERATION')!.description).toContain('操作时间');expect(r.workspace.versions[2].entities.find(e=>e.id==='KGE-ANTENNA')!.source).not.toContain('天线检查记录样例');});
  it('新实体和关系在同单保存后使用服务分配的稳定 ID',async()=>{const s=setup(),w=(await s.service.loadKnowledgeWorkspace()).workspace!;const entity={...knowledgeClone(w.versions[1].entities[0]),id:'new:e',name:'新增型号知识'};const relation={...knowledgeClone(w.versions[1].relations[0]),id:'new:r',head:'new:e'};const r=await s.service.saveKnowledgeChange({...s.request(w),changeId:null,revision:null,draft:{summary:'新增关联',baseVersionId:w.currentVersionId,entities:[entity],relations:[relation]}});const c=r.workspace.changes.find(c=>c.id===r.entityId)!;expect(c.content.entities[0].id).toMatch(/^KGE-/);expect(c.content.relations[0].head).toBe(c.content.entities[0].id);const again=await s.service.saveKnowledgeChange({...s.request(r.workspace),changeId:c.id,revision:c.revision,draft:c.content});expect(again.changed).toBe(false);expect(again.workspace.changes.find(x=>x.id===c.id)!.revision).toBe(1);expect(s.storage.writes).toBe(1);});
  it('驳回必填理由，修改重提保留上一送审内容',async()=>{const s=setup();let w=(await s.service.loadKnowledgeWorkspace()).workspace!;let c=w.changes.find(c=>c.state==='PENDING')!;await expect(s.service.reviewKnowledgeChange({...s.request(w,'KG-REVIEWER'),changeId:c.id,revision:1,submission:1,approved:false,opinion:'  '})).rejects.toThrow('驳回');w=(await s.service.reviewKnowledgeChange({...s.request(w,'KG-REVIEWER'),changeId:c.id,revision:1,submission:1,approved:false,opinion:'来源需补充'})).workspace;c=w.changes.find(x=>x.id===c.id)!;const original=knowledgeClone(c.submissions[0].content),draft=knowledgeClone(c.content);draft.entities[0].source='已补充教学来源';w=(await s.service.saveKnowledgeChange({...s.request(w),changeId:c.id,revision:1,draft})).workspace;c=w.changes.find(x=>x.id===c.id)!;w=(await s.service.submitKnowledgeChange({...s.request(w),changeId:c.id,revision:2})).workspace;c=w.changes.find(x=>x.id===c.id)!;expect(c.submissions).toHaveLength(2);expect(c.submissions[0].content).toEqual(original);expect(c.submissions[0].outcome).toBe('REJECTED');expect(c.submissions[1].content.entities[0].source).toContain('已补充');});
  it('作者撤回后恢复草稿，送审历史保留',async()=>{const s=setup(),w=(await s.service.loadKnowledgeWorkspace()).workspace!,c=w.changes.find(c=>c.state==='PENDING')!;const r=await s.service.withdrawKnowledgeChange({...s.request(w),changeId:c.id,revision:1});const next=r.workspace.changes.find(x=>x.id===c.id)!;expect(next.state).toBe('DRAFT');expect(next.submissions[0].outcome).toBe('WITHDRAWN');});
  it('服务直接调用也禁止作者自审、编辑人发布与未知身份',async()=>{const s=setup(),w=(await s.service.loadKnowledgeWorkspace()).workspace!,c=w.changes.find(c=>c.state==='PENDING')!;await expect(s.service.reviewKnowledgeChange({...s.request(w),changeId:c.id,revision:1,submission:1,approved:true,opinion:''})).rejects.toMatchObject({code:'KNOWLEDGE_FORBIDDEN'});await expect(s.service.publishKnowledgeChange({...s.request(w),changeId:c.id,revision:1})).rejects.toMatchObject({code:'KNOWLEDGE_FORBIDDEN'});await expect(s.service.resetKnowledgeWorkspace(s.request(w,'任意身份'))).rejects.toMatchObject({code:'KNOWLEDGE_FORBIDDEN'});expect(s.storage.writes).toBe(0);});
  it('审核人不能改送审内容，待审核单不能再保存',async()=>{const s=setup(),w=(await s.service.loadKnowledgeWorkspace()).workspace!,c=w.changes.find(c=>c.state==='PENDING')!;for(const actor of ['KG-EDITOR','KG-REVIEWER'])await expect(s.service.saveKnowledgeChange({...s.request(w,actor),changeId:c.id,revision:1,draft:c.content})).rejects.toBeDefined();expect(s.storage.writes).toBe(0);});
  it('审核修订和送审编号不符时拒绝，保留原状态',async()=>{const s=setup(),w=(await s.service.loadKnowledgeWorkspace()).workspace!,c=w.changes.find(c=>c.state==='PENDING')!;for(const [revision,submission] of [[2,1],[1,2]])await expect(s.service.reviewKnowledgeChange({...s.request(w,'KG-REVIEWER'),changeId:c.id,revision,submission,approved:true,opinion:''})).rejects.toMatchObject({code:'KNOWLEDGE_CONFLICT'});expect(s.storage.writes).toBe(0);});
  it('完整回滚恢复父版内容，创建新版本且可再次回滚',async()=>{const s=setup(),w=(await s.service.loadKnowledgeWorkspace()).workspace!;let r=await s.service.rollbackKnowledgeVersion({...s.request(w,'KG-REVIEWER'),versionId:w.currentVersionId,reason:'恢复前版演示'});expect(r.workspace.versions[2].entities).toEqual(w.versions[0].entities);expect(r.workspace.versions[2].parentId).toBe(w.currentVersionId);expect(r.workspace.versions[2].restoredFromVersionId).toBe(w.versions[0].id);r=await s.service.rollbackKnowledgeVersion({...s.request(r.workspace,'KG-REVIEWER'),versionId:r.workspace.currentVersionId,reason:'恢复刚才内容'});expect(r.workspace.versions[3].entities).toEqual(w.versions[1].entities);expect(r.workspace.logs.filter(l=>l.action==='ROLLBACK')).toHaveLength(2);});
  it('回滚拒绝空原因、错误当前版与任意历史版',async()=>{const s=setup(),w=(await s.service.loadKnowledgeWorkspace()).workspace!;for(const [versionId,reason] of [[w.currentVersionId,''],[w.versions[0].id,'错误目标']])await expect(s.service.rollbackKnowledgeVersion({...s.request(w,'KG-REVIEWER'),versionId,reason})).rejects.toBeDefined();expect(s.storage.writes).toBe(0);});
  it('发布后旧基线草稿、待审核和已审核单都不能继续操作',async()=>{const s=setup();let w=await approveDraft(s);const approved=s.change(w);const r=await s.service.rollbackKnowledgeVersion({...s.request(w,'KG-REVIEWER'),versionId:w.currentVersionId,reason:'变更基线'});w=r.workspace;await expect(s.service.publishKnowledgeChange({...s.request(w,'KG-REVIEWER'),changeId:approved.id,revision:approved.revision})).rejects.toMatchObject({code:'KNOWLEDGE_STALE'});await expect(s.service.reviewKnowledgeChange({...s.request(w,'KG-REVIEWER'),changeId:'KGC-SEED-PENDING',revision:1,submission:1,approved:true,opinion:''})).rejects.toMatchObject({code:'KNOWLEDGE_STALE'});await expect(s.service.saveKnowledgeChange({...s.request(w),changeId:null,revision:null,draft:approved.content})).rejects.toMatchObject({code:'KNOWLEDGE_STALE'});});
  it('保存成功请求可幂等重试，内容不同不能重用 ID',async()=>{const s=setup(),w=(await s.service.loadKnowledgeWorkspace()).workspace!,c=s.change(w),draft=knowledgeClone(c.content);draft.summary='新的摘要';const request={...s.request(w),changeId:c.id,revision:1,draft};const first=await s.service.saveKnowledgeChange(request);const again=await s.service.saveKnowledgeChange(request);expect(again.entityId).toBe(first.entityId);expect(s.storage.writes).toBe(1);await expect(s.service.saveKnowledgeChange({...request,draft:{...draft,summary:'另一内容'}})).rejects.toMatchObject({code:'KNOWLEDGE_REQUEST_CONFLICT'});});
  it('发布和回滚重试不重复生成版本或日志',async()=>{const s=setup(),w=await approveDraft(s),c=s.change(w);const request={...s.request(w,'KG-REVIEWER'),changeId:c.id,revision:c.revision};const first=await s.service.publishKnowledgeChange(request),again=await s.service.publishKnowledgeChange(request);expect(again.workspace.versions).toHaveLength(first.workspace.versions.length);const r={...s.request(again.workspace,'KG-REVIEWER'),versionId:again.workspace.currentVersionId,reason:'测试'};const back=await s.service.rollbackKnowledgeVersion(r),replay=await s.service.rollbackKnowledgeVersion(r);expect(replay.workspace.logs).toHaveLength(back.workspace.logs.length);});
  it('保存失败保留旧版本和修订，同请求可以重试成功',async()=>{const s=setup(),w=(await s.service.loadKnowledgeWorkspace()).workspace!,c=s.change(w),draft=knowledgeClone(c.content);draft.summary='失败保留';const r={...s.request(w),changeId:c.id,revision:1,draft};s.storage.failWrite=true;await expect(s.service.saveKnowledgeChange(r)).rejects.toMatchObject({code:'KNOWLEDGE_WRITE_FAILED'});s.storage.failWrite=false;expect((await s.service.loadKnowledgeWorkspace()).workspace).toEqual(w);expect((await s.service.saveKnowledgeChange(r)).workspace.changes.find(x=>x.id===c.id)!.revision).toBe(2);});
  it('发布失败不移动指针或留下版本/日志，成功后才提交',async()=>{const s=setup(),w=await approveDraft(s),c=s.change(w);s.storage.failWrite=true;const r={...s.request(w,'KG-REVIEWER'),changeId:c.id,revision:c.revision};await expect(s.service.publishKnowledgeChange(r)).rejects.toBeDefined();expect((await s.service.loadKnowledgeWorkspace()).workspace).toEqual(w);s.storage.failWrite=false;expect((await s.service.publishKnowledgeChange(r)).workspace.versions).toHaveLength(3);});
  it('已保存实体类型/分类、关系端点和权重必须合法',async()=>{for(const invalid of ['type','endpoint','weight'] as const){const s=setup(),w=(await s.service.loadKnowledgeWorkspace()).workspace!,c=s.change(w),draft=knowledgeClone(c.content);if(invalid==='type')draft.entities[0].type='Component';else{draft.relations=[knowledgeClone(w.versions[1].relations[0])];if(invalid==='endpoint')draft.relations[0].tail='missing';else draft.relations[0].weight=Number.NaN;}await expect(s.service.saveKnowledgeChange({...s.request(w),changeId:c.id,revision:1,draft})).rejects.toBeDefined();}});
});

describe('知识 store 未保存与查询保护',()=>{
  it('回滚原因离开前必须明确处理，取消时保留输入',async()=>{setActivePinia(createPinia());authorizeStore('kg_editor');const store=useKnowledgeStore();store.rollbackReason='尚未确认的回滚原因';const first=store.allowLeave();store.answer('cancel');expect(await first).toBe(false);expect(store.dirty).toBe(true);const second=store.allowLeave();store.answer('save');expect(await second).toBe(true);expect(store.rollbackReason).toBe('');});
  async function start(){setActivePinia(createPinia());authorizeStore('kg_editor');const s=setup();for(const key of Object.keys(s.service) as (keyof typeof s.service)[])vi.spyOn(previewService,key).mockImplementation(s.service[key] as never);const store=useKnowledgeStore();await store.load();return {store,s};}
  it('统一退出前可取消或保存草稿后继续',async()=>{const {store}=await start();const auth=authorizeStore('kg_editor');vi.spyOn(previewService,'logout').mockResolvedValue();auth.registerLeave(()=>store.allowLeave(false,true),()=>store.dirty);auth.registerCleaner(store.clearForSession);await store.openChange(store.workspace!.changes.find(c=>c.id==='KGC-SEED-DRAFT')!);store.draft!.summary='保存后换身份';let choice=auth.leaveSession();store.answer('cancel');expect(await choice).toBe(false);expect(store.actorId).toBe('KG-EDITOR');expect(store.dirty).toBe(true);choice=auth.leaveSession();store.answer('save');expect(await choice).toBe(true);expect(store.workspace).toBeNull();expect(store.dirty).toBe(false);authorizeStore('kg_reviewer');await store.load();expect(store.actorId).toBe('KG-REVIEWER');expect(store.workspace!.changes.find(c=>c.id==='KGC-SEED-DRAFT')!.content.summary).toBe('保存后换身份');});
  it('保存失败不离开、不丢输入',async()=>{const {store,s}=await start();await store.openChange(store.workspace!.changes.find(c=>c.id==='KGC-SEED-DRAFT')!);store.draft!.summary='仍需保留';s.storage.failWrite=true;const leaving=store.allowLeave();store.answer('save');expect(await leaving).toBe(false);expect(store.draft!.summary).toBe('仍需保留');expect(store.dirty).toBe(true);});
  it('审核意见离开只会放弃或继续，不冒充执行审核',async()=>{const {store,s}=await start();authorizeStore('kg_reviewer');await store.openChange(store.workspace!.changes.find(c=>c.state==='PENDING')!);store.opinion='未提交的意见';const leaving=store.allowLeave();expect(store.decision!.saveLabel).toBe('放弃意见并继续');store.answer('save');expect(await leaving).toBe(true);expect(store.change!.state).toBe('PENDING');expect(s.storage.writes).toBe(0);});
  it('迟到搜索不能覆盖新搜索结果',async()=>{const {store}=await start();let done!:(v:Awaited<ReturnType<typeof previewService.searchKnowledge>>)=>void;vi.spyOn(previewService,'searchKnowledge').mockImplementationOnce(()=>new Promise(resolve=>{done=resolve;}));store.query='旧请求';const old=store.refreshBrowse();store.query='功放';await store.refreshBrowse();const total=store.search!.total;done({versionId:store.current!.id,items:[],total:999,page:1,similar:[],code:0});await old;expect(store.search!.total).toBe(total);});
  it('焦点刷新发现外部发布时保留未保存表单与原 revision',async()=>{const {store,s}=await start();await store.openChange(store.workspace!.changes.find(c=>c.id==='KGC-SEED-DRAFT')!);store.draft!.summary='本地输入';const before=store.workspace!.revision;await s.service.rollbackKnowledgeVersion({...s.request(store.workspace!,'KG-REVIEWER'),versionId:store.current!.id,reason:'外部变化'});await store.load();expect(store.workspace!.revision).toBe(before);expect(store.draft!.summary).toBe('本地输入');expect(store.notice).toContain('已变化');expect(await store.saveDraft()).toBe(false);});
});

// 步骤走真实 Mock 写入与版本流程，不在测试中伪造已发布状态。
describe('工作原理步骤版本流程', () => {
  const steps = { steps: [{ title: '新版输入', description: '教学说明' }, { title: '新版输出', description: '' }] };
  async function saveFlow(s: ReturnType<typeof setup>, value: typeof steps | null) {
    const w = (await s.service.loadKnowledgeWorkspace()).workspace!;
    const entity = knowledgeClone(w.versions.at(-1)!.entities.find(e => e.id === 'KGE-PRINCIPLE')!); entity.principleFlow = value;
    return s.service.saveKnowledgeChange({ ...s.request(w), changeId: null, revision: null,
      draft: { summary: '维护原理步骤', baseVersionId: w.currentVersionId, entities: [entity], relations: [] } });
  }
  async function release(s: ReturnType<typeof setup>, w: KnowledgeWorkspace, id: string) {
    const c = w.changes.find(c => c.id === id)!;
    w = (await s.service.submitKnowledgeChange({ ...s.request(w), changeId: id, revision: c.revision })).workspace;
    w = (await s.service.reviewKnowledgeChange({ ...s.request(w, 'KG-REVIEWER'), changeId: id, revision: c.revision, submission: 1, approved: true, opinion: '' })).workspace;
    return (await s.service.publishKnowledgeChange({ ...s.request(w, 'KG-REVIEWER'), changeId: id, revision: c.revision })).workspace;
  }
  it('保存与审核不改变设备图，发布后步骤冻结；回滚恢复无字段的旧版本', async () => {
    const s = setup(), initial = (await s.service.loadKnowledgeWorkspace()).workspace!, baseline = knowledgeClone(initial.versions);
    const saved = await saveFlow(s, knowledgeClone(steps)); let w = saved.workspace;
    const id = saved.entityId, c = w.changes.find(c => c.id === id)!;
    expect((await s.service.getDeviceKnowledge({ versionId: w.currentVersionId, modelId: 'DM-0001' })).items.find(e => e.entity.id === 'KGE-PRINCIPLE')!.entity.principleFlow).toBeUndefined();
    w = (await s.service.submitKnowledgeChange({ ...s.request(w), changeId: id, revision: c.revision })).workspace;
    expect(w.changes.find(c => c.id === id)!.submissions[0].content.entities[0].principleFlow).toEqual(steps);
    await expect(s.service.saveKnowledgeChange({ ...s.request(w), changeId: id, revision: c.revision, draft: c.content })).rejects.toBeDefined();
    w = (await s.service.reviewKnowledgeChange({ ...s.request(w, 'KG-REVIEWER'), changeId: id, revision: c.revision, submission: 1, approved: true, opinion: '' })).workspace;
    expect(w.currentVersionId).toBe(initial.currentVersionId);
    w = (await s.service.publishKnowledgeChange({ ...s.request(w, 'KG-REVIEWER'), changeId: id, revision: c.revision })).workspace;
    expect((await s.service.getKnowledgeEntity({ versionId: w.currentVersionId, entityId: 'KGE-PRINCIPLE' })).entity.principleFlow).toEqual(steps);
    expect(w.versions.slice(0, 2)).toEqual(baseline);
    w = (await s.service.rollbackKnowledgeVersion({ ...s.request(w, 'KG-REVIEWER'), versionId: w.currentVersionId, reason: '恢复原示例' })).workspace;
    expect(w.versions.at(-1)!.entities.find(e => e.id === 'KGE-PRINCIPLE')).not.toHaveProperty('principleFlow');
    expect(w.changes.find(c => c.id === id)!.submissions[0].content.entities[0].principleFlow).toEqual(steps);
  });
  it('移除流程需要单独发布，回滚清除版本恢复上一版有序步骤', async () => {
    const s = setup(), first = await saveFlow(s, knowledgeClone(steps)); let w = await release(s, first.workspace, first.entityId);
    const published = w.currentVersionId, clear = await saveFlow(s, null);
    expect(clear.workspace.currentVersionId).toBe(published);
    w = await release(s, clear.workspace, clear.entityId);
    expect(w.versions.at(-1)!.entities.find(e => e.id === 'KGE-PRINCIPLE')!.principleFlow).toBeNull();
    w = (await s.service.rollbackKnowledgeVersion({ ...s.request(w, 'KG-REVIEWER'), versionId: w.currentVersionId, reason: '恢复步骤' })).workspace;
    expect(w.versions.at(-1)!.entities.find(e => e.id === 'KGE-PRINCIPLE')!.principleFlow).toEqual(steps);
  });
  it('非法步骤保存被拒绝，原记录与发布指针不变', async () => {
    const s = setup(); await saveFlow(s, knowledgeClone(steps)); const before = [...s.storage.entries], writes = s.storage.writes;
    await expect(saveFlow(s, { steps: [{ title: '', description: '' }] })).rejects.toMatchObject({ code: 'KNOWLEDGE_VALIDATION' });
    expect([...s.storage.entries]).toEqual(before); expect(s.storage.writes).toBe(writes);
  });
  it('步骤改变触发未保存保护，取消与保存失败均保留原步骤输入', async () => {
    setActivePinia(createPinia()); authorizeStore('kg_editor'); const s = setup();
    for (const key of Object.keys(s.service) as (keyof typeof s.service)[]) vi.spyOn(previewService, key).mockImplementation(s.service[key] as never);
    const store = useKnowledgeStore(); await store.load(); await store.newChange(store.current!.entities.find(e => e.id === 'KGE-PRINCIPLE'));
    store.draft!.summary = '维护步骤'; store.draft!.entities[0].principleFlow = knowledgeClone(steps);
    let leaving = store.allowLeave(); store.answer('cancel'); expect(await leaving).toBe(false);
    s.storage.failWrite = true; leaving = store.allowLeave(); store.answer('save'); expect(await leaving).toBe(false);
    expect(store.draft!.entities[0].principleFlow).toEqual(steps); expect(store.dirtyDraft).toBe(true);
    s.storage.failWrite = false; expect(await store.saveDraft()).toBe(true); expect(store.dirtyDraft).toBe(false);
  });
});
