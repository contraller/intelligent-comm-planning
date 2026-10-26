import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_STORAGE_KEY, RESOURCE_STORAGE_KEY, PLANNING_STORAGE_KEY, DIAGNOSIS_STORAGE_KEY } from '../src/config/demo';
import { createKnowledgeMock } from '../src/services/knowledge-mock';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { readKnowledge, validateKnowledgeWorkspace, writeKnowledge } from '../src/services/knowledge-storage';
import { TestStorage } from './helpers/storage';
import { authFixture } from './helpers/auth';
import { readSystem, writeSystem } from '../src/services/system-storage';

// 保存真实 admin 自审记录，再单独验证历史读取与身份快照边界。
async function adminReviewed(){
  const s=authFixture();await s.login();let w=(await s.service.loadKnowledgeWorkspace()).workspace!;
  const draft=structuredClone(w.changes.find(c=>c.state==='DRAFT')!.content);
  const saved=await s.service.saveKnowledgeChange({actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'storage-save',changeId:null,revision:null,draft});w=saved.workspace;
  const c=w.changes.find(c=>c.id===saved.entityId)!;
  w=(await s.service.submitKnowledgeChange({actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'storage-submit',changeId:c.id,revision:c.revision})).workspace;
  w=(await s.service.reviewKnowledgeChange({actorId:'SYS-ADMIN',baseRevision:w.revision,requestId:'storage-review',changeId:c.id,revision:c.revision,submission:1,approved:true,opinion:''})).workspace;
  return {s,workspace:w};
}

