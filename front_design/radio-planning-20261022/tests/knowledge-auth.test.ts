import { afterEach,describe,it,expect,vi } from 'vitest';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { authFixture } from './helpers/auth';
import { readSystem,writeSystem } from '../src/services/system-storage';
import { readKnowledge } from '../src/services/knowledge-storage';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { KNOWLEDGE_STORAGE_KEY } from '../src/config/demo';
import { knowledgeClone } from '../src/services/knowledge-validation';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { createAccessService } from '../src/services/access';
import { DEMO_PASSWORD } from '../src/mocks/system-presets';
import { useAuthStore } from '../src/stores/auth';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { TestStorage } from './helpers/storage';

let pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();});

// 使用真实登录与公开服务创建本人变更，覆盖身份校验而非伪造请求结果。
async function submitOwnChange(s:ReturnType<typeof authFixture>,actorId:string){
  let w=(await s.service.loadKnowledgeWorkspace()).workspace!;
  const draft={...knowledgeClone(w.changes.find(c=>c.state==='DRAFT')!.content),summary:'全流程演示变更'};
  const saved=await s.service.saveKnowledgeChange({actorId,baseRevision:w.revision,requestId:crypto.randomUUID(),changeId:null,revision:null,draft});
  w=saved.workspace;const c=w.changes.find(c=>c.id===saved.entityId)!;
  w=(await s.service.submitKnowledgeChange({actorId,baseRevision:w.revision,requestId:crypto.randomUUID(),changeId:c.id,revision:c.revision})).workspace;
  return {workspace:w,changeId:c.id};
}
describe('统一账号与知识历史兼容',()=>{
  // 当前账号显式重置旧格式，不执行内存升级。
  it('旧知识格式提示重置，审核人重置后使用当前基线',async()=>{
    const s=authFixture(),old=initialKnowledgeWorkspace();old.schemaVersion=1;s.storage.entries.set(KNOWLEDGE_STORAGE_KEY,JSON.stringify(old));await s.login('kg_reviewer');
    const loaded=await s.service.loadKnowledgeWorkspace();expect(loaded.workspace).toBeNull();expect(loaded.error).toContain('版本已更新');
    const result=await s.service.resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:null,requestId:'new-baseline'});
    expect(result.workspace.schemaVersion).toBe(initialKnowledgeWorkspace().schemaVersion);expect(readKnowledge(s.storage)).toEqual(result.workspace);
  });
  it('新增账号可编辑，伪造旧 actorId 拒绝，改名停用换角色不改变历史',async()=>{
    const s=authFixture();await s.login();const created=await s.service.saveSystemAccount({...s.mutation(),account:{id:null,username:'new_editor',name:'原编辑名',department:'教研',roleId:'ROLE-KG-EDITOR'}});
    await s.service.logout();await s.login('new_editor');let w=(await s.service.loadKnowledgeWorkspace()).workspace!;
    const draft={...knowledgeClone(w.changes.find(c=>c.state==='DRAFT')!.content),summary:'新增作者草稿'};
    await expect(s.service.saveKnowledgeChange({actorId:'KG-EDITOR',baseRevision:w.revision,requestId:'forged',changeId:null,revision:null,draft})).rejects.toMatchObject({code:'FORBIDDEN'});
    const saved=await s.service.saveKnowledgeChange({actorId:created.objectId,baseRevision:w.revision,requestId:'new-author',changeId:null,revision:null,draft});w=saved.workspace;
    const snapshot=w.identitySnapshots!.find(i=>i.key==='change:'+saved.entityId)!;expect(snapshot).toMatchObject({id:created.objectId,name:'原编辑名',role:'EDITOR'});
    const system=readSystem(s.storage),account=system.accounts.find(a=>a.id===created.objectId)!;Object.assign(account,{name:'改名后',enabled:false,roleId:'ROLE-KG-REVIEWER'});writeSystem(s.storage,system);
    const history=readKnowledge(s.storage);expect(history.identitySnapshots!.find(i=>i.key===snapshot.key)).toEqual(snapshot);expect(history.changes.find(c=>c.id===saved.entityId)?.authorId).toBe(created.objectId);
  });
  it('作者改成审核角色仍不能自审，另一审核账号可审且保存正确快照',async()=>{
    const s=authFixture();await s.login('kg_editor');let w=(await s.service.loadKnowledgeWorkspace()).workspace!;const c=w.changes.find(c=>c.state==='DRAFT')!;
    w=(await s.service.submitKnowledgeChange({actorId:'KG-EDITOR',baseRevision:w.revision,requestId:'submit',changeId:c.id,revision:c.revision})).workspace;
    const system=readSystem(s.storage);system.accounts.find(a=>a.id==='KG-EDITOR')!.roleId='ROLE-KG-REVIEWER';writeSystem(s.storage,system);
    const req={actorId:'KG-EDITOR',baseRevision:w.revision,requestId:'self-review',changeId:c.id,revision:c.revision,submission:1,approved:true,opinion:''};
    await expect(s.service.reviewKnowledgeChange(req)).rejects.toBeDefined();
    await s.service.logout();await s.login('kg_reviewer');const result=await s.service.reviewKnowledgeChange({...req,actorId:'KG-REVIEWER',requestId:'other-review'});
    expect(result.workspace.changes.find(x=>x.id===c.id)?.state).toBe('APPROVED');
    expect(result.workspace.identitySnapshots!.find(i=>i.key==='review:'+c.id+':1')?.id).toBe('KG-REVIEWER');
  });
  it('admin 可新建送审、自审、单独发布并回滚，完整保存身份历史',async()=>{
    const s=authFixture();await s.login();const submitted=await submitOwnChange(s,'SYS-ADMIN');let w=submitted.workspace;
    const c=w.changes.find(c=>c.id===submitted.changeId)!,baseline=knowledgeClone(w.versions.at(-1)!);
    w=(await s.service.reviewKnowledgeChange({actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'admin-review',changeId:c.id,revision:c.revision,submission:1,approved:true,opinion:'演示自审'})).workspace;
    expect(w.changes.find(x=>x.id===c.id)?.state).toBe('APPROVED');expect(w.currentVersionId).toBe(baseline.id);
    expect(w.identitySnapshots!.find(i=>i.key==='review:'+c.id+':1')).toMatchObject({id:'SYS-ADMIN',roleId:'ROLE-ADMIN',role:'REVIEWER'});
    w=(await s.service.publishKnowledgeChange({actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'admin-publish',changeId:c.id,revision:c.revision})).workspace;
    expect(w.changes.find(x=>x.id===c.id)?.state).toBe('PUBLISHED');expect(w.versions.at(-1)?.kind).toBe('PUBLISH');
    expect(w.versions.at(-1)?.entities).not.toEqual(baseline.entities);
    w=(await s.service.rollbackKnowledgeVersion({actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'admin-rollback',versionId:w.currentVersionId,reason:'演示恢复上一版'})).workspace;
    expect(w.versions.at(-1)).toMatchObject({kind:'ROLLBACK',entities:baseline.entities,relations:baseline.relations});expect(readKnowledge(s.storage)).toEqual(w);
  });
  it('admin 自审驳回仍要求原因，修改重提后保留每次审核内容',async()=>{
    const s=authFixture();await s.login();const submitted=await submitOwnChange(s,'SYS-ADMIN');let w=submitted.workspace,c=w.changes.find(c=>c.id===submitted.changeId)!;
    const review={actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'admin-reject',changeId:c.id,revision:c.revision,submission:1,approved:false,opinion:''};
    await expect(s.service.reviewKnowledgeChange(review)).rejects.toThrow('驳回');
    w=(await s.service.reviewKnowledgeChange({...review,opinion:'补充说明'})).workspace;c=w.changes.find(x=>x.id===c.id)!;
    const first=knowledgeClone(c.submissions[0]),draft=knowledgeClone(c.content);draft.summary='补充后的演示变更';
    w=(await s.service.saveKnowledgeChange({actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'admin-revise',changeId:c.id,revision:c.revision,draft})).workspace;c=w.changes.find(x=>x.id===c.id)!;
    w=(await s.service.submitKnowledgeChange({actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'admin-resubmit',changeId:c.id,revision:c.revision})).workspace;c=w.changes.find(x=>x.id===c.id)!;
    w=(await s.service.reviewKnowledgeChange({actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'admin-rereview',changeId:c.id,revision:c.revision,submission:2,approved:true,opinion:''})).workspace;
    const history=w.changes.find(x=>x.id===c.id)!;expect(history.submissions[0]).toEqual(first);expect(history.submissions[1].outcome).toBe('APPROVED');expect(history.state).toBe('APPROVED');
  });
  it('同管理员角色的其他账号不能自审，也不能冒用 admin 身份',async()=>{
    const s=authFixture();await s.login();const added=await s.service.saveSystemAccount({...s.mutation(),account:{id:null,username:'another_admin',name:'其他管理员',department:'教学',roleId:'ROLE-ADMIN'}});
    await s.service.logout();await s.login('another_admin');const {workspace:w,changeId}=await submitOwnChange(s,added.objectId),c=w.changes.find(c=>c.id===changeId)!;
    const review={actorId:added.objectId,baseRevision:w.revision,requestId:'other-self-review',changeId,revision:c.revision,submission:1,approved:true,opinion:''},bytes=s.storage.entries.get(KNOWLEDGE_STORAGE_KEY);
    await expect(s.service.reviewKnowledgeChange(review)).rejects.toMatchObject({code:'KNOWLEDGE_FORBIDDEN'});
    await expect(s.service.reviewKnowledgeChange({...review,actorId:'SYS-ADMIN'})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(s.storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(bytes);
  });
  it('admin 换成普通审核角色后不再享有自审例外',async()=>{
    const s=authFixture();await s.login();await s.service.saveSystemAccount({...s.mutation(),account:{id:null,username:'backup_admin',name:'备用管理员',department:'教学',roleId:'ROLE-ADMIN'}});
    const {workspace:w,changeId}=await submitOwnChange(s,'SYS-ADMIN'),c=w.changes.find(c=>c.id===changeId)!;
    const system=readSystem(s.storage);system.accounts.find(a=>a.id==='SYS-ADMIN')!.roleId='ROLE-KG-REVIEWER';writeSystem(s.storage,system);
    await expect(s.service.reviewKnowledgeChange({actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'changed-role-review',changeId,revision:c.revision,submission:1,approved:true,opinion:''})).rejects.toMatchObject({code:'KNOWLEDGE_FORBIDDEN'});
  });
});

