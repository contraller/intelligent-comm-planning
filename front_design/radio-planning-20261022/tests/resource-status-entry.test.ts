import { useResourceReadStore } from '../src/stores/resource-read';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App, type Component } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ResourcesView from '../src/views/ResourcesView.vue';
import SituationView from '../src/views/SituationView.vue';
import GisObjectInfoPanel from '../src/components/GisObjectInfoPanel.vue';
import ResourceStatusPanel from '../src/components/ResourceStatusPanel.vue';
import ResourceStatusBadge from '../src/components/ResourceStatusBadge.vue';
import ResourceLedgerFilters from '../src/components/ResourceLedgerFilters.vue';
import ResourceLedgerTree from '../src/components/ResourceLedgerTree.vue';
import DeviceInfoPanel from '../src/components/DeviceInfoPanel.vue';
import ObjectInfoPanel from '../src/components/ObjectInfoPanel.vue';
import StatusBadge from '../src/components/StatusBadge.vue';
import GisDeviceLayerPanel from '../src/components/GisDeviceLayerPanel.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { createAccessService } from '../src/services/access';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useResourceLedgerEditStore } from '../src/stores/resource-ledger-edit';
import { useResourceStatusStore } from '../src/stores/resource-status';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useMonitoringStore } from '../src/stores/monitoring';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
// 仅复用相同的基础宿主，页面接线、事件与等待策略保持本地。
import { clientTemplate, node, renderer, find, all, textOf, type HostNode } from './helpers/vue-client';
import type { DeviceStatusSummary } from '../src/types/resource-status';
import type { GisDeviceMapFrame } from '../src/maps/gis-device-display';

vi.mock('../src/components/AppTable.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['rows', 'columns', 'selected'], emits: ['select'],
    setup(props, { emit, slots }) { return () => h('table-probe', { ...props }, props.rows.map((row: any) =>
      h('row-probe', { id: row.id }, [h('button', { 'aria-label': '查看 ' + row.id, onClick: () => emit('select', row) }, row.id), slots.selection?.({ row }), slots[props.columns.find((column: any) => column.header === '运行状态').field]?.({ row })]))); } }) };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup(props, { slots }) { return () => props.visible ? h('drawer-probe', [slots.default?.(), slots.footer?.()]) : null; } }) };
});
vi.mock('../src/components/MapCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ inheritAttrs: false, props: ['gisDeviceFrame', 'stations', 'selectedId', 'resourceMarkers'],
    setup(props, { expose }) { expose({ locate() {}, locateResource() {} }); return () => h('map-probe', { ...props }); } }) };
});
vi.mock('../src/components/DeviceDetailTabs.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ setup(_, { slots }) { return () => h('details-probe', [slots.basic?.(), slots.parameters?.(), slots.actions?.()]); } }) };
});
vi.mock('../src/composables/useDeviceKnowledgeSummary', async () => {
  const { ref } = await import('vue');
  return { useDeviceKnowledgeSummary: () => ({ summary: ref(null), status: ref('forbidden'), error: ref(''), retry() {} }) };
});
vi.mock('../src/components/SpectrumConfigPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/GisResourceTree.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/GisResultLayerPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/DeviceCoveragePanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/GisTaskPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/InterferenceAnalysisPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/InterferenceHistoryDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/InterferenceMeasureDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/InterferenceSourceDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/SituationMonitoringDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/MonitoringObjectPanel.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceExportDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceReadStatus.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceLedgerEditDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceLedgerImportDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/ResourceLedgerExportDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
vi.mock('../src/components/DeviceConfigurationDrawer.vue', () => ({ default: { inheritAttrs: false, render: () => null } }));
// 共用详情入口使用客户端模板，原有业务断言保持实际组件接线。
await clientTemplate(GisObjectInfoPanel, 'src/components/GisObjectInfoPanel.vue', 'resource-ledger-render.ts');
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


await Promise.all([
  [ResourcesView, 'views/ResourcesView'], [SituationView, 'views/SituationView'],
  [ResourceStatusPanel, 'components/ResourceStatusPanel'], [ResourceStatusBadge, 'components/ResourceStatusBadge'],
  [ResourceLedgerFilters, 'components/ResourceLedgerFilters'], [DeviceInfoPanel, 'components/DeviceInfoPanel'],
  [ResourceLedgerTree, 'components/ResourceLedgerTree'],
  [ObjectInfoPanel, 'components/ObjectInfoPanel'], [StatusBadge, 'components/StatusBadge'],
  [GisDeviceLayerPanel, 'components/GisDeviceLayerPanel'],
].map(([component, path]) => clientTemplate(component as Component, 'src/' + path + '.vue', 'resource-ledger-render.ts')));
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mountEntry(url = '/resources') {
  vi.stubGlobal('window', new EventTarget()); class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  // 每次返回新的同身份对象，验证真实访问包装的会话重验不会误清缓存。
  const actual = { ...raw, getSession: async () => JSON.parse(JSON.stringify(auth.identity)) };
  const access = createAccessService(() => actual, null);
  for (const name of Object.keys(access)) vi.spyOn(previewService as any, name).mockImplementation((access as any)[name]);
  const preview = usePreviewStore(); await preview.load();
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/resources', component: ResourcesView }, { path: '/situation', component: SituationView },
    { path: '/planning', component: { render: () => null } },
  ] });
  await router.push(url); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  const root = node('root'); app.mount(root); await settle();
  if (url.startsWith('/resources')) await vi.waitFor(() => expect(useResourceStatusStore().catalog).not.toBeNull());
  return { root, storage, raw, auth, preview, router, status: useResourceStatusStore(), editor: useResourceLedgerEditStore(), gis: useGisWorkspaceStore(), monitor: useMonitoringStore() };
}
const control = (root: HostNode, label: string) => { const el = find(root, n => n.props['aria-label'] === label); expect(el, label).toBeDefined(); return el!; };
async function field(root: HostNode, label: string, value: string) {
  const el = control(root, label); (el.props[el.tag === 'select' ? 'onChange' : 'onInput'] as Function)({ target: { value } }); await new Promise(resolve => setTimeout(resolve, 270)); await settle();
}
async function check(root: HostNode, id: string) { (control(root, '勾选 ' + id).props.onChange as Function)({ target: { checked: true } }); await settle(); }
const rows = (root: HostNode) => find(root, n => n.tag === 'table-probe')!.props.rows as any[];
const frame = (root: HostNode) => find(root, n => n.tag === 'map-probe')!.props.gisDeviceFrame as GisDeviceMapFrame | undefined;
const synchronize = async (root: HostNode) => { await click(root, '同步全部设备状态（414）'); await new Promise(resolve => setTimeout(resolve, 270)); await settle(); };

