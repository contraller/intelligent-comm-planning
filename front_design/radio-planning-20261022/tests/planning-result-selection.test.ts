import { afterEach, describe, expect, it } from 'vitest';
import { createRenderer, h, nextTick, reactive, ssrContextKey, toRaw, type App } from 'vue';
import PlanningApiResultPanel from '../src/components/PlanningApiResultPanel.vue';
import { planningPresets } from '../src/mocks/planning-presets';
import type { PlanningResult } from '../src/types/planning';
import type { ApiPlanningResult } from '../src/types/planning-api';

// 只标注本地夹具，生命周期仍执行当前结果组件的真实入口。
type SelectionFixtureContext = {
  key: string;
  result: PlanningResult | null;
  configuration: PlanningResult['configuration'];
};

// 生命周期用当前结果组件的真实 setup；表格模板与地图联动由组合测试覆盖。
Object.assign(PlanningApiResultPanel, { render: () => h('selection-probe') });
const apps: App[] = [];
const renderer = createRenderer<any, any>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insertStaticContent: () => [{}, {}] });
const frequencyRow = (selection: ReturnType<typeof setup>['selection'], id: string) => selection.bindFrequencyRows([{ id }])[0];
afterEach(() => apps.splice(0).forEach(app => app.unmount()));
function setup() {
  const preset = structuredClone(planningPresets[0]);
  const state = reactive({ context: { key: 'plan-A-v1', result: { ...preset.result!, snapshotId: 'snap-1', inputSnapshot: preset.baseline },
    configuration: preset.result!.configuration } as SelectionFixtureContext, tab: '路由路径', readable: true, generation: 1, active: true });
  // 使用独立展示夹具，关系由 ID 明确给出，不依赖频点猜测。
  state.context.result!.resultDetails = { schemaVersion: 1, assetVersion: 'selection-test', deviceParameters: null, routeQuality: null,
    frequencyAssignments: [{ id: 'FA-A', linkId: 'LINK-A', resourceGroupId: 'hf-full', freqId: null, frequencyKhz: 6000, bandwidthKhz: null, reuseGroup: null }],
    frequencyConflicts: null, frequencyGap: null, conflictFree: null, unreachableDemandIds: null };
  const app=renderer.createApp({render:()=>h(PlanningApiResultPanel,{
    result:state.context.result ? {...preset.result,...state.context.result,nodes:state.context.result.inputSnapshot.stations,devices:state.context.result.inputSnapshot.devices,configuration:state.context.configuration} as unknown as ApiPlanningResult : null,
    ownerKey:JSON.stringify([state.context.key,state.generation,state.readable]),active:state.active&&state.readable,historical:false,
  })});apps.push(app);app.provide(ssrContextKey,{});app.mount({});
  const current=(app._instance!.subTree.component! as any).setupState;
  // 仅将测试调用映射到当前组件入口，不在夹具实现选择或关系解析。
  const selection={
    selection:{get value(){return current.selection;}},
    focus:{get value(){return {...current.focus,message:current.selectionMessage};}},
    get handlers(){const handlers=current.handlers;const row=(value:{id:string})=>current.bindRows([value])[0];return {
      route:(value:{id:string})=>handlers.route(row(value)),link:(value:{id:string})=>handlers.link(row(value)),
      station:handlers.node,clear:handlers.clear,frequency:handlers.pool,assignment:handlers.assignment,
    };},
    selectedRow:(kind:string,rows:{id:string}[])=>current.selectedRow(kind,rows),
    bindFrequencyRows:(rows:{id:string}[])=>current.bindRows(rows),
  };
  Object.defineProperty(state,'tab',{get:()=>current.tab,set:value=>{current.tab=value;}});
  state.tab='路由路径';
  return { state, selection };
}

