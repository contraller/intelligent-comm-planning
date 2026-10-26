import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, reactive, ref, ssrContextKey, type App, type Component } from 'vue';
import ChartCanvas from '../src/components/ChartCanvas.vue';
import DeviceMonitoringPanel from '../src/components/DeviceMonitoringPanel.vue';
import { monitoringPresets } from '../src/mocks/monitoring-presets';
// 仅复用模板编译，原有宿主、替身和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';

// 真实组件生命周期运行，只替换 ECharts 绘制与浏览器尺寸观察。
const probe = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('echarts/core', () => ({ use: vi.fn(), init: probe.init }));
vi.mock('../src/components/StatusBadge.vue', () => ({ default: { render: () => null } }));
interface Host {
  tag: string; tagName: string; text: string; children: Host[]; parent: Host | null;
  props: Record<string, any>; style: Record<string, string>; clientWidth: number; clientHeight: number;
  value: unknown; addEventListener: () => void; removeEventListener: () => void; getRootNode: () => unknown;
  readonly options: Host[];
}
let width = 800, height = 280;
function node(tag: string, text = ''): Host {
  return { tag, tagName: tag.toUpperCase(), text, children: [], parent: null, props: {}, style: {},
    clientWidth: width, clientHeight: height, value: '', addEventListener() {}, removeEventListener() {},
    getRootNode: () => document, get options() { return this.children.filter(row => row.tag === 'option'); } };
}
function remove(child: Host) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: Host, parent: Host, anchor?: Host | null) {
  remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(index < 0 ? parent.children.length : index, 0, child);
}
const renderer = createRenderer<Host, Host>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text; }, setElementText: (target, text) => { target.text = text; target.children = []; },
  parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
  patchProp: (target, key, _old, value) => { target.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const target = node('#static', text); insert(target, parent, anchor); return [target, target]; },
});
const find = (root: Host, label: string): Host | undefined => root.props['aria-label'] === label ? root : root.children.map(child => find(child, label)).find(Boolean);
const charts: { host: Host; setOption: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];
const observers: { notify: () => void; disconnect: ReturnType<typeof vi.fn<() => void>> }[] = [];
const apps: App[] = [];
async function mount(component: Component, props: () => Record<string, unknown>) {
  const root = node('root'), app = renderer.createApp({ render: () => h(component, props()) });
  apps.push(app); app.provide(ssrContextKey, {}); app.mount(root); await nextTick(); return root;
}
beforeAll(async () => {
  for (const [component, filename] of [[ChartCanvas, 'src/components/ChartCanvas.vue'], [DeviceMonitoringPanel, 'src/components/DeviceMonitoringPanel.vue']] as const) {
    await clientTemplate(component, filename, 'chart-lifecycle-render.ts');
  }
});
beforeEach(() => {
  width = 800; height = 280;
  class TestDocument { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  vi.stubGlobal('ShadowRoot', class {});
  vi.stubGlobal('ResizeObserver', class {
    entry: typeof observers[number];
    constructor(callback: () => void) { this.entry = { notify: callback, disconnect: vi.fn() }; observers.push(this.entry); }
    observe() {} disconnect() { this.entry.disconnect(); }
  });
  probe.init.mockImplementation((host: Host) => {
    const chart = { host, setOption: vi.fn(), resize: vi.fn(), on: vi.fn(), dispose: vi.fn() }; charts.push(chart); return chart;
  });
});
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount()); charts.splice(0); observers.splice(0);
  vi.clearAllMocks(); vi.unstubAllGlobals();
});

describe('态势图表绘制生命周期', () => {
  it.each(['width', 'height'])('零 %s 不初始化，恢复尺寸只创建一次并展示最新数据', async dimension => {
    if (dimension === 'width') width = 0; else height = 0;
    const option = ref({ series: [{ type: 'bar', data: [1] }] });
    const root = await mount(ChartCanvas, () => ({ option: option.value }));
    option.value.series[0].data = [3]; await nextTick(); observers[0].notify();
    expect(probe.init).not.toHaveBeenCalled();
    const host = root.children[0]; host.clientWidth = 800; host.clientHeight = 280;
    observers[0].notify(); observers[0].notify();
    expect(probe.init).toHaveBeenCalledTimes(1); expect(charts[0].setOption).toHaveBeenCalledTimes(1);
    expect(charts[0].setOption.mock.lastCall![0].series[0].data).toEqual([3]);
  });
  it('收起期间不更新或调整图表，重开复用实例并应用最后一次数据，卸载拒绝迟到观察', async () => {
    const option = ref({ series: [{ type: 'bar', data: [1] }] });
    await mount(ChartCanvas, () => ({ option: option.value }));
    const chart = charts[0]; chart.host.clientWidth = 0;
    option.value.series[0].data = [2]; await nextTick(); option.value.series[0].data = [4]; await nextTick();
    observers[0].notify(); expect(chart.setOption).toHaveBeenCalledTimes(1); expect(chart.resize).not.toHaveBeenCalled();
    chart.host.clientWidth = 800; observers[0].notify();
    expect(probe.init).toHaveBeenCalledTimes(1); expect(chart.resize).toHaveBeenCalledTimes(1);
    expect(chart.setOption.mock.lastCall![0].series[0].data).toEqual([4]);
    apps.pop()!.unmount(); observers[0].notify();
    expect(chart.dispose).toHaveBeenCalledTimes(1); expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(chart.resize).toHaveBeenCalledTimes(1); expect(probe.init).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('保留原选项合并方式和点选事件，smoothUpdate=%s', async smoothUpdate => {
    const select = vi.fn(); await mount(ChartCanvas, () => ({ option: { series: [] }, smoothUpdate, onSelect: select }));
    expect(charts[0].setOption.mock.lastCall![1]).toEqual(smoothUpdate ? { notMerge: false, replaceMerge: ['series'], lazyUpdate: true } : { notMerge: true });
    charts[0].on.mock.calls[0][1]({ data: { id: 'ND-0001' } }); expect(select).toHaveBeenCalledWith('ND-0001');
  });
  it('设备表格搜索与筛选不重绘分布图，观测分布改变只更新对应图表', async () => {
    const preset = monitoringPresets[0], frame = reactive(structuredClone(preset.frames[0]));
    const root = await mount(DeviceMonitoringPanel, () => ({ network: preset.network, frame, selectedId: '' }));
    expect(charts).toHaveLength(3);
    find(root, '筛选监控设备')!.props['onUpdate:modelValue']('DV-0001');
    find(root, '筛选设备观测状态')!.props['onUpdate:modelValue']('FAULT'); await nextTick();
    expect(charts.map(chart => chart.setOption.mock.calls.length)).toEqual([1, 1, 1]);
    frame.statistics.power[0].count++; await nextTick();
    expect(charts.map(chart => chart.setOption.mock.calls.length)).toEqual([1, 2, 1]);
  });
});
