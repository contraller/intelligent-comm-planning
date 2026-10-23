import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, toRaw, type App, type Slots } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import PlanningApiResultPanel from '../src/components/PlanningApiResultPanel.vue';
import AppTable from '../src/components/AppTable.vue';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useTaskInputStore } from '../src/stores/task-input';
import { useResourceReadStore } from '../src/stores/resource-read';
import { previewService } from '../src/services';
import { usePreviewStore } from '../src/stores/preview';
import { createMockService } from '../src/services/mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { savedRequest } from './helpers/tasks';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
// 仅复用模板编译，滚动状态与回顶验证仍由本地宿主负责。
import { clientTemplate } from './helpers/vue-client';

// 执行真实页面、指标与 AppTable 模板；地图和 PrimeVue 宿主用事件探针，不冒充视觉验收。
vi.mock('../src/components/MapCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false,
    props: ['stations', 'links', 'selectedId', 'selectedLinkId', 'highlightStationIds', 'highlightLinkIds', 'coverageDisplay', 'showCoverage', 'planningOverlay'],
    emits: ['select'], setup(props, { emit, expose }) { expose({locateResource:vi.fn()});return () => h('map-probe', { ...props, select: (id: string) => emit('select', id) }); },
  }) };
});
vi.mock('primevue/datatable', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false, props: ['value', 'selection', 'expandedRows'], emits: ['update:selection', 'update:expandedRows'],
    setup(props, { emit, slots }) { return () => h('table-probe', { ...props, select: (row: unknown) => emit('update:selection', row), expand: (id: string) => emit('update:expandedRows', { [id]: true }) }, [slots.default?.(), ...(props.value as {id:string}[]).filter(row => props.expandedRows?.[row.id]).map(data => slots.expansion?.({data}))]); } }) };
});
vi.mock('primevue/column', () => ({ default: { inheritAttrs:false, props:['field','sortable'], setup:(props:any)=>()=>h('column-probe',{...props}) } }));
vi.mock('../src/components/AppDrawer.vue', async () => { const { h } = await import('vue'); return { default: { inheritAttrs: false, props: ['visible'], setup: (props: { visible: boolean }, { slots }: { slots: Slots }) => () => props.visible ? h('aside', {}, [slots.default?.(), slots.footer?.()]) : null } }; });
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/TaskApiPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/PlanExportDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/PlanningApiProgressPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/PlanComparisonPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));

vi.mock('../src/components/PlanningApiVersionsPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceReadStatus.vue', () => ({ default: { render: () => null } }));


interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown;
  readonly options: HostNode[]; scrollTop?: number;
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
  get options() { return this.children.filter(child => child.tag === 'option'); },
  addEventListener() {}, removeEventListener() {}, getRootNode: () => document });
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
function find(root: HostNode, predicate: (n: HostNode) => boolean): HostNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const hit = find(child, predicate); if (hit) return hit; }
}
const all = (root: HostNode, predicate: (n: HostNode) => boolean): HostNode[] => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
const textOf = (root: HostNode): string => root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}


