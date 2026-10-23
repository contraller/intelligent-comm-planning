import { interferenceFixture } from './helpers/interference';
import { savedRequest,taskMeta } from './helpers/tasks';
import { authorizeStore } from './helpers/auth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { planningPresets } from '../src/mocks/planning-presets';
import { planningAdjustmentExamples } from '../src/mocks/planning-adjustments';
import { bindPlanningAdjustmentExample } from '../src/services/planning-adjustment';
import { RESOURCE_STORAGE_KEY } from '../src/config/demo';
import { PLANNING_STORAGE_KEY, PLANNING_PHASE_MS, PLANNING_TTL_MS } from '../src/config/demo';
import { createMockService } from '../src/services/mock';
import { createPlanningMock } from '../src/services/planning-mock';
import { initialMeta } from '../src/services/resource-storage';
import { initialResources } from '../src/mocks/resource-presets';
import { assertResult, checksPass, resultForJob } from '../src/services/planning-validation';
import resources from '../src/mocks/resources.json';
import type { ResourcesData } from '../src/types/domain';
import type { PlanningSubmit } from '../src/types/planning';
import { TestStorage } from './helpers/storage';
import { previewService } from '../src/services';
import { usePlanningStore } from '../src/stores/planning';
import { usePreviewStore } from '../src/stores/preview';
import type { PlanningJobView } from '../src/types/planning';

