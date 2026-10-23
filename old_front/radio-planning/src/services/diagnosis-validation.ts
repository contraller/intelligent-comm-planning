import { diagnosisNetworkKey, networkInterferenceIds } from './diagnosis-catalog';
import { assertAdoptedSnapshot } from './interference-validation';
import type { PlanVersion } from '../types/domain';
import type { ResourceMeta } from '../types/resource-edit';
import type { PlanningWorkspace } from '../types/planning';
import type { DiagnosisDraft, DiagnosisIssue, DiagnosisPreset, DiagnosisResult, DiagnosisSourceState, FaultInput } from '../types/diagnosis';
import { DIAGNOSIS_MAX_FAULTS } from '../config/demo';
import { taskSourceChanged } from './task-validation';
import { diagnosisSymptoms } from '../mocks/diagnosis-presets';
import { planningPresets } from '../mocks/planning-presets';
import { assertResult, checksPass, dependenciesChanged, inputSignature, planningResultDetailsContext, sameValue } from './planning-validation';
import { assertMockResultDetails } from './planning-result-details-mock';
import { ApiError } from './types';
import { assertPlanningResultIdentity, normalizeResultInput, planningResultPresetId } from './planning-result-identity';
import { assertPlanningAdjustmentResult } from './planning-adjustment';

