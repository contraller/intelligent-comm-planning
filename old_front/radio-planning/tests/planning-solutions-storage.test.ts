import { afterEach,describe,expect,it,vi } from 'vitest';
import { createMockService } from '../src/services/mock';
import { optionsPlanningPresets } from '../src/mocks/planning-options-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import { PLANNING_PHASE_MS,PLANNING_STORAGE_KEY } from '../src/config/demo';
import { TestStorage } from './helpers/storage';
import { savedRequest } from './helpers/tasks';
afterEach(()=>vi.useRealTimers());
async function setup(legacy=false){vi.useFakeTimers();const storage=new TestStorage(),service=createMockService(()=>storage),input=structuredClone((legacy?planningPresets[0]:optionsPlanningPresets[0]).input);const submitted=await service.submitPlanning(await savedRequest(storage,{input,taskId:'storage-task',parentPlanVersionId:null,requestId:'run',baseRevision:'initial'}));vi.setSystemTime(Date.now()+PLANNING_PHASE_MS*7);const view=await service.getPlanningJob(submitted.view.job.id);if(!legacy)await service.savePlanVersion({jobId:view.job.id,baseRevision:submitted.workspace.revision,requestId:'save',name:'保存A',note:'',solutionId:view.solutions![0].solutionId,snapshotId:view.solutions![0].result!.snapshotId});return{service,storage};}
// 篡改身份必须报告损坏，读取不回写或静默修复历史。
describe('多结果持久化边界',()=>{
  it.each(['duplicate-id','duplicate-snapshot','unknown-result','default','flow-id','flow-snapshot','missing-solutions','forged-projection','changed-metric','changed-input','changed-optimization'])('拒绝损坏 %s 并原样保留存储',async kind=>{const s=await setup(),raw=JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!),job=raw.jobs[0],plan=raw.plans[0];
    if(kind==='duplicate-id')job.solutions[1].solutionId=job.solutions[0].solutionId;
    if(kind==='duplicate-snapshot')job.solutions[1].result.snapshotId=job.snapshotId;
    if(kind==='unknown-result')job.solutions[1].resultPresetId='balanced';
    if(kind==='default')job.defaultSolutionId='unknown';
    if(kind==='flow-id')plan.solutionId=job.solutions[1].solutionId;
    if(kind==='flow-snapshot')plan.snapshotId=job.solutions[1].result.snapshotId;
    if(kind==='missing-solutions')delete job.solutions;
    if(kind==='forged-projection')job.solutionOrigin=job.solutions[0];
    if(kind==='changed-metric')job.solutions[1].result.metrics.totalRadiatedPowerW++;
    if(kind==='changed-input')job.input.deploymentSolve.solutionCount++;
    if(kind==='changed-optimization')job.solutions[1].result.resultDetails.optimization.tradeoff[0].survivabilityPercent++;
    const bytes=JSON.stringify(raw),writes=s.storage.writes;s.storage.entries.set(PLANNING_STORAGE_KEY,bytes);await expect(s.service.loadPlanningWorkspace()).rejects.toMatchObject({code:'PLANNING_CORRUPT'});expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);expect(s.storage.writes).toBe(writes);
  });
  it('旧单结果读取不补集合或新输入字段，也不写回',async()=>{const s=await setup(true),bytes=s.storage.getItem(PLANNING_STORAGE_KEY),writes=s.storage.writes;const loaded=await s.service.loadPlanningWorkspace();expect(loaded.workspace.jobs[0]).not.toHaveProperty('solutions');expect(loaded.workspace.jobs[0].input).not.toHaveProperty('deploymentSolve');expect(s.storage.writes).toBe(writes);expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(bytes);});
  it('保存配额失败不产生半个版本或改变另一结果',async()=>{const s=await setup(),loaded=await s.service.loadPlanningWorkspace(),job=loaded.workspace.jobs[0],other=job.solutions![1],before=s.storage.getItem(PLANNING_STORAGE_KEY);s.storage.failWrite=true;await expect(s.service.savePlanVersion({baseRevision:loaded.workspace.revision,jobId:job.id,solutionId:other.solutionId,snapshotId:other.result.snapshotId,requestId:'save-b',name:'B',note:''})).rejects.toThrow();expect(s.storage.getItem(PLANNING_STORAGE_KEY)).toBe(before);});
});
