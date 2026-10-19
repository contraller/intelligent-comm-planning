import { latestTask, taskSourceChanged } from './task-validation';
import { exportPlanFile } from './plan-export';
import { getPresetResultDetails } from './planning-result-details-mock';
import historical from '../mocks/planning.json';
import { planningPhases } from '../mocks/planning-presets';
// 新旧教学作业共用完整目录，不替换旧结果。
import { planningPresets } from './planning-preset-catalog';
import { planningAdjustmentExamples } from '../mocks/planning-adjustments';
import { matchPlanningAdjustment } from './planning-adjustment';
import { planningResultPresetId } from './planning-result-identity';
import { createJobSolutions, projectSolutionJob, solutionViews } from './planning-solutions';
import { planningFrequencyResources } from '../mocks/planning-frequency-resources';
import { PLANNING_PHASE_MS, PLANNING_PRESET_VERSION, PLANNING_TTL_MS } from '../config/demo';
import type { PlanVersion, ResourcesData } from '../types/domain';
import type { ResourceMeta, ResourceStorage } from '../types/resource-edit';
import type {
  PlanningJob,
  PlanningJobView,
  PlanningServices,
  PlanningWorkspace,
} from '../types/planning';
import { ApiError } from './types';
import {
  assertComparable,
  assertConfirmable,
  assertResult,
  captureDependencies,
  checksPass,
  dependenciesChanged,
  getPresetCoverage,
  inputSignature,
  matchPreset,
  resultForJob,
  sameValue,
  validateSaveFields,
} from './planning-validation';
import {
  checkPlanningRevision,
  emptyPlanningWorkspace,
  readPlanning,
  writePlanning,
} from './planning-storage';

