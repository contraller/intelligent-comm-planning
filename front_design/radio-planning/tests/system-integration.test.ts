import { describe,it,expect } from 'vitest';
import { authFixture } from './helpers/auth';
import { readJournal,readSystem } from '../src/services/system-storage';
import { SYSTEM_STORAGE_KEY,OPERATION_LOG_KEY,RESOURCE_STORAGE_KEY,KNOWLEDGE_STORAGE_KEY } from '../src/config/demo';
describe('跨模块公开服务集成',()=>{
  it('资源维护只写资源与统一日志；不授予知识导航或查询权限',async()=>{
    const s=authFixture();await s.login('resource');const p=await s.service.loadPreview();
    await s.service.commitResources({baseRevision:p.resourceMeta.revision,stations:[{id:'ND-0001',name:'授权资源编辑'}],devices:[]});
    expect(s.storage.entries.has(RESOURCE_STORAGE_KEY)).toBe(true);expect(s.storage.entries.has(SYSTEM_STORAGE_KEY)).toBe(false);expect(s.storage.entries.has(KNOWLEDGE_STORAGE_KEY)).toBe(false);
    expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'commitResources',outcome:'SUCCESS',actor:{id:'SYS-RESOURCE'}});
    await expect(s.service.getDeviceKnowledge({versionId:'KGV-SEED-2',modelId:'D-01'})).rejects.toMatchObject({code:'FORBIDDEN'});
  });
  it('业务存储损坏与日志损坏都不影响系统配置维护',async()=>{
    const s=authFixture();await s.login();s.storage.entries.set(RESOURCE_STORAGE_KEY,'broken');s.storage.entries.set(KNOWLEDGE_STORAGE_KEY,'broken');s.storage.entries.set(OPERATION_LOG_KEY,'broken');
    await s.service.saveSystemParameter({...s.mutation(),parameterId:'PAR-01',value:70});expect(readSystem(s.storage).parameters[0].value).toBe(70);expect(s.logger.status().pending).toBe(1);
    expect((await s.service.querySystemAccounts()).total).toBe(7);expect((await s.service.getSession())?.id).toBe('SYS-ADMIN');
  });
  it('系统配置损坏统一阻止业务调用，不伪装为 Mock 成功',async()=>{
    const s=authFixture();await s.login('planner');s.storage.entries.set(SYSTEM_STORAGE_KEY,'broken');
    await expect(s.service.loadDiagnosisWorkspace()).rejects.toMatchObject({code:'SYSTEM_CORRUPT'});await expect(s.service.loadPlanningWorkspace()).rejects.toMatchObject({code:'SYSTEM_CORRUPT'});
  });
  it('知识操作和自身审计同时保留，系统重置不改知识身份历史',async()=>{
    const s=authFixture();await s.login('kg_reviewer');const w=(await s.service.loadKnowledgeWorkspace()).workspace!;
    await s.service.rollbackKnowledgeVersion({actorId:'KG-REVIEWER',baseRevision:w.revision,requestId:'rollback-1',versionId:w.currentVersionId,reason:'统一日志验证'});
    expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'rollbackKnowledgeVersion',outcome:'SUCCESS',actor:{id:'KG-REVIEWER'}});
    const knowledge=s.storage.entries.get(KNOWLEDGE_STORAGE_KEY);await s.service.logout();await s.login();await s.service.resetSystemWorkspace(s.mutation());
    expect(s.storage.entries.get(KNOWLEDGE_STORAGE_KEY)).toBe(knowledge);
  });
});
