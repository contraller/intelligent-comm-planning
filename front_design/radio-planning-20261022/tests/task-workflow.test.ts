import { describe,it,expect } from 'vitest';
import { createMockService } from '../src/services/mock';
import { createPlanningMock } from '../src/services/planning-mock';
import { readResources } from '../src/services/resource-storage';
import { initialResources } from '../src/mocks/resource-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import { TestStorage } from './helpers/storage';
import { saveTaskInput } from './helpers/tasks';
import { PLANNING_STORAGE_KEY } from '../src/config/demo';
import { eligibleDiagnosisPlans,diagnosisSource } from '../src/services/diagnosis-validation';
const fixture=()=>{const storage=new TestStorage(),service=createMockService(()=>storage);let time=1000;const resources=()=>readResources(storage,initialResources()),planning=createPlanningMock(()=>storage,resources,()=>time);return {storage,service,planning,resources,advance:()=>{time+=10000;}};};
describe('任务版本与规划诊断联动',()=>{
  // 合法边界只放宽输入范围，不能让 Mock 绕过预生成结果匹配。
  it.each([0,1])('可靠性 %s 可原值保存，不匹配预设仍不生成规划结果',async minReliability=>{
    const s=fixture(),input=structuredClone(planningPresets[0].input);input.demands[0].minReliability=minReliability;
    await saveTaskInput(s.storage,input,'RELIABILITY');
    const saved=(await s.service.loadTaskWorkspace()).tasks.find(t=>t.id==='RELIABILITY')!.versions.at(-1)!;
    expect(saved.input.demands[0].minReliability).toBe(minReliability);
    const writes=s.storage.writes;
    await expect(s.planning.submitPlanning({baseRevision:'initial',requestId:'run-reliability',taskId:'RELIABILITY',parentPlanVersionId:null,input})).rejects.toMatchObject({code:'NO_PRESET'});
    expect(s.storage.writes).toBe(writes);expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBeNull();
  });
  it('未保存输入不可提交；合法但无预设任务可保存，不能假装产生结果',async()=>{
    const s=fixture(),input=structuredClone(planningPresets[0].input),request={baseRevision:'initial',requestId:'run',taskId:'T',parentPlanVersionId:null,input};
    await expect(s.planning.submitPlanning(request)).rejects.toMatchObject({code:'TASK_NOT_SAVED'});
    input.startTime='2026-09-08T08:00:00+08:00';await saveTaskInput(s.storage,input,'T');
    await expect(s.planning.submitPlanning(request)).rejects.toMatchObject({code:'NO_PRESET'});expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBeNull();
  });
  it('任务条件变更使确认方案及诊断历史失效；改回不重新生效',async()=>{
    const s=fixture(),input=structuredClone(planningPresets[0].input);await saveTaskInput(s.storage,input,'T');
    const run=await s.planning.submitPlanning({baseRevision:'initial',requestId:'run',taskId:'T',parentPlanVersionId:null,input});s.advance();
    const saved=await s.planning.savePlanVersion({baseRevision:run.workspace.revision,requestId:'save',jobId:run.view.job.id,name:'网络',note:''});
    const confirmed=await s.planning.confirmPlanVersion({baseRevision:saved.workspace.revision,requestId:'confirm',planId:saved.plan.id}),frozen=structuredClone(confirmed.plan);
    expect(eligibleDiagnosisPlans(confirmed.workspace,s.resources().meta)).toHaveLength(1);
    input.name='描述变化';await saveTaskInput(s.storage,input,'T');expect((await s.planning.loadPlanningWorkspace()).workspace.plans[0].sourceChanged).toBe(false);
    input.demands[0].maxDelayMs=101;await saveTaskInput(s.storage,input,'T');
    expect(eligibleDiagnosisPlans(confirmed.workspace,s.resources().meta)).toEqual([]);expect(diagnosisSource(frozen,confirmed.workspace,s.resources().meta).state).toBe('HISTORICAL');
    input.demands[0].maxDelayMs=100;await saveTaskInput(s.storage,input,'T');
    const plan=(await s.planning.loadPlanningWorkspace()).workspace.plans[0];expect(plan.sourceChanged).toBe(true);expect(plan.workflow).toEqual(frozen.workflow);expect(plan.inputSnapshot).toEqual(frozen.inputSnapshot);
  });
  it('运行期间任务变更不改写冻结输入；结果只能保存为参考',async()=>{
    const s=fixture(),input=structuredClone(planningPresets[0].input);await saveTaskInput(s.storage,input,'T');
    const run=await s.planning.submitPlanning({baseRevision:'initial',requestId:'run',taskId:'T',parentPlanVersionId:null,input});
    input.demands[0].maxDelayMs=102;await saveTaskInput(s.storage,input,'T');s.advance();
    const view=await s.planning.getPlanningJob(run.view.job.id);expect(view.state).toBe('SUCCESS');expect(view.job.input.demands[0].maxDelayMs).toBe(100);
    const saved=await s.planning.savePlanVersion({baseRevision:run.workspace.revision,requestId:'save',jobId:view.job.id,name:'旧条件',note:''});expect(saved.plan.state).toBe('REFERENCE');
  });
  it('指定设备档可运行；归属、在架和设备约束不被忽略',async()=>{
    const s=fixture(),input=structuredClone(planningPresets.find(p=>p.id==='device-balanced')!.input);await saveTaskInput(s.storage,input,'T');
    const run=await s.planning.submitPlanning({baseRevision:'initial',requestId:'run',taskId:'T',parentPlanVersionId:null,input});expect(run.view.job.input.demands[0].sourceDeviceId).toBe('DV-0001');s.advance();const result=await s.planning.savePlanVersion({baseRevision:run.workspace.revision,jobId:run.view.job.id,requestId:'device-save',name:'指定设备方案',note:''});expect(result.plan.workflow!.configuration.routes).toHaveLength(2);
    input.demands[0].sourceDeviceId='DV-0027';await expect(saveTaskInput(s.storage,input,'BAD')).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    input.demands[0].sourceDeviceId='DV-0001';await s.service.setDeviceAvailability({baseRevision:'initial',requestId:'down',ids:['DV-0001'],availability:'OFF_SHELF'});
    await expect(saveTaskInput(s.storage,input,'DOWN')).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  });
});