await Promise.all([clientTemplate(PlanningApiView, 'src/views/PlanningApiView.vue', 'coverage-render.ts'), clientTemplate(PlanningApiResultPanel, 'src/components/PlanningApiResultPanel.vue', 'coverage-render.ts'), clientTemplate(AppTable, 'src/components/AppTable.vue', 'coverage-render.ts')]);
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const map = (root: HostNode) => find(root, row => row.tag === 'map-probe')!;
const table = (root: HostNode, id: string) => find(root, row => row.tag === 'table-probe' && (row.props.value as { id: string }[]).some(item => item.id === id))!;
async function select(root: HostNode, id: string) {
  const target = table(root, id); expect(target, id).toBeDefined();
  (target.props.select as (row: unknown) => void)((target.props.value as { id: string }[]).find(row => row.id === id)); await nextTick();
}
async function mountPlanning(presetId = 'balanced') {
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', { activeElement: null });
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);let time=Date.parse('2026-10-03T00:00:00Z');vi.spyOn(Date,'now').mockImplementation(()=>time);
  for(const [name,method] of Object.entries(raw))if(typeof method==='function')vi.spyOn(previewService as any,name).mockImplementation(method);
  const preset=planningPresets.find(row=>row.id===presetId)!;
  const submitted=await raw.submitPlanning(await savedRequest(storage,{baseRevision:'initial',requestId:'submit',taskId:null,parentPlanVersionId:null,input:structuredClone(preset.input)}));time+=20000;
  const saved=await raw.savePlanVersion({baseRevision:submitted.workspace.revision,jobId:submitted.view.job.id,requestId:'save',name:'联动测试方案',note:''});
  const preview=usePreviewStore();await preview.load();const resources=useResourceReadStore();await resources.activate('planning');
  const task=useTaskInputStore();await task.initialize('planning');await task.open(saved.plan.taskId,false);
  vi.spyOn(resources,'activate').mockResolvedValue(true);vi.spyOn(task,'initialize').mockResolvedValue();
  const planning=usePlanningApiStore();const started=vi.spyOn(planning,'start').mockImplementation(()=>{});await nextTick();
  planning.selectedPlan=await raw.getPlanningPlan({context:'planning',taskId:task.taskId,planId:saved.plan.id});planning.step=2;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/planning', component: PlanningApiView }] });
  await router.push('/planning?taskId='+task.taskId); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  const root = node('root'); app.mount(root); await vi.waitFor(()=>expect(started).toHaveBeenCalled());await nextTick();
  return { root, planning, task, preview, auth, storage, raw, writes: storage.writes, jobId: submitted.view.job.id };
}

