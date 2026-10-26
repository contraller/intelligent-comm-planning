import { describe, expect, it } from 'vitest';
import { authFixture } from './helpers/auth';
import { createMockService } from '../src/services/mock';
import { KNOWLEDGE_STORAGE_KEY, RESOURCE_STORAGE_KEY, PLANNING_STORAGE_KEY, DIAGNOSIS_STORAGE_KEY } from '../src/config/demo';
import { TestStorage } from './helpers/storage';
import type { KnowledgeWorkspace } from '../src/types/knowledge';
import { projectDeviceKnowledgeSummary } from '../src/services/device-knowledge-summary';

describe('知识发布与既有模块隔离',()=>{
  // 统一账号依次送审/审核/发布，图谱和型号面板仍读取同一版本。
  it('统一登录入口下发布版本联动，历史诊断内容不变',async()=>{const s=authFixture();await s.login('viewer');const before=await s.service.getDiagnosisReport('DG-HW');await s.service.logout();await s.login('kg_editor');let w=(await s.service.loadKnowledgeWorkspace()).workspace!;const c=w.changes.find(c=>c.id==='KGC-SEED-DRAFT')!;w=(await s.service.submitKnowledgeChange({actorId:'KG-EDITOR',baseRevision:w.revision,requestId:'auth-submit',changeId:c.id,revision:c.revision})).workspace;await s.service.logout();await s.login('kg_reviewer');w=(await s.service.reviewKnowledgeChange({actorId:'KG-REVIEWER',baseRevision:w.revision,requestId:'auth-review',changeId:c.id,revision:c.revision,submission:1,approved:true,opinion:''})).workspace;w=(await s.service.publishKnowledgeChange({actorId:'KG-REVIEWER',baseRevision:w.revision,requestId:'auth-publish',changeId:c.id,revision:c.revision})).workspace;const entity=await s.service.getKnowledgeEntity({versionId:w.currentVersionId,entityId:'KGE-OPERATION'}),device=await s.service.getDeviceKnowledge({versionId:w.currentVersionId,modelId:'DM-0001'});expect(device.items.find(x=>x.entity.id===entity.entity.id)?.entity).toEqual(entity.entity);await s.service.logout();await s.login('viewer');expect(await s.service.getDiagnosisReport('DG-HW')).toEqual(before);});
  it('发布和回滚在图谱与型号知识中读取相同版本，历史诊断报告不变',async()=>{const storage=new TestStorage(),service=createMockService(()=>storage);const before=await service.getDiagnosisReport('DG-HW');const preview=await service.loadPreview();let w=(await service.loadKnowledgeWorkspace()).workspace!;let counter=0;const request=(actorId:string)=>({actorId,baseRevision:w.revision,requestId:'integration-'+(++counter)});const c=w.changes.find(c=>c.id==='KGC-SEED-DRAFT')!;w=(await service.submitKnowledgeChange({...request('KG-EDITOR'),changeId:c.id,revision:1})).workspace;w=(await service.reviewKnowledgeChange({...request('KG-REVIEWER'),changeId:c.id,revision:1,submission:1,approved:true,opinion:''})).workspace;w=(await service.publishKnowledgeChange({...request('KG-REVIEWER'),changeId:c.id,revision:1})).workspace;const detail=await service.getKnowledgeEntity({versionId:w.currentVersionId,entityId:'KGE-OPERATION'});const panel=await service.getDeviceKnowledge({versionId:w.currentVersionId,modelId:'DM-0001'});expect(panel.versionId).toBe(detail.versionId);expect(panel.items.find(e=>e.entity.id===detail.entity.id)!.entity).toEqual(detail.entity);expect(detail.entity.description).toContain('操作时间');w=(await service.rollbackKnowledgeVersion({...request('KG-REVIEWER'),versionId:w.currentVersionId,reason:'恢复'})).workspace;expect((await service.getDeviceKnowledge({versionId:w.currentVersionId,modelId:'DM-0001'})).items.find(e=>e.entity.id==='KGE-OPERATION')!.entity.description).not.toContain('操作时间');expect(await service.getDiagnosisReport('DG-HW')).toEqual(before);expect(await service.loadPreview()).toEqual(preview);});
  it('资源/规划/诊断键不可读不阻断知识浏览与审核',async()=>{const s=new TestStorage();s.failReadKeys=new Set([RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY,DIAGNOSIS_STORAGE_KEY]);const service=createMockService(()=>s),loaded=await service.loadKnowledgeWorkspace();expect(loaded.error).toBeNull();const w=loaded.workspace!;const r=await service.reviewKnowledgeChange({actorId:'KG-REVIEWER',baseRevision:w.revision,requestId:'review',changeId:'KGC-SEED-PENDING',revision:1,submission:1,approved:true,opinion:''});expect(r.workspace.changes.find(c=>c.id==='KGC-SEED-PENDING')!.state).toBe('APPROVED');expect(s.readHistory.every(key=>key===KNOWLEDGE_STORAGE_KEY)).toBe(true);});
  it('知识损坏不阻断资源加载、规划历史与诊断历史',async()=>{const s=new TestStorage();s.entries.set(KNOWLEDGE_STORAGE_KEY,'bad');const service=createMockService(()=>s);expect((await service.loadKnowledgeWorkspace()).workspace).toBeNull();expect((await service.loadPreview()).resources.devices.length).toBeGreaterThan(0);await expect(service.loadPlanningWorkspace()).resolves.toBeDefined();await expect(service.getDiagnosisReport('DG-HW')).resolves.toBeDefined();});
  it('资源/规划/诊断的显式重置不会改知识记录',async()=>{const s=new TestStorage(),service=createMockService(()=>s);const w=(await service.loadKnowledgeWorkspace()).workspace!;await service.resetKnowledgeWorkspace({actorId:'KG-REVIEWER',baseRevision:w.revision,requestId:'k-reset'});const saved=s.entries.get(KNOWLEDGE_STORAGE_KEY);const preview=await service.loadPreview();await service.resetResources(preview.resourceMeta.revision);const planning=await service.loadPlanningWorkspace();await service.resetPlanningWorkspace(planning.workspace!.revision);const diagnosis=await service.loadDiagnosisWorkspace();await service.resetDiagnosisWorkspace(diagnosis.workspace!.revision);expect(s.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(saved);});
});

// 真实登录身份下，步骤与文字从同一知识发布版读取；业务快照始终保持。
describe('工作原理统一身份联动', () => {
  it('作者维护、审核人发布/回滚后图谱与两个型号同版，历史诊断及资源不变', async () => {
    const s = authFixture(); await s.login('viewer');
    const report = await s.service.getDiagnosisReport('DG-HW'), preview = await s.service.loadPreview();
    await s.service.logout(); await s.login('kg_editor');
    let w = (await s.service.loadKnowledgeWorkspace()).workspace!; const before = structuredClone(w.versions), original = w.currentVersionId;
    const entity = structuredClone(w.versions[1].entities.find(e => e.id === 'KGE-PRINCIPLE')!);
    entity.principleFlow = { steps: [{ title: '收集输入', description: '发布后可检索的步骤' }, { title: '输出结果', description: '' }] };
    let n = 0; const request = (actorId: string) => ({ actorId, baseRevision: w.revision, requestId: 'principle-auth-' + (++n) });
    const saved = await s.service.saveKnowledgeChange({ ...request('KG-EDITOR'), changeId: null, revision: null,
      draft: { summary: '完善教学流程', baseVersionId: w.currentVersionId, entities: [entity], relations: [] } });
    w = saved.workspace; const id = saved.entityId;
    expect((await s.service.searchKnowledge({ versionId: w.currentVersionId, categories: ['设备知识'], search: '发布后可检索' })).total).toBe(0);
    w = (await s.service.submitKnowledgeChange({ ...request('KG-EDITOR'), changeId: id, revision: 1 })).workspace;
    await s.service.logout(); await s.login('kg_reviewer');
    w = (await s.service.reviewKnowledgeChange({ ...request('KG-REVIEWER'), changeId: id, revision: 1, submission: 1, approved: true, opinion: '' })).workspace;
    expect(w.currentVersionId).toBe(original);
    w = (await s.service.publishKnowledgeChange({ ...request('KG-REVIEWER'), changeId: id, revision: 1 })).workspace;
    const detail = await s.service.getKnowledgeEntity({ versionId: w.currentVersionId, entityId: entity.id });
    for (const modelId of ['DM-0001', 'DM-0002']) {
      const panel = await s.service.getDeviceKnowledge({ versionId: w.currentVersionId, modelId, search: '发布后可检索' });
      expect(panel.versionId).toBe(detail.versionId); expect(panel.items[0].entity).toEqual(detail.entity);
    }
    expect(detail.entity.principleFlow).toEqual(entity.principleFlow); expect(w.versions.slice(0, 2)).toEqual(before);
    w = (await s.service.rollbackKnowledgeVersion({ ...request('KG-REVIEWER'), versionId: w.currentVersionId, reason: '恢复教学原版' })).workspace;
    expect((await s.service.getKnowledgeEntity({ versionId: w.currentVersionId, entityId: entity.id })).entity.principleFlow).toEqual(before[1].entities.find(e=>e.id===entity.id)!.principleFlow);
    expect((await s.service.searchKnowledge({ versionId: w.currentVersionId, categories: ['设备知识'], search: '发布后可检索' })).total).toBe(0);
    await s.service.logout(); await s.login('viewer');
    expect(await s.service.getDiagnosisReport('DG-HW')).toEqual(report); expect(await s.service.loadPreview()).toEqual(preview);
  });
});

// 摘要读取实际发布版本；接口仅经测试变更单创建，不改教学基线。
describe('设备型号摘要与知识发布联动', () => {
  it('保存、送审和批准仍读旧版，发布与回滚同步型号摘要、实体和图谱且业务历史不变', async () => {
    const s = authFixture(); await s.login('viewer');
    const preview = await s.service.loadPreview(), planning = await s.service.loadPlanningWorkspace();
    const diagnosis = await s.service.loadDiagnosisWorkspace(), report = await s.service.getDiagnosisReport('DG-HW');
    const businessKeys = [RESOURCE_STORAGE_KEY, PLANNING_STORAGE_KEY, DIAGNOSIS_STORAGE_KEY];
    const businessRecords = businessKeys.map(key => s.storage.entries.get(key));
    await s.service.logout(); await s.login('kg_editor');
    let w = (await s.service.loadKnowledgeWorkspace()).workspace!;
    const baseline = structuredClone(w.versions), original = w.currentVersionId;
    const summary = async (modelId: string, versionId = w.currentVersionId) => projectDeviceKnowledgeSummary(
      await s.service.getDeviceKnowledge({ modelId, versionId }), { modelId, versionId });
    const originalSummaries = await Promise.all(['DM-0001', 'DM-0002'].map(modelId => summary(modelId)));
    const power = structuredClone(baseline[1].entities.find(e => e.id === 'KGE-POWER')!);
    power.name = '已核对的教学功放'; power.description = '本版只明确绑定第一个型号。'; power.modelIds = ['DM-0001'];
    const operation = structuredClone(baseline[1].entities.find(e => e.id === 'KGE-OPERATION')!);
    operation.description = '本次发布的型号功能说明';
    const interfaceForModel = { ...structuredClone(power), id: 'new:model-interface', name: '测试型号接口',
      type: 'Interface', description: '只验证关系数据的展示流程。', source: '集成测试变更单 · 非厂家资料' };
    const sharedInterface = { ...structuredClone(interfaceForModel), id: 'new:shared-interface',
      name: '测试通用接口知识', modelIds: [] };
    const relations = [interfaceForModel, sharedInterface].map((entity, index) => ({
      id: 'new:interface-relation-' + index, head: 'KGE-MODEL', type: 'hasInterface', tail: entity.id,
      weight: null, source: '测试明确型号关系 · 不参与推理',
    }));
    let count = 0;
    const request = (actorId: string) => ({ actorId, baseRevision: w.revision, requestId: 'summary-release-' + (++count) });
    const saved = await s.service.saveKnowledgeChange({ ...request('KG-EDITOR'), changeId: null, revision: null,
      draft: { summary: '验证组成、功能与接口发布', baseVersionId: original,
        entities: [power, operation, interfaceForModel, sharedInterface], relations } });
    w = saved.workspace;
    const change = w.changes.find(c => c.id === saved.entityId)!;
    const modelInterface = change.content.entities.find(e => e.name === interfaceForModel.name)!;
    const genericInterface = change.content.entities.find(e => e.name === sharedInterface.name)!;
    expect(await summary('DM-0001')).toEqual(originalSummaries[0]);
    w = (await s.service.submitKnowledgeChange({ ...request('KG-EDITOR'), changeId: change.id, revision: change.revision })).workspace;
    expect(await summary('DM-0002')).toEqual(originalSummaries[1]);
    await s.service.logout(); await s.login('kg_reviewer');
    w = (await s.service.reviewKnowledgeChange({ ...request('KG-REVIEWER'), changeId: change.id,
      revision: change.revision, submission: 1, approved: true, opinion: '' })).workspace;
    expect(w.currentVersionId).toBe(original);
    expect(await summary('DM-0001')).toEqual(originalSummaries[0]);
    w = (await s.service.publishKnowledgeChange({ ...request('KG-REVIEWER'), changeId: change.id, revision: change.revision })).workspace;
    const released = w.currentVersionId, first = await summary('DM-0001'), second = await summary('DM-0002');
    expect(first.components).toMatchObject([{ entityId: power.id, name: power.name, description: power.description }]);
    expect(second.components).toEqual([]);
    expect(first.interfaces.map(e => e.entityId)).toEqual(['KGE-INTERFACE', modelInterface.id, genericInterface.id]);
    expect(second.interfaces.map(e => e.entityId)).toEqual([genericInterface.id]);
    for (const item of [first, second]) {
      expect(item.versionId).toBe(released);
      expect(item.functions.find(e => e.entityId === operation.id)?.description).toBe(operation.description);
      expect(item.interfaces.filter(e=>e.entityId!=='KGE-INTERFACE').every(e => e.entitySource === interfaceForModel.source)).toBe(true);
      expect(item.interfaces.every(e => e.bindings.some(b => b.rootId === 'KGE-MODEL' && b.relationType === 'hasInterface'))).toBe(true);
    }
    const graph = await s.service.queryKnowledgeGraph({ versionId: released, categories: ['设备知识'],
      focusId: 'KGE-MODEL', expandedIds: ['KGE-MODEL'] });
    for (const id of [modelInterface.id, genericInterface.id]) {
      const detail = await s.service.getKnowledgeEntity({ versionId: released, entityId: id });
      expect(graph.versionId).toBe(detail.versionId);
      expect(graph.entities.find(e => e.id === id)).toEqual(detail.entity);
      expect(graph.relations.some(r => r.head === 'KGE-MODEL' && r.tail === id && r.type === 'hasInterface')).toBe(true);
      expect(first.interfaces.find(e => e.entityId === id)?.description).toBe(detail.entity.description);
    }
    expect((await summary('DM-0003')).roots).toEqual([]);
    expect(await summary('DM-0001', original)).toEqual(originalSummaries[0]);
    expect(w.versions.slice(0, 2)).toEqual(baseline);
    w = (await s.service.rollbackKnowledgeVersion({ ...request('KG-REVIEWER'), versionId: released, reason: '恢复原教学组成' })).workspace;
    for (const [index, modelId] of ['DM-0001', 'DM-0002'].entries()) {
      const restored = await summary(modelId);
      expect(restored.versionId).toBe(w.currentVersionId);
      expect(restored.components).toEqual(originalSummaries[index].components);
      expect(restored.functions).toEqual(originalSummaries[index].functions);
      expect(restored.interfaces).toEqual(originalSummaries[index].interfaces);
    }
    const restoredGraph = await s.service.queryKnowledgeGraph({ versionId: w.currentVersionId, categories: ['设备知识'] });
    expect(restoredGraph.entities.some(e => e.id === modelInterface.id || e.id === genericInterface.id)).toBe(false);
    expect(await summary('DM-0001', released)).toEqual(first);
    expect(w.versions.slice(0, 2)).toEqual(baseline);
    await s.service.logout(); await s.login('viewer');
    expect(await s.service.loadPreview()).toEqual(preview);
    expect(await s.service.loadPlanningWorkspace()).toEqual(planning);
    expect(await s.service.loadDiagnosisWorkspace()).toEqual(diagnosis);
    expect(await s.service.getDiagnosisReport('DG-HW')).toEqual(report);
    expect(businessKeys.map(key => s.storage.entries.get(key))).toEqual(businessRecords);
  });

  it('关系改为反向后仅发布才移出组成，回滚恢复；只读摘要不写存储或修改返回值', async () => {
    const storage = new TestStorage(), service = createMockService(() => storage);
    let w: KnowledgeWorkspace = (await service.loadKnowledgeWorkspace()).workspace!;
    const baseline = structuredClone(w.versions), original = w.currentVersionId;
    const read = async () => {
      const data = await service.getDeviceKnowledge({ versionId: w.currentVersionId, modelId: 'DM-0001' });
      const untouched = structuredClone(data), records = [...storage.entries], writes = storage.writes;
      const result = projectDeviceKnowledgeSummary(data, { versionId: w.currentVersionId, modelId: 'DM-0001' });
      expect(data).toEqual(untouched); expect([...storage.entries]).toEqual(records); expect(storage.writes).toBe(writes);
      return result;
    };
    const before = await read(), relation = structuredClone(baseline[1].relations.find(r => r.type === 'hasComponent')!);
    [relation.head, relation.tail] = [relation.tail, relation.head]; relation.source = '测试反向关系，不能当型号组成';
    let count = 0;
    const request = (actorId: string) => ({ actorId, baseRevision: w.revision, requestId: 'summary-direction-' + (++count) });
    const saved = await service.saveKnowledgeChange({ ...request('KG-EDITOR'), changeId: null, revision: null,
      draft: { summary: '改变教学关系方向', baseVersionId: original, entities: [], relations: [relation] } });
    w = saved.workspace; const change = w.changes.find(c => c.id === saved.entityId)!;
    expect(await read()).toEqual(before);
    w = (await service.submitKnowledgeChange({ ...request('KG-EDITOR'), changeId: change.id, revision: change.revision })).workspace;
    w = (await service.reviewKnowledgeChange({ ...request('KG-REVIEWER'), changeId: change.id,
      revision: change.revision, submission: 1, approved: true, opinion: '' })).workspace;
    expect(await read()).toEqual(before);
    w = (await service.publishKnowledgeChange({ ...request('KG-REVIEWER'), changeId: change.id, revision: change.revision })).workspace;
    expect((await read()).components).toEqual([]);
    expect((await service.getKnowledgeEntity({ versionId: w.currentVersionId, entityId: 'KGE-MODEL' })).relations).toContainEqual(relation);
    w = (await service.rollbackKnowledgeVersion({ ...request('KG-REVIEWER'), versionId: w.currentVersionId, reason: '恢复正向组成关系' })).workspace;
    expect((await read()).components).toEqual(before.components);
    expect(w.versions.slice(0, 2)).toEqual(baseline);
  });
});
