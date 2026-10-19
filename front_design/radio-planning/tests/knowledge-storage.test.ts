import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_STORAGE_KEY, RESOURCE_STORAGE_KEY, PLANNING_STORAGE_KEY, DIAGNOSIS_STORAGE_KEY } from '../src/config/demo';
import { createKnowledgeMock } from '../src/services/knowledge-mock';
import { initialKnowledgeWorkspace } from '../src/mocks/knowledge-presets';
import { readKnowledge, validateKnowledgeWorkspace, writeKnowledge } from '../src/services/knowledge-storage';
import { TestStorage } from './helpers/storage';

describe('知识独立存储与完整性',()=>{
  // 合法旧身份先按 v1 校验，再补元数据；不接受冒名历史记录。
  it('v1 原身份合法才可内存兼容，v2 快照缺失或 ID 不符拒绝',()=>{const s=new TestStorage(),w=initialKnowledgeWorkspace();w.schemaVersion=1;delete w.identitySnapshots;s.entries.set(KNOWLEDGE_STORAGE_KEY,JSON.stringify(w));expect(readKnowledge(s).schemaVersion).toBe(2);w.versions[0].actorId='unknown';s.entries.set(KNOWLEDGE_STORAGE_KEY,JSON.stringify(w));expect(()=>readKnowledge(s)).toThrow();const current=initialKnowledgeWorkspace();current.identitySnapshots![0].id='wrong';expect(()=>validateKnowledgeWorkspace(current)).toThrow();current.identitySnapshots=[];expect(()=>validateKnowledgeWorkspace(current)).toThrow();expect(s.writes).toBe(0);});
  it('空读取确定性初始数据但不写入，返回数据不能污染下次读取',()=>{const s=new TestStorage(),w=readKnowledge(s);validateKnowledgeWorkspace(w);w.versions[0].entities[0].name='外部修改';expect(readKnowledge(s).versions[0].entities[0].name).not.toBe('外部修改');expect(s.writes).toBe(0);});
  it('完整记录保存/读取往返',()=>{const s=new TestStorage(),w=initialKnowledgeWorkspace();writeKnowledge(s,w);expect(readKnowledge(s)).toEqual(w);expect(s.writeHistory).toEqual([KNOWLEDGE_STORAGE_KEY]);});
  it('坏 JSON 和版本不兼容不覆盖原数据，旧资料仍能只读展示',async()=>{for(const text of ['{bad',JSON.stringify({...initialKnowledgeWorkspace(),schemaVersion:9})]){const s=new TestStorage();s.entries.set(KNOWLEDGE_STORAGE_KEY,text);const loaded=await createKnowledgeMock(()=>s).loadKnowledgeWorkspace();expect(loaded.workspace).toBeNull();expect(loaded.error).toBeTruthy();expect(loaded.legacy.entities).toHaveLength(9);expect(s.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(text);expect(s.writes).toBe(0);}});
  it('拒绝基线篡改、当前指针错误、重复 ID 与悬空端点',()=>{const edits=[(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.versions[0].entities[0].name='偷偷改动';},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.currentVersionId='missing';},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.changes[1].id=w.changes[0].id;},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.changes[1].content.relations.push({...w.versions[1].relations[0],id:'new-edge',tail:'missing'});}];for(const edit of edits){const s=new TestStorage(),w=initialKnowledgeWorkspace();edit(w);s.entries.set(KNOWLEDGE_STORAGE_KEY,JSON.stringify(w));expect(()=>readKnowledge(s)).toThrow('损坏');}});
  it('拒绝自审/伪造发布状态/送审内容替换/回执悬空',()=>{const edits=[(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.changes[0].submissions[0].review!.actorId='KG-EDITOR';},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.changes[1].state='PUBLISHED';},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.changes[2].content.summary='审核期间偷改';},(w:ReturnType<typeof initialKnowledgeWorkspace>)=>{w.receipts.push({requestId:'x',signature:'x',entityId:'missing',changed:true});}];for(const edit of edits){const w=initialKnowledgeWorkspace();edit(w);expect(()=>validateKnowledgeWorkspace(w)).toThrow();}});
  it('读取权限失败明确报错，不能通过重置绕过',async()=>{const s=new TestStorage();s.failRead=true;const service=createKnowledgeMock(()=>s);expect((await service.loadKnowledgeWorkspace()).error).toContain('读取失败');await expect(service.resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:null,requestId:'r'})).rejects.toMatchObject({code:'KNOWLEDGE_READ_FAILED'});expect(s.writes).toBe(0);});
  it('审核人可显式重置坏记录，只改知识键并记日志',async()=>{const s=new TestStorage();s.entries.set(KNOWLEDGE_STORAGE_KEY,'bad');for(const key of [RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY,DIAGNOSIS_STORAGE_KEY,'other'])s.entries.set(key,'keep');const result=await createKnowledgeMock(()=>s).resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:null,requestId:'reset'});expect(result.workspace.logs.at(-1)!.action).toBe('RESET');for(const key of [RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY,DIAGNOSIS_STORAGE_KEY,'other'])expect(s.entries.get(key)).toBe('keep');expect(s.writeHistory).toEqual([KNOWLEDGE_STORAGE_KEY]);});
  it('重置失败保留损坏记录和其他键，不伪装恢复成功',async()=>{const s=new TestStorage();s.entries.set(KNOWLEDGE_STORAGE_KEY,'bad');s.failWrite=true;await expect(createKnowledgeMock(()=>s).resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:null,requestId:'r'})).rejects.toMatchObject({code:'KNOWLEDGE_WRITE_FAILED'});expect(s.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe('bad');});
  it('有效 revision 冲突拒绝覆盖，重置同请求幂等',async()=>{const s=new TestStorage(),service=createKnowledgeMock(()=>s),w=readKnowledge(s);await expect(service.resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:null,requestId:'wrong'})).rejects.toMatchObject({code:'KNOWLEDGE_CONFLICT'});const r={actorId:'KG-REVIEWER',baseRevision:w.revision,requestId:'reset'};const first=await service.resetKnowledgeWorkspace(r);expect((await service.resetKnowledgeWorkspace(r)).workspace.revision).toBe(first.workspace.revision);expect(s.writes).toBe(1);await expect(service.resetKnowledgeWorkspace({...r,requestId:'old'})).rejects.toMatchObject({code:'KNOWLEDGE_CONFLICT'});});
});

