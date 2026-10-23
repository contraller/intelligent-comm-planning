import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, reactive, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import ResourceStatusPanel from '../src/components/ResourceStatusPanel.vue';
import ResourceStatusBadge from '../src/components/ResourceStatusBadge.vue';
import DeviceInfoPanel from '../src/components/DeviceInfoPanel.vue';
import StatusBadge from '../src/components/StatusBadge.vue';
import GisDeviceClusterPanel from '../src/components/GisDeviceClusterPanel.vue';
import { gisDevicePoints, defaultGisDeviceSettings, GIS_DEVICE_COLORS } from '../src/maps/gis-device-display';
import { gisDeviceStyles } from '../src/maps/gis-device-layers';
import { useResourceStatusStore } from '../src/stores/resource-status';
import { usePreviewStore } from '../src/stores/preview';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { TestStorage } from './helpers/storage';
import { authorizeStore } from './helpers/auth';

vi.mock('../src/components/DeviceDetailTabs.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ setup(_, { slots }) { return () => h('details-probe', [slots.basic?.(), slots.parameters?.(), slots.actions?.()]); } }) };
});
vi.mock('../src/composables/useDeviceKnowledgeSummary', async () => {
  const { ref } = await import('vue');
  return { useDeviceKnowledgeSummary: () => ({ summary: ref(null), status: ref('forbidden'), error: ref(''), retry() {} }) };
});
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'resource-ledger-render.ts', { loader: 'ts' });
  (component as ComponentOptions).render = new Function('Vue', code + ';return createRender(Vue);')(Vue);
}
interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown; readonly options: HostNode[];
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
function all(root: HostNode, predicate: (n: HostNode) => boolean): HostNode[] {
  return [...(predicate(root) ? [root] : []),...root.children.flatMap(child => all(child,predicate))];
}
const textOf = (root: HostNode): string => root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


await Promise.all([
  [ResourceStatusPanel, 'ResourceStatusPanel'], [ResourceStatusBadge, 'ResourceStatusBadge'],
  [DeviceInfoPanel, 'DeviceInfoPanel'], [StatusBadge, 'StatusBadge'], [GisDeviceClusterPanel, 'GisDeviceClusterPanel'],
].map(([component, name]) => clientTemplate(component as Component, 'src/components/' + name + '.vue')));
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup() {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage), preview = usePreviewStore(); preview.data = await raw.loadPreview();
  vi.spyOn(previewService, 'loadDeviceStatusContext').mockImplementation(raw.loadDeviceStatusContext);
  vi.spyOn(previewService, 'queryDeviceStatuses').mockImplementation(raw.queryDeviceStatuses);
  const status = useResourceStatusStore(), root = node('root');
  function mount(render: () => Vue.VNode) { app = renderer.createApp({ render }); app.use(pinia!); app.provide(ssrContextKey, {}); app.mount(root); }
  return { root, mount, auth, storage, raw, preview, status };
}
async function change(root: HostNode, label: string, value: string) {
  const el = find(root, n => n.props['aria-label'] === label)!; expect(el).toBeDefined();
  (el.props.onChange as Function)({ target: { value } }); await settle();
}

