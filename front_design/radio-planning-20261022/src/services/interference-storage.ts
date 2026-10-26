import type { PlanVersion } from '../types/domain';
import type { InterferenceWorkspace } from '../types/interference';
import { INTERFERENCE_PHASE_MS } from '../config/demo';
import { interferencePhases } from '../mocks/interference-presets';
import { assertAdoptedSnapshot, assertFrozenAnalysis } from './interference-validation';
import { sameValue, validateSaveFields, checksPass } from './planning-validation';
import { resourceIdValid } from './resource-validation';
import { ApiError } from './types';

export const emptyInterferenceWorkspace = (): InterferenceWorkspace => ({ runs: [], receipts: [] });
const unique = (ids: string[]) => ids.every(resourceIdValid) && new Set(ids).size === ids.length;
const fail = (): never => { throw new ApiError('分析或采纳记录损坏，原记录保留', 'INVALID_ANALYSIS'); };
// 分析结构校验独立于读写，实现仍由规划存储完成一次持久化。
export function validateInterferenceWorkspace(workspace: InterferenceWorkspace, plans: PlanVersion[]) {
  if (!workspace || !Array.isArray(workspace.runs) || !Array.isArray(workspace.receipts)) fail();
  for (const key of ['analysisId', 'jobId', 'requestId'] as const)
    if (!unique(workspace.runs.map(run => run[key]))) fail();
  for (const run of workspace.runs) {
    assertFrozenAnalysis(run);
    if (run.cancelledAt !== null && (!Number.isFinite(run.cancelledAt) || run.cancelledAt < run.startedAt ||
        run.cancelledAt >= run.startedAt + INTERFERENCE_PHASE_MS * interferencePhases.length)) fail();
    const parent = plans.find(plan => plan.id === run.network.id && plan.taskId === run.network.taskId);
    if (!parent || run.analysisId === run.jobId || Date.parse(run.network.workflow!.confirmation!.confirmedAt) > run.startedAt) fail();
    // 来源变化标记是动态视图；其余父快照必须逐项对应真实保存版本。
    const { sourceChanged: _current, ...currentSnapshot } = parent!;
    const { sourceChanged: _frozen, ...frozenSnapshot } = run.network;
    if (!sameValue(currentSnapshot, frozenSnapshot)) fail();
  }
  if (!unique(workspace.receipts.map(receipt => receipt.requestId))) fail();
  for (const receipt of workspace.receipts) {
    const run = workspace.runs.find(row => row.analysisId === receipt.analysisId);
    const plan = plans.find(row => row.id === receipt.planId);
    if (!run || !plan || plan.workflow?.interferenceOrigin?.analysisId !== run.analysisId ||
        plan.workflow.interferenceOrigin.measureId !== receipt.measureId) fail();
  }
}
export function validateAdoptedPlan(plan: PlanVersion, workspace: InterferenceWorkspace) {
  assertAdoptedSnapshot(plan);
  const flow = plan.workflow!, origin = flow.interferenceOrigin!;
  const run = workspace.runs.find(row => row.analysisId === origin.analysisId);
  if (!run || run.cancelledAt !== null || run.scenarioId === 'failed' ||
      run.network.id !== origin.sourcePlanId || plan.taskId !== run.network.taskId ||
      !sameValue(flow.input, run.network.workflow!.input) ||
      // 采纳直接来源是措施，只继承结果基线，不冒充新的人工调整。
      flow.adjustment !== undefined || flow.resultPresetId !== run.network.workflow!.resultPresetId ||
      flow.inputVersion !== run.network.workflow!.inputVersion ||
      !sameValue(flow.dependencies, run.dependencies) || !sameValue(origin.sources, run.sources) ||
      origin.scenarioId !== run.scenarioId || typeof plan.sourceChanged !== 'boolean' ||
      !resourceIdValid(plan.snapshotId) || !resourceIdValid(plan.version) ||
      typeof flow.changeSummary !== 'string' || !flow.changeSummary ||
      flow.presetVersion !== run.network.workflow!.presetVersion ||
      !resourceIdValid(flow.saveRequestId) || !checksPass(flow.checks) || flow.outcome.code !== 0 ||
      !Number.isFinite(Date.parse(flow.savedAt)) ||
      Date.parse(flow.savedAt) < run.startedAt + INTERFERENCE_PHASE_MS * interferencePhases.length) fail();
  validateSaveFields(plan.name, flow.note);
  // 旧 Run 只允许旧式缺省；新采纳必须完整对应其措施的冻结明细。
  const details = run!.measureResultDetails?.find(row => row.measureId === origin.measureId)?.resultDetails;
  if (!sameValue(plan.resultDetails, details)) fail();
  if (!workspace.receipts.some(receipt => receipt.planId === plan.id && receipt.requestId === flow.saveRequestId)) fail();
  if (plan.state === 'CONFIRMED') {
    if (!flow.confirmation || !resourceIdValid(flow.confirmation.requestId) ||
        !Number.isFinite(Date.parse(flow.confirmation.confirmedAt)) ||
        Date.parse(flow.confirmation.confirmedAt) < Date.parse(flow.savedAt) ||
        !sameValue(flow.confirmation.configuration, flow.configuration)) fail();
  } else if (plan.state !== 'SAVED' || flow.confirmation !== null) fail();
  if (workspace.receipts.some(receipt => receipt.analysisId === origin.analysisId && receipt.measureId === origin.measureId && receipt.planId !== plan.id)) fail();
}