export const faultKey = (fault: Pick<FaultInput, 'objectType' | 'objectId'>) => `${fault.objectType}:${fault.objectId}`;
export function eligibleDiagnosisPlans(workspace: PlanningWorkspace, meta: ResourceMeta) {
  return workspace.plans.filter((plan) => plan.workflow && plan.state === 'CONFIRMED' &&
    workspace.currentConfirmedByTask[plan.taskId] === plan.id && plan.workflow.confirmation &&
    plan.workflow.outcome.code === 0 && checksPass(plan.workflow.checks) && !dependenciesChanged(plan.workflow.dependencies, meta)&&!taskSourceChanged(plan.taskId,plan.workflow.input,meta,plan.workflow.dependencies.task?.conditionVersion));
}
export function diagnosisSource(network: PlanVersion, workspace: PlanningWorkspace | null, meta: ResourceMeta | null): DiagnosisSourceState {
  if (!workspace || !meta) return { state: 'UNKNOWN', reasons: ['当前有效性无法核实；仅可查看冻结历史'] };
  if (!network.workflow) return { state: 'HISTORICAL', reasons: ['内置历史快照，不作为新诊断入口'] };
  const reasons: string[] = [];
  const current = workspace.plans.find((p) => p.id === network.id);
  if (!current) reasons.push('源规划已重置或缺失');
  else if (workspace.currentConfirmedByTask[network.taskId] !== network.id ||
    current.workflow?.confirmation?.requestId !== network.workflow.confirmation?.requestId) reasons.push('当前确认版本已替换');
  if(taskSourceChanged(network.taskId,network.workflow.input,meta,network.workflow.dependencies.task?.conditionVersion))reasons.push('任务规划条件已变化');
  if (dependenciesChanged(network.workflow.dependencies, meta)) reasons.push('相关资源已变化');
  return { state: reasons.length ? 'HISTORICAL' : 'CURRENT', reasons };
}
export function validateDiagnosisDraft(draft: DiagnosisDraft, plan: PlanVersion): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = [];
  const add = (field: string, message: string, row?: number, objectId?: string) => issues.push({ field, message, row, objectId });
  if (typeof draft?.name !== 'string' || !draft.name.trim() || draft.name.trim().length > 80) add('name', '场景名称需为 1–80 字');
  if (typeof draft?.description !== 'string' || draft.description.length > 500) add('description', '备注最多 500 字');
  if (draft?.planId !== plan.id) add('planId', '场景与所选方案不一致');
  if (!Array.isArray(draft?.faults) || draft.faults.length < 1 || draft.faults.length > DIAGNOSIS_MAX_FAULTS) {
    add('faults', `每个场景需 1–${DIAGNOSIS_MAX_FAULTS} 个故障对象`); return issues;
  }
  const seen = new Set<string>();
  draft.faults.forEach((fault, index) => {
    const row = index + 1;
    if (!fault || !['NODE','DEVICE','LINK'].includes(fault.objectType)) { add('objectType', '对象类型无效', row); return; }
    const key = faultKey(fault);
    if (seen.has(key)) add('objectId', '同一场景不能重复标记对象', row, fault.objectId);
    seen.add(key);
    const objects = fault.objectType === 'NODE' ? plan.inputSnapshot.stations : fault.objectType === 'DEVICE' ? plan.inputSnapshot.devices : plan.links;
    if (!objects.some((item) => item.id === fault.objectId)) add('objectId', '对象不在所选网络快照中', row, fault.objectId);
    const allowed = { HW_FAILURE: ['NODE','DEVICE'], LINK_DOWN: ['LINK'], SW_CONFIG: ['NODE','DEVICE'], EMI: ['NODE','LINK'] };
    if (!allowed[fault.faultType]?.includes(fault.objectType)) add('faultType', '故障类型不适用于该对象', row, fault.objectId);
    if (!Array.isArray(fault.symptomIds) || new Set(fault.symptomIds).size !== fault.symptomIds.length ||
      fault.symptomIds.some((id) => !diagnosisSymptoms.some((s) => s.id === id))) add('symptomIds', '现象 ID 无效或重复', row, fault.objectId);
    // Date.parse 会归一化 2 月 30 日，额外校验日历日期避免接受无效输入。
    const time = fault.occurTime;
    if (time !== null && (typeof time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(time) || !Number.isFinite(Date.parse(time)) || new Date(time.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10) !== time.slice(0,10))) add('occurTime', '发生时间需为带时区的有效 ISO 时间或留空', row, fault.objectId);
    if (fault.interferenceId !== null && !networkInterferenceIds(plan).includes(fault.interferenceId)) add('interferenceId', '干扰源 ID 不在教学字典中', row, fault.objectId);
    if (fault.faultType !== 'EMI' && fault.interferenceId !== null) add('interferenceId', '非干扰场景请清空干扰源', row, fault.objectId);
  });
  return issues;
}
export function faultSignature(faults: FaultInput[]) {
  return faults.map(({ occurTime: _time, ...f }) => ({ ...f, symptomIds: [...f.symptomIds].sort() })).sort((a,b) => faultKey(a).localeCompare(faultKey(b)));
}
export function assertDiagnosisNetwork(plan: PlanVersion) {
  const flow = plan.workflow;
  if (flow) assertPlanningResultIdentity(flow);
  if (flow?.interferenceOrigin) {
    assertAdoptedSnapshot(plan);
    if (plan.state !== 'CONFIRMED' || !flow.confirmation || !checksPass(flow.checks) || flow.outcome.code !== 0 ||
        !sameValue(flow.confirmation.configuration, flow.configuration))
      throw new ApiError('抗干扰方案尚未有效确认', 'INVALID_NETWORK');
    return;
  }
  const preset = planningPresets.find((p) => flow && p.id === planningResultPresetId(flow) && ['balanced','economical'].includes(p.id));
  if (!flow || !preset?.result || plan.state !== 'CONFIRMED' || !flow.confirmation || !checksPass(flow.checks))
    throw new ApiError('网络不是受支持的有效确认快照', 'INVALID_NETWORK');
  // 历史诊断可以脱离原规划记录，仍须校验明确的调整值与此冻结结果一致。
  if (flow.adjustment) {
    if (flow.resultPresetId === undefined) throw new ApiError('调整网络缺少结果身份', 'INVALID_NETWORK');
    assertPlanningAdjustmentResult(flow.adjustment, { input: flow.input, configuration: flow.configuration, nodeIds: plan.inputSnapshot.stations.map(row => row.id) });
  }
  const expectedConfiguration = structuredClone(preset.result.configuration);
  // 只映射保存时的需求身份，不调整路由或业务结果。
  for (const route of expectedConfiguration.routes) {
    const source = preset.input.demands.find((d) => d.id === route.demandId)!;
    route.demandId = flow.input.demands.find((d) => d.sourceId === source.sourceId && d.targetId === source.targetId && d.service === source.service)?.id ?? '';
  }
  // 只替换结果身份参与匹配，任务频率、需求和条件仍逐项核对。
  if (!sameValue(inputSignature(normalizeResultInput(flow.input, preset.id)), inputSignature(preset.input)) || !sameValue(plan.inputSnapshot, preset.baseline) ||
    !sameValue(plan.links, preset.result.links) || !sameValue(plan.regions, preset.result.regions) || !sameValue(plan.metrics, preset.result.metrics) ||
    !sameValue(flow.configuration, expectedConfiguration) || !sameValue(flow.confirmation.configuration, expectedConfiguration))
    throw new ApiError('网络输入或配置暂无对应预生成诊断结果', 'NO_PRESET');
  const result = { ...preset.result, snapshotId: plan.snapshotId, inputSnapshot: plan.inputSnapshot,
    configuration: expectedConfiguration, resultDetails: plan.resultDetails, coverage: plan.coverage };
  // 只检查诊断保存的附加数据，不向旧网络补入新资产。
  if (plan.resultDetails !== undefined) assertMockResultDetails(plan.resultDetails, { presetId: preset.id, input: flow.input,
    context: planningResultDetailsContext(result, flow.input) });
  assertResult(result, flow.input, preset.id);
}
export function matchDiagnosisPreset(draft: DiagnosisDraft, plan: PlanVersion, presets: DiagnosisPreset[]) {
  const issues = validateDiagnosisDraft(draft, plan);
  if (issues.length) throw new ApiError('请修正故障场景', 3003, issues);
  assertDiagnosisNetwork(plan);
  const preset = presets.find((p) => p.networkPresetId === diagnosisNetworkKey(plan) && sameValue(faultSignature(p.faults), faultSignature(draft.faults)));
  if (!preset) throw new ApiError('当前输入暂无预生成结果', 'NO_PRESET', [{ field: 'faults', message: '故障对象、类型、现象或干扰源与已准备模板不一致' }]);
  return preset;
}
export function bindDiagnosisResult(result: DiagnosisResult, draft: DiagnosisDraft, network: PlanVersion): DiagnosisResult {
  const copy = structuredClone(result);
  for (const conclusion of copy.conclusions) if (conclusion.fault) {
    const f = draft.faults.find((item) => faultKey(item) === faultKey(conclusion.fault!));
    if (!f) throw new ApiError('结论与故障身份不一致', 'INVALID_RESULT');
    conclusion.fault = structuredClone(f);
  }
  const preset = planningPresets.find((p) => network.workflow && p.id === planningResultPresetId(network.workflow))!;
  if (copy.summary) copy.summary.affectedDemandIds = copy.summary.affectedDemandIds.map((id) => {
    const original = preset.input.demands.find((d) => d.id === id)!;
    const demand = network.workflow!.input.demands.find((d) => d.sourceId === original.sourceId && d.targetId === original.targetId && d.service === original.service);
    if (!demand) throw new ApiError('影响需求不存在', 'INVALID_RESULT');
    return demand.id;
  });
  return copy;
}
export function assertDiagnosisResult(result: DiagnosisResult, network: PlanVersion, faults: FaultInput[]) {
  const fail = () => { throw new ApiError('诊断结果字段或引用不完整', 'INVALID_RESULT'); };
  const probability = (v: number | null) => v === null || (Number.isFinite(v) && v >= 0 && v <= 1);
  if (!result || !Array.isArray(result.conclusions) || result.conclusions.length !== faults.length || !result.summary) fail();
  for (const c of result.conclusions) {
    if (!c.fault || !faults.some((f) => sameValue(f, c.fault)) || !probability(c.confidence) || typeof c.needManualReview !== 'boolean' || !c.rootCause || !c.chain.length) fail();
    if (new Set(c.branches.map((b) => b.source)).size !== 3 || c.branches.length !== 3) fail();
    for (const b of c.branches) if (!probability(b.confidence) || !probability(b.weight) || !probability(b.contribution) || !Array.isArray(b.evidence) || (b.source === 'ML' && result.fusionMode === 'TWO_WAY_DEGRADED' && (b.confidence !== null || !b.disabledReason))) fail();
    if (c.candidates.some((v) => !probability(v.confidence))) fail();
  }
  for (const row of result.nodes) if (!network.inputSnapshot.stations.some((n) => n.id === row.nodeId) || row.detourRoute.some((id) => !network.inputSnapshot.stations.some((n) => n.id === id))) fail();
  for (const row of result.links) if (!network.links.some((l) => l.id === row.linkId) || (row.faultKey && !faults.some((f) => faultKey(f) === row.faultKey))) fail();
  for (const region of result.regions) {
    if (region.faultKey && !faults.some((f) => faultKey(f) === region.faultKey)) fail();
    if (!region.rings.length || region.rings.some((ring) => ring.length < 4 || !sameValue(ring[0], ring.at(-1)) || ring.some(([x,y]) => !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90))) fail();
  }
  if (result.summary!.affectedDemandIds.some((id) => !network.workflow?.input.demands.some((d) => d.id === id))) fail();
  // 仅校验已提供的案例修复耗时，空值不补零，也不从建议预计值推算。
  for (const suggestion of result.suggestions) for (const item of suggestion.similarCases) {
    const value = item.repairTimeMin;
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail();
  }
  if (Object.entries(result.summary!).some(([key,value]) => key !== 'affectedDemandIds' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) fail();
}
