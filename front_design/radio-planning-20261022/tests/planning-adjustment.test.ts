import { describe, expect, it } from 'vitest';
import { planningPresets } from '../src/mocks/planning-presets';
import { planningAdjustmentExamples } from '../src/mocks/planning-adjustments';
import { initialResources } from '../src/mocks/resource-presets';
import { assertPlanningAdjustmentResult, bindPlanningAdjustmentExample, createPlanningAdjustment, matchPlanningAdjustment, readPlanningAdjustment, validatePlanningAdjustment } from '../src/services/planning-adjustment';
import { createPlanningMock } from '../src/services/planning-mock';
import { initialMeta } from '../src/services/resource-storage';
import { normalizeResultInput } from '../src/services/planning-result-identity';
import type { PlanningAdjustmentContext } from '../src/types/planning-adjustment';
import type { PlanningSubmit } from '../src/types/planning';
import { TestStorage } from './helpers/storage';
import { savedRequest, taskMeta } from './helpers/tasks';

function context(): PlanningAdjustmentContext {
  return { id: 'parent', snapshotId: 'snapshot', input: structuredClone(planningPresets[0].input),
    configuration: structuredClone(planningPresets[0].result!.configuration), nodeIds: [...planningPresets[0].input.stationIds] };
}
async function scenario(presetId = 'balanced') {
  const storage = new TestStorage(); let time = 1000;
  const resources = initialResources(), meta = initialMeta();
  const service = createPlanningMock(() => storage, () => ({ resources, meta: { ...meta, taskWorkspace: taskMeta(storage) } }), () => time);
  const input = structuredClone(planningPresets.find(row => row.id === presetId)!.input);
  const submitted = await service.submitPlanning(await savedRequest(storage, { baseRevision: 'initial', requestId: 'first', taskId: null, parentPlanVersionId: null, input }));
  time += 10000;
  const saved = await service.savePlanVersion({ baseRevision: submitted.workspace.revision, jobId: submitted.view.job.id, requestId: 'save-first', name: '父方案', note: '' });
  const example = planningAdjustmentExamples.find(row => row.id === 'economical')!;
  const request: PlanningSubmit = { baseRevision: saved.workspace.revision, requestId: 'adjust', taskId: saved.plan.taskId,
    parentPlanVersionId: saved.plan.id, input: structuredClone(saved.plan.workflow!.input),
    adjustment: presetId === 'device-balanced' ? createPlanningAdjustment(saved.plan) : bindPlanningAdjustmentExample(example, saved.plan) };
  return { storage, service, resources, meta, parent: saved.plan, request, advance: () => { time += 10000; } };
}

