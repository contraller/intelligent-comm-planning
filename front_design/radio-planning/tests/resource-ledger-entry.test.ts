import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ResourcesView from '../src/views/ResourcesView.vue';
import ResourceLedgerFilters from '../src/components/ResourceLedgerFilters.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { selectResourceExport } from '../src/services/resource-files';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import type { Device, DeviceClass } from '../src/types/domain';
import type { ResourceKind } from '../src/types/resource-edit';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

// 保留真实页面与筛选模板；表格仅代替分页布局，所有行及业务插槽照常渲染。
vi.mock('../src/components/AppTable.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['rows', 'columns', 'selected'], emits: ['select'],
    setup(props, { emit, slots }) {
      return () => h('table-probe', { rows: props.rows, columns: props.columns, selected: props.selected }, props.rows.map((row: Device) =>
        h('row-probe', { id: row.id }, [h('button', { 'aria-label': '查看台账设备 ' + row.id, onClick: () => emit('select', row) }, row.id),
          slots.selection?.({ row }), h('band-cell', slots.freqMinKhz?.({ row })), h('frequency-cell', slots.workFreqKhz?.({ row }))])));
    } }) };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup(props, { slots }) {
    return () => props.visible ? h('drawer-probe', [slots.default?.(), slots.footer?.()]) : null;
  } }) };
});
vi.mock('../src/components/DeviceInfoPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['device'], setup(props, { slots }) {
    return () => h('detail-probe', { device: props.device }, slots.actions?.());
  } }) };
});
vi.mock('../src/components/ResourceExportDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'filteredIds', 'selectedIds'], setup: props => () => h('export-probe', { ...props }) }) };
});
vi.mock('../src/components/SpectrumConfigPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/StatusBadge.vue', () => ({ default: { render: () => null } }));
// 在内存宿主执行真实客户端模板；不把宿主事件验证当作浏览器视觉验收。
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

