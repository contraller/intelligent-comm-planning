import resources from './resources.json';
import { DEMO_BBOX } from '../config/demo';
import type { ResourcesData } from '../types/domain';
import type { PlanningInput, PlanningPreset, PlanningResult } from '../types/planning';

// 独立教学预设，所有结果数值均为常量；资源附件仅用作身份与输入基线。
const source = resources as ResourcesData;
const stationIds = ['ND-0001', 'ND-0003', 'ND-0004'];
const deviceIds = ['DV-0001', 'DV-0002', 'DV-0027', 'DV-0028', 'DV-0037', 'DV-0038'];
const baseline = {
  stations: source.stations.filter((row) => stationIds.includes(row.id)),
  devices: source.devices.filter((row) => deviceIds.includes(row.id)),
};
const input: PlanningInput = {
  name: '三站协同保障演示',
  description: '独立预生成场景；正常告警对象允许参与，不使用故障或离线设备。',
  bbox: [...DEMO_BBOX],
  stationIds,
  presetId: 'balanced',
  frequencyId: 'hf-full',
  constraints: { connectivityPercent: 100, maxRelayHops: 2, survivabilityPercent: 90 },
  demands: [
    {
      id: 'DEMAND-01',
      sourceId: 'ND-0001',
      targetId: 'ND-0003',
      service: '话音',
      priority: 'P1',
      mandatory: true,
      dataVolumeMb: null,
      requiredRateKbps: 2.4,
      maxDelayMs: 100,
      minReliability: 0.95,
    },
    {
      id: 'DEMAND-02',
      sourceId: 'ND-0001',
      targetId: 'ND-0004',
      service: '数据',
      priority: 'P2',
      mandatory: true,
      dataVolumeMb: 1,
      requiredRateKbps: 4.8,
      maxDelayMs: 100,
      minReliability: 0.95,
    },
  ],
};
const balanced: Omit<PlanningResult, 'snapshotId' | 'inputSnapshot'> = {
  links: [
    {
      id: 'LINK-A',
      a: 'ND-0001',
      b: 'ND-0003',
      deviceA: 'DV-0001',
      deviceB: 'DV-0027',
      state: 'EXCELLENT',
      deviceClass: 'HF',
      frequencyKhz: 6000,
      backup: false,
    },
    {
      id: 'LINK-B',
      a: 'ND-0001',
      b: 'ND-0004',
      deviceA: 'DV-0002',
      deviceB: 'DV-0037',
      state: 'GOOD',
      deviceClass: 'HF',
      frequencyKhz: 8000,
      backup: false,
    },
    {
      id: 'LINK-C',
      a: 'ND-0003',
      b: 'ND-0004',
      deviceA: 'DV-0028',
      deviceB: 'DV-0038',
      state: 'GOOD',
      deviceClass: 'HF',
      frequencyKhz: 10000,
      backup: true,
    },
  ],
  regions: [
    {
      id: 'COVERAGE-3',
      kind: 'coverage',
      label: '三站预设覆盖区',
      rings: [
        [
          [114.08, 37.51],
          [114.12, 37.57],
          [114.27, 37.44],
          [114.4, 37.27],
          [114.32, 37.17],
          [114.2, 37.28],
          [114.08, 37.51],
        ],
        [
          [114.21, 37.36],
          [114.23, 37.36],
          [114.23, 37.38],
          [114.21, 37.38],
          [114.21, 37.36],
        ],
      ],
    },
    {
      id: 'BLIND-3',
      kind: 'blind',
      label: '地形盲区',
      rings: [
        [
          [114.21, 37.36],
          [114.23, 37.36],
          [114.23, 37.38],
          [114.21, 37.38],
          [114.21, 37.36],
        ],
      ],
    },
    {
      id: 'UNKNOWN-3',
      kind: 'uncalculated',
      label: '未计算',
      rings: [
        [
          [114.42, 37.42],
          [114.5, 37.4],
          [114.52, 37.49],
          [114.42, 37.42],
        ],
      ],
    },
  ],
  metrics: {
    connectivityPercent: 100,
    survivabilityPercent: 96,
    totalRadiatedPowerW: 190,
    coveragePercent: 94,
    delayMs: 32,
  },
  deploymentCost: 12,
  costUnit: '演示成本点',
  checks: [
    {
      id: 'connectivity',
      label: '必要通联连通率 100%',
      passed: true,
      detail: '预设两条必要需求均满足',
    },
    { id: 'survivability', label: '抗毁性 ≥ 90%', passed: true, detail: '预设结论 96%' },
    { id: 'relay', label: '中继跳数 ≤ 2', passed: true, detail: '预设主备路由符合约束' },
    {
      id: 'frequency',
      label: '频率资源完整',
      passed: true,
      detail: '6000 / 8000 / 10000 kHz 已分配',
    },
  ],
  configuration: {
    deployment: [
      { stationId: 'ND-0001', deviceIds: ['DV-0001', 'DV-0002'], role: '源站' },
      { stationId: 'ND-0003', deviceIds: ['DV-0027', 'DV-0028'], role: '目标 / 备份中继' },
      { stationId: 'ND-0004', deviceIds: ['DV-0037', 'DV-0038'], role: '目标 / 备份中继' },
    ],
    devices: [
      {
        deviceId: 'DV-0001',
        stationId: 'ND-0001',
        frequencyKhz: 6000,
        txPowerDbm: 45,
        antennaHeightM: 16.6,
      },
      {
        deviceId: 'DV-0002',
        stationId: 'ND-0001',
        frequencyKhz: 8000,
        txPowerDbm: 45,
        antennaHeightM: 16.7,
      },
      {
        deviceId: 'DV-0027',
        stationId: 'ND-0003',
        frequencyKhz: 6000,
        txPowerDbm: 45,
        antennaHeightM: 16.7,
      },
      {
        deviceId: 'DV-0028',
        stationId: 'ND-0003',
        frequencyKhz: 10000,
        txPowerDbm: 45,
        antennaHeightM: 10.5,
      },
      {
        deviceId: 'DV-0037',
        stationId: 'ND-0004',
        frequencyKhz: 8000,
        txPowerDbm: 45,
        antennaHeightM: 16.2,
      },
      {
        deviceId: 'DV-0038',
        stationId: 'ND-0004',
        frequencyKhz: 10000,
        txPowerDbm: 45,
        antennaHeightM: 15.8,
      },
    ],
    routes: [
      {
        id: 'ROUTE-1',
        demandId: 'DEMAND-01',
        nodeIds: ['ND-0001', 'ND-0003'],
        linkIds: ['LINK-A'],
        backup: false,
      },
      {
        id: 'ROUTE-2',
        demandId: 'DEMAND-02',
        nodeIds: ['ND-0001', 'ND-0004'],
        linkIds: ['LINK-B'],
        backup: false,
      },
      {
        id: 'ROUTE-3',
        demandId: 'DEMAND-01',
        nodeIds: ['ND-0001', 'ND-0004', 'ND-0003'],
        linkIds: ['LINK-B', 'LINK-C'],
        backup: true,
      },
      {
        id: 'ROUTE-4',
        demandId: 'DEMAND-02',
        nodeIds: ['ND-0001', 'ND-0003', 'ND-0004'],
        linkIds: ['LINK-A', 'LINK-C'],
        backup: true,
      },
    ],
    frequencies: [
      { id: 'hf-full', minKhz: 6000, maxKhz: 10000, allocatedKhz: [6000, 8000, 10000] },
    ],
  },
  notes: [
    '来源：独立教学预设 planning-demo-1，指标和轮廓不是计算结果。',
    'ND-0004 / DV-0037 为正常加告警，预设允许参与；保留告警标记。',
    '总功率仅为最小化目标，未声称全局最优。',
  ],
};
const economical = structuredClone(balanced);
economical.metrics = {
  connectivityPercent: 100,
  survivabilityPercent: 91,
  totalRadiatedPowerW: 60,
  coveragePercent: 90,
  delayMs: 45,
};
economical.deploymentCost = 10;
economical.configuration.devices.forEach((row) => {
  row.txPowerDbm = 40;
});
// 第二档使用经 ND-0003 的主路由；原直达路径保留为备份。
economical.configuration.routes[1] = {
  id: 'ROUTE-2',
  demandId: 'DEMAND-02',
  nodeIds: ['ND-0001', 'ND-0003', 'ND-0004'],
  linkIds: ['LINK-A', 'LINK-C'],
  backup: false,
};
economical.configuration.routes[3] = {
  id: 'ROUTE-4',
  demandId: 'DEMAND-02',
  nodeIds: ['ND-0001', 'ND-0004'],
  linkIds: ['LINK-B'],
  backup: true,
};
economical.links[1].backup = true;
economical.links[2].backup = false;
economical.checks[1].detail = '预设结论 91%';
economical.regions[0].label = '节能档预设覆盖区';
economical.regions[0].rings[0] = [
  [114.1, 37.5],
  [114.14, 37.54],
  [114.25, 37.42],
  [114.36, 37.26],
  [114.31, 37.2],
  [114.21, 37.3],
  [114.1, 37.5],
];
const constrained = structuredClone(economical);
constrained.metrics = {
  connectivityPercent: 100,
  survivabilityPercent: 82,
  totalRadiatedPowerW: 60,
  coveragePercent: 86,
  delayMs: 53,
};
constrained.checks[1] = {
  id: 'survivability',
  label: '抗毁性 ≥ 90%',
  passed: false,
  detail: '该档预设抗毁性 82%，未达约束',
};
constrained.regions[0].label = '约束不足档预设覆盖区';
constrained.regions[0].rings[0] = [
  [114.12, 37.49],
  [114.15, 37.52],
  [114.25, 37.4],
  [114.34, 37.25],
  [114.31, 37.22],
  [114.22, 37.31],
  [114.12, 37.49],
];