describe('规划结果选择生命周期', () => {
  // 表格与地图的选择替换由组件测试覆盖，这里只验证路由页清除后的默认范围。
  it('路由页清除节点选择后恢复默认范围', async () => {
    const { selection } = setup();
    selection.handlers.station('ND-0003');
    expect(selection.focus.value.stationIds).toEqual(['ND-0003']);
    selection.handlers.clear();
    expect(selection.focus.value).toMatchObject({ stationId: '', linkId: '', linkIds: ['LINK-A', 'LINK-B', 'LINK-C'] });
  });
  it.each(['owner', 'snapshot', 'absent', 'tab', 'identity', 'permission'])('%s 变化清除选择并拒绝旧回调', async change => {
    const { state, selection } = setup(), old = selection.handlers;
    old.route({ id: 'ROUTE-3' });
    if (change === 'owner') state.context.key = 'plan-B-v1';
    if (change === 'snapshot') state.context.result!.snapshotId = 'snap-2';
    if (change === 'absent') state.context.result = null;
    if (change === 'tab') state.tab = '设备参数';
    if (change === 'identity') state.generation++;
    if (change === 'permission') state.readable = false;
    await nextTick();expect(selection.selection.value).toBeNull();
    old.route({ id: 'ROUTE-3' });
    expect(selection.selection.value).toBeNull();
    if (change === 'permission') {
      selection.handlers.station('ND-0001');
      expect(selection.focus.value.stationIds).toEqual([]);
    }
  });
  it('同版本重读保留有效选择，当前 ID 或关联失效时清理', async () => {
    const { state, selection } = setup(); selection.handlers.route({ id: 'ROUTE-3' });
    state.context = structuredClone(toRaw(state.context)); await nextTick();
    expect(selection.selection.value?.id).toBe('ROUTE-3');
    state.context.configuration!.routes.find(row => row.id === 'ROUTE-3')!.linkIds[0] = 'missing';
    await nextTick(); expect(selection.selection.value).toBeNull();
    selection.handlers.link({ id: 'LINK-A' }); state.context.result!.links.shift();
    await nextTick(); expect(selection.selection.value).toBeNull();
  });
  it('隐藏结果区保留其选择，但隐藏前的事件恢复后也失效', async () => {
    const { state, selection } = setup(), old = selection.handlers;
    old.link({ id: 'LINK-A' }); state.active = false;await nextTick();
    selection.handlers.station('ND-0004'); expect(selection.selection.value?.id).toBe('LINK-A');
    state.active = true;await nextTick(); old.station('ND-0004'); expect(selection.selection.value?.id).toBe('LINK-A');
    selection.handlers.station('ND-0004'); expect(selection.selection.value?.id).toBe('ND-0004');
  });
  it('不存在的 ID 拒绝选择；存在但关联不全的行可显示明确提示', async () => {
    const { state, selection } = setup();
    selection.handlers.route({ id: 'forged' }); expect(selection.selection.value).toBeNull();
    state.context.configuration!.routes[0].linkIds = ['missing'];
    selection.handlers.route({ id: 'ROUTE-1' });await nextTick();
    expect(selection.focus.value).toMatchObject({ stationIds: [], linkIds: [] });expect(selection.focus.value.message).toContain('关联不完整');
  });
  it('池与分配行互斥；离开频率页签、关系失效和迟到回调不保留频率高亮', async () => {
    const { state, selection } = setup(); state.tab = '频率分配';
    selection.handlers.frequency(frequencyRow(selection, 'hf-full')); expect(selection.selection.value?.kind).toBe('frequency');
    selection.handlers.assignment(frequencyRow(selection, 'FA-A')); expect(selection.selection.value?.kind).toBe('assignment');
    expect(selection.selectedRow('frequency', [{ id: 'hf-full' }])).toBeNull(); expect(selection.focus.value.linkIds).toEqual(['LINK-A']);
    state.context.result!.resultDetails!.frequencyAssignments![0].linkId = 'missing'; await nextTick();
    expect(selection.selection.value).toBeNull(); expect(selection.focus.value.linkIds).toEqual([]);
    expect(selection.focus.value.message).toContain('关联不完整');
    state.context.result!.resultDetails!.frequencyAssignments![0].linkId = 'LINK-A';
    const old = selection.handlers, oldRow = frequencyRow(selection, 'FA-A'); old.assignment(oldRow); state.tab = '覆盖与场强';await nextTick();
    expect(selection.selection.value).toBeNull(); old.assignment(oldRow); expect(selection.selection.value).toBeNull();
  });
  it('重复分配身份不能保留上一次频率行的高亮', async () => {
    const { state, selection } = setup(); state.tab = '频率分配';
    selection.handlers.frequency(frequencyRow(selection, 'hf-full'));
    expect(selection.focus.value.linkIds).toEqual(['LINK-A']);
    state.context.result!.resultDetails!.frequencyAssignments!.push({ ...state.context.result!.resultDetails!.frequencyAssignments![0] });
    selection.handlers.assignment(frequencyRow(selection, 'FA-A'));await nextTick();
    expect(selection.focus.value).toMatchObject({ stationIds: [], linkIds: [] });expect(selection.focus.value.message).toContain('关联不完整');
  });
  it.each(['frequency', 'assignment'] as const)('新版本当前 %s handler 拒绝迟到旧行，即使对象 ID 相同', async kind => {
    const { state, selection } = setup(); state.tab = '频率分配';
    const id = kind === 'frequency' ? 'hf-full' : 'FA-A', oldRow = frequencyRow(selection, id);
    selection.handlers[kind](oldRow); expect(selection.focus.value.linkIds).toEqual(['LINK-A']);
    state.context.key = 'plan-B-v1';await nextTick();
    selection.handlers[kind](oldRow); expect(selection.selection.value).toBeNull(); expect(selection.focus.value.linkIds).toEqual([]);
    selection.handlers[kind](frequencyRow(selection, id)); expect(selection.focus.value.linkIds).toEqual(['LINK-A']);
  });
  it('池关系减少但仍可定位时清理旧选择并保留变化原因', async () => {
    const { state, selection } = setup(); state.tab = '频率分配';
    state.context.result!.resultDetails!.frequencyAssignments!.push({ id: 'FA-B', linkId: 'LINK-B', resourceGroupId: 'hf-full', freqId: null, frequencyKhz: state.context.result!.links[1].frequencyKhz, bandwidthKhz: null, reuseGroup: null });
    selection.handlers.frequency(frequencyRow(selection, 'hf-full')); expect(selection.focus.value.linkIds).toEqual(['LINK-A', 'LINK-B']);
    state.context.result!.resultDetails!.frequencyAssignments!.pop(); await nextTick();
    expect(selection.selection.value).toBeNull(); expect(selection.focus.value.linkIds).toEqual([]); expect(selection.focus.value.message).toContain('关联已变化');
  });
});