// 注入时钟与存储后可验证刷新恢复、有效期和写入失败；不依赖后台定时器。
export function createPlanningMock(
  getStorage: () => ResourceStorage,
  getResources: () => { resources: ResourcesData; meta: ResourceMeta },
  now = () => Date.now(),
): PlanningServices {
  const read = () => readPlanning(getStorage(), planningPresets);
  function changed(workspace: PlanningWorkspace) {
    const meta = getResources().meta;
    for (const plan of workspace.plans)
      plan.sourceChanged = dependenciesChanged(plan.workflow!.dependencies, meta)||taskSourceChanged(plan.taskId,plan.workflow!.input,meta,plan.workflow!.dependencies.task?.conditionVersion);
    return workspace;
  }
  function view(job: PlanningJob, workspace: PlanningWorkspace): PlanningJobView {
    const preset = planningPresets.find((p) => p.id === planningResultPresetId(job))!;
    const elapsed = Math.max(0, now() - job.startedAt);
    const finished = elapsed >= PLANNING_PHASE_MS * planningPhases.length;
    const state =
      job.cancelledAt !== null
        ? 'CANCELLED'
        : finished
          ? preset.executionError
            ? 'FAILED'
            : 'SUCCESS'
          : elapsed < 300
            ? 'PENDING'
            : 'RUNNING';
    const effectiveElapsed = job.cancelledAt === null ? elapsed : job.cancelledAt - job.startedAt;
    const legacyExpired =
      job.cancelledAt === null &&
      elapsed >= PLANNING_TTL_MS &&
      !workspace.plans.some((p) => p.jobId === job.id);
    const solutions = job.solutions === undefined ? undefined : state === 'SUCCESS' ? solutionViews(job, workspace.plans, now()) : [];
    const defaultSolution = solutions?.find(s => s.solutionId === job.defaultSolutionId);
    const expired = solutions?.length ? solutions.every(s => s.expired) : legacyExpired;
    return {
      job: structuredClone(job),
      state,
      progress: Math.min(
        100,
        Math.floor((effectiveElapsed / (PLANNING_PHASE_MS * planningPhases.length)) * 100),
      ),
      phases: planningPhases.map((name, index) => ({
        name,
        state:
          effectiveElapsed >= (index + 1) * PLANNING_PHASE_MS
            ? 'done'
            : effectiveElapsed >= index * PLANNING_PHASE_MS && state === 'RUNNING'
              ? 'running'
              : 'waiting',
      })),
      ...(solutions === undefined ? {} : { solutions, defaultSolutionId: state === 'SUCCESS' ? job.defaultSolutionId ?? null : null }),
      result: solutions === undefined ? state === 'SUCCESS' && !expired ? resultForJob(job, preset) : null : defaultSolution?.result ?? null,
      outcome: state === 'SUCCESS' && (!expired || solutions !== undefined) ? structuredClone(preset.outcome) : null,
      error: expired
        ? '2001：未保存结果已超过 24 小时，请重新提交'
        : state === 'FAILED'
          ? preset.executionError
          : null,
      expired,
      sourceChanged: dependenciesChanged(job.dependencies, getResources().meta)||taskSourceChanged(job.taskId,job.input,getResources().meta,job.dependencies.task?.conditionVersion),
    };
  }
  function jobById(workspace: PlanningWorkspace, id: string) {
    const job = workspace.jobs.find((j) => j.id === id);
    if (!job) throw new ApiError('任务不存在，请重新加载规划工作区', 'JOB_NOT_FOUND');
    return job;
  }
  function persist(workspace: PlanningWorkspace) {
    changed(workspace);
    workspace.revision = crypto.randomUUID();
    writePlanning(getStorage(), workspace, planningPresets);
    return workspace;
  }
  const requireId = (id: string) => {
    if (typeof id !== 'string' || !id.trim())
      throw new ApiError('操作标识不能为空', 'VALIDATION_ERROR');
  };
  return {
    async loadPlanningWorkspace() {
      return { workspace: changed(read()), presets: structuredClone(planningPresets.filter(p => !p.hidden)), adjustmentExamples: structuredClone(planningAdjustmentExamples), frequencyResources: structuredClone(planningFrequencyResources) };
    },
    async submitPlanning(request) {
      requireId(request.requestId);
      const workspace = read();
      const previous = workspace.jobs.find((j) => j.requestId === request.requestId);
      if (previous) {
        if (
          !sameValue(previous.input, request.input) ||
          !sameValue(previous.adjustment, request.adjustment) ||
          previous.parentPlanVersionId !== request.parentPlanVersionId ||
          (request.taskId !== null && previous.taskId !== request.taskId)
        )
          throw new ApiError('重复请求标识对应不同输入', 'IDEMPOTENCY_CONFLICT');
        return { workspace: changed(workspace), view: view(previous, workspace) };
      }
      checkPlanningRevision(request.baseRevision, workspace.revision);
      if (workspace.jobs.some((j) => ['PENDING', 'RUNNING'].includes(view(j, workspace).state)))
        throw new ApiError('已有规划任务运行中，请等待完成或取消', 'JOB_RUNNING');
      const current = getResources();
      let preset = matchPreset(request.input, current.resources, planningPresets);
      const saved=request.taskId&&current.meta.taskWorkspace&&latestTask(current.meta.taskWorkspace,request.taskId);
      // 独立调整冻结父输入；任务仅改名称/说明不改变条件版本，也不要求重写父快照。
      if(!saved||!(request.adjustment === undefined ? sameValue(saved.input,request.input) : sameValue(inputSignature(saved.input),inputSignature(request.input))))
        throw new ApiError('请先保存当前任务输入，再开始规划','TASK_NOT_SAVED');
      if (
        request.parentPlanVersionId !== null &&
        !workspace.plans.some(
          (p) => p.id === request.parentPlanVersionId && p.taskId === request.taskId,
        )
      )
        throw new ApiError('调整父版本不属于当前任务', 'INVALID_PARENT');
      if (request.adjustment !== undefined) {
        const parent = workspace.plans.find(plan => plan.id === request.parentPlanVersionId);
        if (!parent?.workflow || parent.taskId !== request.taskId || !sameValue(parent.workflow.input, request.input))
          throw new ApiError('调整必须沿用父方案的任务条件与身份', 'INVALID_PARENT');
        if (dependenciesChanged(parent.workflow.dependencies, current.meta) || taskSourceChanged(parent.taskId, parent.workflow.input, current.meta, parent.workflow.dependencies.task?.conditionVersion))
          throw new ApiError('源数据已变化，请使用来源有效的方案', 'SOURCE_CHANGED');
        preset = matchPlanningAdjustment(request.adjustment, parent, planningPresets);
      }
      const job: PlanningJob = {
        id: crypto.randomUUID(),
        requestId: request.requestId,
        taskId: request.taskId ?? crypto.randomUUID(),
        inputVersion: crypto.randomUUID(),
        snapshotId: crypto.randomUUID(),
        presetVersion: PLANNING_PRESET_VERSION,
        input: structuredClone(request.input),
        ...(request.adjustment === undefined ? {} : { adjustment: structuredClone(request.adjustment), resultPresetId: preset.id }),
        dependencies: {...captureDependencies(current.meta, preset.baseline),task:{id:request.taskId!,conditionVersion:saved.conditionVersion}},
        inputSnapshot: structuredClone(preset.baseline),
        coverage: getPresetCoverage(preset.id),
        parentPlanVersionId: request.parentPlanVersionId,
        startedAt: now(),
        cancelledAt: null,
      };
      // 仅新提交选择独立资产；旧任务和幂等返回都不补充最新数据。
      const resultDetails = getPresetResultDetails(preset.id, job.input);
      if (resultDetails !== undefined) job.resultDetails = resultDetails;
      createJobSolutions(job, preset, planningPresets);
      workspace.jobs.push(job);
      // 返回视图在写入前准备；存储失败不能算提交成功。
      const nextView = view(job, workspace);
      return { workspace: persist(workspace), view: nextView };
    },
    async getPlanningJob(jobId) {
      const workspace = read();
      const result = view(jobById(workspace, jobId), workspace);
      if (result.expired && result.solutions === undefined) throw new ApiError(result.error!, 2001, result);
      return result;
    },
    async cancelPlanningJob(request) {
      const workspace = read();
      const job = jobById(workspace, request.jobId);
      if (job.cancelledAt !== null)
        return { workspace: changed(workspace), view: view(job, workspace) };
      checkPlanningRevision(request.baseRevision, workspace.revision);
      if (!['PENDING', 'RUNNING'].includes(view(job, workspace).state))
        throw new ApiError('任务已结束，不能再次取消', 'TERMINAL_JOB');
      job.cancelledAt = now();
      const nextView = view(job, workspace);
      return { workspace: persist(workspace), view: nextView };
    },
    async savePlanVersion(request) {
      requireId(request.requestId);
      validateSaveFields(request.name, request.note);
      const workspace = read();
      const repeated = workspace.plans.find((p) => p.workflow!.saveRequestId === request.requestId);
      if (repeated) {
        if (
          repeated.jobId !== request.jobId ||
          repeated.solutionId !== request.solutionId ||
          (request.solutionId !== undefined && repeated.snapshotId !== request.snapshotId) ||
          repeated.name !== request.name.trim() ||
          repeated.workflow!.note !== request.note
        )
          throw new ApiError('保存标识对应不同内容', 'IDEMPOTENCY_CONFLICT');
        changed(workspace);
        return { workspace, plan: repeated };
      }
      checkPlanningRevision(request.baseRevision, workspace.revision);
      if (workspace.plans.some((p) => p.jobId === request.jobId && p.solutionId === request.solutionId))
        throw new ApiError('此结果已有保存版本，请查看原版本', 'ALREADY_SAVED');
      const originalJob = jobById(workspace, request.jobId);
      const job = projectSolutionJob(originalJob, request.solutionId);
      const rawView = view(originalJob, workspace);
      const selected = rawView.solutions?.find(s => s.solutionId === request.solutionId);
      if (originalJob.solutions !== undefined && request.snapshotId !== job.snapshotId) throw new ApiError('所选结果快照不符', 'INVALID_RESULT');
      const current = selected ? { ...rawView, result: selected.result, outcome: selected.outcome, expired: selected.expired } : rawView;
      if (current.expired) throw new ApiError(current.error ?? '2001：所选未保存结果已超过24小时，请重新提交', 2001, current);
      if (current.state !== 'SUCCESS' || !current.result || !current.outcome)
        throw new ApiError('当前任务没有可保存的完整结果', 'NO_RESULT');
      assertResult(current.result, job.input, planningResultPresetId(job));
      const result = current.result;
      const plan: PlanVersion = {
        id: crypto.randomUUID(),
        name: request.name.trim(),
        taskId: job.taskId,
        jobId: job.id,
        ...(request.solutionId === undefined ? {} : { solutionId: request.solutionId }),
        snapshotId: job.snapshotId,
        version: `V${workspace.plans.filter((p) => p.taskId === job.taskId).length + 1}`,
        preset: planningPresets.find((p) => p.id === planningResultPresetId(job))!.label,
        state:
          !current.sourceChanged && current.outcome.code === 0 && checksPass(result.checks)
            ? 'SAVED'
            : 'REFERENCE',
        sourceChanged: current.sourceChanged,
        stationIds: [...job.input.stationIds],
        inputSnapshot: result.inputSnapshot,
        links: result.links,
        regions: result.regions,
        coverage: result.coverage ? structuredClone(result.coverage) : undefined,
        ...(result.resultDetails === undefined ? {} : { resultDetails: structuredClone(result.resultDetails) }),
        metrics: result.metrics,
        notes: result.notes,
        workflow: {
          ...(job.solutionOrigin === undefined ? {} : { solutionOrigin: structuredClone(job.solutionOrigin), resultPresetId: job.resultPresetId }),
          ...(job.adjustment === undefined ? {} : { adjustment: structuredClone(job.adjustment), resultPresetId: job.resultPresetId }),
          input: structuredClone(job.input),
          inputVersion: job.inputVersion,
          dependencies: structuredClone(job.dependencies),
          presetVersion: job.presetVersion,
          saveRequestId: request.requestId,
          savedAt: new Date(now()).toISOString(),
          parentPlanVersionId: job.parentPlanVersionId,
          changeSummary: job.adjustment ? `从父版本调整设备参数与主路由；结果 ${planningResultPresetId(job)}` : job.parentPlanVersionId
            ? `从父版本调整到 ${job.input.presetId}；${job.input.frequencyId}`
            : '首次保存',
          note: request.note,
          checks: result.checks,
          deploymentCost: result.deploymentCost,
          costUnit: result.costUnit,
          configuration: result.configuration,
          outcome: current.outcome,
          confirmation: null,
        },
      };
      workspace.plans.push(plan);
      return { workspace: persist(workspace), plan };
    },
    async confirmPlanVersion(request) {
      requireId(request.requestId);
      const workspace = read();
      const repeated = workspace.plans.find(
        (p) => p.workflow!.confirmation?.requestId === request.requestId,
      );
      if (repeated) {
        if (repeated.id !== request.planId)
          throw new ApiError('确认标识对应其他方案', 'IDEMPOTENCY_CONFLICT');
        changed(workspace);
        return { workspace, plan: repeated };
      }
      checkPlanningRevision(request.baseRevision, workspace.revision);
      const plan = workspace.plans.find((p) => p.id === request.planId);
      if (!plan) throw new ApiError('方案不存在', 'PLAN_NOT_FOUND');
      assertConfirmable(plan, getResources().meta);
      plan.state = 'CONFIRMED';
      plan.workflow!.confirmation = {
        requestId: request.requestId,
        confirmedAt: new Date(now()).toISOString(),
        configuration: structuredClone(plan.workflow!.configuration),
      };
      workspace.currentConfirmedByTask[plan.taskId] = plan.id;
      return { workspace: persist(workspace), plan };
    },
    async comparePlanVersions(ids) {
      const workspace = changed(read());
      const all = [...(structuredClone(historical.plans) as PlanVersion[]), ...workspace.plans];
      const plans = ids.map((id) => all.find((p) => p.id === id));
      if (plans.some((p) => !p)) throw new ApiError('对比方案不存在', 'PLAN_NOT_FOUND');
      assertComparable(plans as PlanVersion[]);
      // 旧方案保留累计影响规则，缺失成本不补零。
      const meta = getResources().meta;
      for (const p of plans as PlanVersion[])
        if (!p.workflow)
          p.sourceChanged ||= (meta.interferenceVersion??'initial')!=='initial' ||
            p.inputSnapshot.stations.some((s) => meta.changedStationIds.includes(s.id)) ||
            p.inputSnapshot.devices.some((d) => meta.changedDeviceIds.includes(d.id));
      return structuredClone(plans as PlanVersion[]);
    },
    async exportPlanVersion(request){
      const all=[...(structuredClone(historical.plans) as PlanVersion[]),...changed(read()).plans];
      const plan=all.find(p=>p.id===request.planId);
      if(!plan)throw new ApiError('已保存方案不存在','PLAN_NOT_FOUND');
      if(!plan.workflow){const meta=getResources().meta;plan.sourceChanged||=(meta.interferenceVersion??'initial')!=='initial'||plan.inputSnapshot.stations.some(s=>meta.changedStationIds.includes(s.id))||plan.inputSnapshot.devices.some(d=>meta.changedDeviceIds.includes(d.id));}
      return exportPlanFile(plan,request.format);
    },
    async resetPlanningWorkspace(baseRevision) {
      try {
        const workspace = read();
        if (baseRevision === null) checkPlanningRevision('initial', workspace.revision);
        else checkPlanningRevision(baseRevision, workspace.revision);
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !['PLANNING_CORRUPT', 'PLANNING_INCOMPATIBLE'].includes(String(error.code))
        )
          throw error;
      }
      return {
        workspace: persist(emptyPlanningWorkspace()),
        presets: structuredClone(planningPresets.filter(p => !p.hidden)),
        frequencyResources: structuredClone(planningFrequencyResources),
        adjustmentExamples: structuredClone(planningAdjustmentExamples),
      };
    },
  };
}
