import type { PlanVersion } from '../types/domain';
import type { PlanningAdjustment, PlanningAdjustmentContext, PlanningAdjustmentExample } from '../types/planning-adjustment';
import type { PlanningIssue, PlanningPreset } from '../types/planning';
import { ApiError } from './types';
import { assertPlanningAdjustmentShape, normalizeResultInput, planningResultPresetId } from './planning-result-identity';
import { bindResultDemands } from './planning-snapshot';
import { inputSignature, sameValue } from './planning-validation';
import { optionsAdjustableIds } from '../mocks/planning-options-presets';
import { routingAdjustableIds } from '../mocks/planning-routing-presets';

type Parent = PlanVersion | PlanningAdjustmentContext;
// 仅接收明确发布的完整组合；全部新增任务条件仍参与精确匹配。
const adjustablePresetIds = ['balanced', 'economical', 'deployment-balanced', 'deployment-economical', ...optionsAdjustableIds, ...routingAdjustableIds];
export function planningAdjustmentContext(parent: Parent): PlanningAdjustmentContext {
  if ('configuration' in parent) return parent;
  if (!parent.workflow || !parent.snapshotId) throw new ApiError('此方案缺少可调整的完整快照', 'INVALID_PARENT');
  return { id: parent.id, snapshotId: parent.snapshotId, input: parent.workflow.input,
    configuration: parent.workflow.configuration, nodeIds: parent.inputSnapshot.stations.map(row => row.id) };
}
export function readPlanningAdjustment(value: unknown): PlanningAdjustment {
  assertPlanningAdjustmentShape(value);
  return structuredClone(value);
}
export function createPlanningAdjustment(parent: Parent): PlanningAdjustment {
  const context = planningAdjustmentContext(parent);
  return { schemaVersion: 1, sourcePlanId: context.id, sourceSnapshotId: context.snapshotId, manualOverrides: [], manualPaths: [] };
}
export function validatePlanningAdjustment(adjustment: PlanningAdjustment, parent: Parent): PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  const add = (objectId: string, field: string, message: string) => issues.push({ objectId, field, message });
  try { assertPlanningAdjustmentShape(adjustment); } catch { return [{ objectId: 'ADJUSTMENT', field: 'adjustment', message: '调整字段无效：功率须为有限数值，高度须为非负有限数值，路径至少包含两端' }]; }
  const context = planningAdjustmentContext(parent);
  if (adjustment.sourcePlanId !== context.id || adjustment.sourceSnapshotId !== context.snapshotId)
    add('ADJUSTMENT', 'sourcePlanId', '父方案或父快照不一致');
  const devices = new Set<string>(), demands = new Set<string>();
  for (const row of adjustment.manualOverrides) {
    if (devices.has(row.deviceId) || !context.configuration.devices.some(device => device.deviceId === row.deviceId))
      add(row.deviceId, 'deviceId', '设备 ID 重复或不属于父方案');
    devices.add(row.deviceId);
  }
  for (const row of adjustment.manualPaths) {
    const demand = context.input.demands.find(item => item.id === row.demandId);
    if (demands.has(row.demandId) || !demand) add(row.demandId, 'demandId', '通联需求重复或不属于父方案');
    demands.add(row.demandId);
    if (demand && (row.nodePath[0] !== demand.sourceId || row.nodePath.at(-1) !== demand.targetId))
      add(row.demandId, 'nodePath', '主路径两端须对应通联需求');
    if (new Set(row.nodePath).size !== row.nodePath.length || row.nodePath.some(id => !context.nodeIds.includes(id)))
      add(row.demandId, 'nodePath', '路径节点须属于冻结网络且不得重复');
  }
  return issues;
}
// 独立历史可能已无父记录，只核对明确声明的输入与冻结返回值，不推算省略项。
export function assertPlanningAdjustmentResult(adjustment: PlanningAdjustment,
  context: Pick<PlanningAdjustmentContext, 'input' | 'configuration' | 'nodeIds'>) {
  const issues = validatePlanningAdjustment(adjustment, { ...context, id: adjustment?.sourcePlanId, snapshotId: adjustment?.sourceSnapshotId });
  if (issues.length) throw new ApiError('调整来源字段与冻结网络无法关联', 'INVALID_RESULT', issues);
  for (const override of adjustment.manualOverrides) {
    const device = context.configuration.devices.find(row => row.deviceId === override.deviceId)!;
    for (const field of ['txPowerDbm', 'antennaHeightM'] as const)
      if (Object.hasOwn(override, field) && override[field] !== device[field])
        throw new ApiError('调整设备输入与冻结结果不一致', 'INVALID_RESULT', [{ objectId: override.deviceId, field, message: '已声明的人工参数与返回配置不一致' }]);
  }
  for (const path of adjustment.manualPaths) {
    const routes = context.configuration.routes.filter(row => !row.backup && row.demandId === path.demandId);
    if (routes.length !== 1 || !sameValue(routes[0].nodeIds, path.nodePath))
      throw new ApiError('人工主路径与冻结结果不一致', 'INVALID_RESULT', [{ objectId: path.demandId, field: 'nodePath', message: '人工路径必须对应返回的该需求主路由' }]);
  }
}
export function bindPlanningAdjustmentExample(example: PlanningAdjustmentExample, parent: Parent): PlanningAdjustment {
  const context = planningAdjustmentContext(parent);
  const mapped = bindResultDemands({ configuration: { deployment: [], devices: [], frequencies: [],
    routes: example.manualPaths.map((row, index) => ({ id: String(index), demandId: row.demandId, nodeIds: row.nodePath, linkIds: [], backup: false })) } }, context.input, example.input);
  return { ...createPlanningAdjustment(context), manualOverrides: structuredClone(example.manualOverrides),
    manualPaths: mapped.configuration.routes.map(row => ({ demandId: row.demandId, nodePath: row.nodeIds })) };
}
export function planningAdjustmentUnavailable(parent: PlanVersion, mock = true): string | null {
  if (!parent.workflow || !parent.snapshotId || !parent.workflow.configuration) return '此历史方案缺少完整工作流快照，可继续查看与比较';
  if (parent.sourceChanged) return '源数据已变化，请使用来源有效的方案';
  if (mock && (parent.workflow.interferenceOrigin || !adjustablePresetIds.includes(planningResultPresetId(parent.workflow)) ||
    parent.workflow.input.demands.some(row => row.endpointMode === 'device')))
    return '暂无此类方案的预生成调整组合';
  return null;
}
// 这里只合并人工输入和既有配置，用于精确查找预生成组合；不计算路径或业务指标。
export function matchPlanningAdjustment(adjustment: PlanningAdjustment, parent: PlanVersion, presets: PlanningPreset[]): PlanningPreset {
  const issues = validatePlanningAdjustment(adjustment, parent);
  if (issues.length) throw new ApiError('请修正方案调整输入', 'VALIDATION_ERROR', issues);
  const unavailable = planningAdjustmentUnavailable(parent);
  if (unavailable) throw new ApiError(unavailable, parent.sourceChanged ? 'SOURCE_CHANGED' : 'NO_PRESET');
  const context = planningAdjustmentContext(parent);
  const devices = context.configuration.devices.map(row => ({ ...row, ...adjustment.manualOverrides.find(item => item.deviceId === row.deviceId) }));
  const paths = context.configuration.routes.filter(row => !row.backup).map(row => ({ demandId: row.demandId,
    nodePath: adjustment.manualPaths.find(item => item.demandId === row.demandId)?.nodePath ?? row.nodeIds }));
  const sorted = <T>(rows: T[], key: keyof T) => [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
  for (const preset of presets.filter(row => adjustablePresetIds.includes(row.id))) {
    if (!preset.result || !sameValue(inputSignature(normalizeResultInput(context.input, preset.id)), inputSignature(preset.input)) ||
      !sameValue(parent.inputSnapshot, preset.baseline)) continue;
    const target = bindResultDemands(preset.result, context.input, preset.input).configuration;
    if (sameValue(sorted(devices, 'deviceId'), sorted(target.devices, 'deviceId')) &&
      sameValue(sorted(paths, 'demandId'), sorted(target.routes.filter(row => !row.backup).map(row => ({ demandId: row.demandId, nodePath: row.nodeIds })), 'demandId')) &&
      sameValue(context.configuration.deployment, target.deployment) && sameValue(context.configuration.frequencies, target.frequencies)) return preset;
  }
  throw new ApiError('当前调整暂无对应预生成结果；输入已保留', 'NO_PRESET', [
    { objectId: 'ADJUSTMENT', field: 'manualOverrides', message: '可使用服务提供的均衡或节能完整组合；其他功率、高度及路径暂未提供结果' },
  ]);
}
