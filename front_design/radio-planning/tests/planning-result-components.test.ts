import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, toRaw, type App, type Component, type ComponentOptions, type Slots } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import PlanningView from '../src/views/PlanningView.vue';
import PlanningMetricPanel from '../src/components/PlanningMetricPanel.vue';
import AppTable from '../src/components/AppTable.vue';
import { usePlanningStore } from '../src/stores/planning';
import { usePreviewStore } from '../src/stores/preview';
import { createPlanningMock } from '../src/services/planning-mock';
import { createMockService } from '../src/services/mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { initialMeta } from '../src/services/resource-storage';
import resources from '../src/mocks/resources.json';
import type { ResourcesData, Station } from '../src/types/domain';
import { savedRequest, taskMeta } from './helpers/tasks';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

// 执行真实页面、指标与 AppTable 模板；地图和 PrimeVue 宿主用事件探针，不冒充视觉验收。
vi.mock('../src/components/MapCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false,
    props: ['stations', 'links', 'selectedId', 'selectedLinkId', 'highlightStationIds', 'highlightLinkIds', 'mockCoverageDisplay', 'showCoverage'],
    emits: ['select'], setup(props, { emit }) { return () => h('map-probe', { ...props, select: (id: string) => emit('select', id) }); },
  }) };
});
vi.mock('primevue/datatable', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false, props: ['value', 'selection'], emits: ['update:selection'],
    setup(props, { emit }) { return () => h('table-probe', { ...props, select: (row: unknown) => emit('update:selection', row) }); } }) };
});
vi.mock('primevue/column', () => ({ default: { render: () => null } }));
vi.mock('../src/components/AppDrawer.vue', async () => { const { h } = await import('vue'); return { default: { inheritAttrs: false, props: ['visible'], setup: (props: { visible: boolean }, { slots }: { slots: Slots }) => () => props.visible ? h('aside', {}, [slots.default?.(), slots.footer?.()]) : null } }; });
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/TaskWorkspacePanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/PlanExportDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/PlanningProgressPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/PlanComparisonPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));

async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'coverage-render.ts', { loader: 'ts' });
  (component as ComponentOptions).render = new Function('Vue', code + ';return createRender(Vue);')(Vue);
}

interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown;
  readonly options: HostNode[];
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
const textOf = (root: HostNode): string => root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}


await Promise.all([clientTemplate(PlanningView, 'src/views/PlanningView.vue'), clientTemplate(PlanningMetricPanel, 'src/components/PlanningMetricPanel.vue'), clientTemplate(AppTable, 'src/components/AppTable.vue')]);
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
  const storage = new TestStorage(), raw = createMockService(() => storage); let time = Date.parse('2026-10-03T00:00:00Z');
  const service = createPlanningMock(() => storage, () => ({ resources: structuredClone(resources) as ResourcesData, meta: { ...initialMeta(), taskWorkspace: taskMeta(storage) } }), () => time);
  const preset = planningPresets.find(row => row.id === presetId)!;
  const submitted = await service.submitPlanning(await savedRequest(storage, { baseRevision: 'initial', requestId: 'submit', taskId: null, parentPlanVersionId: null, input: structuredClone(preset.input) }));
  time += 20000;
  const saved = await service.savePlanVersion({ baseRevision: submitted.workspace.revision, jobId: submitted.view.job.id, requestId: 'save', name: '联动测试方案', note: '' });
  const preview = usePreviewStore(); preview.data = await raw.loadPreview(); preview.mergePlanning(saved.workspace.plans);
  const planning = usePlanningStore(); planning.workspace = saved.workspace; planning.selectedPlanId = saved.plan.id; planning.step = 2;
  planning.draft = structuredClone(preset.input); planning.baseline = structuredClone(preset.input);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: PlanningView }] });
  await router.push('/'); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  const root = node('root'); app.mount(root); await nextTick();
  return { root, planning, preview, auth, storage, writes: storage.writes, service, jobId: submitted.view.job.id };
}

