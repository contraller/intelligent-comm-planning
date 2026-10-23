import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey, toRaw, type App } from 'vue';
import { clientTemplate } from './helpers/vue-client';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import SituationView from '../src/views/SituationView.vue';
import GisObjectInfoPanel from '../src/components/GisObjectInfoPanel.vue';
import GisResourceTree from '../src/components/GisResourceTree.vue';
import ResourceReadStatus from '../src/components/ResourceReadStatus.vue';
import GisDeviceLayerPanel from '../src/components/GisDeviceLayerPanel.vue';
import GisResultLayerPanel from '../src/components/GisResultLayerPanel.vue';
import DeviceCoveragePanel from '../src/components/DeviceCoveragePanel.vue';
import type { GisDeviceMapFrame } from '../src/maps/gis-device-display';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { useResourceReadStore } from '../src/stores/resource-read';
import { usePreviewStore } from '../src/stores/preview';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useMonitoringStore } from '../src/stores/monitoring';
import { useInterferenceStore } from '../src/stores/interference';
import { useTaskInputStore } from '../src/stores/task-input';
import { useDiagnosisStore } from '../src/stores/diagnosis';
import { useDeviceConfigurationStore } from '../src/stores/device-configuration';
import { demandLayer, linkLayer } from '../src/maps/layers';
import { candidateLinkLayer } from '../src/maps/candidate-link-layers';
import type { InterferenceSource, MapRegion, NetworkLink, Station } from '../src/types/domain';
import type { PlanningDemand } from '../src/types/planning';
import { planningPresets } from '../src/mocks/planning-presets';
import { authorizeStore } from './helpers/auth';
import { bindMonitoring, settleMonitoring } from './helpers/monitoring';
import { interferenceFixture } from './helpers/interference';
import { TestStorage } from './helpers/storage';
import { analysisMap, clickWorkbench, compileWorkbenchTemplates, createWorkbenchFixture, openWorkbenchFromPage, reportHostFailure, settleWorkbench, traceHostErrors, workbenchNode, workbenchText } from './helpers/interference-workbench';

const transport = vi.hoisted(() => ({ mode: 'mock' }));
vi.mock('../src/config/env', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config/env')>();
  return { ...actual, env: { ...actual.env, get mode() { return transport.mode; } } };
});

// 保留真实页面 setup、路由监听和挂载顺序，只替换画布与非入口业务组件。
vi.mock('../src/components/MapCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({
    inheritAttrs: false,
    props: ['frozenNetwork', 'interferenceProjection', 'gisDeviceFrame', 'stations', 'interferences', 'links', 'candidateWorkset', 'demands', 'regions', 'interferenceImpact', 'selectedId', 'selectedLinkId', 'selectedInterferenceId', 'resourceMarkers', 'planningOverlay'],
    setup(props, { expose }) {
      expose({ locate: () => {}, locateResource: () => {} });
      return () => h('map-probe', { ...props });
    },
  }) };
});
vi.mock('../src/components/ObjectInfoPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false, props: ['station', 'selectedDeviceId'],
    setup: props => () => h('device-probe', { ...props }),
  }) };
});
vi.mock('../src/components/DeviceInfoPanel.vue', async () => { const { h } = await import('vue'); return { default: { props: ['device', 'resources', 'detailContext'], setup: (props: any) => () => h('device-probe', { station: props.detailContext?.node, selectedDeviceId: props.device?.id }) } }; });
vi.mock('../src/components/SituationMonitoringDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/MonitoringObjectPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/GisTaskPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceStatusPanel.vue', async () => {
  const { defineComponent } = await import('vue');
  return { default: defineComponent({ setup(_props, { expose }) { expose({ requestLeave: async () => true }); return () => null; } }) };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup: (props, { slots }) => () => props.visible ? h('aside', [slots.default?.(), slots.footer?.()]) : null }) };
});
vi.mock('../src/components/InterferenceSourceDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceExportDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false, props: ['filteredIds', 'selectedIds'],
    setup: props => () => h('export-probe', { ...props }) }) };
});
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/StatusBadge.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));

// Node 下 Vite 生成 SSR 模板；只在本测试编译同一 SFC 的客户端模板，执行真实挂载钩子。
const filename = 'src/views/SituationView.vue';
// 主组件保持本地副本，自定义编译身份和后续子组件处理顺序均保留。
const MountedSituationView = { ...SituationView };
await clientTemplate(MountedSituationView, filename, 'situation-entry-render.ts', { id: 'situation-entry-test' });
// 本批控件也执行客户端模板，仍保留原详情探针核对定位身份。
for (const [component, deviceFile] of [
  [GisObjectInfoPanel, 'src/components/GisObjectInfoPanel.vue'], [GisResourceTree, 'src/components/GisResourceTree.vue'],
  [GisDeviceLayerPanel, 'src/components/GisDeviceLayerPanel.vue'],
  [GisResultLayerPanel, 'src/components/GisResultLayerPanel.vue'],
  [DeviceCoveragePanel, 'src/components/DeviceCoveragePanel.vue'],
  [ResourceReadStatus, 'src/components/ResourceReadStatus.vue'],
] as const) {
  await clientTemplate(component, deviceFile, 'device-entry-render.ts');
}
await compileWorkbenchTemplates();

// 内存宿主实际运行 Vue 挂载/更新/卸载；不模拟浏览器布局或 OpenLayers 点击。
interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown;
  readonly options: HostNode[];
  addEventListener: () => void; removeEventListener: () => void;
  getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({
  tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
  get options() { return this.children.filter(child => child.tag === 'option'); },
  addEventListener: () => {}, removeEventListener: () => {},
  // 原生 v-model 更新时需要根节点的焦点信息；不模拟实际浏览器焦点行为。
  getRootNode: () => document,
});
function remove(child: HostNode) {
  if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
  child.parent = null;
}
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent;
  const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text),
  createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; },
  setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent,
  nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => {
    const el = node('#static', text); insert(el, parent, anchor); return [el, el];
  },
});
function find(root: HostNode, tag: string): HostNode | undefined {
  if (root.tag === tag) return root;
  for (const child of root.children) { const hit = find(child, tag); if (hit) return hit; }
}
const textOf = (root: HostNode): string => root.text + root.children.map(textOf).join('');

// 从实际模板入口更新筛选，避免直接改页面内部响应式变量掩盖绑定错误。
function findWhere(root: HostNode, predicate: (entry: HostNode) => boolean): HostNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const hit = findWhere(child, predicate); if (hit) return hit; }
}
async function click(root: HostNode, label: string) {
  const button = findWhere(root, entry => entry.tag === 'button' && textOf(entry).trim() === label);
  expect(button, `未找到按钮：${label}`).toBeDefined();
  await (button!.props.onClick as () => unknown)();
  await nextTick();
  if (['HF', 'VUHF', '告警', '全部', '按站点浏览', '按设备分类'].includes(label)) { await vi.advanceTimersByTimeAsync(250); await settleMonitoring(); }
}
async function search(root: HostNode, query: string) {
  const input = findWhere(root, entry => entry.props['aria-label'] === '搜索资源')!;
  (input.props.onInput as (event: unknown) => void)({ target: { value: query } });
  await nextTick(); await vi.advanceTimersByTimeAsync(250); await settleMonitoring();
}
function treeIds(root: HostNode) {
  const ids: string[] = [];
  function visit(entry: HostNode) {
    if (entry.tag === 'button' && String(entry.props.class).split(' ').includes('station-item')) {
      const id = textOf(entry).match(/(?:ND|IF)-\d+/)?.[0];
      if (id) ids.push(id);
    }
    entry.children.forEach(visit);
  }
  visit(root); return ids;
}

