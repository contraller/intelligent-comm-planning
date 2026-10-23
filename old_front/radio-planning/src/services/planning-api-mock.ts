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

export function createPlanningApiMock(getStorage: () => ResourceStorage, source: () => { resources: ResourcesData; meta: ResourceMeta }, receipts = new Map<string, ApiReceipt>(), now = () => Date.now()): PlanningApiServices {
  const legacy = createPlanningMock(getStorage, source, now), tasks = createTaskMock(getStorage);
  function result(r: PlanningResult): ApiPlanningResult {
    return { snapshotId: r.snapshotId, nodes: r.inputSnapshot.stations.map(n => ({ id: n.id, name: n.name, coordinate: [...n.coordinate], status: n.status, alert: n.alert })),
      devices: r.inputSnapshot.devices.map(d => { const model = source().resources.models.find(m => m.id === d.modelId); if (!model) throw new ApiError('设备型号缺失', 'INVALID_PLANNING_RESPONSE'); return { id: d.id, stationId: d.stationId, modelId: d.modelId, modelName: model.name, deviceClass: model.deviceClass, availability: d.availability ?? 'ACTIVE', workFreqKhz: d.workFreqKhz, txPowerDbm: d.txPowerDbm, antennaHeightM: d.antennaHeightM, tiltDeg: d.tiltDeg ?? null, azimuthDeg: d.azimuthDeg ?? null }; }),
      links: structuredClone(r.links), metrics: structuredClone(r.metrics), configuration: structuredClone(r.configuration), checks: structuredClone(r.checks), deploymentCost: r.deploymentCost, costUnit: r.costUnit, notes: [...r.notes],
      // 桥接仅复制 Job／Plan 的冻结明细，不查询当前资产补历史数据。
      ...(r.resultDetails === undefined ? {} : { resultDetails: structuredClone(r.resultDetails) }),
      coverage: { rasterPng: null, contour: { type: 'FeatureCollection', features: r.regions.map(x => ({ type: 'Feature', id: x.id, properties: { level: x.kind, field_strength_dbuvm_min: null }, geometry: { type: 'Polygon', coordinates: structuredClone(x.rings) } })) } },
    };
  }
  async function job(v: PlanningJobView): Promise<ApiPlanningJob> {
    const w = (await legacy.loadPlanningWorkspace()).workspace;
    return { id: v.job.id, taskId: v.job.taskId, revision: w.revision, inputVersion: v.job.inputVersion, conditionVersion: v.job.dependencies.task?.conditionVersion ?? 'legacy', resourceRevision: v.job.dependencies.resourceEpoch,
      input: structuredClone(v.job.input), parentPlanId: v.job.parentPlanVersionId, state: v.state, progress: v.progress, phases: structuredClone(v.phases), result: v.result ? result(v.result) : null, outcome: structuredClone(v.outcome), error: v.error, expired: v.expired, sourceChanged: v.sourceChanged, savedPlanId: w.plans.find(p => p.jobId === v.job.id && (v.solutions === undefined || p.solutionId === v.defaultSolutionId))?.id ?? null,
      // 每份结果独立转换；保存A不表示整个作业的其他结果已保存。
      ...(v.solutions === undefined ? {} : { defaultSolutionId: v.defaultSolutionId, solutions: v.solutions.map(s => ({ ...structuredClone(s), result: s.result ? result(s.result) : null })) }),
      // 回显冻结请求和服务匹配身份，不能从当前任务或表单补历史值。
      ...(v.job.adjustment === undefined ? {} : { adjustment: structuredClone(v.job.adjustment) }),
      ...(v.job.resultPresetId === undefined ? {} : { resultPresetId: v.job.resultPresetId }) };
  }
  async function plan(p: PlanVersion): Promise<ApiPlan> {
    const f = p.workflow; if (!f || !p.jobId) throw new ApiError('旧方案缺少完整任务快照', 'INCOMPLETE_PLAN');
    const w = (await legacy.loadPlanningWorkspace()).workspace;
    return { id: p.id, taskId: p.taskId, jobId: p.jobId, revision: w.revision, version: p.version, name: p.name, note: f.note, inputVersion: f.inputVersion, conditionVersion: f.dependencies.task?.conditionVersion ?? 'legacy', resourceRevision: f.dependencies.resourceEpoch, input: structuredClone(f.input), parentPlanId: f.parentPlanVersionId, state: p.state as ApiPlan['state'], sourceChanged: p.sourceChanged, current: !p.sourceChanged && w.currentConfirmedByTask[p.taskId] === p.id, savedAt: f.savedAt, confirmedAt: f.confirmation?.confirmedAt ?? null, source: 'Mock 教学预生成结果', outcome: structuredClone(f.outcome), result: result({ ...p, configuration: f.configuration, checks: f.checks, deploymentCost: f.deploymentCost, costUnit: f.costUnit }),
      ...(p.solutionId === undefined ? {} : { solutionId: p.solutionId, solutionLabel: f.solutionOrigin!.label, radioCount: f.solutionOrigin!.radioCount }),
      ...(f.adjustment === undefined ? {} : { adjustment: structuredClone(f.adjustment) }),
      ...(f.resultPresetId === undefined ? {} : { resultPresetId: f.resultPresetId }) };
  }
  function receipt(input: { requestId: string; taskId: string }, kind: ApiReceipt['kind'], entityId: string) { receipts.set(input.requestId, { ...input, kind, entityId, state: 'SUCCEEDED', message: 'Mock 操作完成' }); }
  async function owner(jobId: string, taskId: string) { const v = await legacy.getPlanningJob(jobId); if (v.job.taskId !== taskId) throw new ApiError('作业不属于当前任务', 'INVALID_PARENT'); return v; }
  const getPlan: PlanningApiServices['getPlanningPlan'] = async input => { assertTaskOptions(input); const w = await legacy.loadPlanningWorkspace(), p = w.workspace.plans.find(p => p.id === input.planId && p.taskId === input.taskId); if (!p) throw new ApiError('方案不存在', 'PLAN_NOT_FOUND'); return plan(p); };
  return {
    async loadPlanningCatalog(input) { assertTaskOptions(input); const { workspace, presets, adjustmentExamples, frequencyResources } = await legacy.loadPlanningWorkspace(); return { revision: workspace.presetVersion, presets: presets.map(p => ({ id: p.id, label: p.label, description: p.summary, defaults: structuredClone(p.input) })), frequencies: [...new Map(presets.map(p => [p.frequency.id, { ...p.frequency }])).values()], ...(frequencyResources === undefined ? {} : { frequencyResources }), ...(adjustmentExamples === undefined ? {} : { adjustmentExamples: structuredClone(adjustmentExamples) }) }; },
    async submitPlanningTask(input) {
      assertTaskOptions(input); const t = (await tasks.loadTaskWorkspace()).tasks.find(t => t.id === input.taskId)?.versions.at(-1);
      if (!t || t.id !== input.revision || t.id !== input.inputVersion || t.conditionVersion !== input.conditionVersion || source().meta.revision !== input.resourceRevision) throw new ApiError('任务或资源版本已变化', 'TASK_REVISION_CONFLICT');
      const w = await legacy.loadPlanningWorkspace();
      // 任务仅改名称仍可调整；沿用父版本冻结条件，核心服务另验条件版本与来源依赖。
      const parent = input.adjustment === undefined ? undefined : w.workspace.plans.find(p => p.id === input.parentPlanId && p.taskId === input.taskId);
      if (input.adjustment !== undefined && !parent?.workflow) throw new ApiError('调整父版本不存在或缺少完整快照', 'INVALID_PARENT');
      const saved = await legacy.submitPlanning({ requestId: input.requestId, taskId: input.taskId, input: parent?.workflow?.input ?? t.input, parentPlanVersionId: input.parentPlanId, baseRevision: w.workspace.revision, ...(input.adjustment === undefined ? {} : { adjustment: structuredClone(input.adjustment) }) }); receipt(input, 'submit', saved.view.job.id); return job(saved.view);
    },
    async getPlanningTask(input) { assertTaskOptions(input); return job(await owner(input.jobId, input.taskId)); },
    async cancelPlanningTask(input) { assertTaskOptions(input); await owner(input.jobId, input.taskId); const r = await legacy.cancelPlanningJob({ jobId: input.jobId, baseRevision: input.revision }); receipt(input, 'cancel', input.jobId); return job(r.view); },
    async queryPlanningPlans(input) { assertApiPage(input); const all = (await legacy.loadPlanningWorkspace()).workspace.plans.filter(p => p.taskId === input.taskId && (!input.search || p.name.includes(input.search))); return { items: await Promise.all(all.slice((input.page - 1) * input.pageSize, input.page * input.pageSize).map(plan)), total: all.length, page: input.page, pageSize: input.pageSize }; },
    getPlanningPlan: getPlan,
    async savePlanningPlan(input) { assertTaskOptions(input); await owner(input.jobId, input.taskId); const r = await legacy.savePlanVersion({ jobId: input.jobId, requestId: input.requestId, baseRevision: input.revision, name: input.name, note: input.note,
      ...(input.solutionId === undefined ? {} : { solutionId: input.solutionId, snapshotId: input.snapshotId }) }); receipt(input, 'savePlan', r.plan.id); return plan(r.plan); },
    async confirmPlanningPlan(input) { await getPlan(input); const r = await legacy.confirmPlanVersion({ planId: input.planId, requestId: input.requestId, baseRevision: input.revision }); receipt(input, 'confirm', r.plan.id); return plan(r.plan); },
    async comparePlanningPlans(input) { assertTaskOptions(input); const values = await legacy.comparePlanVersions(input.planIds); if (values.some(p => p.taskId !== input.taskId)) throw new ApiError('不能跨任务对比', 'INVALID_COMPARISON'); return Promise.all(values.map(plan)); },
    async exportPlanningPlan(input) { return exportApiPlanFile(await getPlan(input), input.format); },
    async getPlanningCoverageImage() { throw new ApiError('当前 Mock 结果没有预生成 PNG', 'COVERAGE_NOT_AVAILABLE'); },
  };
}
