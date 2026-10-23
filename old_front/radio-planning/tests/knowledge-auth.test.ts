import { describe,it,expect } from 'vitest';
import { authFixture } from './helpers/auth';
import { readSystem,writeSystem } from '../src/services/system-storage';
import { readKnowledge } from '../src/services/knowledge-storage';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { KNOWLEDGE_STORAGE_KEY } from '../src/config/demo';
import { knowledgeClone } from '../src/services/knowledge-validation';
describe('统一账号与知识历史兼容',()=>{
  it('合法 v1 只在内存升级，写失败不覆盖旧字节，成功后保存 v2',async()=>{
    const s=authFixture(),old=initialKnowledgeWorkspace();old.schemaVersion=1;delete old.identitySnapshots;const bytes=JSON.stringify(old);s.storage.entries.set(KNOWLEDGE_STORAGE_KEY,bytes);await s.login('kg_editor');
    const w=(await s.service.loadKnowledgeWorkspace()).workspace!;expect(w.schemaVersion).toBe(2);expect(s.storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(bytes);expect(w.versions).toEqual(old.versions);
    const c=w.changes.find(c=>c.state==='DRAFT')!,draft=knowledgeClone(c.content);draft.summary='兼容写入';
    const req={actorId:'KG-EDITOR',baseRevision:w.revision,requestId:'v1-upgrade',changeId:c.id,revision:c.revision,draft};
    s.storage.failWriteKeys.add(KNOWLEDGE_STORAGE_KEY);await expect(s.service.saveKnowledgeChange(req)).rejects.toBeDefined();expect(s.storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(bytes);
    s.storage.failWriteKeys.clear();await s.service.saveKnowledgeChange(req);expect(JSON.parse(s.storage.entries.get(KNOWLEDGE_STORAGE_KEY)!).schemaVersion).toBe(2);
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
});
