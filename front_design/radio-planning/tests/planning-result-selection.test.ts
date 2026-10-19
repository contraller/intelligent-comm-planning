import { afterEach, describe, expect, it } from 'vitest';
import { effectScope, nextTick, reactive, toRaw } from 'vue';
import { usePlanningResultSelection } from '../src/composables/usePlanningResultSelection';
import { planningPresets } from '../src/mocks/planning-presets';
import type { PlanningResultDisplayContext } from '../src/services/planning-result-display';

const scopes: ReturnType<typeof effectScope>[] = [];
const frequencyRow = (selection: ReturnType<typeof usePlanningResultSelection>, id: string) => selection.bindFrequencyRows([{ id }])[0];
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()));
function setup() {
  const preset = structuredClone(planningPresets[0]);
  const state = reactive({ context: { key: 'plan-A-v1', result: { ...preset.result!, snapshotId: 'snap-1', inputSnapshot: preset.baseline },
    configuration: preset.result!.configuration } as PlanningResultDisplayContext, tab: '路由结果', readable: true, generation: 1, active: true });
  // 使用独立展示夹具，关系由 ID 明确给出，不依赖频点猜测。
  state.context.result!.resultDetails = { schemaVersion: 1, assetVersion: 'selection-test', deviceParameters: null, routeQuality: null,
    frequencyAssignments: [{ id: 'FA-A', linkId: 'LINK-A', resourceGroupId: 'hf-full', freqId: null, frequencyKhz: 6000, bandwidthKhz: null, reuseGroup: null }],
    frequencyConflicts: null, frequencyGap: null, conflictFree: null, unreachableDemandIds: null };
  const scope = effectScope(); scopes.push(scope);
  const selection = scope.run(() => usePlanningResultSelection({ context: () => state.context, tab: () => state.tab,
    readable: () => state.readable, generation: () => state.generation, active: () => state.active }))!;
  return { state, selection };
}