describe('内置管理员自审历史',()=>{
  it('自审记录完整往返，admin 改名换角色后仍按原身份快照读取',async()=>{
    const {s,workspace}=await adminReviewed();expect(readKnowledge(s.storage)).toEqual(workspace);
    await s.service.saveSystemAccount({...s.mutation(),account:{id:null,username:'history_admin',name:'备用管理员',department:'教学',roleId:'ROLE-ADMIN'}});
    const system=readSystem(s.storage),admin=system.accounts.find(a=>a.id==='SYS-ADMIN')!;admin.name='改名后的管理员';admin.roleId='ROLE-KG-REVIEWER';writeSystem(s.storage,system);
    expect(readKnowledge(s.storage)).toEqual(workspace);
  });
  it.each([['OTHER-ADMIN','ROLE-ADMIN'],['SYS-ADMIN','ROLE-KG-REVIEWER']])('身份 %s / %s 的自审历史被拒绝且保留原字节',async(actorId,roleId)=>{
    const {s,workspace}=await adminReviewed();
    const bytes=JSON.stringify(workspace).replaceAll('"SYS-ADMIN"',JSON.stringify(actorId)).replaceAll('"ROLE-ADMIN"',JSON.stringify(roleId));
    s.storage.entries.set(KNOWLEDGE_STORAGE_KEY,bytes);const writes=s.storage.writes;
    expect(()=>readKnowledge(s.storage)).toThrow('损坏');expect(s.storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(bytes);expect(s.storage.writes).toBe(writes);
  });
});

describe('知识独立存储与完整性',()=>{
  // 开发预设变更沿用显式重置，不兼容旧基线或触碰其他业务存储。
  it('新预设可往返，上一预设只提示重置且重置后采用新定义关系',async()=>{
    const storage=new TestStorage(),old={...initialKnowledgeWorkspace(),presetVersion:'knowledge-demo-2'},bytes=JSON.stringify(old);
    storage.entries.set(KNOWLEDGE_STORAGE_KEY,bytes);storage.entries.set(RESOURCE_STORAGE_KEY,'原资源');
    expect(()=>readKnowledge(storage)).toThrow('版本已更新');expect(storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(bytes);expect(storage.writes).toBe(0);
    const service=createKnowledgeMock(()=>storage);
    await service.resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:null,requestId:'升级知识预设'});
    const current=readKnowledge(storage);expect(current.presetVersion).toBe('knowledge-demo-3');expect(current.schemaVersion).toBe(3);
    expect(current.versions[1].relations.filter(relation=>relation.type==='definesState')).toHaveLength(4);
    writeKnowledge(storage,current);expect(readKnowledge(storage)).toEqual(current);
    expect(storage.entries.get(RESOURCE_STORAGE_KEY)).toBe('原资源');expect(storage.writeHistory.every(key=>key===KNOWLEDGE_STORAGE_KEY)).toBe(true);
  });
  // 旧格式只提示重置，新格式仍严格核验身份关联。
  it('旧格式不升级，当前快照缺失或身份不符拒绝',()=>{const s=new TestStorage(),w=initialKnowledgeWorkspace();w.schemaVersion=1;s.entries.set(KNOWLEDGE_STORAGE_KEY,JSON.stringify(w));expect(()=>readKnowledge(s)).toThrow('版本已更新');const current=initialKnowledgeWorkspace();current.identitySnapshots![0].id='wrong';expect(()=>validateKnowledgeWorkspace(current)).toThrow();current.identitySnapshots=[];expect(()=>validateKnowledgeWorkspace(current)).toThrow();expect(s.writes).toBe(0);});
  it('空读取确定性初始数据但不写入，返回数据不能污染下次读取',()=>{const s=new TestStorage(),w=readKnowledge(s);validateKnowledgeWorkspace(w);w.versions[0].entities[0].name='外部修改';expect(readKnowledge(s).versions[0].entities[0].name).not.toBe('外部修改');expect(s.writes).toBe(0);});
  it('完整记录保存/读取往返',()=>{const s=new TestStorage(),w=initialKnowledgeWorkspace();writeKnowledge(s,w);expect(readKnowledge(s)).toEqual(w);expect(s.writeHistory).toEqual([KNOWLEDGE_STORAGE_KEY]);});
  it('坏 JSON 和版本不兼容不覆盖原数据，不再提供旧资料预览',async()=>{for(const text of ['{bad',JSON.stringify({...initialKnowledgeWorkspace(),schemaVersion:9})]){const s=new TestStorage();s.entries.set(KNOWLEDGE_STORAGE_KEY,text);const loaded=await createKnowledgeMock(()=>s).loadKnowledgeWorkspace();expect(loaded.workspace).toBeNull();expect(loaded.error).toBeTruthy();expect(loaded).not.toHaveProperty('legacy');expect(s.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(text);expect(s.writes).toBe(0);}});
  it('拒绝基线篡改、当前指针错误、重复 ID 与悬空端点',()=>{const edits=[(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.versions[0].entities[0].name='偷偷改动';},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.currentVersionId='missing';},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.changes[1].id=w.changes[0].id;},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.changes[1].content.relations.push({...w.versions[1].relations[0],id:'new-edge',tail:'missing'});}];for(const edit of edits){const s=new TestStorage(),w=initialKnowledgeWorkspace();edit(w);s.entries.set(KNOWLEDGE_STORAGE_KEY,JSON.stringify(w));expect(()=>readKnowledge(s)).toThrow('损坏');}});
  it('拒绝自审/伪造发布状态/送审内容替换/回执悬空',()=>{const edits=[(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.changes[0].submissions[0].review!.actorId='KG-EDITOR';},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.changes[1].state='PUBLISHED';},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.changes[2].content.summary='审核期间偷改';},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.receipts.push({requestId:'x',signature:'x',entityId:'missing',changed:true});}];for(const edit of edits){const w=initialKnowledgeWorkspace();edit(w);expect(()=>validateKnowledgeWorkspace(w)).toThrow();}});
  it('读取权限失败明确报错，不能通过重置绕过',async()=>{const s=new TestStorage();s.failRead=true;const service=createKnowledgeMock(()=>s);expect((await service.loadKnowledgeWorkspace()).error).toContain('读取失败');await expect(service.resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:null,requestId:'r'})).rejects.toMatchObject({code:'KNOWLEDGE_READ_FAILED'});expect(s.writes).toBe(0);});
  it('审核人可显式重置坏记录，只改知识键并记日志',async()=>{const s=new TestStorage();s.entries.set(KNOWLEDGE_STORAGE_KEY,'bad');for(const key of [RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY,DIAGNOSIS_STORAGE_KEY,'other'])s.entries.set(key,'keep');const result=await createKnowledgeMock(()=>s).resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:null,requestId:'reset'});expect(result.workspace.logs.at(-1)!.action).toBe('RESET');for(const key of [RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY,DIAGNOSIS_STORAGE_KEY,'other'])expect(s.entries.get(key)).toBe('keep');expect(s.writeHistory).toEqual([KNOWLEDGE_STORAGE_KEY]);});
  it('重置失败保留损坏记录和其他键，不伪装恢复成功',async()=>{const s=new TestStorage();s.entries.set(KNOWLEDGE_STORAGE_KEY,'bad');s.failWrite=true;await expect(createKnowledgeMock(()=>s).resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:null,requestId:'r'})).rejects.toMatchObject({code:'KNOWLEDGE_WRITE_FAILED'});expect(s.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe('bad');});
  it('有效 revision 冲突拒绝覆盖，重置同请求幂等',async()=>{const s=new TestStorage(),service=createKnowledgeMock(()=>s),w=readKnowledge(s);await expect(service.resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:null,requestId:'wrong'})).rejects.toMatchObject({code:'KNOWLEDGE_CONFLICT'});const r={actorId:'KG-REVIEWER',baseRevision:w.revision,requestId:'reset'};const first=await service.resetKnowledgeWorkspace(r);expect((await service.resetKnowledgeWorkspace(r)).workspace.revision).toBe(first.workspace.revision);expect(s.writes).toBe(1);await expect(service.resetKnowledgeWorkspace({...r,requestId:'old'})).rejects.toMatchObject({code:'KNOWLEDGE_CONFLICT'});});
});