await Promise.all([clientTemplate(ResourcesView, 'src/views/ResourcesView.vue'), clientTemplate(ResourceLedgerFilters, 'src/components/ResourceLedgerFilters.vue')]);
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mountEntry() {
  vi.stubGlobal('window', new EventTarget());
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  // 新状态目录沿用本入口测试数据，避免误读真实浏览器会话。
  vi.spyOn(previewService, 'loadDeviceStatusContext').mockImplementation(raw.loadDeviceStatusContext);
  for (const name of ['loadPreview', 'commitResources', 'setDeviceAvailability'] as const)
    vi.spyOn(previewService, name).mockImplementation(raw[name] as never);
  const preview = usePreviewStore(); await preview.load();
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/resources', component: ResourcesView }, { path: '/situation', component: { render: () => null } },
  ] });
  await router.push('/resources'); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  const root = node('root'); app.mount(root); await settle();
  return { root, preview, storage, raw, auth, router, editor: useResourceEditStore() };
}
type Fixture = Awaited<ReturnType<typeof mountEntry>>;
type LedgerRow = Device & { freqMinKhz: number; freqMaxKhz: number; deviceClass: DeviceClass };
const control = (root: HostNode, label: string) => {
  const found = find(root, row => row.props['aria-label'] === label); expect(found, label).toBeDefined(); return found!;
};
// 分类按钮还带有全库数量，只按其中的分类名称选择。
async function category(root: HostNode, label: string) {
  const button = find(root, row => row.tag === 'button' && row.children.some(child => child.props.class === 'row-label' && textOf(child).trim() === label));
  expect(button, label).toBeDefined(); await (button!.props.onClick as () => unknown)(); await settle();
}
async function field(root: HostNode, label: string, value: string) {
  const input = control(root, label), event = input.tag === 'select' ? 'onChange' : 'onInput';
  (input.props[event] as Function)({ target: { value } }); await settle();
}
async function apply(root: HostNode) {
  const form = control(root, '频率筛选'); (form.props.onSubmit as Function)({ preventDefault() {} }); await settle();
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
const exported = (s: Fixture, selected = false) => find(s.root, row => row.tag === 'export-probe')!.props[selected ? 'selectedIds' : 'filteredIds'] as Record<ResourceKind, string[]>;
const stats = (s: Fixture) => textOf(find(s.root, row => row.props.class === 'stats-grid')!);

describe('Mock 台账告警与频率筛选页面', () => {
  it('初始全库统计保留，两列区分型号范围和空配置，不在浏览时写存储', async () => {
    const s = await mountEntry(), first = rows(s)[0], before = JSON.stringify(s.preview.data);
    expect(rows(s)).toHaveLength(414);
    expect(table(s).props.columns).toContainEqual({ field: 'freqMinKhz', header: '型号支持频段（kHz）', sortable: false });
    expect(table(s).props.columns).toContainEqual({ field: 'workFreqKhz', header: '设备工作频点（kHz）' });
    expect(textOf(find(s.root, row => row.tag === 'band-cell')!)).toBe(first.freqMinKhz + '–' + first.freqMaxKhz);
    expect(textOf(find(s.root, row => row.tag === 'frequency-cell')!)).toBe('未提供');
    expect(stats(s)).toContain('414'); expect(textOf(s.root)).toContain('匹配 414 台设备');
    expect(JSON.stringify(s.preview.data)).toBe(before); expect(s.storage.writes).toBe(0);
  });
  // 仅限制台账排序入口；初始顺序及行选择仍使用原数据和详情流程。
  it('只开放三列排序且不会因列配置改变初始顺序或设备选择', async () => {
    const s = await mountEntry();
    const columns = table(s).props.columns as { field: string; sortable?: boolean }[];
    expect(columns.filter(column => column.sortable !== false).map(column => column.field))
      .toEqual(['id', 'displayedStatus', 'workFreqKhz']);
    expect(ids(s)).toEqual(s.preview.data!.resources.devices.map(device => device.id));
    await choose(s.root, 'DV-0027');
    expect(table(s).props.selected).toMatchObject({ id: 'DV-0027' });
    expect(find(s.root, row => row.tag === 'detail-probe')!.props.device).toMatchObject({ id: 'DV-0027' });
    expect(s.storage.writes).toBe(0);
  });
  it('附加告警与运行状态、类别、关键词和在架条件求交集，全库统计不变', async () => {
    const s = await mountEntry(), data = s.preview.data!.resources, device = data.devices[0];
    // 只改测试内存输入，验证正常且告警的组合不被误排除。
    device.status = 'NORMAL'; device.alert = true; await settle(); const originalStats = stats(s);
    await field(s.root, '筛选附加告警', 'YES'); await field(s.root, '筛选设备状态', 'NORMAL');
    expect(ids(s)).toContain(device.id); expect(rows(s).every(row => row.alert && row.status === 'NORMAL')).toBe(true);
    await category(s.root, '短波设备 HF'); await field(s.root, '搜索设备', device.id); await field(s.root, '在架状态', 'ACTIVE');
    expect(ids(s)).toEqual([device.id]); expect(exported(s).devices).toEqual([device.id]);
    await field(s.root, '筛选附加告警', 'NO'); expect(rows(s)).toEqual([]); expect(stats(s)).toBe(originalStats); expect(s.storage.writes).toBe(0);
  });
  it('频率输入与已应用条件分开；同一范围切换两种口径不会自动填充工作频点', async () => {
    const s = await mountEntry(), original = JSON.stringify(s.preview.data);
    await field(s.root, '频率筛选依据', 'MODEL'); await field(s.root, '频率下限（kHz）', '6000');
    await field(s.root, '频率上限（kHz）', '6000');
    expect(rows(s)).toHaveLength(414); expect(textOf(s.root)).toContain('频率条件尚未应用');
    await apply(s.root); const expected = s.preview.data!.resources.devices.filter(device => {
      const model = s.preview.data!.resources.models.find(row => row.id === device.modelId)!;
      return model.freqMinKhz <= 6000 && model.freqMaxKhz >= 6000;
    }).map(row => row.id);
    expect(ids(s)).toEqual(expected); expect(expected.length).toBeGreaterThan(10);
    await field(s.root, '频率筛选依据', 'DEVICE'); expect(ids(s)).toEqual(expected);
    await apply(s.root); expect(rows(s)).toEqual([]); expect(exported(s).devices).toEqual([]);
    expect(JSON.stringify(s.preview.data)).toBe(original); expect(s.storage.writes).toBe(0);
  });
  it('频点为空独立筛选且停用范围；有值无结果，不回退型号或全库', async () => {
    const s = await mountEntry();
    await field(s.root, '频率筛选依据', 'DEVICE'); await field(s.root, '频率下限（kHz）', '6000');
    await field(s.root, '工作频点是否有值', 'MISSING');
    expect(control(s.root, '频率下限（kHz）').props.disabled).toBe(true);
    expect(control(s.root, '频率上限（kHz）').props.disabled).toBe(true);
    await apply(s.root); expect(rows(s)).toHaveLength(414); expect(textOf(s.root)).toContain('已应用：设备工作频点 · 频点为空');
    await field(s.root, '工作频点是否有值', 'PRESENT'); await field(s.root, '频率下限（kHz）', '');
    await apply(s.root); expect(rows(s)).toEqual([]); expect(textOf(s.root)).toContain('匹配 0 台设备');
  });
  it.each(['bad', '-1', '7000'])('非法或倒置下限 %s 保留已应用结果、勾选和导出范围', async min => {
    const s = await mountEntry(); await field(s.root, '频率筛选依据', 'MODEL');
    await field(s.root, '频率下限（kHz）', '6000'); await field(s.root, '频率上限（kHz）', '6000'); await apply(s.root);
    await click(s.root, '勾选筛选结果（全部分页）'); const expected = ids(s), selected = [...exported(s, true).devices];
    await field(s.root, '频率下限（kHz）', min); await apply(s.root);
    expect(ids(s)).toEqual(expected); expect(exported(s).devices).toEqual(expected); expect(exported(s, true).devices).toEqual(selected);
    expect(textOf(s.root)).toContain(min === '7000' ? '频率下限不能大于上限' : '频率下限须为非负有限数');
    expect(textOf(s.root)).toContain('已应用：型号支持频段 · 6000–6000 kHz');
    expect(s.storage.writes).toBe(0);
  });
  it('勾选覆盖全部分页，筛选导出和列表一致，隐藏勾选不被偷偷裁掉', async () => {
    const s = await mountEntry(); await field(s.root, '频率筛选依据', 'MODEL');
    await field(s.root, '频率下限（kHz）', '6000'); await apply(s.root);
    const expected = ids(s); expect(expected.length).toBeGreaterThan(10);
    await click(s.root, '勾选筛选结果（全部分页）'); expect(exported(s, true).devices).toEqual(expected);
    const output = selectResourceExport(s.preview.data!.resources, { context: 'ledger', format: 'csv', kinds: ['devices'], ids: exported(s) });
    expect(output.tables[0].rows.map(row => row[0])).toEqual(expected);
    await field(s.root, '搜索设备', expected[0]); expect(ids(s)).toEqual([expected[0]]);
    expect(exported(s).devices).toEqual([expected[0]]); expect(exported(s, true).devices).toEqual(expected);
    expect(textOf(s.root)).toContain('其中 ' + (expected.length - 1) + ' 台在筛选结果外');
    const selectedOutput = selectResourceExport(s.preview.data!.resources, { context: 'ledger', format: 'csv', kinds: ['devices'], ids: exported(s, true) });
    expect(selectedOutput.tables[0].rows.map(row => row[0])).toEqual(expected);
  });
  it('批量下架保留筛选外勾选目标，取消不变，确认沿用原 Mock 保存', async () => {
    const s = await mountEntry(); await check(s.root, 'DV-0001'); await check(s.root, 'DV-0002');
    await field(s.root, '搜索设备', 'DV-0001');
    const button = find(s.root, row => row.tag === 'button' && textOf(row) === '批量下架')!;
    const first = (button.props.onClick as () => Promise<void>)(); await settle(); expect(s.editor.decision?.message).toContain('本次 2 台设备');
    s.editor.answer('cancel'); await first; expect(s.storage.writes).toBe(0);
    const second = (button.props.onClick as () => Promise<void>)(); await settle(); s.editor.answer('save'); await second; await settle();
    expect(previewService.setDeviceAvailability).toHaveBeenCalledWith(expect.objectContaining({ ids: ['DV-0001', 'DV-0002'], availability: 'OFF_SHELF' }));
    expect(s.preview.data!.resources.devices.filter(row => ['DV-0001', 'DV-0002'].includes(row.id)).every(row => row.availability === 'OFF_SHELF')).toBe(true);
    expect(exported(s, true).devices).toEqual(['DV-0001', 'DV-0002']); expect(ids(s)).toEqual(['DV-0001']);
  });
  it('筛选和清除都保留详情与未保存输入，只恢复显示条件', async () => {
    const s = await mountEntry(); await choose(s.root, 'DV-0001'); await check(s.root, 'DV-0001');
    await field(s.root, '搜索设备', '不存在');
    expect(find(s.root, row => row.tag === 'detail-probe')!.props.device).toMatchObject({ id: 'DV-0001' });
    expect(textOf(s.root)).toContain('当前查看或编辑的设备不在筛选结果中');
    await click(s.root, '编辑设备参数'); s.editor.form!.fields.workFreqKhz = '6000'; await settle();
    const before = JSON.stringify(s.editor.form);
    await field(s.root, '筛选附加告警', 'YES'); await field(s.root, '筛选设备状态', 'FAULT'); await field(s.root, '在架状态', 'OFF_SHELF');
    await category(s.root, '超短波设备 VUHF'); await field(s.root, '频率筛选依据', 'MODEL');
    await field(s.root, '频率下限（kHz）', 'bad'); await apply(s.root);
    await click(s.root, '清除全部筛选');
    expect(rows(s)).toHaveLength(414); expect(exported(s, true).devices).toEqual(['DV-0001']);
    expect(JSON.stringify(s.editor.form)).toBe(before); expect(s.editor.formDirty).toBe(true); expect(s.storage.writes).toBe(0);
    expect(control(s.root, '频率筛选依据').props.value).toBe('ALL'); expect(control(s.root, '频率下限（kHz）').props.value).toBe('');
    expect(textOf(s.root)).not.toContain('频率下限须'); expect(textOf(s.root)).not.toContain('不在筛选结果中');
  });
  it('未保存工作频点不影响筛选，保存成功才进入结果；失败保留输入和旧范围', async () => {
    const s = await mountEntry(); await choose(s.root, 'DV-0001'); await click(s.root, '编辑设备参数');
    s.editor.form!.fields.workFreqKhz = '6000'; await settle();
    await field(s.root, '频率筛选依据', 'DEVICE'); await field(s.root, '频率下限（kHz）', '6000'); await field(s.root, '频率上限（kHz）', '6000'); await apply(s.root);
    expect(rows(s)).toEqual([]); expect(s.preview.data!.resources.devices[0].workFreqKhz).toBeNull();
    s.storage.failWrite = true; expect(await s.editor.save()).toBe(false); await settle();
    expect(rows(s)).toEqual([]); expect(s.editor.form!.fields.workFreqKhz).toBe('6000');
    s.storage.failWrite = false; expect(await s.editor.save(), s.editor.error).toBe(true); await settle();
    expect(ids(s)).toEqual(['DV-0001']); expect(exported(s).devices).toEqual(['DV-0001']);
    expect(textOf(find(s.root, row => row.tag === 'frequency-cell')!)).toBe('6000');
  });
  it('切换页签保留已应用与未应用条件，新挂载恢复默认', async () => {
    const s = await mountEntry(); await field(s.root, '筛选附加告警', 'YES');
    await field(s.root, '频率筛选依据', 'MODEL'); await field(s.root, '频率下限（kHz）', '6000'); await apply(s.root);
    const before = ids(s); await field(s.root, '频率下限（kHz）', '7000');
    await click(s.root, '频谱接口配置'); await click(s.root, '设备台账');
    expect(ids(s)).toEqual(before); expect(control(s.root, '频率下限（kHz）').props.value).toBe('7000');
    expect(textOf(s.root)).toContain('已应用：型号支持频段 · ≥ 6000 kHz'); expect(textOf(s.root)).toContain('频率条件尚未应用');
    await s.router.push('/situation'); await settle(); await s.router.push('/resources'); await settle();
    expect(rows(s)).toHaveLength(414); expect(control(s.root, '频率筛选依据').props.value).toBe('ALL'); expect(s.storage.writes).toBe(0);
  });
  it('切换详情或页签被取消时保留筛选和原表单，筛选本身不触发关闭确认', async () => {
    const s = await mountEntry(); await choose(s.root, 'DV-0001'); await click(s.root, '编辑设备参数');
    s.editor.form!.fields.workFreqKhz = '6000'; const before = JSON.stringify(s.editor.form), close = vi.spyOn(s.editor, 'closeForm');
    await field(s.root, '搜索设备', 'DV-0002'); expect(close).not.toHaveBeenCalled();
    await choose(s.root, 'DV-0002'); expect(s.editor.decision).not.toBeNull(); s.editor.answer('cancel'); await settle();
    expect(table(s).props.selected).toMatchObject({ id: 'DV-0001' }); expect(JSON.stringify(s.editor.form)).toBe(before);
    const tab = find(s.root, row => row.tag === 'button' && textOf(row) === '频谱接口配置')!;
    const pending = (tab.props.onClick as () => Promise<void>)(); await settle(); s.editor.answer('cancel'); await pending; await settle();
    expect(ids(s)).toEqual(['DV-0002']); expect(control(s.root, '搜索设备').props.value).toBe('DV-0002'); expect(JSON.stringify(s.editor.form)).toBe(before);
  });
  it('失去维护权限仍可只读筛选，原批量和编辑入口保持禁用', async () => {
    const s = await mountEntry(); await check(s.root, 'DV-0001');
    s.auth.identity!.permissions = s.auth.identity!.permissions.filter(value => value !== 'resources.edit'); await settle();
    await field(s.root, '搜索设备', 'DV-0001'); expect(ids(s)).toEqual(['DV-0001']);
    expect(find(s.root, row => row.tag === 'button' && textOf(row) === '批量下架')!.props.disabled).toBe(true);
    await choose(s.root, 'DV-0001'); expect(find(s.root, row => row.tag === 'button' && textOf(row).trim() === '编辑设备参数')!.props.disabled).toBe(true);
    expect(s.storage.writes).toBe(0);
  });
});
