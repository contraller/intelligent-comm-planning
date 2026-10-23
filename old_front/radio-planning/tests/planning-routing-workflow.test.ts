import { afterEach,describe,expect,it,vi } from 'vitest';
import { createMockService } from '../src/services/mock';
import { routingPlanningPresets,ROUTING_DETAILS_VERSION } from '../src/mocks/planning-routing-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import { TestStorage } from './helpers/storage';
import { savedRequest,saveTaskInput } from './helpers/tasks';
import { PLANNING_PHASE_MS,PLANNING_STORAGE_KEY } from '../src/config/demo';
import type { PlanningInput } from '../src/types/planning';
import { bindPlanningAdjustmentExample } from '../src/services/planning-adjustment';
import { planningAdjustmentExamples } from '../src/mocks/planning-adjustments';
const input=()=>structuredClone(routingPlanningPresets[0].input);
afterEach(()=>vi.useRealTimers());
async function setup(){
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
  const storage=new TestStorage(),service=createMockService(()=>storage);
  const advance=()=>vi.setSystemTime(Date.now()+PLANNING_PHASE_MS*7);
  const run=async(value:PlanningInput,revision='initial')=>{
    const r=await service.submitPlanning(await savedRequest(storage,{baseRevision:revision,requestId:crypto.randomUUID(),taskId:'ROUTING-TASK',parentPlanVersionId:null,input:value}));
    advance();return r;
  };return{storage,service,run,advance};
}
// 通过真实 Mock 服务验证输入、结果身份和冻结版本，避免仅断言字段存在。
describe('逐需求路由的完整流程',()=>{
  it('两档可保存、确认、比较及刷新，导出使用冻结输入',async()=>{
    const original=JSON.stringify(planningPresets),s=await setup(),aRun=await s.run(input());
    const view=await s.service.getPlanningJob(aRun.view.job.id);
    expect(view.state).toBe('SUCCESS');expect(view.result!.resultDetails!.assetVersion).toBe(ROUTING_DETAILS_VERSION);
    const a=await s.service.savePlanVersion({baseRevision:aRun.workspace.revision,requestId:'save-a',jobId:view.job.id,name:'路由均衡',note:''});
    const confirmed=await s.service.confirmPlanVersion({baseRevision:a.workspace.revision,requestId:'confirm',planId:a.plan.id});
    const bRun=await s.run(structuredClone(routingPlanningPresets[1].input),confirmed.workspace.revision);
    const b=await s.service.savePlanVersion({baseRevision:bRun.workspace.revision,requestId:'save-b',jobId:bRun.view.job.id,name:'路由节能',note:''});
    const compared=await s.service.comparePlanVersions([a.plan.id,b.plan.id]);
    expect(compared.map(p=>p.workflow!.input.demands)).toEqual([input().demands,input().demands]);
    const reload=await createMockService(()=>s.storage).loadPlanningWorkspace();
    expect(reload.workspace.plans).toHaveLength(2);expect(reload.workspace.plans[0].workflow!.input).toEqual(input());
    const file=await s.service.exportPlanVersion({planId:a.plan.id,format:'json'});
    expect(JSON.parse(new TextDecoder().decode(file.bytes)).plan.workflow.input).toEqual(input());
    // ZIP 编码使用真实调度；规划时间轴已经走完，不再推进假时钟。
    vi.useRealTimers();
    const Excel=(await import('exceljs')).default,book=new Excel.Workbook();
    const xlsx=await s.service.exportPlanVersion({planId:a.plan.id,format:'xlsx'});await book.xlsx.load(xlsx.bytes as any);
    expect(book.getWorksheet('逐需求路由条件')!.getRow(2).values).toEqual([,input().demands[0].id,'最高可靠性','请求备份']);
    expect(JSON.stringify(planningPresets)).toBe(original);
  });
  it('重排需求和自定义ID后仍正确绑定，人工调整保留路由条件与父快照',async()=>{
    const s=await setup(),value=input();value.demands.forEach((d,i)=>d.id='custom-'+i);value.demands.reverse();
    const run=await s.run(value),saved=await s.service.savePlanVersion({baseRevision:run.workspace.revision,requestId:'parent',jobId:run.view.job.id,name:'父',note:''});
    const frozen=JSON.stringify(saved.plan);
    const adjustment=bindPlanningAdjustmentExample(planningAdjustmentExamples.find(e=>e.id==='economical')!,saved.plan);
    const child=await s.service.submitPlanning({baseRevision:saved.workspace.revision,requestId:'adjust',taskId:saved.plan.taskId,parentPlanVersionId:saved.plan.id,input:structuredClone(saved.plan.workflow!.input),adjustment});
    expect(child.view.job.input).toEqual(value);expect(child.view.job.resultPresetId).toBe('routing-economical');
    s.advance();const view=await s.service.getPlanningJob(child.view.job.id);
    expect(view.result!.configuration.routes.every(r=>value.demands.some(d=>d.id===r.demandId))).toBe(true);
    expect(view.result!.metrics.totalRadiatedPowerW).toBe(60);
    await s.service.savePlanVersion({baseRevision:child.workspace.revision,requestId:'child',jobId:child.view.job.id,name:'子',note:''});
    expect(JSON.stringify((await s.service.loadPlanningWorkspace()).workspace.plans[0])).toBe(frozen);
  });
  it('路由条件变更使旧方案成为历史，改回也不复活旧条件版本',async()=>{
    const s=await setup(),run=await s.run(input()),saved=await s.service.savePlanVersion({baseRevision:run.workspace.revision,requestId:'save',jobId:run.view.job.id,name:'原',note:''});
    const frozen=structuredClone(saved.plan.workflow),value=input();value.demands[0].needBackup=false;
    await saveTaskInput(s.storage,value,'ROUTING-TASK');await saveTaskInput(s.storage,input(),'ROUTING-TASK');
    expect(new Set((await s.service.loadTaskWorkspace()).tasks[0].versions.map(v=>v.conditionVersion)).size).toBe(3);
    const plan=(await s.service.loadPlanningWorkspace()).workspace.plans[0];expect(plan.sourceChanged).toBe(true);expect(plan.workflow).toEqual(frozen);
  });
  it.each(['false','strategy','empty'])('合法未预生成条件可保存但拒绝复用旧结果：%s',async(kind)=>{
    const s=await setup(),value=input();if(kind==='false')value.demands[0].needBackup=false;
    else if(kind==='strategy')value.demands[0].routeStrategy='MIN_DELAY';else value.demands[0].needBackup=null;
    await saveTaskInput(s.storage,value,'ROUTING-TASK');
    await expect(s.service.submitPlanning({baseRevision:'initial',requestId:'no-match',taskId:'ROUTING-TASK',parentPlanVersionId:null,input:value})).rejects.toMatchObject({code:'NO_PRESET'});
    expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBeNull();
    expect((await s.service.loadTaskWorkspace()).tasks[0].versions[0].input).toEqual(value);
  });
  it('旧任务缺省改为null不增加业务条件版本，也不改写原版本',async()=>{
    const s=await setup(),old=structuredClone(planningPresets[0].input);await saveTaskInput(s.storage,old,'ROUTING-TASK');
    const first=(await s.service.loadTaskWorkspace()).tasks[0].versions[0],value=structuredClone(old);
    value.demands.forEach(d=>{d.routeStrategy=null;d.needBackup=null;});await saveTaskInput(s.storage,value,'ROUTING-TASK');
    const versions=(await s.service.loadTaskWorkspace()).tasks[0].versions;
    expect(versions.at(-1)!.conditionVersion).toBe(first.conditionVersion);expect(versions[0]).toEqual(first);
    expect(versions[0].input.demands[0]).not.toHaveProperty('needBackup');
  });
});

