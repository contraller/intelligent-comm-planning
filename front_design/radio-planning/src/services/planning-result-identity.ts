import type { PlanningAdjustment } from '../types/planning-adjustment';
import type { PlanningInput, PlanningSolutionOrigin } from '../types/planning';
import { ApiError } from './types';

type ResultIdentity = { input: PlanningInput; resultPresetId?: string; adjustment?: PlanningAdjustment;
  parentPlanVersionId?: string | null; interferenceOrigin?: unknown; solutionOrigin?: PlanningSolutionOrigin };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

// 轻量结构验证不加载预设；HTTP 和冻结历史可共同使用。
export function assertPlanningAdjustmentShape(value: unknown): asserts value is PlanningAdjustment {
  const fail = () => { throw new ApiError('调整输入结构无效，请检查设备参数和人工路径', 'VALIDATION_ERROR'); };
  if (!record(value) || value.schemaVersion !== 1 || !id(value.sourcePlanId) || !id(value.sourceSnapshotId) ||
    !Array.isArray(value.manualOverrides) || !Array.isArray(value.manualPaths)) fail();
  const data = value as unknown as PlanningAdjustment;
  if (Object.keys(data).some(key => !['schemaVersion', 'sourcePlanId', 'sourceSnapshotId', 'manualOverrides', 'manualPaths'].includes(key))) fail();
  for (const row of data.manualOverrides) {
    if (!record(row) || !id(row.deviceId) || Object.keys(row).some(key => !['deviceId', 'txPowerDbm', 'antennaHeightM'].includes(key))) fail();
    for (const key of ['txPowerDbm', 'antennaHeightM'] as const)
      if (Object.hasOwn(row, key) && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || key === 'antennaHeightM' && row[key]! < 0)) fail();
  }
  for (const row of data.manualPaths)
    if (!record(row) || !id(row.demandId) || !Array.isArray(row.nodePath) || row.nodePath.length < 2 || !row.nodePath.every(id) ||
      new Set(row.nodePath).size !== row.nodePath.length || Object.keys(row).some(key => !['demandId', 'nodePath'].includes(key))) fail();
  if (new Set(data.manualOverrides.map(row => row.deviceId)).size !== data.manualOverrides.length ||
    new Set(data.manualPaths.map(row => row.demandId)).size !== data.manualPaths.length) fail();
}
export function planningResultPresetId(flow: Pick<ResultIdentity, 'input' | 'resultPresetId'>): string {
  return flow.resultPresetId ?? flow.input.presetId;
}
// 只转换结果档位，保留频率与全部任务业务条件参与后续比对。
export function normalizeResultInput(input: PlanningInput, resultPresetId: string): PlanningInput {
  return { ...input, presetId: resultPresetId };
}
export function assertPlanningResultIdentity(flow: ResultIdentity) {
  if (flow.resultPresetId !== undefined && (!id(flow.resultPresetId) || !flow.adjustment && !flow.interferenceOrigin && !flow.solutionOrigin))
    throw new ApiError('结果身份缺少有效调整来源', 'INVALID_RESULT');
  // 集合来源仅用于原备选保存；完整归属另由作业快照逐项验证。
  if (flow.solutionOrigin !== undefined) {
    const origin = flow.solutionOrigin;
    if (!record(origin) || !id(origin.solutionId) || !id(origin.label) || origin.resultPresetId !== flow.resultPresetId
      || !id(origin.resultPresetId) || origin.radioCount !== null && (!Number.isSafeInteger(origin.radioCount) || origin.radioCount < 0)
      || flow.adjustment || flow.interferenceOrigin) throw new ApiError('备选结果来源无效', 'INVALID_RESULT');
  }
  if (flow.adjustment !== undefined) {
    assertPlanningAdjustmentShape(flow.adjustment);
    if (flow.interferenceOrigin || flow.parentPlanVersionId !== flow.adjustment.sourcePlanId)
      throw new ApiError('调整来源与父版本不一致', 'INVALID_RESULT');
  }
}