describe('规划页面实际模板联动', () => {
  it('备用路由整条高亮且行选中，链路行改用双端定位，地图点击替换选择', async () => {
    const s = await mountPlanning(), before = JSON.stringify(s.preview.data);
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
    const s = await mountPlanning();
    await select(s.root, 'ROUTE-3'); await click(s.root, '参数配置');
    expect(map(s.root).props.highlightStationIds).toHaveLength(3);
    await select(s.root, 'DV-0001');
    expect(map(s.root).props.highlightLinkIds).toEqual(['LINK-A']);
    await click(s.root, '清除选择');
    expect(map(s.root).props).toMatchObject({ selectedId: '', selectedLinkId: '', highlightLinkIds: [] });
    expect(table(s.root, 'DV-0001').props.selection).toBeNull();
    await click(s.root, '覆盖结果');
    const control = find(s.root, row => row.props['aria-label'] === '覆盖显示')!;
    (control.props['onUpdate:modelValue'] as (value: string) => void)('contour');
    (map(s.root).props.select as (id: string) => void)('ND-0001'); await nextTick();
    await click(s.root, '清除选择');
    expect(map(s.root).props).toMatchObject({ mockCoverageDisplay: 'contour', showCoverage: true, selectedId: '', selectedLinkId: '' });
    expect(s.storage.writes).toBe(s.writes);
  });
  it('部署定位采用保存输出坐标，不读取当前资源的新坐标', async () => {
    const s = await mountPlanning(), plan = s.planning.selectedPlan!;
    plan.workflow!.configuration.deployment[0].plannedCoordinate = [114.8, 37.8];
    s.preview.data!.resources.stations.find(row => row.id === 'ND-0001')!.coordinate = [120, 30];
    await click(s.root, '中继部署'); await select(s.root, 'ND-0001');
    expect(map(s.root).props.selectedId).toBe('ND-0001');
    expect((map(s.root).props.stations as Station[]).find(row => row.id === 'ND-0001')!.coordinate).toEqual([114.8, 37.8]);
    expect(plan.inputSnapshot.stations.find(row => row.id === 'ND-0001')!.coordinate).not.toEqual([114.8, 37.8]);
  });
  it('频率池和分配行按明确 ID 关联；无关系和不完整关联不保留上次高亮', async () => {
    const s = await mountPlanning(), plan = s.planning.selectedPlan!, configuration = plan.workflow!.configuration;
    plan.resultDetails!.frequencyAssignments = plan.resultDetails!.frequencyAssignments!.filter(row => row.linkId === 'LINK-A');
    const assignment = plan.resultDetails!.frequencyAssignments![0];
    await click(s.root, '通信资源'); await select(s.root, 'hf-full');
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
    const s = await mountPlanning(); await click(s.root, '通信资源');
    const assignment = s.planning.selectedPlan!.resultDetails!.frequencyAssignments![0], oldTable = table(s.root, assignment.id), oldRow = (oldTable.props.value as { id: string }[]).find(row => row.id === assignment.id)!;
    await select(s.root, assignment.id);
    const copy = structuredClone(toRaw(s.planning.selectedPlan!)); copy.id = 'new-frequency-owner'; s.preview.data!.planning.plans.push(copy);
    await s.planning.selectPlan(copy.id); await nextTick();
    // 调用新渲染表格的当前转发器，验证保护不依赖旧 handler 本身。
    (table(s.root, assignment.id).props.select as (row: unknown) => void)(oldRow); await nextTick();
    expect(map(s.root).props.highlightLinkIds).toEqual([]); expect(table(s.root, assignment.id).props.selection).toBeNull();
    await select(s.root, assignment.id); expect(map(s.root).props.highlightLinkIds).toEqual([assignment.linkId]);
    s.planning.selectedPlan!.resultDetails!.frequencyAssignments![0].linkId = 'missing'; await nextTick();
    expect(table(s.root, assignment.id).props.selection).toBeNull(); expect(map(s.root).props.highlightLinkIds).toEqual([]);
    expect(textOf(s.root)).toContain('关联不完整');
  });
  it('参数路由新列直接显示明细，旧版仍保留核心结果并提示缺省', async () => {
    const s = await mountPlanning(), details = s.planning.selectedPlan!.resultDetails!;
    const route = details.routeQuality![0]; route.hopCount = 0; route.reliability = 0; route.isFeasible = false;
    await nextTick();
    const rows = table(s.root, route.routeId).props.value as Record<string, unknown>[];
    expect(rows.find(row => row.id === route.routeId)).toMatchObject({ hopCount: 0, reliability: '0%', isFeasible: '不可行' });
    await click(s.root, '参数配置');
    expect((table(s.root, 'DV-0001').props.value as Record<string, unknown>[])[0]).toMatchObject({ tiltDeg: '未提供', tiltEffective: '未参与' });
    delete s.planning.selectedPlan!.resultDetails; await nextTick();
    expect(textOf(s.root)).toContain('此结果未提供补充明细');
    expect((table(s.root, 'DV-0001').props.value as Record<string, unknown>[])[0]).toMatchObject({ tiltDeg: '未提供', tiltEffective: '未提供' });
    await click(s.root, '通信资源'); await select(s.root, 'hf-full');
    expect(map(s.root).props.highlightLinkIds).toEqual([]); expect(textOf(s.root)).toContain('未提供明确分配关系');
  });
  it('第三步配置快照展示同一冻结明细及空集合，未读取当前输入补值', async () => {
    const s = await mountPlanning(), details = s.planning.selectedPlan!.resultDetails!;
    details.frequencyConflicts = []; details.frequencyGap = { requiredChannels: 353, availableChannels: 48, shortage: 0 }; details.conflictFree = true;
    details.routeQuality = []; s.planning.draft!.demands[0].minReliability = 0.123;
    s.planning.step = 3; await nextTick(); await click(s.root, '查看配置快照');
    const drawer = find(s.root, row => row.tag === 'aside')!, value = textOf(drawer);
    expect(value).toContain('明细版本：'); expect(value).toContain(details.assetVersion);
    expect(value).toContain('天线倾角 / °：未提供'); expect(value).toContain('倾角参与计算：未参与');
    expect(value).toContain('路由质量：没有记录'); expect(value).toContain('可靠性：未提供');
    expect(value).toContain('频率冲突：没有记录'); expect(value).toContain('所需信道：353 · 可用信道：48 · 缺口：0 · 服务结论：明确无冲突');
    expect(value).toContain('未列出不可达需求'); expect(value).not.toContain('12.3%');
    const assignment = details.frequencyAssignments![0];
    expect((table(drawer, assignment.id).props.value as Record<string, unknown>[])[0]).toMatchObject({ linkId: assignment.linkId, frequencyKhz: assignment.frequencyKhz });
    expect(s.storage.writes).toBe(s.writes);
  });
  it('取消版本切换保留选择，实际换版即使复用快照和对象 ID 也清除', async () => {
    const s = await mountPlanning(); await select(s.root, 'ROUTE-3');
    const copy = structuredClone(toRaw(s.planning.selectedPlan!)); copy.id = 'new-owner';
    s.preview.data!.planning.plans.push(copy); s.planning.formDirty = true;
    const pending = s.planning.selectPlan(copy.id); await nextTick();
    expect(s.planning.decision).not.toBeNull(); s.planning.answer('cancel');
    expect(await pending).toBe(false); await nextTick();
    expect(table(s.root, 'ROUTE-3').props.selection).toMatchObject({ id: 'ROUTE-3' });
    s.planning.formDirty = false; await s.planning.selectPlan(copy.id); await nextTick();
    expect(table(s.root, 'ROUTE-3').props.selection).toBeNull();
    expect(map(s.root).props.highlightLinkIds).toEqual(['LINK-A', 'LINK-B', 'LINK-C']);
  });
  it('同版本重读保留选择，权限丢失立即清除并拒绝新事件', async () => {
    const s = await mountPlanning(); await select(s.root, 'ROUTE-3');
    const copy = structuredClone(toRaw(s.planning.selectedPlan!));
    s.preview.mergePlanning([copy]); await nextTick();
    expect(table(s.root, 'ROUTE-3').props.selection).toMatchObject({ id: 'ROUTE-3' });
    s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'planning.view') }); await nextTick();
    await select(s.root, 'ROUTE-3');
    expect(table(s.root, 'ROUTE-3').props.selection).toBeNull();
    expect(map(s.root).props.highlightLinkIds).toEqual([]);
  });
  it('输入地图与结果选择独立，历史快照保留节点链路回退表', async () => {
    const s = await mountPlanning(); await select(s.root, 'ROUTE-3');
    s.planning.step = 1; await nextTick();
    (map(s.root).props.select as (id: string) => void)('ND-0004'); await nextTick();
    s.planning.step = 2; await nextTick();
    expect(map(s.root).props.selectedId).toBe('ND-0001');
    await s.planning.selectPlan('PLAN-V1'); await nextTick();
    expect(textOf(s.root)).toContain('未提供校验结论');
    const id = s.planning.selectedPlan!.links[0].id; await select(s.root, id);
    expect(map(s.root).props.selectedLinkId).toBe(id);
    await click(s.root, '中继部署');
    const stationId = s.planning.selectedPlan!.inputSnapshot.stations[0].id; await select(s.root, stationId);
    expect(map(s.root).props.selectedId).toBe(stationId);
    await click(s.root, '任务快照');
    const device = s.planning.selectedPlan!.inputSnapshot.devices[0]; await select(s.root, device.id);
    expect(map(s.root).props.selectedId).toBe(device.stationId);
  });
  it('指标颜色和文字来自当前结果，参考方案的抗毁性明确未达标', async () => {
    const s = await mountPlanning('constrained');
    const connectivity = find(s.root, row => row.props['data-metric'] === 'connectivity')!;
    const survival = find(s.root, row => row.props['data-metric'] === 'survivability')!;
    const power = find(s.root, row => row.props['data-metric'] === 'power')!;
    expect(connectivity.props.class).toContain('passed'); expect(textOf(connectivity)).toContain('达标');
    expect(survival.props.class).toContain('failed'); expect(textOf(survival)).toContain('82%'); expect(textOf(survival)).toContain('未达标');
    expect(power.props.class).toContain('objective'); expect(textOf(power)).toContain('最小化目标');
    expect(textOf(power)).not.toContain('最优');
  });
});
