import { useResourceReadStore } from '../src/stores/resource-read';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import SituationView from '../src/views/SituationView.vue';
import GisObjectInfoPanel from '../src/components/GisObjectInfoPanel.vue';
import GisResourceTree from '../src/components/GisResourceTree.vue';
import ObjectInfoPanel from '../src/components/ObjectInfoPanel.vue';
import DeviceInfoPanel from '../src/components/DeviceInfoPanel.vue';
import DeviceNetworkPanel from '../src/components/DeviceNetworkPanel.vue';
import DeviceCoveragePanel from '../src/components/DeviceCoveragePanel.vue';
import GisResultLayerPanel from '../src/components/GisResultLayerPanel.vue';
import GisDeviceLayerPanel from '../src/components/GisDeviceLayerPanel.vue';
import GisDeviceClusterPanel from '../src/components/GisDeviceClusterPanel.vue';
import type { GisDeviceMapFrame } from '../src/maps/gis-device-display';
import type { GisResultLayerSettings } from '../src/maps/gis-result-layers';
import LinkDetailPanel from '../src/components/LinkDetailPanel.vue';
import LinkHistoryChart from '../src/components/LinkHistoryChart.vue';
import { useAuthStore } from '../src/stores/auth';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useMonitoringStore } from '../src/stores/monitoring';
import type { DeviceCoverageOverlay } from '../src/types/device-coverage';
import { authorizeStore } from './helpers/auth';
import { bindMonitoring, settleMonitoring } from './helpers/monitoring';
import { analysisMap, clickWorkbench, compileWorkbenchTemplates, createWorkbenchFixture, openWorkbenchFromPage, reportHostFailure, settleWorkbench, traceHostErrors, workbenchText } from './helpers/interference-workbench';
import { TestStorage } from './helpers/storage';
// 仅复用模板编译，原有特殊宿主和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';

const probes = vi.hoisted(() => ({ locate: vi.fn(), retry: vi.fn(), locateResource: vi.fn() }));
const transport = vi.hoisted(() => ({ mode: 'mock' }));
vi.mock('../src/config/env', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config/env')>();
  return { ...actual, env: { ...actual.env, get mode() { return transport.mode; } } };
});
// 真实页面、设备入口和覆盖面板运行客户端模板；仅用探针替代地图画布。
vi.mock('../src/components/MapCanvas.vue', async () => {
  const { defineComponent, getCurrentInstance, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false,
    props: ['frozenNetwork', 'interferenceProjection', 'showNodes', 'gisDeviceFrame', 'gisResultLayers', 'opacity', 'topologyOpacity', 'interferenceImpact', 'deviceCoverageActive', 'deviceCoverages', 'deviceCoverageDisplay', 'selectedId', 'stations', 'regions', 'links', 'showCoverage', 'showLinks', 'highlightLinkIds', 'highlightStationIds', 'demands', 'diagnosisDevices', 'diagnosisFaults', 'diagnosisRegions', 'candidateLinks', 'selectLinks', 'selectedLinkId', 'selectedInterferenceId'],
    emits: ['deviceCoverageState', 'select', 'selectLink', 'selectDevice', 'selectDeviceCluster'],
    setup(props, { emit, expose }) {
      const instance = getCurrentInstance()!;
      expose({ locate: probes.locateResource, locateResource: probes.locateResource, fitDeviceCoverage: probes.locate, retryDeviceCoverage: probes.retry });
      return () => {
        // 保留本帧真实监听函数，避免旧 emit 自动转发给新上下文掩盖迟到事件。
        const selectLink = instance.vnode.props?.onSelectLink as (id: string) => void;
        const selectFrozenLink = instance.vnode.props?.onSelectFrozenLink as (id: string) => void;
        return h('map-probe', { ...props,
        selectDevice: (id: string, version: number) => emit('selectDevice', id, version),
        selectDeviceCluster: (ids: string[], version: number) => emit('selectDeviceCluster', ids, version), report: (id: string, state: string) => emit('deviceCoverageState', id, state), select: (id: string) => emit('select', id), selectLink, selectFrozenLink });
      };
    },
  }) };
});
vi.mock('../src/components/DeviceDetailTabs.vue', async () => {
  const { h } = await import('vue');
  return { default: { inheritAttrs: false, setup(_: unknown, { slots }: { slots: Vue.Slots }) {
    return () => h('div', [slots.basic?.(), slots.structure?.(), slots.functions?.(), slots.parameters?.(), slots.network?.(), slots.actions?.()]);
  } } };
});
vi.mock('../src/components/StatusBadge.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
// 趋势业务模板实际执行，画布只接收已构造的选项。
vi.mock('../src/components/ChartCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['option', 'label'], setup(props) { return () => h('chart-probe', { ...props }); } }) };
});
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

// 共用详情入口使用客户端模板，原有业务断言保持实际组件接线。
await clientTemplate(GisObjectInfoPanel, 'src/components/GisObjectInfoPanel.vue', 'coverage-render.ts');
await Promise.all([clientTemplate(SituationView, 'src/views/SituationView.vue', 'coverage-render.ts'), clientTemplate(ObjectInfoPanel, 'src/components/ObjectInfoPanel.vue', 'coverage-render.ts'), clientTemplate(DeviceInfoPanel, 'src/components/DeviceInfoPanel.vue', 'coverage-render.ts'), clientTemplate(DeviceNetworkPanel, 'src/components/DeviceNetworkPanel.vue', 'coverage-render.ts'), clientTemplate(DeviceCoveragePanel, 'src/components/DeviceCoveragePanel.vue', 'coverage-render.ts')]);
await clientTemplate(GisResourceTree, 'src/components/GisResourceTree.vue', 'coverage-render.ts');
await clientTemplate(GisResultLayerPanel, 'src/components/GisResultLayerPanel.vue', 'coverage-render.ts');
await Promise.all([clientTemplate(GisDeviceLayerPanel, 'src/components/GisDeviceLayerPanel.vue', 'coverage-render.ts'),
  clientTemplate(GisDeviceClusterPanel, 'src/components/GisDeviceClusterPanel.vue', 'coverage-render.ts')]);
await Promise.all([clientTemplate(LinkDetailPanel, 'src/components/LinkDetailPanel.vue', 'coverage-render.ts'), clientTemplate(LinkHistoryChart, 'src/components/LinkHistoryChart.vue', 'coverage-render.ts')]);
await compileWorkbenchTemplates();

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
  expect(el, label).toBeDefined(); waitingFor = '按钮 ' + label; await (el!.props.onClick as () => unknown)(); waitingFor = '按钮后刷新 ' + label; await settleMonitoring();
}
// 原生折叠组通过 toggle 展开；原有趋势、图层与输入保护断言不变。
async function expandHistory(root: HostNode) {
  const group = find(root, n => n.tag === 'details' && n.props['aria-label'] === '链路历史趋势');
  expect(group, '链路历史趋势折叠组').toBeDefined();
  await (group!.props.onToggle as (event: unknown) => unknown)({ currentTarget: { open: true } });
  await nextTick();
}
async function change(root: HostNode, label: string, value: string | boolean, event = 'onChange') {
  const el = find(root, n => n.props['aria-label'] === label);
  expect(el, label).toBeDefined();
  (el!.props[event] as (e: unknown) => void)({ target: { value, checked: value } }); await nextTick();
  if (label === '搜索资源') { await vi.advanceTimersByTimeAsync(250); await settleMonitoring(); }
}
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
let waitingFor = '夹具未启动', waitSnapshot: () => unknown = () => null;
afterEach(context => { reportHostFailure(context.task, waitingFor, waitSnapshot); app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); waitingFor = '夹具未启动'; waitSnapshot = () => null; });
async function mountEntry(deviceId = 'DV-0001', frozen = false) {
  waitingFor = '设备入口夹具准备';
  transport.mode = frozen ? 'http' : 'mock';
  vi.useFakeTimers(); vi.stubGlobal('window', new EventTarget());
  class TestDocument extends EventTarget { hidden = false; activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  vi.stubGlobal('ShadowRoot', class {});
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  // 公共分页与完整 GIS 资料绑定同一存储。
  for (const key of ['loadResourceReadContext','queryResourceDevices','queryResourceNodes','queryResourceInterferences','getResourceObject','queryResourceMap','loadGisResourceDirectory','loadGisResourceScene','loadGisResourceEditContext'] as const) vi.spyOn(previewService,key).mockImplementation(raw[key].bind(raw) as never);

  // 持有实际注入页面的轻目录，归属保护只改变该显示夹具。
  let directory!: Awaited<ReturnType<typeof raw.loadGisResourceDirectory>>;
  vi.mocked(previewService.loadGisResourceDirectory).mockImplementation(async input => directory = await raw.loadGisResourceDirectory(input));
  vi.spyOn(previewService, 'loadPreview').mockImplementation(raw.loadPreview);
  // 页面状态读取复用同一测试服务，避免掉入默认服务而丢失测试身份。
  vi.spyOn(previewService, 'loadDeviceStatusContext').mockImplementation(raw.loadDeviceStatusContext);
  vi.spyOn(previewService, 'loadInterferenceWorkspace').mockImplementation(raw.loadInterferenceWorkspace);
  // 详情新增发布版知识摘要，只注入读取依赖，不改变覆盖流程与断言。
  for (const name of ['loadKnowledgeMetadata', 'searchKnowledgeSummaries', 'getKnowledgeGraph', 'getKnowledgeEntity', 'getDeviceKnowledge','saveResourceChanges'] as const)
    vi.spyOn(previewService, name).mockImplementation(raw[name] as never);
  bindMonitoring(raw); vi.spyOn(previewService,'getMonitoringObservation').mockImplementation(raw.getMonitoringObservation);
  const wb = await createWorkbenchFixture(); wb.bind();
  const preview = usePreviewStore(); waitingFor = '设备入口预览及GIS读取'; await preview.load();await useResourceReadStore().activate('gis');await useGisWorkspaceStore().loadScene();
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/situation', component: SituationView }, { path: '/planning', component: { render: () => null } },
  ] });
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  traceHostErrors(app);
  waitSnapshot = () => { const gis = useGisWorkspaceStore(), editor = useResourceEditStore(), read = useResourceReadStore();
    return { route: router.currentRoute.value.fullPath, mode: gis.mapMode, gisBusy: gis.busy, saveState: gis.saveState,
      editorBusy: editor.busy, editorDecision: editor.decision, formDirty: editor.formDirty, resourceDirty: editor.dirty,
      editorError: editor.error, refreshing: read.refreshing, readPending: read.pending, readErrors: read.errors,
      currentResource: read.workspace?.revision }; };
  waitingFor = '设备入口router.push'; await router.push('/situation?stationId=ND-0001&deviceId=' + deviceId); await router.isReady();
  const root = node('root'); app.mount(root); await settleMonitoring(); await nextTick();
  waitingFor = '设备入口用例主体';
  const map = () => find(root, n => n.tag === 'map-probe')!.props;
  return { root, map, preview, storage, router, directory: () => directory, gis: useGisWorkspaceStore(), editor: useResourceEditStore(), monitor: useMonitoringStore(), wb };
}
async function enterAnalysis(s: Awaited<ReturnType<typeof mountEntry>>) { return openWorkbenchFromPage(s.root, s.wb); }
async function returnFromAnalysis(s: Awaited<ReturnType<typeof mountEntry>>) { await clickWorkbench(s.root, '返回当前资源'); }