// 真实页面、详情与同步模板联动；画布几何/颜色在独立组件测试执行。
describe('台账与 GIS 状态同步入口', () => {
  it('运行状态排序字段跟随可见观测，未知观测不借用基线状态', async () => {
    const s = await mountEntry(); await field(s.root, '设备状态教学样例', 'abnormal'); await synchronize(s.root);
    // 检查传给真实表格约定的字段；不把内存宿主当作浏览器排序验收。
    const column = (find(s.root, n => n.tag === 'table-probe')!.props.columns as {field: string; header: string}[]).find(c => c.header === '运行状态')!;
    const fault = rows(s.root).find(r => r.id === 'DV-0001'), unknown = rows(s.root).find(r => r.id === 'DV-0004');
    expect(fault[column.field]).toBe('FAULT'); expect(fault.status).toBe('NORMAL');
    expect(unknown[column.field]).toBe('UNKNOWN');
    await field(s.root, '设备状态来源', 'baseline');
    expect(rows(s.root).find(r => r.id === 'DV-0001')[column.field]).toBe('NORMAL');
    expect(s.preview.data!.resources.devices.find(d => d.id === 'DV-0001')!.status).toBe('NORMAL');
    expect(s.storage.writes).toBe(0);
  });
  it('GIS 故障详情的来源底栏不再额外声明设备正常', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001&deviceId=DV-0001');
    // 定向展示夹具修改当前详情 DTO，普通 GIS 不再绑定 Preview。
    await vi.waitFor(()=>expect(useResourceReadStore().detail).not.toBeNull());const object=useResourceReadStore().detail!.object;if(object.kind==='device')object.status='FAULT'; await settle();
    expect(textOf(s.root)).toContain('设备故障');
    const footer = find(s.root, n => String(n.props.class).split(' ').includes('detail-footer'))!;
    expect(footer).toBeDefined(); expect(textOf(footer)).toContain('数据来源：已保存资源');
    expect(textOf(footer)).not.toContain('正常'); expect(s.storage.writes).toBe(0);
  });
  it('筛选清空勾选；勾选同步仅当前页，全库同步仍由服务展开目标', async () => {
    const s = await mountEntry(); expect(s.status.catalog).not.toBeNull();
    await check(s.root, 'DV-0001'); await check(s.root, 'DV-0002'); await field(s.root, '搜索设备', 'DV-0001');
    expect(textOf(s.root)).toContain('同步勾选设备状态（0）'); await check(s.root, 'DV-0001');
    await field(s.root, '设备状态教学样例', 'abnormal'); await click(s.root, '同步勾选设备状态（1）'); await new Promise(resolve => setTimeout(resolve, 270)); await settle();
    expect(previewService.synchronizeDeviceStatuses).toHaveBeenLastCalledWith(expect.objectContaining({ deviceIds: ['DV-0001'], scope: 'IDS' }));
    expect(rows(s.root)[0].status).toBe('NORMAL'); expect(rows(s.root)[0].statusDisplay.status).toBe('FAULT');
    await synchronize(s.root); expect(vi.mocked(previewService.synchronizeDeviceStatuses).mock.lastCall![0]).toMatchObject({ scope: 'ALL', deviceIds: [] });
    (control(s.root, '查看 DV-0001').props.onClick as Function)(); await settle();
    expect(textOf(s.root)).toContain('设备故障'); expect(textOf(s.root)).toContain('2026-10-16T08:00:00+08:00');
    await field(s.root, '筛选设备状态', 'NORMAL'); expect(rows(s.root)).toEqual([]); expect(textOf(s.root)).toContain('详情和输入已保留');
    expect(s.storage.writes).toBe(0);
  });
  it('未知状态/告警筛选不混用基线，切回基线只清不支持条件', async () => {
    const s = await mountEntry(); await field(s.root, '设备状态教学样例', 'abnormal'); await synchronize(s.root);
    await field(s.root, '搜索设备', 'DV-000'); await field(s.root, '筛选附加告警', 'UNKNOWN');
    expect(rows(s.root).map(r => r.id)).toEqual(['DV-0004', 'DV-0005']);
    await field(s.root, '筛选设备状态', 'UNKNOWN'); expect(rows(s.root).map(r => r.id)).toEqual(['DV-0004']);
    await field(s.root, '设备状态来源', 'baseline');
    expect(control(s.root, '筛选设备状态').props.value).toBe('全部状态'); expect(control(s.root, '筛选附加告警').props.value).toBe('ALL');
    expect(control(s.root, '搜索设备').props.value).toBe('DV-000'); expect(previewService.synchronizeDeviceStatuses).toHaveBeenCalledTimes(1);
  });
  it('同步及读取失败保留设备未保存表单和既有方案/诊断', async () => {
    const s = await mountEntry(); (control(s.root, '查看 DV-0001').props.onClick as Function)(); await settle();
    await click(s.root, '编辑设备参数'); await settle(); s.editor.form!.fields.antennaHeightM = '19';
    const form = JSON.stringify(s.editor.form), history = JSON.stringify([s.preview.data!.planning, s.preview.data!.diagnosis]), resources = JSON.stringify(s.preview.data!.resources);
    await field(s.root, '设备状态教学样例', 'abnormal'); await synchronize(s.root);
    vi.mocked(previewService.synchronizeDeviceStatuses).mockRejectedValueOnce(new Error('服务暂不可用')); await synchronize(s.root);
    expect(textOf(s.root)).toContain('服务暂不可用'); expect(JSON.stringify(s.editor.form)).toBe(form);
    expect(JSON.stringify([s.preview.data!.planning, s.preview.data!.diagnosis])).toBe(history); expect(JSON.stringify(s.preview.data!.resources)).toBe(resources);
    expect(s.storage.writes).toBe(0); s.editor.clearForSession();
  });
  it('台账观测跨页保留；普通 GIS 始终展示资源状态，网络监控独立', async () => {
    const s = await mountEntry(); await field(s.root, '设备状态教学样例', 'abnormal'); await synchronize(s.root);
    const count = vi.mocked(previewService.synchronizeDeviceStatuses).mock.calls.length;
    await s.router.push('/situation?stationId=ND-0001&deviceId=DV-0001'); await settle();
    expect(frame(s.root)!.points.find(p => p.id === 'DV-0001')!.status).toBe('NORMAL');
    expect(frame(s.root)).not.toHaveProperty('statusSource'); expect(textOf(s.root)).not.toContain('设备状态同步');
    expect(previewService.synchronizeDeviceStatuses).toHaveBeenCalledTimes(count);
    const statusBefore = s.status.mode;
    await s.gis.begin(); await settle(); expect(frame(s.root)!.points.find(p => p.id === 'DV-0001')!.status).toBe('NORMAL');
    expect(s.status.mode).toBe(statusBefore);
    await click(s.root, '退出编辑'); await settle(); expect(frame(s.root)!.points.find(p => p.id === 'DV-0001')!.status).toBe('NORMAL');
    s.monitor.showNetwork(); await settle(); expect(frame(s.root)).toBeUndefined(); expect(s.status.mode).toBe(statusBefore);
    s.gis.mapMode = 'resource'; await settle(); expect(frame(s.root)).not.toHaveProperty('statusSource');
    await s.router.push('/resources'); await settle(); expect(rows(s.root).find(r => r.id === 'DV-0001').statusDisplay.status).toBe('FAULT');
  });
  it('GIS 状态筛选仅使用资源基线，编辑往返保留设备清单', async () => {
    const s = await mountEntry('/situation?stationId=ND-0001'); await click(s.root, '图层管理'); await settle();
    expect(all(s.root, n => n.tag === 'option' && n.props.value === 'UNKNOWN')).toEqual([]);
    await field(s.root, '设备点位状态', 'FAULT');
    const ids = frame(s.root)!.points.map(p => p.id);
    expect(ids).toEqual(s.preview.data!.resources.devices.filter(d => d.status === 'FAULT').map(d => d.id));
    await s.gis.begin(); await settle(); await click(s.root, '退出编辑'); await settle();
    expect(frame(s.root)!.points.map(p => p.id)).toEqual(ids);
    expect(control(s.root, '设备点位状态').props.value).toBe('FAULT');
    expect(previewService.synchronizeDeviceStatuses).not.toHaveBeenCalled();
  });
  it('保存上下架使旧观测失效；重新同步正常不能把设备恢复上架', async () => {
    const s = await mountEntry(); await synchronize(s.root);
    const saving = s.editor.setAvailability(['DV-0001'], 'OFF_SHELF'); await settle();
    expect(s.editor.decision?.title).toBe('下架设备'); s.editor.answer('save'); await saving; await settle();
    expect(s.status.mode).toBe('baseline'); expect(s.status.records).toEqual({}); expect(textOf(s.root)).toContain('资源版本已变化');
    await synchronize(s.root); const device = (await s.raw.loadPreview()).resources.devices[0];
    expect(rows(s.root).find(r => r.id === device.id)!.statusDisplay.status).toBe('NORMAL'); expect(device.availability).toBe('OFF_SHELF');
  });
  it('切页后的迟到状态不会污染新页；失权后控件和观测停止使用', async () => {
    const s = await mountEntry(); let finish!: (batch: DeviceStatusSummary) => void;
    vi.mocked(previewService.synchronizeDeviceStatuses).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const btn = find(s.root, n => n.tag === 'button' && textOf(n).trim() === '同步全部设备状态（414）')!;
    const pending = (btn.props.onClick as Function)(); await nextTick();
    const request = vi.mocked(previewService.synchronizeDeviceStatuses).mock.lastCall![0], batch = await s.raw.synchronizeDeviceStatuses(request);
    await s.router.push('/situation?stationId=ND-0001'); await settle(); finish(batch); await pending; await settle();
    expect(s.status.records).toEqual({}); expect(s.status.mode).toBe('baseline');
    expect(find(s.root, n => n.props['aria-label'] === '设备状态来源')).toBeUndefined();
    expect(frame(s.root)).not.toHaveProperty('statusSource');
    s.auth.accept({ ...s.auth.identity!, permissions: [] }); await settle();
    expect(frame(s.root)).toBeUndefined(); expect(previewService.synchronizeDeviceStatuses).toHaveBeenCalledTimes(1);
  });
});