let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
let waitingFor = '夹具未启动', waitSnapshot: () => unknown = () => null;
afterEach(context => {
  reportHostFailure(context.task, waitingFor, waitSnapshot);
  app?.unmount(); app = undefined;
  if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  waitingFor = '夹具未启动'; waitSnapshot = () => null;
});
async function mountEntry(url: string, editing = false, confirmedNetwork = false, frozen = false) {
  waitingFor = '态势入口夹具准备';
  transport.mode = frozen ? 'http' : 'mock';
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  class TestDocument extends EventTarget { hidden = false; activeElement = null; }
  vi.stubGlobal('Document', TestDocument);
  vi.stubGlobal('document', new TestDocument());
  vi.stubGlobal('ShadowRoot', class {});
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  // 公共浏览与完整上下文使用同一夹具，不把 Preview 注入页面。
  for (const key of ['loadResourceReadContext','queryResourceDevices','queryResourceNodes','queryResourceInterferences','getResourceObject','queryResourceMap','loadGisResourceDirectory','loadGisResourceScene','loadGisResourceEditContext'] as const) vi.spyOn(previewService, key).mockImplementation(raw[key].bind(raw) as never);
  Object.assign(window, { localStorage: storage });
  // 标绘退出用例通过原保存与确认流程准备绑定网络，不手工伪造当前方案。
  if (confirmedNetwork) await interferenceFixture('balanced', storage);
  // 新状态目录沿用本入口测试数据，避免误读真实浏览器会话。
  vi.spyOn(previewService, 'loadDeviceStatusContext').mockImplementation(raw.loadDeviceStatusContext);
  vi.spyOn(previewService, 'loadPreview').mockImplementation(raw.loadPreview);
  vi.spyOn(previewService, 'loadInterferenceWorkspace').mockImplementation(raw.loadInterferenceWorkspace);
  vi.spyOn(previewService, 'getDiagnosisReport').mockImplementation(raw.getDiagnosisReport);
  vi.spyOn(previewService, 'loadDiagnosisContext').mockImplementation(raw.loadDiagnosisContext);
  vi.spyOn(previewService, 'loadDiagnosisSourceOptions').mockImplementation(raw.loadDiagnosisSourceOptions);
  vi.spyOn(previewService, 'saveDiagnosisReceipt').mockImplementation(raw.saveDiagnosisReceipt);
  vi.spyOn(previewService, 'loadDeviceConfigurationContext').mockImplementation(raw.loadDeviceConfigurationContext);
  vi.spyOn(previewService, 'queryDeviceConfigurationOperations').mockImplementation(raw.queryDeviceConfigurationOperations);
  vi.spyOn(previewService, 'saveResourceChanges').mockImplementation(raw.saveResourceChanges);
  for(const name of ['queryDiagnosisScenarios','queryDiagnosisHistory','getDiagnosisSource','getDiagnosisVersion','getDiagnosisPreset','queryTaskSummaries'] as const)vi.spyOn(previewService,name).mockImplementation(raw[name] as never);
  bindMonitoring(raw); vi.spyOn(previewService,'getMonitoringObservation').mockImplementation(raw.getMonitoringObservation); await usePreviewStore().load(); await useResourceReadStore().activate('gis'); await useGisWorkspaceStore().loadScene();
  const gis = useGisWorkspaceStore(), editor = useResourceEditStore();
  // 浏览预期直接取同版本目录；不借用编辑草稿，也不提前加载完整编辑基线。
  const browseResources = (await raw.loadGisResourceDirectory({ context: 'gis', revision: gis.scene!.revision })).resources;
  if (editing) {
    await gis.begin(); await editor.openForm('device', 'DV-0001');
    editor.form!.fields.antennaHeightM = '19';
  }
  const before = [...storage.entries];
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/situation', component: MountedSituationView },
    { path: '/planning', component: { render: () => null } },
  ] });
  const wb = await createWorkbenchFixture(); wb.bind();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router);
  app.provide(ssrContextKey, {});
  traceHostErrors(app);
  waitSnapshot = () => { const read = useResourceReadStore(); return { route: router.currentRoute.value.fullPath,
    mode: gis.mapMode, gisBusy: gis.busy, saveState: gis.saveState, editorBusy: editor.busy, editorDecision: editor.decision,
    formDirty: editor.formDirty, resourceDirty: editor.dirty, editorError: editor.error,
    refreshing: read.refreshing, readPending: read.pending, readErrors: read.errors }; };
  waitingFor = '态势入口router.push'; await router.push(url); await router.isReady();
  const root = node('root'); app.mount(root); await settleMonitoring(); await nextTick();
  // 原有节点口径场景显式进入站点浏览；设备分类默认入口由专项测试覆盖。
  await click(root, '按站点浏览'); await vi.advanceTimersByTimeAsync(250); await settleMonitoring();
  waitingFor = '态势入口用例主体';
  expect([...storage.entries]).toEqual(before);
  return { root, gis, editor, browseResources, router, storage, before, raw, monitor: useMonitoringStore(), map: () => find(root, 'map-probe')!.props, wb };
}