describe('GIS 设备覆盖入口和控制', () => {
  it.each(['身份', '失权', '版本', '监控', '离页'] as const)('覆盖读取等待期间改变%s后，迟到结果不能接管地图', async kind => {
    const s = await mountEntry(), read = useResourceReadStore(), auth = useAuthStore();
    const catalog = await createMockService(() => s.storage).getGisCoverageCatalog({ context: 'gis', revision: read.workspace!.revision });
    let finish!: (value: typeof catalog) => void, signal: AbortSignal | undefined;
    vi.spyOn(previewService, 'getGisCoverageCatalog').mockImplementationOnce(input => {
      signal = input.signal;
      return new Promise(resolve => { finish = resolve; });
    });
    // 保留真实按钮事件与请求，只延迟数据返回。
    const action = find(s.root, row => row.tag === 'button' && textOf(row).trim() === '查看覆盖')!;
    (action.props.onClick as () => unknown)(); await nextTick();
    if (kind === '身份') auth.generation++;
    if (kind === '失权') auth.accept({ ...auth.identity!, permissions: [] });
    if (kind === '版本') read.workspace!.revision = 'new-resource-revision';
    if (kind === '监控') s.monitor.showNetwork();
    if (kind === '离页') { await s.router.push('/planning'); s.gis.mapMode = 'monitoring'; }
    await nextTick(); finish(catalog); await settleMonitoring();
    if (kind === '监控' || kind === '离页') expect(s.gis.mapMode).toBe('monitoring');
    expect(find(s.root, row => row.tag === 'map-probe')?.props.deviceCoverageActive).not.toBe(true);
    if (['身份', '版本', '离页'].includes(kind)) expect(signal?.aborted).toBe(true);
    expect(s.storage.writes).toBe(0);
  });
  it('等待覆盖时后选整网优先，重复读取合并且失败不替换新的显示意图', async () => {
    const s = await mountEntry(); let fail!: (reason: Error) => void;
    const request = vi.spyOn(previewService, 'getGisCoverageCatalog').mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await click(s.root, '图层管理');
    await change(s.root, '覆盖设备范围', 'single');
    await change(s.root, '覆盖设备范围', 'multiple');
    await change(s.root, '覆盖设备范围', 'network');
    fail(new Error('覆盖暂不可用')); await settleMonitoring();
    expect(request).toHaveBeenCalledTimes(1); expect(s.map().deviceCoverageActive).toBe(false);
    expect(s.map().deviceCoverages).toEqual([]); expect(textOf(s.root)).toContain('覆盖暂不可用');
    expect(s.storage.writes).toBe(0);
  });
  it('资源版本变化后立即按新版本读取，旧响应不污染目录或结束新请求', async () => {
    const s = await mountEntry(), read = useResourceReadStore();
    const catalog = await createMockService(() => s.storage).getGisCoverageCatalog({ context: 'gis', revision: read.workspace!.revision });
    const finishes: ((value: typeof catalog) => void)[] = [];
    const request = vi.spyOn(previewService, 'getGisCoverageCatalog').mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
    await click(s.root, '图层管理'); await change(s.root, '覆盖设备范围', 'single');
    read.workspace!.revision = 'next-resource-revision'; await nextTick();
    await change(s.root, '覆盖设备范围', 'multiple');
    expect(request).toHaveBeenCalledTimes(2); expect(request.mock.calls[0][0].signal?.aborted).toBe(true);
    finishes[0](catalog); await settleMonitoring();
    await change(s.root, '覆盖设备范围', 'single'); expect(request).toHaveBeenCalledTimes(2);
    finishes[1](catalog); await settleMonitoring();
    expect(request.mock.calls[1][0].revision).toBe('next-resource-revision');
    // 此夹具只推进读取版本，地图仍受原场景版本保护；核对新的目录与显示选择。
    expect(find(s.root, row => row.props['aria-label'] === '覆盖设备范围')!.props.value).toBe('single');
    expect(find(s.root, row => row.props['aria-label'] === '单台覆盖设备')!.props.value).toBe('DV-0001');
    expect(s.storage.writes).toBe(0);
  });
  it('选中设备只高亮其关联链路，切换同站设备和节点不继承其他设备关系', async () => {
    const s = await mountEntry();
    // 模拟公共服务复核同一身份；引用更新不应取消本次资源选择。
    const getObject = vi.mocked(previewService.getResourceObject).getMockImplementation()!;
    vi.mocked(previewService.getResourceObject).mockImplementation(async input => {
      useAuthStore().accept(JSON.parse(JSON.stringify(useAuthStore().identity)));
      return getObject(input);
    });
    expect(s.map().highlightLinkIds).toEqual(['PL-001', 'PL-002']); expect(textOf(s.root)).toContain('固定站话音保障');
    await change(s.root, '选择节点设备', 'DV-0002'); await settleMonitoring();
    expect((s.map().gisDeviceFrame as GisDeviceMapFrame).selectedDeviceId).toBe('DV-0002');
    expect(s.map().highlightLinkIds).toEqual([]); expect(textOf(s.root)).toContain('当前演示网络未关联此设备');
    await (s.map().select as (id: string) => unknown)('ND-0003'); await settleMonitoring();
    await change(s.root, '选择节点设备', 'DV-0027'); await settleMonitoring();
    expect(s.map().highlightLinkIds).toEqual(['PL-001', 'PL-005', 'PL-006', 'PL-007']); expect(textOf(s.root)).toContain('备用保障');
    expect(s.storage.writes).toBe(0);
  });
  it('草稿和保存变更同步暂停关联与高亮，撤销草稿后恢复且不动覆盖选择', async () => {
    const s = await mountEntry(); await click(s.root, '查看覆盖');
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001');
    s.editor.form!.fields.txPowerDbm = '40'; await nextTick();
    expect(s.map().highlightLinkIds).toEqual([]); expect(textOf(s.root)).toContain('资源存在未保存修改');
    expect(textOf(s.root)).not.toContain('固定站话音保障');
    s.editor.form!.fields.txPowerDbm = s.editor.form!.initial.txPowerDbm; await nextTick();
    expect(s.map().highlightLinkIds).toEqual(['PL-001', 'PL-002']); expect(s.map().deviceCoverageActive).toBe(true);
    s.gis.scene!.resourceMeta.changedStationIds.push('ND-0001'); await nextTick();
    expect(s.map().highlightLinkIds).toEqual([]); expect(textOf(s.root)).toContain('资源已变更'); expect(s.storage.writes).toBe(0);
  });
  it('关联查看不清除资源筛选或开启链路图层，目录异常不高亮错配链路', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理');
    const toggle = find(s.root, row => row.tag === 'label' && textOf(row).includes('规划后链路'))!;
    const checkbox = find(toggle, row => row.tag === 'input')!;
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: false } }); await nextTick();
    await change(s.root, '选择节点设备', 'DV-0002'); await settleMonitoring();
    await change(s.root, '选择节点设备', 'DV-0001'); await settleMonitoring(); expect(s.map().showLinks).toBe(false);
    await click(s.root, '资源树'); const input = find(s.root, row => row.props['aria-label'] === '搜索资源')!;
    (input.props.onInput as (event: unknown) => void)({ target: { value: '不存在的节点' } }); await nextTick();
    expect(s.map().stations).toEqual([]); expect(textOf(s.root)).toContain('固定站话音保障');
    expect(s.map().showLinks).toBe(false);
    useResourceReadStore().detail!.network!.snapshotId = 'OLD'; await nextTick();
    expect(s.map().highlightLinkIds).toEqual([]); expect(textOf(s.root)).toContain('版本不匹配'); expect(s.storage.writes).toBe(0);
  });
  it('GIS 详情收到型号资料并展示草稿配置，查看详情不改已保存值或存储', async () => {
    const s = await mountEntry(), saved = s.preview.data!.resources.devices.find(row => row.id === 'DV-0001')!;
    const before = saved.txPowerDbm;
    const detail = s.preview.data!.deviceDetails!.models.find(row => row.modelId === saved.modelId)!;
    expect(textOf(s.root)).toContain('电台类型' + detail.category); expect(textOf(s.root)).toContain(`接收灵敏度${detail.rxSensitivityDbm} dBm`);
    await s.gis.begin();
    // 模拟已应用至 GIS 草稿的参数，尚未整体保存。
    s.editor.resources.devices.find(row => row.id === saved.id)!.txPowerDbm = 0; await nextTick();
    expect(textOf(s.root)).toContain('发射功率0 dBm'); expect(saved.txPowerDbm).toBe(before);
    expect(textOf(s.root)).toContain('当前显示 GIS 草稿，尚未保存。'); expect(s.storage.writes).toBe(0);
    await click(s.root, '查看覆盖'); expect(s.map().deviceCoverageActive).toBe(false);
  });
  it('显式查看设备后切换图层，普通选点不改覆盖选择；返回整网保留原区域', async () => {
    const s = await mountEntry(), original = s.map().regions, submit = vi.spyOn(previewService, 'submitPlanning');
    expect(s.map().deviceCoverageActive).toBe(false);
    await click(s.root, '查看覆盖');
    expect(s.map().deviceCoverageActive).toBe(true);
    expect((s.map().deviceCoverages as DeviceCoverageOverlay[]).map(r => r.sample.deviceId)).toEqual(['DV-0001']);
    expect(textOf(s.root)).toContain('工作频率：未提供');
    await (s.map().select as (id: string) => unknown)('ND-0002'); await nextTick();
    expect((s.map().deviceCoverages as DeviceCoverageOverlay[])[0].sample.deviceId).toBe('DV-0001');
    await change(s.root, '覆盖设备范围', 'network');
    expect(s.map().deviceCoverageActive).toBe(false); expect(s.map().regions).toEqual(original);
    expect(s.storage.writes).toBe(0); expect(submit).not.toHaveBeenCalled();
  });
  it('多台选择、逐台显隐、透明度、定位和显示模式均经实际面板绑定', async () => {
    const s = await mountEntry(); await click(s.root, '查看覆盖');
    await change(s.root, '覆盖设备范围', 'multiple');
    for (const id of ['DV-0001', 'DV-0033']) await change(s.root, '叠加 ' + id, true);
    expect((s.map().deviceCoverages as DeviceCoverageOverlay[])).toHaveLength(2);
    await change(s.root, '显示 DV-0033', false);
    await change(s.root, 'DV-0001 覆盖透明度', '0.4', 'onInput');
    expect((s.map().deviceCoverages as DeviceCoverageOverlay[]).map(r => [r.visible, r.opacity])).toEqual([[true, 0.4], [false, 0.7]]);
    await change(s.root, '设备覆盖显示方式', 'raster'); expect(s.map().deviceCoverageDisplay).toBe('raster');
    // 当前目录换到 v2，定位仍使用所选设备的快照身份。
    await click(s.root, '定位覆盖范围'); expect(probes.locate).toHaveBeenCalledWith('device-v2-DV-0001');
    expect(s.map().selectedId).toBe('ND-0001'); expect(s.storage.writes).toBe(0);
    await click(s.root, '清空叠加选择'); expect(s.map().deviceCoverages).toEqual([]); expect(s.map().deviceCoverageActive).toBe(true);
    expect(textOf(s.root)).toContain('请选择要展示的设备');
  });
  it('无样例设备明确空态，不回退整网或其他设备；可从面板选择有效样例', async () => {
    const s = await mountEntry('DV-0002'); await click(s.root, '查看覆盖');
    expect(s.map().deviceCoverageActive).toBe(true); expect(s.map().deviceCoverages).toEqual([]);
    expect(textOf(s.root)).toContain('此设备暂无预生成结果');
    await change(s.root, '单台覆盖设备', 'DV-0043');
    expect((s.map().deviceCoverages as DeviceCoverageOverlay[])[0].sample.deviceId).toBe('DV-0043');
    expect(s.map().selectedId).toBe('ND-0001');
  });
  it('加载失败按设备显示并重试，重试不更改显示选择', async () => {
    const s = await mountEntry(); await click(s.root, '查看覆盖');
    (s.map().report as (id: string, state: string) => void)('device-v2-DV-0001', 'error'); await nextTick();
    expect(textOf(s.root)).toContain('图片加载失败，已保留本设备轮廓');
    await click(s.root, '重试图片'); expect(probes.retry).toHaveBeenCalledWith('device-v2-DV-0001');
    expect((s.map().deviceCoverages as DeviceCoverageOverlay[])).toHaveLength(1);
  });
  it('编辑草稿与保存资源变更暂停覆盖但保留表单，恢复后选择不丢失', async () => {
    const s = await mountEntry(); await click(s.root, '查看覆盖');
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001'); s.editor.form!.fields.antennaHeightM = '19'; await nextTick();
    const form = JSON.stringify(s.editor.form); expect(s.map().deviceCoverageActive).toBe(false); expect(s.map().deviceCoverages).toEqual([]);
    await change(s.root, '单台覆盖设备', 'DV-0033'); expect(JSON.stringify(s.editor.form)).toBe(form);
    s.editor.form!.fields.antennaHeightM = s.editor.form!.initial.antennaHeightM; await nextTick();
    expect(s.map().deviceCoverageActive).toBe(true);
    s.gis.scene!.resourceMeta.changedDeviceIds.push('DV-0001'); await nextTick(); expect(s.map().deviceCoverageActive).toBe(false);
    s.gis.scene!.resourceMeta.changedDeviceIds = []; await nextTick(); expect((s.map().deviceCoverages as DeviceCoverageOverlay[])[0].sample.deviceId).toBe('DV-0033');
    expect(s.storage.writes).toBe(0);
  });
  it('资源筛选不裁剪覆盖几何，监控上下文暂停且返回后恢复选择', async () => {
    const s = await mountEntry(); await click(s.root, '查看覆盖');
    const sample = (s.map().deviceCoverages as DeviceCoverageOverlay[])[0].sample;
    await click(s.root, '资源树');
    const search = find(s.root, n => n.props['aria-label'] === '搜索资源')!;
    (search.props.onInput as (event: unknown) => void)({ target: { value: '不存在的资源' } }); await nextTick();
    expect(s.map().stations).toEqual([]); expect((s.map().deviceCoverages as DeviceCoverageOverlay[])[0].sample).toEqual(sample);
    s.monitor.showNetwork(); await settleMonitoring(); expect(s.map().deviceCoverageActive).toBe(false); expect(s.map().deviceCoverages).toEqual([]);
    expect(s.map().highlightLinkIds).toEqual([]);
    await click(s.root, '图层管理'); await click(s.root, '返回资源地图');
    expect((s.map().deviceCoverages as DeviceCoverageOverlay[])[0].sample).toEqual(sample);
  });
  it('干扰冻结网络隔离设备教学层，返回后恢复原样例', async () => {
    const s = await mountEntry('DV-0001', true); await click(s.root, '查看覆盖');
    const sample = (s.map().deviceCoverages as DeviceCoverageOverlay[])[0].sample, analysis = await enterAnalysis(s);
    const map = analysisMap(s.root);
    expect(map.gisDeviceFrame).toBeUndefined(); expect(map.deviceCoverageActive).not.toBe(true);
    expect(map.frozenNetwork).toBeNull(); expect(map.interferenceProjection).toEqual(analysis.mapProjection);
    expect(map.stations).toEqual([]);
    await returnFromAnalysis(s); expect((s.map().deviceCoverages as DeviceCoverageOverlay[])[0].sample).toEqual(sample);
    s.wb.assertNoWrites();
  });
  it('离页再进入恢复整网，覆盖选择不写入浏览器存储', async () => {
    const s = await mountEntry(); await click(s.root, '查看覆盖');
    await s.router.push('/planning'); await nextTick();
    await s.router.push('/situation?stationId=ND-0001&deviceId=DV-0001'); await settleMonitoring(); await nextTick();
    expect(s.map().deviceCoverageActive).toBe(false); expect(s.map().deviceCoverages).toEqual([]); expect(s.storage.writes).toBe(0);
  });
});

