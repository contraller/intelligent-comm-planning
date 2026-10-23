import type { ApiReceipt } from '../types/task-api';
import type { ApiPlan, ApiPlanningJob, ApiPlanningResult, PlanningApiServices } from '../types/planning-api';
import type { ResourceMeta, ResourceStorage } from '../types/resource-edit';
import type { PlanVersion, ResourcesData } from '../types/domain';
import type { PlanningJobView, PlanningResult } from '../types/planning';
import { createPlanningMock } from './planning-mock';
import { createTaskMock } from './task-mock';
import { assertApiPage, assertTaskOptions } from './task-api-validation';
import { exportApiPlanFile } from './plan-export';
import { ApiError } from './types';
import historical from '../mocks/planning.json';
import { requireMockResourceRevision } from './mock-resource-revision';
import { exportPlanFile } from './plan-export';
import { sameValue } from './planning-validation';
import { withPlanningReads } from './planning-api-validation';

export function createPlanningApiMock(getStorage: () => ResourceStorage, source: () => { resources: ResourcesData; meta: ResourceMeta }, receipts = new Map<string, ApiReceipt>(), now = () => Date.now()): PlanningApiServices {
  const legacy = createPlanningMock(getStorage, source, now), tasks = createTaskMock(getStorage);
  const referencePlans = (): PlanVersion[] => {
    const meta = source().meta;
    return structuredClone((historical as unknown as { plans: PlanVersion[] }).plans).map(p => ({ ...p,
      sourceChanged: p.sourceChanged || (meta.interferenceVersion ?? 'initial') !== 'initial' || p.inputSnapshot.stations.some(s => meta.changedStationIds.includes(s.id)) || p.inputSnapshot.devices.some(d => meta.changedDeviceIds.includes(d.id)) }));
  };
  const getReference: PlanningApiServices['getPlanningReference'] = async input => {
    assertTaskOptions(input);
    const found = referencePlans().find(p => p.id === input.planId && p.taskId === input.taskId);
    if (!found) throw new ApiError('只读历史方案不存在', 'PLAN_NOT_FOUND');
    return found;
  };
  const catalog: PlanningApiServices['loadPlanningCatalog'] = async input => {
    assertTaskOptions(input);
    const { workspace, presets, adjustmentExamples, frequencyResources } = await legacy.loadPlanningWorkspace();
    return { revision: workspace.presetVersion, workspaceRevision: workspace.revision, presets: presets.map(p => ({ id: p.id, label: p.label, description: p.summary, defaults: structuredClone(p.input) })), frequencies: [...new Map(presets.map(p => [p.frequency.id, { ...p.frequency }])).values()], ...(frequencyResources === undefined ? {} : { frequencyResources }), ...(adjustmentExamples === undefined ? {} : { adjustmentExamples: structuredClone(adjustmentExamples) }) };
  };
  function result(r: PlanningResult): ApiPlanningResult {
    return { snapshotId: r.snapshotId, nodes: r.inputSnapshot.stations.map(n => ({ id: n.id, name: n.name, coordinate: [...n.coordinate], status: n.status, alert: n.alert })),
      devices: r.inputSnapshot.devices.map(d => { const model = source().resources.models.find(m => m.id === d.modelId); if (!model) throw new ApiError('设备型号缺失', 'INVALID_PLANNING_RESPONSE'); return { id: d.id, stationId: d.stationId, modelId: d.modelId, modelName: model.name, deviceClass: model.deviceClass, availability: d.availability ?? null, workFreqKhz: d.workFreqKhz, txPowerDbm: d.txPowerDbm, antennaHeightM: d.antennaHeightM, tiltDeg: d.tiltDeg ?? null, azimuthDeg: d.azimuthDeg ?? null }; }),
      links: structuredClone(r.links), metrics: structuredClone(r.metrics), configuration: structuredClone(r.configuration), checks: structuredClone(r.checks), deploymentCost: r.deploymentCost, costUnit: r.costUnit, notes: [...r.notes],
      // 桥接仅复制 Job／Plan 的冻结明细，不查询当前资产补历史数据。
      ...(r.resultDetails === undefined ? {} : { resultDetails: structuredClone(r.resultDetails) }),
      // 优先复制当前快照自己的场强元数据；旧结果只保留已有区域轮廓。
      coverage: r.coverage === undefined ? { rasterPng: null, contour: { type: 'FeatureCollection', features: r.regions.map(x => ({ type: 'Feature', id: x.id, properties: { level: x.kind, field_strength_dbuvm_min: null }, geometry: { type: 'Polygon', coordinates: structuredClone(x.rings) } })) } } : structuredClone(r.coverage),
    };
  }
  async function job(v: PlanningJobView): Promise<ApiPlanningJob> {
    const w = (await legacy.loadPlanningWorkspace()).workspace;
    return { id: v.job.id, taskId: v.job.taskId, revision: w.revision, inputVersion: v.job.taskInputVersion!, conditionVersion: v.job.dependencies.task!.conditionVersion, resourceRevision: v.job.resourceReadRevision!,
      input: structuredClone(v.job.input), parentPlanId: v.job.parentPlanVersionId, state: v.state, progress: v.progress, phases: structuredClone(v.phases), result: v.result ? result(v.result) : null, outcome: structuredClone(v.outcome), error: v.error, expired: v.expired, sourceChanged: v.sourceChanged, savedPlanId: w.plans.find(p => p.jobId === v.job.id && (v.solutions === undefined || p.solutionId === v.defaultSolutionId))?.id ?? null,
      // 每份结果独立转换；保存A不表示整个作业的其他结果已保存。
      ...(v.solutions === undefined ? {} : { defaultSolutionId: v.defaultSolutionId, solutions: v.solutions.map(s => ({ ...structuredClone(s), result: s.result ? result(s.result) : null })) }),
      // 回显冻结请求和服务匹配身份，不能从当前任务或表单补历史值。
      ...(v.job.adjustment === undefined ? {} : { adjustment: structuredClone(v.job.adjustment) }),
      ...(v.job.resultPresetId === undefined ? {} : { resultPresetId: v.job.resultPresetId }) };
  }
  async function plan(p: PlanVersion): Promise<ApiPlan> {
    const f = p.workflow; if (!f) throw new ApiError('旧方案缺少完整任务快照，请使用只读历史入口', 'INCOMPLETE_PLAN');
    const w = (await legacy.loadPlanningWorkspace()).workspace;
    const original = w.jobs.find(j => j.id === p.jobId);
    return { id: p.id, taskId: p.taskId, jobId: p.jobId, revision: w.revision, version: p.version, name: p.name, note: f.note, inputVersion: original?.taskInputVersion ?? null, conditionVersion: f.dependencies.task!.conditionVersion, resourceRevision: original?.resourceReadRevision ?? null, input: structuredClone(f.input), parentPlanId: f.parentPlanVersionId, state: p.state as ApiPlan['state'], sourceChanged: p.sourceChanged, current: !p.sourceChanged && w.currentConfirmedByTask[p.taskId] === p.id, savedAt: f.savedAt, confirmedAt: f.confirmation?.confirmedAt ?? null, source: f.interferenceOrigin ? '干扰措施采纳结果' : 'Mock 教学预生成结果', outcome: structuredClone(f.outcome), result: result({ ...p, configuration: f.configuration, checks: f.checks, deploymentCost: f.deploymentCost, costUnit: f.costUnit }),
      // 只投影已有确认记录中的冻结配置，不读取现有资源或重新生成业务结果。
      confirmedConfiguration: f.confirmation ? { sourcePlanId: p.id, sourcePlanVersion: p.version, sourceSnapshotId: p.snapshotId, confirmedAt: f.confirmation.confirmedAt, configuration: structuredClone(f.confirmation.configuration) } : null,
      ...(f.interferenceOrigin === undefined ? {} : { interferenceOrigin: structuredClone(f.interferenceOrigin) }),
      ...(p.solutionId === undefined ? {} : { solutionId: p.solutionId, solutionLabel: f.solutionOrigin!.label, radioCount: f.solutionOrigin!.radioCount }),
      ...(f.adjustment === undefined ? {} : { adjustment: structuredClone(f.adjustment) }),
      ...(f.resultPresetId === undefined ? {} : { resultPresetId: f.resultPresetId }) };
  }
  function receipt(input: { requestId: string; taskId: string }, kind: ApiReceipt['kind'], entityId: string) { receipts.set(input.requestId, { ...input, kind, entityId, state: 'SUCCEEDED', message: 'Mock 操作完成' }); }
  async function owner(jobId: string, taskId: string) { const v = await legacy.getPlanningJob(jobId); if (v.job.taskId !== taskId) throw new ApiError('作业不属于当前任务', 'INVALID_PARENT'); return v; }
  const getPlan: PlanningApiServices['getPlanningPlan'] = async input => { assertTaskOptions(input); const w = await legacy.loadPlanningWorkspace(), p = w.workspace.plans.find(p => p.id === input.planId && p.taskId === input.taskId); if (!p) throw new ApiError('方案不存在', 'PLAN_NOT_FOUND'); return plan(p); };
  return withPlanningReads({
    async querySavedPlanningPlans(input) {
      assertApiPage(input);
      if (input.context !== 'planning' || input.state !== undefined && !['SAVED', 'REFERENCE', 'CONFIRMED'].includes(input.state)
        || input.search !== undefined && /[\u0000-\u001f\u007f]/.test(input.search))
        throw new ApiError('方案历史查询条件无效', 'INVALID_TASK_QUERY');
      const w = (await legacy.loadPlanningWorkspace()).workspace;
      // 教学模式也只查询本工作区实际保存的完整版本，不注入内置旧快照。
      const all = w.plans.filter(p => p.workflow && (!input.state || p.state === input.state)
        && (!input.search?.trim() || `${p.id} ${p.taskId} ${p.jobId ?? ''} ${p.name}`.includes(input.search.trim())))
        .sort((a, b) => b.workflow!.savedAt.localeCompare(a.workflow!.savedAt) || b.id.localeCompare(a.id));
      const items = all.slice((input.pageNum - 1) * input.pageSize, input.pageNum * input.pageSize).map(p => ({
        id: p.id, taskId: p.taskId, name: p.name, version: p.version, state: p.state as ApiPlan['state'],
        current: p.state === 'CONFIRMED' && !p.sourceChanged && w.currentConfirmedByTask[p.taskId] === p.id,
        sourceChanged: p.sourceChanged, savedAt: p.workflow!.savedAt,
      }));
      return { items, total: all.length, pageNum: input.pageNum, pageSize: input.pageSize };
    },
    loadPlanningCatalog: catalog,
    async queryPlanningJobs(input) {
      assertApiPage(input);
      const workspace = (await legacy.loadPlanningWorkspace()).workspace;
      const all = workspace.jobs.filter(j => !input.search || `${j.id} ${j.taskId} ${j.input.name}`.includes(input.search)).sort((a, b) => b.startedAt - a.startedAt);
      const items = await Promise.all(all.slice((input.pageNum - 1) * input.pageSize, input.pageNum * input.pageSize).map(async j => {
        let state: ApiPlanningJob['state'];
        try { state = (await legacy.getPlanningJob(j.id)).state; }
        catch (error) { if (!(error instanceof ApiError) || error.code !== 2001 || !(error.data as PlanningJobView)?.state) throw error; state = (error.data as PlanningJobView).state; }
        return { id: j.id, taskId: j.taskId, name: j.input.name, startedAt: new Date(j.startedAt).toISOString(), state };
      }));
      return { items, total: all.length, pageNum: input.pageNum, pageSize: input.pageSize };
    },
    async queryPlanningReferences(input) {
      assertApiPage(input);
      const all = referencePlans().filter(p => !input.search || `${p.id} ${p.name} ${p.taskId}`.includes(input.search));
      return { items: all.slice((input.pageNum - 1) * input.pageSize, input.pageNum * input.pageSize), total: all.length, pageNum: input.pageNum, pageSize: input.pageSize };
    },
    getPlanningReference: getReference,
    async comparePlanningReferences(input) {
      assertTaskOptions(input);
      // 原比较服务继续校验任务与资源快照，不能拿当前资源补齐历史。
      return legacy.comparePlanVersions(input.planIds);
    },
    async exportPlanningReference(input) { return exportPlanFile(await getReference(input), input.format); },
    async resetPlanningData(input) { assertTaskOptions(input); await legacy.resetPlanningWorkspace(input.revision); receipts.clear(); return catalog(input); },
    async submitPlanningTask(input) {
      assertTaskOptions(input);
      const w = await legacy.loadPlanningWorkspace(), previous = w.workspace.jobs.find(j => j.requestId === input.requestId);
      // 原提交先按冻结身份重放；资源后来变化不能把已成功请求改成新提交。
      if (previous) {
        if (previous.taskId !== input.taskId || previous.taskInputVersion !== input.inputVersion || input.revision !== input.inputVersion || previous.dependencies.task?.conditionVersion !== input.conditionVersion || previous.resourceReadRevision !== input.resourceRevision || previous.parentPlanVersionId !== input.parentPlanId || !sameValue(previous.adjustment, input.adjustment)) throw new ApiError('同一请求 ID 对应不同内容', 'IDEMPOTENCY_CONFLICT');
        try { return await job(await legacy.getPlanningJob(previous.id)); }
        catch (error) { if (error instanceof ApiError && error.code === 2001 && (error.data as PlanningJobView)?.job?.id === previous.id) return job(error.data as PlanningJobView); throw error; }
      }
      const t = (await tasks.loadTaskWorkspace()).tasks.find(t => t.id === input.taskId)?.versions.at(-1);
      requireMockResourceRevision(source(), input.resourceRevision);
      if (!t || t.id !== input.revision || t.id !== input.inputVersion || t.conditionVersion !== input.conditionVersion) throw new ApiError('任务或资源版本已变化', 'TASK_REVISION_CONFLICT');
      // 任务仅改名称仍可调整；沿用父版本冻结条件，核心服务另验条件版本与来源依赖。
      const parent = input.adjustment === undefined ? undefined : w.workspace.plans.find(p => p.id === input.parentPlanId && p.taskId === input.taskId);
      if (input.adjustment !== undefined && !parent?.workflow) throw new ApiError('调整父版本不存在或缺少完整快照', 'INVALID_PARENT');
      const saved = await legacy.submitPlanning({ requestId: input.requestId, taskId: input.taskId, input: parent?.workflow?.input ?? t.input, parentPlanVersionId: input.parentPlanId, baseRevision: w.workspace.revision, ...(input.adjustment === undefined ? {} : { adjustment: structuredClone(input.adjustment) }) }); receipt(input, 'submit', saved.view.job.id); return job(saved.view);
    },
    async getPlanningTask(input) {
      assertTaskOptions(input);
      try { return await job(await owner(input.jobId, input.taskId)); }
      catch (error) {
        // 过期仍返回这个作业的冻结身份和状态，结果保持不可用。
        if (error instanceof ApiError && error.code === 2001 && (error.data as PlanningJobView)?.job?.taskId === input.taskId) return job(error.data as PlanningJobView);
        throw error;
      }
    },
    async cancelPlanningTask(input) { assertTaskOptions(input); await owner(input.jobId, input.taskId); const r = await legacy.cancelPlanningJob({ jobId: input.jobId, baseRevision: input.revision, requestId: input.requestId }); receipt(input, 'cancel', input.jobId); return job(r.view); },
    async queryPlanningPlans(input) { assertApiPage(input); const all = (await legacy.loadPlanningWorkspace()).workspace.plans.filter(p => p.taskId === input.taskId && (!input.search || p.name.includes(input.search))); return { items: await Promise.all(all.slice((input.pageNum - 1) * input.pageSize, input.pageNum * input.pageSize).map(plan)), total: all.length, pageNum: input.pageNum, pageSize: input.pageSize }; },
    getPlanningPlan: getPlan,
    async savePlanningPlan(input) { assertTaskOptions(input); await owner(input.jobId, input.taskId); const r = await legacy.savePlanVersion({ jobId: input.jobId, requestId: input.requestId, baseRevision: input.revision, name: input.name, note: input.note,
      ...(input.solutionId === undefined ? {} : { solutionId: input.solutionId, snapshotId: input.snapshotId }) }); receipt(input, 'savePlan', r.plan.id); return plan(r.plan); },
    async confirmPlanningPlan(input) { await getPlan(input); const r = await legacy.confirmPlanVersion({ planId: input.planId, requestId: input.requestId, baseRevision: input.revision }); receipt(input, 'confirm', r.plan.id); return plan(r.plan); },
    async comparePlanningPlans(input) { assertTaskOptions(input); const values = await legacy.comparePlanVersions(input.planIds); if (values.some(p => p.taskId !== input.taskId)) throw new ApiError('不能跨任务对比', 'INVALID_COMPARISON'); return Promise.all(values.map(plan)); },
    async exportPlanningPlan(input) { return exportApiPlanFile(await getPlan(input), input.format); },
    async getPlanningCoverageImage(input) {
      assertTaskOptions(input);
      const w = (await legacy.loadPlanningWorkspace()).workspace;
      const frozen = w.plans.find(p => p.snapshotId === input.snapshotId)?.coverage
        ?? w.jobs.flatMap(j => [j.snapshotId === input.snapshotId ? j.coverage : undefined, ...j.solutions?.filter(s => s.result.snapshotId === input.snapshotId).map(s => s.result.coverage) ?? []]).find(Boolean);
      if (!frozen?.rasterPng || !sameValue(frozen.rasterPng, input.raster) || !/^\/maps\/coverage\/[\w-]+\.png$/.test(input.raster.url)) throw new ApiError('当前冻结结果没有此覆盖图片', 'COVERAGE_NOT_AVAILABLE');
      const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}${input.raster.url}`, { signal: input.signal });
      if (!response.ok) throw new ApiError('预生成覆盖图片读取失败', 'COVERAGE_NOT_AVAILABLE');
      const blob = await response.blob(), bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
      if (bytes.length !== 24 || [137,80,78,71,13,10,26,10].some((v,i) => bytes[i] !== v) || new DataView(bytes.buffer).getUint32(16) !== input.raster.width || new DataView(bytes.buffer).getUint32(20) !== input.raster.height) throw new ApiError('预生成覆盖图片与冻结元数据不符', 'INVALID_COVERAGE_IMAGE');
      return blob;
    },
  });
}