describe('GIS 入口挂载联动', () => {
  it('轻目录只在进入和刷新读取，正常无技术横栏，失败保留目录并可重试', async () => {
    const s = await mountEntry('/situation');
    expect(previewService.loadGisResourceDirectory).toHaveBeenCalledTimes(1);
    expect(previewService.queryResourceDevices).not.toHaveBeenCalled(); expect(previewService.loadGisResourceEditContext).not.toHaveBeenCalled();
    await search(s.root, 'DV-0033'); expect(previewService.loadGisResourceDirectory).toHaveBeenCalledTimes(1);
    expect(findWhere(s.root, row => String(row.props.class).includes('read-status'))).toBeUndefined();
    vi.mocked(previewService.loadGisResourceDirectory).mockRejectedValueOnce(new Error('目录暂时不可用'));
    await click(s.root, '刷新资源'); await settleMonitoring();
    expect(textOf(s.root)).toContain('目录暂时不可用'); expect(textOf(s.root)).toContain('DV-0033');
    await click(s.root, '刷新资源'); await settleMonitoring();
    expect(textOf(s.root)).not.toContain('目录暂时不可用');
    expect(findWhere(s.root, row => String(row.props.class).includes('read-status'))).toBeUndefined();
  });
  // 默认不占用详情栏，但明确选择对象仍通过原监控联动展开。
  it('普通入口收起右侧详情，选择监控设备后显示对应面板', async () => {
    const s = await mountEntry('/situation');
    const detail = () => findWhere(s.root, row => String(row.props.class).includes('situation-right'));
    expect(detail()).toBeUndefined(); expect(s.monitor.open).toBe(true);
    // 恢复入口归属右侧工作区，保留可见短标签和明确的无障碍名称。
    const restore = findWhere(s.root, row => row.props['aria-label'] === '展开详情面板')!;
    expect(String(restore.props.class)).toContain('detail-restore');
    expect(restore.props['aria-expanded']).toBe(false); expect(restore.props['aria-controls']).toBe('gis-detail-panel');
    s.monitor.selectDevice('DV-0001'); await settleMonitoring(); await nextTick();
    expect(detail()).toBeDefined(); expect(textOf(detail()!)).toContain('监控详情');
    expect(s.monitor.selectedDeviceId).toBe('DV-0001'); expect(s.storage.writes).toBe(0);
  });
  it('窄窗口切回资源面板仅收起详情，不清空选择和未保存表单', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    Object.assign(window, { matchMedia: () => ({ matches: true }) });
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001');
    s.editor.form!.fields.antennaHeightM = '19';
    const before = JSON.stringify(s.editor.form), selected = s.map().selectedId;
    const resourceRestore = findWhere(s.root, row => row.props['aria-label'] === '展开资源面板')!;
    expect(String(resourceRestore.props.class)).toContain('resource-restore');
    expect(resourceRestore.props['aria-controls']).toBe('gis-resource-panel');
    await click(s.root, '资源');
    expect(findWhere(s.root, row => String(row.props.class).includes('situation-right'))).toBeUndefined();
    expect(s.map().selectedId).toBe(selected); expect(JSON.stringify(s.editor.form)).toBe(before);
    await click(s.root, '详情');
    expect(findWhere(s.root, row => row.props['aria-label'] === '展开详情面板')).toBeUndefined();
    expect(findWhere(s.root, row => String(row.props.class).includes('situation-right'))).toBeDefined();
    expect(JSON.stringify(s.editor.form)).toBe(before); expect(s.editor.formDirty).toBe(true);
    expect(s.storage.writes).toBe(0);
  });
  it.each(['/situation', '/situation?stationId=ND-0001', '/situation?diagnosisId=DG-HW'])(
    '没有分析记录时，%s 的冻结入口隔离原快照但不伪造分析结果', async url => {
      const s = await mountEntry(url, false, false, true), analysis = useInterferenceStore(), originalMode = s.gis.mapMode;
      s.wb.context.run_count = 0;
      s.wb.workbench.listRuns.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 20 });
      const submit = vi.spyOn(previewService, 'submitInterferenceAnalysis');
      expect(analysis.selected).toBeNull();
      await click(s.root, '干扰分析'); await settleMonitoring();
      expect(workbenchNode(s.root, row => row.props['aria-label'] === '数据库冻结方案')).toBeDefined();
      expect(workbenchNode(s.root, row => row.tag === 'map-probe' && !!row.props.resourceMarkers)).toBeUndefined();
      expect(s.gis.mapMode).toBe(originalMode); expect(analysis.selected).toBeNull(); expect(analysis.mapProjection).toBeNull();
      expect(s.wb.workbench.getRun).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled(); s.wb.assertNoWrites(); expect(s.storage.writes).toBe(0);
    });
  it('已有分析记录时从监控切到选定快照，不自动重新分析', async () => {
    const s = await mountEntry('/situation', false, false, true);s.monitor.showNetwork();
    const analysis = await openWorkbenchFromPage(s.root, s.wb);
    expect(analysisMap(s.root).interferenceProjection).toEqual(analysis.mapProjection);
    expect(analysisMap(s.root).gisDeviceFrame).toBeUndefined();expect(textOf(s.root)).toContain(s.wb.run.run_id);
    expect(s.wb.workbench.listRuns).toHaveBeenCalledWith(expect.objectContaining({task_id:s.wb.target.taskId}),expect.any(AbortSignal));
    s.wb.assertNoWrites();expect(s.storage.writes).toBe(0);
  });
  it('取消进入冻结分析保留未应用的 GIS 表单', async () => {
    const s = await mountEntry('/situation', true, false, true), before = JSON.stringify(s.editor.form);
    const entering = clickWorkbench(s.root, '干扰分析'); await settleWorkbench();
    expect(s.editor.decision).not.toBeNull(); s.editor.answer('cancel'); await entering;
    expect(workbenchNode(s.root, row => row.props['aria-label'] === '数据库冻结方案')).toBeUndefined();
    expect(JSON.stringify(s.editor.form)).toBe(before); expect(s.editor.formDirty).toBe(true);
    s.wb.assertNoWrites(); expect(s.storage.writes).toBe(0);
  });
  it('保留已选资源链路时，切回分析不会被资源详情监听覆盖', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001', false, false, true);
    await search(s.root, 'PL-001');
    const link = findWhere(s.root, row => row.props['aria-label'] === '选择链路 PL-001')!;
    await (link.props.onClick as Function)(); await settleMonitoring();
    s.monitor.showNetwork(); await settleMonitoring();
    const originalMode = s.gis.mapMode;
    await click(s.root, '干扰分析'); await settleMonitoring();
    expect(workbenchNode(s.root, row => row.props['aria-label'] === '数据库冻结方案')).toBeDefined();
    expect(workbenchNode(s.root, row => row.tag === 'map-probe' && !!row.props.resourceMarkers)).toBeUndefined();
    expect(s.gis.mapMode).toBe(originalMode);
    await clickWorkbench(s.root, '返回当前资源'); await click(s.root, '资源树');
    expect(s.map().selectedLinkId).toBe('PL-001'); s.wb.assertNoWrites(); expect(s.storage.writes).toBe(0);
  });
  // 只核对实际模板中的来源说明，切换展示不产生业务保存。
  it('来源标识跟随资源和监控视图，缺少资源版本时明确提示', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const label = () => textOf(findWhere(s.root, n => n.props['aria-label'] === '当前视图数据来源')!);
    const read = useResourceReadStore(), revision = read.workspace!.revision;
    expect(label()).toBe('资源 · ' + revision);
    s.monitor.showNetwork(); await settleMonitoring(); expect(label()).toBe('监控网络 · 参考网络');
    await click(s.root, '资源树'); expect(label()).toBe('资源 · ' + revision);
    // 模拟来源元数据缺失，验证提示不会沿用另一视图的身份。
    Object.assign(read.workspace!, { revision: null }); await nextTick(); expect(label()).toBe('资源 · 版本未提供');
    expect(s.storage.writes).toBe(0);
  });
  it('诊断来源只显示已取得报告，目标不存在时不冒充已有结果', async () => {
    const s = await mountEntry('/situation?diagnosisId=DG-HW');
    const label = () => textOf(findWhere(s.root, n => n.props['aria-label'] === '当前视图数据来源')!);
    expect(label()).toBe('诊断 DG-HW');
    await s.router.push('/situation?diagnosisId=DG-missing'); await settleMonitoring();
    expect(label()).toBe('诊断 结果未提供'); expect(s.storage.writes).toBe(0);
  });
  it('普通入口默认资源图，观测独立加载；明确查看网络才切源', async () => {
    const s = await mountEntry('/situation');
    expect(s.gis.mapMode).toBe('resource');expect(s.map().resourceMarkers).toBe(true);
    expect((s.map().gisDeviceFrame as GisDeviceMapFrame).points).toHaveLength(414);
    expect(s.monitor.network?.kind).toBe('DEMO');expect(s.monitor.networkState.index).toBe(0);
    s.monitor.tab='links';await nextTick();expect(s.gis.mapMode).toBe('resource');
    s.monitor.showNetwork();await nextTick();expect(s.gis.mapMode).toBe('monitoring');
    await click(s.root,'资源树');expect(s.gis.mapMode).toBe('resource');expect(s.storage.writes).toBe(0);
  });
  it.each(['/situation', '/situation?diagnosisId=DG-HW'])(
    '%s 的图层和侧栏恢复不换来源，资源树明确返回且保留深链', async url => {
      const s = await mountEntry(url), mode = s.gis.mapMode, query = { ...s.router.currentRoute.value.query };
      const network = JSON.stringify([s.map().stations, s.map().links]);
      expect(findWhere(s.root, n => n.tag === 'button' && textOf(n).trim() === '返回资源浏览')).toBeUndefined();
      await click(s.root, '图层管理'); expect(s.gis.mapMode).toBe(mode);
      Object.assign(window, { matchMedia: () => ({ matches: true }) });
      const collapse = findWhere(s.root, n => n.props['aria-label'] === '收起资源面板')!;
      await (collapse.props.onClick as () => unknown)(); await nextTick();
      await click(s.root, '资源'); expect(s.gis.mapMode).toBe(mode);
      expect(JSON.stringify([s.map().stations, s.map().links])).toBe(network);
      await click(s.root, '资源树'); expect(s.gis.mapMode).toBe('resource'); expect(s.map().resourceMarkers).toBe(true);
      expect(s.router.currentRoute.value.query).toEqual(query);
      // 资源树已经高亮时仍可明确返回；监控选择和底部重新接管不被这次切换清空。
      s.monitor.showNetwork(); await settleMonitoring(); expect(s.gis.mapMode).toBe('monitoring');
      await click(s.root, '资源树'); expect(s.gis.mapMode).toBe('resource'); expect(s.storage.writes).toBe(0);
    },
  );
  it('进入冻结干扰前必须处理 GIS 输入；取消不丢表单，返回当前资源不改冻结身份', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001', true, false, true), form = JSON.stringify(s.editor.form);
    const enter=clickWorkbench(s.root,'干扰分析');await settleWorkbench();
    expect(s.editor.decision).not.toBeNull();s.editor.answer('cancel');await enter;
    expect(JSON.stringify(s.editor.form)).toBe(form);expect(s.editor.formDirty).toBe(true);
    expect(workbenchNode(s.root,row=>row.props['aria-label']==='数据库冻结方案')).toBeUndefined();s.wb.assertNoWrites();
    // 明确放弃以后才进入；不能以直接改 store 模式绕过原离开决定。
    const next=clickWorkbench(s.root,'干扰分析');await settleWorkbench();s.editor.answer('discard');await next;
    await clickWorkbench(s.root,'打开冻结网络');
    await clickWorkbench(s.root,row=>workbenchText(row).trim().startsWith('历史 '));
    await clickWorkbench(s.root,row=>String(row.props.class).includes('history-row'));
    const analysis=useInterferenceStore(),frozen=JSON.stringify(analysis.selected);
    await clickWorkbench(s.root,'返回当前资源');expect(s.gis.mapMode).toBe('resource');expect(JSON.stringify(analysis.selected)).toBe(frozen);
    expect(s.storage.writes).toBe(0);s.wb.assertNoWrites();
  });
  it.each(['顶部按钮', '同页 URL'])(
    '%s 进入故障标绘时配置或资源取消都保留路由与原输入', async entry => {
      const s = await mountEntry('/situation?stationId=ND-0001', true), configuration = useDeviceConfigurationStore();
      await configuration.open('gis', 'DV-0001', true); configuration.power = '50';
      const form = JSON.stringify(s.editor.form), original = s.router.currentRoute.value.fullPath;
      const enter = () => entry === '顶部按钮' ? click(s.root, '故障标绘') : s.router.push('/situation?faultEdit=1');
      let navigation = enter(); await settleMonitoring(); expect(configuration.decision).not.toBeNull();
      expect(s.editor.decision).toBeNull(); configuration.answer('cancel'); await navigation;
      expect(s.router.currentRoute.value.fullPath).toBe(original); expect(configuration.power).toBe('50');
      expect(JSON.stringify(s.editor.form)).toBe(form);
      navigation = enter(); await settleMonitoring(); configuration.answer('discard'); await settleMonitoring();
      expect(s.editor.decision).not.toBeNull(); s.editor.answer('cancel'); await navigation;
      expect(s.router.currentRoute.value.fullPath).toBe(original); expect(configuration.visible).toBe(true);
      expect(configuration.power).toBe('50'); expect(JSON.stringify(s.editor.form)).toBe(form);
      navigation = enter(); await settleMonitoring(); configuration.answer('discard'); await settleMonitoring();
      s.editor.answer('discard'); await navigation; await settleMonitoring();
      expect(s.router.currentRoute.value.query).toEqual({ faultEdit: '1' }); expect(configuration.visible).toBe(false);
      expect(s.editor.context).toBeNull(); expect(previewService.saveResourceChanges).not.toHaveBeenCalled();
    },
  );
  it.each(['顶部按钮', '同页 URL'])(
    '%s 进入标绘前保存失败保留现场，重试成功只提交一次且不重复决策', async entry => {
      const s = await mountEntry('/situation?stationId=ND-0001', true), form = JSON.stringify(s.editor.form);
      const original = s.router.currentRoute.value.fullPath;
      const enter = () => entry === '顶部按钮' ? click(s.root, '故障标绘') : s.router.push('/situation?faultEdit=1');
      vi.mocked(previewService.saveResourceChanges).mockRejectedValueOnce(new Error('资源保存失败'));
      let navigation = enter(); await settleMonitoring(); expect(s.editor.decision).not.toBeNull();
      s.editor.answer('save'); await navigation;
      expect(s.router.currentRoute.value.fullPath).toBe(original); expect(JSON.stringify(s.editor.form)).toBe(form);
      expect(s.editor.error).toContain('资源保存失败'); expect(previewService.saveResourceChanges).toHaveBeenCalledTimes(1);
      navigation = enter(); await settleMonitoring(); expect(s.editor.decision).not.toBeNull();
      s.editor.answer('save'); await navigation; await settleMonitoring();
      expect(s.router.currentRoute.value.query).toEqual({ faultEdit: '1' }); expect(s.editor.context).toBeNull();
      expect(s.editor.decision).toBeNull(); expect(previewService.saveResourceChanges).toHaveBeenCalledTimes(2);
      expect((await createMockService(()=>s.storage).loadPreview()).resources.devices.find(row => row.id === 'DV-0001')!.antennaHeightM).toBe(19);
    },
  );
  it('仅故障标绘保留顶部返回，旧资源页签不能退出，取消或保存失败保留后明确放弃才退出', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001', false, true);
    const oldTab = findWhere(s.root, n => n.tag === 'button' && textOf(n).trim() === '资源树')!.props.onClick as () => unknown;
    const previousOpen = s.monitor.open; await click(s.root, '故障标绘'); await settleMonitoring();
    const diagnosis = useDiagnosisStore(); expect(diagnosis.draft).not.toBeNull();
    const draft = JSON.stringify(diagnosis.draft);
    expect(findWhere(s.root, n => n.tag === 'button' && textOf(n).trim() === '资源树')).toBeUndefined();
    expect(findWhere(s.root, n => n.tag === 'button' && textOf(n).trim() === '返回资源浏览')).toBeDefined();
    expect(s.monitor.open).toBe(false); await oldTab(); await settleMonitoring();
    expect(s.router.currentRoute.value.query.faultEdit).toBe('1'); expect(diagnosis.decision).toBeNull();
    let leaving = click(s.root, '返回资源浏览'); await settleMonitoring(); diagnosis.answer('cancel'); await leaving;
    expect(s.router.currentRoute.value.query.faultEdit).toBe('1'); expect(JSON.stringify(diagnosis.draft)).toBe(draft);
    vi.mocked(previewService.saveDiagnosisReceipt).mockRejectedValueOnce(new Error('场景保存失败'));
    leaving = click(s.root, '返回资源浏览'); await settleMonitoring(); diagnosis.answer('save'); await leaving;
    expect(s.router.currentRoute.value.query.faultEdit).toBe('1'); expect(JSON.stringify(diagnosis.draft)).toBe(draft);
    expect(diagnosis.error).toBe('场景保存失败');
    leaving = click(s.root, '返回资源浏览'); await settleMonitoring(); diagnosis.answer('discard'); await leaving;
    expect(s.router.currentRoute.value.query).toEqual({}); expect(s.gis.mapMode).toBe('resource');
    expect(s.monitor.open).toBe(previousOpen); expect(previewService.saveDiagnosisReceipt).toHaveBeenCalledTimes(1);
  });
  it('节点定位不被挂载后的默认监控覆盖，仍可手动切换监控', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    expect(s.gis.mapMode).toBe('resource'); expect(s.map()).toMatchObject({ selectedId: 'ND-0001', resourceMarkers: true });
    s.monitor.showNetwork(); await settleMonitoring();
    expect(s.gis.mapMode).toBe('monitoring'); expect(s.map().resourceMarkers).toBe(false);
  });
  it('设备定位保留所属节点和设备详情', async () => {
    const s = await mountEntry('/situation?stationId=ND-0003&deviceId=DV-0027');
    expect(s.gis.mapMode).toBe('resource'); expect(s.map().selectedId).toBe('ND-0003');
    expect(find(s.root, 'device-probe')?.props.selectedDeviceId).toBe('DV-0027');
  });
  it('干扰源定位保留资源地图和对应详情', async () => {
    const s = await mountEntry('/situation?interferenceId=IF-0008');
    expect(s.gis.mapMode).toBe('resource'); expect(s.map()).toMatchObject({ selectedInterferenceId: 'IF-0008', resourceMarkers: true });
    expect(useResourceReadStore().detail?.object).toMatchObject({kind:'interference',id:'IF-0008'});
  });
  it.each([
    ['stationId=ND-missing', '地图定位失败'],
    ['stationId=', '地图定位失败'],
    ['deviceId=DV-0001', '地图定位失败'],
    ['stationId=ND-0001&deviceId=DV-0027', '地图定位失败'],
    ['stationId=ND-0001&stationId=ND-0003', '地图定位失败'],
    ['interferenceId=IF-0008&stationId=ND-0001', '地图定位参数无效'],
  ])('无效定位 %s 保留原错误提示，不自动进入监控', async (query, message) => {
    const s = await mountEntry('/situation?' + query);
    expect(textOf(s.root)).toContain(message); expect(s.gis.mapMode).toBe('resource');
  });
  it('已有 GIS 编辑状态及未应用表单保持不变', async () => {
    const s = await mountEntry('/situation', true);
    expect(s.gis.mapMode).toBe('resource'); expect(s.editor.context).toBe('gis');
    expect(s.editor.form!.fields.antennaHeightM).toBe('19'); expect(s.editor.formDirty).toBe(true);
  });
  // 同页任务深链必须尊重当前资源表单及导入的取消决定。
  it.each(['form', 'import'])('任务深链取消 %s 决策时保留地图、路由与资源输入', async kind => {
    const s = await mountEntry('/situation', true), before = JSON.stringify(s.editor.form);
    vi.spyOn(s.editor, 'closeForm').mockResolvedValue(kind !== 'form');
    const closeImport = vi.spyOn(s.editor, 'closeImport').mockResolvedValue(false);
    await s.router.push('/situation?taskId=TASK-OTHER'); await settleMonitoring();
    expect(s.router.currentRoute.value.fullPath).toBe('/situation');
    expect(s.gis.mapMode).toBe('resource'); expect(JSON.stringify(s.editor.form)).toBe(before);
    expect(s.editor.formDirty).toBe(true); expect(s.storage.writes).toBe(0);
    if (kind === 'form') expect(closeImport).not.toHaveBeenCalled();
    else expect(closeImport).toHaveBeenCalledOnce();
  });
});