// 假时钟验证刷新和后台时间轴，不等待真实计算或调用算法。
export function setupPlanning() {
  const storage = new TestStorage();
  const resourcesService = createMockService(() => storage);
  let current = { resources: structuredClone(resources) as ResourcesData, meta: initialMeta() };
  let time = Date.parse('2026-10-03T00:00:00Z');
  const service = createPlanningMock(
    () => storage,
    () => ({...current,meta:{...current.meta,taskWorkspace:taskMeta(storage)}}),
    () => time,
  );
  const advance = (milliseconds = PLANNING_PHASE_MS * 6) => {
    time += milliseconds;
  };
  const request = (preset = 'balanced'): PlanningSubmit => ({
    baseRevision: 'initial',
    requestId: crypto.randomUUID(),
    taskId: null,
    parentPlanVersionId: null,
    input: structuredClone(planningPresets.find((p) => p.id === preset)!.input),
  });
  const commit = async (
    stations: { id: string; name: string }[],
    devices: { id: string; antennaHeightM: number }[] = [],
  ) => {
    current = await resourcesService.commitResources({
      baseRevision: current.meta.revision,
      stations,
      devices,
    });
  };
  const resetResources = async () => {
    current = await resourcesService.resetResources(current.meta.revision);
  };
  return { storage, resourcesService, service, advance, request, commit, resetResources };
}
describe('规划任务与方案流程', () => {
  it('独立调整多代保存原任务条件、需求身份和父快照，结果随目标完整切换', async () => {
    const s = setupPlanning(), original = s.request();
    original.input.demands[0].id = 'my-demand-1'; original.input.demands[1].id = 'my-demand-2';
    original.input.demands.reverse();
    const first = await s.service.submitPlanning(await savedRequest(s.storage, original)); s.advance();
    let saved = await s.service.savePlanVersion({ baseRevision: first.workspace.revision, jobId: first.view.job.id, requestId: 'parent-save', name: '父方案', note: '' });
    const parentBytes = JSON.stringify(saved.plan), taskBytes = s.storage.getItem(RESOURCE_STORAGE_KEY);
    for (const target of ['economical', 'balanced']) {
      const parent = saved.plan, adjustment = bindPlanningAdjustmentExample(planningAdjustmentExamples.find(row => row.id === target)!, parent);
      const submitted = await s.service.submitPlanning({ baseRevision: saved.workspace.revision, requestId: 'adjust-' + target,
        taskId: parent.taskId, parentPlanVersionId: parent.id, input: structuredClone(parent.workflow!.input), adjustment });
      expect(submitted.view.job.input.presetId).toBe('balanced'); expect(submitted.view.job.resultPresetId).toBe(target);
      s.advance(); const view = await s.service.getPlanningJob(submitted.view.job.id);
      expect(view.result!.configuration.routes.every(route => ['my-demand-1', 'my-demand-2'].includes(route.demandId))).toBe(true);
      expect(view.result!.metrics.totalRadiatedPowerW).toBe(target === 'economical' ? 60 : 190);
      expect(view.result!.configuration.routes.find(route => route.demandId === 'my-demand-2' && !route.backup)!.nodeIds)
        .toEqual(target === 'economical' ? ['ND-0001', 'ND-0003', 'ND-0004'] : ['ND-0001', 'ND-0004']);
      assertResult(view.result!, view.job.input, target);
      saved = await s.service.savePlanVersion({ baseRevision: submitted.workspace.revision, jobId: submitted.view.job.id, requestId: 'save-' + target, name: target, note: '' });
      expect(saved.plan.workflow!.adjustment).toEqual(adjustment);
      expect(saved.plan.workflow!.dependencies).toEqual(parent.workflow!.dependencies);
    }
    expect(s.storage.getItem(RESOURCE_STORAGE_KEY)).toBe(taskBytes);
    expect(JSON.stringify(saved.workspace.plans[0])).toBe(parentBytes);
    expect(saved.workspace.plans.every(plan => !plan.sourceChanged)).toBe(true);
  });
  it('任务仅改名称说明后仍可调整有效父版本，作业保留父输入不覆盖任务库', async () => {
    const s = setupPlanning(), first = await s.service.submitPlanning(await savedRequest(s.storage, s.request())); s.advance();
    const saved = await s.service.savePlanVersion({ baseRevision: first.workspace.revision, jobId: first.view.job.id, requestId: 'parent', name: '父方案', note: '' });
    const renamed = structuredClone(saved.plan.workflow!.input); renamed.name = '新的任务名称'; renamed.description = '仅更新说明';
    await savedRequest(s.storage, { ...s.request(), taskId: saved.plan.taskId, input: renamed });
    const bytes = s.storage.getItem(RESOURCE_STORAGE_KEY), condition = taskMeta(s.storage)!.tasks.find(row => row.id === saved.plan.taskId)!.versions.at(-1)!.conditionVersion;
    expect(condition).toBe(saved.plan.workflow!.dependencies.task!.conditionVersion);
    const loaded = await s.service.loadPlanningWorkspace(); expect(loaded.workspace.plans[0].sourceChanged).toBe(false);
    const adjusted = await s.service.submitPlanning({ baseRevision: loaded.workspace.revision, requestId: 'adjust-renamed', taskId: saved.plan.taskId,
      parentPlanVersionId: saved.plan.id, input: structuredClone(saved.plan.workflow!.input), adjustment: bindPlanningAdjustmentExample(planningAdjustmentExamples[1], saved.plan) });
    expect(adjusted.view.job.input).toEqual(saved.plan.workflow!.input);
    expect(s.storage.getItem(RESOURCE_STORAGE_KEY)).toBe(bytes);
  });
  it('六阶段推进、冻结输入、刷新后按持久化时间轴恢复', async () => {
    const s = setupPlanning();
    const request = s.request();
    const submitted = await s.service.submitPlanning(await savedRequest(s.storage,request));
    expect(submitted.view.state).toBe('PENDING');
    request.input.name = '后续编辑';
    s.advance(1600);
    expect((await s.service.getPlanningJob(submitted.view.job.id)).phases[0].state).toBe('done');
    expect((await s.service.loadPlanningWorkspace()).workspace.jobs[0].input.name).not.toBe(
      '后续编辑',
    );
    s.advance();
    const result = await s.service.getPlanningJob(submitted.view.job.id);
    expect(result.state).toBe('SUCCESS');
    expect(result.progress).toBe(100);
    expect(result.result!.metrics.connectivityPercent).toBe(100);
    expect(
      new Set([
        result.job.id,
        result.job.taskId,
        result.job.inputVersion,
        result.result!.snapshotId,
      ]).size,
    ).toBe(4);
    assertResult(result.result!, result.job.input);
  });
  it('查询只读 Job 冻结明细，核心预设的附加字段不能回填旧任务', async () => {
    const s = setupPlanning(), submitted = await s.service.submitPlanning(await savedRequest(s.storage, s.request()));
    const job = structuredClone(submitted.view.job), preset = structuredClone(planningPresets[0]);
    // 仅修改测试副本，模拟未来核心结果意外携带明细。
    preset.result!.resultDetails = structuredClone(job.resultDetails!);
    delete job.resultDetails;
    expect(resultForJob(job, preset)).not.toHaveProperty('resultDetails');
    job.resultDetails = structuredClone(submitted.view.job.resultDetails!);
    preset.result!.resultDetails.assetVersion = 'new-catalog-value';
    expect(resultForJob(job, preset)!.resultDetails).toEqual(submitted.view.job.resultDetails);
  });
  it.each(['requiredRateKbps', 'maxDelayMs', 'minReliability'] as const)(
    '必填数值空值不能变成 0：%s',
    async (field) => {
      const s = setupPlanning();
      const r = s.request();
      r.input.demands[0][field] = null;
      await expect(s.service.submitPlanning(r)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(s.storage.writes).toBe(0);
    },
  );
  it('合法但不匹配的需求与资源明确报出对象字段，不复用结果', async () => {
    const s = setupPlanning();
    const r = s.request();
    r.input.demands[0].requiredRateKbps = 3;
    await expect(s.service.submitPlanning(await savedRequest(s.storage,r))).rejects.toMatchObject({
      code: 'NO_PRESET',
      data: expect.arrayContaining([expect.objectContaining({ field: 'demands' })]),
    });
    await s.commit([], [{ id: 'DV-0001', antennaHeightM: 12 }]);
    await expect(s.service.submitPlanning(await savedRequest(s.storage,s.request()))).rejects.toMatchObject({
      code: 'NO_PRESET',
      data: expect.arrayContaining([
        expect.objectContaining({ objectId: 'DV-0001', field: 'antennaHeightM' }),
      ]),
    });
  });
  it('自建需求 ID 与改变排列顺序可匹配，结果引用使用实际 ID', async () => {
    const s = setupPlanning();
    const r = s.request();
    r.input.demands[0].id = 'custom';
    r.input.demands.reverse();
    r.input.stationIds.reverse();
    const submitted = await s.service.submitPlanning(await savedRequest(s.storage,r));
    s.advance();
    const view = await s.service.getPlanningJob(submitted.view.job.id);
    expect(view.result!.configuration.routes.some((route) => route.demandId === 'custom')).toBe(
      true,
    );
    // 明细与核心路由共用端点身份映射，不依赖需求顺序。
    expect(view.result!.resultDetails!.routeQuality!.some(row => row.demandId === 'custom')).toBe(true);
    assertResult(view.result!, r.input);
  });
  it('同时最多一个任务，相同请求幂等，不同输入重用标识拒绝', async () => {
    const s = setupPlanning();
    const r = s.request();
    const a = await s.service.submitPlanning(await savedRequest(s.storage,r));
    expect((await s.service.submitPlanning(await savedRequest(s.storage,r))).view.job.id).toBe(a.view.job.id);
    await expect(
      s.service.submitPlanning(await savedRequest(s.storage,{ ...s.request(), baseRevision: a.workspace.revision })),
    ).rejects.toMatchObject({ code: 'JOB_RUNNING' });
    r.input.description = 'changed';
    await expect(s.service.submitPlanning(await savedRequest(s.storage,r))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(s.storage.writeHistory.filter(k=>k===PLANNING_STORAGE_KEY)).toHaveLength(1);
  });
  it('取消先落盘；失败保留状态，成功后旧时间轴不能复活结果', async () => {
    const s = setupPlanning();
    const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
    s.storage.failWrite = true;
    await expect(
      s.service.cancelPlanningJob({ baseRevision: a.workspace.revision, jobId: a.view.job.id }),
    ).rejects.toMatchObject({ code: 'PLANNING_WRITE_FAILED' });
    expect((await s.service.getPlanningJob(a.view.job.id)).state).toBe('PENDING');
    s.storage.failWrite = false;
    await s.service.cancelPlanningJob({ baseRevision: a.workspace.revision, jobId: a.view.job.id });
    s.advance();
    expect((await s.service.getPlanningJob(a.view.job.id)).state).toBe('CANCELLED');
    expect((await s.service.getPlanningJob(a.view.job.id)).result).toBeNull();
  });
  it.each(['constrained', 'shortage', 'execution-failed'])(
    '业务分支和执行失败区分：%s',
    async (preset) => {
      const s = setupPlanning();
      const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request(preset)));
      s.advance();
      const view = await s.service.getPlanningJob(a.view.job.id);
      expect(view.state).toBe(preset === 'execution-failed' ? 'FAILED' : 'SUCCESS');
      expect(a.view.job.resultDetails !== undefined).toBe(preset === 'constrained');
      if (preset === 'execution-failed') expect(view.error).toContain('服务异常');
      else {
        expect(view.outcome!.gap.length).toBeGreaterThan(0);
        expect(view.outcome!.suggestions.length).toBeGreaterThan(0);
      }
      if (preset !== 'constrained')
        await expect(
          s.service.savePlanVersion({
            baseRevision: a.workspace.revision,
            jobId: a.view.job.id,
            requestId: 'save',
            name: '参考',
            note: '',
          }),
        ).rejects.toMatchObject({ code: 'NO_RESULT' });
    },
  );
  it('未达标的完整结果保存 REFERENCE 且不可确认', async () => {
    const s = setupPlanning();
    const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request('constrained')));
    s.advance();
    const saved = await s.service.savePlanVersion({
      baseRevision: a.workspace.revision,
      jobId: a.view.job.id,
      requestId: 'save',
      name: '参考',
      note: '',
    });
    expect(saved.plan.state).toBe('REFERENCE');
    expect(saved.plan.resultDetails).toEqual(a.view.job.resultDetails);
    await expect(
      s.service.confirmPlanVersion({
        baseRevision: saved.workspace.revision,
        planId: saved.plan.id,
        requestId: 'confirm',
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIRMABLE' });
  });
  it('保存、确认幂等；调整新版本替换当前指针但保留历史配置', async () => {
    const s = setupPlanning();
    const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
    s.advance();
    const save = {
      baseRevision: a.workspace.revision,
      jobId: a.view.job.id,
      requestId: 'save',
      name: '均衡方案',
      note: '',
    };
    const saved = await s.service.savePlanVersion(save);
    // 保存、确认与重试只复制已提交的明细，不重新取目录值。
    const frozenDetails = structuredClone(a.view.job.resultDetails!);
    expect((await s.service.getPlanningJob(a.view.job.id)).result!.resultDetails).toEqual(frozenDetails);
    expect(saved.plan.resultDetails).toEqual(frozenDetails);
    expect((await s.service.savePlanVersion(save)).plan.id).toBe(saved.plan.id);
    const confirm = {
      baseRevision: saved.workspace.revision,
      planId: saved.plan.id,
      requestId: 'confirm',
    };
    const confirmed = await s.service.confirmPlanVersion(confirm);
    expect(confirmed.plan.resultDetails).toEqual(frozenDetails);
    expect(confirmed.plan.workflow!.confirmation!.configuration).not.toHaveProperty('resultDetails');
    saved.plan.resultDetails!.deviceParameters![0].tiltDeg = 99;
    expect((await s.service.savePlanVersion(save)).plan.resultDetails).toEqual(frozenDetails);
    expect((await s.service.confirmPlanVersion(confirm)).plan.workflow!.confirmation).toEqual(
      confirmed.plan.workflow!.confirmation,
    );
    const b = await s.service.submitPlanning(await savedRequest(s.storage,{
      ...s.request('economical'),
      taskId: a.view.job.taskId,
      parentPlanVersionId: saved.plan.id,
      baseRevision: confirmed.workspace.revision,
    }));
    s.advance();
    const second = await s.service.savePlanVersion({
      baseRevision: b.workspace.revision,
      jobId: b.view.job.id,
      requestId: 'save2',
      name: '节能方案',
      note: '有限调整',
    });
    const final = await s.service.confirmPlanVersion({
      baseRevision: second.workspace.revision,
      planId: second.plan.id,
      requestId: 'confirm2',
    });
    expect(final.workspace.currentConfirmedByTask[a.view.job.taskId]).toBe(second.plan.id);
    expect(final.workspace.plans[0]).toEqual({...confirmed.plan,sourceChanged:true});
    expect(second.plan.workflow!.parentPlanVersionId).toBe(saved.plan.id);
    expect(
      (await s.service.comparePlanVersions([saved.plan.id, second.plan.id])).map(
        (p) => p.metrics.totalRadiatedPowerW,
      ),
    ).toEqual([190, 60]);
    await expect(s.service.comparePlanVersions(['PLAN-V1', second.plan.id])).rejects.toMatchObject({
      code: 'INCOMPARABLE',
    });
    expect(
      (await s.service.comparePlanVersions(['PLAN-V1', 'PLAN-V2']))[0].workflow,
    ).toBeUndefined();
  });
  it('无关资源变更不失效，相关对象改回或重置均不能重新认证', async () => {
    const s = setupPlanning();
    const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
    s.advance();
    await s.commit([{ id: 'ND-0100', name: '无关修改' }]);
    expect((await s.service.getPlanningJob(a.view.job.id)).sourceChanged).toBe(false);
    const saved = await s.service.savePlanVersion({
      baseRevision: a.workspace.revision,
      jobId: a.view.job.id,
      requestId: 'save',
      name: '方案',
      note: '',
    });
    await s.commit([{ id: 'ND-0001', name: '相关修改' }]);
    await s.commit([{ id: 'ND-0001', name: resources.stations[0].name }]);
    expect((await s.service.loadPlanningWorkspace()).workspace.plans[0].sourceChanged).toBe(true);
    await expect(
      s.service.confirmPlanVersion({
        baseRevision: saved.workspace.revision,
        planId: saved.plan.id,
        requestId: 'confirm',
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await s.resetResources();
    expect((await s.service.loadPlanningWorkspace()).workspace.plans[0].sourceChanged).toBe(true);
  });
  it('生成后资源变化，保存保留原依赖并作为历史参考', async () => {
    const s = setupPlanning();
    const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
    s.advance();
    await s.commit([], [{ id: 'DV-0001', antennaHeightM: 10 }]);
    const saved = await s.service.savePlanVersion({
      baseRevision: a.workspace.revision,
      jobId: a.view.job.id,
      requestId: 'save',
      name: '历史',
      note: '',
    });
    expect(saved.plan.state).toBe('REFERENCE');
    expect(saved.plan.workflow!.dependencies).toEqual(a.view.job.dependencies);
  });
  it('未保存结果 24 小时过期，已保存版本与结果继续可读', async () => {
    const s = setupPlanning();
    const a = await s.service.submitPlanning(await savedRequest(s.storage,s.request()));
    s.advance(PLANNING_TTL_MS);
    await expect(s.service.getPlanningJob(a.view.job.id)).rejects.toMatchObject({
      code: 2001,
      data: { expired: true },
    });
    const b = await s.service.submitPlanning(await savedRequest(s.storage,{
      ...s.request(),
      baseRevision: a.workspace.revision,
    }));
    s.advance();
    await s.service.savePlanVersion({
      baseRevision: b.workspace.revision,
      jobId: b.view.job.id,
      requestId: 'save',
      name: '保留',
      note: '',
    });
    s.advance(PLANNING_TTL_MS);
    expect((await s.service.getPlanningJob(b.view.job.id)).expired).toBe(false);
  });
  it('缺失或未知校验不视为通过', () => {
    expect(checksPass([])).toBe(false);
    expect(
      checksPass(planningPresets[0].result!.checks.map((row) => ({ ...row, passed: null }))),
    ).toBe(false);
  });
});

async function setupStore() {
  setActivePinia(createPinia()); authorizeStore();
  const scenario = setupPlanning();
  const preview = usePreviewStore();
  preview.data = await scenario.resourcesService.loadPreview();
  for (const method of Object.keys(scenario.service) as (keyof typeof scenario.service)[])
    vi.spyOn(previewService, method).mockImplementation(scenario.service[method] as never);
  for(const method of ['loadTaskWorkspace','saveTask'] as const)vi.spyOn(previewService,method).mockImplementation(scenario.resourcesService[method] as never);
  const store = usePlanningStore();
  await store.load();
  return { ...scenario, store, preview };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('规划页面共享状态与轮询', () => {
  it('未提交输入离开取消保留，确认放弃只恢复输入，不写存储', async () => {
    const { store, storage } = await setupStore();
    store.draft!.name = '未提交修改';
    const cancelled = store.allowDiscard();
    store.answer('cancel');
    expect(await cancelled).toBe(false);
    expect(store.draft!.name).toBe('未提交修改');
    const discarded = store.allowDiscard();
    store.answer('discard');
    expect(await discarded).toBe(true);
    expect(store.dirty).toBe(false);
    expect(storage.writes).toBe(0);
    store.formDirty = true;
    const form = store.allowDiscard();
    store.answer('cancel');
    expect(await form).toBe(false);
  });
  it('提交失败保留输入，重复点击只写一次，刷新只恢复已提交记录', async () => {
    const { store, storage } = await setupStore();
    store.draft!.name = '用户任务';
    storage.failWrite = true;
    expect(await store.submit()).toBe(false);
    expect(store.draft!.name).toBe('用户任务');
    expect(store.jobId).toBe('');
    storage.failWrite = false;
    expect(await store.saveTask()).toBe(true);
    const first = store.submit();
    const second = store.submit();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(storage.writeHistory.filter(k=>k===PLANNING_STORAGE_KEY)).toHaveLength(1);
    store.draft!.name = '不持久化';
    setActivePinia(createPinia()); authorizeStore();
    const fresh = usePlanningStore();
    await fresh.load();
    expect(fresh.draft!.name).toBe('用户任务');
    expect(fresh.jobId).toBe(store.jobId);
  });
  it('离页停止轮询，返回后恢复时间轴，终态不再轮询', async () => {
    vi.useFakeTimers();
    const { store, advance } = await setupStore();
    expect(await store.saveTask()).toBe(true);
    await store.submit();
    const spy = vi.mocked(previewService.getPlanningJob);
    await store.startPolling();
    expect(vi.getTimerCount()).toBe(1);
    store.stopPolling();
    const count = spy.mock.calls.length;
    advance();
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy.mock.calls.length).toBe(count);
    await store.startPolling();
    expect(store.view!.state).toBe('SUCCESS');
    expect(vi.getTimerCount()).toBe(0);
    store.stopPolling();
  });
  it('取消后迟到的旧查询不覆盖终态，也不重叠查询', async () => {
    vi.useFakeTimers();
    const { store } = await setupStore();
    expect(await store.saveTask()).toBe(true);
    await store.submit();
    let resolve!: (value: PlanningJobView) => void;
    const old = structuredClone(JSON.parse(JSON.stringify(store.view))) as PlanningJobView;
    const spy = vi.mocked(previewService.getPlanningJob);
    spy.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = store.startPolling();
    await store.query();
    expect(spy).toHaveBeenCalledTimes(1);
    const cancel = store.cancelJob();
    store.answer('save');
    await cancel;
    resolve(old);
    await pending;
    await Promise.resolve();
    expect(store.view!.state).toBe('CANCELLED');
    expect(vi.getTimerCount()).toBe(0);
    store.stopPolling();
  });
  it('查询失败保留最后进度，重试成功后恢复；不改为业务 FAILED', async () => {
    const { store, storage, advance } = await setupStore();
    expect(await store.saveTask()).toBe(true);
    await store.submit();
    storage.failRead = true;
    await store.query();
    expect(store.queryError).toContain('状态未确认');
    expect(store.view!.state).toBe('PENDING');
    storage.failRead = false;
    advance();
    await store.query();
    expect(store.queryError).toBe('');
    expect(store.view!.state).toBe('SUCCESS');
  });
  it('保存合并共享版本，确认替换记录；调整不改台账或原快照', async () => {
    const { store, preview, advance, storage } = await setupStore();
    expect(await store.saveTask()).toBe(true);
    await store.submit();
    advance();
    await store.query();
    const original = JSON.stringify(preview.data!.resources);
    const diagnosis = JSON.stringify(preview.data!.diagnosis);
    expect(await store.save('新方案', '')).toBe(true);
    expect(preview.data!.planning.plans).toHaveLength(3);
    const plan = store.selectedPlan!;
    const confirmed = store.confirm(plan);
    store.answer('save');
    await confirmed;
    expect(store.selectedPlan!.state).toBe('CONFIRMED');
    const snapshot = JSON.stringify(store.selectedPlan!.inputSnapshot);
    await store.adjustPlan(store.selectedPlan!);
    store.applyPreset('economical');
    expect(store.dirty).toBe(true);
    expect(store.parentPlanId).toBe(plan.id);
    expect(JSON.stringify(preview.data!.resources)).toBe(original);
    expect(JSON.stringify(preview.data!.diagnosis)).toBe(diagnosis);
    expect(JSON.stringify(preview.data!.planning.plans.at(-1)!.inputSnapshot)).toBe(snapshot);
    const before = storage.writes;
    const resetCancelled = store.reset();
    store.answer('cancel');
    await resetCancelled;
    expect(storage.writes).toBe(before);
    expect(store.dirty).toBe(true);
    storage.failWrite = true;
    const resetFailed = store.reset();
    store.answer('save');
    await resetFailed;
    expect(store.dirty).toBe(true);
    expect(preview.data!.planning.plans).toHaveLength(3);
    storage.failWrite = false;
    const reset = store.reset();
    store.answer('save');
    await reset;
    expect(store.workspace!.jobs).toEqual([]);
    expect(preview.data!.planning.plans).toHaveLength(2);
    expect(JSON.stringify(preview.data!.resources)).toBe(original);
  });
});

describe('本批资源依赖失效',()=>{
  it('无关新站点不影响已提交任务；干扰变更影响全部历史，不能确认',async()=>{
    const storage=new TestStorage(),resourcesService=createMockService(()=>storage);
    let current={resources:initialResources(),meta:initialMeta()},time=1000;
    const service=createPlanningMock(()=>storage,()=>({...current,meta:{...current.meta,taskWorkspace:taskMeta(storage)}}),()=>time);
    const submitted=await service.submitPlanning(await savedRequest(storage,{baseRevision:'initial',requestId:'p',taskId:null,parentPlanVersionId:null,input:structuredClone(planningPresets[0].input)}));
    current=await resourcesService.commitResources({baseRevision:'initial',stations:[],devices:[],newStations:[{...current.resources.stations[0],id:'unrelated',origin:'MANUAL'}]});
    time+=10000;
    const saved=await service.savePlanVersion({baseRevision:submitted.workspace.revision,requestId:'save',jobId:submitted.view.job.id,name:'独立网络',note:''});
    expect(saved.plan.sourceChanged).toBe(false);expect(saved.plan.state).toBe('SAVED');
    current=await resourcesService.commitResources({baseRevision:current.meta.revision,stations:[],devices:[],interferences:[{id:current.resources.interferences![0].id,active:!current.resources.interferences![0].active}]});
    expect((await service.loadPlanningWorkspace()).workspace.plans.find(p=>p.id===saved.plan.id)?.sourceChanged).toBe(true);
    await expect(service.confirmPlanVersion({baseRevision:saved.workspace.revision,requestId:'confirm',planId:saved.plan.id})).rejects.toMatchObject({code:'SOURCE_CHANGED'});
  });
});

// 比较继续使用同任务、相同输入快照规则，部署输出变化不冒充资源输入变化。
it('基线与两项独立采纳方案可比较，确认后旧版本保留', async () => {
  const s=await interferenceFixture(),run=await s.submit();s.advance();
  const a=await s.adopt(run.view.run.analysisId,'NODE_REDEPLOY'),b=await s.adopt(run.view.run.analysisId,'CHANNEL_SWITCH');
  const compared=await s.planning.comparePlanVersions([s.plan.id,a.plan.id,b.plan.id]);
  expect(compared).toHaveLength(3);expect(compared.every(plan=>plan.taskId===s.plan.taskId)).toBe(true);
  await s.confirm(a.plan.id);
  expect((await s.planning.loadPlanningWorkspace()).workspace.plans).toHaveLength(3);
});