describe('知识写入期间权限变化',()=>{
  // 两个独立会话共享业务数据，真实访问包装在写入后发现角色权限变化。
  async function start(){
    pinia=createPinia();setActivePinia(pinia);const auth=useAuthStore(),s=authFixture();s.bind();
    await previewService.login({username:'kg_editor',password:DEMO_PASSWORD});
    const newSession=new TestStorage(),adminRaw=createMockService(()=>s.storage,()=>newSession);
    const admin=createAccessService(()=>adminRaw,null,()=>{});await admin.login({username:'admin',password:DEMO_PASSWORD});
    const store=useKnowledgeStore();await store.load();await store.openChange({id:'KGC-SEED-DRAFT'});store.draft!.summary='权限变化期间保存';
    const revoke=async()=>{const w=readSystem(s.storage),role=w.roles.find(r=>r.id==='ROLE-KG-EDITOR')!;
      await admin.saveSystemRole({baseRevision:w.revision,requestId:crypto.randomUUID(),role:{...role,permissions:role.permissions.filter(p=>p!=='knowledge.edit')}});
    };
    return {auth,s,store,revoke};
  }
  it.each(['保存','保存后送审'] as const)('%s 已受理后失去编辑权限，解除忙状态且不继续旧操作',async action=>{
    const {auth,s,store,revoke}=await start(),generation=auth.generation,save=s.raw.saveKnowledgeReceipt.bind(s.raw);
    const saving=vi.spyOn(s.raw,'saveKnowledgeReceipt').mockImplementation(async request=>{const result=await save(request);await revoke();return result;});
    const submit=vi.spyOn(s.raw,'submitKnowledgeReceipt'),detail=vi.mocked(previewService.getKnowledgeChange);detail.mockClear();
    if(action==='保存')expect(await store.saveDraft()).toBe(true);else await store.submit();
    expect(auth.generation).toBeGreaterThan(generation);expect(auth.can('knowledge.edit')).toBe(false);
    expect(store.busy).toBe(false);expect(store.locked).toBe(false);expect(store.dirtyDraft).toBe(false);expect(store.receiptPending).toBe(true);
    expect(store.notice).toContain('无需重复提交');expect(store.notice).toContain('权限已变化');expect(store.decision).toBeNull();
    expect(saving).toHaveBeenCalledTimes(1);expect(submit).not.toHaveBeenCalled();expect(detail).not.toHaveBeenCalled();
    expect(readKnowledge(s.storage).changes.find(c=>c.id==='KGC-SEED-DRAFT')!.content.summary).toBe('权限变化期间保存');
    expect(await store.saveDraft()).toBe(false);expect(saving).toHaveBeenCalledTimes(1);
    await store.load();expect(store.receiptPending).toBe(false);expect(store.change!.content.summary).toBe('权限变化期间保存');
    expect(await store.allowLeave()).toBe(true);
  });
  it('未受理写入在权限变化后仍解除忙状态并保留输入',async()=>{
    const {auth,s,store,revoke}=await start();
    vi.spyOn(s.raw,'saveKnowledgeReceipt').mockImplementation(async()=>{await revoke();await previewService.getSession();throw new Error('保存暂不可用');});
    expect(await store.saveDraft()).toBe(false);expect(auth.can('knowledge.edit')).toBe(false);
    expect(store.busy).toBe(false);expect(store.locked).toBe(false);expect(store.receiptPending).toBe(false);
    expect(store.dirtyDraft).toBe(true);expect(store.draft!.summary).toBe('权限变化期间保存');expect(store.error).toContain('保存暂不可用');
    expect(readKnowledge(s.storage).changes.find(c=>c.id==='KGC-SEED-DRAFT')!.content.summary).not.toBe('权限变化期间保存');
    const leaving=store.allowLeave();store.answer('cancel');expect(await leaving).toBe(false);
  });
});