// 跨页定位仍先完成身份/归属与未保存确认，频率条件只影响设备实例层。
describe('GIS 频率条件与跨页定位', () => {
  const frame = (s: Awaited<ReturnType<typeof mountEntry>>) => s.map().gisDeviceFrame as GisDeviceMapFrame | undefined;
  const control = (root: HostNode, label: string) => findWhere(root, row => row.props['aria-label'] === label)!;
  async function input(root: HostNode, label: string, value: string) {
    const el = control(root, label); (el.props[el.tag === 'select' ? 'onChange' : 'onInput'] as Function)({ target: { value } }); await nextTick();
  }
  async function apply(root: HostNode) {
    (control(root, 'GIS 设备频率筛选').props.onSubmit as Function)({ preventDefault() {} }); await nextTick();
  }
  async function filter(root: HostNode) {
    await click(root, '图层管理'); await input(root, 'GIS 频率筛选依据', 'DEVICE'); await input(root, 'GIS 频率下限（kHz）', '6000'); await apply(root);
  }
  it('有效设备定位解除阻挡并保留待应用输入，站点和导出范围未被频率改变', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001&deviceId=DV-0001');
    const outside = JSON.stringify([s.map().stations, s.map().links, s.map().candidateLinks, s.map().demands, s.map().interferences, s.map().regions, find(s.root, 'export-probe')!.props]);
    await filter(s.root); expect(frame(s)!.points).toEqual([]);
    expect(JSON.stringify([s.map().stations, s.map().links, s.map().candidateLinks, s.map().demands, s.map().interferences, s.map().regions, find(s.root, 'export-probe')!.props])).toBe(outside);
    await input(s.root, 'GIS 频率下限（kHz）', '7000');
    await s.router.push('/situation?stationId=ND-0001&deviceId=DV-0002'); await settleMonitoring();
    expect(frame(s)!.points.some(row => row.id === 'DV-0002')).toBe(true);
    expect(control(s.root, 'GIS 频率下限（kHz）').props.value).toBe('7000'); expect(textOf(s.root)).toContain('解除频率限制');
    expect(find(s.root, 'device-probe')!.props.selectedDeviceId).toBe('DV-0002'); expect(s.storage.writes).toBe(0);
  });
  it('错误归属和取消跨页定位不清频率条件、详情或未保存输入', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001&deviceId=DV-0001'); await filter(s.root);
    await s.router.push('/situation?stationId=ND-0003&deviceId=DV-0001'); await settleMonitoring();
    expect(frame(s)!.points).toEqual([]); expect(textOf(s.root)).toContain('地图定位失败');
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001'); s.editor.form!.fields.workFreqKhz = '6000';
    const form = JSON.stringify(s.editor.form); await s.router.push('/situation?stationId=ND-0001&deviceId=DV-0002'); await settleMonitoring();
    expect(s.editor.decision).not.toBeNull(); s.editor.answer('cancel'); await settleMonitoring();
    expect(frame(s)!.points).toEqual([]); expect(JSON.stringify(s.editor.form)).toBe(form);
    expect(control(s.root, 'GIS 频率下限（kHz）').props.value).toBe('6000'); expect(textOf(s.root)).not.toContain('解除频率限制');
  });
  it('新挂载恢复资源图与默认频率条件', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001&deviceId=DV-0001'); await filter(s.root);
    await s.router.push('/planning'); await nextTick(); await s.router.push('/situation'); await settleMonitoring();
    expect(s.gis.mapMode).toBe('resource');expect(frame(s)!.points).toHaveLength(414);
    await click(s.root, '图层管理');expect(control(s.root, 'GIS 频率筛选依据').props.disabled).toBeFalsy();
    expect(control(s.root, 'GIS 频率筛选依据').props.value).toBe('ALL');
    await click(s.root, '资源树'); expect(frame(s)!.points).toHaveLength(414); expect(s.storage.writes).toBe(0);
  });
});