describe('独立方案调整输入与完整预生成组合', () => {
  it('空覆盖沿用原值，0 与缺省分开，负高度和非有限数不接受', () => {
    const parent = context(), blank = createPlanningAdjustment(parent);
    expect(validatePlanningAdjustment(blank, parent)).toEqual([]);
    expect(readPlanningAdjustment({ ...blank, manualOverrides: [{ deviceId: 'DV-0001', txPowerDbm: 0, antennaHeightM: 0 }] }).manualOverrides[0].txPowerDbm).toBe(0);
    for (const value of [null, NaN, Infinity, '40']) expect(() => readPlanningAdjustment({ ...blank, manualOverrides: [{ deviceId: 'DV-0001', txPowerDbm: value }] })).toThrow();
    expect(() => readPlanningAdjustment({ ...blank, manualOverrides: [{ deviceId: 'DV-0001', antennaHeightM: -1 }] })).toThrow();
  });
  it.each(['duplicate-device', 'duplicate-demand', 'unknown-device', 'unknown-demand', 'unknown-node', 'duplicate-node', 'wrong-endpoint', 'wrong-parent', 'wrong-snapshot'])(
    '边界拒绝不合法输入：%s', kind => {
      const parent = context(), draft = bindPlanningAdjustmentExample(planningAdjustmentExamples[1], parent);
      if (kind === 'duplicate-device') draft.manualOverrides.push(structuredClone(draft.manualOverrides[0]));
      if (kind === 'duplicate-demand') draft.manualPaths.push(structuredClone(draft.manualPaths[0]));
      if (kind === 'unknown-device') draft.manualOverrides[0].deviceId = 'missing';
      if (kind === 'unknown-demand') draft.manualPaths[0].demandId = 'missing';
      if (kind === 'unknown-node') draft.manualPaths[1].nodePath.splice(1, 0, 'missing');
      if (kind === 'duplicate-node') draft.manualPaths[1].nodePath.splice(1, 0, 'ND-0001');
      if (kind === 'wrong-endpoint') draft.manualPaths[1].nodePath.reverse();
      if (kind === 'wrong-parent') draft.sourcePlanId = 'other';
      if (kind === 'wrong-snapshot') draft.sourceSnapshotId = 'other';
      expect(validatePlanningAdjustment(draft, parent).length).toBeGreaterThan(0);
    },
  );
  it('服务示例按需求关系映射自建 ID，填写不改父方案', () => {
    const parent = context(); parent.input.demands[0].id = 'custom-1'; parent.input.demands[1].id = 'custom-2'; parent.input.demands.reverse();
    const before = JSON.stringify(parent), draft = bindPlanningAdjustmentExample(planningAdjustmentExamples[1], parent);
    expect(draft.manualPaths.map(row => row.demandId)).toEqual(['custom-1', 'custom-2']);
    expect(JSON.stringify(parent)).toBe(before);
  });
  it('无父记录的独立历史核对声明值、对象归属及主路径，不把输入当结果', () => {
    const parent = context(), draft = bindPlanningAdjustmentExample(planningAdjustmentExamples[1], parent);
    const result = { ...parent, configuration: structuredClone(planningPresets[1].result!.configuration) };
    expect(() => assertPlanningAdjustmentResult(draft, result)).not.toThrow();
    for (const change of [
      (copy: typeof draft) => { copy.manualOverrides[0].deviceId = 'missing'; },
      (copy: typeof draft) => { copy.manualOverrides[0].txPowerDbm = 99; },
      (copy: typeof draft) => { copy.manualOverrides[0].antennaHeightM = 99; },
      (copy: typeof draft) => { copy.manualPaths[0].demandId = 'missing'; },
      (copy: typeof draft) => { copy.manualPaths[1].nodePath = ['ND-0001', 'ND-0004']; },
    ]) {
      const corrupted = structuredClone(draft); change(corrupted);
      expect(() => assertPlanningAdjustmentResult(corrupted, result)).toThrow();
    }
    // 省略项没有父记录可核实，仍按“沿用”含义保留，不能自行补生成值。
    expect(() => assertPlanningAdjustmentResult(createPlanningAdjustment(parent), result)).not.toThrow();
  });
  it('完整配置选择目标结果，单台功率和高度变化不冒充成功', async () => {
    const s = await scenario();
    expect(matchPlanningAdjustment(s.request.adjustment!, s.parent, planningPresets).id).toBe('economical');
    const single = createPlanningAdjustment(s.parent); single.manualOverrides = [{ deviceId: 'DV-0001', txPowerDbm: 40 }];
    expect(() => matchPlanningAdjustment(single, s.parent, planningPresets)).toThrowError(/暂无对应预生成结果/);
    const height = structuredClone(s.request.adjustment!); height.manualOverrides[0].antennaHeightM = 20;
    expect(() => matchPlanningAdjustment(height, s.parent, planningPresets)).toThrowError(/暂无对应预生成结果/);
    const otherPath = structuredClone(s.request.adjustment!); otherPath.manualPaths[1].nodePath = ['ND-0001', 'ND-0004'];
    expect(() => matchPlanningAdjustment(otherPath, s.parent, planningPresets)).toThrowError(/暂无对应预生成结果/);
  });
  it('结果身份归一化仍保留频率和业务条件，不能跳过输入匹配', async () => {
    const s = await scenario(), parent = structuredClone(s.parent);
    parent.workflow!.input.frequencyId = 'hf-limited';
    expect(normalizeResultInput(parent.workflow!.input, 'economical').frequencyId).toBe('hf-limited');
    expect(() => matchPlanningAdjustment(s.request.adjustment!, parent, planningPresets)).toThrowError(/暂无对应预生成结果/);
  });
  it('同请求返回原作业，改变调整输入重用请求标识拒绝且不写入', async () => {
    const s = await scenario(), first = await s.service.submitPlanning(s.request), writes = s.storage.writes;
    expect((await s.service.submitPlanning(s.request)).view.job.id).toBe(first.view.job.id);
    const changed = structuredClone(s.request); changed.adjustment!.manualOverrides[0].txPowerDbm = 45;
    await expect(s.service.submitPlanning(changed)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(s.storage.writes).toBe(writes);
  });
  it('父快照篡改、混入其他任务条件和未知组合均不创建作业', async () => {
    const s = await scenario(), writes = s.storage.writes;
    const invalid = structuredClone(s.request); invalid.adjustment!.sourceSnapshotId = 'other';
    await expect(s.service.submitPlanning(invalid)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const changed = structuredClone(s.request); changed.input.description = '另一组输入';
    await expect(s.service.submitPlanning(changed)).rejects.toMatchObject({ code: 'INVALID_PARENT' });
    const unsupported = structuredClone(s.request); unsupported.adjustment!.manualOverrides[0].antennaHeightM = 20;
    await expect(s.service.submitPlanning(unsupported)).rejects.toMatchObject({ code: 'NO_PRESET' });
    expect(s.storage.writes).toBe(writes);
  });
  it('来源变化不能调整，设备档不降级为站点档', async () => {
    const s = await scenario(); s.meta.stationVersions['ND-0001'] = 'changed';
    await expect(s.service.submitPlanning(s.request)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    const device = await scenario('device-balanced');
    await expect(device.service.submitPlanning(device.request)).rejects.toMatchObject({ code: 'NO_PRESET' });
  });
  it('调整失败写入保留旧存储，取消后新结果不复活', async () => {
    const s = await scenario(); s.storage.failWrite = true;
    await expect(s.service.submitPlanning(s.request)).rejects.toMatchObject({ code: 'PLANNING_WRITE_FAILED' });
    s.storage.failWrite = false;
    expect((await s.service.loadPlanningWorkspace()).workspace.jobs).toHaveLength(1);
    const submitted = await s.service.submitPlanning(s.request);
    await s.service.cancelPlanningJob({ baseRevision: submitted.workspace.revision, jobId: submitted.view.job.id });
    s.advance(); const view = await s.service.getPlanningJob(submitted.view.job.id);
    expect(view.state).toBe('CANCELLED'); expect(view.result).toBeNull(); expect(view.job.adjustment).toEqual(s.request.adjustment);
  });
});
