import { describe, expect, it } from 'vitest';
import { planningPresets } from '../src/mocks/planning-presets';
import { planningMetricCards } from '../src/services/planning-result-display';
import type { PlanningCheck, PlanningResult } from '../src/types/planning';
import { detailCollection, deviceDetailCells, routeDetailCells, frequencyDetailSummary, unreachableDemandText, resolveFrequencyFocus } from '../src/services/planning-result-details-display';
import type { FrequencyDisplayContext } from '../src/services/planning-result-details-display';

// 每例克隆既有预设，仅构造测试输入，不修改生产 Mock。
// 显式采用现役频率契约，明细可缺省且保留数组与空值的原类型。
function fixture(): FrequencyDisplayContext & { metrics: PlanningResult['metrics'] } {
  const preset = structuredClone(planningPresets.find(row => row.id === 'balanced')!);
  return { nodes: preset.baseline.stations, devices: preset.baseline.devices,
    links: preset.result!.links, configuration: preset.result!.configuration, metrics: preset.result!.metrics, resultDetails: {
      schemaVersion: 1 as const, assetVersion: 'display-fixture', deviceParameters: null, routeQuality: null,
      frequencyAssignments: [{ id: 'FA-A', linkId: 'LINK-A', resourceGroupId: preset.result!.configuration.frequencies[0].id, freqId: null, frequencyKhz: preset.result!.links[0].frequencyKhz, bandwidthKhz: null, reuseGroup: 0 }],
      frequencyConflicts: null, frequencyGap: null, conflictFree: null, unreachableDemandIds: null,
    } };
}

describe('规划三项目标展示', () => {
  it.each(['balanced', 'economical', 'constrained'])('%s 指标与显式结论直接读取', id => {
    const preset = planningPresets.find(row => row.id === id)!.result!;
    const cards = planningMetricCards(preset.metrics, preset.checks);
    expect(cards.map(row => row.value)).toEqual([preset.metrics.connectivityPercent, preset.metrics.totalRadiatedPowerW, preset.metrics.survivabilityPercent]);
    expect(cards.map(row => row.unit)).toEqual(['%', 'W', '%']);
    expect(cards[0].state).toBe('passed');
    expect(cards[1]).toMatchObject({ state: 'objective', status: '最小化目标' });
    expect(cards[2].state).toBe(id === 'constrained' ? 'failed' : 'passed');
  });
  it.each([null, undefined, 'true', 1, {}])('无有效校验 %s 时不从数值推断', passed => {
    const c = fixture(), checks = [{ id: 'connectivity', passed }, { id: 'survivability', passed }] as PlanningCheck[];
    expect(planningMetricCards(c.metrics, checks).filter(row => row.id !== 'power').every(row => row.state === 'unknown')).toBe(true);
  });
  it('缺结论、重复结论均保持中性；零值保留，不重新计算功率', () => {
    const metrics = { ...fixture().metrics, connectivityPercent: 0, totalRadiatedPowerW: 0 };
    const check: PlanningCheck = { id: 'connectivity', label: '', detail: '', passed: true };
    expect(planningMetricCards(metrics)[0].status).toBe('未提供校验结论');
    expect(planningMetricCards(metrics, [check, check])[0].state).toBe('unknown');
    expect(planningMetricCards(metrics, [check])[0]).toMatchObject({ value: 0, state: 'passed' });
    expect(planningMetricCards(metrics)[1].value).toBe(0);
    expect(planningMetricCards(undefined).every(row => row.value === null)).toBe(true);
    expect(planningMetricCards({ ...metrics, survivabilityPercent: NaN })[2].value).toBeNull();
  });
  it('HTTP 可空指标保留缺值与有效零值，不改变显式结论或功率目标', () => {
    // 只读可空输入无需补值或断言成 Mock 结果类型。
    const metrics = Object.freeze({ connectivityPercent: null, totalRadiatedPowerW: 0, survivabilityPercent: 0 });
    const checks: readonly PlanningCheck[] = Object.freeze([
      { id: 'connectivity', label: '连通率', passed: true, detail: '服务返回达标' },
      { id: 'survivability', label: '抗毁性', passed: false, detail: '服务返回未达标' },
    ]);
    expect(planningMetricCards(metrics, checks)).toMatchObject([
      { value: null, state: 'passed', status: '达标', note: '服务返回达标' },
      { value: 0, unit: 'W', state: 'objective', status: '最小化目标' },
      { value: 0, unit: '%', state: 'failed', status: '未达标', note: '服务返回未达标' },
    ]);
    expect(planningMetricCards({ connectivityPercent: null, totalRadiatedPowerW: null, survivabilityPercent: null }))
      .toMatchObject([{ value: null, state: 'unknown' }, { value: null, state: 'objective' }, { value: null, state: 'unknown' }]);
    expect(planningMetricCards(metrics, [...checks, { ...checks[1], passed: true }])[2])
      .toMatchObject({ value: 0, state: 'unknown', status: '未提供校验结论' });
    expect(metrics).toEqual({ connectivityPercent: null, totalRadiatedPowerW: 0, survivabilityPercent: 0 });
  });
});