// 频率只控制设备实例层；真实草稿/保存/取消流程不由测试替代。
describe('GIS 设备频率入口联动', () => {
  const frame = (s: Awaited<ReturnType<typeof mountEntry>>) => s.map().gisDeviceFrame as GisDeviceMapFrame | undefined;
  const ids = (s: Awaited<ReturnType<typeof mountEntry>>) => frame(s)!.points.map(row => row.id);
  const control = (root: HostNode, label: string) => find(root, row => row.props['aria-label'] === label)!;
  async function submit(root: HostNode) {
    (control(root, 'GIS 设备频率筛选').props.onSubmit as Function)({ preventDefault() {} }); await nextTick();
  }
  async function frequency(root: HostNode, mode = 'DEVICE', min = '6000', max = '6000') {
    await change(root, 'GIS 频率筛选依据', mode);
    await change(root, 'GIS 频率下限（kHz）', min, 'onInput'); await change(root, 'GIS 频率上限（kHz）', max, 'onInput'); await submit(root);
  }
  it('频率只改变设备点位，目录/导出/站点/链路/区域和业务数据保持原范围', async () => {
    const s = await mountEntry(), before = JSON.stringify(s.preview.data);
    const outside = () => JSON.stringify([s.map().stations, s.map().links, s.map().regions, s.map().gisResultLayers,
      find(s.root, row => row.tag === 'export-probe')!.props]);
    const original = outside(), tree = textOf(find(s.root, row => row.props.class === 'gis-resource-tree')!);
    await click(s.root, '图层管理'); await frequency(s.root, 'MODEL');
    expect(ids(s)).toContain('DV-0001'); expect(ids(s).length).toBeLessThan(414);
    await frequency(s.root); expect(ids(s)).toEqual([]); expect(outside()).toBe(original);
    await click(s.root, '资源树'); expect(textOf(find(s.root, row => row.props.class === 'gis-resource-tree')!)).toBe(tree);
    expect(textOf(s.root)).toContain('当前选中设备未在地图显示'); expect(frame(s)!.selectedDeviceId).toBe('DV-0001');
    expect(JSON.stringify(s.preview.data)).toBe(before); expect(s.storage.writes).toBe(0);
  });
  it('未提交/非法频率输入保留点位；聚合清单裁剪到同一范围并拒绝隐藏成员', async () => {
    const s = await mountEntry(); s.gis.scene!.map.devices.find(row => row.id === 'DV-0002')!.workFreqKhz = 6000; await nextTick();
    const originalVersion = frame(s)!.version;
    (s.map().selectDeviceCluster as Function)(['DV-0001', 'DV-0002'], originalVersion); await nextTick();
    await click(s.root, '图层管理'); await change(s.root, 'GIS 频率筛选依据', 'DEVICE');
    await change(s.root, 'GIS 频率下限（kHz）', '6000', 'onInput'); expect(ids(s)).toHaveLength(414);
    await submit(s.root); expect(ids(s)).toEqual(['DV-0002']);
    expect(find(s.root, row => row.props['aria-label'] === '查看聚合设备 DV-0001')).toBeUndefined();
    expect(control(s.root, '查看聚合设备 DV-0002')).toBeDefined();
    (s.map().selectDevice as Function)('DV-0001', originalVersion); await settleMonitoring();
    expect(frame(s)!.selectedDeviceId).toBe('DV-0001');
    await change(s.root, 'GIS 频率下限（kHz）', 'bad', 'onInput'); await submit(s.root);
    expect(ids(s)).toEqual(['DV-0002']); expect(textOf(s.root)).toContain('非负有限数');
    await change(s.root, 'GIS 频率下限（kHz）', '9000', 'onInput'); await submit(s.root);
    expect(ids(s)).toEqual([]); expect(control(s.root, '查看聚合设备 DV-0002')).toBeUndefined();
  });
  it('频点只在应用资源草稿后参与筛选，资源撤销/重做及放弃同步恢复，隐藏不清表单', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await frequency(s.root);
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001');
    s.editor.form!.fields.workFreqKhz = '6000'; await nextTick();
    expect(ids(s)).toEqual([]); expect((await createMockService(()=>s.storage).loadPreview()).resources.devices[0].workFreqKhz).toBeNull();
    expect(s.editor.applyForm(), s.editor.error).toBe(true); await nextTick(); expect(ids(s)).toEqual(['DV-0001']);
    await s.gis.moveHistory('undo'); await nextTick(); expect(ids(s)).toEqual([]); expect(s.editor.form?.id).toBe('DV-0001');
    await s.gis.moveHistory('redo'); await nextTick(); expect(ids(s)).toEqual(['DV-0001']);
    const pending = s.gis.leave(); expect(s.editor.decision).not.toBeNull(); s.editor.answer('discard');
    expect(await pending).toBe(true); await nextTick(); expect(ids(s)).toEqual([]);
    expect(control(s.root, 'GIS 频率下限（kHz）').props.value).toBe('6000'); expect(s.storage.writes).toBe(0);
  });
  it('资源保存失败保留已应用草稿与未应用输入，成功后用保存结果重新筛选', async () => {
    const s = await mountEntry(), raw = createMockService(() => s.storage);
    vi.spyOn(previewService, 'commitResources').mockImplementation(raw.commitResources);
    await click(s.root, '图层管理'); await frequency(s.root);
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001'); s.editor.form!.fields.workFreqKhz = '6000';
    expect(s.editor.applyForm(), s.editor.error).toBe(true); await nextTick(); expect(ids(s)).toEqual(['DV-0001']);
    s.editor.form!.fields.workFreqKhz = '7500'; s.storage.failWrite = true;
    expect(await s.gis.save()).toBe(false); await nextTick();
    expect(ids(s)).toEqual(['DV-0001']); expect(s.editor.form!.fields.workFreqKhz).toBe('7500');
    expect(s.preview.data!.resources.devices[0].workFreqKhz).toBeNull(); expect(s.storage.writes).toBe(0);
    s.storage.failWrite = false; expect(await s.gis.save(), s.editor.error).toBe(true); await nextTick();
    expect(ids(s)).toEqual([]); expect((await createMockService(()=>s.storage).loadPreview()).resources.devices[0].workFreqKhz).toBe(7500);
    expect((await createMockService(()=>s.storage).loadPreview()).resources.devices[0].workFreqKhz).toBe(7500); expect(s.storage.writes).toBe(1);
  });
  it('目录取消保持频率与未保存输入，应用并继续后只解除阻挡目标的频率限制', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await frequency(s.root);
    await change(s.root, 'GIS 频率下限（kHz）', 'bad', 'onInput'); await submit(s.root);
    await change(s.root, '显示VUHF设备', false);
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001'); s.editor.form!.fields.workFreqKhz = '6000'; await nextTick();
    await click(s.root, '资源树'); const choose = () => (control(s.root, '选择设备 DV-0002').props.onClick as Function)();
    const form = JSON.stringify(s.editor.form); choose(); await nextTick(); expect(s.editor.decision).not.toBeNull();
    s.editor.answer('cancel'); await settleMonitoring();
    expect(ids(s)).toEqual([]); expect(JSON.stringify(s.editor.form)).toBe(form);
    await click(s.root, '图层管理');
    expect(control(s.root, 'GIS 频率下限（kHz）').props.value).toBe('bad');
    expect(textOf(s.root)).not.toContain('已为定位目标解除频率限制');
    await click(s.root, '资源树'); choose(); await nextTick(); s.editor.answer('save'); await settleMonitoring();
    await click(s.root, '图层管理');
    expect(ids(s)).toContain('DV-0002'); expect(frame(s)!.selectedDeviceId).toBe('DV-0002');
    expect(frame(s)!.settings.VUHF.visible).toBe(false); expect(textOf(s.root)).toContain('已为定位目标解除频率限制');
    expect(control(s.root, 'GIS 频率下限（kHz）').props.value).toBe('bad');
    expect(s.editor.resources.devices[0].workFreqKhz).toBe(6000); expect(s.storage.writes).toBe(0);
  });
  it('目录目标原本符合范围时保留频率，筛选再次隐藏不自动解除或清除详情', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await frequency(s.root, 'MODEL');
    await click(s.root, '资源树'); (control(s.root, '选择设备 DV-0002').props.onClick as Function)(); await settleMonitoring();
    expect(textOf(s.root)).not.toContain('已为定位目标解除频率限制'); expect(ids(s).length).toBeLessThan(414);
    await click(s.root, '图层管理'); await frequency(s.root);
    expect(ids(s)).toEqual([]); expect(frame(s)!.selectedDeviceId).toBe('DV-0002'); expect(textOf(s.root)).toContain('当前选中设备未在地图显示');
  });
  it('监控/分析往返保留频率输入但不裁剪冻结网络，换身份重置', async () => {
    const s = await mountEntry('DV-0001', true); await click(s.root, '图层管理'); await frequency(s.root);
    await change(s.root, 'GIS 频率下限（kHz）', '7000', 'onInput');
    s.monitor.showNetwork(); await settleMonitoring(); const monitored = JSON.stringify([s.map().stations, s.map().links, s.map().regions]);
    expect(frame(s)).toBeUndefined(); await click(s.root, '清除频率条件');
    expect(JSON.stringify([s.map().stations, s.map().links, s.map().regions])).toBe(monitored);
    await click(s.root, '资源树'); expect(ids(s)).toEqual([]); await click(s.root, '图层管理'); expect(control(s.root, 'GIS 频率下限（kHz）').props.value).toBe('7000');
    const analysis = await enterAnalysis(s), frozen = JSON.stringify(analysis.mapProjection);
    expect(analysisMap(s.root).gisDeviceFrame).toBeUndefined();
    expect(analysis.mapProjection?.nodes).toHaveLength(s.wb.network.nodes.length);
    expect(analysis.mapProjection?.links).toHaveLength(s.wb.network.links.length);
    expect(JSON.stringify(analysis.mapProjection)).toBe(frozen); s.wb.assertNoWrites();
    await returnFromAnalysis(s); expect(ids(s)).toEqual([]); await click(s.root, '图层管理'); expect(control(s.root, 'GIS 频率下限（kHz）').props.value).toBe('7000');
    useAuthStore().generation++; await nextTick(); expect(ids(s)).toHaveLength(414); expect(control(s.root, 'GIS 频率下限（kHz）').props.value).toBe('');
    expect(s.storage.writes).toBe(0);
  });
  it('目录确认期间权限或身份变化不解除频率限制或采纳迟到选择', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await frequency(s.root);
    let resolve!: (value: boolean) => void;
    vi.spyOn(s.editor, 'closeForm').mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
    await click(s.root, '资源树'); (control(s.root, '选择设备 DV-0002').props.onClick as Function)(); await nextTick();
    const auth = useAuthStore(), permissions = [...auth.identity!.permissions]; auth.identity!.permissions = permissions.filter(row => row !== 'situation.view');
    resolve(true); await settleMonitoring(); auth.identity!.permissions = permissions; await nextTick();
    expect(ids(s)).toEqual([]); expect(frame(s)!.selectedDeviceId).toBe('DV-0001');
    expect(textOf(s.root)).not.toContain('已为定位目标解除频率限制'); expect(s.storage.writes).toBe(0);
  });
});

