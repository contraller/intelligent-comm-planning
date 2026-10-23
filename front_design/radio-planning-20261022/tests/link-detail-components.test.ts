import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, createRenderer, h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import LinkDetailPanel from '../src/components/LinkDetailPanel.vue';
import LinkHistoryChart from '../src/components/LinkHistoryChart.vue';
import { createLinkDetailContext, LINK_METRICS } from '../src/services/link-detail';
import { createMockService } from '../src/services/mock';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
// 仅复用模板编译，原有特殊宿主和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';

// 保留真实面板和趋势选项构造，仅将需要 Canvas 的宿主替换为可检查探针。
vi.mock('../src/components/ChartCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['option', 'height', 'label'], setup(props) {
    return () => h('chart-probe', { ...props });
  } }) };
});


await Promise.all([clientTemplate(LinkDetailPanel, 'src/components/LinkDetailPanel.vue', 'coverage-render.ts'), clientTemplate(LinkHistoryChart, 'src/components/LinkHistoryChart.vue', 'coverage-render.ts')]);

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

// 原生 details 的 toggle 事件驱动真实懒挂载；保留原有采样与权限断言。
async function toggleHistory(root: HostNode, open: boolean) {
  const group = find(root, n => n.tag === 'details' && n.props['aria-label'] === '链路历史趋势');
  expect(group).toBeDefined();
  expect(textOf(find(group!, n => n.tag === 'summary')!)).toBe('历史趋势');
  await (group!.props.onToggle as (event: unknown) => unknown)({ currentTarget: { open } });
  await nextTick();
  expect(group!.props.open).toBe(open);
}

interface ChartOption {
  xAxis: { type: string }; yAxis: { name: string };
  tooltip: { renderMode: string; formatter: (params: unknown) => string };
  series: { connectNulls: boolean; smooth: boolean; data: { value: [number, number | null]; itemStyle: { color: string } }[] }[];
}
const chart = (root: HostNode) => find(root, row => row.tag === 'chart-probe');
const option = (root: HostNode) => chart(root)!.props.option as ChartOption;
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mountDetail(linkId = 'PL-001') {
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), service = createMockService(() => storage);
  const data = reactive(await service.loadPreview()), state = reactive({ linkId, hidden: false, dirty: false });
  const context = computed(() => createLinkDetailContext(data.situation, data.resources, data.resourceMeta, state.dirty));
  app = renderer.createApp({ render: () => h(LinkDetailPanel, { link: data.situation.links.find(row => row.id === state.linkId)!,
    resources: data.resources, context: context.value, hidden: state.hidden }) });
  app.use(pinia); app.provide(ssrContextKey, {}); const root = node('root'); app.mount(root); await nextTick();
  return { root, data, state, storage, auth };
}

