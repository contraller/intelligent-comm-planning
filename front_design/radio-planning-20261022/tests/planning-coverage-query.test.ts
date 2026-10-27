import { describe, expect, it } from 'vitest';
import { resolvePlanningCoverageQuery, type PlanningCoverageSource } from '../src/services/planning-coverage-query';
import { apiJob, apiPlan } from './fixtures/planning-api';
import { createPlanningAdjustment } from '../src/services/planning-adjustment';
function fixture(): PlanningCoverageSource {
  const parent = apiPlan(), job = apiJob();
  job.parentPlanId = parent.id;
  job.adjustment = createPlanningAdjustment({id:parent.id,snapshotId:parent.result.snapshotId,input:parent.input,configuration:parent.result.configuration,nodeIds:parent.result.nodes.map(n=>n.id)});
  job.result!.snapshotId = 'CANDIDATE-SNAPSHOT';
  return {selectedPlan:null, adjustmentParent:parent, adjustmentResult:job.result, job,
    inAdjustment:true,previewSide:'after',dirty:false,running:false,pending:false};
}
describe('方案覆盖身份与调整快照', () => {
  it('未保存候选绑定成功作业和实际快照，不保存或改写父方案', () => {
    const source=fixture(), parent=structuredClone(source.adjustmentParent);
    expect(resolvePlanningCoverageQuery(source)).toEqual({planId:'PREVIEW-J1',taskId:'T1',snapshotId:'CANDIDATE-SNAPSHOT',resourceRevision:'r1',context:'planning'});
    expect(source.adjustmentParent).toEqual(parent);expect(source.selectedPlan).toBeNull();
  });
  it.each(['dirty','running','pending'] as const)('%s时不回退到原方案旧覆盖', flag => {
    const source=fixture();source[flag]=true;expect(resolvePlanningCoverageQuery(source)).toBeNull();
  });
  it('调整前地图只展示父方案覆盖，调整后才显示候选覆盖', () => {
    const source=fixture();source.previewSide='before';
    expect(resolvePlanningCoverageQuery(source)?.planId).toBe(source.adjustmentParent!.id);
    expect(resolvePlanningCoverageQuery(source)?.snapshotId).toBe(source.adjustmentParent!.result.snapshotId);
    source.previewSide='after';expect(resolvePlanningCoverageQuery(source)?.planId).toBe('PREVIEW-J1');
  });
  it.each(['task','parent','snapshot','failed'] as const)('拒绝%s不一致的候选快照', kind => {
    const source=fixture();
    if(kind==='task')source.job!.taskId='OTHER';
    if(kind==='parent')source.job!.parentPlanId='OTHER';
    if(kind==='snapshot')source.adjustmentResult={...source.adjustmentResult!,snapshotId:'OTHER'};
    if(kind==='failed')source.job!.state='FAILED';
    expect(resolvePlanningCoverageQuery(source)?.planId).not.toBe('PREVIEW-J1');
  });
  it('只读查看已保存版本不会取调整候选的覆盖', () => {
    const source=fixture();source.inAdjustment=false;source.selectedPlan=source.adjustmentParent;
    expect(resolvePlanningCoverageQuery(source)?.planId).toBe(source.selectedPlan!.id);
    expect(resolvePlanningCoverageQuery(source)?.snapshotId).toBe(source.selectedPlan!.result.snapshotId);
  });
});

describe('候选覆盖保存后的版本关联',()=>{
  it('仅复用同job、任务、快照及资源的实际候选来源，不改写anchor',()=>{
    const source=fixture(), query=resolvePlanningCoverageQuery(source)!;
    source.selectedPlan={...source.adjustmentParent!,jobId:source.job!.id,result:source.adjustmentResult!};source.inAdjustment=false;source.candidateOrigins=[query];
    expect(resolvePlanningCoverageQuery(source)).toEqual(query);expect(resolvePlanningCoverageQuery(source)?.planId).toBe('PREVIEW-J1');
    source.selectedPlan={...source.selectedPlan,result:{...source.selectedPlan.result,snapshotId:'DIFFERENT'}};
    expect(resolvePlanningCoverageQuery(source)?.planId).toBe(source.selectedPlan.id);
  });
});
