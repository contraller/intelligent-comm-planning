import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import GisDeviceLayerPanel from '../src/components/GisDeviceLayerPanel.vue';
import GisDeviceClusterPanel from '../src/components/GisDeviceClusterPanel.vue';
import { emptyDeviceFrequencyInput, emptyDeviceFrequencyFilter } from '../src/services/device-frequency-filter';
import { initialResources } from '../src/mocks/resource-presets';
import { defaultGisDeviceSettings, gisDevicePoints, type GisDeviceStateFilter } from '../src/maps/gis-device-display';
// 仅复用模板编译，原有特殊宿主和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';

// 实际组件模板在内存宿主运行，验证事件和文本，不模拟真实布局。

await Promise.all([clientTemplate(GisDeviceLayerPanel, 'src/components/GisDeviceLayerPanel.vue', 'coverage-render.ts'),
  clientTemplate(GisDeviceClusterPanel, 'src/components/GisDeviceClusterPanel.vue', 'coverage-render.ts')]);
interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown;
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
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
async function change(root: HostNode, label: string, value: string | boolean, event = 'onChange') {
  const el = find(root, n => n.props['aria-label'] === label);
  expect(el, label).toBeDefined();
  (el!.props[event] as (e: unknown) => void)({ target: { value, checked: value } }); await nextTick();
}

let app: App<HostNode> | undefined;
afterEach(() => { app?.unmount(); app = undefined; });
function mountControl() {
  const props = reactive({ settings: defaultGisDeviceSettings(), state: 'ALL' as GisDeviceStateFilter, available: true, missingCount: 0, count: 414,
    frequencyInput: emptyDeviceFrequencyInput(), frequency: emptyDeviceFrequencyFilter(), frequencyPending: false, frequencyError: '', frequencyNotice: '' });
  const configure = vi.fn(), filter = vi.fn(), updateFrequency = vi.fn(), applyFrequency = vi.fn(), clearFrequency = vi.fn(), root = node('root');
  app = renderer.createApp({ render: () => h(GisDeviceLayerPanel, { ...props, onConfigure: configure, onFilter: filter, onUpdateFrequency: updateFrequency, onApplyFrequency: applyFrequency, onClearFrequency: clearFrequency }) });
  app.provide(ssrContextKey, {}); app.mount(root);
  return { props, root, configure, filter, updateFrequency, applyFrequency, clearFrequency };
}
describe('设备图层控制与聚合清单模板', () => {
  it('两类开关和透明度分别发事件，状态筛选不直接改动传入数据', async () => {
    const s = mountControl(), before = JSON.stringify(s.props);
    await change(s.root, '显示HF设备', false); expect(s.configure).toHaveBeenLastCalledWith('HF', { visible: false });
    await change(s.root, 'VUHF设备透明度', '0.3', 'onInput'); expect(s.configure).toHaveBeenLastCalledWith('VUHF', { opacity: 0.3 });
    await change(s.root, '设备点位状态', 'ALERT'); expect(s.filter).toHaveBeenCalledWith('ALERT');
    expect(JSON.stringify(s.props)).toBe(before); expect(textOf(s.root)).toContain('414 台设备');
  });
  it('不适用时禁用所有显示控件，直接触发事件也不能修改，缺资料说明不假报结果', async () => {
    const s = mountControl(); s.props.available = false; await nextTick();
    for (const label of ['显示HF设备', '显示VUHF设备', 'HF设备透明度', 'VUHF设备透明度', '设备点位状态']) {
      expect(find(s.root, row => row.props['aria-label'] === label)!.props.disabled).toBe(true);
    }
    await change(s.root, '显示HF设备', false); await change(s.root, 'HF设备透明度', '0.4', 'onInput'); await change(s.root, '设备点位状态', 'FAULT');
    expect(s.configure).not.toHaveBeenCalled(); expect(s.filter).not.toHaveBeenCalled(); expect(textOf(s.root)).toContain('当前显示偏好已保留');
    s.props.available = true; s.props.missingCount = 2; s.props.count = 0; await nextTick();
    expect(textOf(s.root)).toContain('2 台设备缺少有效类别或位置'); expect(textOf(s.root)).toContain('当前显示 0 台设备');
  });
  it('聚合清单显示精确设备和附加状态，选择/收起只发意图', async () => {
    const points = gisDevicePoints(initialResources()).points.slice(0, 2); points[0].status = 'FAULT'; points[0].alert = true; points[0].offShelf = true; points[0].manualStation = true;
    const props = reactive({ members: points, disabled: false }), select = vi.fn(), close = vi.fn(), root = node('root');
    app = renderer.createApp({ render: () => h(GisDeviceClusterPanel, { ...props, onSelect: select, onClose: close }) });
    app.provide(ssrContextKey, {}); app.mount(root);
    expect(textOf(root)).toContain('故障 · 告警 · 已下架'); expect(textOf(root)).toContain('人工标绘站点');
    expect(textOf(root)).toContain(points[0].stationId);
    const button = find(root, row => row.props['aria-label'] === '查看聚合设备 ' + points[0].id)!;
    (button.props.onClick as () => void)(); expect(select).toHaveBeenCalledWith(points[0].id);
    await click(root, '收起设备清单'); expect(close).toHaveBeenCalledOnce(); expect(props.members).toHaveLength(2);
    props.disabled = true; await nextTick(); (button.props.onClick as () => void)(); expect(select).toHaveBeenCalledTimes(1);
    props.members = []; await nextTick(); expect(textOf(root)).toContain('当前聚合没有可显示的设备');
  });
});