// 真实目录组件与导出探针共用页面结果，避免仅验证纯函数却遗漏绑定。
describe('GIS 资源目录新增检索入口', () => {
  const frame = (s: Awaited<ReturnType<typeof mountEntry>>) => s.map().gisDeviceFrame as GisDeviceMapFrame;
  const exported = (s: Awaited<ReturnType<typeof mountEntry>>) => find(s.root, 'export-probe')!.props.filteredIds;
  it('搜索其他节点的设备自动展开但不选中；显式选择设置精确设备和父节点', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    await search(s.root, ' dv-0027 ');
    expect(treeIds(s.root)).toEqual(['ND-0003']); expect(frame(s).points.map(row => row.id)).toEqual(['DV-0027']);
    expect(s.map().selectedId).toBe('ND-0001'); expect(find(s.root, 'device-probe')!.props.selectedDeviceId).toBe('');
    const button = findWhere(s.root, row => row.props['aria-label'] === '选择设备 DV-0027')!;
    expect(button).toBeDefined(); (button.props.onClick as Function)(); await settleMonitoring();
    expect(s.map().selectedId).toBe('ND-0003'); expect(find(s.root, 'device-probe')!.props.selectedDeviceId).toBe('DV-0027');
    expect(exported(s)).toEqual({ nodes: ['ND-0003'], devices: ['DV-0027'], interference_sources: [] });
    expect(findWhere(s.root, row => row.props['aria-label'] === '搜索资源')!.props.value).toBe(' dv-0027 ');
    expect(s.storage.writes).toBe(0);
  });
  it('链路搜索只显示命中链路和两端必要设备，导出沿用资源格式', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    await search(s.root, 'pl-001');
    expect((s.map().links as NetworkLink[]).map(row => row.id)).toEqual(['PL-001']);
    expect(treeIds(s.root)).toEqual(['ND-0001', 'ND-0003']); expect(frame(s).points.map(row => row.id)).toEqual(['DV-0001', 'DV-0027']);
    expect(findWhere(s.root, row => row.props['aria-label'] === '选择链路 PL-001')).toBeDefined();
    expect(findWhere(s.root, row => row.props['aria-label'] === '选择链路 PL-002')).toBeUndefined();
    expect(exported(s)).toEqual({ nodes: ['ND-0001', 'ND-0003'], devices: ['DV-0001', 'DV-0027'], interference_sources: [] });
  });
  it('跨页设备定位保留仍匹配的设备搜索，只解除阻挡目标的节点条件', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001'), device = s.browseResources.devices.find(row => {
      const parent = s.browseResources.stations.find(station => station.id === row.stationId);
      return parent && !parent.alert && parent.id !== 'ND-0001';
    })!;
    await search(s.root, device.id); await click(s.root, '告警');
    expect(frame(s).points).toEqual([]);
    await s.router.push({ path: '/situation', query: { stationId: device.stationId, deviceId: device.id } }); await settleMonitoring();
    expect(frame(s).points.map(row => row.id)).toEqual([device.id]);
    expect(findWhere(s.root, row => row.props['aria-label'] === '搜索资源')!.props.value).toBe(device.id);
    expect(find(s.root, 'device-probe')!.props.selectedDeviceId).toBe(device.id);
  });
  it('已选设备被另一台设备搜索隐藏时保留详情，不扩大匹配结果', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001&deviceId=DV-0001'); await search(s.root, 'DV-0002');
    expect(frame(s).points.map(row => row.id)).toEqual(['DV-0002']); expect(frame(s).selectedDeviceId).toBe('DV-0001');
    expect(textOf(s.root)).toContain('当前选中对象不在筛选结果中');
    expect(find(s.root, 'device-probe')!.props.selectedDeviceId).toBe('DV-0001');
    await click(s.root, '清除筛选'); expect(frame(s).points).toHaveLength(414); expect(frame(s).selectedDeviceId).toBe('DV-0001');
  });
  it('搜索设备不裁剪监控网络；明确选择后才切回资源地图', async () => {
    const s = await mountEntry('/situation');s.monitor.showNetwork();await nextTick();
    const network=JSON.stringify([s.map().stations,s.map().links]);
    await search(s.root, 'DV-0027'); expect(s.gis.mapMode).toBe('monitoring');
    expect(JSON.stringify([s.map().stations, s.map().links])).toBe(network);
    const button = findWhere(s.root, row => row.props['aria-label'] === '选择设备 DV-0027')!;
    (button.props.onClick as Function)(); await settleMonitoring();
    expect(s.gis.mapMode).toBe('resource'); expect(frame(s).points.map(row => row.id)).toEqual(['DV-0027']);
    expect(s.map().selectedId).toBe('ND-0003'); expect(s.storage.writes).toBe(0);
  });
});

