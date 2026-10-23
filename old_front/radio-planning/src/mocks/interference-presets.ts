import { initialResources } from './resource-presets';
import { planningPresets } from './planning-presets';
import type { InterferenceImpact, InterferenceResult, InterferenceScenario, InterferenceVariant, CountermeasureType } from '../types/interference';

export const interferencePhases = ['输入快照校验', '影响结果读取', '措施预评估读取', '分析完成'];
const resources = initialResources();
const source = (id: string) => structuredClone(resources.interferences!.find(row => row.id === id)!);
const enhanced = { ...source('IF-0008'), txPowerDbm: 47.9 };
export const interferenceScenarios: InterferenceScenario[] = [
  { id: 'single', label: '单源干扰', sources: [source('IF-0008')], instruction: 'IF-0008 保持原始参数。' },
  { id: 'multiple', label: '双源干扰', sources: [source('IF-0008'), source('IF-0010')], instruction: 'IF-0008、IF-0010 保持原始参数，读取联合预生成结果。' },
  { id: 'enhanced', label: '干扰功率增强', sources: [enhanced], instruction: '先在资源编辑中将 IF-0008 功率保存为 47.9 dBm，其他参数保持原始值。' },
  { id: 'unaffected', label: '无影响教学分支', sources: [source('IF-0008')], instruction: '参数保持原始值；这是显式选择的无影响教学场景。' },
  { id: 'unavailable', label: '无可行措施教学分支', sources: [source('IF-0008')], instruction: '参数保持原始值；展示各类措施不可采纳的原因。' },
  { id: 'failed', label: '分析失败教学分支', sources: [source('IF-0008')], instruction: '参数保持原始值；演示执行失败与历史保留。' },
];
const labels: Record<CountermeasureType, string> = {
  FREQ_ADJUST: '频率调整', CHANNEL_SWITCH: '信道切换', POWER_OPT: '功率优化',
  ROUTE_REBUILD: '路由重构', NODE_REDEPLOY: '节点重部署',
};
const details: Record<CountermeasureType, string> = {
  FREQ_ADJUST: '链路 B 及两端设备改用 9000 kHz，保持任务需求。',
  CHANNEL_SWITCH: '链路 B 及两端设备切换至 8300 kHz 预设信道。',
  POWER_OPT: '链路 B 两端设备采用 49 dBm 预设功率档。',
  ROUTE_REBUILD: '需求 2 主路径采用节点 1 → 节点 3 → 节点 4，原直达路径作为备份。',
  NODE_REDEPLOY: '节点 4 的方案部署位置设为 [114.31, 37.26]，保留原资源坐标。',
};
const types = Object.keys(labels) as CountermeasureType[];

// 下列参数、路由、指标均是独立教学常量；组合对象不执行规划或效果推算。
export const interferenceVariants: InterferenceVariant[] = planningPresets
  .filter(preset => ['balanced', 'economical'].includes(preset.id))
  .flatMap(preset => types.filter(type => !(preset.id === 'economical' && type === 'ROUTE_REBUILD')).map(type => {
    const result = structuredClone(preset.result!);
    const configuration = result.configuration;
    const link = result.links.find(row => row.id === 'LINK-B')!;
    if (type === 'FREQ_ADJUST' || type === 'CHANNEL_SWITCH') {
      const frequency = type === 'FREQ_ADJUST' ? 9000 : 8300;
      link.frequencyKhz = frequency;
      for (const device of configuration.devices)
        if (['DV-0002', 'DV-0037'].includes(device.deviceId)) device.frequencyKhz = frequency;
      configuration.frequencies[0].allocatedKhz = [6000, frequency, 10000];
    }
    if (type === 'POWER_OPT') {
      for (const device of configuration.devices)
        if (['DV-0002', 'DV-0037'].includes(device.deviceId)) device.txPowerDbm = 49;
    }
    if (type === 'ROUTE_REBUILD') {
      configuration.routes = configuration.routes.filter(route => route.demandId !== 'DEMAND-02');
      configuration.routes.push(
        { id: 'IF-ROUTE-B', demandId: 'DEMAND-02', nodeIds: ['ND-0001', 'ND-0003', 'ND-0004'], linkIds: ['LINK-A', 'LINK-C'], backup: false },
        { id: 'IF-ROUTE-B-BACKUP', demandId: 'DEMAND-02', nodeIds: ['ND-0001', 'ND-0004'], linkIds: ['LINK-B'], backup: true },
      );
      link.backup = true;
      result.links.find(row => row.id === 'LINK-C')!.backup = false;
    }
    if (type === 'NODE_REDEPLOY') {
      configuration.deployment.find(row => row.stationId === 'ND-0004')!.plannedCoordinate = [114.31, 37.26];
      result.regions = [
        { id: 'IF-COVERAGE-REDEPLOY', kind: 'coverage', label: '重部署方案预设覆盖',
          rings: [[[114.08,37.51],[114.14,37.56],[114.34,37.4],[114.39,37.23],[114.25,37.18],[114.08,37.51]]] },
      ];
    }
    link.state = 'GOOD';
    const power = type === 'POWER_OPT' ? (preset.id === 'balanced' ? 240 : 210) : (preset.id === 'balanced' ? 190 : 110);
    result.metrics = { coveragePercent: type === 'NODE_REDEPLOY' ? 96 : 94, connectivityPercent: 100,
      survivabilityPercent: 96, totalRadiatedPowerW: power, delayMs: type === 'ROUTE_REBUILD' ? 44 : 32 };
    result.deploymentCost = type === 'NODE_REDEPLOY' ? 18 : 12;
    result.checks = [
      { id: 'connectivity', label: '必要通联连通率 100%', passed: true, detail: '抗干扰教学预设：全部必要需求满足' },
      { id: 'survivability', label: '抗毁性 ≥90%', passed: true, detail: '预生成结论 96%' },
      { id: 'relay', label: '中继 ≤2 跳', passed: true, detail: '预设路由已核对' },
      { id: 'frequency', label: '频率完整', passed: true, detail: '本教学变体的设备/链路频率匹配' },
    ];
    result.notes = ['抗干扰独立教学方案，不代表真实计算或设备下发', details[type], '指标与覆盖读取该变体的预生成常量'];
    return { id: preset.id + ':' + type, networkPresetId: preset.id, type, label: labels[type], result };
  }));