// 目录显式选择与地图事件分开验证：前者允许显出，后者仍拒绝隐藏或陈旧事件。
describe('GIS 目录显式选择保护', () => {
  const frame = (s: Awaited<ReturnType<typeof mountEntry>>) => s.map().gisDeviceFrame as GisDeviceMapFrame | undefined;
  const action = (root: HostNode, label: string) => {
    const button = find(root, row => row.props['aria-label'] === label);
    expect(button, label).toBeDefined(); return button!.props.onClick as () => unknown;
  };
  async function search(root: HostNode, value: string) {
    const input = find(root, row => row.props['aria-label'] === '搜索资源')!;
    (input.props.onInput as Function)({ target: { value } }); await nextTick(); await vi.advanceTimersByTimeAsync(250); await settleMonitoring();
  }
  async function select(root: HostNode, label: string) {
    action(root, label)(); await settleMonitoring(); await nextTick();
  }
  async function toggle(root: HostNode, label: string, value: boolean) {
    const row = find(root, entry => entry.tag === 'label' && textOf(entry).includes(label))!;
    const control = find(row, entry => entry.tag === 'input')!;
    if (label === '规划后链路') (control.props.onChange as Function)({ target: { checked: value } });
    else (control.props['onUpdate:modelValue'] as Function)(value);
    await nextTick();
  }
  it('隐藏设备经目录选择恢复自身类型和状态，保留另一类型偏好；同 ID 再点也定位', async () => {
    const s = await mountEntry(), before = JSON.stringify(s.preview.data);
    await click(s.root, '图层管理'); await change(s.root, '显示HF设备', false);
    await change(s.root, 'HF设备透明度', '0', 'onInput'); await change(s.root, '显示VUHF设备', false);
    await change(s.root, 'VUHF设备透明度', '0.4', 'onInput'); await change(s.root, '设备点位状态', 'FAULT');
    await click(s.root, '资源树'); await search(s.root, 'DV-0027'); probes.locateResource.mockClear();
    await select(s.root, '选择设备 DV-0027');
    expect(frame(s)!.settings.HF).toEqual({ visible: true, opacity: 1 });
    expect(frame(s)!.settings.VUHF).toEqual({ visible: false, opacity: 0.4 });
    expect(frame(s)!.points.map(row => row.id)).toEqual(['DV-0027']); expect(s.map().selectedId).toBe('ND-0003');
    expect(frame(s)!.selectedDeviceId).toBe('DV-0027'); expect(probes.locateResource).toHaveBeenCalledOnce();
    await select(s.root, '选择设备 DV-0027'); expect(probes.locateResource).toHaveBeenCalledTimes(2);
    await click(s.root, '图层管理'); await change(s.root, '显示HF设备', false);
    expect(frame(s)!.points).toEqual([]); expect(frame(s)!.selectedDeviceId).toBe('DV-0027');
    expect(textOf(s.root)).toContain('当前选中设备未在地图显示');
    expect(JSON.stringify(s.preview.data)).toBe(before); expect(s.storage.writes).toBe(0);
  });
  it('取消真实未保存确认保留输入、选择和图层，应用并继续后精确选择且草稿仍未保存', async () => {
    const s = await mountEntry(); await s.gis.begin(); await s.editor.openForm('device', 'DV-0001');
    s.editor.form!.fields.antennaHeightM = '19';
    await click(s.root, '图层管理'); await change(s.root, '显示HF设备', false);
    await click(s.root, '资源树'); await search(s.root, 'DV-0027');
    const form = JSON.stringify(s.editor.form), settings = JSON.stringify(frame(s)!.settings);
    action(s.root, '选择设备 DV-0027')(); await nextTick(); expect(s.editor.decision).not.toBeNull();
    s.editor.answer('cancel'); await settleMonitoring();
    expect(JSON.stringify(s.editor.form)).toBe(form); expect(JSON.stringify(frame(s)!.settings)).toBe(settings);
    expect(frame(s)!.selectedDeviceId).toBe('DV-0001'); expect(s.map().selectedId).toBe('ND-0001');
    expect(find(s.root, row => row.props['aria-label'] === '搜索资源')!.props.value).toBe('DV-0027');
    action(s.root, '选择设备 DV-0027')(); await nextTick(); s.editor.answer('save'); await settleMonitoring();
    expect(s.editor.form).toBeNull(); expect(frame(s)!.selectedDeviceId).toBe('DV-0027');
    expect(s.editor.resources.devices.find(row => row.id === 'DV-0001')!.antennaHeightM).toBe(19);
    expect(s.map().showLinks).toBe(false); expect(s.storage.writes).toBe(0);
  });
  it('链路目录显示原 ID、两端、类别及状态；隐藏后显式选择仍定位并保留隐藏', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理');
    await toggle(s.root, '规划后链路', false); await toggle(s.root, '站点参考点', false);
    await change(s.root, '显示VUHF设备', false); await click(s.root, '资源树'); await search(s.root, 'PL-001');
    const button = find(s.root, row => row.props['aria-label'] === '选择链路 PL-001')!;
    expect(textOf(button)).toContain('PL-001 · HF · 优');
    expect(textOf(button)).toContain(s.preview.data!.resources.stations.find(row => row.id === 'ND-0003')!.name);
    probes.locateResource.mockClear(); await select(s.root, '选择链路 PL-001');
    expect(s.map()).toMatchObject({ selectedLinkId: 'PL-001', selectedId: '', showLinks: false, showNodes: true });
    expect(frame(s)!.selectedDeviceId).toBe(''); expect(frame(s)!.settings.VUHF.visible).toBe(false);
    expect(find(s.root, row => row.props['aria-label'] === 'GIS 链路详情')).toBeDefined();
    expect(probes.locateResource).toHaveBeenCalledOnce();
    await select(s.root, '选择链路 PL-001'); expect(probes.locateResource).toHaveBeenCalledTimes(2);
    await click(s.root, '图层管理'); await toggle(s.root, '规划后链路', false);
    expect(s.map().showLinks).toBe(false); expect(s.map().selectedLinkId).toBe('PL-001'); expect(s.storage.writes).toBe(0);
  });
  it.each(['设备', '链路'])('从监控目录选择%s取消时不切模式，不改变筛选或图层', async kind => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await change(s.root, 'HF设备透明度', '0.4', 'onInput');
    await toggle(s.root, '规划后链路', false);
    // 资源树页签会返回资源地图；先展示目录，再从监控中点具体对象验证原关闭保护。
    await click(s.root, '资源树'); const id = kind === '设备' ? 'DV-0027' : 'PL-001'; await search(s.root, id);
    s.monitor.showNetwork(); await settleMonitoring();
    const before = JSON.stringify([s.map().stations, s.map().links, s.map().selectedId, s.map().selectedLinkId]);
    vi.spyOn(s.editor, 'closeForm').mockResolvedValueOnce(false);
    await select(s.root, '选择' + kind + ' ' + id);
    expect(s.gis.mapMode).toBe('monitoring'); expect(JSON.stringify([s.map().stations, s.map().links, s.map().selectedId, s.map().selectedLinkId])).toBe(before);
    expect(find(s.root, row => row.props['aria-label'] === '搜索资源')!.props.value).toBe(id);
    await click(s.root, '资源树'); expect(frame(s)!.selectedDeviceId).toBe('DV-0001');
    expect(frame(s)!.settings.HF.opacity).toBe(0.4); expect(s.map().showLinks).toBe(false);
  });
  it.each(['身份', '版本', '快照', '模式', '归属', '权限'])('设备确认等待期间改变%s后拒绝旧选择', async kind => {
    const s = await mountEntry(); await search(s.root, 'DV-0027');
    let done!: (value: boolean) => void;
    vi.spyOn(s.editor, 'closeForm').mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    action(s.root, '选择设备 DV-0027')(); await nextTick();
    if (kind === '身份') useAuthStore().generation++;
    if (kind === '版本') s.gis.scene!.resourceMeta.revision = 'NEW';
    if (kind === '快照') s.gis.scene!.situation.snapshotId = 'NEW';
    if (kind === '模式') { s.gis.mapMode = 'analysis'; s.gis.mapMode = 'resource'; }
    if (kind === '归属') s.directory().resources.devices.find(row => row.id === 'DV-0027')!.stationId = 'ND-0001';
    if (kind === '权限') useAuthStore().identity!.permissions = [];
    done(true); await settleMonitoring();
    expect(s.map().selectedId).toBe('ND-0001');
    if (kind !== '权限') expect(frame(s)!.selectedDeviceId).toBe('DV-0001');
    expect(s.storage.writes).toBe(0);
  });
  it.each(['身份', '版本', '模式', '端点', '资源失效'])('链路确认等待期间改变%s后不恢复旧链路', async kind => {
    const s = await mountEntry(); await search(s.root, 'PL-001');
    let done!: (value: boolean) => void;
    vi.spyOn(s.editor, 'closeForm').mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    action(s.root, '选择链路 PL-001')(); await nextTick();
    if (kind === '身份') useAuthStore().generation++;
    if (kind === '版本') s.gis.scene!.resourceMeta.revision = 'NEW';
    if (kind === '模式') { s.gis.mapMode = 'analysis'; s.gis.mapMode = 'resource'; }
    if (kind === '端点') s.gis.scene!.situation.links[0].deviceA = 'DV-0002';
    if (kind === '资源失效') s.gis.scene!.resourceMeta.changedDeviceIds.push('DV-0001');
    done(true); await settleMonitoring(); expect(s.map().selectedLinkId).toBeUndefined();
    expect(s.map().selectedId).toBe('ND-0001'); expect(s.storage.writes).toBe(0);
  });
  it('旧链路和错配链路的目录禁用，直接调用旧按钮也不能关闭表单或恢复结果', async () => {
    const s = await mountEntry(), stale = action(s.root, '选择链路 PL-001');
    s.gis.scene!.resourceMeta.changedDeviceIds.push('DV-0001'); await nextTick();
    const close = vi.spyOn(s.editor, 'closeForm'); stale(); await settleMonitoring();
    expect(close).not.toHaveBeenCalled(); expect(s.map().showLinks).toBe(false);
    expect(find(s.root, row => row.props['aria-label'] === '选择链路 PL-001')!.props.disabled).toBe(true);
    expect(textOf(s.root)).toContain('旧链路暂不可用');
    s.gis.scene!.resourceMeta.changedDeviceIds = []; s.gis.scene!.situation.links[0].deviceA = 'DV-0027'; await nextTick();
    expect(find(s.root, row => row.props['aria-label'] === '选择链路 PL-001')!.props.disabled).toBe(true);
    await select(s.root, '选择链路 PL-001'); expect(close).not.toHaveBeenCalled(); expect(s.map().selectedLinkId).toBeUndefined();
  });
  it('干扰分析目录显式选链路后回到普通资源详情，不修改冻结分析', async () => {
    const s = await mountEntry('DV-0001', true), analysis = await enterAnalysis(s);
    const before = JSON.stringify(analysis.selected);
    expect(analysisMap(s.root).interferenceProjection).toEqual(analysis.mapProjection);
    await returnFromAnalysis(s); await search(s.root, 'PL-001');
    await select(s.root, '选择链路 PL-001'); expect(s.gis.mapMode).toBe('resource'); expect(s.map().selectedLinkId).toBe('PL-001');
    expect(JSON.stringify(analysis.selected)).toBe(before); expect(s.storage.writes).toBe(0);
  });
});