describe('规划结果选择生命周期', () => {
  it('单一选择替换表格行与地图高亮，清除恢复页签默认', () => {
    const { selection } = setup();
    selection.handlers.value.route({ id: 'ROUTE-3' });
    expect(selection.focus.value.linkIds).toEqual(['LINK-B', 'LINK-C']);
    expect(selection.selectedRow('route', [{ id: 'ROUTE-3' }])).toEqual({ id: 'ROUTE-3' });
    selection.handlers.value.station('ND-0003');
    expect(selection.selectedRow('route', [{ id: 'ROUTE-3' }])).toBeNull();
    expect(selection.focus.value.stationIds).toEqual(['ND-0003']);
    selection.handlers.value.clear();
    expect(selection.focus.value).toMatchObject({ stationId: '', linkId: '', linkIds: ['LINK-A', 'LINK-B', 'LINK-C'] });
  });
  it.each(['owner', 'snapshot', 'absent', 'tab', 'identity', 'permission'])('%s 变化清除选择并拒绝旧回调', change => {
    const { state, selection } = setup(), old = selection.handlers.value;
    old.route({ id: 'ROUTE-3' });
    if (change === 'owner') state.context.key = 'plan-B-v1';
    if (change === 'snapshot') state.context.result!.snapshotId = 'snap-2';
    if (change === 'absent') state.context.result = null;
    if (change === 'tab') state.tab = '参数配置';
    if (change === 'identity') state.generation++;
    if (change === 'permission') state.readable = false;
    expect(selection.selection.value).toBeNull();
    old.route({ id: 'ROUTE-3' });
    expect(selection.selection.value).toBeNull();
    if (change === 'permission') {
      selection.handlers.value.station('ND-0001');
      expect(selection.focus.value.stationIds).toEqual([]);
    }
  });
  it('同版本重读保留有效选择，当前 ID 或关联失效时清理', async () => {
    const { state, selection } = setup(); selection.handlers.value.route({ id: 'ROUTE-3' });
    state.context = structuredClone(toRaw(state.context)); await nextTick();
    expect(selection.selection.value?.id).toBe('ROUTE-3');
    state.context.configuration!.routes.find(row => row.id === 'ROUTE-3')!.linkIds[0] = 'missing';
    await nextTick(); expect(selection.selection.value).toBeNull();
    selection.handlers.value.link({ id: 'LINK-A' }); state.context.result!.links.shift();
    await nextTick(); expect(selection.selection.value).toBeNull();
  });
  it('隐藏结果区保留其选择，但隐藏前的事件恢复后也失效', () => {
    const { state, selection } = setup(), old = selection.handlers.value;
    old.link({ id: 'LINK-A' }); state.active = false;
    selection.handlers.value.station('ND-0004'); expect(selection.selection.value?.id).toBe('LINK-A');
    state.active = true; old.station('ND-0004'); expect(selection.selection.value?.id).toBe('LINK-A');
    selection.handlers.value.station('ND-0004'); expect(selection.selection.value?.id).toBe('ND-0004');
  });
  it('不存在的 ID 拒绝选择；存在但关联不全的行可显示明确提示', () => {
    const { state, selection } = setup();
    selection.handlers.value.route({ id: 'forged' }); expect(selection.selection.value).toBeNull();
    state.context.configuration!.routes[0].linkIds = ['missing'];
    selection.handlers.value.route({ id: 'ROUTE-1' });
    expect(selection.focus.value).toMatchObject({ state: 'invalid', stationIds: [], linkIds: [] });
  });
  it('池与分配行互斥；离开频率页签、关系失效和迟到回调不保留频率高亮', async () => {
    const { state, selection } = setup(); state.tab = '通信资源';
    selection.handlers.value.frequency(frequencyRow(selection, 'hf-full')); expect(selection.selection.value?.kind).toBe('frequency');
    selection.handlers.value.assignment(frequencyRow(selection, 'FA-A')); expect(selection.selection.value?.kind).toBe('assignment');
    expect(selection.selectedRow('frequency', [{ id: 'hf-full' }])).toBeNull(); expect(selection.focus.value.linkIds).toEqual(['LINK-A']);
    state.context.result!.resultDetails!.frequencyAssignments![0].linkId = 'missing'; await nextTick();
    expect(selection.selection.value).toBeNull(); expect(selection.focus.value.linkIds).toEqual([]);
    expect(selection.focus.value.message).toContain('关联不完整');
    state.context.result!.resultDetails!.frequencyAssignments![0].linkId = 'LINK-A';
    const old = selection.handlers.value, oldRow = frequencyRow(selection, 'FA-A'); old.assignment(oldRow); state.tab = '覆盖结果';
    expect(selection.selection.value).toBeNull(); old.assignment(oldRow); expect(selection.selection.value).toBeNull();
  });
  it('重复分配身份不能保留上一次频率行的高亮', () => {
    const { state, selection } = setup(); state.tab = '通信资源';
    selection.handlers.value.frequency(frequencyRow(selection, 'hf-full'));
    expect(selection.focus.value.linkIds).toEqual(['LINK-A']);
    state.context.result!.resultDetails!.frequencyAssignments!.push({ ...state.context.result!.resultDetails!.frequencyAssignments![0] });
    selection.handlers.value.assignment(frequencyRow(selection, 'FA-A'));
    expect(selection.focus.value).toMatchObject({ state: 'invalid', stationIds: [], linkIds: [] });
  });
  it.each(['frequency', 'assignment'] as const)('新版本当前 %s handler 拒绝迟到旧行，即使对象 ID 相同', kind => {
    const { state, selection } = setup(); state.tab = '通信资源';
    const id = kind === 'frequency' ? 'hf-full' : 'FA-A', oldRow = frequencyRow(selection, id);
    selection.handlers.value[kind](oldRow); expect(selection.focus.value.linkIds).toEqual(['LINK-A']);
    state.context.key = 'plan-B-v1';
    selection.handlers.value[kind](oldRow); expect(selection.selection.value).toBeNull(); expect(selection.focus.value.linkIds).toEqual([]);
    selection.handlers.value[kind](frequencyRow(selection, id)); expect(selection.focus.value.linkIds).toEqual(['LINK-A']);
  });
  it('池关系减少但仍可定位时清理旧选择并保留变化原因', async () => {
    const { state, selection } = setup(); state.tab = '通信资源';
    state.context.result!.resultDetails!.frequencyAssignments!.push({ id: 'FA-B', linkId: 'LINK-B', resourceGroupId: 'hf-full', freqId: null, frequencyKhz: state.context.result!.links[1].frequencyKhz, bandwidthKhz: null, reuseGroup: null });
    selection.handlers.value.frequency(frequencyRow(selection, 'hf-full')); expect(selection.focus.value.linkIds).toEqual(['LINK-A', 'LINK-B']);
    state.context.result!.resultDetails!.frequencyAssignments!.pop(); await nextTick();
    expect(selection.selection.value).toBeNull(); expect(selection.focus.value.linkIds).toEqual([]); expect(selection.focus.value.message).toContain('关联已变化');
  });
});
