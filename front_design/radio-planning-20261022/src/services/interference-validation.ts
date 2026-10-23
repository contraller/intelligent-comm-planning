import type { InterferenceSource, PlanVersion } from '../types/domain';
import type { PlanningInput, PlanningWorkspace } from '../types/planning';
import type { ResourceMeta } from '../types/resource-edit';
import type { InterferenceRun, InterferenceScenarioId, InterferenceSourceState, InterferenceSubmit } from '../types/interference';
import { INTERFERENCE_PRESET_VERSION } from '../config/demo';
import { planningPresets } from '../mocks/planning-presets';
import { interferenceDemoResult, interferenceScenarios, interferenceVariants } from '../mocks/interference-presets';
import { assertResult, checksPass, dependenciesChanged, inputSignature, matchesPresetCoverage, planningResultDetailsContext, sameValue } from './planning-validation';
import { assertMockResultDetails } from './planning-result-details-mock';
import { bindResultDemands } from './planning-snapshot';
import { taskSourceChanged } from './task-validation';
import { resourceIdValid } from './resource-validation';
import { ApiError } from './types';
import { assertPlanningResultIdentity, normalizeResultInput, planningResultPresetId } from './planning-result-identity';
import { assertPlanningAdjustmentResult } from './planning-adjustment';

