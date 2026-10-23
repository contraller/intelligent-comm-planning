import { interferenceFixture } from './helpers/interference';
import { planningPresets } from '../src/mocks/planning-presets';
import { describe,it,expect } from 'vitest';
import { authFixture } from './helpers/auth';
import { readJournal,readSystem } from '../src/services/system-storage';
import { OPERATION_LOG_KEY,SYSTEM_STORAGE_KEY } from '../src/config/demo';
import { DEMO_PASSWORD } from '../src/mocks/system-presets';
describe('业务结果与日志独立',()=>{
  it('日志重置冲突记录失败，成功重置只保留一个重置事件',async()=>{
    const s=authFixture();await s.login();await expect(s.service.resetOperationLogs({baseRevision:'stale'})).rejects.toMatchObject({code:'LOG_CONFLICT'});
    expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'resetOperationLogs',outcome:'FAILED',errorCode:'LOG_CONFLICT'});
    await s.service.resetOperationLogs({baseRevision:readJournal(s.storage).revision});expect(readJournal(s.storage).events).toHaveLength(1);
  });
  it('资源保存日志保留所选对象 ID，不记录原字段内容',async()=>{
    const s=authFixture();await s.login('resource');const preview=await s.service.loadPreview();
    await s.service.commitResources({baseRevision:preview.resourceMeta.revision,stations:[{id:'ND-0001',name:'不应进入日志的字段内容'}],devices:[]});
    expect(readJournal(s.storage).events.at(-1)?.objectId).toBe('ND-0001');expect(s.storage.entries.get(OPERATION_LOG_KEY)).not.toContain('不应进入日志的字段内容');
  });
  it('记录真实成功/失败/拒绝/无变化，普通浏览不增加事件',async()=>{
    const s=authFixture();await s.login();const count=readJournal(s.storage).events.length;await s.service.querySystemAccounts();await s.service.loadPreview();expect(readJournal(s.storage).events).toHaveLength(count);
    await s.service.saveSystemParameter({...s.mutation(),parameterId:'PAR-01',value:30});
    await expect(s.service.saveSystemParameter({...s.mutation(),parameterId:'PAR-01',value:-1})).rejects.toBeDefined();
    await expect(s.service.submitPlanning({} as never)).rejects.toBeDefined();
    expect(readJournal(s.storage).events.map(e=>e.outcome)).toEqual(['SUCCESS','UNCHANGED','FAILED','DENIED']);
  });
  it('业务成功但日志配额失败仍返回成功，只重试日志不重做业务',async()=>{
    const s=authFixture();await s.login();s.storage.failWriteKeys.add(OPERATION_LOG_KEY);
    const r={...s.mutation(),parameterId:'PAR-01',value:45};expect((await s.service.saveSystemParameter(r)).changed).toBe(true);
    const before=s.storage.entries.get(SYSTEM_STORAGE_KEY);expect(readSystem(s.storage).parameters[0].value).toBe(45);expect(s.logger.status().pending).toBe(1);
    await s.service.saveSystemParameter(r);expect(s.logger.status().pending).toBe(1);
    s.storage.failWriteKeys.clear();s.logger.retry();s.logger.retry();expect(s.logger.status().pending).toBe(0);expect(s.storage.entries.get(SYSTEM_STORAGE_KEY)).toBe(before);
    expect(readJournal(s.storage).events.filter(e=>e.requestId===r.requestId)).toHaveLength(1);
  });
  it('记录冻结操作人名称，失败登录不含口令、请求体或业务文件',async()=>{
    const s=authFixture();await s.login();const actor=readSystem(s.storage).accounts[0];
    await s.service.saveSystemAccount({...s.mutation(),account:{...actor,name:'后来改名'}});
    const events=readJournal(s.storage).events;expect(events[0].actor?.name).toBe('演示管理员');expect(events.at(-1)?.actor?.name).toBe('演示管理员');
    await s.service.logout();await expect(s.service.login({username:'viewer',password:'secret-raw-password'})).rejects.toBeDefined();
    const bytes=s.storage.entries.get(OPERATION_LOG_KEY)!;expect(bytes).not.toContain('secret-raw-password');expect(bytes).not.toContain(DEMO_PASSWORD);
    expect(readJournal(s.storage).events.at(-1)).toMatchObject({actor:null,attemptedUsername:'viewer',outcome:'DENIED'});
  });
  it('显式重置更换日志 epoch，旧待补事件不能重新写回',async()=>{
    const s=authFixture();await s.login();s.storage.failWriteKeys.add(OPERATION_LOG_KEY);await s.service.saveSystemParameter({...s.mutation(),parameterId:'PAR-01',value:35});expect(s.logger.status().pending).toBe(1);
    s.storage.failWriteKeys.clear();await s.service.resetOperationLogs({baseRevision:readJournal(s.storage).revision});s.logger.retry();expect(s.logger.status().pending).toBe(0);expect(readJournal(s.storage).events.map(e=>e.action)).toEqual(['resetOperationLogs']);
  });
  it('只记录本次失败，不将重复成功请求改成新的变更事件',async()=>{
    const s=authFixture();await s.login();const request={...s.mutation(),parameterId:'PAR-02',value:40};await s.service.saveSystemParameter(request);await s.service.saveSystemParameter(request);
    await expect(s.service.saveSystemParameter({...request,value:41})).rejects.toBeDefined();
    expect(readJournal(s.storage).events.filter(e=>e.requestId===request.requestId).map(e=>e.outcome)).toEqual(['SUCCESS','FAILED']);
  });
});