describe('普通 GIS 设备点位与聚合清单接入', () => {
  const frame = (s: Awaited<ReturnType<typeof mountEntry>>) => s.map().gisDeviceFrame as GisDeviceMapFrame | undefined;
  const list = (root: HostNode) => find(root, row => row.props['aria-label'] === '聚合设备清单');
  async function open(s: Awaited<ReturnType<typeof mountEntry>>, ids = ['DV-0001', 'DV-0002']) {
    (s.map().selectDeviceCluster as (ids: string[], version: number) => void)(ids, frame(s)!.version); await nextTick();
  }
  async function pick(s: Awaited<ReturnType<typeof mountEntry>>, id: string, version = frame(s)!.version) {
    (s.map().selectDevice as (id: string, version: number) => void)(id, version); await settleMonitoring(); await nextTick();
  }
  it('点位直接选择精确设备与所属站点，聚合打开不切换原对象，选择后沿用详情和关联链路', async () => {
    const s = await mountEntry(), before = JSON.stringify(s.preview.data);
    expect(frame(s)!.points).toHaveLength(414); await open(s);
    expect(list(s.root)).toBeDefined(); expect(frame(s)!.selectedDeviceId).toBe('DV-0001');
    const target = find(s.root, row => row.props['aria-label'] === '查看聚合设备 DV-0002')!;
    await (target.props.onClick as () => unknown)(); await vi.waitFor(() => expect(frame(s)!.selectedDeviceId).toBe('DV-0002'));
    expect(frame(s)!.selectedDeviceId).toBe('DV-0002'); expect(s.map().highlightLinkIds).toEqual([]); expect(list(s.root)).toBeUndefined();
    await pick(s, 'DV-0027'); expect(s.map().selectedId).toBe('ND-0003'); expect(frame(s)!.selectedDeviceId).toBe('DV-0027');
    expect(s.map().highlightLinkIds).toEqual(['PL-001', 'PL-005', 'PL-006', 'PL-007']);
    expect(JSON.stringify(s.preview.data)).toBe(before); expect(s.storage.writes).toBe(0);
  });
  it('取消切换保留草稿/清单/覆盖，确认应用原表单后可选择仍有效的成员', async () => {
    const s = await mountEntry(); await click(s.root, '查看覆盖'); await s.gis.begin();
    await s.editor.openForm('device', 'DV-0001'); s.editor.form!.fields.antennaHeightM = '19'; await nextTick();
    await open(s); const before = JSON.stringify(s.editor.form);
    const button = find(s.root, row => row.props['aria-label'] === '查看聚合设备 DV-0002')!;
    const action = button.props.onClick as () => Promise<unknown>;
    const first = action(); await nextTick(); expect(s.editor.decision).not.toBeNull(); s.editor.answer('cancel'); await first; await nextTick();
    expect(JSON.stringify(s.editor.form)).toBe(before); expect(frame(s)!.selectedDeviceId).toBe('DV-0001'); expect(list(s.root)).toBeDefined();
    const second = action(); await nextTick(); s.editor.answer('save'); await second; await settleMonitoring();
    expect(frame(s)!.selectedDeviceId).toBe('DV-0002'); expect(s.editor.form).toBeNull();
    expect(s.editor.resources.devices.find(row => row.id === 'DV-0001')!.antennaHeightM).toBe(19);
    expect((s.map().deviceCoverages as DeviceCoverageOverlay[])).toEqual([]); // 旧覆盖仍受已应用草稿保护。
    expect(s.storage.writes).toBe(0);
  });
  it('开关和设备状态只改变点位，保留链路、区域、覆盖及选中详情', async () => {
    const s = await mountEntry(); await click(s.root, '查看覆盖');
    const links = s.map().links, regions = s.map().regions, coverage = JSON.stringify(s.map().deviceCoverages);
    await change(s.root, 'HF设备透明度', '0.4', 'onInput'); await change(s.root, '显示HF设备', false);
    expect(frame(s)!.points.every(row => row.deviceClass === 'VUHF')).toBe(true);
    expect(textOf(s.root)).toContain('当前选中设备未在地图显示'); expect(frame(s)!.selectedDeviceId).toBe('DV-0001');
    await change(s.root, '设备点位状态', 'FAULT'); expect(frame(s)!.points.every(row => row.status === 'FAULT')).toBe(true);
    expect(s.map().links).toEqual(links); expect(s.map().regions).toEqual(regions); expect(JSON.stringify(s.map().deviceCoverages)).toBe(coverage);
    await click(s.root, '资源树'); await click(s.root, '图层管理'); expect(frame(s)!.settings.HF).toEqual({ visible: false, opacity: 0.4 });
  });
  it('未应用表单不伪装已应用资源，应用站点草稿更新设备位置且不恢复旧业务结果', async () => {
    const s = await mountEntry(); await s.gis.begin(); await s.editor.openForm('station', 'ND-0001');
    const saved = [...s.preview.data!.resources.stations[0].coordinate], longitude = saved[0] + 0.005;
    // 原表单只开放站点位置和设备参数，不将运行状态误当作可编辑字段。
    s.editor.form!.fields.longitude = String(longitude); await nextTick(); expect(frame(s)!.points.find(row => row.id === 'DV-0001')!.coordinate).toEqual(saved);
    expect(s.editor.applyForm()).toBe(true); await nextTick();
    expect(frame(s)!.points.find(row => row.id === 'DV-0001')!.coordinate).toEqual([longitude, saved[1]]);
    expect(s.map().showLinks).toBe(false); expect(s.map().showCoverage).toBe(false); expect(s.preview.data!.resources.stations[0].coordinate).toEqual(saved);
  });
  it('陈旧帧、隐藏成员和无权限事件不能打开清单或关闭正在编辑的表单', async () => {
    const s = await mountEntry(), stale = frame(s)!.version; await click(s.root, '图层管理');
    await change(s.root, '显示HF设备', false); const close = vi.spyOn(s.editor, 'closeForm');
    await pick(s, 'DV-0002', stale); await pick(s, 'DV-0002'); expect(close).not.toHaveBeenCalled();
    (s.map().selectDeviceCluster as Function)(['DV-0001', 'DV-0002'], stale); await nextTick(); expect(list(s.root)).toBeUndefined();
    useAuthStore().identity!.permissions = []; await nextTick(); expect(frame(s)).toBeUndefined();
    await pick(s, 'DV-0033', stale); expect(close).not.toHaveBeenCalled();
  });
  it.each(['身份', '来源', '模式', '归属'])('确认等待期改变%s后拒绝原选择', async kind => {
    const s = await mountEntry(); let done!: (ok: boolean) => void;
    vi.spyOn(s.editor, 'closeForm').mockImplementationOnce(() => new Promise<boolean>(resolve => { done = resolve; }));
    (s.map().selectDevice as Function)('DV-0002', frame(s)!.version); await nextTick();
    if (kind === '身份') useAuthStore().generation++;
    if (kind === '来源') s.gis.scene!.resourceMeta.revision = 'changed';
    if (kind === '模式') { s.gis.mapMode = 'analysis'; await nextTick(); s.gis.mapMode = 'resource'; }
    if (kind === '归属') s.gis.scene!.map.devices.find(row => row.id === 'DV-0002')!.stationId = 'ND-0003';
    done(true); await settleMonitoring(); expect(frame(s)!.selectedDeviceId).toBe('DV-0001');
  });
  it('模式往返保留显示偏好但关闭清单，冻结网络不接入设备实例层', async () => {
    const s = await mountEntry('DV-0001', true); await click(s.root, '图层管理'); await change(s.root, 'HF设备透明度', '0.3', 'onInput'); await open(s);
    s.monitor.showNetwork(); await settleMonitoring(); expect(frame(s)).toBeUndefined(); expect(list(s.root)).toBeUndefined();
    await click(s.root, '资源树'); expect(frame(s)!.settings.HF.opacity).toBe(0.3);
    await enterAnalysis(s);
    expect(analysisMap(s.root).gisDeviceFrame).toBeUndefined(); expect(list(s.root)).toBeUndefined();
    await returnFromAnalysis(s); expect(frame(s)!.settings.HF.opacity).toBe(0.3);
    useAuthStore().generation++; await nextTick(); expect(frame(s)!.settings.HF.opacity).toBe(1); expect(s.storage.writes).toBe(0);
  });
  it('新页面恢复默认，聚合清单不写入业务存储', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await change(s.root, '显示HF设备', false);
    await s.router.push('/planning'); await nextTick(); await s.router.push('/situation?stationId=ND-0001'); await settleMonitoring();
    expect(frame(s)!.settings.HF).toEqual({ visible: true, opacity: 1 }); expect(list(s.root)).toBeUndefined(); expect(s.storage.writes).toBe(0);
  });
});

