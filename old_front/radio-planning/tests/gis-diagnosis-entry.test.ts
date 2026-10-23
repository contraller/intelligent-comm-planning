import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import SituationView from '../src/views/SituationView.vue';
import GisDiagnosisPanel from '../src/components/GisDiagnosisPanel.vue';
import GisResourceTree from '../src/components/GisResourceTree.vue';
import GisResultLayerPanel from '../src/components/GisResultLayerPanel.vue';
import GisDeviceLayerPanel from '../src/components/GisDeviceLayerPanel.vue';
import DeviceCoveragePanel from '../src/components/DeviceCoveragePanel.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { createPlanningMock } from '../src/services/planning-mock';
import { createDiagnosisMock } from '../src/services/diagnosis-mock';
import { initialMeta } from '../src/services/resource-storage';
import { usePreviewStore } from '../src/stores/preview';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useDiagnosisStore } from '../src/stores/diagnosis';
import { planStations } from '../src/services/planning-snapshot';
import { planningPresets } from '../src/mocks/planning-presets';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import resources from '../src/mocks/resources.json';
import type { ResourcesData } from '../src/types/domain';
import type { DiagnosisDemo, DiagnosisRecord } from '../src/types/diagnosis';
import type { GisResultLayerSettings } from '../src/maps/gis-result-layers';
import { PLANNING_STORAGE_KEY } from '../src/config/demo';
import { authorizeStore } from './helpers/auth';
import { bindMonitoring, settleMonitoring } from './helpers/monitoring';
import { savedRequest, taskMeta } from './helpers/tasks';
import { TestStorage } from './helpers/storage';

