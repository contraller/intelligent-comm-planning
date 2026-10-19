import { describe, expect, it } from 'vitest';
import { createTaskApiMock } from '../src/services/task-api-mock';
import { createPlanningApiMock } from '../src/services/planning-api-mock';
import { createMockService } from '../src/services/mock';
import { readResources } from '../src/services/resource-storage';
import { initialResources } from '../src/mocks/resource-presets';
import { TestStorage } from './helpers/storage';
import type { ApiReceipt } from '../src/types/task-api';
import { PLANNING_STORAGE_KEY } from '../src/config/demo';
import { bindPlanningAdjustmentExample } from '../src/services/planning-adjustment';
const options={context:'planning' as const};
function fixture(){const storage=new TestStorage(),receipts=new Map<string,ApiReceipt>(),source=()=>readResources(storage,initialResources());let time=Date.parse('2026-10-05T00:00:00Z');return{storage,source,tasks:createTaskApiMock(()=>storage,source,receipts),planning:createPlanningApiMock(()=>storage,source,receipts,()=>time),advance:()=>{time+=10000;}};}
async function saved(s:ReturnType<typeof fixture>,preset='balanced'){
  const catalog=await s.planning.loadPlanningCatalog(options),input=catalog.presets.find(p=>p.id===preset)!.defaults;
  return s.tasks.saveTaskInput({...options,taskId:'T1',revision:null,resourceRevision:s.source().meta.revision,requestId:'save-task',input});
}
// 用真实第二次提交建立可比较版本，保留原有“至少两个不同方案”的规则。
async function anotherPlan(s:ReturnType<typeof fixture>,parentPlanId:string|null){
  const task=await s.tasks.getTaskInput({...options,taskId:'T1'});
  const job=await s.planning.submitPlanningTask({...options,taskId:'T1',revision:task.revision,inputVersion:task.inputVersion,conditionVersion:task.conditionVersion,resourceRevision:task.resourceRevision,parentPlanId,requestId:'compare-run'});
  s.advance();const done=await s.planning.getPlanningTask({...options,taskId:'T1',jobId:job.id});
  return s.planning.savePlanningPlan({...options,taskId:'T1',jobId:job.id,revision:done.revision,requestId:'compare-save',name:'第二方案',note:''});
}
describe('新契约与既有 Mock 桥接',()=>{
  it('调整目录、独立提交和回执保留父版本身份且不改写任务输入', async () => {
    const s = fixture(), task = await saved(s), parent = await anotherPlan(s, null);
    // 名称和说明不改变业务条件版本，调整仍应冻结父方案原始输入。
    const renamed = await s.tasks.saveTaskInput({ ...options, taskId: 'T1', revision: task.revision, resourceRevision: task.resourceRevision, requestId: 'rename-before-adjustment', input: { ...task.input, name: '任务改名', description: '只修改说明' } });
    const catalog = await s.planning.loadPlanningCatalog(options), beforeTask = await s.tasks.getTaskInput({ ...options, taskId: 'T1' }), beforeResources = structuredClone(s.source());
    expect(catalog.adjustmentExamples).toHaveLength(2);
    const sample = catalog.adjustmentExamples!.find(e => e.manualOverrides.every(d => d.txPowerDbm === 40))!;
    const adjustment = bindPlanningAdjustmentExample(sample, { id: parent.id, snapshotId: parent.result.snapshotId, input: parent.input, configuration: parent.result.configuration, nodeIds: parent.result.nodes.map(n => n.id) });
    const request = { ...options, taskId: 'T1', revision: renamed.revision, inputVersion: renamed.inputVersion, conditionVersion: renamed.conditionVersion, resourceRevision: renamed.resourceRevision, parentPlanId: parent.id, requestId: 'manual-adjustment', adjustment };
    const started = await s.planning.submitPlanningTask(request), replay = await s.planning.submitPlanningTask(request);
    expect(replay.id).toBe(started.id); expect(started.adjustment).toEqual(adjustment); expect(started.input).toEqual(parent.input);
    const receipt = await s.tasks.getPlanningOperation({ ...options, taskId: 'T1', requestId: request.requestId, kind: 'submit' });
    expect(receipt.entityId).toBe(started.id);
    s.advance(); const done = await s.planning.getPlanningTask({ ...options, taskId: 'T1', jobId: started.id });
    expect(done.state).toBe('SUCCESS'); expect(done.resultPresetId).toBe('economical');
    expect(done.result!.configuration.devices.every(d => d.txPowerDbm === 40)).toBe(true);
    const plan = await s.planning.savePlanningPlan({ ...options, taskId: 'T1', jobId: started.id, revision: done.revision, requestId: 'save-adjustment', name: '人工调整方案', note: '' });
    expect(plan.adjustment).toEqual(adjustment); expect(plan.parentPlanId).toBe(parent.id); expect(plan.resultPresetId).toBe('economical');
    expect((await s.tasks.getTaskInput({ ...options, taskId: 'T1' })).input).toEqual(beforeTask.input);
    expect((await s.tasks.getTaskInput({ ...options, taskId: 'T1' })).conditionVersion).toBe(beforeTask.conditionVersion);
    expect(s.source()).toEqual(beforeResources);
    expect((await s.planning.getPlanningPlan({ ...options, taskId: 'T1', planId: parent.id })).result).toEqual(parent.result);
    // 返回对象的修改不能污染回执恢复后读取到的冻结调整。
    plan.adjustment!.manualOverrides[0].txPowerDbm = 999;
    expect((await s.planning.getPlanningPlan({ ...options, taskId: 'T1', planId: plan.id })).adjustment).toEqual(adjustment);
  });
  it('保存、执行、版本保存及确认沿用原事务，业务快照不改资源',async()=>{
    const s=fixture(),task=await saved(s),before=s.source().resources;
    const request={...options,taskId:task.taskId,revision:task.revision,inputVersion:task.inputVersion,conditionVersion:task.conditionVersion,resourceRevision:task.resourceRevision,parentPlanId:null,requestId:'run'};
    const job=await s.planning.submitPlanningTask(request);expect((await s.planning.submitPlanningTask(request)).id).toBe(job.id);s.advance();const done=await s.planning.getPlanningTask({...options,taskId:'T1',jobId:job.id});expect(done.state).toBe('SUCCESS');expect(done.result!.coverage.contour!.features.length).toBeGreaterThan(0);
    const plan=await s.planning.savePlanningPlan({...options,taskId:'T1',jobId:job.id,revision:done.revision,requestId:'save-plan',name:'新方案',note:''});const confirmed=await s.planning.confirmPlanningPlan({...options,taskId:'T1',planId:plan.id,revision:plan.revision,requestId:'confirm'});expect(confirmed.current).toBe(true);expect(confirmed.state).toBe('CONFIRMED');expect(s.source().resources).toEqual(before);
    // 新桥接的每个出口保留相同冻结明细，返回值可独立消费。
    expect(done.result!.resultDetails).toBeDefined(); expect(plan.result.resultDetails).toEqual(done.result!.resultDetails);
    expect(confirmed.result.resultDetails).toEqual(done.result!.resultDetails);
    const second = await anotherPlan(s, plan.id);
    const compared = await s.planning.comparePlanningPlans({ ...options, taskId: 'T1', planIds: [plan.id, second.id] });
    expect(compared[0].result.resultDetails).toEqual(done.result!.resultDetails);
    confirmed.result.resultDetails!.conflictFree = false;
    expect((await s.planning.getPlanningPlan({ ...options, taskId: 'T1', planId: plan.id })).result.resultDetails).toEqual(done.result!.resultDetails);
    const receipt=await s.tasks.getPlanningOperation({...options,taskId:'T1',requestId:'confirm',kind:'confirm'});expect(receipt.entityId).toBe(plan.id);
  });
  it('缺省明细的历史 Job 经查询、保存、确认和桥接对比仍缺省且读取不写回',async()=>{
    const s=fixture(),task=await saved(s);
    const job=await s.planning.submitPlanningTask({...options,taskId:'T1',revision:task.revision,inputVersion:task.inputVersion,conditionVersion:task.conditionVersion,resourceRevision:task.resourceRevision,parentPlanId:null,requestId:'old-run'});
    // 在持久化边界恢复旧版本字段形状，再走真实服务流程。
    const raw=JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!); delete raw.jobs[0].resultDetails;
    const legacy=JSON.stringify(raw);s.storage.entries.set(PLANNING_STORAGE_KEY,legacy);s.advance();const writes=s.storage.writes;
    const done=await s.planning.getPlanningTask({...options,taskId:'T1',jobId:job.id});
    expect(done.result).not.toHaveProperty('resultDetails');expect(s.storage.writes).toBe(writes);expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(legacy);
    const plan=await s.planning.savePlanningPlan({...options,taskId:'T1',jobId:job.id,revision:done.revision,requestId:'old-save',name:'旧任务保存',note:''});
    const confirmed=await s.planning.confirmPlanningPlan({...options,taskId:'T1',planId:plan.id,revision:plan.revision,requestId:'old-confirm'});
    expect(plan.result).not.toHaveProperty('resultDetails');expect(confirmed.result).not.toHaveProperty('resultDetails');
    const second=await anotherPlan(s,plan.id),compared=await s.planning.comparePlanningPlans({...options,taskId:'T1',planIds:[plan.id,second.id]});
    expect(compared[0].result).not.toHaveProperty('resultDetails');expect(compared[1].result.resultDetails).toBeDefined();
  });
  it('Mock 继续按有限预设执行，合法自定义任务不会伪造结果',async()=>{
    const s=fixture(),task=await saved(s);task.input.demands[0].maxDelayMs=999;
    const changed=await s.tasks.saveTaskInput({...options,taskId:'T1',revision:task.revision,resourceRevision:task.resourceRevision,requestId:'change',input:task.input});
    await expect(s.planning.submitPlanningTask({...options,taskId:'T1',revision:changed.revision,inputVersion:changed.inputVersion,conditionVersion:changed.conditionVersion,resourceRevision:changed.resourceRevision,parentPlanId:null,requestId:'run'})).rejects.toMatchObject({code:'NO_PRESET'});
  });
  it('仅名称变化沿用条件版本，条件改回仍使旧方案保持历史状态',async()=>{
    const s=fixture(),task=await saved(s),run=await s.planning.submitPlanningTask({...options,taskId:'T1',revision:task.revision,inputVersion:task.inputVersion,conditionVersion:task.conditionVersion,resourceRevision:task.resourceRevision,parentPlanId:null,requestId:'run'});s.advance();const done=await s.planning.getPlanningTask({...options,taskId:'T1',jobId:run.id});const plan=await s.planning.savePlanningPlan({...options,taskId:'T1',jobId:run.id,revision:done.revision,requestId:'plan',name:'快照',note:''});
    const named=await s.tasks.saveTaskInput({...options,taskId:'T1',revision:task.revision,resourceRevision:task.resourceRevision,requestId:'name',input:{...task.input,name:'新名称'}});expect(named.conditionVersion).toBe(task.conditionVersion);
    const changed=await s.tasks.saveTaskInput({...options,taskId:'T1',revision:named.revision,resourceRevision:task.resourceRevision,requestId:'condition',input:{...task.input,demands:task.input.demands.map((d,i)=>i?d:{...d,maxDelayMs:101})}});expect(changed.conditionVersion).not.toBe(task.conditionVersion);
    await s.tasks.saveTaskInput({...options,taskId:'T1',revision:changed.revision,resourceRevision:task.resourceRevision,requestId:'back',input:task.input});expect((await s.planning.getPlanningPlan({...options,taskId:'T1',planId:plan.id})).sourceChanged).toBe(true);
  });
  it('任务保存写入失败不产生新版本，旧全量服务继续可用',async()=>{
    const s=fixture(),task=await saved(s);s.storage.failWrite=true;await expect(s.tasks.saveTaskInput({...options,taskId:'T1',revision:task.revision,resourceRevision:task.resourceRevision,requestId:'fail',input:{...task.input,name:'失败修改'}})).rejects.toBeDefined();s.storage.failWrite=false;
    expect((await s.tasks.getTaskInput({...options,taskId:'T1'})).input.name).toBe(task.input.name);expect((await createMockService(()=>s.storage).loadTaskWorkspace()).tasks).toHaveLength(1);
  });
});