describe('工作原理持久化', () => {
  const flow = { steps: [{ title: '输入', description: '' }, { title: '输出', description: '教学说明' }] };
  async function saved() {
    const storage = new TestStorage(), service = createKnowledgeMock(() => storage), initial = readKnowledge(storage);
    const entity = { ...initial.versions[1].entities.find(e => e.id === 'KGE-PRINCIPLE')!, principleFlow: flow };
    const result = await service.saveKnowledgeChange({ actorId: 'KG-EDITOR', baseRevision: initial.revision, requestId: 'flow-save', changeId: null, revision: null,
      draft: { summary: '维护流程', baseVersionId: initial.currentVersionId, entities: [entity], relations: [] } });
    return { storage, initial, result };
  }
  it('基线已保存流程，读取不补写或改写字节', () => {
    const storage = new TestStorage(), initial = initialKnowledgeWorkspace(), bytes = JSON.stringify(initial);
    storage.entries.set(KNOWLEDGE_STORAGE_KEY, bytes); const loaded = readKnowledge(storage);
    expect(loaded).toEqual(initial); expect(storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(bytes); expect(storage.writes).toBe(0);
    expect(loaded.versions.every(v => v.entities.find(e=>e.id==='KGE-PRINCIPLE')?.principleFlow?.steps.length===4)).toBe(true);
  });
  it('新流程保存读取往返，原两个完整快照保持不变', async () => {
    const { storage, initial, result } = await saved(), read = readKnowledge(storage);
    expect(read).toEqual(result.workspace);
    expect(read.changes.find(c => c.id === result.entityId)!.content.entities[0].principleFlow).toEqual(flow);
    expect(read.versions).toEqual(initial.versions); expect(storage.writeHistory).toEqual([KNOWLEDGE_STORAGE_KEY]);
  });
  it('坏步骤存储被拒绝并保留原字节，不能静默丢弃坏字段', async () => {
    const { storage, result } = await saved();
    result.workspace.changes.find(c => c.id === result.entityId)!.content.entities[0].principleFlow!.steps[0].title = '';
    const bytes = JSON.stringify(result.workspace); storage.entries.set(KNOWLEDGE_STORAGE_KEY, bytes);
    const writes = storage.writes; expect(() => readKnowledge(storage)).toThrow('损坏');
    expect(storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(bytes); expect(storage.writes).toBe(writes);
  });
});