describe('GIS 三组结果图层页面接入', () => {
  const layers = (s: Awaited<ReturnType<typeof mountEntry>>) => s.map().gisResultLayers as GisResultLayerSettings;
  async function analysisMode(s: Awaited<ReturnType<typeof mountEntry>>) {
    return enterAnalysis(s);
  }
  it('独立开关和透明度经过实际面板；设备入口只恢复覆盖，保留选中对象和业务数据', async () => {
    const s = await mountEntry(), before = JSON.stringify(s.preview.data), submit = vi.spyOn(previewService, 'submitPlanning');
    await click(s.root, '图层管理'); await change(s.root, '显示信号覆盖', false);
    await change(s.root, '信号覆盖透明度', '0.4', 'onInput'); await change(s.root, '显示原有影响示意区域', false);
    await change(s.root, '原有影响示意区域透明度', '0.3', 'onInput');
    expect(layers(s).coverage).toEqual({ visible: false, opacity: 0.4 });
    await click(s.root, '查看覆盖'); expect(layers(s).coverage).toEqual({ visible: true, opacity: 0.4 });
    expect(layers(s).illustration).toEqual({ visible: false, opacity: 0.3 }); expect(s.map().selectedId).toBe('ND-0001');
    expect(JSON.stringify(s.preview.data)).toBe(before); expect(s.storage.writes).toBe(0); expect(submit).not.toHaveBeenCalled();
  });
  it('整网/单台/多台、页签和收起面板均保留三组偏好与逐台配置', async () => {
    const s = await mountEntry(); await click(s.root, '查看覆盖');
    await change(s.root, '信号覆盖透明度', '0.5', 'onInput'); await change(s.root, '显示原有影响示意区域', false);
    await change(s.root, '覆盖设备范围', 'multiple'); await change(s.root, '叠加 DV-0001', true);
    await change(s.root, 'DV-0001 覆盖透明度', '0.4', 'onInput'); await change(s.root, '显示 DV-0001', false);
    await change(s.root, '覆盖设备范围', 'network'); await change(s.root, '覆盖设备范围', 'multiple');
    await click(s.root, '资源树'); await click(s.root, '图层管理');
    const collapse = find(s.root, row => row.props['aria-label'] === '收起资源面板')!;
    await (collapse.props.onClick as () => unknown)(); await nextTick(); await click(s.root, '资源');
    expect(layers(s).coverage.opacity).toBe(0.5); expect(layers(s).illustration.visible).toBe(false);
    expect((s.map().deviceCoverages as DeviceCoverageOverlay[])[0]).toMatchObject({ visible: false, opacity: 0.4 });
    expect(s.storage.writes).toBe(0);
  });
  it('未知设备不回退整网，原有示意仍独立显示；新设备样例恢复覆盖偏好', async () => {
    const s = await mountEntry('DV-0002'); await click(s.root, '查看覆盖');
    expect(layers(s).coverage.visible).toBe(false); expect(layers(s).illustration.visible).toBe(true);
    expect(s.map().deviceCoverageActive).toBe(true); expect(s.map().deviceCoverages).toEqual([]);
    expect(find(s.root, row => row.props['aria-label'] === '显示信号覆盖')!.props.disabled).toBe(true);
    await change(s.root, '单台覆盖设备', 'DV-0033'); expect(layers(s).coverage.visible).toBe(true);
  });
  it('草稿暂停所有原区域且不能重新开启，恢复输入后沿用原显示偏好', async () => {
    const s = await mountEntry(); await click(s.root, '查看覆盖'); await change(s.root, '原有影响示意区域透明度', '0.2', 'onInput');
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001'); s.editor.form!.fields.antennaHeightM = '19'; await nextTick();
    const input = JSON.stringify(s.editor.form); await change(s.root, '显示信号覆盖', true); await change(s.root, '显示原有影响示意区域', true);
    expect(Object.values(layers(s)).every(row => !row.visible)).toBe(true); expect(JSON.stringify(s.editor.form)).toBe(input);
    s.editor.form!.fields.antennaHeightM = s.editor.form!.initial.antennaHeightM; await nextTick();
    expect(layers(s).illustration).toEqual({ visible: true, opacity: 0.2 }); expect(s.map().deviceCoverageActive).toBe(true);
  });
  it('监控不显示区域，分析使用冻结来源和等级筛选，返回设备模式保留各自偏好', async () => {
    const s = await mountEntry('DV-0001', true); await click(s.root, '查看覆盖'); await change(s.root, '信号覆盖透明度', '0.5', 'onInput');
    await change(s.root, '显示原有影响示意区域', false);
    s.monitor.showNetwork(); await settleMonitoring(); expect(Object.values(layers(s)).every(row => !row.visible)).toBe(true);
    expect(s.map().regions).toEqual([]); expect(textOf(s.root)).toContain('监控网络不提供此类区域');
    const analysis = await analysisMode(s), impact = JSON.stringify(analysis.impact);
    expect(analysisMap(s.root).interferenceProjection).toEqual(analysis.mapProjection);
    expect(analysisMap(s.root).gisResultLayers).toBeUndefined();
    analysis.levels = []; await nextTick(); expect(analysis.filteredImpact?.affected_links).toEqual([]);
    expect(analysis.filteredImpact?.affected_nodes).toEqual([]); expect(JSON.stringify(analysis.impact)).toBe(impact);
    s.gis.scene!.resourceMeta.changedDeviceIds.push('DV-0001'); await nextTick();
    expect(analysisMap(s.root).interferenceProjection).toEqual(analysis.mapProjection);
    s.gis.scene!.resourceMeta.changedDeviceIds = []; await returnFromAnalysis(s);
    expect((s.map().deviceCoverages as DeviceCoverageOverlay[])[0].sample.deviceId).toBe('DV-0001');
    expect(layers(s).illustration.visible).toBe(false); expect(layers(s).coverage.opacity).toBe(0.5);
    expect(s.storage.writes).toBe(0); s.wb.assertNoWrites();
  });
  it('权限丢失暂停区域，身份更换及离页重进恢复默认配置', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await change(s.root, '信号覆盖透明度', '0.2', 'onInput');
    const auth = useAuthStore(), permissions = [...auth.identity!.permissions];
    auth.identity!.permissions = permissions.filter(p => p !== 'situation.view'); await nextTick();
    expect(Object.values(layers(s)).every(row => !row.visible)).toBe(true);
    auth.identity!.permissions = permissions; await nextTick(); expect(layers(s).coverage.opacity).toBe(0.2);
    auth.generation++; await nextTick(); expect(layers(s).coverage).toEqual({ visible: true, opacity: 0.8 });
    await change(s.root, '显示信号覆盖', false); await s.router.push('/planning'); await nextTick();
    await s.router.push('/situation?stationId=ND-0001&deviceId=DV-0001'); await settleMonitoring();
    expect(layers(s).coverage).toEqual({ visible: true, opacity: 0.8 }); expect(s.storage.writes).toBe(0);
  });
});

