import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ref, ssrContextKey, type App, type Component } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import GisTaskPanel from '../src/components/GisTaskPanel.vue';
import SituationMonitoringDrawer from '../src/components/SituationMonitoringDrawer.vue';
import InterferenceAnalysisPanel from '../src/components/InterferenceAnalysisPanel.vue';
import { useGisTaskSelection } from '../src/composables/useGisTaskSelection';
import { usePreviewStore } from '../src/stores/preview';
import { useTaskInputStore } from '../src/stores/task-input';
import { useMonitoringStore } from '../src/stores/monitoring';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useInterferenceStore } from '../src/stores/interference';
import { createMockService } from '../src/services/mock';
import { initialResources } from '../src/mocks/resource-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
// 仅复用模板编译，原有宿主、替身和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';

// 外壳在关闭时卸载字段，用真实表单验证输入保护；不模拟 CSS 布局。
vi.mock('../src/components/AppDrawer.vue', () => ({ default: Vue.defineComponent({
  props: ['visible', 'title'], emits: ['update:visible'],
  setup: (p, { slots, emit }) => () => p.visible ? h('aside', { 'aria-label': p.title }, [
    slots.default?.(), slots.footer?.(), h('button', { onClick: () => emit('update:visible', false) }, '关闭任务抽屉'),
  ]) : null,
}) }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningRoutingEditor.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DeviceMonitoringPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/LinkMonitoringPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SpectrumMonitoringPanel.vue', () => ({ default: { render: () => null } }));

for (const [component, filename] of [
  [GisTaskPanel, 'src/components/GisTaskPanel.vue'], 
  [SituationMonitoringDrawer, 'src/components/SituationMonitoringDrawer.vue'],
  [InterferenceAnalysisPanel, 'src/components/InterferenceAnalysisPanel.vue'],
] as const) {
  await clientTemplate(component, filename, 'gis-layout-render.ts');
}

interface Host {
  tag: string; tagName: string; text: string; parent: Host | null; children: Host[];
  props: Record<string, any>; style: Record<string, string>; clientHeight: number; value?: unknown; checked?: boolean;
  readonly parentElement: Host | null; readonly options: Host[];
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => unknown;
}
function node(tag: string, text = ''): Host {
  return { tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {}, clientHeight: 800,
    get parentElement() { return this.parent; }, get options() { return this.children.filter(n => n.tag === 'option'); },
    addEventListener() {}, removeEventListener() {}, getRootNode: () => document };
}
function remove(child: Host) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: Host, parent: Host, anchor?: Host | null) { remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, child); }
const renderer = createRenderer<Host, Host>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; n.children = []; },
  parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
  patchProp: (n, key, _old, value) => { n.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const n = node('#static', text); insert(n, parent, anchor); return [n, n]; },
});
const textOf = (n: Host): string => (n.tag === '#comment' ? '' : n.text.replace(/<[^>]+>/g, '')) + n.children.map(textOf).join('');
function find(n: Host, predicate: (n: Host) => boolean): Host | undefined { if (predicate(n)) return n; for (const c of n.children) { const hit = find(c, predicate); if (hit) return hit; } }
const all = (n: Host, predicate: (n: Host) => boolean): Host[] => [...(predicate(n) ? [n] : []), ...n.children.flatMap(c => all(c, predicate))];
const button = (root: Host, label: string) => find(root, n => n.tag === 'button' && textOf(n).trim() === label)!;
async function flush() { for (let i = 0; i < 20; i++) await nextTick(); }
let app: App | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); if (pinia) disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(component: Component) {
  vi.stubGlobal('window', new EventTarget());
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('Document', TestDocument);
  pinia = createPinia(); setActivePinia(pinia); authorizeStore();
  const storage = new TestStorage();
  usePreviewStore().data = await createMockService(() => storage).loadPreview();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }, { path: '/planning', component: { render: () => null } }] });
  await router.push('/'); await router.isReady();
  const root = node('root'); app = renderer.createApp(component); app.use(pinia); app.use(router); app.provide(ssrContextKey, {}); app.mount(root); await flush();
  return root;
}