describe('冻结频率结果关联', () => {
  // 直接验证当前页面使用的频率解析，不再经过旧对象定位入口。
  it('频率只读取明确组与链路 ID，不关联其他同频链路或设备', () => {
    const c = fixture(), row = c.configuration!.frequencies[0]; row.allocatedKhz = [6000, 6000];
    c.links[1].frequencyKhz = 6000;
    const actual = resolveFrequencyFocus(c, { kind: 'frequency', id: row.id });
    expect(actual.linkIds).toEqual(['LINK-A']);
    expect(new Set(actual.stationIds)).toEqual(new Set(['ND-0001', 'ND-0003']));
    expect(actual.message).toContain('明确关联 1 条链路');
    expect(actual.stationId).toBe(''); expect(actual.linkId).toBe('');
  });
  it.each(['absent', 'null', 'empty', 'unbound'])('频率分配 %s 没有明确关系时清空高亮', mode => {
    const c = fixture(), row = c.configuration!.frequencies[0];
    if (mode === 'absent') delete c.resultDetails;
    else if (mode === 'null') c.resultDetails!.frequencyAssignments = null;
    else if (mode === 'empty') c.resultDetails!.frequencyAssignments = [];
    else c.resultDetails!.frequencyAssignments![0].resourceGroupId = null;
    expect(resolveFrequencyFocus(c, { kind: 'frequency', id: row.id })).toMatchObject({ state: 'missing', stationIds: [], linkIds: [], stationId: '', linkId: '', message: '未提供明确分配关系' });
  });
  it('分配行可无组归属；重复分配、链路或频点不一致均拒绝整体联动', () => {
    const c = fixture(); c.resultDetails!.frequencyAssignments![0].resourceGroupId = null;
    expect(resolveFrequencyFocus(c, { kind: 'assignment', id: 'FA-A' }).linkIds).toEqual(['LINK-A']);
    c.resultDetails!.frequencyAssignments!.push({ ...c.resultDetails!.frequencyAssignments![0], id: 'FA-B' });
    expect(resolveFrequencyFocus(c, { kind: 'assignment', id: 'FA-A' }).state).toBe('invalid');
    c.resultDetails!.frequencyAssignments!.pop(); c.links[0].frequencyKhz = 7000;
    expect(resolveFrequencyFocus(c, { kind: 'assignment', id: 'FA-A' })).toMatchObject({ state: 'invalid', linkIds: [], stationIds: [] });
  });
  it('频率关联拒绝错误设备归属，不保留旧高亮', () => {
    const c = fixture(); c.configuration!.devices[0].stationId = 'other';
    expect(resolveFrequencyFocus(c, { kind: 'frequency', id: 'hf-full' })).toMatchObject({ state: 'invalid', stationIds: [], linkIds: [] });
  });
  it('频率关联与指标展示不修改输入', () => {
    const c = fixture(), before = JSON.stringify(c);
    resolveFrequencyFocus(c, { kind: 'frequency', id: 'hf-full' });
    resolveFrequencyFocus(c, { kind: 'assignment', id: 'FA-A' });
    planningMetricCards(c.metrics);
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe('补充明细的缺值与显式结论展示', () => {
  it('保留 0、false、空集合与未提供的区别，不修改服务结果', () => {
    const details = fixture().resultDetails!;
    details.deviceParameters = [{ deviceId: 'D', tiltDeg: 0, tiltEffective: false }];
    details.routeQuality = [{ routeId: 'R', demandId: 'D1', hopCount: 0, totalDistanceM: 0, totalDelayMs: 0, bottleneckMarginDb: -3, reliability: 0, isFeasible: false, bottleneckLinkId: null }];
    details.frequencyGap = { requiredChannels: 353, availableChannels: 48, shortage: 0 }; details.conflictFree = true; details.unreachableDemandIds = [];
    const before = JSON.stringify(details);
    expect(deviceDetailCells(details, 'D')).toEqual({ tiltDeg: 0, tiltEffective: '未参与' });
    expect(deviceDetailCells(undefined, 'D')).toEqual({ tiltDeg: '未提供', tiltEffective: '未提供' });
    expect(routeDetailCells(details, 'R')).toMatchObject({ reliability: '0%', isFeasible: '不可行', totalDistanceM: 0, bottleneckMarginDb: -3, bottleneckLinkId: '未提供' });
    expect(frequencyDetailSummary(details)).toContain('所需信道：353 · 可用信道：48 · 缺口：0 · 服务结论：明确无冲突');
    expect(detailCollection(null)).toBe('未提供'); expect(detailCollection([])).toBe('没有记录');
    expect(unreachableDemandText(details)).toBe('未列出不可达需求'); expect(unreachableDemandText(undefined)).toBe('未提供');
    expect(JSON.stringify(details)).toBe(before);
  });
});
