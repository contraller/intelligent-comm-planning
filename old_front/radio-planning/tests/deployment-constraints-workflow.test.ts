import { afterEach,describe,expect,it,vi } from 'vitest';
import { createMockService } from '../src/services/mock';
import { deploymentPlanningPresets } from '../src/mocks/deployment-constraint-presets';
import { TestStorage } from './helpers/storage';
import { savedRequest,saveTaskInput } from './helpers/tasks';
import { PLANNING_PHASE_MS,PLANNING_STORAGE_KEY } from '../src/config/demo';
import type { PlanningInput } from '../src/types/planning';
import { bindPlanningAdjustmentExample } from '../src/services/planning-adjustment';
import { planningAdjustmentExamples } from '../src/mocks/planning-adjustments';
const input=()=>structuredClone(deploymentPlanningPresets[0].input);
afterEach(()=>vi.useRealTimers());
async function setup(){vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));const storage=new TestStorage(),service=createMockService(()=>storage);
 const run=async(value:PlanningInput,revision='initial')=>{const r=await service.submitPlanning(await savedRequest(storage,{baseRevision:revision,requestId:crypto.randomUUID(),taskId:'DEPLOY-TASK',parentPlanVersionId:null,input:value}));vi.setSystemTime(Date.now()+PLANNING_PHASE_MS*7);return r;};return{storage,service,run};}
// 完整目录、新旧快照和条件版本共同验证，不只检验新增字段存在。
describe('部署约束任务到方案闭环',()=>{
  it('新增教学方案有限人工调整保持父条件及独立结果身份',async()=>{
    const s=await setup(),first=await s.run(input()),saved=await s.service.savePlanVersion({baseRevision:first.workspace.revision,requestId:'parent',jobId:first.view.job.id,name:'父方案',note:''});
    const adjustment=bindPlanningAdjustmentExample(planningAdjustmentExamples.find(e=>e.id==='economical')!,saved.plan);
    const child=await s.service.submitPlanning({baseRevision:saved.workspace.revision,requestId:'adjust',taskId:saved.plan.taskId,parentPlanVersionId:saved.plan.id,input:structuredClone(saved.plan.workflow!.input),adjustment});
    expect(child.view.job.input).toEqual(saved.plan.workflow!.input);expect(child.view.job.resultPresetId).toBe('deployment-economical');
    vi.setSystemTime(Date.now()+PLANNING_PHASE_MS*7);const result=await s.service.getPlanningJob(child.view.job.id);expect(result.result!.metrics.totalRadiatedPowerW).toBe(60);
  });
  it('两套固定预设可规划、保存、确认、对比，读回不丢条件',async()=>{
    const s=await setup();const first=await s.run(input()),view=await s.service.getPlanningJob(first.view.job.id);
    expect(view.state).toBe('SUCCESS');expect(view.result!.resultDetails!.assetVersion).toBe('planning-result-details-demo-3');
    const a=await s.service.savePlanVersion({baseRevision:first.workspace.revision,requestId:'save-a',jobId:view.job.id,name:'部署均衡',note:''});
    const confirmed=await s.service.confirmPlanVersion({baseRevision:a.workspace.revision,requestId:'confirm-a',planId:a.plan.id});
    const bRun=await s.run(structuredClone(deploymentPlanningPresets[1].input),confirmed.workspace.revision);
    const b=await s.service.savePlanVersion({baseRevision:bRun.workspace.revision,requestId:'save-b',jobId:bRun.view.job.id,name:'部署节能',note:''});
    expect((await s.service.comparePlanVersions([a.plan.id,b.plan.id])).map(p=>p.workflow!.input.deploymentConstraints)).toEqual([input().deploymentConstraints,input().deploymentConstraints]);
    const reload=await createMockService(()=>s.storage).loadPlanningWorkspace();expect(reload.workspace.plans).toHaveLength(2);expect(reload.workspace.plans[0].workflow!.input).toEqual(input());
    const file=await s.service.exportPlanVersion({planId:a.plan.id,format:'json'});expect(JSON.parse(new TextDecoder().decode(file.bytes)).plan.workflow.input).toEqual(input());
    // 其他模块至少能安全读取含新预设的规划库，不新增分析结果。
    expect((await s.service.loadTaskWorkspace()).tasks).toHaveLength(1);
  });
  it('合法自定义条件可保存，但不匹配时拒绝计算而且不写规划库',async()=>{
    const s=await setup(),value=input();value.deploymentConstraints!.gridStepM=600;
    await saveTaskInput(s.storage,value,'DEPLOY-TASK');
    await expect(s.service.submitPlanning({baseRevision:'initial',requestId:'unsupported',taskId:'DEPLOY-TASK',parentPlanVersionId:null,input:value})).rejects.toMatchObject({code:'NO_PRESET'});
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBeNull();expect((await s.service.loadTaskWorkspace()).tasks[0].versions[0].input).toEqual(value);
  });
  it('条件变化使旧方案来源变化，改回不复活历史条件版本',async()=>{
    const s=await setup(),first=await s.run(input()),saved=await s.service.savePlanVersion({baseRevision:first.workspace.revision,requestId:'save',jobId:first.view.job.id,name:'原方案',note:''});
    const frozen=structuredClone(saved.plan.workflow),value=input();value.deploymentConstraints!.maxSlopeDeg=20;await saveTaskInput(s.storage,value,'DEPLOY-TASK');await saveTaskInput(s.storage,input(),'DEPLOY-TASK');
    const tasks=await s.service.loadTaskWorkspace();expect(new Set(tasks.tasks[0].versions.map(v=>v.conditionVersion)).size).toBe(3);
    const plan=(await s.service.loadPlanningWorkspace()).workspace.plans[0];expect(plan.sourceChanged).toBe(true);expect(plan.workflow).toEqual(frozen);
  });
});
