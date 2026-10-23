import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Vue from 'vue';
import { h, nextTick, ssrContextKey, reactive, type App, type Component } from 'vue';
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
// 同型宿主共用，挂载、等待和业务断言继续留在本文件。
import { clientTemplate, node, renderer, find, all, textOf, type HostNode } from './helpers/vue-client';

vi.mock('../src/components/DeviceDetailTabs.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ setup(_, { slots }) { return () => h('details-probe', [slots.basic?.(), slots.parameters?.(), slots.actions?.()]); } }) };
});
vi.mock('../src/composables/useDeviceKnowledgeSummary', async () => {
  const { ref } = await import('vue');
  return { useDeviceKnowledgeSummary: () => ({ summary: ref(null), status: ref('forbidden'), error: ref(''), retry() {} }) };
});
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


await Promise.all([
  [ResourceStatusPanel, 'ResourceStatusPanel'], [ResourceStatusBadge, 'ResourceStatusBadge'],
  [DeviceInfoPanel, 'DeviceInfoPanel'], [StatusBadge, 'StatusBadge'], [GisDeviceClusterPanel, 'GisDeviceClusterPanel'],
].map(([component, name]) => clientTemplate(component as Component, 'src/components/' + name + '.vue', 'resource-ledger-render.ts')));
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup() {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage), preview = usePreviewStore(); preview.data = await raw.loadPreview();
  // 显式提供台账读取版本和全库数量，测试不依赖完整预览的控件回退。
  const workspace = await raw.loadResourceReadContext({ context: 'ledger' });
  const statusProps = { resourceRevision: workspace.revision, total: workspace.stats.devices };
  vi.spyOn(previewService, 'loadDeviceStatusOptions').mockImplementation(raw.loadDeviceStatusOptions);
  vi.spyOn(previewService, 'synchronizeDeviceStatuses').mockImplementation(raw.synchronizeDeviceStatuses);
  vi.spyOn(previewService, 'queryDeviceStatusBatch').mockImplementation(raw.queryDeviceStatusBatch);
  const status = useResourceStatusStore(), root = node('root');
  function mount(render: () => Vue.VNode) { app = renderer.createApp({ render }); app.use(pinia!); app.provide(ssrContextKey, {}); app.mount(root); }
  return { root, mount, auth, storage, raw, preview, status, statusProps };
}
async function change(root: HostNode, label: string, value: string) {
  const el = find(root, n => n.props['aria-label'] === label)!; expect(el).toBeDefined();
  (el.props.onChange as Function)({ target: { value } }); await settle();
}