const probes = vi.hoisted(() => ({ locate: vi.fn(), locateResource: vi.fn(), fit: vi.fn() }));
// 页面、面板、路由和报告读取均真实运行，仅地图画布及本批无关面板使用探针。
vi.mock('../src/components/MapCanvas.vue', async () => {
  const { defineComponent, getCurrentInstance, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false,
    props: ['stations', 'links', 'showLinks', 'selectLinks', 'topologyOpacity', 'candidateLinks', 'regions', 'interferences', 'demands', 'diagnosisFaults', 'diagnosisRegions', 'diagnosisDevices', 'selectedId', 'selectedLinkId', 'highlightStationIds', 'highlightLinkIds', 'gisResultLayers', 'gisDeviceFrame', 'deviceCoverageActive', 'deviceCoverages', 'interferenceImpact', 'resourceMarkers', 'picking', 'pickPreview'],
    emits: ['select', 'selectLink', 'selectFault'],
    setup(props, { emit, expose }) {
      const instance = getCurrentInstance()!;
      expose({ locate: probes.locate, locateResource: probes.locateResource, fit: probes.fit });
      return () => {
        // 旧地图事件保留所属渲染代次，不让宿主探针重新路由到新监听函数。
        const selectLink = instance.vnode.props?.onSelectLink as (id: string) => void;
        return h('map-probe', { ...props, select: (id: string) => emit('select', id),
          selectLink, selectFault: (type: string, id: string) => emit('selectFault', type, id) });
      };
    },
  }) };
});
vi.mock('../src/components/ObjectInfoPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false, props: ['station', 'selectedDeviceId'], setup: props => () => h('resource-detail', { ...props }) }) };
});
vi.mock('../src/components/InterferenceAnalysisPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/SituationMonitoringDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/MonitoringObjectPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/TaskWorkspacePanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/InterferenceHistoryDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/InterferenceMeasureDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/InterferenceSourceDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceExportDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/StatusBadge.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));

async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: filename,
    compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (template.errors.length) throw new Error(template.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${template.code} }`, 'diagnosis-entry-render.ts', { loader: 'ts' });
  (component as ComponentOptions).render = new Function('Vue', code + ';return createRender(Vue);')(Vue);
}
await Promise.all([
  [SituationView, 'src/views/SituationView.vue'], [GisDiagnosisPanel, 'src/components/GisDiagnosisPanel.vue'],
  [GisResourceTree, 'src/components/GisResourceTree.vue'], [GisResultLayerPanel, 'src/components/GisResultLayerPanel.vue'],
  [GisDeviceLayerPanel, 'src/components/GisDeviceLayerPanel.vue'], [DeviceCoveragePanel, 'src/components/DeviceCoveragePanel.vue'],
].map(([component, file]) => clientTemplate(component as Component, file as string)));

interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown;
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
  addEventListener() {}, removeEventListener() {}, getRootNode: () => document });
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
function find(root: HostNode, match: (row: HostNode) => boolean): HostNode | undefined {
  if (match(root)) return root;
  for (const child of root.children) { const found = find(child, match); if (found) return found; }
}
const textOf = (root: HostNode): string => (root.tag === '#comment' ? '' : root.text.replace(/<[^>]+>/g, '')) + root.children.map(textOf).join('');
const button = (root: HostNode, label: string) => find(root, row => row.tag === 'button' && textOf(row).trim() === label);
async function click(root: HostNode, label: string) {
  const target = button(root, label); expect(target, label).toBeDefined();
  await (target!.props.onClick as () => unknown)(); await settleMonitoring();
}
async function change(root: HostNode, label: string, value: string | boolean, event = 'onChange') {
  const target = find(root, row => row.props['aria-label'] === label); expect(target, label).toBeDefined();
  (target!.props[event] as (event: unknown) => void)({ target: { checked: value, value } }); await settleMonitoring();
}

// 本文件独立走规划保存、确认、诊断保存与提交流程，不改公共 fixture 或来源资产。
async function diagnosisFixture(demo: DiagnosisDemo = 'normal', presetId = 'balanced:hardware') {
  const storage = new TestStorage(); let time = Date.parse('2026-10-15T01:00:00Z');
  const current = { resources: structuredClone(resources) as ResourcesData, meta: initialMeta() };
  const read = () => ({ ...current, meta: { ...current.meta, taskWorkspace: taskMeta(storage) } });
  const planning = createPlanningMock(() => storage, read, () => time);
  const submitted = await planning.submitPlanning(await savedRequest(storage, { baseRevision: 'initial', requestId: 'plan-submit', taskId: null,
    parentPlanVersionId: null, input: structuredClone(planningPresets.find(row => row.id === 'balanced')!.input) }));
  time += 10000;
  const saved = await planning.savePlanVersion({ baseRevision: submitted.workspace.revision, requestId: 'plan-save', jobId: submitted.view.job.id, name: 'GIS 诊断冻结网络', note: '' });
  const confirmed = await planning.confirmPlanVersion({ baseRevision: saved.workspace.revision, requestId: 'plan-confirm', planId: saved.plan.id });
  const service = createDiagnosisMock(() => storage, read, () => time);
  const initial = await service.loadDiagnosisWorkspace();
  const scenario = await service.saveDiagnosisScenario({ baseRevision: initial.workspace!.revision, requestId: 'scene-save', scenarioId: null,
    draft: { name: 'GIS 完整诊断', description: '只读影响显示', planId: confirmed.plan.id, faults: structuredClone(diagnosisPresets.find(row => row.id === presetId)!.faults) } });
  const result = await service.submitDiagnosis({ baseRevision: scenario.revision, requestId: 'diagnosis-submit', scenarioVersionId: scenario.scenarios[0].versions[0].id, demo });
  return { storage, current, planning, service, id: result.view.run.id, advance: () => { time += 10000; } };
}
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function mountEntry(url = '/situation?diagnosisId=DG-HW', options: { editing?: boolean; denied?: boolean; fixture?: Awaited<ReturnType<typeof diagnosisFixture>> } = {}) {
  vi.useFakeTimers(); vi.stubGlobal('window', new EventTarget());
  class TestDocument extends EventTarget { hidden = false; activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  if (options.denied) auth.identity!.permissions = auth.identity!.permissions.filter(permission => permission !== 'diagnosis.view');
  const storage = options.fixture?.storage ?? new TestStorage(), raw = createMockService(() => storage);
  // 新状态目录沿用本入口测试数据，避免误读真实浏览器会话。
  vi.spyOn(previewService, 'loadDeviceStatusContext').mockImplementation(raw.loadDeviceStatusContext);
  vi.spyOn(previewService, 'loadPreview').mockImplementation(raw.loadPreview);
  vi.spyOn(previewService, 'loadInterferenceWorkspace').mockImplementation(raw.loadInterferenceWorkspace);
  const report = vi.spyOn(previewService, 'getDiagnosisReport').mockImplementation(options.fixture?.service.getDiagnosisReport ?? raw.getDiagnosisReport);
  const workspace = vi.spyOn(previewService, 'loadDiagnosisWorkspace');
  const run = vi.spyOn(previewService, 'getDiagnosisRun'), submit = vi.spyOn(previewService, 'submitDiagnosis');
  bindMonitoring(raw); const preview = usePreviewStore(); await preview.load();
  const gis = useGisWorkspaceStore(), editor = useResourceEditStore(), diagnosis = useDiagnosisStore();
  if (options.editing) { gis.begin(); await editor.openForm('device', 'DV-0001', 'gis'); editor.form!.fields.antennaHeightM = '19'; }
  const before = [...storage.entries], writes = storage.writes;
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/situation', component: SituationView }, { path: '/diagnosis', component: { render: () => null } },
    { path: '/planning', component: { render: () => null } }, { path: '/other', component: { render: () => null } },
  ] });
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  await router.push(url); await router.isReady(); const root = node('root'); app.mount(root); await settleMonitoring();
  const map = () => find(root, row => row.tag === 'map-probe')!.props;
  const panel = () => find(root, row => row.props['aria-label'] === 'GIS 诊断快照');
  return { root, map, panel, router, gis, editor, auth, diagnosis, preview, storage, before, writes, raw, report, workspace, run, submit };
}

describe('GIS 完整诊断独立快照入口', () => {
  it('显式历史报告阻止默认监控，地图、面板身份及冻结数据来自同一报告', async () => {
    const s = await mountEntry(), record = await s.raw.getDiagnosisReport('DG-HW');
    expect(s.gis.mapMode).toBe('diagnosis'); expect(s.report.mock.calls.every(args => args[0] === 'DG-HW')).toBe(true);
    expect(s.report.mock.calls.length).toBeGreaterThan(0); expect(s.report.mock.calls.length).toBeLessThanOrEqual(2);
    expect(s.map().stations).toEqual(planStations(record.network)); expect(s.map().links).toEqual(record.network.links);
    expect(s.map().diagnosisRegions).toEqual(record.result.regions); expect(s.map().diagnosisFaults).toEqual([]);
    expect(s.map().diagnosisDevices).toEqual(record.network.inputSnapshot.devices);
    expect(textOf(s.panel()!)).toContain('DG-HW'); expect(textOf(s.panel()!)).toContain(record.network.snapshotId!);
    expect(textOf(s.panel()!)).toContain('未提供结构化影响统计'); expect(textOf(s.panel()!)).toContain('未提供完整故障输入');
    expect(find(s.root, row => row.tag === 'resource-detail')).toBeUndefined();
    expect(s.workspace).not.toHaveBeenCalled(); expect(s.run).not.toHaveBeenCalled(); expect(s.submit).not.toHaveBeenCalled();
    expect([...s.storage.entries]).toEqual(s.before); expect(s.storage.writes).toBe(s.writes);
  });
  it('真实已完成任务使用规划输出坐标和影响清单，不混入当前资源或其他三模式结果', async () => {
    const fixture = await diagnosisFixture(); fixture.advance(); const record = await fixture.service.getDiagnosisReport(fixture.id);
    const s = await mountEntry('/situation?diagnosisId=' + fixture.id, { fixture });
    expect(s.map().stations).toEqual(planStations(record.network)); expect(s.map().links).toEqual(record.network.links);
    expect(s.map().diagnosisFaults).toEqual(record.faults); expect(s.map().diagnosisRegions).toEqual(record.result.regions);
    expect(s.map().regions).toEqual([]); expect(s.map().candidateLinks).toEqual([]); expect(s.map().demands).toEqual([]);
    expect(s.map().interferences).toEqual([]); expect(s.map().interferenceImpact).toBeNull(); expect(s.map().gisDeviceFrame).toBeUndefined();
    expect(s.map().deviceCoverageActive).toBe(false); expect(s.map().deviceCoverages).toEqual([]);
    expect(s.map().resourceMarkers).toBe(false); expect(s.map().picking).toBe(false); expect(s.map().pickPreview).toBeUndefined();
    const panel = textOf(s.panel()!); expect(panel).toContain(record.diagnoseTaskId!); expect(panel).toContain(record.impactTaskId!);
    expect(panel).toContain('完整影响统计'); expect(panel).toContain(String(record.result.summary!.totalBandwidthLossKbps));
    expect([...s.storage.entries]).toEqual(s.before); expect(s.workspace).not.toHaveBeenCalled();
  });
  it.each(['', 'DG-HW&diagnosisId=DG-LINK', 'DG-HW&stationId=ND-0001', 'DG-HW&taskId=TASK-A', 'x'.repeat(121)])('错误入口 %s 不请求、不自动进入监控，也不显示资源替代结果', async query => {
    const s = await mountEntry('/situation?diagnosisId=' + query);
    expect(s.gis.mapMode).toBe('diagnosis'); expect(s.report).not.toHaveBeenCalled(); expect(s.map().stations).toEqual([]);
    expect(s.map().links).toEqual([]); expect(find(s.root, row => row.props.role === 'alert')).toBeDefined();
    expect(s.workspace).not.toHaveBeenCalled();
  });
  it('普通入口不读取任何诊断，无目标入口仅导航到诊断页', async () => {
    const s = await mountEntry('/situation'); expect(s.gis.mapMode).toBe('monitoring'); expect(s.report).not.toHaveBeenCalled();
    const navigation = vi.spyOn(s.router, 'push');
    await click(s.root, '诊断快照'); expect(navigation).toHaveBeenCalledWith('/diagnosis');
    await navigation.mock.results[0].value; await settleMonitoring(); expect(s.router.currentRoute.value.path).toBe('/diagnosis');
    expect(s.workspace).not.toHaveBeenCalled(); expect(s.report).not.toHaveBeenCalled();
  });
  it('缺诊断权限保持空诊断画布，不能读取报告或打开资源详情', async () => {
    const s = await mountEntry(undefined, { denied: true });
    expect(s.gis.mapMode).toBe('diagnosis'); expect(s.report).not.toHaveBeenCalled(); expect(s.map().stations).toEqual([]);
    expect(textOf(s.root)).toContain('权限'); expect(find(s.root, row => row.tag === 'resource-detail')).toBeUndefined();
  });
  it.each(['normal', 'impact-failed'] as const)('未就绪或影响失败 %s 不读取预藏结果，正常完成后可重试', async demo => {
    const fixture = await diagnosisFixture(demo); if (demo === 'impact-failed') fixture.advance();
    const s = await mountEntry('/situation?diagnosisId=' + fixture.id, { fixture });
    expect(s.map().stations).toEqual([]); expect(textOf(s.root)).toContain('完整报告未就绪');
    expect(s.run).not.toHaveBeenCalled(); expect(s.workspace).not.toHaveBeenCalled();
    if (demo === 'normal') { fixture.advance(); await click(s.root, '重新读取报告'); expect((s.map().stations as unknown[]).length).toBeGreaterThan(0); }
  });
  it('同页资源筛选与未应用表单保留，诊断冻结网络不被旧结果暂停或资源筛选裁剪', async () => {
    const s = await mountEntry(undefined, { editing: true }), form = JSON.stringify(s.editor.form), network = JSON.stringify([s.map().stations, s.map().links]);
    const requests = s.report.mock.calls.length;
    await change(s.root, '搜索资源', '不存在', 'onInput');
    expect(s.gis.mapMode).toBe('diagnosis'); expect(JSON.stringify([s.map().stations, s.map().links])).toBe(network);
    expect(JSON.stringify(s.editor.form)).toBe(form); expect(s.editor.formDirty).toBe(true);
    await click(s.root, '资源视图'); expect(s.gis.mapMode).toBe('resource'); expect(s.map().stations).toEqual([]);
    expect(JSON.stringify(s.editor.form)).toBe(form);
    await click(s.root, '诊断快照'); expect(JSON.stringify([s.map().stations, s.map().links])).toBe(network);
    expect(s.report).toHaveBeenCalledTimes(requests + 1); expect(JSON.stringify(s.editor.form)).toBe(form); expect(s.storage.writes).toBe(s.writes);
  });
  it('从诊断选择资源树需先通过原表单确认，取消不切出或丢输入', async () => {
    const s = await mountEntry(undefined, { editing: true }), form = JSON.stringify(s.editor.form);
    const close = vi.spyOn(s.editor, 'closeForm').mockResolvedValue(false);
    const target = find(s.root, row => row.props['aria-label'] === '选择设备 DV-0027')!;
    // 搜索真实目录使另一节点的设备行展开，再触发实际树事件。
    if (!target) await change(s.root, '搜索资源', 'DV-0027', 'onInput');
    const control = find(s.root, row => row.props['aria-label'] === '选择设备 DV-0027')!;
    expect(control).toBeDefined(); (control.props.onClick as () => unknown)(); await settleMonitoring();
    expect(close).toHaveBeenCalled(); expect(s.gis.mapMode).toBe('diagnosis'); expect(JSON.stringify(s.editor.form)).toBe(form);
    expect(s.editor.formDirty).toBe(true);
  });
  it('资源树等待确认时更换报告，旧确认通过也不能把新报告切回资源地图', async () => {
    const s = await mountEntry(undefined, { editing: true });
    await change(s.root, '搜索资源', 'DV-0027', 'onInput');
    let confirm!: (value: boolean) => void;
    const close = vi.spyOn(s.editor, 'closeForm').mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    const control = find(s.root, row => row.props['aria-label'] === '选择设备 DV-0027')!;
    (control.props.onClick as () => unknown)(); await settleMonitoring(); expect(close).toHaveBeenCalledOnce();
    await s.router.push('/situation?diagnosisId=DG-LINK'); await settleMonitoring(); confirm(true); await settleMonitoring();
    expect(s.gis.mapMode).toBe('diagnosis'); expect(textOf(s.panel()!)).toContain('DG-LINK'); expect(s.map().selectedId).toBe('');
    expect(find(s.root, row => row.tag === 'resource-detail')).toBeUndefined(); expect(s.storage.writes).toBe(s.writes);
  });
  it('从诊断新建或导入取消表单确认时保留报告和输入', async () => {
    const s = await mountEntry(undefined, { editing: true }), form = JSON.stringify(s.editor.form);
    const settle = vi.spyOn(s.editor, 'settleForm').mockResolvedValue(false), open = vi.spyOn(s.editor, 'openImport');
    await click(s.root, '新建固定站'); expect(settle).toHaveBeenCalled(); expect(s.gis.mapMode).toBe('diagnosis');
    await click(s.root, '导入资源'); expect(open).not.toHaveBeenCalled(); expect(s.gis.mapMode).toBe('diagnosis');
    expect(JSON.stringify(s.editor.form)).toBe(form); expect(textOf(s.panel()!)).toContain('DG-HW');
  });
  it('等级筛选只裁剪区域与影响高亮，统计与冻结网络保持；清单和地图选择可重复定位', async () => {
    const fixture = await diagnosisFixture(); fixture.advance(); const record = await fixture.service.getDiagnosisReport(fixture.id);
    const s = await mountEntry('/situation?diagnosisId=' + fixture.id, { fixture });
    const network = JSON.stringify([s.map().stations, s.map().links]), count = s.report.mock.calls.length;
    const affected = record.result.nodes.find(row => row.level === 'SEVERE')!; expect(affected).toBeDefined();
    await click(s.root, '定位节点 ' + affected.nodeId); expect(find(s.root, row => row.props['aria-label'] === '冻结对象详情')).toBeDefined();
    const first = probes.locate.mock.calls.length + probes.locateResource.mock.calls.length;
    await click(s.root, '定位节点 ' + affected.nodeId); expect(probes.locate.mock.calls.length + probes.locateResource.mock.calls.length).toBeGreaterThan(first);
    await change(s.root, '显示严重诊断影响', false);
    expect((s.map().diagnosisRegions as DiagnosisRecord['result']['regions']).every(row => row.level !== 'SEVERE')).toBe(true);
    expect(s.map().highlightStationIds).not.toContain(affected.nodeId); expect(find(s.root, row => row.props['aria-label'] === '冻结对象详情')).toBeUndefined();
    expect(JSON.stringify([s.map().stations, s.map().links])).toBe(network); expect(textOf(s.panel()!)).toContain('完整影响统计');
    (s.map().selectLink as (id: string) => void)(record.network.links[0].id); await settleMonitoring();
    expect(textOf(s.panel()!)).toContain('冻结状态'); expect(s.report).toHaveBeenCalledTimes(count);
  });
  it('图层面板的第四组只控制诊断区域，来回切模式保留偏好', async () => {
    const s = await mountEntry(), original = JSON.stringify([s.map().diagnosisRegions, s.map().highlightStationIds, s.map().highlightLinkIds]);
    const requests = s.report.mock.calls.length;
    await click(s.root, '图层管理'); await change(s.root, '诊断影响区域透明度', '0', 'onInput');
    const settings = () => s.map().gisResultLayers as GisResultLayerSettings;
    expect(settings().diagnosis.opacity).toBe(0); expect(settings().coverage.visible).toBe(false);
    expect(settings().interference.visible).toBe(false); expect(settings().illustration.visible).toBe(false);
    await change(s.root, '显示诊断影响区域', false);
    expect(JSON.stringify([s.map().diagnosisRegions, s.map().highlightStationIds, s.map().highlightLinkIds])).toBe(original);
    await click(s.root, '资源视图'); expect(settings().diagnosis.visible).toBe(false);
    await click(s.root, '诊断快照'); expect(settings().diagnosis).toEqual({ visible: false, opacity: 0 });
    expect(s.report).toHaveBeenCalledTimes(requests + 1); expect(s.submit).not.toHaveBeenCalled(); expect(s.storage.writes).toBe(s.writes);
  });
  it('同报告内容更新后拒绝旧地图、清单、等级和图层控件事件，即使对象 ID 相同', async () => {
    const s = await mountEntry(), record = await s.raw.getDiagnosisReport('DG-HW');
    await click(s.root, '图层管理');
    const oldMap = s.map().select as (id: string) => void;
    const oldRow = button(s.root, '定位节点 ' + record.result.nodes[0].nodeId)!.props.onClick as () => unknown;
    const oldLevel = find(s.root, row => row.props['aria-label'] === '显示严重诊断影响')!.props.onChange as (event: unknown) => void;
    const oldOpacity = find(s.root, row => row.props['aria-label'] === '诊断影响区域透明度')!.props.onInput as (event: unknown) => void;
    const updated = structuredClone(record); updated.result.nodes[0].reason += '；服务报告内容已更新';
    s.report.mockResolvedValue(updated); await click(s.root, '重新读取报告');
    oldMap(record.result.nodes[0].nodeId); await oldRow(); oldLevel({ target: { checked: false } }); oldOpacity({ target: { value: '0.1' } }); await settleMonitoring();
    expect(s.map().selectedId).toBe(''); expect(find(s.root, row => row.props['aria-label'] === '冻结对象详情')).toBeUndefined();
    expect(find(s.root, row => row.props['aria-label'] === '显示严重诊断影响')!.props.checked).toBe(true);
    expect((s.map().gisResultLayers as GisResultLayerSettings).diagnosis.opacity).toBe(0.8);
  });
  it('合法历史 null 等级在三级全关后仍显示，服务空清单与请求失败分别提示', async () => {
    const s = await mountEntry(), report = await s.raw.getDiagnosisReport('DG-HW'), before = JSON.stringify([s.map().diagnosisRegions, s.map().highlightStationIds]);
    for (const level of ['严重', '中等', '轻微']) await change(s.root, '显示' + level + '诊断影响', false);
    expect(JSON.stringify([s.map().diagnosisRegions, s.map().highlightStationIds])).toBe(before); expect(textOf(s.panel()!)).toContain('未提供等级');
    report.result.regions = []; report.result.nodes = []; report.result.links = []; s.report.mockResolvedValue(report);
    await click(s.root, '重新读取报告');
    expect(textOf(s.panel()!)).toContain('服务未提供影响区域'); expect(textOf(s.panel()!)).toContain('服务返回空节点影响清单');
    expect(textOf(s.panel()!)).toContain('服务返回空链路影响清单'); expect(find(s.root, row => row.props.role === 'alert')).toBeUndefined();
    expect((s.map().stations as unknown[]).length).toBeGreaterThan(0);
  });
  it('权限撤销后立即清空画面和旧事件，恢复权限按当前目标重新读取', async () => {
    const s = await mountEntry(), oldMap = s.map().select as (id: string) => void, identity = structuredClone(Vue.toRaw(s.auth.identity!));
    s.auth.accept({ ...identity, permissions: identity.permissions.filter(permission => permission !== 'diagnosis.view') }); await settleMonitoring();
    oldMap('ND-0003'); await settleMonitoring(); expect(s.map().stations).toEqual([]); expect(s.map().selectedId).toBe('');
    expect(textOf(s.root)).toContain('权限'); expect(button(s.root, '诊断快照')).toBeUndefined();
    const requests = s.report.mock.calls.length; s.auth.accept(identity); await settleMonitoring();
    expect(s.report.mock.calls.length).toBeGreaterThan(requests); expect((s.map().stations as unknown[]).length).toBeGreaterThan(0);
    oldMap('ND-0003'); await settleMonitoring(); expect(s.map().selectedId).toBe('');
  });
  it('源规划重置后焦点刷新保留历史网络与有效选择，来源核实失败清理画面', async () => {
    const fixture = await diagnosisFixture(); fixture.advance();
    const s = await mountEntry('/situation?diagnosisId=' + fixture.id, { fixture });
    const record = await fixture.service.getDiagnosisReport(fixture.id), network = JSON.stringify([s.map().stations, s.map().links]);
    await click(s.root, '图层管理'); await change(s.root, '拓扑透明度', '0.3', 'onInput'); await change(s.root, '显示规划后链路', false);
    (s.map().select as (id: string) => void)(record.network.inputSnapshot.stations[0].id); await settleMonitoring();
    const selected = s.map().selectedId, fitCount = probes.fit.mock.calls.length, locateCount = probes.locate.mock.calls.length;
    const workspace = await fixture.planning.loadPlanningWorkspace(); await fixture.planning.resetPlanningWorkspace(workspace.workspace.revision);
    window.dispatchEvent(new Event('focus')); await settleMonitoring();
    expect(textOf(s.panel()!)).toContain('历史'); expect(JSON.stringify([s.map().stations, s.map().links])).toBe(network);
    expect(s.map().selectedId).toBe(selected); expect(probes.fit).toHaveBeenCalledTimes(fitCount); expect(probes.locate).toHaveBeenCalledTimes(locateCount);
    expect(s.map().topologyOpacity).toBe(0.3); expect(s.map().showLinks).toBe(false);
    fixture.storage.failReadKeys.add(PLANNING_STORAGE_KEY); window.dispatchEvent(new Event('focus')); await settleMonitoring();
    expect(textOf(s.panel()!)).toContain('无法核实'); expect(JSON.stringify([s.map().stations, s.map().links])).toBe(network);
    s.report.mockRejectedValueOnce(new Error('报告读取失败')); window.dispatchEvent(new Event('focus')); await settleMonitoring();
    expect(s.map().stations).toEqual([]); expect(textOf(s.root)).toContain('报告读取失败');
    expect(find(s.root, row => row.props['aria-label'] === '拓扑透明度')!.props.disabled).toBe(true);
    await change(s.root, '拓扑透明度', '1', 'onInput'); expect(s.map().topologyOpacity).toBe(0.3);
  });
  it('切到其他模式清空诊断展示，返回明确目标重读；普通页面重入不残留 diagnosis', async () => {
    const s = await mountEntry(), requests = s.report.mock.calls.length;
    s.gis.mapMode = 'monitoring'; await settleMonitoring(); expect(s.map().diagnosisRegions).toEqual([]); expect(s.panel()).toBeUndefined();
    s.gis.mapMode = 'analysis'; await settleMonitoring(); expect(s.map().diagnosisRegions).toEqual([]);
    await click(s.root, '诊断快照'); expect(s.gis.mapMode).toBe('diagnosis'); expect(s.report).toHaveBeenCalledTimes(requests + 1);
    await s.router.push('/other'); await settleMonitoring(); expect(s.gis.mapMode).toBe('resource');
    await s.router.push('/situation'); await settleMonitoring(); expect(s.gis.mapMode).toBe('monitoring'); expect(s.report).toHaveBeenCalledTimes(requests + 1);
  });
});

describe('GIS 诊断快照拓扑透明度', () => {
  const control = (root: HostNode, label = '拓扑透明度') => find(root, row => row.props['aria-label'] === label)!;
  it('零透明度只拦地图线条，故障图标与影响清单仍可定位且不改变冻结统计或区域', async () => {
    const fixture = await diagnosisFixture('normal', 'balanced:link'); fixture.advance();
    const record = await fixture.service.getDiagnosisReport(fixture.id), s = await mountEntry('/situation?diagnosisId=' + fixture.id, { fixture });
    const link = record.network.links[0].id, fault = record.faults.find(row => row.objectType === 'LINK')!;
    const oldMap = s.map().selectLink as (id: string) => void, network = JSON.stringify([s.map().stations, s.map().links]);
    const regions = JSON.stringify([s.map().diagnosisRegions, s.map().gisResultLayers]), faults = s.map().diagnosisFaults;
    const inputs = Object.fromEntries(['deviceCoverages', 'demands', 'highlightLinkIds', 'highlightStationIds', 'diagnosisDevices', 'diagnosisFaults', 'diagnosisRegions', 'candidateLinks'].map(key => [key, s.map()[key]]));
    const count = s.report.mock.calls.length;
    await click(s.root, '图层管理'); await change(s.root, '拓扑透明度', '0', 'onInput');
    expect(s.map().topologyOpacity).toBe(0); expect(s.map().selectLinks).toBe(false); expect(control(s.root).props.disabled).toBe(false);
    // 真实父模板的冻结输入引用保持，实际地图层无需重建。
    for (const [key, reference] of Object.entries(inputs)) expect(s.map()[key], key).toBe(reference);
    oldMap(link); (s.map().selectLink as (id: string) => void)(link); await settleMonitoring();
    expect(s.map().selectedLinkId).toBe(''); expect(find(s.root, row => row.props['aria-label'] === '冻结对象详情')).toBeUndefined();
    (s.map().selectFault as (type: string, id: string) => void)('LINK', fault.objectId); await settleMonitoring();
    expect(s.map().selectedLinkId).toBe(fault.objectId); expect(textOf(s.panel()!)).toContain('冻结状态');
    const located = probes.locate.mock.calls.length; await click(s.root, '定位链路 ' + record.result.links[0].linkId);
    expect(probes.locate.mock.calls.length).toBeGreaterThan(located); expect(s.map().topologyOpacity).toBe(0);
    expect(JSON.stringify([s.map().stations, s.map().links])).toBe(network); expect(JSON.stringify([s.map().diagnosisRegions, s.map().gisResultLayers])).toBe(regions);
    expect(s.map().diagnosisFaults).toBe(faults); expect(textOf(s.panel()!)).toContain(String(record.result.summary!.totalBandwidthLossKbps));
    expect(s.report).toHaveBeenCalledTimes(count); expect(s.submit).not.toHaveBeenCalled(); expect(s.storage.writes).toBe(s.writes);
  });
  it('关闭拓扑和独立诊断区域分别保留，返回资源再进诊断不恢复隐藏链路', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); const count = s.report.mock.calls.length;
    await change(s.root, '拓扑透明度', '0.4', 'onInput'); await change(s.root, '显示规划后链路', false);
    await change(s.root, '诊断影响区域透明度', '0.2', 'onInput');
    expect((s.map().gisResultLayers as GisResultLayerSettings).diagnosis).toEqual({ visible: true, opacity: 0.2 });
    await click(s.root, '资源视图'); expect(s.map().showLinks).toBe(false); expect(s.map().topologyOpacity).toBe(0.4);
    await click(s.root, '诊断快照'); expect(s.map().showLinks).toBe(false); expect(s.map().topologyOpacity).toBe(0.4);
    expect(control(s.root).props.disabled).toBe(false); expect((s.map().gisResultLayers as GisResultLayerSettings).diagnosis.opacity).toBe(0.2);
    await change(s.root, '显示规划后链路', true); expect(s.map().showLinks).toBe(true); expect(s.map().topologyOpacity).toBe(0.4);
    expect(s.report).toHaveBeenCalledTimes(count + 1); expect(s.storage.writes).toBe(s.writes);
  });
  it('同名报告内容换代后旧滑块、开关及地图线回调不能影响新报告', async () => {
    const s = await mountEntry(), record = await s.raw.getDiagnosisReport('DG-HW'); await click(s.root, '图层管理');
    await change(s.root, '拓扑透明度', '0.4', 'onInput');
    const oldOpacity = control(s.root).props.onInput as (event: unknown) => void;
    const oldToggle = control(s.root, '显示规划后链路').props.onChange as (event: unknown) => void;
    const oldMap = s.map().selectLink as (id: string) => void;
    const updated = structuredClone(record); updated.result.nodes[0].reason += '；同 ID 新内容';
    s.report.mockResolvedValue(updated); await click(s.root, '重新读取报告'); const count = s.report.mock.calls.length;
    oldOpacity({ target: { value: '0' } }); oldToggle({ target: { checked: false } }); oldMap(record.network.links[0].id); await settleMonitoring();
    expect(s.map().topologyOpacity).toBe(0.4); expect(s.map().showLinks).toBe(true); expect(s.map().selectedLinkId).toBe('');
    await change(s.root, '拓扑透明度', '0.7', 'onInput'); expect(s.map().topologyOpacity).toBe(0.7); expect(s.report).toHaveBeenCalledTimes(count);
  });
  it('完整诊断未就绪时不借普通网络启用控件，成功重读后才能恢复原偏好', async () => {
    const fixture = await diagnosisFixture(), s = await mountEntry('/situation?diagnosisId=' + fixture.id, { fixture });
    await click(s.root, '图层管理'); expect(control(s.root).props.disabled).toBe(true);
    expect(control(s.root, '显示规划后链路').props.disabled).toBe(true); expect(s.map().showLinks).toBe(false);
    await change(s.root, '拓扑透明度', '0', 'onInput'); await change(s.root, '显示规划后链路', false); expect(s.map().topologyOpacity).toBe(1);
    fixture.advance(); await click(s.root, '重新读取报告'); expect(control(s.root).props.disabled).toBe(false); expect(s.map().showLinks).toBe(true);
    expect(s.map().topologyOpacity).toBe(1); expect(s.workspace).not.toHaveBeenCalled(); expect(s.run).not.toHaveBeenCalled();
  });
  it('诊断权限暂失保留偏好并使旧控件失效，恢复后仍使用当前报告', async () => {
    const s = await mountEntry(); await click(s.root, '图层管理'); await change(s.root, '拓扑透明度', '0.4', 'onInput');
    const oldOpacity = control(s.root).props.onInput as (event: unknown) => void, identity = structuredClone(Vue.toRaw(s.auth.identity!));
    s.auth.accept({ ...identity, permissions: identity.permissions.filter(row => row !== 'diagnosis.view') }); await settleMonitoring();
    expect(control(s.root).props.disabled).toBe(true); expect(s.map().showLinks).toBe(false);
    await change(s.root, '拓扑透明度', '0', 'onInput'); expect(s.map().topologyOpacity).toBe(0.4);
    s.auth.accept(identity); await settleMonitoring(); oldOpacity({ target: { value: '0' } }); await settleMonitoring();
    expect(s.map().topologyOpacity).toBe(0.4); expect(s.map().showLinks).toBe(true); expect(textOf(s.panel()!)).toContain('DG-HW');
  });
});
