import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ResourcesView from '../src/views/ResourcesView.vue';
import ResourceLedgerFilters from '../src/components/ResourceLedgerFilters.vue';
import ResourceLedgerTree from '../src/components/ResourceLedgerTree.vue';
import SpectrumConfigPanel from '../src/components/SpectrumConfigPanel.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceLedgerEditStore } from '../src/stores/resource-ledger-edit';
import { useResourceReadStore } from '../src/stores/resource-read';
import ResourceLedgerEditDrawer from '../src/components/ResourceLedgerEditDrawer.vue';
import ResourceLedgerImportDrawer from '../src/components/ResourceLedgerImportDrawer.vue';
import ResourceReadStatus from '../src/components/ResourceReadStatus.vue';
import type { Device, DeviceClass } from '../src/types/domain';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
// 编译与同型基础宿主复用公共工具，保留本文件的事件和生命周期。
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';

// 记录首次渲染的打开条件，避免异步稳定后漏掉瞬时误开抽屉。
const drawerLifecycle = vi.hoisted(() => ({ detailVisibility: [] as boolean[] }));

// 保留真实页面与筛选模板；表格仅代替分页布局，所有行及业务插槽照常渲染。
vi.mock('../src/components/AppTable.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['rows', 'columns', 'selected', 'total'], emits: ['select', 'page', 'sort'],
    setup(props, { emit, slots }) {
      return () => h('table-probe', { rows: props.rows, columns: props.columns, selected: props.selected, total: props.total, onTestPage: (value: unknown) => emit('page', value), onTestSort: (value: unknown) => emit('sort', value) }, props.rows.map((row: Device) =>
        h('row-probe', { id: row.id }, [h('button', { 'aria-label': '查看台账设备 ' + row.id, onClick: () => emit('select', row) }, row.id),
          slots.selection?.({ row }), h('band-cell', slots.freqMinKhz?.({ row })), h('frequency-cell', slots.workFreqKhz?.({ row }))])));
    } }) };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'title'], emits: ['update:visible'], setup(props, { slots, emit }) {
    return () => {
      if (props.title === '设备实例详情') drawerLifecycle.detailVisibility.push(!!props.visible);
      return props.visible ? h('drawer-probe', [slots.default?.(), slots.footer?.(),
        h('button', { onClick: () => emit('update:visible', false) }, '关闭设备详情')]) : null;
    };
  } }) };
});
vi.mock('../src/components/DeviceInfoPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['device'], setup(props, { slots }) {
    return () => h('detail-probe', { device: props.device }, slots.actions?.());
  } }) };
});
vi.mock('../src/components/ResourceLedgerExportDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'filter', 'selectedIds'], setup: props => () => h('export-probe', { ...props }) }) };
});
vi.mock('../src/components/ResourceStatusPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DeviceConfigurationDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/StatusBadge.vue', () => ({ default: { render: () => null } }));
// 在内存宿主执行真实客户端模板；不把宿主事件验证当作浏览器视觉验收。
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }

await Promise.all([clientTemplate(ResourcesView, 'src/views/ResourcesView.vue', 'resource-ledger-render.ts'), clientTemplate(ResourceLedgerFilters, 'src/components/ResourceLedgerFilters.vue', 'resource-ledger-render.ts'), clientTemplate(ResourceLedgerTree, 'src/components/ResourceLedgerTree.vue', 'resource-ledger-render.ts'), clientTemplate(SpectrumConfigPanel, 'src/components/SpectrumConfigPanel.vue', 'resource-ledger-render.ts'), clientTemplate(ResourceLedgerEditDrawer, 'src/components/ResourceLedgerEditDrawer.vue', 'resource-ledger-render.ts'), clientTemplate(ResourceLedgerImportDrawer, 'src/components/ResourceLedgerImportDrawer.vue', 'resource-ledger-render.ts'), clientTemplate(ResourceReadStatus, 'src/components/ResourceReadStatus.vue', 'resource-ledger-render.ts')]);
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; drawerLifecycle.detailVisibility.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mountEntry(beforeMount?: (read: ReturnType<typeof useResourceReadStore>) => Promise<void>) {
  vi.stubGlobal('window', new EventTarget());
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  // 新状态目录沿用本入口测试数据，避免误读真实浏览器会话。
  vi.spyOn(previewService, 'loadDeviceStatusOptions').mockImplementation(raw.loadDeviceStatusOptions);
  for (const name of ['loadPreview', 'commitResources', 'setDeviceAvailability', 'querySpectrumSources', 'loadResourceReadContext', 'queryResourceDevices', 'queryResourceMap', 'getResourceObject', 'loadResourceMaintenanceContext', 'previewResourceExport'] as const)
    vi.spyOn(previewService, name).mockImplementation(raw[name] as never);
  const preview = usePreviewStore(); await preview.load();
  await beforeMount?.(useResourceReadStore());
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/resources', component: ResourcesView }, { path: '/situation', component: { render: () => null } },
  ] });
  await router.push('/resources'); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  const root = node('root'); app.mount(root); await settle();
  return { root, preview, storage, raw, auth, router, editor: useResourceLedgerEditStore(), read: useResourceReadStore() };
}
type Fixture = Awaited<ReturnType<typeof mountEntry>>;
type LedgerRow = Device & { freqMinKhz: number; freqMaxKhz: number; deviceClass: DeviceClass };
const control = (root: HostNode, label: string) => {
  const found = find(root, row => row.props['aria-label'] === label); expect(found, label).toBeDefined(); return found!;
};
// 分类按钮还带有全库数量，只按其中的分类名称选择。
async function category(root: HostNode, label: string) {
  const button = find(root, row => row.tag === 'button' && row.children.some(child => child.tag === 'span' && textOf(child).trim() === label));
  expect(button, label).toBeDefined(); await (button!.props.onClick as () => unknown)(); await new Promise(resolve => setTimeout(resolve, 270)); await settle();
}
async function field(root: HostNode, label: string, value: string) {
  const input = control(root, label), event = input.tag === 'select' ? 'onChange' : 'onInput';
  (input.props[event] as Function)({ target: { value } }); await new Promise(resolve => setTimeout(resolve, 270)); await settle();
}
async function apply(root: HostNode) {
  const form = control(root, '频率筛选'); (form.props.onSubmit as Function)({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 270)); await settle();
}
async function choose(root: HostNode, id: string) {
  (control(root, '查看台账设备 ' + id).props.onClick as Function)(); await settle();
}
async function check(root: HostNode, id: string, checked = true) {
  (control(root, '勾选 ' + id).props.onChange as Function)({ target: { checked } }); await settle();
}
const table = (s: Fixture) => find(s.root, row => row.tag === 'table-probe')!;
const rows = (s: Fixture) => table(s).props.rows as LedgerRow[];
const ids = (s: Fixture) => rows(s).map(row => row.id);
const stats = (s: Fixture) => textOf(find(s.root, row => row.props['aria-label'] === '资源统计')!);
const pageCheck = (root: HostNode, checked = true) => (control(root, '全选当前页').props.onChange as Function)({ target: { checked } });