// 客户端模板与 OpenLayers 样式对象实际执行；不将内存宿主当作视觉验收。
describe('设备状态同步控件和详情', () => {
  it('全部/勾选按钮目标清楚，显示缺报失败结果，重复读取不改采集时间', async () => {
    const s = await setup(), props = reactive({ enabled: true, selectedIds: ['DV-0001', 'DV-0002'], hiddenCount: 1 });
    s.mount(() => h(ResourceStatusPanel, { ...s.statusProps, ...props })); await settle();
    expect(textOf(s.root)).toContain('同步全部设备状态（414）'); expect(textOf(s.root)).toContain('包含筛选外 1 台');
    await change(s.root, '设备状态教学样例', 'partial'); await click(s.root, '同步勾选设备状态（2）'); await settle();
    expect(previewService.synchronizeDeviceStatuses).toHaveBeenLastCalledWith(expect.objectContaining({ deviceIds: props.selectedIds }));
    await s.status.loadBatch(); await settle();
    expect(textOf(s.root)).toContain('已上报 0 / 未上报 1 / 失败 1'); expect(textOf(s.root)).toContain('本批未收到设备上报');
    await change(s.root, '设备状态教学样例', 'abnormal'); await click(s.root, '同步全部设备状态（414）'); await settle();
    await s.status.loadBatch();
    const sampled = s.status.records['DV-0001'].observation!.observedAt;
    await click(s.root, '同步全部设备状态（414）'); await settle(); await s.status.loadBatch(); expect(s.status.records['DV-0001'].observation!.observedAt).toBe(sampled);
    expect(s.storage.writes).toBe(0);
  });
  it('暂停/失权禁用控件，直接触发事件也不能改来源与示例', async () => {
    const s = await setup(), props = reactive({ enabled: true, pausedReason: '' });
    s.mount(() => h(ResourceStatusPanel, { ...s.statusProps, ...props })); await settle();
    await click(s.root, '同步全部设备状态（414）'); await settle(); expect(s.status.mode).toBe('observed');
    props.enabled = false; props.pausedReason = '台账读取暂停，暂不能同步'; await settle();
    const before = JSON.stringify(s.status.records), calls = vi.mocked(previewService.synchronizeDeviceStatuses).mock.calls.length;
    await change(s.root, '设备状态来源', 'baseline'); await change(s.root, '设备状态教学样例', 'failed');
    await click(s.root, '同步全部设备状态（414）'); expect(s.status.mode).toBe('observed'); expect(s.status.exampleId).toBe('normal');
    expect(JSON.stringify(s.status.records)).toBe(before); expect(previewService.synchronizeDeviceStatuses).toHaveBeenCalledTimes(calls);
    expect(textOf(s.root)).toContain('台账读取暂停，暂不能同步');
    props.enabled = true; props.pausedReason = ''; s.auth.accept({ ...s.auth.identity!, permissions: [] }); await settle();
    await change(s.root, '设备状态来源', 'baseline'); await change(s.root, '设备状态教学样例', 'failed');
    await click(s.root, '同步全部设备状态（414）'); expect(s.status.mode).toBe('observed'); expect(s.status.exampleId).toBe('normal');
    expect(JSON.stringify(s.status.records)).toBe(before); expect(previewService.synchronizeDeviceStatuses).toHaveBeenCalledTimes(calls);
  });
  it('详情使用观测状态和采集时间，但原设备参数保持不变；撤去可选输入恢复基线', async () => {
    const s = await setup(), key = Symbol(); await s.status.load(key, () => true, s.statusProps.resourceRevision); s.status.setExample('abnormal');
    await s.status.sync(['DV-0001', 'DV-0004'], key, () => true, s.statusProps.resourceRevision); await s.status.loadBatch();
    const props = reactive({ observed: true, id: 'DV-0001' }), resources = s.preview.data!.resources, before = JSON.stringify(resources);
    s.mount(() => { const device = resources.devices.find(d => d.id === props.id)!;
      return h(DeviceInfoPanel, { device, resources, statusDisplay: props.observed ? s.status.display(device) : undefined }); });
    expect(textOf(s.root)).toContain('设备故障'); expect(textOf(s.root)).toContain('2026-10-16T08:00:00+08:00');
    props.id = 'DV-0004'; await settle(); expect(textOf(s.root)).toContain('状态未提供'); expect(textOf(s.root)).toContain('告警未提供');
    expect(find(s.root, n => String(n.props.class).includes('unknown'))).toBeDefined();
    props.observed = false; await settle(); expect(textOf(s.root)).not.toContain('最近获取'); expect(JSON.stringify(resources)).toBe(before);
  });
  it('地图合法空状态用中性色、聚合标缺省数量，不附加资源页观测信息', async () => {
    const s = await setup();
    const points = gisDevicePoints(s.preview.data!.resources).points.filter(p => ['DV-0004', 'DV-0005'].includes(p.id));
    // 模拟地图 DTO 的合法空值，资源管理观测仍由上一用例独立验证。
    points.forEach(row => { row.status = null; row.alert = null; });
    const styles = gisDeviceStyles([points[0]], defaultGisDeviceSettings(), '');
    expect((styles[0].getImage() as any).getStroke().getColor()).toBe(GIS_DEVICE_COLORS.UNKNOWN);
    expect(gisDeviceStyles(points, defaultGisDeviceSettings(), '').some(style => style.getText()?.getText() === '状态/告警未提供 2')).toBe(true);
    const choose = vi.fn(); s.mount(() => h(GisDeviceClusterPanel, { members: points, disabled: false, onSelect: choose }));
    expect(textOf(s.root)).toContain('状态未提供 · 告警未提供'); expect(textOf(s.root)).not.toContain('采集：');
    const el = find(s.root, n => n.props['aria-label'] === '查看聚合设备 DV-0004')!; (el.props.onClick as Function)();
    expect(choose).toHaveBeenCalledWith('DV-0004');
  });
});