describe('GIS 链路详情及历史趋势实际模板', () => {
  it('两端设备、频率、带宽和最新指标采用当前链路资料，并明确固定历史来源', async () => {
    const s = await mountDetail('PL-002'), text = textOf(s.root);
    for (const item of ['PL-002', 'DV-0001', 'DV-0037', 'ND-0001', 'ND-0004', '6500 kHz', '3 kHz', '主干链路',
      '8.4', '2.10e-4', '95', '38', '预警越限', 'Mock 固定教学历史样例', '2026/10/03 09:42:18']) expect(text).toContain(item);
    const loss = find(s.root, row => row.props['data-metric'] === 'packetLossRate')!;
    expect(textOf(loss)).toContain('6 %'); expect(loss.props.class).toContain('violation'); expect(loss.props.style).toMatchObject({ color: '#f2cf5b' });
    expect(chart(s.root)).toBeUndefined(); expect(s.storage.writes).toBe(0);
  });
  it('故障中的缺测与零吞吐量分别展示，不把空值当正常零值', async () => {
    const s = await mountDetail('PL-005');
    const snr = find(s.root, row => row.props['data-metric'] === 'snrDb')!, throughput = find(s.root, row => row.props['data-metric'] === 'throughputKbps')!;
    expect(textOf(snr)).toContain('未采集'); expect(textOf(snr)).not.toContain('0 dB');
    expect(textOf(throughput)).toContain('0 kbps'); expect(throughput.props.style).toMatchObject({ color: '#ef5f64' });
    expect(textOf(s.root)).toContain('100 %'); expect(textOf(s.root)).toContain('故障越限');
  });
  it('五指标切换使用统一单位和真实采样时刻，只有展开后才挂载图表', async () => {
    const s = await mountDetail('PL-002'); await toggleHistory(s.root, true);
    expect(chart(s.root)!.props.label).toBe('PL-002 信噪比历史趋势，单位 dB');
    const expected = [[8.4, 'dB'], [.00021, '比率'], [6, '%'], [95, 'ms'], [38, 'kbps']];
    for (const [i, item] of LINK_METRICS.entries()) {
      await click(s.root, item.label); const current = option(s.root);
      expect(current.xAxis.type).toBe('time'); expect(current.yAxis.name).toBe(expected[i][1]);
      expect(current.series[0].data.at(-1)!.value).toEqual([Date.parse('2026-10-03T09:42:18+08:00'), expected[i][0]]);
      expect(current.tooltip.renderMode).toBe('richText');
      expect(current.tooltip.formatter([{ dataIndex: 3 }])).toContain('09:42:18 (UTC+8)');
      expect(current.tooltip.formatter([{ dataIndex: 3 }])).toContain('预警越限');
    }
    await toggleHistory(s.root, false); expect(chart(s.root)).toBeUndefined(); expect(s.storage.writes).toBe(0);
  });
  it('空采样断线，零值保留，并按每一时刻提供的标识着色', async () => {
    const s = await mountDetail('PL-003'); await toggleHistory(s.root, true); await click(s.root, '时延');
    expect(option(s.root).series[0]).toMatchObject({ connectNulls: false, smooth: false });
    expect(option(s.root).series[0].data.map(row => row.value[1])).toEqual([48, null, 46, 47]);
    expect(option(s.root).tooltip.formatter([{ dataIndex: 1 }])).toContain('未采集');
    s.state.linkId = 'PL-005'; await nextTick(); await toggleHistory(s.root, true); await click(s.root, '吞吐量');
    expect(option(s.root).series[0].data.map(row => row.value[1])).toEqual([48, 30, 0, 0]);
    expect(option(s.root).series[0].data.map(row => row.itemStyle.color)).toEqual(['#8ed66b', '#f2cf5b', '#ef5f64', '#ef5f64']);
  });
  it('切换链路重置展开状态与默认指标，隐藏提示不重置选择', async () => {
    const s = await mountDetail(); await toggleHistory(s.root, true); await click(s.root, '丢包率');
    s.state.hidden = true; await nextTick(); expect(textOf(s.root)).toContain('详情已保留'); expect(option(s.root).yAxis.name).toBe('%');
    s.state.linkId = 'PL-006'; await nextTick(); expect(chart(s.root)).toBeUndefined(); expect(textOf(s.root)).toContain('备用链路');
    await toggleHistory(s.root, true); expect(chart(s.root)!.props.label).toBe('PL-006 信噪比历史趋势，单位 dB');
  });
  it.each(['catalog', 'record', 'invalid'])('%s 不可用时保留基础资料但不渲染指标/趋势', async kind => {
    const s = await mountDetail();
    if (kind === 'catalog') delete s.data.situation.linkDetails;
    if (kind === 'record') s.data.situation.linkDetails!.records.shift();
    if (kind === 'invalid') s.data.situation.linkDetails!.snapshotId = 'OLD';
    await nextTick(); expect(textOf(s.root)).toContain('DV-0001');
    expect(find(s.root, row => !!row.props['data-metric'])).toBeUndefined(); expect(chart(s.root)).toBeUndefined();
    expect(textOf(s.root)).toContain(kind === 'invalid' ? '网络版本不匹配' : '暂无');
  });
  it('未保存和已保存变更卸载旧趋势，恢复基线后仍需显式展开', async () => {
    const s = await mountDetail(); await toggleHistory(s.root, true);
    s.state.dirty = true; await nextTick(); expect(chart(s.root)).toBeUndefined(); expect(textOf(s.root)).toContain('资源存在未保存修改');
    s.state.dirty = false; await nextTick(); expect(chart(s.root)).toBeUndefined(); await toggleHistory(s.root, true);
    s.data.resourceMeta.changedDeviceIds.push('DV-0001'); await nextTick();
    expect(chart(s.root)).toBeUndefined(); expect(textOf(s.root)).toContain('资源已变更');
  });
  it('失去查看权限立即隐藏详情与图表，只读交互不写资源或存储', async () => {
    const s = await mountDetail(), before = JSON.stringify(s.data);
    await toggleHistory(s.root, true); await click(s.root, '误码率');
    expect(find(s.root, row => ['input', 'select', 'textarea'].includes(row.tag))).toBeUndefined();
    s.auth.identity!.permissions = []; await nextTick();
    expect(textOf(s.root)).toContain('没有 GIS 查看权限'); expect(textOf(s.root)).not.toContain('PL-001');
    expect(chart(s.root)).toBeUndefined(); expect(JSON.stringify(s.data)).toBe(before); expect(s.storage.writes).toBe(0);
  });
  it('来源和越限原因作为文本展示，提示框不使用 HTML', async () => {
    const s = await mountDetail();
    s.data.situation.linkDetails!.source = '<img src=x onerror=alert(1)>';
    const metric = s.data.situation.linkDetails!.records[0].samples.at(-1)!.metrics.snrDb;
    metric.status = 'WARNING'; metric.reason = '<script>alert(2)</script>';
    await nextTick(); expect(find(s.root, row => row.tag === 'img' || row.tag === 'script')).toBeUndefined();
    await toggleHistory(s.root, true); expect(option(s.root).tooltip.renderMode).toBe('richText');
    expect(option(s.root).tooltip.formatter([{ dataIndex: 3 }])).toContain('<script>alert(2)</script>');
  });
});
