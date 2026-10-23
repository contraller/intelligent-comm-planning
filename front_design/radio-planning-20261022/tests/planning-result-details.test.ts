import { describe, expect, it } from 'vitest';
import { planningPresets } from '../src/mocks/planning-presets';
import { interferenceVariants } from '../src/mocks/interference-presets';
import { planningResultDetailsCatalog, PLANNING_RESULT_DETAILS_ASSET_VERSION } from '../src/mocks/planning-result-details';
import { assertMockResultDetails, getPresetResultDetails, getVariantResultDetails } from '../src/services/planning-result-details-mock';
import { assertPlanningResultDetails, readPlanningResultDetails } from '../src/services/planning-result-details-validation';
import { bindResultDemands } from '../src/services/planning-snapshot';
import type { PlanningInput } from '../src/types/planning';
import type { PlanningResultDetails, PlanningResultDetailsContext } from '../src/types/planning-result-details';

function fixture(presetId = 'balanced', variantId?: string, frozenInput?: PlanningInput) {
  const preset = planningPresets.find(row => row.id === presetId)!;
  const input = structuredClone(frozenInput ?? preset.input);
  const source = variantId ? interferenceVariants.find(row => row.id === variantId)!.result : preset.result!;
  const result = bindResultDemands(source, input, preset.input);
  const context: PlanningResultDetailsContext = {
    nodes: preset.baseline.stations, devices: preset.baseline.devices, links: result.links,
    configuration: result.configuration, demandIds: input.demands.map(row => row.id),
  };
  const details = variantId ? getVariantResultDetails(variantId, input) : getPresetResultDetails(presetId, input)!;
  return { input, context, details };
}

describe('独立规划补充明细教学资产', () => {
  // 读取历史v1必须走自身目录，新任务才取得带候选的v2。
  it('候选扩展升级保留v1目录及核心明细原值', () => {
    const input = planningPresets[0].input;
    const old = getPresetResultDetails('balanced', input, PLANNING_RESULT_DETAILS_ASSET_VERSION)!;
    const current = getPresetResultDetails('balanced', input)!;
    expect(old).not.toHaveProperty('candidateScreening'); expect(current.candidateScreening?.candidates).toHaveLength(4);
    const { candidateScreening: _candidate, assetVersion: _version, ...core } = current;
    expect({ ...core, assetVersion: old.assetVersion }).toEqual(old);
    expect(planningResultDetailsCatalog[PLANNING_RESULT_DETAILS_ASSET_VERSION].presets.balanced).toEqual(old);
  });
  it.each(['balanced', 'economical', 'constrained', 'device-balanced'])('%s 明细与原核心配置及冻结需求一致', presetId => {
    const { input, context, details } = fixture(presetId);
    expect(() => assertMockResultDetails(details, { presetId, input, context })).not.toThrow();
    expect(details.deviceParameters).toHaveLength(6);
    expect(details.deviceParameters!.every(row => row.tiltDeg === null && row.tiltEffective === false)).toBe(true);
    expect(details.frequencyAssignments!.every(row => row.freqId === null)).toBe(true);
    expect(details.routeQuality!.map(row => row.routeId)).toEqual(context.configuration.routes.map(row => row.id));
    expect(details.schemaVersion).toBe(1);
  });
  it.each(interferenceVariants.map(variant => [variant.id, variant.networkPresetId]))('%s 独立声明措施后质量并精确匹配变体频点', (variantId, presetId) => {
    const { input, context, details } = fixture(presetId, variantId);
    expect(() => assertMockResultDetails(details, { variantId, input, context })).not.toThrow();
    expect(details.routeQuality).not.toEqual(getPresetResultDetails(presetId, input)!.routeQuality);
    expect(details.frequencyAssignments!.find(row => row.linkId === 'LINK-B')!.frequencyKhz)
      .toBe(context.links.find(row => row.id === 'LINK-B')!.frequencyKhz);
    // 未提供质量的路由不能从措施前配置或数组顺序补值。
    expect(details.routeQuality!.find(row => row.routeId === 'ROUTE-1')!.reliability).toBeNull();
  });
  it('目录只含四基础档和九有效变体，无结果档不补造明细', () => {
    const directory = planningResultDetailsCatalog[PLANNING_RESULT_DETAILS_ASSET_VERSION];
    expect(Object.keys(directory.presets)).toHaveLength(4); expect(Object.keys(directory.variants)).toHaveLength(9);
    for (const id of ['shortage', 'execution-failed']) {
      expect(getPresetResultDetails(id, planningPresets.find(row => row.id === id)!.input)).toBeUndefined();
    }
    expect(() => getVariantResultDetails('economical:ROUTE_REBUILD', planningPresets[0].input)).toThrow();
  });
  it.each(['balanced', 'device-balanced'])('%s 需求改名及倒序仍按端点业务映射，歧义身份拒绝', presetId => {
    const preset = planningPresets.find(row => row.id === presetId)!;
    const input = structuredClone(preset.input);
    input.demands[0].id = 'VOICE-USER'; input.demands[1].id = 'DATA-USER'; input.demands.reverse();
    const { context, details } = fixture(presetId, undefined, input);
    expect(details.routeQuality!.find(row => row.routeId === 'ROUTE-1')!.demandId).toBe('VOICE-USER');
    expect(details.routeQuality!.find(row => row.routeId === 'ROUTE-2')!.demandId).toBe('DATA-USER');
    expect(() => assertMockResultDetails(details, { presetId, input, context })).not.toThrow();
    input.demands.push({ ...input.demands[0], id: 'DUPLICATE-RELATION' });
    expect(() => getPresetResultDetails(presetId, input)).toThrow('唯一关联');
  });
  it('已发布资产不可改写，返回副本互不影响，也不修改旧核心预设', () => {
    const before = JSON.stringify({ planningPresets, interferenceVariants });
    const { input, details } = fixture();
    const directory = planningResultDetailsCatalog[PLANNING_RESULT_DETAILS_ASSET_VERSION];
    expect(Object.isFrozen(directory.presets.balanced.routeQuality![0])).toBe(true);
    details.routeQuality![0].reliability = 0;
    details.deviceParameters![0].tiltDeg = 45;
    expect(getPresetResultDetails('balanced', input)!.routeQuality![0].reliability).toBe(0.99);
    const variant = getVariantResultDetails('balanced:FREQ_ADJUST', input);
    variant.frequencyAssignments![0].frequencyKhz = 1;
    expect(getVariantResultDetails('balanced:FREQ_ADJUST', input).frequencyAssignments![0].frequencyKhz).toBe(6000);
    expect(JSON.stringify({ planningPresets, interferenceVariants })).toBe(before);
  });
});