export function analysisEligibility(plan: PlanVersion, workspace: PlanningWorkspace, meta: ResourceMeta) {
  const flow = plan.workflow;
  const reason = !flow || plan.state !== 'CONFIRMED' || !flow.confirmation || !checksPass(flow.checks) || flow.outcome.code !== 0
    ? '需要完整且已确认的方案'
    : workspace.currentConfirmedByTask[plan.taskId] !== plan.id ? '该确认版本已被替换'
    : dependenciesChanged({ ...flow.dependencies, interferenceVersion: meta.interferenceVersion ?? 'initial' }, meta) ||
      taskSourceChanged(plan.taskId, flow.input, meta, flow.dependencies.task?.conditionVersion)
      ? '任务、站点、设备或资源基线已变化' : '';
  return { eligible: !reason, reason, interferenceOnly: !reason && (flow!.dependencies.interferenceVersion ?? 'initial') !== (meta.interferenceVersion ?? 'initial') };
}
export function interferenceSourceState(run: InterferenceRun, workspace: PlanningWorkspace | null, meta: ResourceMeta | null): InterferenceSourceState {
  if (!workspace || !meta) return { state: 'UNKNOWN', reasons: ['当前来源无法核实，冻结结果仍可查看'] };
  const current = workspace.plans.find(plan => plan.id === run.network.id);
  const reasons: string[] = [];
  if (!current || workspace.currentConfirmedByTask[run.network.taskId] !== run.network.id ||
      current.workflow?.confirmation?.requestId !== run.network.workflow?.confirmation?.requestId)
    reasons.push('源确认版本已替换或缺失');
  if (dependenciesChanged(run.dependencies, meta) ||
      taskSourceChanged(run.network.taskId, run.network.workflow!.input, meta, run.dependencies.task?.conditionVersion))
    reasons.push('分析提交后的任务、资源或干扰源已变化');
  return { state: reasons.length ? 'HISTORICAL' : 'CURRENT', reasons };
}
// 名称/来源标签仅展示，物理参数、身份、点位和生效状态均必须匹配。
function sourceParameters(source: InterferenceSource) {
  const { name: _name, origin: _origin, ...parameters } = source;
  return parameters;
}
export function matchingSources(sources: InterferenceSource[], expected: InterferenceSource[]) {
  return sources.length === expected.length && new Set(sources.map(row => row.id)).size === sources.length &&
    sources.every(row => expected.some(candidate => candidate.id === row.id && sameValue(sourceParameters(row), sourceParameters(candidate))));
}
export function requireInterferenceScenario(id: InterferenceScenarioId) {
  const scenario = interferenceScenarios.find(row => row.id === id);
  if (!scenario) throw new ApiError('干扰教学场景不存在', 'NO_PRESET');
  return scenario;
}
export function assertBaseNetwork(plan: PlanVersion) {
  const flow = plan.workflow;
  if (flow) assertPlanningResultIdentity(flow);
  const preset = planningPresets.find(row => flow && row.id === planningResultPresetId(flow) && ['balanced', 'economical'].includes(row.id));
  if (!flow || flow.interferenceOrigin || !preset?.result || !sameValue(inputSignature(normalizeResultInput(flow.input, preset.id)), inputSignature(preset.input)))
    throw new ApiError('该网络配置暂无干扰预生成结果，不能忽略已有调整', 'NO_PRESET');
  if (flow.adjustment) {
    if (flow.resultPresetId === undefined) throw new ApiError('调整网络缺少结果身份', 'INVALID_RESULT');
    assertPlanningAdjustmentResult(flow.adjustment, { input: flow.input, configuration: flow.configuration, nodeIds: plan.inputSnapshot.stations.map(row => row.id) });
    if (plan.coverage !== undefined && !matchesPresetCoverage(preset.id, plan.coverage))
      throw new ApiError('调整网络覆盖与结果身份不一致', 'INVALID_RESULT');
  }
  const expected = bindResultDemands(preset.result, flow.input, preset.input);
  for (const field of ['links', 'regions', 'metrics', 'notes'] as const)
    if (!sameValue(plan[field], expected[field])) throw new ApiError('网络结果与干扰预设不一致', 'NO_PRESET');
  if (!sameValue(plan.inputSnapshot, preset.baseline) || !sameValue(flow.configuration, expected.configuration) ||
      !sameValue(flow.checks, expected.checks) || !sameValue(flow.confirmation?.configuration, flow.configuration))
    throw new ApiError('网络快照与干扰预设不一致', 'NO_PRESET');
  if (plan.resultDetails !== undefined) assertMockResultDetails(plan.resultDetails, { presetId: preset.id, input: flow.input,
    context: planningResultDetailsContext({ ...expected, inputSnapshot: plan.inputSnapshot }, flow.input) });
}
export function validateInterferenceSubmit(request: InterferenceSubmit, network: PlanVersion, sources: InterferenceSource[]) {
  if (!resourceIdValid(request.requestId) || !Array.isArray(request.interferenceIds) || !request.interferenceIds.length ||
      new Set(request.interferenceIds).size !== request.interferenceIds.length)
    throw new ApiError('请求标识和干扰源选择无效', 'VALIDATION_ERROR');
  if (sources.length !== request.interferenceIds.length || sources.some(row => !row.active))
    throw new ApiError('请选择存在且已生效的干扰源', 'VALIDATION_ERROR');
  assertBaseNetwork(network);
  const scenario = requireInterferenceScenario(request.scenarioId);
  if (!matchingSources(sources, scenario.sources))
    throw new ApiError('干扰源或参数暂无预生成结果，输入已保留', 'NO_PRESET',
      scenario.sources.map(row => ({ objectId: row.id, field: 'interference', message: scenario.instruction })));
  return interferenceDemoResult(scenario, planningResultPresetId(network.workflow!));
}
export function variantResult(variantId: string, input: PlanningInput, resultPresetId = input.presetId) {
  const variant = interferenceVariants.find(row => row.id === variantId);
  const preset = planningPresets.find(row => row.id === variant?.networkPresetId);
  // 输入保持原任务，只有已验证的结果基线可以决定措施变体。
  if (!variant || !preset || resultPresetId !== preset.id || !sameValue(inputSignature(normalizeResultInput(input, resultPresetId)), inputSignature(preset.input)))
    throw new ApiError('抗干扰方案与任务条件没有对应预设', 'NO_PRESET');
  return { ...bindResultDemands(variant.result, input, preset.input), inputSnapshot: structuredClone(preset.baseline) };
}
export function assertAdoptedSnapshot(plan: PlanVersion) {
  const flow = plan.workflow, origin = flow?.interferenceOrigin;
  if (!flow || !origin || plan.jobId !== null || origin.presetVersion !== INTERFERENCE_PRESET_VERSION ||
      ![origin.analysisId, origin.measureId, origin.sourcePlanId, origin.variantId].every(resourceIdValid))
    throw new ApiError('抗干扰方案来源不完整', 'INVALID_RESULT');
  assertPlanningResultIdentity(flow);
  if (flow.adjustment !== undefined) throw new ApiError('采纳版本不能同时声明人工调整来源', 'INVALID_RESULT');
  const scenario = requireInterferenceScenario(origin.scenarioId);
  const resultPresetId = planningResultPresetId(flow);
  const expected = variantResult(origin.variantId, flow.input, resultPresetId);
  const measure = interferenceDemoResult(scenario, resultPresetId).measures.find(row => row.id === origin.measureId);
  if (!matchingSources(origin.sources, scenario.sources) || !measure?.variantId || measure.variantId !== origin.variantId ||
      flow.parentPlanVersionId !== origin.sourcePlanId || !sameValue(plan.stationIds, flow.input.stationIds))
    throw new ApiError('抗干扰方案来源与措施不一致', 'INVALID_RESULT');
  for (const field of ['inputSnapshot', 'links', 'regions', 'metrics', 'notes'] as const)
    if (!sameValue(plan[field], expected[field])) throw new ApiError('抗干扰方案冻结结果被改变', 'INVALID_RESULT');
  for (const field of ['configuration', 'checks', 'deploymentCost', 'costUnit'] as const)
    if (!sameValue(flow[field], expected[field])) throw new ApiError('抗干扰方案冻结配置被改变', 'INVALID_RESULT');
  // 诊断历史可凭采纳来源与明细版本独立检查，无须上游分析记录仍存在。
  if (plan.resultDetails !== undefined) assertMockResultDetails(plan.resultDetails, { variantId: origin.variantId, input: flow.input,
    context: planningResultDetailsContext(expected, flow.input) });
  assertResult({ ...expected, snapshotId: plan.snapshotId, resultDetails: plan.resultDetails }, flow.input, resultPresetId);
}
export function assertFrozenAnalysis(run: InterferenceRun) {
  if (!run || run.presetVersion !== INTERFERENCE_PRESET_VERSION ||
      ![run.jobId, run.analysisId, run.requestId].every(resourceIdValid) ||
      !Number.isFinite(run.startedAt) || run.startedAt < 0 ||
      run.network?.state !== 'CONFIRMED' || !run.network.workflow?.confirmation)
    throw new ApiError('分析快照无效', 'INVALID_ANALYSIS');
  assertBaseNetwork(run.network);
  const expected = validateInterferenceSubmit({
    requestId: run.requestId, planId: run.network.id, scenarioId: run.scenarioId,
    interferenceIds: run.sources.map(row => row.id), baseRevision: '', baseResourceRevision: '',
  }, run.network, run.sources);
  const expectedDependencies = { ...run.network.workflow.dependencies, interferenceVersion: run.dependencies?.interferenceVersion };
  if (!resourceIdValid(run.dependencies?.interferenceVersion) || !sameValue(run.dependencies, expectedDependencies) || !sameValue(run.result, expected))
    throw new ApiError('分析结果或依赖快照被改变', 'INVALID_ANALYSIS');
  // 整组缺省是合法旧记录；存在时每个有效措施必须恰好有一份完整明细。
  if (run.measureResultDetails !== undefined) {
    const valid = expected.measures.filter(measure => run.scenarioId !== 'failed' && measure.variantId && !measure.unavailableReason);
    if (!Array.isArray(run.measureResultDetails) || run.measureResultDetails.length !== valid.length ||
        new Set(run.measureResultDetails.map(row => row?.measureId)).size !== valid.length)
      throw new ApiError('措施明细集合不完整', 'INVALID_ANALYSIS');
    for (const row of run.measureResultDetails) {
      const measure = valid.find(item => item.id === row?.measureId);
      if (!measure?.variantId) throw new ApiError('措施明细引用无效', 'INVALID_ANALYSIS');
      const result = variantResult(measure.variantId, run.network.workflow.input, planningResultPresetId(run.network.workflow));
      assertMockResultDetails(row.resultDetails, { variantId: measure.variantId, input: run.network.workflow.input,
        context: planningResultDetailsContext(result, run.network.workflow.input) });
    }
  }
}