describe('GIS 抽屉与态势分配', () => {
  it('紧凑查看网络入口仍切换到原监控网络，不写入资源或任务', async () => {
    const root = await mount(SituationMonitoringDrawer), gis = useGisWorkspaceStore(), store = useMonitoringStore();
    gis.mapMode = 'resource'; await flush();
    const showNetwork = vi.spyOn(store, 'showNetwork'), action = button(root, '查看网络');
    expect(action).toBeDefined(); expect(action.props['aria-label']).toBe('在地图查看监控网络');
    const before = JSON.stringify(usePreviewStore().data);
    action.props.onClick(); await flush();
    expect(showNetwork).toHaveBeenCalledOnce(); expect(gis.mapMode).toBe('monitoring');
    expect(JSON.stringify(usePreviewStore().data)).toBe(before);
    expect(button(root, '查看网络')).toBeUndefined();
  });
  it('任务查看读取保存版本并发出定位意图，不提供编辑保存入口或覆盖规划草稿', async () => {
    let task!: ReturnType<typeof useGisTaskSelection>;
    const locate = vi.fn();
    const root = await mount({ setup() {
      // 只读任务展示与当前任务草稿分别准备。
      const planning = useTaskInputStore();
      planning.draft = structuredClone(planningPresets[0]!.input);
      planning.draft.name = '规划页未保存名称';
      task = useGisTaskSelection();
      task.selected = { taskId: 'T-SAVED', name: '已保存任务', version: 'V2', updatedAt: '2026-10-19', input: structuredClone(planningPresets[0]!.input) };
      task.library = [task.selected]; task.total = 1;
      return () => h(GisTaskPanel, { controller: task, stations: initialResources().stations, onLocateNode: locate });
    } });
    const before = JSON.stringify(useTaskInputStore().draft);
    expect(textOf(root)).toContain('V2');
    for (const label of ['新建任务', '导入任务', '保存', '撤销编辑', '重做编辑']) expect(button(root, label)).toBeUndefined();
    expect(find(root, n => n.props['data-validation-field'] === 'name')).toBeUndefined();
    button(root, '定位节点').props.onClick(); await flush();
    expect(locate).toHaveBeenCalledWith(task.input!.stationIds[0]);
    expect(JSON.stringify(useTaskInputStore().draft)).toBe(before);
  });

  it('任务编辑入口携带所选保存身份，缺失资源仅禁用相应定位', async () => {
    let task!: ReturnType<typeof useGisTaskSelection>;
    const edit = vi.fn();
    const root = await mount({ setup() {
      task = useGisTaskSelection();
      task.selected = { taskId: 'T2', name: '第二任务', version: 'V1', updatedAt: '2026-10-19', input: structuredClone(planningPresets[0]!.input) };
      task.library = [task.selected]; task.total = 1;
      return () => h(GisTaskPanel, { controller: task, stations: [], onEditTask: edit });
    } });
    expect(all(root, n => n.tag === 'aside')).toHaveLength(0);
    expect(button(root, '定位节点').props.disabled).toBe(true);
    expect(button(root, '定位通联').props.disabled).toBe(true);
    button(root, '编辑任务').props.onClick(); await flush();
    expect(edit).toHaveBeenCalledWith('T2');
    expect(task.taskId).toBe('T2');
  });

  it('态势分隔条按容器限制调整，切换页签和收起保留比例，窗口缩小时重新计算边界', async () => {
    let resize!: () => void;
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
    const root = await mount({ render: () => h('div', [h(SituationMonitoringDrawer)]) });
    const handle = () => find(root, n => n.props['aria-label'] === '调整态势抽屉高度')!;
    const current = () => Number(handle().props['aria-valuenow']);
    const initial = current(); expect(initial).toBeGreaterThan(300);
    handle().props.onKeydown({ key: 'ArrowUp', preventDefault() {} }); await flush(); expect(current()).toBe(initial + 20);
    await button(root, '通信链路态势').props.onClick(); await flush(); expect(current()).toBe(initial + 20);
    const monitor = useMonitoringStore(); monitor.open = false; await flush(); monitor.open = true; await flush(); expect(current()).toBe(initial + 20);
    handle().props.onKeydown({ key: 'End', preventDefault() {} }); await flush(); expect(current()).toBeGreaterThan(500);
    const drawer = find(root, n => String(n.props.class).includes('monitor-drawer'))!;
    drawer.parent!.clientHeight = 400; resize(); await flush();
    expect(current()).toBeLessThanOrEqual(Number(handle().props['aria-valuemax']));
    expect(current()).toBeLessThan(400);
  });

  it('干扰源搜索保留隐藏勾选，定位不改变选择，未生效源仍不可选', async () => {
    const select = vi.fn();
    const root = await mount({ setup() {
      const store = useInterferenceStore();
      store.sources.sources = initialResources().interferences!;
      store.interferenceIds = ['IF-0008'];
      return () => h(InterferenceAnalysisPanel, { sourceEditable: false, selectedNodeId: '', selectedLinkId: '', onSelectSource: select });
    } });
    const store = useInterferenceStore(), search = find(root, n => n.props['aria-label'] === '搜索已保存干扰源')!;
    search.props['onUpdate:modelValue']('if-0001'); await flush();
    expect(all(root, n => n.tag === 'input' && n.props.type === 'checkbox')).toHaveLength(1);
    expect(store.interferenceIds).toEqual(['IF-0008']);
    const locate = find(root, n => n.props['aria-label'] === '定位干扰源 IF-0001')!;
    locate.props.onClick(); expect(select).toHaveBeenCalledWith('IF-0001'); expect(store.interferenceIds).toEqual(['IF-0008']);
    search.props['onUpdate:modelValue'](''); await flush();
    expect(find(root, n => n.tag === 'input' && n.props.value === 'IF-0008')!.checked).toBe(true);
    expect(find(root, n => n.tag === 'input' && n.props.value === 'IF-0013')!.props.disabled).toBe(true);
  });
});