describe('补充明细契约与冻结引用校验', () => {
  it('保留 0、false、负裕度和比例边界；HTTP 自有版本不依赖 Mock 目录', () => {
    const { context, details } = fixture();
    details.assetVersion = 'http-service-release-2026';
    Object.assign(details.routeQuality![0], { hopCount: 0, totalDistanceM: 0, totalDelayMs: 0, bottleneckMarginDb: -3, reliability: 0, isFeasible: false });
    details.routeQuality![1].reliability = 1;
    details.deviceParameters![0].tiltDeg = 0;
    details.frequencyAssignments![0].reuseGroup = 0;
    details.conflictFree = false;
    const read = readPlanningResultDetails(details, context);
    expect(read).toEqual(details); expect(read).not.toBe(details);
    read.routeQuality![0].reliability = 1;
    expect(details.routeQuality![0].reliability).toBe(0);
  });
  it('允许缺值、明确空集合和部分分配，不把缺少行判为未分配', () => {
    const { context, details } = fixture();
    details.deviceParameters = null; details.routeQuality = []; details.frequencyConflicts = null;
    details.frequencyGap = null; details.conflictFree = null; details.unreachableDemandIds = null;
    details.frequencyAssignments = details.frequencyAssignments!.slice(0, 1);
    details.frequencyAssignments[0].resourceGroupId = null;
    details.frequencyAssignments[0].bandwidthKhz = null;
    details.frequencyAssignments[0].reuseGroup = null;
    expect(readPlanningResultDetails(details, context)).toEqual(details);
    details.frequencyAssignments = [];
    expect(readPlanningResultDetails(details, context).frequencyAssignments).toEqual([]);
  });
  it('冲突记录、数量缺口和总体结论分别保留，不推算一致性', () => {
    const { context, details } = fixture();
    details.frequencyConflicts = [{ id: 'C1', type: 'SERVICE_NEW_KIND', linkIds: ['LINK-A', 'LINK-B'],
      frequencyKhz: null, distanceM: 0, requiredDistanceM: 30000, severity: 'SERVICE_DEFINED' }];
    details.frequencyGap = { requiredChannels: 353, availableChannels: 48, shortage: 0 };
    details.conflictFree = true;
    details.unreachableDemandIds = ['DEMAND-01'];
    expect(readPlanningResultDetails(details, context)).toEqual(details);
  });
  const corruptions: [string, (value: PlanningResultDetails) => void][] = [
    ['未知 schema', value => { (value as { schemaVersion: number }).schemaVersion = 2; }],
    ['空版本', value => { value.assetVersion = ' '; }],
    ['缺少必有集合', value => { delete (value as Partial<PlanningResultDetails>).routeQuality; }],
    ['缺少可空字段', value => { delete (value.deviceParameters![0] as { tiltDeg?: number | null }).tiltDeg; }],
    ['重复设备', value => { value.deviceParameters!.push({ ...value.deviceParameters![0] }); }],
    ['设备不在配置', value => { value.deviceParameters![0].deviceId = 'FOREIGN'; }],
    ['倾角非有限', value => { value.deviceParameters![0].tiltDeg = Infinity; }],
    ['布尔文本', value => { (value.deviceParameters![0] as unknown as { tiltEffective: string }).tiltEffective = 'false'; }],
    ['重复路由', value => { value.routeQuality!.push({ ...value.routeQuality![0] }); }],
    ['错误需求', value => { value.routeQuality![0].demandId = 'DEMAND-02'; }],
    ['错误瓶颈', value => { value.routeQuality![0].bottleneckLinkId = 'LINK-C'; }],
    ['小数跳数', value => { value.routeQuality![0].hopCount = 1.5; }],
    ['负距离', value => { value.routeQuality![0].totalDistanceM = -1; }],
    ['比例越界', value => { value.routeQuality![0].reliability = 1.01; }],
    ['重复分配身份', value => { value.frequencyAssignments![1].id = value.frequencyAssignments![0].id; }],
    ['重复分配链路', value => { value.frequencyAssignments![1].linkId = 'LINK-A'; }],
    ['错链路', value => { value.frequencyAssignments![0].linkId = 'FOREIGN'; }],
    ['错频点', value => { value.frequencyAssignments![0].frequencyKhz = 8000; }],
    ['错频率池', value => { value.frequencyAssignments![0].resourceGroupId = 'OTHER'; }],
    ['复用组为文本', value => { (value.frequencyAssignments![0] as unknown as { reuseGroup: string }).reuseGroup = '1'; }],
    ['负复用组', value => { value.frequencyAssignments![0].reuseGroup = -1; }],
    ['零带宽', value => { value.frequencyAssignments![0].bandwidthKhz = 0; }],
    ['空频点身份', value => { value.frequencyAssignments![0].freqId = ' '; }],
    ['错误不可达身份', value => { value.unreachableDemandIds = ['FOREIGN']; }],
    ['重复不可达身份', value => { value.unreachableDemandIds = ['DEMAND-01', 'DEMAND-01']; }],
    ['小数缺口', value => { value.frequencyGap!.shortage = 0.5; }],
    ['重复冲突链路', value => { value.frequencyConflicts = [{ id: 'C1', type: 'ANY', linkIds: ['LINK-A', 'LINK-A'], frequencyKhz: null, distanceM: null, requiredDistanceM: null, severity: null }]; }],
  ];
  it.each(corruptions)('%s 拒绝整个已提供的明细', (_name, corrupt) => {
    const { context, details } = fixture(); corrupt(details);
    expect(() => assertPlanningResultDetails(details, context)).toThrow('补充明细无效');
  });
  it.each(['frozen-device', 'configured-device', 'frozen-node', 'group-values', 'context-duplicate'] as const)('%s 关联不完整时拒绝，不只检查 linkId 存在', target => {
    const { context, details } = fixture();
    const broken = structuredClone(context);
    if (target === 'frozen-device') broken.devices[0].stationId = 'ND-0003';
    if (target === 'configured-device') broken.configuration.devices[0].stationId = 'ND-0003';
    if (target === 'frozen-node') broken.nodes = broken.nodes.filter(row => row.id !== 'ND-0001');
    if (target === 'group-values') broken.configuration.frequencies[0].allocatedKhz = [8000, 10000];
    if (target === 'context-duplicate') broken.links = [...broken.links, broken.links[0]];
    expect(() => assertPlanningResultDetails(details, broken)).toThrow();
  });
  it('结构合法的篡改仍须命中记录自身资产版本与来源', () => {
    const { input, context, details } = fixture();
    details.routeQuality![0].reliability = 0.8;
    expect(() => assertPlanningResultDetails(details, context)).not.toThrow();
    expect(() => assertMockResultDetails(details, { presetId: 'balanced', input, context })).toThrow('资产不一致');
    details.assetVersion = 'unknown-local-version';
    expect(() => assertMockResultDetails(details, { presetId: 'balanced', input, context })).toThrow('未知');
    expect(() => assertMockResultDetails(details, { presetId: 'balanced', variantId: 'balanced:POWER_OPT', input, context })).toThrow('身份不唯一');
  });
});