// 日志仅存对象摘要；文件正文与接口地址不作为审计内容。
describe('资源文件及频谱操作日志',()=>{
  it('导入和上下架列出 ID；导出记录类型，不保存文件正文',async()=>{
    const s=authFixture();await s.login('resource');
    const preview=await s.service.previewResourceImport({file:await s.service.getResourceTemplate('xlsx'),kind:'nodes',context:'ledger',baseRevision:'initial'});
    const saved=await s.service.commitResourceImport({baseRevision:'initial',requestId:'import',preview});
    expect(readJournal(s.storage).events.at(-1)?.objectId).toContain('NEW-STATION-01');
    await s.service.setDeviceAvailability({baseRevision:saved.meta.revision,requestId:'down',ids:['NEW-DEVICE-01'],availability:'OFF_SHELF'});
    expect(readJournal(s.storage).events.at(-1)?.objectId).toBe('NEW-DEVICE-01');
    await s.service.exportResources({format:'csv',kinds:['devices'],ids:{devices:['NEW-DEVICE-01']}});
    expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'exportResources',objectId:'devices',outcome:'SUCCESS'});
    expect(s.storage.entries.get(OPERATION_LOG_KEY)).not.toContain('新建固定站示例');
  });
  it('频谱模拟失败记录 FAILED，日志不包含地址和参数',async()=>{
    const s=authFixture();await s.login('resource');const initial=await s.service.loadSpectrumWorkspace();
    const saved=await s.service.saveSpectrumSource({baseRevision:initial.revision,requestId:'spectrum-save',source:{...initial.sources[0],endpoint:'/private-spectrum-path?token=do-not-log',minKhz:2,maxKhz:20}});
    await s.service.checkSpectrumSource({baseRevision:saved.workspace.revision,requestId:'spectrum-check',sourceId:'SP-01',configRevision:saved.workspace.sources[0].revision,demo:'connection-failed'});
    expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'checkSpectrumSource',outcome:'FAILED',errorCode:'MOCK_CHECK_FAILED'});
    const text=s.storage.entries.get(OPERATION_LOG_KEY)!;expect(text).not.toContain('private-spectrum');expect(text).not.toContain('do-not-log');
  });
});

describe('任务保存日志',()=>{
  it('记录任务 ID 和失败码，不记录输入全文；方案导出有独立事件',async()=>{
    const s=authFixture();await s.login('planner');
    const request={taskId:'LOG-TASK',input:{...structuredClone(planningPresets[0].input),description:'不应写入审计全文'},baseResourceRevision:'initial',baseTaskRevision:'initial',requestId:'task-log'};
    await s.service.saveTask(request);expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'saveTask',objectId:'LOG-TASK',outcome:'SUCCESS'});
    expect(JSON.stringify(readJournal(s.storage))).not.toContain('不应写入审计全文');
    await expect(s.service.saveTask({...request,requestId:'stale'})).rejects.toMatchObject({code:'TASK_REVISION_CONFLICT'});
    expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'saveTask',outcome:'FAILED',errorCode:'TASK_REVISION_CONFLICT'});
    await s.service.exportPlanVersion({planId:'PLAN-V1',format:'json'});expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'exportPlanVersion',objectId:'PLAN-V1',outcome:'SUCCESS'});
  });
});

it('分析与采纳日志记录身份、成功和重复结果，不包含完整冻结资源',async()=>{
  const s=authFixture(),simulation=await interferenceFixture('balanced',s.storage);
  Object.assign(s.raw,simulation.service,simulation.planning);
  await s.login('planner');
  const submitted=await s.service.submitInterferenceAnalysis(await simulation.request());
  expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'submitInterferenceAnalysis',module:'GIS 干扰分析',objectId:submitted.view.run.analysisId,outcome:'SUCCESS'});
  simulation.advance();
  const request={baseRevision:submitted.workspace.revision,requestId:'adopt-log',analysisId:submitted.view.run.analysisId,measureId:'FREQ_ADJUST'};
  const adopted=await s.service.adoptInterferenceMeasure(request);
  expect(readJournal(s.storage).events.at(-1)).toMatchObject({action:'adoptInterferenceMeasure',objectId:adopted.plan.id,outcome:'SUCCESS'});
  await s.service.adoptInterferenceMeasure({...request,requestId:'repeat-log',baseRevision:adopted.workspace.revision});
  expect(readJournal(s.storage).events.at(-1)).toMatchObject({outcome:'UNCHANGED',objectId:adopted.plan.id});
  expect(s.storage.entries.get(OPERATION_LOG_KEY)).not.toContain('inputSnapshot');
});