describe('设备显示与既有 GIS 定位/节点筛选衔接', () => {
  const frame = (s: Awaited<ReturnType<typeof mountEntry>>) => s.map().gisDeviceFrame as GisDeviceMapFrame | undefined;
  async function change(root: HostNode, label: string, value: boolean | string, event = 'onChange') {
    const target = findWhere(root, row => row.props['aria-label'] === label)!;
    expect(target, label).toBeDefined(); (target.props[event] as (e: unknown) => void)({ target: { value, checked: value } }); await nextTick();
  }
  it('节点能力和告警条件保持原口径，设备只显示这些节点中的匹配成员', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    await click(s.root, 'HF'); const nodes = s.map().stations as Station[], ids = new Set(nodes.map(row => row.id));
    expect(frame(s)!.points.every(row => ids.has(row.stationId))).toBe(true);
    // 双频站仍包含 VUHF 设备，节点能力条件不冒充设备类型条件。
    expect(frame(s)!.points.some(row => row.deviceClass === 'VUHF')).toBe(true);
    await click(s.root, '图层管理'); await change(s.root, '显示VUHF设备', false);
    expect(s.map().stations).toEqual(nodes); expect(frame(s)!.points.every(row => row.deviceClass === 'HF')).toBe(true);
    await click(s.root, '资源树'); await search(s.root, '不存在'); expect(frame(s)!.points).toEqual([]);
    await click(s.root, '清除筛选'); expect(frame(s)!.points.every(row => row.deviceClass === 'HF')).toBe(true);
  });
  it('有效显式设备定位仅解除目标类型和状态阻挡，其他图层偏好保留', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001&deviceId=DV-0001'); await click(s.root, '图层管理');
    await change(s.root, '显示HF设备', false); await change(s.root, 'HF设备透明度', '0', 'onInput');
    await change(s.root, '显示VUHF设备', false); await change(s.root, '设备点位状态', 'FAULT');
    await s.router.push('/situation?stationId=ND-0001&deviceId=DV-0002'); await settleMonitoring();
    expect(frame(s)!.settings.HF).toEqual({ visible: true, opacity: 1 }); expect(frame(s)!.settings.VUHF.visible).toBe(false);
    expect(frame(s)!.points.some(row => row.id === 'DV-0002')).toBe(true);
    expect(find(s.root, 'device-probe')!.props.selectedDeviceId).toBe('DV-0002'); expect(s.storage.writes).toBe(0);
  });
  it('错误归属及取消设备定位保留设备显示条件和未保存表单', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001', true), form = JSON.stringify(s.editor.form);
    await click(s.root, '图层管理'); await change(s.root, '显示HF设备', false); await change(s.root, 'HF设备透明度', '0.3', 'onInput');
    await s.router.push('/situation?stationId=ND-0003&deviceId=DV-0001'); await settleMonitoring();
    expect(frame(s)!.settings.HF).toEqual({ visible: false, opacity: 0.3 }); expect(textOf(s.root)).toContain('地图定位失败');
    vi.spyOn(s.editor, 'closeForm').mockResolvedValue(false);
    await s.router.push('/situation?stationId=ND-0001&deviceId=DV-0002'); await settleMonitoring();
    expect(frame(s)!.settings.HF).toEqual({ visible: false, opacity: 0.3 }); expect(JSON.stringify(s.editor.form)).toBe(form);
  });
  it('默认资源图的设备显示可直接操作，返回资源树保留显示偏好', async () => {
    const s=await mountEntry('/situation');expect(s.gis.mapMode).toBe('resource');expect(frame(s)!.points).toHaveLength(414);
    await click(s.root,'图层管理');await change(s.root,'显示HF设备',false);
    expect(frame(s)!.settings.HF.visible).toBe(false);
    await click(s.root,'资源树');expect(frame(s)!.settings.HF.visible).toBe(false);
  });
});

