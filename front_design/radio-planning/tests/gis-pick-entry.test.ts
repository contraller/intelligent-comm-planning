import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import SituationView from '../src/views/SituationView.vue';
import AppDrawer from '../src/components/AppDrawer.vue';
import ResourceEditDrawer from '../src/components/ResourceEditDrawer.vue';
import InterferenceSourceDrawer from '../src/components/InterferenceSourceDrawer.vue';
import GisResourceTree from '../src/components/GisResourceTree.vue';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { usePlanningStore } from '../src/stores/planning';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useAuthStore } from '../src/stores/auth';
import { createMockService } from '../src/services/mock';
import { previewService } from '../src/services';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { bindMonitoring, settleMonitoring } from './helpers/monitoring';
import type { GisPickContext, GisPickResult, GisPickToggle } from '../src/types/gis-pick';

// 页面、表单、Pinia 和 Mock 服务真实运行，地图的投影与聚合由组件测试覆盖。
vi.mock('../src/components/MapCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false, props: ['gisPick', 'picking', 'stations'],
    setup: (props, { attrs, expose }) => { expose({ locate() {}, locateResource() {} }); return () => h('map-probe', { ...props, ...attrs }); } }) };
});
vi.mock('primevue/drawer', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], emits: ['update:visible', 'after-show'],
    setup: (props, { slots }) => () => props.visible ? h('drawer-probe', {}, [slots.default?.(), slots.footer?.()]) : null }) };
});
vi.mock('../src/components/ObjectInfoPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/StatusBadge.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/TaskWorkspacePanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/InterferenceAnalysisPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SituationMonitoringDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/MonitoringObjectPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/InterferenceHistoryDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/InterferenceMeasureDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceExportDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));
let focused: HostNode | null = null, scrolled: HostNode | null = null;
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'coverage-render.ts', { loader: 'ts' });
  (component as ComponentOptions).render = new Function('Vue', code + ';return createRender(Vue);')(Vue);
}

interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[]; options:HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown;
  focus: () => void; scrollIntoView: () => void; getAttribute: (key:string) => unknown; matches:(selector:string)=>boolean; querySelectorAll:()=>HostNode[];
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
  get options(){return this.children.filter(n=>n.tag==='option');},
  focus(){focused=this;},scrollIntoView(){scrolled=this;},getAttribute(key){return this.props[key];},matches(){return !!this.props.disabled;},
  querySelectorAll(){const all:HostNode[]=[];const walk=(n:HostNode)=>{for(const c of n.children){if(c.props['data-validation-field'])all.push(c);walk(c);}};walk(this);return all;},
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