describe('规划页面实际模板联动', () => {
  it('正式配置抽屉读取独立服务配置，产物缺失后关闭且不能借用规划配置重开', async () => {
    const s = await mountPlanning(), plan = structuredClone(toRaw(s.planning.selectedPlan!));
    app!.unmount();
    const confirmed = Vue.ref<import('../src/types/planning-api').PlanningConfirmedConfiguration | null>({ sourcePlanId: plan.id, sourcePlanVersion: plan.version, sourceSnapshotId: plan.result.snapshotId, confirmedAt: '2026-10-21T01:00:00Z', configuration: structuredClone(plan.result.configuration) });
    confirmed.value!.configuration.devices[0].txPowerDbm = 0;
    const panel = Vue.ref<InstanceType<typeof PlanningApiResultPanel>>();
    app = renderer.createApp({ render: () => h(PlanningApiResultPanel, { ref: panel, result: plan.result, ownerKey: 'confirmed-owner', active: true, historical: false, confirmedConfiguration: confirmed.value }) });
    app.use(pinia!);app.provide(ssrContextKey, {});const root = node('root');app.mount(root);
    panel.value!.openConfiguration('confirmed-owner', 'confirmed');await nextTick();
    const drawer = find(root, row => row.tag === 'aside')!;
    expect((table(drawer, 'DV-0001').props.value as Record<string,unknown>[])[0].txPowerDbm).toBe(0);
    expect(plan.result.configuration.devices[0].txPowerDbm).not.toBe(0);
    confirmed.value = null;await nextTick();expect(find(root, row => row.tag === 'aside')).toBeUndefined();
    panel.value!.openConfiguration('confirmed-owner', 'confirmed');await nextTick();expect(find(root, row => row.tag === 'aside')).toBeUndefined();
  });
  it('部署数量只取当前对象，保留零值且不借用其他结果的数量', async () => {
    const s=await mountPlanning(),plan=s.planning.selectedPlan!;
    s.planning.job!.solutions=[{solutionId:'another-result',label:'另一结果',radioCount:7,result:plan.result,outcome:plan.outcome,savedPlanId:null,expired:false}];s.planning.selectedSolutionId='another-result';
    plan.radioCount=0;await nextTick();
    const summary=()=>textOf(find(s.root,row=>row.props['aria-label']==='新增部署单元数')!);
    expect(summary()).toBe('新增部署单元数：0');
    delete plan.radioCount;await nextTick();expect(summary()).toBe('新增部署单元数：未提供');
    s.planning.selectedPlan=null;await nextTick();expect(summary()).toBe('新增部署单元数：7');
    delete s.planning.job!.solutions;await nextTick();expect(summary()).toBe('新增部署单元数：未提供');
  });
  it('覆盖说明明确热力和边界含义，显示方式仍联动同一地图', async () => {
    const s=await mountPlanning();await click(s.root,'覆盖与场强');
    const selector=find(s.root,row=>row.props['aria-label']==='覆盖显示方式')!,body=selector.parent!.parent!;
    expect(textOf(body)).toContain('场强热力图以颜色呈现场强空间分布');expect(textOf(body)).toContain('dBμV/m');expect(textOf(body)).toContain('覆盖轮廓显示已提供的覆盖边界');expect(textOf(body)).not.toContain('PNG');
    (selector.props.onChange as Function)({target:{value:'raster'}});await nextTick();expect(map(s.root).props.coverageDisplay).toBe('raster');
  });
  it('配置查看随方案切换和失去查看权限关闭，重开读取当前冻结结果', async () => {
    const s=await mountPlanning();await click(s.root,'查看完整配置');expect(find(s.root,row=>row.tag==='aside')).toBeDefined();
    const next=structuredClone(toRaw(s.planning.selectedPlan!));next.id='configuration-next';next.version='V9';next.result.configuration.devices[0].txPowerDbm=12;
    s.planning.selectedPlan=next;await nextTick();expect(find(s.root,row=>row.tag==='aside')).toBeUndefined();
    await click(s.root,'查看完整配置');
    expect((table(find(s.root,row=>row.tag==='aside')!,'DV-0001').props.value as Record<string,unknown>[])[0].txPowerDbm).toBe(12);
    s.auth.accept({...s.auth.identity!,permissions:s.auth.identity!.permissions.filter(value=>value!=='planning.view')});await nextTick();
    expect(find(s.root,row=>row.tag==='aside')).toBeUndefined();
    const entry=find(s.root,row=>row.tag==='button'&&textOf(row).trim()==='查看完整配置')!;expect(entry.props.disabled).toBe(true);
    (entry.props.onClick as Function)();await nextTick();expect(find(s.root,row=>row.tag==='aside')).toBeUndefined();
  });
  it('切换及切回页签都只将明细回顶，保留整页滚动位置', async () => {
    const s=await mountPlanning(), scroll=find(s.root,row=>row.props.class==='result-scroll')!;
    s.root.scrollTop=88;scroll.scrollTop=720;
    await click(s.root,'路由路径');expect(scroll.scrollTop).toBe(0);expect(s.root.scrollTop).toBe(88);
    scroll.scrollTop=240;await click(s.root,'频率分配');expect(scroll.scrollTop).toBe(0);
    scroll.scrollTop=32;await click(s.root,'路由路径');expect(scroll.scrollTop).toBe(0);expect(s.root.scrollTop).toBe(88);
    const candidates=all(s.root,row=>row.tag==='details'&&textOf(row).includes('候选筛选与依据'));
    expect(candidates).toHaveLength(0);await click(s.root,'部署点位');
    expect(all(s.root,row=>row.tag==='details'&&textOf(row).includes('候选筛选与依据'))[0].props.open).not.toBe(true);
  });
  it('备用路由整条高亮且行选中，链路行改用双端定位，地图点击替换选择', async () => {
    const s = await mountPlanning(), before = JSON.stringify(s.preview.data);await click(s.root,'路由路径');
    await select(s.root, 'ROUTE-3');
    expect(map(s.root).props).toMatchObject({ selectedId: 'ND-0001', selectedLinkId: '', highlightLinkIds: ['LINK-B', 'LINK-C'], highlightStationIds: ['ND-0001', 'ND-0004', 'ND-0003'] });
    expect(table(s.root, 'ROUTE-3').props.selection).toMatchObject({ id: 'ROUTE-3' });
    await select(s.root, 'LINK-C');
    expect(map(s.root).props).toMatchObject({ selectedId: '', selectedLinkId: 'LINK-C', highlightStationIds: ['ND-0003', 'ND-0004'] });
    expect(table(s.root, 'ROUTE-3').props.selection).toBeNull();
    (map(s.root).props.select as (id: string) => void)('ND-0004'); await nextTick();
    expect(map(s.root).props.highlightLinkIds).toEqual([]);
    expect(table(s.root, 'LINK-C').props.selection).toBeNull();
    expect(JSON.stringify(s.preview.data)).toBe(before); expect(s.storage.writes).toBe(s.writes);
  });
  it('切换页签、清除选择恢复默认范围；覆盖偏好和冻结结果保持', async () => {
    const s = await mountPlanning();await click(s.root,'路由路径');
    await select(s.root, 'ROUTE-3'); await click(s.root, '设备参数');
    expect((map(s.root).props.highlightStationIds as string[]).length).toBeGreaterThan(0);
    await select(s.root, 'DV-0001');
    expect(map(s.root).props.highlightLinkIds).toEqual(['LINK-A']);
    await click(s.root, '清除选择');
    expect(map(s.root).props).toMatchObject({ selectedId: '', selectedLinkId: '', highlightLinkIds: [] });
    expect(table(s.root, 'DV-0001').props.selection).toBeNull();
    await click(s.root, '覆盖与场强');
    const control = find(s.root, row => row.props['aria-label'] === '覆盖显示方式')!;
    (control.props.onChange as Function)({target:{value:'contour'}});
    (map(s.root).props.select as (id: string) => void)('ND-0001'); await nextTick();
    await click(s.root, '清除选择');
    expect(map(s.root).props).toMatchObject({ coverageDisplay: 'contour', showCoverage: true, selectedId: '', selectedLinkId: '' });
    expect(s.storage.writes).toBe(s.writes);
  });
  it('部署定位采用保存输出坐标，不读取当前资源的新坐标', async () => {
    const s = await mountPlanning(), plan = s.planning.selectedPlan!;
    plan.result.configuration.deployment[0].plannedCoordinate = [114.8, 37.8];
    s.preview.data!.resources.stations.find(row => row.id === 'ND-0001')!.coordinate = [120, 30];
    await click(s.root, '部署点位'); await select(s.root, 'ND-0001');
    expect(map(s.root).props.selectedId).toBe('ND-0001');
    expect((map(s.root).props.planningOverlay as {nodes:{id:string;coordinate:number[]}[]}).nodes.find(row => row.id === 'ND-0001')!.coordinate).toEqual([114.8, 37.8]);
    expect(plan.result.nodes.find(row => row.id === 'ND-0001')!.coordinate).not.toEqual([114.8, 37.8]);
  });
  it('频率池和分配行按明确 ID 关联；无关系和不完整关联不保留上次高亮', async () => {
    const s = await mountPlanning(), plan = s.planning.selectedPlan!, configuration = plan.result.configuration;
    plan.result.resultDetails!.frequencyAssignments = plan.result.resultDetails!.frequencyAssignments!.filter(row => row.linkId === 'LINK-A');
    const assignment = plan.result.resultDetails!.frequencyAssignments![0];
    await click(s.root, '频率分配'); await select(s.root, 'hf-full');
    expect(map(s.root).props.highlightLinkIds).toEqual(['LINK-A']);
    expect(textOf(s.root)).toContain('明确关联');
    await select(s.root, assignment.id); expect(table(s.root, 'hf-full').props.selection).toBeNull();
    expect(map(s.root).props.highlightLinkIds).toEqual(['LINK-A']);
    assignment.resourceGroupId = null; await nextTick(); await select(s.root, 'hf-full');
    expect(map(s.root).props.highlightLinkIds).toEqual([]);
    expect(textOf(s.root)).toContain('未提供明确分配关系');
    assignment.resourceGroupId = 'hf-full'; configuration.devices[0].stationId = 'missing'; await nextTick();
    await select(s.root, 'hf-full');
    expect(map(s.root).props.highlightLinkIds).toEqual([]);
    expect(textOf(s.root)).toContain('所选结果关联不完整');
  });
  it('复用表格实例收到旧频率行时不串版本，失效关系清除后保留提示', async () => {
    const s = await mountPlanning(); await click(s.root, '频率分配');
    const assignment = s.planning.selectedPlan!.result.resultDetails!.frequencyAssignments![0], oldTable = table(s.root, assignment.id), oldRow = (oldTable.props.value as { id: string }[]).find(row => row.id === assignment.id)!;
    await select(s.root, assignment.id);
    const copy = structuredClone(toRaw(s.planning.selectedPlan!)); copy.id = 'new-frequency-owner'; vi.mocked(previewService.getPlanningPlan).mockResolvedValue(copy);
    await s.planning.selectPlan(copy.id); await nextTick();
    // 调用新渲染表格的当前转发器，验证保护不依赖旧 handler 本身。
    (table(s.root, assignment.id).props.select as (row: unknown) => void)(oldRow); await nextTick();
    expect(map(s.root).props.highlightLinkIds).toEqual([]); expect(table(s.root, assignment.id).props.selection).toBeNull();
    await select(s.root, assignment.id); expect(map(s.root).props.highlightLinkIds).toEqual([assignment.linkId]);
    s.planning.selectedPlan!.result.resultDetails!.frequencyAssignments![0].linkId = 'missing'; await nextTick();
    expect(table(s.root, assignment.id).props.selection).toBeNull(); expect(map(s.root).props.highlightLinkIds).toEqual([]);
    expect(textOf(s.root)).toContain('关联不完整');
  });
  it('参数路由明细保留零值与否值，旧版仍保留核心结果并提示缺省', async () => {
    const s = await mountPlanning(), details = s.planning.selectedPlan!.result.resultDetails!;await click(s.root,'路由路径');
    const route = details.routeQuality![0]; route.hopCount = 0; route.reliability = 0; route.isFeasible = false;
    await nextTick();
    const rows = table(s.root, route.routeId).props.value as Record<string, unknown>[];
    expect(rows.find(row => row.id === route.routeId)).toMatchObject({ hopCount: 0, reliability: '0%', isFeasible: '不可行' });
    await click(s.root, '设备参数');
    expect((table(s.root, 'DV-0001').props.value as Record<string, unknown>[])[0]).toMatchObject({ tiltDeg: '未提供', tiltEffective: '未参与' });
    delete s.planning.selectedPlan!.result.resultDetails; await nextTick();
    expect(textOf(s.root)).toContain('此结果未提供补充明细');
    expect((table(s.root, 'DV-0001').props.value as Record<string, unknown>[])[0]).toMatchObject({ tiltDeg: '未提供', tiltEffective: '未提供' });
    await click(s.root, '频率分配'); await select(s.root, 'hf-full');
    expect(map(s.root).props.highlightLinkIds).toEqual([]); expect(textOf(s.root)).toContain('未提供明确分配关系');
  });
  it('第三步配置快照展示同一冻结明细及空集合，未读取当前输入补值', async () => {
    const s = await mountPlanning(), details = s.planning.selectedPlan!.result.resultDetails!;
    details.frequencyConflicts = []; details.frequencyGap = { requiredChannels: 353, availableChannels: 48, shortage: 0 }; details.conflictFree = true;
    details.routeQuality = []; s.task.draft!.demands[0].minReliability = 0.123;
    s.planning.step = 3; await nextTick(); await click(s.root, '查看完整配置');
    const drawer=find(s.root,row=>row.tag==='aside')!;
    expect((table(drawer,'DV-0001').props.value as Record<string,unknown>[])[0]).toMatchObject({tiltDeg:'未提供',tiltEffective:'未参与'});
    expect((table(drawer,'ROUTE-1').props.value as Record<string,unknown>[])[0]).toMatchObject({reliability:'未提供'});
    // 当前页在分项标签展示补充明细；配置抽屉仍读取同一冻结快照。
    await click(s.root,'频率分配');const value=textOf(s.root);
    expect(value).toContain('频率冲突记录');expect(value).toContain('没有记录');
    expect(value).toContain('所需信道：353 · 可用信道：48 · 缺口：0 · 服务结论：明确无冲突');expect(value).not.toContain('12.3%');
    const assignment=details.frequencyAssignments![0];
    expect((table(s.root,assignment.id).props.value as Record<string,unknown>[])[0]).toMatchObject({linkId:assignment.linkId,frequencyKhz:assignment.frequencyKhz});
    expect(s.storage.writes).toBe(s.writes);
  });
  it('取消版本切换保留选择，实际换版即使复用快照和对象 ID 也清除', async () => {
    const s = await mountPlanning();await click(s.root,'路由路径'); await select(s.root, 'ROUTE-3');
    const copy = structuredClone(toRaw(s.planning.selectedPlan!)); copy.id = 'new-owner';
    vi.mocked(previewService.getPlanningPlan).mockResolvedValue(copy);await s.planning.openPlanAdjustment();
    s.planning.updateAdjustment({...structuredClone(toRaw(s.planning.adjustmentDraft!)),manualOverrides:[{deviceId:'DV-0001',txPowerDbm:33}]});
    const pending = s.planning.selectPlan(copy.id); await nextTick();
    expect(s.task.decision).not.toBeNull(); s.task.answer('cancel');
    expect(await pending).toBe(false); await nextTick();
    expect(table(s.root, 'ROUTE-3').props.selection).toMatchObject({ id: 'ROUTE-3' });
    s.planning.discardAdjustment(); await s.planning.selectPlan(copy.id); await nextTick();
    expect(table(s.root, 'ROUTE-3').props.selection).toBeNull();
    expect(map(s.root).props.highlightLinkIds).toEqual(['LINK-A', 'LINK-B', 'LINK-C']);
  });
  it('同版本重读保留选择，权限丢失立即清除并拒绝新事件', async () => {
    const s = await mountPlanning();await click(s.root,'路由路径'); await select(s.root, 'ROUTE-3');
    const copy = structuredClone(toRaw(s.planning.selectedPlan!));
    s.planning.selectedPlan=copy; await nextTick();
    expect(table(s.root, 'ROUTE-3').props.selection).toMatchObject({ id: 'ROUTE-3' });
    s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'planning.view') }); await nextTick();
    await select(s.root, 'ROUTE-3');
    expect(table(s.root, 'ROUTE-3').props.selection).toBeNull();
    expect(map(s.root).props.highlightLinkIds).toEqual([]);
  });
  it('输入地图与结果选择独立，历史快照保留节点链路回退表', async () => {
    const s = await mountPlanning();await click(s.root,'路由路径'); await select(s.root, 'ROUTE-3');
    s.planning.step = 1; await nextTick();
    (map(s.root).props.select as (id: string) => void)('ND-0004'); await nextTick();
    s.planning.step = 2; await nextTick();
    expect(map(s.root).props.selectedId).toBe('ND-0001');
    // 独立构造缺少补充明细的历史契约，不把只读参考库冒充任务方案接口。
    const reference=structuredClone(toRaw(s.planning.selectedPlan!));reference.id='historical';reference.result.checks=[];delete reference.result.resultDetails;
    vi.mocked(previewService.getPlanningPlan).mockResolvedValue(reference);
    await s.planning.selectPlan(reference.id,reference.taskId);await nextTick();
    expect(textOf(s.root)).toContain('未提供校验结论');
    await click(s.root,'路由路径');const id=s.planning.selectedPlan!.result.links[0].id;await select(s.root,id);expect(map(s.root).props.selectedLinkId).toBe(id);
    await click(s.root,'部署点位');const stationId=s.planning.selectedPlan!.result.configuration.deployment[0].stationId;await select(s.root,stationId);expect(map(s.root).props.selectedId).toBe(stationId);
    await click(s.root,'设备参数');const device=s.planning.selectedPlan!.result.configuration.devices[0];await select(s.root,device.deviceId);expect(map(s.root).props.selectedId).toBe(device.stationId);

  });
  it('指标颜色和文字来自当前结果，参考方案的抗毁性明确未达标', async () => {
    const s = await mountPlanning('constrained');
    const connectivity = find(s.root, row => row.tag === 'article' && textOf(row).includes('连通率'))!;
    const survival = find(s.root, row => row.tag === 'article' && textOf(row).includes('抗毁性'))!;
    const power = find(s.root, row => row.tag === 'article' && textOf(row).includes('总辐射功率'))!;
    expect(connectivity.props.class).toContain('passed'); expect(textOf(connectivity)).toContain('达标');
    expect(survival.props.class).toContain('failed'); expect(textOf(survival)).toContain('82%'); expect(textOf(survival)).toContain('未达标');
    expect(power.props.class).toContain('objective'); expect(textOf(power)).toContain('最小化目标');expect(textOf(power)).toContain('未提供单项达标结论');
    expect(textOf(power)).not.toContain('最优');
  });
  it('路由主表关闭排序，辅助指标可展开且不改变地图选择', async () => {
    const s=await mountPlanning(); await click(s.root,'路由路径');
    const route=s.planning.selectedPlan!.result.configuration.routes[0], probe=table(s.root,route.id);
    const columns=all(probe,row=>row.tag==='column-probe'&&!!row.props.field);
    expect(columns.map(row=>row.props.field)).toEqual(['demandId','path','isFeasible']);
    expect(columns.every(row=>row.props.sortable===false)).toBe(true);
    const before=map(s.root).props.selectedId;
    (probe.props.expand as (id:string)=>void)(route.id); await nextTick();
    expect(textOf(s.root)).toContain('总距离 / m'); expect(textOf(s.root)).toContain('瓶颈裕度 / dB');
    expect(map(s.root).props.selectedId).toBe(before);
  });
});
