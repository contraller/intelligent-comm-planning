import { planningPresets } from './planning-presets';
import type { PlanningAdjustmentExample } from '../types/planning-adjustment';

// 只引用已有完整结果作为演示输入，不生成新覆盖或指标。
export const planningAdjustmentExamples: PlanningAdjustmentExample[] = planningPresets
  .filter(preset => ['balanced', 'economical'].includes(preset.id))
  .map(preset => ({ id: preset.id, label: preset.label, source: '独立教学预生成组合 planning-demo-1',
    input: structuredClone(preset.input),
    manualOverrides: preset.result!.configuration.devices.map(row => ({ deviceId: row.deviceId, txPowerDbm: row.txPowerDbm, antennaHeightM: row.antennaHeightM })),
    manualPaths: preset.result!.configuration.routes.filter(row => !row.backup).map(row => ({ demandId: row.demandId, nodePath: [...row.nodeIds] })) }));