describe('工作原理持久化兼容', () => {
  const flow = { steps: [{ title: '输入', description: '' }, { title: '输出', description: '教学说明' }] };
  async function saved() {
    const storage = new TestStorage(), service = createKnowledgeMock(() => storage), initial = readKnowledge(storage);
    const entity = { ...initial.versions[1].entities.find(e => e.id === 'KGE-PRINCIPLE')!, principleFlow: flow };
    const result = await service.saveKnowledgeChange({ actorId: 'KG-EDITOR', baseRevision: initial.revision, requestId: 'flow-save', changeId: null, revision: null,
      draft: { summary: '维护流程', baseVersionId: initial.currentVersionId, entities: [entity], relations: [] } });
    return { storage, initial, result };
  }
  it('已有记录缺少流程字段仍合法，读取不回填字段或改写字节', () => {
    const storage = new TestStorage(), initial = initialKnowledgeWorkspace(), bytes = JSON.stringify(initial);
    storage.entries.set(KNOWLEDGE_STORAGE_KEY, bytes); const loaded = readKnowledge(storage);
    expect(loaded).toEqual(initial); expect(storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(bytes); expect(storage.writes).toBe(0);
    expect(loaded.versions.every(v => v.entities.every(e => !Object.hasOwn(e, 'principleFlow')))).toBe(true);
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
