import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import SituationView from '../src/views/SituationView.vue';
import GisResourceTree from '../src/components/GisResourceTree.vue';
import GisDeviceLayerPanel from '../src/components/GisDeviceLayerPanel.vue';
import GisResultLayerPanel from '../src/components/GisResultLayerPanel.vue';
import DeviceCoveragePanel from '../src/components/DeviceCoveragePanel.vue';
import type { GisDeviceMapFrame } from '../src/maps/gis-device-display';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { usePreviewStore } from '../src/stores/preview';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useMonitoringStore } from '../src/stores/monitoring';
import { useInterferenceStore } from '../src/stores/interference';
import { usePlanningStore } from '../src/stores/planning';
import { demandLayer, linkLayer } from '../src/maps/layers';
import type { InterferenceSource, MapRegion, NetworkLink, Station } from '../src/types/domain';
import type { PlanningDemand } from '../src/types/planning';
import { planningPresets } from '../src/mocks/planning-presets';
import { authorizeStore } from './helpers/auth';
import { bindMonitoring, settleMonitoring } from './helpers/monitoring';
import { interferenceFixture } from './helpers/interference';
import { TestStorage } from './helpers/storage';

// 保留真实页面 setup、路由监听和挂载顺序，只替换画布与非入口业务组件。
vi.mock('../src/components/MapCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({
    inheritAttrs: false,
    props: ['gisDeviceFrame', 'stations', 'interferences', 'links', 'candidateLinks', 'demands', 'regions', 'interferenceImpact', 'selectedId', 'selectedInterferenceId', 'resourceMarkers'],
    setup(props, { expose }) {
      expose({ locate: () => {} });
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
vi.mock('../src/components/InterferenceAnalysisPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false, props: ['source'],
    setup: props => () => h('source-probe', { ...props }),
  }) };
});
vi.mock('../src/components/SituationMonitoringDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/MonitoringObjectPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/TaskWorkspacePanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/InterferenceHistoryDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/InterferenceMeasureDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
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
const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
const bindingMetadata = compileScript(descriptor, { id: 'situation-entry-test' }).bindings;
const compiled = compileTemplate({ source: descriptor.template!.content, filename, id: 'situation-entry-test',
  compilerOptions: { mode: 'function', bindingMetadata },
});
if (compiled.errors.length) throw new Error(compiled.errors.map(String).join('\n'));
const { code: renderFactory } = await transformWithEsbuild(
  `function createRender(Vue) { ${compiled.code} }`, 'situation-entry-render.ts', { loader: 'ts' },
);
const MountedSituationView = { ...SituationView, render: new Function('Vue', renderFactory + ';return createRender(Vue);')(Vue) };
// 本批控件也执行客户端模板，仍保留原详情探针核对定位身份。
for (const [component, deviceFile] of [
  [GisResourceTree, 'src/components/GisResourceTree.vue'],
  [GisDeviceLayerPanel, 'src/components/GisDeviceLayerPanel.vue'],
  [GisResultLayerPanel, 'src/components/GisResultLayerPanel.vue'],
  [DeviceCoveragePanel, 'src/components/DeviceCoveragePanel.vue'],
] as const) {
  const deviceDescriptor = parse(readFileSync(deviceFile, 'utf8'), { filename: deviceFile }).descriptor;
  const deviceBindings = compileScript(deviceDescriptor, { id: deviceFile }).bindings;
  const deviceTemplate = compileTemplate({ source: deviceDescriptor.template!.content, filename: deviceFile, id: deviceFile,
    compilerOptions: { mode: 'function', bindingMetadata: deviceBindings } });
  if (deviceTemplate.errors.length) throw new Error(deviceTemplate.errors.map(String).join('\n'));
  const deviceRender = await transformWithEsbuild(`function createRender(Vue) { ${deviceTemplate.code} }`, 'device-entry-render.ts', { loader: 'ts' });
  (component as Vue.ComponentOptions).render = new Function('Vue', deviceRender.code + ';return createRender(Vue);')(Vue);
}

// 内存宿主实际运行 Vue 挂载/更新/卸载；不模拟浏览器布局或 OpenLayers 点击。
interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown;
  addEventListener: () => void; removeEventListener: () => void;
  getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({
  tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
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
}
async function search(root: HostNode, query: string) {
  const input = findWhere(root, entry => entry.props['aria-label'] === '搜索资源')!;
  (input.props.onInput as (event: unknown) => void)({ target: { value: query } });
  await nextTick();
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
afterEach(() => {
  app?.unmount(); app = undefined;
  if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function mountEntry(url: string, editing = false) {
  vi.useFakeTimers();
  vi.stubGlobal('window', new EventTarget());
  class TestDocument extends EventTarget { hidden = false; activeElement = null; }
  vi.stubGlobal('Document', TestDocument);
  vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  // 新状态目录沿用本入口测试数据，避免误读真实浏览器会话。
  vi.spyOn(previewService, 'loadDeviceStatusContext').mockImplementation(raw.loadDeviceStatusContext);
  vi.spyOn(previewService, 'loadPreview').mockImplementation(raw.loadPreview);
  vi.spyOn(previewService, 'loadInterferenceWorkspace').mockImplementation(raw.loadInterferenceWorkspace);
  vi.spyOn(previewService, 'getDiagnosisReport').mockImplementation(raw.getDiagnosisReport);
  bindMonitoring(raw); await usePreviewStore().load();
  const gis = useGisWorkspaceStore(), editor = useResourceEditStore();
  if (editing) {
    gis.begin(); await editor.openForm('device', 'DV-0001', 'gis');
    editor.form!.fields.antennaHeightM = '19';
  }
  const before = [...storage.entries];
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/situation', component: MountedSituationView },
    { path: '/planning', component: { render: () => null } },
  ] });
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router);
  app.provide(ssrContextKey, {});
  await router.push(url); await router.isReady();
  const root = node('root'); app.mount(root); await settleMonitoring(); await nextTick();
  expect([...storage.entries]).toEqual(before);
  return { root, gis, editor, router, storage, before, monitor: useMonitoringStore(), map: () => find(root, 'map-probe')!.props };
}

describe('GIS 入口挂载联动', () => {
  // 默认不占用详情栏，但明确选择对象仍通过原监控联动展开。
  it('普通入口收起右侧详情，选择监控设备后显示对应面板', async () => {
    const s = await mountEntry('/situation');
    const detail = () => findWhere(s.root, row => String(row.props.class).includes('situation-right'));
    expect(detail()).toBeUndefined(); expect(s.monitor.open).toBe(true);
    s.monitor.selectDevice('DV-0001'); await settleMonitoring(); await nextTick();
    expect(detail()).toBeDefined(); expect(textOf(detail()!)).toContain('监控详情');
    expect(s.monitor.selectedDeviceId).toBe('DV-0001'); expect(s.storage.writes).toBe(0);
  });
  it('窄窗口切回资源面板仅收起详情，不清空选择和未保存表单', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    Object.assign(window, { matchMedia: () => ({ matches: true }) });
    s.gis.begin(); await s.editor.openForm('device', 'DV-0001', 'gis');
    s.editor.form!.fields.antennaHeightM = '19';
    const before = JSON.stringify(s.editor.form), selected = s.map().selectedId;
    await click(s.root, '资源');
    expect(findWhere(s.root, row => String(row.props.class).includes('situation-right'))).toBeUndefined();
    expect(s.map().selectedId).toBe(selected); expect(JSON.stringify(s.editor.form)).toBe(before);
    await click(s.root, '详情');
    expect(findWhere(s.root, row => String(row.props.class).includes('situation-right'))).toBeDefined();
    expect(JSON.stringify(s.editor.form)).toBe(before); expect(s.editor.formDirty).toBe(true);
    expect(s.storage.writes).toBe(0);
  });
  it.each(['/situation', '/situation?stationId=ND-0001', '/situation?diagnosisId=DG-HW'])(
    '没有分析记录时，%s 的分析按钮显示入口并退出原快照', async url => {
      const s = await mountEntry(url), analysis = useInterferenceStore();
      const submit = vi.spyOn(previewService, 'submitInterferenceAnalysis');
      expect(analysis.selected).toBeNull();
      await click(s.root, '干扰分析'); await settleMonitoring();
      expect(s.gis.mapMode).toBe('resource'); expect(s.map().resourceMarkers).toBe(true);
      expect(find(s.root, 'source-probe')).toBeDefined();
      expect(submit).not.toHaveBeenCalled(); expect(s.storage.writes).toBe(0);
    });
  it('已有分析记录时从监控切到选定快照，不自动重新分析', async () => {
    const s = await mountEntry('/situation');
    const fixture = await interferenceFixture(), submitted = await fixture.submit(); fixture.advance();
    const loaded = await fixture.service.loadInterferenceWorkspace(), analysis = useInterferenceStore();
    analysis.views = loaded.views; analysis.analysisId = submitted.view.run.analysisId; await nextTick();
    const submit = vi.spyOn(previewService, 'submitInterferenceAnalysis');
    await click(s.root, '干扰分析'); await settleMonitoring();
    expect(s.gis.mapMode).toBe('analysis'); expect(s.map().resourceMarkers).toBe(false);
    expect(find(s.root, 'source-probe')).toBeDefined();
    expect(textOf(s.root)).toContain(submitted.view.run.analysisId);
    expect(submit).not.toHaveBeenCalled(); expect(s.storage.writes).toBe(0);
  });
  it('打开分析面板保留未应用的 GIS 表单', async () => {
    const s = await mountEntry('/situation', true), before = JSON.stringify(s.editor.form);
    await click(s.root, '干扰分析'); await settleMonitoring();
    expect(find(s.root, 'source-probe')).toBeDefined();
    expect(JSON.stringify(s.editor.form)).toBe(before); expect(s.editor.formDirty).toBe(true);
    expect(s.storage.writes).toBe(0);
  });
  it('保留已选资源链路时，切回分析不会被资源详情监听覆盖', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    await search(s.root, 'PL-001');
    const link = findWhere(s.root, row => row.props['aria-label'] === '选择链路 PL-001')!;
    await (link.props.onClick as Function)(); await settleMonitoring();
    s.monitor.showNetwork(); await settleMonitoring();
    await click(s.root, '干扰分析'); await settleMonitoring();
    expect(s.gis.mapMode).toBe('resource'); expect(find(s.root, 'source-probe')).toBeDefined();
    expect(s.storage.writes).toBe(0);
  });
  // 只核对实际模板中的来源说明，切换展示不产生业务保存。
  it('来源标识跟随资源和监控视图，缺少资源版本时明确提示', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const label = () => textOf(findWhere(s.root, n => n.props['aria-label'] === '当前视图数据来源')!);
    const preview = usePreviewStore(); preview.data!.resourceMeta.revision = 'resource-test-version'; await nextTick();
    expect(label()).toBe('资源 · resource-test-version');
    s.monitor.showNetwork(); await settleMonitoring(); expect(label()).toBe('监控网络 ' + s.monitor.network!.key);
    await click(s.root, '资源视图'); expect(label()).toBe('资源 · resource-test-version');
    // 模拟来源元数据缺失，验证提示不会沿用另一视图的身份。
    Object.assign(preview.data!.resourceMeta, { revision: null }); await nextTick(); expect(label()).toBe('资源 · 版本未提供');
    expect(s.storage.writes).toBe(0);
  });
  it('诊断来源只显示已取得报告，目标不存在时不冒充已有结果', async () => {
    const s = await mountEntry('/situation?diagnosisId=DG-HW');
    const label = () => textOf(findWhere(s.root, n => n.props['aria-label'] === '当前视图数据来源')!);
    expect(label()).toBe('诊断 DG-HW');
    await s.router.push('/situation?diagnosisId=DG-missing'); await settleMonitoring();
    expect(label()).toBe('诊断 结果未提供'); expect(s.storage.writes).toBe(0);
  });
  it('普通入口仍默认展示监控网络', async () => {
    const s = await mountEntry('/situation');
    expect(s.gis.mapMode).toBe('monitoring'); expect(s.map().resourceMarkers).toBe(false);
    expect(s.monitor.network?.kind).toBe('DEMO'); expect(s.monitor.networkState.index).toBe(0);
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
    expect(find(s.root, 'source-probe')?.props.source).toMatchObject({ id: 'IF-0008' });
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
    s.gis.begin(); await s.editor.openForm('device', 'DV-0001', 'gis'); s.editor.form!.fields.workFreqKhz = '6000';
    const form = JSON.stringify(s.editor.form); await s.router.push('/situation?stationId=ND-0001&deviceId=DV-0002'); await settleMonitoring();
    expect(s.editor.decision).not.toBeNull(); s.editor.answer('cancel'); await settleMonitoring();
    expect(frame(s)!.points).toEqual([]); expect(JSON.stringify(s.editor.form)).toBe(form);
    expect(control(s.root, 'GIS 频率下限（kHz）').props.value).toBe('6000'); expect(textOf(s.root)).not.toContain('解除频率限制');
  });
  it('新挂载恢复默认，普通入口仍为监控模式且频率控件禁用', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001&deviceId=DV-0001'); await filter(s.root);
    await s.router.push('/planning'); await nextTick(); await s.router.push('/situation'); await settleMonitoring();
    expect(s.gis.mapMode).toBe('monitoring'); expect(frame(s)).toBeUndefined();
    await click(s.root, '图层管理'); expect(control(s.root, 'GIS 频率筛选依据').props.disabled).toBe(true);
    expect(control(s.root, 'GIS 频率筛选依据').props.value).toBe('ALL');
    await click(s.root, '资源视图'); expect(frame(s)!.points).toHaveLength(414); expect(s.storage.writes).toBe(0);
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
    const s = await mountEntry('/situation?stationId=ND-0001'), device = s.editor.resources.devices.find(row => {
      const parent = s.editor.resources.stations.find(station => station.id === row.stationId);
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
    const s = await mountEntry('/situation'), network = JSON.stringify([s.map().stations, s.map().links]);
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
  it('普通入口继续默认监控，新点位层不改变监控网络范围或默认模式', async () => {
    const s = await mountEntry('/situation'); expect(s.gis.mapMode).toBe('monitoring'); expect(frame(s)).toBeUndefined();
    const stations = s.map().stations; await click(s.root, '图层管理');
    await change(s.root, '显示HF设备', false); expect(s.map().stations).toEqual(stations);
    await click(s.root, '资源视图'); expect(frame(s)!.settings.HF.visible).toBe(true);
  });
});

describe('GIS 资源筛选与地图联动', () => {
  it.each(['编号', '名称'])('按节点%s搜索时地图与资源树一致，覆盖区域及资源数据保持完整', async kind => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const original = JSON.stringify(s.editor.resources), target = s.editor.resources.stations[0];
    const regions = s.map().regions as MapRegion[];
    await search(s.root, kind === '编号' ? target.id.toLowerCase() : target.name);
    const visible = s.map().stations as Station[];
    expect(visible.map(row => row.id)).toEqual([target.id]);
    expect(treeIds(s.root).filter(id => id.startsWith('ND-'))).toEqual([target.id]);
    expect(s.map().regions).toEqual(regions);
    expect(JSON.stringify(s.editor.resources)).toBe(original);
    expect([...s.storage.entries]).toEqual(s.before);
  });
  it.each(['HF', 'VUHF', '告警'])('%s 筛选同步节点，不把节点条件应用到干扰源', async filter => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const expected = s.editor.resources.stations.filter(row => filter === '告警' ? row.alert : row.classes.includes(filter as 'HF' | 'VUHF'));
    await click(s.root, filter);
    expect((s.map().stations as Station[]).map(row => row.id)).toEqual(expected.map(row => row.id));
    expect(treeIds(s.root).filter(id => id.startsWith('ND-'))).toEqual(expected.map(row => row.id));
    expect(s.map().interferences).toEqual(s.editor.resources.interferences);
  });
  it.each(['编号', '名称'])('干扰源%s搜索同步资源树与地图', async kind => {
    const s = await mountEntry('/situation?stationId=ND-0001'), source = s.editor.resources.interferences![0];
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
  it('复用原图层仅绘制两端可见的链路、候选线和任务线，不改任务内容', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const planning = usePlanningStore(), nodes = s.editor.resources.stations;
    const demands: PlanningDemand[] = [{ ...planningPresets[0].input.demands[0], id: 'CD-FILTER', sourceId: nodes[0].id, targetId: nodes[1].id }];
    // 此检查只提供未提交的显示输入，不制造规划结果或写入任务。
    planning.draft = structuredClone(planningPresets[0].input);
    planning.draft!.demands = demands;
    await nextTick();
    const before = JSON.stringify(planning.draft);
    expect(demandLayer(s.map().demands as PlanningDemand[], s.map().stations as Station[]).getSource()!.getFeatures()).toHaveLength(1);
    await search(s.root, nodes[0].id);
    const visible = s.map().stations as Station[];
    expect(linkLayer(s.map().links as NetworkLink[], visible).getSource()!.getFeatures()).toHaveLength(0);
    expect(linkLayer(s.map().candidateLinks as NetworkLink[], visible, true).getSource()!.getFeatures()).toHaveLength(0);
    expect(demandLayer(s.map().demands as PlanningDemand[], visible).getSource()!.getFeatures()).toHaveLength(0);
    expect(JSON.stringify(planning.draft)).toBe(before);
  });
  it('跨页定位清除阻挡目标的搜索和类别条件', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const target = s.editor.resources.stations.find(row => row.id !== 'ND-0001' && !row.alert)!;
    await click(s.root, '告警'); await search(s.root, '不存在的资源');
    await s.router.push({ path: '/situation', query: { stationId: target.id } }); await settleMonitoring();
    expect(s.map().selectedId).toBe(target.id);
    expect((s.map().stations as Station[]).some(row => row.id === target.id)).toBe(true);
    expect(textOf(s.root)).not.toContain('当前选中对象不在筛选结果中');
  });
  it('干扰源定位清除搜索但保留节点类别筛选；隐藏时详情仍在', async () => {
    const s = await mountEntry('/situation?interferenceId=IF-0008');
    await click(s.root, 'HF'); await search(s.root, '不存在的资源');
    expect(find(s.root, 'source-probe')?.props.source).toMatchObject({ id: 'IF-0008' });
    expect(textOf(s.root)).toContain('当前选中对象不在筛选结果中');
    await s.router.push('/situation?interferenceId=IF-0001'); await settleMonitoring();
    expect((s.map().interferences as InterferenceSource[]).some(row => row.id === 'IF-0001')).toBe(true);
    const expected = s.editor.resources.stations.filter(row => row.classes.includes('HF'));
    expect(s.map().stations).toEqual(expected);
  });
  it('节点定位保留仍匹配目标的搜索，只解除不匹配的告警条件', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const target = s.editor.resources.stations.find(row => row.id !== 'ND-0001' && !row.alert)!;
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
  it('筛选不切换监控模式或截断监控网络，回到资源视图再应用筛选', async () => {
    const s = await mountEntry('/situation');
    const stations = s.map().stations, links = s.map().links;
    await search(s.root, '不存在的资源'); await click(s.root, '告警');
    expect(s.gis.mapMode).toBe('monitoring'); expect(s.map().stations).toEqual(stations); expect(s.map().links).toEqual(links);
    expect(textOf(s.root)).toContain('当前快照保持完整');
    await click(s.root, '资源视图');
    expect(s.map().stations).toEqual([]); expect(s.map().interferences).toEqual([]);
  });
  it('资源筛选不截断干扰分析的冻结节点、链路和干扰源', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001');
    const fixture = await interferenceFixture(), submitted = await fixture.submit(); fixture.advance();
    const loaded = await fixture.service.loadInterferenceWorkspace(), analysis = useInterferenceStore();
    analysis.views = loaded.views; analysis.analysisId = submitted.view.run.analysisId; s.gis.mapMode = 'analysis';
    await nextTick();
    const stations = s.map().stations, links = s.map().links, sources = s.map().interferences, regions = s.map().regions;
    expect((stations as Station[]).length).toBeGreaterThan(0); expect((sources as InterferenceSource[]).length).toBeGreaterThan(0);
    await search(s.root, '不存在的资源'); await click(s.root, '告警');
    expect(s.gis.mapMode).toBe('analysis'); expect(s.map().stations).toEqual(stations); expect(s.map().links).toEqual(links);
    expect(s.map().interferences).toEqual(sources); expect(s.map().regions).toEqual(regions);
  });
  it('措施后地图使用服务快照自身坐标和成套结果，缺失后完整回到措施前',async()=>{
    const s=await mountEntry('/situation?stationId=ND-0001');
    const fixture=await interferenceFixture(),submitted=await fixture.submit();fixture.advance();
    const loaded=await fixture.service.loadInterferenceWorkspace(),analysis=useInterferenceStore();
    // 自定义服务载荷与预设不同，防止页面偷用原网络坐标或按本地变体取数。
    const view=loaded.views[0],preview=view.measurePreviews![0].result!;
    preview.inputSnapshot.stations[0].coordinate=[116.2,38.8];
    preview.links[0].id='service-preview-link';preview.regions=[];
    view.result!.measures[0].after!.summary.affectedNodeCount=17;
    analysis.views=loaded.views;analysis.analysisId=submitted.view.run.analysisId;s.gis.mapMode='analysis';await nextTick();
    const sourceLabel=()=>textOf(findWhere(s.root,n=>n.props['aria-label']==='当前视图数据来源')!);
    expect(sourceLabel()).toBe(`干扰分析 ${view.run.analysisId} · 网络 ${view.run.network.snapshotId}`);
    const before={stations:s.map().stations,links:s.map().links,regions:s.map().regions,impact:s.map().interferenceImpact};
    analysis.inspectMeasure(analysis.selected!.result!.measures[0]);analysis.after=true;await nextTick();
    expect(sourceLabel()).toBe(`措施预览 ${view.measurePreviews![0].measureId} · 来源方案 ${view.run.network.id}`);
    expect((s.map().stations as Station[]).find(row=>row.id===preview.inputSnapshot.stations[0].id)!.coordinate).toEqual([116.2,38.8]);
    expect(s.map().links).toEqual(preview.links);expect(s.map().regions).toEqual([]);
    expect(s.map().interferenceImpact).toEqual(view.result!.measures[0].after);expect(textOf(s.root)).toContain('措施后预评估');
    analysis.views=[{...view,measurePreviews:undefined}];await nextTick();
    expect(sourceLabel()).toBe(`干扰分析 ${view.run.analysisId} · 网络 ${view.run.network.snapshotId}`);
    expect({stations:s.map().stations,links:s.map().links,regions:s.map().regions,impact:s.map().interferenceImpact}).toEqual(before);
    expect(textOf(s.root)).toContain('措施前影响');expect(textOf(s.root)).not.toContain('措施后预评估');
    expect(analysis.canPreviewAfter).toBe(false);expect(s.storage.writes).toBe(0);
  });
});