describe('GIS 资源筛选与地图联动', () => {
  it.each(['编号', '名称'])('按节点%s搜索时地图与资源树一致，覆盖区域及资源数据保持完整', async kind => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const original = JSON.stringify(s.gis.scene!.map), target = s.browseResources.stations[0];
    const regions = s.map().regions as MapRegion[];
    await search(s.root, kind === '编号' ? target.id.toLowerCase() : target.name);
    const visible = s.map().stations as Station[];
    expect(visible.map(row => row.id)).toEqual([target.id]);
    expect(treeIds(s.root).filter(id => id.startsWith('ND-'))).toEqual([target.id]);
    expect(s.map().regions).toEqual(regions);
    expect(JSON.stringify(s.gis.scene!.map)).toBe(original);
    expect([...s.storage.entries]).toEqual(s.before);
  });
  it.each(['HF', 'VUHF', '告警'])('%s 筛选同步节点，不把节点条件应用到干扰源', async filter => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const expected = s.browseResources.stations.filter(row => filter === '告警' ? row.alert : row.classes.includes(filter as 'HF' | 'VUHF'));
    await click(s.root, filter);
    expect((s.map().stations as Station[]).map(row => row.id)).toEqual(expected.map(row => row.id));
    expect(treeIds(s.root).filter(id => id.startsWith('ND-'))).toEqual(expected.map(row => row.id));
    expect(textOf(s.root)).toContain(expected.length + ' 节点');
    expect(s.map().interferences).toEqual(s.browseResources.interferences);
  });
  it.each(['编号', '名称'])('干扰源%s搜索同步资源树与地图', async kind => {
    const s = await mountEntry('/situation?stationId=ND-0001'), source = s.browseResources.interferences![0];
    await search(s.root, kind === '编号' ? source.id.toLowerCase() : source.name);
    expect((s.map().interferences as InterferenceSource[]).map(row => row.id)).toEqual([source.id]);
    expect(treeIds(s.root)).toEqual([source.id]);
    expect(s.map().stations).toEqual([]);
  });
  it('无匹配时隐藏点与连线，保留详情、表单及草稿，清除后恢复', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001', true);
    const form = JSON.stringify(s.editor.form), resources = JSON.stringify(s.editor.resources);
    const stations = s.map().stations, sources = s.map().interferences, regions = s.map().regions;
    await search(s.root, '不存在的资源');
    expect(s.map().stations).toEqual([]); expect(s.map().interferences).toEqual([]);
    expect(s.map().selectedId).toBe('ND-0001');
    expect(find(s.root, 'device-probe')?.props.station).toMatchObject({ id: 'ND-0001' });
    expect(textOf(s.root)).toContain('当前选中对象不在筛选结果中');
    expect(JSON.stringify(s.editor.form)).toBe(form); expect(s.editor.formDirty).toBe(true);
    expect(JSON.stringify(s.editor.resources)).toBe(resources); expect(s.map().regions).toEqual(regions);
    await click(s.root, '清除筛选');
    expect(s.map().stations).toEqual(stations); expect(s.map().interferences).toEqual(sources);
    expect(textOf(s.root)).not.toContain('当前选中对象不在筛选结果中');
    expect(JSON.stringify(s.editor.form)).toBe(form); expect([...s.storage.entries]).toEqual(s.before);
  });
  it('资源筛选裁剪资源链路，任务地图独立读取保存版本而不修改规划草稿', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const planning = useTaskInputStore(), nodes = s.browseResources.stations;
    const demands: PlanningDemand[] = [{ ...planningPresets[0].input.demands[0], id: 'CD-FILTER', sourceId: nodes[0].id, targetId: nodes[1].id }];
    // 规划页草稿不再作为 GIS 任务输入；保存版本由只读服务明确提供。
    planning.draft = structuredClone(planningPresets[0].input);
    planning.draft!.demands = demands;
    await nextTick();
    const before = JSON.stringify(planning.draft);
    expect(s.map().demands).toEqual([]);
    await search(s.root, nodes[0].id);
    const visible = s.map().stations as Station[];
    expect(linkLayer(s.map().links as NetworkLink[], visible).getSource()!.getFeatures()).toHaveLength(0);
    expect(candidateLinkLayer(s.map().candidateWorkset as import('../src/types/candidate-link').CandidateLink[], visible).getSource()!.getFeatures()).toHaveLength(0);
    expect(demandLayer(s.map().demands as PlanningDemand[], visible).getSource()!.getFeatures()).toHaveLength(0);
    const saved = { ...structuredClone(planningPresets[0].input), stationIds: [nodes[0].id, nodes[1].id], demands };
    // 共同分页服务返回保存版本，保持“GIS 不读取规划草稿”的原业务断言。
    const task = { taskId: 'TASK-VIEW', revision: 'TV-1', inputVersion: 'TV-1', conditionVersion: 'TC-1', resourceRevision: useResourceReadStore().workspace!.revision, updatedAt: '2026-10-19T00:00:00Z', activeJobId: null, input: saved };
    vi.spyOn(previewService, 'queryTaskSummaries').mockResolvedValue({ items: [{...task,name:task.input.name}], total: 1, pageNum: 1, pageSize: 10 });
    vi.spyOn(previewService, 'getTaskInput').mockResolvedValue(task);
    await s.router.push('/situation?taskId=TASK-VIEW'); await settleMonitoring();
    expect(((s.map().planningOverlay as { nodes: Station[] }).nodes as Station[]).map(row => row.id)).toEqual(saved.stationIds);
    expect(demandLayer((s.map().planningOverlay as { demands: PlanningDemand[] }).demands as PlanningDemand[], (s.map().planningOverlay as { nodes: Station[] }).nodes as Station[]).getSource()!.getFeatures()).toHaveLength(1);
    expect(textOf(s.root)).toContain('任务查看 · 只读');
    expect(JSON.stringify(planning.draft)).toBe(before);
    expect(findWhere(s.root, row => row.tag === 'button' && textOf(row).trim() === '返回资源浏览')).toBeUndefined();
    await click(s.root, '图层管理'); expect((s.map().planningOverlay as { demands: PlanningDemand[] }).demands).toEqual(saved.demands);
    await click(s.root, '资源树'); expect(s.gis.mapMode).toBe('resource'); expect(s.map().demands).toEqual([]);
    expect(s.router.currentRoute.value.query).toEqual({ taskId: 'TASK-VIEW' });
    expect(JSON.stringify(planning.draft)).toBe(before); expect(s.storage.writes).toBe(0);
  });
  it('跨页定位清除阻挡目标的搜索和类别条件', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const target = s.browseResources.stations.find(row => row.id !== 'ND-0001' && !row.alert)!;
    await click(s.root, '告警'); await search(s.root, '不存在的资源');
    await s.router.push({ path: '/situation', query: { stationId: target.id } }); await settleMonitoring();
    expect(s.map().selectedId).toBe(target.id);
    expect((s.map().stations as Station[]).some(row => row.id === target.id)).toBe(true);
    expect(textOf(s.root)).not.toContain('当前选中对象不在筛选结果中');
  });
  it('干扰源定位清除搜索但保留节点类别筛选；隐藏时详情仍在', async () => {
    const s = await mountEntry('/situation?interferenceId=IF-0008');
    await click(s.root, 'HF'); await search(s.root, '不存在的资源');
    expect(useResourceReadStore().detail?.object).toMatchObject({kind:'interference',id:'IF-0008'});
    expect(textOf(s.root)).toContain('当前选中对象不在筛选结果中');
    await s.router.push('/situation?interferenceId=IF-0001'); await settleMonitoring();
    expect((s.map().interferences as InterferenceSource[]).some(row => row.id === 'IF-0001')).toBe(true);
    const expected = s.browseResources.stations.filter(row => row.classes.includes('HF'));
    expect(s.map().stations).toEqual(expected);
  });
  it('节点定位保留仍匹配目标的搜索，只解除不匹配的告警条件', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const target = s.browseResources.stations.find(row => row.id !== 'ND-0001' && !row.alert)!;
    await search(s.root, target.id); await click(s.root, '告警');
    expect(s.map().stations).toEqual([]);
    await s.router.push({ path: '/situation', query: { stationId: target.id } }); await settleMonitoring();
    expect((s.map().stations as Station[]).map(row => row.id)).toEqual([target.id]);
    expect(findWhere(s.root, entry => entry.props['aria-label'] === '搜索资源')?.props.value).toBe(target.id);
  });
  it('无效定位和取消切换都保留筛选与未保存输入', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001', true);
    const form = JSON.stringify(s.editor.form);
    await search(s.root, '不存在的资源');
    await s.router.push('/situation?stationId=ND-missing'); await settleMonitoring();
    expect(textOf(s.root)).toContain('地图定位失败'); expect(s.map().stations).toEqual([]);
    vi.spyOn(s.editor, 'closeForm').mockResolvedValue(false);
    await s.router.push('/situation?stationId=ND-0003'); await settleMonitoring();
    expect(s.map().selectedId).toBe('ND-0001'); expect(s.map().stations).toEqual([]);
    expect(JSON.stringify(s.editor.form)).toBe(form);
  });
  it('同站点设备定位被取消时也不解除筛选或丢弃表单', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001', true);
    const form = JSON.stringify(s.editor.form);
    await search(s.root, '不存在的资源');
    vi.spyOn(s.editor, 'closeForm').mockResolvedValue(false);
    await s.router.push('/situation?stationId=ND-0001&deviceId=DV-0001'); await settleMonitoring();
    expect(s.map().stations).toEqual([]); expect(s.map().selectedId).toBe('ND-0001');
    expect(find(s.root, 'device-probe')?.props.selectedDeviceId).toBe('');
    expect(JSON.stringify(s.editor.form)).toBe(form); expect(s.editor.formDirty).toBe(true);
  });
  it('显式查看监控后筛选不截断冻结网络，返回资源图才应用筛选', async () => {
    const s=await mountEntry('/situation');s.monitor.showNetwork();await nextTick();
    const stations = s.map().stations, links = s.map().links;
    await search(s.root, '不存在的资源'); await click(s.root, '告警');
    expect(s.gis.mapMode).toBe('monitoring'); expect(s.map().stations).toEqual(stations); expect(s.map().links).toEqual(links);
    expect(textOf(s.root)).toContain('当前快照保持完整');
    await click(s.root, '资源树');
    expect(s.map().stations).toEqual([]); expect(s.map().interferences).toEqual([]);
  });
  it('资源筛选不截断干扰分析的冻结节点、链路和干扰源', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001',false,false,true);
    await search(s.root,'不存在的资源');await click(s.root,'告警');
    const analysis=await openWorkbenchFromPage(s.root,s.wb),projection=analysis.mapProjection!;
    expect(projection.nodes).toHaveLength(s.wb.network.nodes.length);expect(projection.links).toHaveLength(s.wb.network.links.length);
    expect(projection.sources).toEqual(s.wb.scene.interferenceSources.map(row=>row.sourceRow));
    expect(analysisMap(s.root).interferenceProjection).toEqual(projection);
    await clickWorkbench(s.root,'返回当前资源');
    expect(s.map().stations).toEqual([]);expect(s.map().interferences).toEqual([]);s.wb.assertNoWrites();
  });
  it('措施后地图使用服务快照自身坐标和成套结果，缺失后完整回到措施前',async()=>{
    const s=await mountEntry('/situation?stationId=ND-0001',false,false,true);
    const analysis=await openWorkbenchFromPage(s.root,s.wb);
    const sourceLabel=()=>textOf(findWhere(s.root,n=>n.props['aria-label']==='当前视图数据来源')!);
    expect(sourceLabel()).toBe('数据库冻结方案 · 独立历史来源');
    const before=structuredClone(toRaw(analysis.mapProjection));
    await clickWorkbench(s.root,row=>workbenchText(row).trim().startsWith('P5 · 节点重部署'));
    await clickWorkbench(s.root,'措施后预测');
    expect(analysis.mapProjection?.phase).toBe('PREVIEW');
    expect(analysis.mapProjection?.nodes.find(row=>row.node_id==='UNIT-N1')).toMatchObject({lon:116.2,lat:38.8});
    expect(analysisMap(s.root).interferenceProjection).toEqual(analysis.mapProjection);expect(textOf(s.root)).toContain('措施预览');
    s.wb.workbench.getPreview.mockResolvedValueOnce({...s.wb.preview,measure_id:'UNIT-CM5',impact_after:null});
    await clickWorkbench(s.root,row=>workbenchText(row).trim().startsWith('P5 · 节点重部署'));
    expect(analysis.mapProjection).toEqual(before);expect(textOf(s.root)).toContain('措施前影响');
    expect(analysis.canPreviewAfter).toBe(false);expect(s.storage.writes).toBe(0);s.wb.assertNoWrites();
  });
});
