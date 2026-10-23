import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMockService } from '../src/services/mock';
import { optionsPlanningPresets } from '../src/mocks/planning-options-presets';
import { planningAdjustmentExamples } from '../src/mocks/planning-adjustments';
import { bindPlanningAdjustmentExample } from '../src/services/planning-adjustment';
import { TestStorage } from './helpers/storage';
import { savedRequest } from './helpers/tasks';
import { PLANNING_PHASE_MS, PLANNING_TTL_MS } from '../src/config/demo';

afterEach(() => vi.useRealTimers());
async function setup(id = 'options-min') {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
  const storage = new TestStorage(), service = createMockService(() => storage);
  const input = structuredClone(optionsPlanningPresets.find(p => p.id === id)!.input);
  const submitted = await service.submitPlanning(await savedRequest(storage, { input, taskId: 'OPTIONS-TASK', parentPlanVersionId: null, requestId: 'submit', baseRevision: 'initial' }));
  const advance = (ms = PLANNING_PHASE_MS * 7) => vi.setSystemTime(Date.now() + ms);
  advance(); const view = await service.getPlanningJob(submitted.view.job.id);
  let revision = submitted.workspace.revision;
  const save = async (index: number, requestId = 'save-' + index) => {
    const s = view.solutions![index];
    const value = await service.savePlanVersion({ baseRevision: revision, jobId: view.job.id, solutionId: s.solutionId, snapshotId: s.result!.snapshotId, requestId, name: s.label, note: '' });
    revision = value.workspace.revision; return value;
  };
  return { service, storage, submitted, view, save, advance, revision: () => revision };
}
// 同作业的结果必须各自保存，不能只验证新增字段存在。
describe('多份完整规划结果', () => {
  it('运行中不展示结果，完成后两份快照独立且可分别保存比较', async () => {
    const s = await setup(); expect(s.submitted.view.solutions).toEqual([]); expect(s.submitted.view.result).toBeNull();
    expect(s.view.solutions).toHaveLength(2);
    expect(new Set(s.view.solutions!.map(v => v.result!.snapshotId)).size).toBe(2);
    const a = await s.save(0), b = await s.save(1);
    expect(a.plan.jobId).toBe(b.plan.jobId); expect(a.plan.id).not.toBe(b.plan.id); expect(a.plan.solutionId).not.toBe(b.plan.solutionId);
    expect((await s.service.comparePlanVersions([a.plan.id, b.plan.id])).map(p => p.metrics.totalRadiatedPowerW)).toEqual([190, 60]);
    expect((await s.service.getPlanningJob(s.view.job.id)).solutions!.map(v => v.savedPlanId)).toEqual([a.plan.id, b.plan.id]);
    const loaded = await createMockService(() => s.storage).loadPlanningWorkspace(); expect(loaded.workspace.plans).toHaveLength(2);
    expect(loaded.presets.some(p => p.hidden)).toBe(false);
  });
  it('两个保存版本可先后确认，原快照保留且仅一个当前指向', async () => {
    const s = await setup(), a = await s.save(0), b = await s.save(1);
    const first = await s.service.confirmPlanVersion({ baseRevision: b.workspace.revision, planId: a.plan.id, requestId: 'confirm-a' });
    const second = await s.service.confirmPlanVersion({ baseRevision: first.workspace.revision, planId: b.plan.id, requestId: 'confirm-b' });
    expect(second.workspace.currentConfirmedByTask[a.plan.taskId]).toBe(b.plan.id);
    expect(second.workspace.plans[0].snapshotId).toBe(a.plan.snapshotId);
  });
  it('保存A不延长B的有效期，已保存版本仍可读', async () => {
    const s = await setup(), a = await s.save(0); s.advance(PLANNING_TTL_MS);
    const view = await s.service.getPlanningJob(s.view.job.id);
    expect(view.solutions!.map(v => [v.expired, !!v.result])).toEqual([[false, true], [true, false]]);
    await expect(s.save(1)).rejects.toMatchObject({ code: 2001 });
    expect((await s.service.loadPlanningWorkspace()).workspace.plans[0].id).toBe(a.plan.id);
  });
  it('同一结果重复保存及换结果重用请求ID均拒绝', async () => {
    const s = await setup(), first = await s.save(0, 'one');
    expect((await s.save(0, 'one')).plan.id).toBe(first.plan.id);
    await expect(s.save(1, 'one')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(s.save(0, 'two')).rejects.toMatchObject({ code: 'ALREADY_SAVED' });
  });
  it('缺少结果身份或快照不允许保存默认项', async () => {
    const s = await setup(), request = { baseRevision: s.revision(), jobId: s.view.job.id, requestId: 'bad', name: '坏关联', note: '' };
    await expect(s.service.savePlanVersion(request)).rejects.toMatchObject({ code: 'INVALID_RESULT' });
    await expect(s.service.savePlanVersion({ ...request, solutionId: s.view.solutions![0].solutionId, snapshotId: 'other' })).rejects.toMatchObject({ code: 'INVALID_RESULT' });
  });
  it('期望3份只返回1份，不填补结果', async () => {
    const s = await setup('options-fixed'); expect(s.view.job.input.deploymentSolve?.fixedCount).toBe(0);
    expect(s.view.job.input.deploymentSolve?.solutionCount).toBe(3); expect(s.view.solutions).toHaveLength(1);
    expect((await s.save(0)).plan.state).toBe('SAVED');
  });
  it('频率缺口保留建议，没有结果不能保存', async () => {
    const s = await setup('options-gap'); expect(s.view.solutions).toEqual([]); expect(s.view.outcome?.code).toBe(3002);
    expect(s.view.outcome?.gap.length).toBeGreaterThan(0);
    await expect(s.service.savePlanVersion({ baseRevision: s.revision(), jobId: s.view.job.id, requestId: 'bad', name: '无结果', note: '' })).rejects.toMatchObject({ code: 'INVALID_RESULT' });
  });
  it('关键桥参考可保存不可确认，关联需求取冻结身份', async () => {
    const s = await setup('options-bridge'), saved = await s.save(0);
    expect(saved.plan.state).toBe('REFERENCE');
    expect(saved.plan.resultDetails?.optimization?.criticalBridges?.[0].affectedDemandIds).toEqual(s.view.job.input.demands.map(d => d.id));
    await expect(s.service.confirmPlanVersion({ baseRevision: saved.workspace.revision, planId: saved.plan.id, requestId: 'bad-confirm' })).rejects.toMatchObject({ code: 'NOT_CONFIRMABLE' });
  });
  it('原备选可有限调整为另一固定输出，父输入与集合不被改写', async () => {
    const s = await setup(), parent = await s.save(0), bytes = JSON.stringify(s.view.job.solutions);
    const adjustment = bindPlanningAdjustmentExample(planningAdjustmentExamples.find(e => e.id === 'economical')!, parent.plan);
    const adjusted = await s.service.submitPlanning({ baseRevision: parent.workspace.revision, requestId: 'adjust', taskId: parent.plan.taskId, parentPlanVersionId: parent.plan.id, input: structuredClone(parent.plan.workflow!.input), adjustment });
    s.advance(); const child = await s.service.getPlanningJob(adjusted.view.job.id);
    expect(child.solutions).toBeUndefined(); expect(child.result?.metrics.totalRadiatedPowerW).toBe(60);
    const saved = await s.service.savePlanVersion({ baseRevision: adjusted.workspace.revision, jobId: child.job.id, requestId: 'adjust-save', name: '调整子版', note: '' });
    expect(saved.plan.workflow!.input).toEqual(parent.plan.workflow!.input);
    expect(JSON.stringify(saved.workspace.jobs[0].solutions)).toBe(bytes);
  });
});