await Promise.all([
  [SituationView, 'src/views/SituationView.vue'], [AppDrawer, 'src/components/AppDrawer.vue'],
  [ResourceEditDrawer, 'src/components/ResourceEditDrawer.vue'], [InterferenceSourceDrawer, 'src/components/InterferenceSourceDrawer.vue'],
  [GisResourceTree, 'src/components/GisResourceTree.vue'],
].map(([component, path]) => clientTemplate(component as Component, path as string)));
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); focused = null; scrolled = null; });
async function settle() { for (let i = 0; i < 8; i++) await nextTick(); }
async function mountEntry() {
  vi.useFakeTimers(); vi.stubGlobal('window', new EventTarget());
  class TestDocument extends EventTarget { hidden = false; activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  vi.spyOn(previewService, 'loadPreview').mockImplementation(raw.loadPreview);
  vi.spyOn(previewService, 'loadInterferenceWorkspace').mockImplementation(raw.loadInterferenceWorkspace);
  vi.spyOn(previewService, 'loadPlanningWorkspace').mockImplementation(raw.loadPlanningWorkspace);
  vi.spyOn(previewService, 'loadTaskWorkspace').mockImplementation(raw.loadTaskWorkspace);
  const save = vi.spyOn(previewService, 'commitGisWorkspace').mockImplementation(raw.commitGisWorkspace);
  const submit = vi.spyOn(previewService, 'submitPlanning'), impact = vi.spyOn(previewService, 'submitInterferenceAnalysis');
  bindMonitoring(raw);
  const preview = usePreviewStore(), planning = usePlanningStore(), editor = useResourceEditStore(), gis = useGisWorkspaceStore();
  await preview.load(); await planning.load(); gis.begin();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/situation', component: SituationView }, { path: '/planning', component: { render: () => null } }] });
  app = renderer.createApp({ render: () => h(Vue.Fragment, [h(RouterView), h(ResourceEditDrawer)]) });
  app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  await router.push('/situation'); await router.isReady(); const root = node('root'); app.mount(root); await settleMonitoring(); await settle();
  const map = () => find(root, n => n.tag === 'map-probe')!;
  const capture = () => {
    const props = map().props, context = props.gisPick as GisPickContext;
    return { context: JSON.parse(JSON.stringify(context)) as GisPickContext, pick: props.onGisPick as (result: GisPickResult) => void,
      cancel: props.onGisPickCancel as (key: string) => void, toggle: props.onGisPickToggle as (value: GisPickToggle) => void };
  };
  const start = async (kind: 'station' | 'interference' = 'station', id?: string) => {
    if (id) { await editor.openForm(kind, id, 'gis'); editor.picking = true; } else await editor.newForm(kind, 'gis');
    await settle(); return capture();
  };
  return { editor, gis, planning, preview, auth, storage, save, submit, impact, root, capture, start };
}
describe('GIS 吸附的真实页面入口', () => {
  it.each(['station', 'interference'] as const)('%s 新建取点返回原抽屉，只填坐标、提示未应用，无业务请求', async kind => {
    const s = await mountEntry(), frame = await s.start(kind), fields = { ...s.editor.form!.fields };
    const target = frame.context.targets.find(row => row.kind !== kind)!;
    const resources = JSON.stringify(s.editor.resources), writes = s.storage.writes;
    frame.pick({ key: frame.context.key, coordinate: target.coordinate, target }); await settle();
    expect(s.editor.form!.fields).toEqual({ ...fields, longitude: target.coordinate[0].toFixed(6), latitude: target.coordinate[1].toFixed(6) });
    expect(textOf(s.root)).toContain('已采用'); expect(textOf(s.root)).toContain(target.id); expect(textOf(s.root)).toContain('尚未应用');
    expect(s.editor.picking).toBe(false); expect(JSON.stringify(s.editor.resources)).toBe(resources);
    expect(s.storage.writes).toBe(writes); expect(s.save).not.toHaveBeenCalled(); expect(s.submit).not.toHaveBeenCalled(); expect(s.impact).not.toHaveBeenCalled();
    const longitude = find(s.root, n => n.props['data-validation-field'] === 'longitude')!;
    (longitude.props['onUpdate:modelValue'] as (value: string) => void)('114.650001'); await settle();
    expect(s.editor.pickNotice).toBe(''); expect(textOf(s.root)).not.toContain('已采用');
    await click(s.root, kind === 'station' ? '在地图上重新取点' : '在地图上取点'); await settle();
    const again = s.capture(), before = { ...s.editor.form!.fields }; again.cancel(again.context.key); await settle();
    expect(s.editor.form!.fields).toEqual(before);
  });
  it('仅已应用草稿加入目标，读取草稿位置；未应用预览、自身和资源筛选外对象不参与', async () => {
    const s = await mountEntry(); await s.start(); const newId = s.editor.form!.id;
    expect(s.capture().context.targets.some(row => row.id === newId)).toBe(false);
    const frame = s.capture(); frame.pick({ key: frame.context.key, coordinate: [114.66, 37.51] });
    s.editor.form!.fields.name = '草稿吸附点'; expect(s.editor.applyForm(), s.editor.error).toBe(true);
    await s.editor.closeForm(); const second = await s.start('interference');
    expect(second.context.targets.find(row => row.id === newId)?.coordinate).toEqual([114.66, 37.51]);
    expect(s.preview.data!.resources.stations.some(row => row.id === newId)).toBe(false);
    const search = find(s.root, n => n.props['aria-label'] === '搜索资源')!;
    (search.props.onInput as (event: unknown) => void)({ target: { value: '草稿吸附点' } }); await settle();
    expect(s.capture().context.targets.map(row => row.id)).toEqual([newId]);
    const oldTarget = second.context.targets.find(row => row.id !== newId)!;
    second.pick({ key: second.context.key, coordinate: oldTarget.coordinate, target: oldTarget });
    expect(s.editor.picking).toBe(true);
  });
  it('A→B→A 的相同 ID 重开不接受旧点击、取消或开关', async () => {
    const s = await mountEntry(), old = await s.start('station', 'ND-0001');
    s.editor.picking = false; await s.editor.closeForm(); await s.start('station', 'ND-0002');
    s.editor.picking = false; await s.editor.closeForm(); const current = await s.start('station', 'ND-0001');
    const fields = { ...s.editor.form!.fields };
    expect(current.context.key).not.toBe(old.context.key);
    old.pick({ key: old.context.key, coordinate: [114.65, 37.5] }); old.cancel(old.context.key); old.toggle({ key: old.context.key, enabled: false });
    expect(s.editor.form!.fields).toEqual(fields); expect(s.editor.picking).toBe(true); expect(s.capture().context.enabled).toBe(true);
  });
  it.each(['mode', 'permission', 'busy', 'session', 'account', 'draft'] as const)('%s 往返后旧事件失效；新会话可重新取点', async reason => {
    const s = await mountEntry(), old = await s.start('station', 'ND-0001'), fields = { ...s.editor.form!.fields };
    if (reason === 'mode') { s.gis.mapMode = 'analysis'; s.gis.mapMode = 'resource'; }
    if (reason === 'permission') { const permissions = [...s.auth.identity!.permissions]; s.auth.identity!.permissions = []; s.auth.identity!.permissions = permissions; }
    if (reason === 'busy') { s.preview.busy = true; s.preview.busy = false; }
    if (reason === 'session') s.auth.identity!.sessionId = 'next';
    if (reason === 'account') s.auth.identity!.id = 'other-account';
    if (reason === 'draft') { s.editor.draft!.stations[1]!.coordinate = [114.66, 37.52]; }
    await settle(); old.pick({ key: old.context.key, coordinate: [114.65, 37.5] }); old.cancel(old.context.key);
    expect(s.editor.picking).toBe(true); expect(s.editor.form!.fields).toEqual(fields);
    const current = s.capture(); current.pick({ key: current.context.key, coordinate: [114.65, 37.5] });
    expect(s.editor.form!.fields.longitude).toBe('114.650000'); expect(s.editor.picking).toBe(false);
  });
  it('临时失权保留吸附偏好和字段，切会话复位开启且保留已有输入', async () => {
    const s = await mountEntry(), frame = await s.start();
    frame.toggle({ key: frame.context.key, enabled: false }); await settle();
    const fields = { ...s.editor.form!.fields }, permissions = [...s.auth.identity!.permissions];
    s.auth.identity!.permissions = []; await settle(); expect(s.capture().context.active).toBe(false);
    s.capture().pick({ key: s.capture().context.key, coordinate: [114.65, 37.5] }); expect(s.editor.form!.fields).toEqual(fields);
    s.auth.identity!.permissions = permissions; await settle(); expect(s.capture().context.enabled).toBe(false);
    s.auth.identity!.sessionId = 'next'; await settle(); expect(s.capture().context.enabled).toBe(true); expect(s.editor.form!.fields).toEqual(fields);
  });
  it('当前目标坐标不符或不存在时拒绝回填，不信旧高亮内容', async () => {
    const s = await mountEntry(), frame = await s.start(), target = frame.context.targets[0]!, fields = { ...s.editor.form!.fields };
    frame.pick({ key: frame.context.key, coordinate: [114.65, 37.5], target });
    frame.pick({ key: frame.context.key, coordinate: target.coordinate, target: { ...target, id: 'missing' } });
    expect(s.editor.picking).toBe(true); expect(s.editor.form!.fields).toEqual(fields);
  });
  it('吸附后可统一保存，提交只含业务坐标，没有目标 ID 或吸附配置', async () => {
    const s = await mountEntry(), frame = await s.start('station', 'ND-0001');
    const target = frame.context.targets.find(row => row.kind === 'station')!;
    frame.pick({ key: frame.context.key, coordinate: target.coordinate, target }); await settle();
    expect(await s.gis.save(), s.editor.error).toBe(true);
    expect(s.save).toHaveBeenCalledOnce();
    const request = s.save.mock.calls[0]![0];
    expect(request.changes.stations[0]!.coordinate).toEqual(target.coordinate);
    expect(JSON.stringify(request)).not.toContain('gisPick'); expect(JSON.stringify(request)).not.toContain('pickNotice');
    expect(s.preview.data!.resources.stations.find(row => row.id === 'ND-0001')!.coordinate).toEqual(target.coordinate);
    expect(s.editor.pickNotice).toBe('');
  });
  it('页面卸载后旧回调不再写入遗留表单', async () => {
    const s = await mountEntry(), frame = await s.start(), form = s.editor.form!, before = { ...form.fields };
    app!.unmount(); app = undefined;
    frame.pick({ key: frame.context.key, coordinate: [114.65, 37.5] }); frame.cancel(frame.context.key);
    expect(form.fields).toEqual(before);
  });
});