describe('普通 GIS 链路点选详情接入', () => {
  const detail = (root: HostNode) => find(root, row => row.props['aria-label'] === 'GIS 链路详情');
  async function selectLink(s: Awaited<ReturnType<typeof mountEntry>>, id: string) {
    (s.map().selectLink as (id: string) => void)(id); await settleMonitoring(); await nextTick();
  }
  it('七条规划链路可选且复用地图定位参数；候选或不存在的 ID 不影响当前选择', async () => {
    const s = await mountEntry(), before = JSON.stringify(s.preview.data), submit = vi.spyOn(previewService, 'submitPlanning');
    expect(s.map().selectLinks).toBe(true);
    for (const link of s.gis.scene!.situation.links) {
      await selectLink(s, link.id); expect(s.map().selectedLinkId).toBe(link.id); expect(s.map().highlightLinkIds).toEqual([link.id]);
      expect(s.map().selectedId).toBe(''); expect(textOf(detail(s.root)!)).toContain(link.deviceA); expect(textOf(detail(s.root)!)).toContain(link.deviceB);
    }
    await selectLink(s, 'CL-DEMO-01'); await selectLink(s, 'UNKNOWN');
    expect(s.map().selectedLinkId).toBe('PL-007'); expect(s.gis.mapMode).toBe('resource');
    expect(JSON.stringify(s.preview.data)).toBe(before); expect(s.storage.writes).toBe(0); expect(submit).not.toHaveBeenCalled();
  });
  it('站点、设备和干扰源与链路互斥，取消切换保留链路详情', async () => {
    const s = await mountEntry(); await selectLink(s, 'PL-001');
    const close = vi.spyOn(s.editor, 'closeForm').mockResolvedValueOnce(false);
    (s.map().select as (id: string) => void)('ND-0003'); await settleMonitoring();
    expect(s.map().selectedLinkId).toBe('PL-001'); expect(detail(s.root)).toBeDefined(); close.mockRestore();
    (s.map().select as (id: string) => void)('ND-0003'); await settleMonitoring();
    expect(s.map().selectedLinkId).toBeUndefined(); expect(detail(s.root)).toBeUndefined();
    await change(s.root, '选择节点设备', 'DV-0027'); await settleMonitoring();
    expect(s.map().highlightLinkIds).toEqual(['PL-001', 'PL-005', 'PL-006', 'PL-007']);
    await selectLink(s, 'PL-003'); expect(s.map().highlightLinkIds).toEqual(['PL-003']);
    const source = s.preview.data!.resources.interferences![0];
    const button = find(s.root, row => row.tag === 'button' && textOf(row).includes(source.id))!;
    await (button.props.onClick as () => unknown)(); await settleMonitoring();
    expect(s.map().selectedInterferenceId).toBe(source.id); expect(s.map().selectedLinkId).toBeUndefined(); expect(detail(s.root)).toBeUndefined();
  });
  it('原关闭保护拒绝时保留表单，资源已脏的陈旧链路事件不能再关闭输入', async () => {
    const s = await mountEntry(); await s.gis.begin(); await s.editor.openForm('device', 'DV-0001');
    const before = JSON.stringify(s.editor.form), close = vi.spyOn(s.editor, 'closeForm').mockResolvedValueOnce(false);
    await selectLink(s, 'PL-002'); expect(close).toHaveBeenCalledOnce(); expect(JSON.stringify(s.editor.form)).toBe(before);
    expect(s.map().selectedId).toBe('ND-0001'); expect(s.map().selectedLinkId).toBeUndefined();
    s.editor.form!.fields.antennaHeightM = '19'; await nextTick(); const input = JSON.stringify(s.editor.form);
    await selectLink(s, 'PL-002'); expect(close).toHaveBeenCalledOnce(); expect(JSON.stringify(s.editor.form)).toBe(input);
    expect(s.map().selectLinks).toBe(false); expect(s.map().showLinks).toBe(false);
    s.editor.form!.fields.antennaHeightM = s.editor.form!.initial.antennaHeightM; close.mockRestore(); await nextTick();
    await selectLink(s, 'PL-002'); expect(s.map().selectedLinkId).toBe('PL-002'); expect(s.editor.form).toBeNull(); expect(s.storage.writes).toBe(0);
  });
  it('等待关闭期间更换快照或身份，不接受旧事件', async () => {
    const s = await mountEntry(); let resolve!: (ok: boolean) => void;
    const close = vi.spyOn(s.editor, 'closeForm').mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
    (s.map().selectLink as (id: string) => void)('PL-001'); await nextTick();
    s.gis.scene!.situation.snapshotId = 'NET-NEW'; resolve(true); await settleMonitoring();
    expect(s.map().selectedLinkId).toBeUndefined(); expect(s.map().selectedId).toBe('ND-0001');
    close.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done; }));
    (s.map().selectLink as (id: string) => void)('PL-001'); await nextTick();
    useAuthStore().generation++; resolve(true); await settleMonitoring(); expect(s.map().selectedLinkId).toBeUndefined();
  });
  it('筛选与关闭图层保留详情及趋势，不自动清除条件或开启图层', async () => {
    const s = await mountEntry(); await selectLink(s, 'PL-003'); await expandHistory(s.root);
    await click(s.root, '图层管理'); await change(s.root, '显示规划后链路', false); await click(s.root, '资源树');
    const search = find(s.root, row => row.props['aria-label'] === '搜索资源')!;
    (search.props.onInput as (event: unknown) => void)({ target: { value: '不存在' } }); await nextTick();
    expect(s.map().stations).toEqual([]); expect(textOf(detail(s.root)!)).toContain('详情已保留');
    expect(find(s.root, row => row.tag === 'chart-probe')).toBeDefined();
    await selectLink(s, 'PL-001'); expect(s.map().selectedLinkId).toBe('PL-003'); expect(s.map().stations).toEqual([]);
    await click(s.root, '图层管理');
    await click(s.root, '清除筛选'); expect(s.map().showLinks).toBe(false); expect(detail(s.root)).toBeDefined();
    await selectLink(s, 'PL-001'); expect(s.map().selectedLinkId).toBe('PL-003'); expect(s.storage.writes).toBe(0);
  });
  it('资源变更暂停旧指标和高亮，更换快照或移除链路清理过时选择', async () => {
    const s = await mountEntry(); await selectLink(s, 'PL-002'); await expandHistory(s.root);
    await s.gis.begin(); s.editor.resources.devices[0].txPowerDbm = 0; await nextTick();
    expect(textOf(detail(s.root)!)).toContain('资源存在未保存修改'); expect(find(s.root, row => row.tag === 'chart-probe')).toBeUndefined();
    expect(s.map().selectedLinkId).toBeUndefined(); expect(s.map().highlightLinkIds).toEqual([]);
    s.editor.resources.devices[0].txPowerDbm = s.preview.data!.resources.devices[0].txPowerDbm; await nextTick();
    expect(s.map().selectedLinkId).toBe('PL-002');
    s.gis.scene!.resourceMeta.interferenceVersion = 'changed'; await nextTick();
    expect(textOf(detail(s.root)!)).toContain('资源已变更'); expect(s.map().selectLinks).toBe(false);
    s.gis.scene!.resourceMeta.interferenceVersion = 'initial'; await nextTick();
    s.gis.scene!.situation.snapshotId = 'OTHER'; await nextTick(); expect(detail(s.root)).toBeUndefined();
    s.gis.scene!.situation.snapshotId = 'NET-DEMO-03'; await nextTick(); await selectLink(s, 'PL-001');
    s.gis.scene!.situation.links = s.gis.scene!.situation.links.filter(link => link.id !== 'PL-001'); await nextTick();
    expect(detail(s.root)).toBeUndefined(); expect(s.map().selectedLinkId).toBeUndefined();
  });
  it('缺资料仍允许查看基础详情，权限丢失后不暴露指标或接受链路点选', async () => {
    const s = await mountEntry(); vi.mocked(previewService.getGisLinkDetails).mockResolvedValue({...s.gis.scene!.linkDetails,state:'missing',records:[],message:'暂无当前网络的链路指标与历史资料。'}); await selectLink(s, 'PL-001');
    expect(textOf(detail(s.root)!)).toContain('暂无当前网络'); expect(textOf(detail(s.root)!)).toContain('DV-0001');
    const auth = useAuthStore(); auth.identity!.permissions = auth.identity!.permissions.filter(p => p !== 'situation.view'); await nextTick();
    expect(s.map().selectLinks).toBe(false); expect(s.map().highlightLinkIds).toEqual([]);
    expect(textOf(detail(s.root)!)).toContain('没有 GIS 查看权限'); await selectLink(s, 'PL-002');
    authorizeStore(); await nextTick(); expect(s.map().selectedLinkId).toBe('PL-001'); expect(s.storage.writes).toBe(0);
  });
  it('监控和干扰分析使用自己的网络与选择，返回资源视图恢复原链路', async () => {
    const s = await mountEntry('DV-0001', true); await selectLink(s, 'PL-002');
    const baseline = s.gis.scene!.situation.links;
    s.monitor.showNetwork(); await settleMonitoring(); expect(detail(s.root)).toBeUndefined(); expect(s.map().selectedLinkId).not.toBe('PL-002');
    expect(s.map().links).not.toEqual(baseline); await click(s.root, '资源树'); expect(s.map().selectedLinkId).toBe('PL-002');
    await enterAnalysis(s);
    expect(detail(s.root)).toBeUndefined(); expect(analysisMap(s.root).selectedLinkId).not.toBe('PL-002');
    const analysisId = s.wb.network.links[0]!.id;
    await clickWorkbench(s.root, row => workbenchText(row).startsWith(`${analysisId} ·`));
    expect(analysisMap(s.root).selectedLinkId).toBe(analysisId);
    await returnFromAnalysis(s); expect(s.map().selectedLinkId).toBe('PL-002'); expect(detail(s.root)).toBeDefined();
    expect(s.gis.scene!.situation.links).toEqual(baseline); expect(s.storage.writes).toBe(0);
  });
});