function preset(
  id: string,
  label: string,
  result: PlanningPreset['result'],
  options: Partial<PlanningPreset> = {},
): PlanningPreset {
  return {
    id,
    label,
    scene: '三站协同保障',
    summary: label,
    source: '独立教学预设 planning-demo-1；仅复用附件对象身份',
    input: { ...structuredClone(input), presetId: id },
    baseline: structuredClone(baseline),
    result,
    frequency: { id: 'hf-full', label: 'HF 完整频率资源', minKhz: 6000, maxKhz: 10000 },
    outcome: {
      code: 0,
      message: '已完成，预设约束通过',
      suggestions: ['可保存版本后确认配置'],
      gap: [],
    },
    executionError: null,
    ...options,
  };
}
export const planningPresets: PlanningPreset[] = [
  preset('balanced', '均衡档 · 45 dBm / 直达主路由', balanced),
  preset('economical', '节能档 · 40 dBm / 经 ND-0003', economical),
  preset('constrained', '约束不足 · 40 dBm / 抗毁性 82%', constrained, {
    outcome: {
      code: 3001,
      message: '已完成，约束未满足',
      suggestions: ['切换均衡档或节能档重新提交；当前可保存为参考'],
      gap: [
        { objectId: 'NETWORK', field: 'survivability', message: '预设抗毁性 82%，目标至少 90%' },
      ],
    },
  }),
  preset('shortage', '频率不足 · 仅 6000 kHz', null, {
    input: { ...structuredClone(input), presetId: 'shortage', frequencyId: 'hf-limited' },
    frequency: { id: 'hf-limited', label: 'HF 受限频率资源', minKhz: 6000, maxKhz: 6000 },
    outcome: {
      code: 3002,
      message: '已完成，频率资源不足',
      suggestions: ['补充 8000、10000 kHz 资源后选择完整预设'],
      gap: [
        {
          objectId: 'hf-limited',
          field: 'frequencyKhz',
          message: '缺少 8000、10000 kHz；没有完整结果可保存',
        },
      ],
    },
  }),
  preset('execution-failed', '执行失败演示 · 预设服务异常', null, {
    executionError: 'Mock 规划服务异常，未生成结果；输入快照已保留，可重新提交。',
  }),
];
// 指定设备的独立教学档：身份和结果均来自显式常量，不推算新指标。
const devicePreset=preset('device-balanced','指定设备档 · HF 直达主路由',structuredClone(balanced));
devicePreset.input.demands[0]={...devicePreset.input.demands[0],endpointMode:'device',sourceDeviceId:'DV-0001',targetDeviceId:'DV-0027',preferredClass:'HF'};
devicePreset.input.demands[1]={...devicePreset.input.demands[1],endpointMode:'device',sourceDeviceId:'DV-0002',targetDeviceId:'DV-0037',preferredClass:'HF'};
// 设备档仅提供满足所选设备端点的直达路由，不借其他电台充当备份端点。
devicePreset.result!.configuration.routes=structuredClone(balanced.configuration.routes.slice(0,2));
devicePreset.result!.notes.push('指定设备教学档仅提供直达主路由，未提供设备级备份路由；指标仍为该教学档固定展示值。');
planningPresets.push(devicePreset);
export const planningPhases = [
  '中继部署',
  '参数优化',
  '覆盖分析',
  '路由规划',
  '通信资源',
  '多目标优化',
];