const emptyImpact = (): InterferenceImpact => ({
  nodes: [], links: [], regions: [], summary: { affectedNodeCount: 0, affectedLinkCount: 0, severeLinkCount: 0 },
});
export function interferenceDemoResult(scenario: InterferenceScenario, networkPresetId: string): InterferenceResult {
  const sourceIds = scenario.sources.map(row => row.id);
  const multiple = scenario.id === 'multiple';
  const enhanced = scenario.id === 'enhanced';
  const impact: InterferenceImpact = scenario.id === 'unaffected' ? emptyImpact() : {
    nodes: [
      { nodeId: 'ND-0004', level: 'SEVERE', snrBeforeDb: 18.2, snrAfterDb: enhanced ? 0.8 : 3.1, deltaDb: enhanced ? -17.4 : -15.1 },
      { nodeId: 'ND-0001', level: enhanced ? 'SEVERE' : 'MODERATE', snrBeforeDb: 15, snrAfterDb: enhanced ? 4.2 : 8.4, deltaDb: enhanced ? -10.8 : -6.6 },
      ...(multiple ? [{ nodeId: 'ND-0003', level: 'MODERATE' as const, snrBeforeDb: 16, snrAfterDb: 9, deltaDb: -7 }] : []),
    ],
    links: [
      { linkId: 'LINK-B', level: 'SEVERE', snrBeforeDb: 18.2, snrAfterDb: enhanced ? 0.8 : 3.1, stateBefore: 'GOOD', stateAfter: 'FAULT', interferenceIds: sourceIds },
      ...(multiple ? [{ linkId: 'LINK-A', level: 'MODERATE' as const, snrBeforeDb: 16, snrAfterDb: 9, stateBefore: 'EXCELLENT' as const, stateAfter: 'WARNING' as const, interferenceIds: sourceIds }] : []),
    ],
    regions: [{
      id: 'IF-IMPACT-B', label: '节点 4 严重受扰预设区域', level: 'SEVERE', interferenceIds: sourceIds,
      polygons: [
        [[[114.2,37.36],[114.28,37.39],[114.37,37.28],[114.35,37.2],[114.27,37.2],[114.2,37.36]],
         [[114.28,37.27],[114.29,37.27],[114.29,37.28],[114.28,37.28],[114.28,37.27]]],
        [[[114.3,37.4],[114.32,37.4],[114.32,37.42],[114.3,37.4]]],
      ],
    }, {
      id: 'IF-IMPACT-MODERATE', label: '预设中等影响区', level: 'MODERATE', interferenceIds: sourceIds,
      polygons: [[[[114.14,37.41],[114.2,37.41],[114.2,37.46],[114.14,37.41]]]],
    }, {
      id: 'IF-IMPACT-MINOR', label: '预设轻微影响区', level: 'MINOR', interferenceIds: sourceIds,
      polygons: [[[[114.1,37.48],[114.14,37.48],[114.14,37.5],[114.1,37.48]]]],
    }],
    summary: { affectedNodeCount: multiple ? 3 : 2, affectedLinkCount: multiple ? 2 : 1, severeLinkCount: 1 },
  };
  const unavailable = scenario.id === 'unavailable' || scenario.id === 'unaffected';
  const reasons: Record<CountermeasureType, string> = {
    FREQ_ADJUST: '教学分支：无可用且无冲突的新频率', CHANNEL_SWITCH: '教学分支：相邻信道无改善',
    POWER_OPT: '教学分支：允许功率档不足以恢复质量', ROUTE_REBUILD: '教学分支：不存在满足需求的绕行路径',
    NODE_REDEPLOY: '教学分支：没有满足部署约束的候选位置',
  };
  return {
    impact,
    measures: types.map((type, index) => {
      // 节能档本就经节点 3 绕行；不能只换路由 ID 冒充产生了新的措施。
      const blockedReason = unavailable ? (scenario.id === 'unaffected' ? '当前预设没有受扰对象，无需采纳' : reasons[type])
        : networkPresetId === 'economical' && type === 'ROUTE_REBUILD' ? '节能档当前已采用该绕行主路由，暂无其他可行路由预设' : null;
      return {
      id: type, type, targetNodeId: type === 'NODE_REDEPLOY' ? 'ND-0004' : null,
      targetLinkId: type === 'NODE_REDEPLOY' ? null : 'LINK-B', priority: index + 1,
      title: labels[type], detail: details[type],
      risk: type === 'POWER_OPT' ? '提高功率可能增加邻网互扰；当前效果仅为教学预评估' :
        type === 'CHANNEL_SWITCH' ? '实际信道冲突风险需由后端评估' : '效果来自预生成结果，采纳后仍需确认方案',
      unavailableReason: blockedReason,
      variantId: blockedReason ? null : networkPresetId + ':' + type,
      snrAfterDb: blockedReason ? null : 14.6,
      after: blockedReason ? null : emptyImpact(),
      };
    }),
    notes: ['Mock / 独立教学预生成结果；不由前端计算干扰功率或范围',
      multiple ? '双源影响使用同一份联合结果，不把单源统计相加' : '仅分析显式选择的已保存干扰源',
      '分析结果不修改设备运行状态或资源台账'],
  };
}
