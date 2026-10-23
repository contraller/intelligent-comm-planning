import { emptyInterferenceWorkspace, validateInterferenceWorkspace, validateAdoptedPlan } from './interference-storage';
import {
  PLANNING_PHASE_MS,
  PLANNING_PRESET_VERSION,
  PLANNING_SCHEMA_VERSION,
  PLANNING_STORAGE_KEY,
} from '../config/demo';
import type { ResourceStorage } from '../types/resource-edit';
import type { PlanningPreset, PlanningWorkspace } from '../types/planning';
import { assertMockResultDetails } from './planning-result-details-mock';
import {
  assertResult,
  checksPass,
  matchesPresetCoverage,
  inputSignature,
  planningResultDetailsContext,
  resultForJob,
  sameValue,
  validatePlanningInput,
  validateSaveFields,
} from './planning-validation';
import type { ResourcesData } from '../types/domain';
import { ApiError } from './types';
import { matchPlanningAdjustment } from './planning-adjustment';
import { assertPlanningResultIdentity, normalizeResultInput, planningResultPresetId } from './planning-result-identity';
import { assertJobSolutions, projectSolutionJob } from './planning-solutions';

export function emptyPlanningWorkspace(): PlanningWorkspace {
  return {
    schemaVersion: PLANNING_SCHEMA_VERSION,
    presetVersion: PLANNING_PRESET_VERSION,
    revision: 'initial',
    interference: emptyInterferenceWorkspace(),
    jobs: [],
    plans: [],
    currentConfirmedByTask: {},
  };
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const unique = (values: string[]) =>
  values.every(identifier) && new Set(values).size === values.length;
export function validateWorkspace(workspace: PlanningWorkspace, presets: PlanningPreset[]) {
  if (
    !workspace ||
    workspace.schemaVersion !== PLANNING_SCHEMA_VERSION ||
    workspace.presetVersion !== PLANNING_PRESET_VERSION
  )
    throw new ApiError('规划存储版本不兼容；原记录已保留', 'PLANNING_INCOMPATIBLE');
  const fail = () => {
    throw new Error('规划工作区字段或引用无效');
  };
  if (
    !identifier(workspace.revision) ||
    !Array.isArray(workspace.jobs) ||
    !Array.isArray(workspace.plans) ||
    !workspace.currentConfirmedByTask ||
    Array.isArray(workspace.currentConfirmedByTask) ||
    typeof workspace.currentConfirmedByTask !== 'object'
  )
    fail();
  for (const field of ['id', 'requestId', 'inputVersion', 'snapshotId'] as const)
    if (!unique(workspace.jobs.map((j) => j[field]))) fail();
  if (workspace.revision === 'initial' && (workspace.jobs.length || workspace.plans.length || workspace.interference?.runs.length || workspace.interference?.receipts.length)) fail();
  if (
    !unique(workspace.plans.map((p) => p.id)) ||
    !unique(workspace.plans.flatMap((p) => p.jobId === null ? [] : [JSON.stringify([p.jobId, p.solutionId ?? null])])) ||
    !unique(workspace.plans.map((p) => p.workflow!.saveRequestId))
  )
    fail();
  for (const job of workspace.jobs) {
    // 采纳来源只属于保存方案，不能伪装成规划作业以绕过调整来源检查。
    if (Object.hasOwn(job, 'interferenceOrigin') || Object.hasOwn(job, 'solutionOrigin') || job.resultPresetId !== undefined && job.adjustment === undefined) fail();
    assertPlanningResultIdentity(job);
    const preset = presets.find((p) => p.id === planningResultPresetId(job));
    if (
      !preset ||
      !identifier(job.taskId) ||
      job.presetVersion !== workspace.presetVersion ||
      !Number.isFinite(job.startedAt) ||
      job.startedAt < 0 ||
      (job.cancelledAt !== null &&
        (!Number.isFinite(job.cancelledAt) || job.cancelledAt < job.startedAt))
    )
      fail();
    const baseline = preset!.baseline;
    assertJobSolutions(job, preset!, presets);
    if (job.cancelledAt !== null && job.cancelledAt >= job.startedAt + PLANNING_PHASE_MS * 6)
      fail();
    if (
      validatePlanningInput(job.input, {
        ...baseline,
        models: [],
        antennas: [],
        source: '',
        version: '',
      } as ResourcesData).length ||
      !sameValue(inputSignature(normalizeResultInput(job.input, preset!.id)), inputSignature(preset!.input)) ||
      !sameValue(job.inputSnapshot, baseline)
    )
      fail();
    if (!identifier(job.dependencies?.resourceEpoch)) fail();
    // 当前作业必须带原始读取身份，缺失时拒绝而不补造版本。
    if (!identifier(job.resourceReadRevision) || !identifier(job.taskInputVersion)) fail();
    if (job.cancelRequestId !== undefined && (!identifier(job.cancelRequestId) || job.cancelledAt === null)) fail();
    // 预设未提供覆盖时允许缺失；已有覆盖必须匹配当前固定资产。
    if (job.coverage !== undefined && !matchesPresetCoverage(preset!.id, job.coverage)) fail();
    // 有明细时校验冻结内容，不为无明细的预设生成结果。
    if (job.resultDetails !== undefined) {
      const result = resultForJob(job, preset!);
      if (!result) fail();
      assertMockResultDetails(job.resultDetails, { presetId: preset!.id, input: job.input,
        context: planningResultDetailsContext(result!, job.input) });
    }
    if(!job.dependencies.task||!identifier(job.dependencies.task.conditionVersion)||job.dependencies.task.conditionVersion==='legacy'||job.dependencies.task.id!==job.taskId)fail();
    if(!identifier(job.dependencies.interferenceVersion))fail();
    for (const [field, rows] of [
      ['stationVersions', baseline.stations],
      ['deviceVersions', baseline.devices],
    ] as const) {
      const map = job.dependencies[field];
      if (
        !map ||
        !sameValue(Object.keys(map).sort(), rows.map((r) => r.id).sort()) ||
        !Object.values(map).every(identifier)
      )
        fail();
    }
    if (
      job.parentPlanVersionId !== null &&
      !workspace.plans.some(
        (p) =>
          p.id === job.parentPlanVersionId &&
          p.taskId === job.taskId &&
          p.jobId !== job.id &&
          Date.parse(p.workflow!.savedAt) <= job.startedAt,
      )
    )
      fail();
    if (job.adjustment !== undefined) {
      const parent = workspace.plans.find(plan => plan.id === job.parentPlanVersionId);
      if (!parent?.workflow || !identifier(job.resultPresetId) || !sameValue(parent.workflow.input, job.input) ||
        !sameValue(parent.inputSnapshot, job.inputSnapshot)) fail();
      if (!sameValue(parent!.workflow!.dependencies, job.dependencies)) fail();
      // 历史读取只核对当时冻结输入；当前来源变化不抹除已完成调整。
      const matched = matchPlanningAdjustment(job.adjustment, { ...parent!, sourceChanged: false }, presets);
      if (matched.id !== job.resultPresetId) fail();
    }
  }
  // 默认结果沿用作业快照，其他备选的快照也必须全工作区唯一。
  if (!unique(workspace.jobs.flatMap(j => [j.snapshotId, ...(j.solutions?.slice(1).map(s => s.result.snapshotId) ?? [])]))) fail();
  validateInterferenceWorkspace(workspace.interference, workspace.plans);
  for (const plan of workspace.plans) {
    if (plan.workflow) assertPlanningResultIdentity(plan.workflow);
    // 采纳版本来自分析快照，不伪造规划作业。
    if (plan.workflow?.interferenceOrigin) {
      if (plan.coverage !== undefined) fail(); // 采纳结果尚无独立场强图，不能沿用父方案图片。
      validateAdoptedPlan(plan, workspace.interference);
      continue;
    }
    const originalJob = workspace.jobs.find((j) => j.id === plan.jobId);
    const job = originalJob && projectSolutionJob(originalJob, plan.solutionId);
    const preset = job && presets.find((p) => p.id === planningResultPresetId(job));
    if (!job || !preset || job.cancelledAt !== null || preset.executionError) fail();
    const expected = resultForJob(job!, preset!);
    if (!expected) fail();
    const flow = plan.workflow!;
    if (
      !flow ||
      !['SAVED', 'REFERENCE', 'CONFIRMED'].includes(plan.state) ||
      typeof plan.sourceChanged !== 'boolean' ||
      !identifier(plan.version) ||
      plan.taskId !== job!.taskId ||
      plan.snapshotId !== job!.snapshotId ||
      plan.preset !== preset!.label
    )
      fail();
    validateSaveFields(plan.name, flow.note);
    if (
      !Number.isFinite(Date.parse(flow.savedAt)) ||
      Date.parse(flow.savedAt) < job!.startedAt + PLANNING_PHASE_MS * 6 ||
      !sameValue(flow.input, job!.input) ||
      !sameValue(flow.adjustment, job!.adjustment) ||
      flow.resultPresetId !== job!.resultPresetId ||
      !sameValue(flow.solutionOrigin, job!.solutionOrigin) ||
      flow.inputVersion !== job!.inputVersion ||
      flow.parentPlanVersionId !== job!.parentPlanVersionId ||
      typeof flow.changeSummary !== 'string' ||
      flow.presetVersion !== job!.presetVersion ||
      !sameValue(flow.dependencies, job!.dependencies) ||
      !sameValue(flow.outcome, preset!.outcome)
    )
      fail();
    for (const field of ['inputSnapshot', 'links', 'regions', 'coverage', 'resultDetails', 'metrics', 'notes'] as const)
      if (!sameValue(plan[field], expected![field])) fail();
    for (const field of ['configuration', 'checks', 'deploymentCost', 'costUnit'] as const)
      if (!sameValue(flow[field], expected![field])) fail();
    if (!sameValue(plan.stationIds, job!.input.stationIds)) fail();
    assertResult(expected!, job!.input, planningResultPresetId(job!));
    if (plan.state !== 'REFERENCE' && (!checksPass(flow.checks) || flow.outcome.code !== 0)) fail();
    if (plan.state === 'CONFIRMED') {
      if (
        !flow.confirmation ||
        !identifier(flow.confirmation.requestId) ||
        !Number.isFinite(Date.parse(flow.confirmation.confirmedAt)) ||
        Date.parse(flow.confirmation.confirmedAt) < Date.parse(flow.savedAt) ||
        !sameValue(flow.confirmation.configuration, flow.configuration)
      )
        fail();
    } else if (flow.confirmation !== null) fail();
  }
  const confirmations = workspace.plans.flatMap((p) =>
    p.workflow!.confirmation ? [p.workflow!.confirmation.requestId] : [],
  );
  if (!unique(confirmations)) fail();
  for (const [taskId, id] of Object.entries(workspace.currentConfirmedByTask))
    if (!workspace.plans.some((p) => p.id === id && p.taskId === taskId && p.state === 'CONFIRMED'))
      fail();
  for (const plan of workspace.plans)
    if (plan.state === 'CONFIRMED' && !Object.hasOwn(workspace.currentConfirmedByTask, plan.taskId))
      fail();
}
export function readPlanning(
  storage: ResourceStorage,
  presets: PlanningPreset[],
): PlanningWorkspace {
  let text: string | null;
  try {
    text = storage.getItem(PLANNING_STORAGE_KEY);
  } catch {
    throw new ApiError('无法读取规划工作区，请检查浏览器权限后重试', 'PLANNING_READ_FAILED');
  }
  if (text === null) return emptyPlanningWorkspace();
  try {
    const workspace = JSON.parse(text) as PlanningWorkspace;
    validateWorkspace(workspace, presets);
    return workspace;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'PLANNING_INCOMPATIBLE') throw error;
    throw new ApiError(
      '规划记录损坏；原记录已保留，可查看内置方案或明确重置规划工作区',
      'PLANNING_CORRUPT',
    );
  }
}
export function checkPlanningRevision(expected: string, actual: string) {
  if (expected !== actual)
    throw new ApiError('规划版本已变化，输入已保留；请重新加载后再操作', 'PLANNING_CONFLICT');
}
export function writePlanning(
  storage: ResourceStorage,
  workspace: PlanningWorkspace,
  presets: PlanningPreset[],
) {
  validateWorkspace(workspace, presets);
  try {
    storage.setItem(PLANNING_STORAGE_KEY, JSON.stringify(workspace));
  } catch {
    throw new ApiError(
      '规划保存失败：存储被拒绝或空间不足；原记录和输入已保留',
      'PLANNING_WRITE_FAILED',
    );
  }
}