// 使用原生表单提交事件，区别输入变化与真正应用条件。
describe('GIS 频率筛选控件', () => {
  const control = (root: HostNode, label: string) => find(root, row => row.props['aria-label'] === label)!;
  const submit = async (root: HostNode) => {
    (control(root, 'GIS 设备频率筛选').props.onSubmit as Function)({ preventDefault() {} }); await nextTick();
  };
  it('输入只发更新事件，提交和清除各自独立，摘要显示实际已应用条件', async () => {
    const s = mountControl(); await change(s.root, 'GIS 频率筛选依据', 'MODEL');
    expect(s.updateFrequency).toHaveBeenLastCalledWith({ mode: 'MODEL', presence: 'ALL', min: '', max: '' });
    expect(s.applyFrequency).not.toHaveBeenCalled(); expect(s.props.frequencyInput.mode).toBe('ALL');
    s.props.frequencyInput.mode = 'MODEL'; s.props.frequencyPending = true; await nextTick();
    await change(s.root, 'GIS 频率下限（kHz）', '6000', 'onInput');
    expect(s.updateFrequency).toHaveBeenLastCalledWith({ mode: 'MODEL', presence: 'ALL', min: '6000', max: '' });
    expect(textOf(s.root)).toContain('已应用：不限频率'); expect(textOf(s.root)).toContain('尚未应用');
    await submit(s.root); expect(s.applyFrequency).toHaveBeenCalledOnce();
    await click(s.root, '清除频率条件'); expect(s.clearFrequency).toHaveBeenCalledOnce();
  });
  it('频点为空停用范围，错误与定位解除提示不伪装已应用条件', async () => {
    const s = mountControl(); s.props.frequencyInput.mode = 'DEVICE'; s.props.frequencyInput.presence = 'MISSING';
    s.props.frequencyInput.min = 'bad'; s.props.frequencyError = '频率下限须为非负有限数（kHz）';
    s.props.frequencyNotice = '已为定位目标解除频率限制'; await nextTick();
    expect(control(s.root, 'GIS 频率下限（kHz）').props.disabled).toBe(true);
    expect(control(s.root, 'GIS 频率上限（kHz）').props.disabled).toBe(true);
    await change(s.root, 'GIS 频率下限（kHz）', '1', 'onInput'); expect(s.updateFrequency).not.toHaveBeenCalled();
    expect(find(s.root, row => row.props.role === 'alert') && textOf(s.root)).toContain('非负有限数');
    expect(textOf(s.root)).toContain('解除频率限制');
    await change(s.root, 'GIS 工作频点是否有值', 'PRESENT');
    expect(s.updateFrequency).toHaveBeenLastCalledWith({ mode: 'DEVICE', presence: 'PRESENT', min: 'bad', max: '' });
  });
  it('无权或非资源地图时所有新增控件禁用，直接调用事件也不提交', async () => {
    const s = mountControl(); s.props.frequencyInput.mode = 'DEVICE'; s.props.available = false; await nextTick();
    for (const label of ['GIS 频率筛选依据', 'GIS 工作频点是否有值', 'GIS 频率下限（kHz）', 'GIS 频率上限（kHz）']) {
      expect(control(s.root, label).props.disabled).toBe(true);
    }
    await change(s.root, 'GIS 频率筛选依据', 'MODEL'); await change(s.root, 'GIS 频率下限（kHz）', '6000', 'onInput');
    await submit(s.root); await click(s.root, '清除频率条件');
    expect(s.updateFrequency).not.toHaveBeenCalled(); expect(s.applyFrequency).not.toHaveBeenCalled(); expect(s.clearFrequency).not.toHaveBeenCalled();
  });
});
