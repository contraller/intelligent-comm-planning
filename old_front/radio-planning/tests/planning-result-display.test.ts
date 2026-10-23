import { describe, expect, it } from 'vitest';
import { planningPresets } from '../src/mocks/planning-presets';
import { planningMetricCards, resolvePlanningResultFocus } from '../src/services/planning-result-display';
import type { PlanningResultDisplayContext, PlanningResultSelection } from '../src/services/planning-result-display';
import type { PlanningCheck } from '../src/types/planning';
import { detailCollection, deviceDetailCells, routeDetailCells, frequencyDetailSummary, unreachableDemandText } from '../src/services/planning-result-details-display';

// 每例克隆既有预设，仅构造测试输入，不修改生产 Mock。
function fixture(presetId = 'balanced'): PlanningResultDisplayContext {
  const preset = structuredClone(planningPresets.find(row => row.id === presetId)!);
  const result = { ...preset.result!, snapshotId: 'snapshot-1', inputSnapshot: preset.baseline, resultDetails: {
    schemaVersion: 1 as const, assetVersion: 'display-fixture', deviceParameters: null, routeQuality: null,
    frequencyAssignments: [{ id: 'FA-A', linkId: 'LINK-A', resourceGroupId: preset.result!.configuration.frequencies[0].id, freqId: null, frequencyKhz: preset.result!.links[0].frequencyKhz, bandwidthKhz: null, reuseGroup: 0 }],
    frequencyConflicts: null, frequencyGap: null, conflictFree: null, unreachableDemandIds: null,
  } };
  return { key: 'job-1', result, configuration: preset.result!.configuration };
}
const focus = (context: PlanningResultDisplayContext, kind: PlanningResultSelection['kind'], id: string) =>
  resolvePlanningResultFocus(context, '路由结果', { kind, id });

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
    expect(planningMetricCards(c.result!.metrics, checks).filter(row => row.id !== 'power').every(row => row.state === 'unknown')).toBe(true);
  });
  it('缺结论、重复结论均保持中性；零值保留，不重新计算功率', () => {
    const metrics = { ...fixture().result!.metrics, connectivityPercent: 0, totalRadiatedPowerW: 0 };
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

describe('冻结结果对象关联', () => {
  it.each([['balanced', 'ROUTE-3'], ['economical', 'ROUTE-2']])('%s 的 %s 显示全部给定路径', (presetId, id) => {
    const c = fixture(presetId), row = c.configuration!.routes.find(row => row.id === id)!;
    expect(focus(c, 'route', id)).toMatchObject({ state: 'ready', stationIds: row.nodeIds, linkIds: row.linkIds, stationId: row.nodeIds[0], linkId: '' });
    expect(row.linkIds.length).toBeGreaterThan(1);
  });
  it('链路使用双端点定位，设备只关联精确设备实例', () => {
    const c = fixture();
    expect(focus(c, 'link', 'LINK-A')).toMatchObject({ stationIds: ['ND-0001', 'ND-0003'], linkIds: ['LINK-A'], stationId: '', linkId: 'LINK-A' });
    expect(focus(c, 'device', 'DV-0001')).toMatchObject({ stationIds: ['ND-0001'], linkIds: ['LINK-A'], stationId: 'ND-0001' });
    expect(focus(c, 'device', 'DV-0002').linkIds).toEqual(['LINK-B']);
    expect(focus(c, 'input-device', 'DV-0001').linkIds).toEqual([]);
  });
  it('部署和地图节点选择只定向当前节点', () => {
    const c = fixture();
    expect(focus(c, 'deployment', 'ND-0001')).toMatchObject({ stationId: 'ND-0001', stationIds: ['ND-0001'], linkIds: [] });
    expect(focus(c, 'station', 'ND-0004')).toMatchObject({ stationId: 'ND-0004', linkIds: [] });
  });
  it('频率只读取明确组与链路 ID，不关联其他同频链路或设备', () => {
    const c = fixture(), row = c.configuration!.frequencies[0]; row.allocatedKhz = [6000, 6000];
    c.result!.links[1].frequencyKhz = 6000;
    const actual = focus(c, 'frequency', row.id);
    expect(actual.linkIds).toEqual(['LINK-A']);
    expect(new Set(actual.stationIds)).toEqual(new Set(['ND-0001', 'ND-0003']));
    expect(actual.message).toContain('明确关联 1 条链路');
    expect(actual.stationId).toBe(''); expect(actual.linkId).toBe('');
  });
  it.each(['absent', 'null', 'empty', 'unbound'])('频率分配 %s 没有明确关系时清空高亮', mode => {
    const c = fixture(), row = c.configuration!.frequencies[0];
    if (mode === 'absent') delete c.result!.resultDetails;
    else if (mode === 'null') c.result!.resultDetails!.frequencyAssignments = null;
    else if (mode === 'empty') c.result!.resultDetails!.frequencyAssignments = [];
    else c.result!.resultDetails!.frequencyAssignments![0].resourceGroupId = null;
    expect(focus(c, 'frequency', row.id)).toMatchObject({ state: 'missing', stationIds: [], linkIds: [], stationId: '', linkId: '', message: '未提供明确分配关系' });
  });
  it('分配行可无组归属；重复分配、链路或频点不一致均拒绝整体联动', () => {
    const c = fixture(); c.result!.resultDetails!.frequencyAssignments![0].resourceGroupId = null;
    expect(focus(c, 'assignment', 'FA-A').linkIds).toEqual(['LINK-A']);
    c.result!.resultDetails!.frequencyAssignments!.push({ ...c.result!.resultDetails!.frequencyAssignments![0], id: 'FA-B' });
    expect(focus(c, 'assignment', 'FA-A').state).toBe('invalid');
    c.result!.resultDetails!.frequencyAssignments!.pop(); c.result!.links[0].frequencyKhz = 7000;
    expect(focus(c, 'assignment', 'FA-A')).toMatchObject({ state: 'invalid', linkIds: [], stationIds: [] });
  });
  it.each(['missing-link', 'wrong-order', 'duplicate-link', 'missing-device', 'wrong-host'])('不完整路由 %s 不串入其他对象', issue => {
    const c = fixture(), route = c.configuration!.routes.find(row => row.id === 'ROUTE-3')!;
    if (issue === 'missing-link') route.linkIds[0] = 'elsewhere';
    if (issue === 'wrong-order') route.nodeIds.reverse();
    if (issue === 'duplicate-link') route.linkIds[1] = route.linkIds[0];
    if (issue === 'missing-device') c.result!.inputSnapshot.devices = [];
    if (issue === 'wrong-host') c.result!.inputSnapshot.devices[0].stationId = 'other';
    // 错误设备须属于所选路径，避免测试无关设备。
    if (issue === 'wrong-host') c.result!.inputSnapshot.devices.find(row => row.id === 'DV-0002')!.stationId = 'other';
    expect(focus(c, 'route', route.id)).toMatchObject({ state: 'invalid', stationIds: [], linkIds: [] });
  });
  it('缺设备归属、频率匹配关联异常和未知对象不保留旧高亮', () => {
    const c = fixture(); c.configuration!.devices[0].stationId = 'other';
    for (const selection of [{ kind: 'device', id: 'DV-0001' }, { kind: 'frequency', id: 'hf-full' }, { kind: 'link', id: 'missing' }] as PlanningResultSelection[]) {
      expect(focus(c, selection.kind, selection.id)).toMatchObject({ state: 'invalid', stationIds: [], linkIds: [] });
    }
  });
  it('各页签默认范围只来自所提供的结果，旧快照不补配置', () => {
    const c = fixture();
    const defaults = (tab: string) => resolvePlanningResultFocus(c, tab, null);
    expect(defaults('路由结果').linkIds).toEqual(['LINK-A', 'LINK-B', 'LINK-C']);
    expect(defaults('通信资源').linkIds).toEqual([]);
    c.configuration!.deployment = c.configuration!.deployment.slice(0, 1);
    expect(defaults('中继部署').stationIds).toEqual([c.configuration!.deployment[0].stationId]);
    expect(defaults('参数配置').stationIds).toHaveLength(3);
    for (const tab of ['覆盖结果', '优化建议', '任务快照']) expect(defaults(tab)).toMatchObject({ stationIds: [], linkIds: [] });
    c.configuration = undefined;
    expect(defaults('中继部署').stationIds).toEqual([]);
    expect(focus(c, 'route', 'ROUTE-1').state).toBe('invalid');
    expect(focus(c, 'link', 'LINK-A').state).toBe('ready');
    expect(focus(c, 'station', 'ND-0001').state).toBe('ready');
  });
  it('所有展示操作不修改冻结结果', () => {
    const c = fixture(), before = JSON.stringify(c);
    for (const row of c.configuration!.routes) focus(c, 'route', row.id);
    for (const row of c.configuration!.devices) focus(c, 'device', row.deviceId);
    focus(c, 'frequency', 'hf-full'); planningMetricCards(c.result!.metrics);
    expect(JSON.stringify(c)).toBe(before);
  });
});

describe('补充明细的缺值与显式结论展示', () => {
  it('保留 0、false、空集合与未提供的区别，不修改服务结果', () => {
    const details = fixture().result!.resultDetails!;
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