describe('统一台账页面', () => {
  it('从 GIS 已选设备进入时不瞬时打开详情，台账选择和关闭仍正常', async () => {
    const s = await mountEntry(async read => {
      await read.activate('gis'); await read.selectObject('device', 'DV-0001');
      expect(read.selected).toEqual({ kind: 'device', id: 'DV-0001' });
    });
    expect(drawerLifecycle.detailVisibility.length).toBeGreaterThan(0);
    expect(drawerLifecycle.detailVisibility).not.toContain(true);
    expect(s.read.context).toBe('ledger'); expect(s.read.selected).toBeNull();
    expect(rows(s)).toHaveLength(10); expect(find(s.root, row => row.tag === 'drawer-probe')).toBeUndefined();
    await choose(s.root, ids(s)[0]);
    expect(drawerLifecycle.detailVisibility.at(-1)).toBe(true);
    expect(find(s.root, row => row.tag === 'detail-probe')).toBeDefined();
    await click(s.root, '关闭设备详情');
    expect(s.read.selected).toBeNull(); expect(find(s.root, row => row.tag === 'drawer-probe')).toBeUndefined();
    expect(s.storage.writes).toBe(0);
  });
  it('仅绑定当前页，统计和匹配数仍来自全库；浏览不写存储', async () => {
    const s = await mountEntry(), first = rows(s)[0];
    expect(rows(s)).toHaveLength(10); expect(table(s).props.total).toBe(414); expect(stats(s)).toContain('414');
    expect(table(s).props.columns).toContainEqual({ field: 'freqMinKhz', header: '型号支持频段（kHz）', sortable: false });
    expect(textOf(find(s.root, row => row.tag === 'band-cell')!)).toBe(first.freqMinKhz + '–' + first.freqMaxKhz);
    expect(textOf(find(s.root, row => row.tag === 'frequency-cell')!)).toBe('未提供'); expect(s.storage.writes).toBe(0);
  });
  it('全选仅当前页，半选、取消、翻页及迟到旧行事件都不会混入其他页', async () => {
    const s = await mountEntry(); pageCheck(s.root); await settle(); expect(control(s.root, '全选当前页').props.checked).toBe(true);
    await check(s.root, ids(s)[0], false); expect(control(s.root, '全选当前页').props.indeterminate).toBe(true);
    const oldEvent = control(s.root, '勾选 ' + ids(s)[0]).props.onChange as Function;
    (table(s).props.onTestPage as Function)({ first: 10, rows: 10 }); await settle();
    expect(s.read.ledger?.pageNum).toBe(2); expect(control(s.root, '全选当前页').props.checked).toBe(false);
    oldEvent({ target: { checked: true } }); await settle(); expect(textOf(s.root)).toContain('已勾选 0 台');
    pageCheck(s.root); await settle(); expect(textOf(s.root)).toContain('已勾选 10 台'); pageCheck(s.root, false); await settle(); expect(textOf(s.root)).toContain('已勾选 0 台');
  });
  it('合法筛选在服务内求交集；非法频率保留结果和当前页勾选', async () => {
    const s = await mountEntry(); await category(s.root, '短波设备 HF');
    await field(s.root, '频率下限（kHz）', '6000'); await field(s.root, '频率上限（kHz）', '6000'); await apply(s.root);
    expect(table(s).props.total).toBe(174); expect(rows(s).every(row => row.freqMinKhz <= 6000 && row.freqMaxKhz >= 6000)).toBe(true);
    pageCheck(s.root); await settle(); const before = ids(s);
    await field(s.root, '频率下限（kHz）', '7000'); await apply(s.root);
    expect(ids(s)).toEqual(before); expect(textOf(s.root)).toContain('已勾选 10 台'); expect(textOf(s.root)).toContain('频率下限不能大于上限');
    await field(s.root, '频率筛选依据', 'DEVICE'); await field(s.root, '频率下限（kHz）', '6000'); await apply(s.root);
    expect(rows(s)).toEqual([]); expect(textOf(s.root)).toContain('已勾选 0 台'); expect(s.storage.writes).toBe(0);
  });
  it('查询失败保留成功页，但不恢复旧勾选；导出传已应用筛选', async () => {
    const s = await mountEntry(); pageCheck(s.root); await settle(); const before = ids(s);
    vi.mocked(previewService.queryResourceDevices).mockRejectedValueOnce(new Error('查询失败'));
    await field(s.root, '搜索设备', 'new-filter'); expect(ids(s)).toEqual(before); expect(textOf(s.root)).toContain('已勾选 0 台');
    expect(s.read.errors.ledger).toBe('查询失败'); expect(s.read.ledgerApplied?.search).toBeUndefined();
    expect(find(s.root, row => row.tag === 'export-probe')?.props.filter).toMatchObject({ search: undefined });
  });
  it('部署和角色独立；新增未输入可关闭，取消切页签保留实际输入', async () => {
    const s = await mountEntry(); await category(s.root, '短波设备 HF');
    await category(s.root, '固定部署'); expect(table(s).props.total).toBe(32);
    await field(s.root, '筛选节点角色', 'RELAY'); expect(rows(s)).toEqual([]);
    await click(s.root, '新增设备'); expect(s.editor.formDirty).toBe(false); expect(await s.editor.closeForm()).toBe(true);
    await click(s.root, '新增设备'); s.editor.form!.fields.stationId = 'ND-0001';
    const switching = click(s.root, '频谱接口配置'); await settle(); expect(s.editor.decision).not.toBeNull();
    s.editor.answer('cancel'); await switching; expect(s.editor.form!.fields.stationId).toBe('ND-0001');
  });
  it('频谱页独立表格，不携带设备目录和统计，也不显示冗余首行说明', async () => {
    const s = await mountEntry(); await click(s.root, '频谱接口配置'); await settle();
    expect(textOf(s.root)).not.toContain('资源分类'); expect(find(s.root, row => row.props['aria-label'] === '资源统计')).toBeUndefined();
    expect(table(s).props.columns).toContainEqual({ field: 'protocol', header: '协议', sortable: false });
    expect(rows(s)).toHaveLength(2); expect(textOf(s.root)).not.toContain('HTTP_JSON 为我方默认建议');
    expect(control(s.root, 'Mock 检查场景')).toBeDefined(); expect(s.storage.writes).toBe(0);
  });
});