// 客户端模板与 OpenLayers 样式对象实际执行；不将内存宿主当作视觉验收。
describe('设备状态同步控件和详情', () => {
  it('全部/勾选按钮目标清楚，显示缺报失败结果，重复读取不改采集时间', async () => {
    const s = await setup(), props = reactive({ enabled: true, selectedIds: ['DV-0001', 'DV-0002'], hiddenCount: 1 });
    s.mount(() => h(ResourceStatusPanel, { context: 'ledger', ...props })); await settle();
    expect(textOf(s.root)).toContain('同步全部设备状态（414）'); expect(textOf(s.root)).toContain('包含筛选外 1 台');
    await change(s.root, '设备状态教学样例', 'partial'); await click(s.root, '同步勾选设备状态（2）'); await settle();
    expect(previewService.queryDeviceStatuses).toHaveBeenLastCalledWith(expect.objectContaining({ deviceIds: props.selectedIds }));
    expect(textOf(s.root)).toContain('已上报 0 / 未上报 1 / 失败 1'); expect(textOf(s.root)).toContain('本批未收到设备上报');
    await change(s.root, '设备状态教学样例', 'abnormal'); await click(s.root, '同步全部设备状态（414）'); await settle();
    const sampled = s.status.records['DV-0001'].observation!.observedAt;
    await click(s.root, '同步全部设备状态（414）'); await settle(); expect(s.status.records['DV-0001'].observation!.observedAt).toBe(sampled);
    expect(s.storage.writes).toBe(0);
  });
  it('暂停/失权禁用控件，直接触发事件也不能改来源与示例', async () => {
    const s = await setup(), props = reactive({ enabled: true, pausedReason: '' });
    s.mount(() => h(ResourceStatusPanel, { context: 'gis', ...props })); await settle();
    await click(s.root, '同步全部设备状态（414）'); await settle(); expect(s.status.mode).toBe('observed');
    props.enabled = false; props.pausedReason = '编辑态暂不叠加同步观测'; await settle();
    const before = JSON.stringify(s.status.records), calls = vi.mocked(previewService.queryDeviceStatuses).mock.calls.length;
    await change(s.root, '设备状态来源', 'baseline'); await change(s.root, '设备状态教学样例', 'failed');
    await click(s.root, '同步全部设备状态（414）'); expect(s.status.mode).toBe('observed'); expect(s.status.exampleId).toBe('normal');
    expect(JSON.stringify(s.status.records)).toBe(before); expect(previewService.queryDeviceStatuses).toHaveBeenCalledTimes(calls);
    expect(textOf(s.root)).toContain('编辑态暂不叠加同步观测');
  });
  it('详情使用观测状态和采集时间，但原设备参数保持不变；撤去可选输入恢复基线', async () => {
    const s = await setup(), key = Symbol(); await s.status.load('ledger', key, () => true); s.status.setExample('abnormal');
    await s.status.sync('ledger', ['DV-0001', 'DV-0004'], key, () => true);
    const props = reactive({ observed: true, id: 'DV-0001' }), resources = s.preview.data!.resources, before = JSON.stringify(resources);
    s.mount(() => { const device = resources.devices.find(d => d.id === props.id)!;
      return h(DeviceInfoPanel, { device, resources, statusDisplay: props.observed ? s.status.display(device) : undefined }); });
    expect(textOf(s.root)).toContain('设备故障'); expect(textOf(s.root)).toContain('2026-10-16T08:00:00+08:00');
    props.id = 'DV-0004'; await settle(); expect(textOf(s.root)).toContain('状态未提供'); expect(textOf(s.root)).toContain('告警未提供');
    expect(find(s.root, n => String(n.props.class).includes('unknown'))).toBeDefined();
    props.observed = false; await settle(); expect(textOf(s.root)).not.toContain('最近获取'); expect(JSON.stringify(resources)).toBe(before);
  });
  it('未知观测地图用中性色、聚合标缺省数量和来源时间，正常原图标仍兼容', async () => {
    const s = await setup(), key = Symbol(); await s.status.load('ledger', key, () => true); s.status.setExample('abnormal');
    await s.status.sync('ledger', ['DV-0004', 'DV-0005'], key, () => true);
    const points = gisDevicePoints(s.preview.data!.resources, s.status.displays).points.filter(p => ['DV-0004', 'DV-0005'].includes(p.id));
    const styles = gisDeviceStyles([points[0]], defaultGisDeviceSettings(), '');
    expect((styles[0].getImage() as any).getStroke().getColor()).toBe(GIS_DEVICE_COLORS.UNKNOWN);
    expect(gisDeviceStyles(points, defaultGisDeviceSettings(), '').some(style => style.getText()?.getText() === '状态/告警未提供 2')).toBe(true);
    const choose = vi.fn(); s.mount(() => h(GisDeviceClusterPanel, { members: points, disabled: false, onSelect: choose }));
    expect(textOf(s.root)).toContain('部分异常教学样例'); expect(textOf(s.root)).toContain('2026-10-16T08:00:00+08:00');
    const el = find(s.root, n => n.props['aria-label'] === '查看聚合设备 DV-0004')!; (el.props.onClick as Function)();
    expect(choose).toHaveBeenCalledWith('DV-0004');
  });
});