describe('GIS 拓扑独立透明度和上下文保护', () => {
  const control = (root: HostNode, label = '拓扑透明度') => find(root, row => row.props['aria-label'] === label)!;
  const opacity = (root: HostNode, value: string) => change(root, '拓扑透明度', value, 'onInput');
  const mapLink = (s: Awaited<ReturnType<typeof mountEntry>>) => s.map().selectLink as (id: string) => void;
  const detail = (root: HostNode) => find(root, row => row.props['aria-label'] === 'GIS 链路详情');
  const requests = () => [previewService.loadPreview, previewService.loadInterferenceWorkspace,
    previewService.loadMonitoringContext, previewService.getMonitoringFrame].map(fn => vi.mocked(fn).mock.calls.length);
  async function analysisMode(s: Awaited<ReturnType<typeof mountEntry>>) {
    return enterAnalysis(s);
  }
  it('默认 100%，0/中间值/1 只调整拓扑显示；拒绝空白、非数与越界输入', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理');
    expect(control(s.root).props).toMatchObject({ min: '0', max: '1', step: '0.1', value: 1, disabled: false });
    const data = JSON.stringify(s.preview.data), layers = JSON.stringify(s.map().gisResultLayers), devices = s.map().gisDeviceFrame;
    const inputs = Object.fromEntries(['deviceCoverages', 'demands', 'highlightLinkIds', 'highlightStationIds', 'diagnosisDevices', 'diagnosisFaults', 'diagnosisRegions', 'candidateLinks'].map(key => [key, s.map()[key]]));
    const counts = requests(), fits = probes.locateResource.mock.calls.length, submit = vi.spyOn(previewService, 'submitPlanning');
    for (const value of ['0', '0.3', '1']) {
      await opacity(s.root, value); expect(s.map().topologyOpacity).toBe(Number(value));
      expect(s.map().selectLinks).toBe(value !== '0'); expect(control(s.root).props.disabled).toBe(false);
      // 父模板不得因滑块重渲染制造新数组，触发 MapCanvas 重建图片和其他图层。
      for (const [key, reference] of Object.entries(inputs)) expect(s.map()[key], key).toBe(reference);
    }
    await opacity(s.root, '0.3');
    for (const value of ['', ' ', 'NaN', 'Infinity', '-0.1', '1.1']) {
      await opacity(s.root, value); expect(s.map().topologyOpacity).toBe(0.3);
    }
    expect(JSON.stringify(s.map().gisResultLayers)).toBe(layers); expect(s.map().gisDeviceFrame).toBe(devices);
    expect(JSON.stringify(s.preview.data)).toBe(data); expect(requests()).toEqual(counts);
    expect(probes.locateResource).toHaveBeenCalledTimes(fits); expect(submit).not.toHaveBeenCalled(); expect(s.storage.writes).toBe(0);
  });
  it('零透明度保留详情趋势和输入，地图旧线事件不触发关闭确认，树选择仍定位', async () => {
    const s = await mountEntry(); mapLink(s)('PL-003'); await settleMonitoring(); await expandHistory(s.root);
    const staleMap = mapLink(s); await click(s.root, '图层管理'); await opacity(s.root, '0');
    expect(detail(s.root)).toBeDefined(); expect(textOf(detail(s.root)!)).toContain('详情已保留');
    expect(find(s.root, row => row.tag === 'chart-probe')).toBeDefined(); expect(textOf(s.root)).toContain('拓扑透明度为 0');
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001'); await nextTick();
    const form = JSON.stringify(s.editor.form), close = vi.spyOn(s.editor, 'closeForm').mockResolvedValue(false);
    staleMap('PL-001'); mapLink(s)('PL-002'); await settleMonitoring(); expect(close).not.toHaveBeenCalled();
    expect(JSON.stringify(s.editor.form)).toBe(form); expect(s.map().selectedLinkId).toBe('PL-003');
    await click(s.root, '资源树'); await change(s.root, '搜索资源', 'PL-001', 'onInput');
    const select = () => (find(s.root, row => row.props['aria-label'] === '选择链路 PL-001')!.props.onClick as () => void)();
    select(); await settleMonitoring(); expect(close).toHaveBeenCalledOnce(); expect(s.map().selectedLinkId).toBe('PL-003');
    close.mockRestore(); probes.locateResource.mockClear(); select(); await settleMonitoring();
    expect(s.map().selectedLinkId).toBe('PL-001'); expect(s.map().topologyOpacity).toBe(0); expect(probes.locateResource).toHaveBeenCalledOnce();
    expect(s.editor.form).toBeNull(); expect(s.storage.writes).toBe(0);
  });
  it('地图等待原关闭确认期间隐藏拓扑，迟到确认不采纳旧线条选择', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理');
    let resolve!: (value: boolean) => void;
    const close = vi.spyOn(s.editor, 'closeForm').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    mapLink(s)('PL-001'); await nextTick(); expect(close).toHaveBeenCalledOnce();
    await opacity(s.root, '0'); resolve(true); await settleMonitoring();
    expect(s.map().selectedLinkId).toBeUndefined(); expect(s.map().selectedId).toBe('ND-0001'); expect(s.map().topologyOpacity).toBe(0);
  });
  it.each(['模式往返', '资源版本往返', '权限往返', '会话变化'] as const)('%s使旧滑块、开关及地图线事件失效', async kind => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await opacity(s.root, '0.3');
    const oldOpacity = control(s.root).props.onInput as (event: unknown) => void;
    const oldToggle = control(s.root, '显示规划后链路').props.onChange as (event: unknown) => void, oldMap = mapLink(s);
    const auth = useAuthStore();
    if (kind === '模式往返') { s.gis.mapMode = 'analysis'; s.gis.mapMode = 'resource'; }
    if (kind === '资源版本往返') { const version = s.gis.scene!.resourceMeta.revision; s.gis.scene!.resourceMeta.revision = 'changed'; s.gis.scene!.resourceMeta.revision = version; }
    if (kind === '权限往返') { const permissions = auth.identity!.permissions; auth.identity!.permissions = []; auth.identity!.permissions = permissions; }
    if (kind === '会话变化') auth.identity!.sessionId += '-new';
    await nextTick(); const expected = kind === '会话变化' ? 1 : 0.3;
    oldOpacity({ target: { value: '0' } }); oldToggle({ target: { checked: false } }); oldMap('PL-001'); await settleMonitoring();
    expect(s.map().topologyOpacity).toBe(expected); expect(s.map().showLinks).toBe(true); expect(s.map().selectedLinkId).toBeUndefined();
    await opacity(s.root, '0.7'); expect(s.map().topologyOpacity).toBe(0.7); expect(s.storage.writes).toBe(0);
  });
  it('缺少当前网络、筛选无链路和草稿暂停时禁用，不能借其他模式链路恢复显示', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await opacity(s.root, '0.3');
    s.gis.mapMode = 'analysis'; await nextTick(); expect(control(s.root).props.disabled).toBe(true);
    await opacity(s.root, '1'); expect(s.map().topologyOpacity).toBe(0.3); expect(s.map().showLinks).toBe(false);
    s.gis.mapMode = 'resource'; await click(s.root, '资源树'); await change(s.root, '搜索资源', '不存在', 'onInput'); await click(s.root, '图层管理');
    expect(control(s.root).props.disabled).toBe(true); expect(textOf(s.root)).toContain('筛选');
    await change(s.root, '显示规划后链路', false); await click(s.root, '清除筛选'); expect(s.map().showLinks).toBe(true);
    await s.gis.begin(); await s.editor.openForm('device', 'DV-0001'); s.editor.form!.fields.antennaHeightM = '19'; await nextTick();
    const form = JSON.stringify(s.editor.form); expect(control(s.root).props.disabled).toBe(true); await opacity(s.root, '0');
    expect(s.map().topologyOpacity).toBe(0.3); expect(JSON.stringify(s.editor.form)).toBe(form);
    s.editor.form!.fields.antennaHeightM = s.editor.form!.initial.antennaHeightM; await nextTick();
    expect(control(s.root).props.disabled).toBe(false); expect(s.map().showLinks).toBe(true);
  });
  it('同身份失权保留偏好并拒绝控件，换账号/会话或重入页面恢复默认', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await opacity(s.root, '0.3'); await change(s.root, '显示规划后链路', false);
    const auth = useAuthStore(), identity = structuredClone(Vue.toRaw(auth.identity!));
    auth.accept({ ...identity, permissions: identity.permissions.filter(row => row !== 'situation.view') }); await settleMonitoring();
    expect(control(s.root).props.disabled).toBe(true); await opacity(s.root, '0.8'); await change(s.root, '显示规划后链路', true);
    auth.accept(identity); await settleMonitoring(); expect(s.map().topologyOpacity).toBe(0.3); expect(s.map().showLinks).toBe(false);
    auth.accept({ ...identity, id: identity.id + '-other' }); await settleMonitoring();
    expect(s.map().topologyOpacity).toBe(1); expect(s.map().showLinks).toBe(true);
    await opacity(s.root, '0'); await change(s.root, '显示规划后链路', false);
    await s.router.push('/planning'); await nextTick(); await s.router.push('/situation?stationId=ND-0001&deviceId=DV-0001'); await settleMonitoring();
    expect(s.map().topologyOpacity).toBe(1); expect(s.map().showLinks).toBe(true); expect(s.storage.writes).toBe(0);
  });
  it('监控网络保留隐藏偏好，原清单选择和定位不受地图门禁影响，也不新增查询', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await opacity(s.root, '0'); await change(s.root, '显示规划后链路', false);
    s.monitor.showNetwork(); await settleMonitoring(); expect(control(s.root).props.disabled).toBe(false);
    const id = s.monitor.network!.links[0].id, counts = requests(); probes.locateResource.mockClear();
    mapLink(s)(id); await settleMonitoring(); expect(s.monitor.selectedLinkId).toBe('');
    s.monitor.selectLink(id); await settleMonitoring(); expect(s.monitor.selectedLinkId).toBe(id); expect(probes.locateResource).toHaveBeenCalled();
    await opacity(s.root, '0.5'); expect(s.map().showLinks).toBe(false); expect(s.map().topologyOpacity).toBe(0.5);
    await click(s.root, '资源树'); expect(s.map().topologyOpacity).toBe(0.5); expect(s.map().showLinks).toBe(false); expect(requests()).toEqual(counts);
  });
  it('监控网络身份往返后旧控件和同名链路回调失效，刷新观察值保留显示偏好', async () => {
    const s = await mountEntry(); s.monitor.showNetwork(); await settleMonitoring(); await click(s.root, '图层管理'); await opacity(s.root, '0.4');
    const oldOpacity = control(s.root).props.onInput as (event: unknown) => void, oldMap = mapLink(s), network = s.monitor.network!;
    const key = network.key, id = network.links[0].id;
    network.key = key + ':updated'; network.key = key; await nextTick();
    oldOpacity({ target: { value: '0' } }); oldMap(id); await settleMonitoring();
    expect(s.map().topologyOpacity).toBe(0.4); expect(s.monitor.selectedLinkId).toBe('');
    const count = vi.mocked(previewService.getMonitoringFrame).mock.calls.length;
    await opacity(s.root, '0.6'); expect(s.map().topologyOpacity).toBe(0.6);
    expect(previewService.getMonitoringFrame).toHaveBeenCalledTimes(count); expect(s.storage.writes).toBe(0);
  });
  it('新版措施前后只换冻结投影，普通资源旧控件不能改分析；清单仍能选链路', async () => {
    const s = await mountEntry('DV-0001', true); await click(s.root, '图层管理'); await opacity(s.root, '0.4');
    const oldOpacity = control(s.root).props.onInput as (event: unknown) => void, oldMap = mapLink(s);
    const analysis = await analysisMode(s), frozen = JSON.stringify(analysis.selected);
    await clickWorkbench(s.root, row => workbenchText(row).startsWith('P5 · 节点重部署'));
    await clickWorkbench(s.root, '措施后预测');
    expect(analysis.effectiveAfter).toBe(true); expect(analysis.mapProjection?.phase).toBe('PREVIEW');
    expect(analysis.mapProjection?.nodes.find(row => row.node_id === 'UNIT-N1')).toMatchObject({lon:116.2,lat:38.8});
    oldOpacity({target:{value:'0'}});oldMap('PL-001');await settleWorkbench();
    expect(analysisMap(s.root).interferenceProjection).toEqual(analysis.mapProjection);expect(analysisMap(s.root).selectedLinkId).toBe('');
    await clickWorkbench(s.root, row => workbenchText(row).startsWith('UNIT-L2 ·'));
    expect(analysisMap(s.root).selectedLinkId).toBe('UNIT-L2');
    const reads = s.wb.workbench.getRun.mock.calls.length;
    await clickWorkbench(s.root, '措施前');expect(analysis.mapProjection?.phase).toBe('BEFORE');
    expect(JSON.stringify(analysis.selected)).toBe(frozen);expect(s.wb.workbench.getRun).toHaveBeenCalledTimes(reads);
    await returnFromAnalysis(s);await click(s.root,'图层管理');expect(s.map().topologyOpacity).toBe(0.4);
    await opacity(s.root,'0');await change(s.root,'显示规划后链路',false);expect(s.map().showLinks).toBe(false);
    expect(s.storage.writes).toBe(0);s.wb.assertNoWrites();
  });
  it('新版分析宿主仍须保留影响区域开关及透明度，不能因换宿主丢掉原覆盖', async () => {
    const s=await mountEntry('DV-0001',true);await enterAnalysis(s);
    for(const label of ['显示干扰分析影响区域','干扰分析影响区域透明度','拓扑透明度','显示规划后链路']) {
      expect(find(s.root,row=>row.props['aria-label']===label),`${label}：需由新冻结宿主提供，不借旧资源控件替代`).toBeDefined();
    }
    s.wb.assertNoWrites();
  });
  it('措施前地图的迟到线条事件不能污染措施后选择', async () => {
    const s=await mountEntry('DV-0001',true);await enterAnalysis(s);
    const stale=analysisMap(s.root).selectFrozenLink as (id:string)=>void;
    await clickWorkbench(s.root,row=>workbenchText(row).startsWith('P5 · 节点重部署'));
    await clickWorkbench(s.root,'措施后预测');stale('UNIT-L1');await settleWorkbench();
    expect(analysisMap(s.root).selectedLinkId).toBe('');s.wb.assertNoWrites();
  });
});
