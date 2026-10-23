import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import AppTable from '../src/components/AppTable.vue';
import AppDrawer from '../src/components/AppDrawer.vue';
// 仅复用模板编译，原有宿主、替身和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';

// 执行公共组件模板，以宿主事件检查排序开关、展开身份和默认尺寸边界。
vi.mock('primevue/datatable', () => ({ default: { inheritAttrs: false, props: ['value', 'selection', 'expandedRows', 'sortField', 'sortOrder', 'tableStyle'], emits: ['sort', 'page', 'update:selection', 'update:expandedRows'], setup(props: any, { emit, slots }: any) { return () => h('table-probe', { ...props, sort: (value: unknown) => emit('sort', value), page: (value: unknown) => emit('page', value), select: (value: unknown) => emit('update:selection', value), expand: (id: string) => emit('update:expandedRows', { [id]: true }) }, [slots.default?.(), ...props.value.filter((row: any) => props.expandedRows?.[row.id]).map((data: unknown) => slots.expansion?.({ data }))]); } } }));
vi.mock('primevue/column', () => ({ default: { inheritAttrs: false, props: ['field', 'header', 'sortable', 'expander', 'style', 'pt'], setup: (props: any, { slots }:any) => () => h('column-probe', { ...props },slots.header?.()) } }));
vi.mock('primevue/drawer', () => ({ default: { inheritAttrs: false, setup: (_: unknown, { attrs, slots }: any) => () => h('drawer-probe', attrs, slots.default?.()) } }));
beforeAll(async () => {
  for (const [component, name] of [[AppTable, 'AppTable'], [AppDrawer, 'AppDrawer']] as const) {
    const filename = `src/components/${name}.vue`;
    await clientTemplate(component, filename, 'table-render.ts');
  }
});
interface Host { tag: string; text: string; children: Host[]; parent: Host | null; props: Record<string, any> }
const node = (tag: string, text = ''): Host => ({ tag, text, children: [], parent: null, props: {} });
function remove(el: Host) { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null; }
const renderer = createRenderer<Host, Host>({ createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text), insert(el, parent, anchor) { remove(el); el.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, el); }, remove, setText(el, text) { el.text = text; }, setElementText(el, text) { el.text = text; el.children = []; }, parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null, patchProp(el, key, _, value) { el.props[key] = value; }, insertStaticContent(text, parent) { const el = node('#static', text); el.parent = parent; parent.children.push(el); return [el, el]; } });
const all = (root: Host, predicate: (row: Host) => boolean): Host[] => [...(predicate(root) ? [root] : []), ...root.children.flatMap(row => all(row, predicate))];
const text = (root: Host): string => root.text + root.children.map(text).join('');
let app: App | undefined;
function mount(component: any, props: any, slots = {}) { const root = node('root'); app = renderer.createApp({ render: () => h(component, props, slots) }); app.provide(ssrContextKey, { modules: new Set() }); app.mount(root); return root; }
afterEach(() => { app?.unmount(); app = undefined; });
describe('规划表格的局部阅读配置', () => {
  it('受控表头仅向调用方发列选择，不让内置比较器二次排序，其他列不开放', async () => {
    const sort=vi.fn(),rows=[{id:'A',power:50},{id:'B',power:null}];
    const props=reactive({rows,columns:[{field:'id',header:'方案',sortable:false},{field:'power',header:'功率',sortable:true}],controlledSort:true,sortable:true,sortField:'power',sortOrder:-1,onSort:sort});
    const root=mount(AppTable,props),table=all(root,row=>row.tag==='table-probe')[0];
    expect(table.props.sortField).toBeUndefined();expect(table.props.sortOrder).toBeUndefined();expect(table.props.value).toEqual(rows);
    const headers=all(root,row=>row.tag==='button');expect(headers).toHaveLength(1);
    expect(all(root,row=>row.tag==='column-probe'&&row.props.field==='power')[0].props.pt.headerCell['aria-sort']).toBe('descending');
    headers[0].props.onClick({stopPropagation:vi.fn()});expect(sort).toHaveBeenCalledWith({sortField:'power'});
    props.sortable=false;await nextTick();expect(all(root,row=>row.tag==='button')).toHaveLength(0);
  });
  it('其他页面默认排序保持，明确禁排的列仍不开放', () => {
    const root = mount(AppTable, { rows: [{ id: 'one' }], columns: [{ field: 'id', header: '编号' }, { field: 'note', header: '说明', sortable: false }] });
    const columns = all(root, row => row.tag === 'column-probe');
    expect(columns.map(row => row.props.sortable)).toEqual([true, false]);
  });
  it('局部关闭排序同时拒绝初始排序和服务排序事件，分页及选中仍可用', () => {
    const sort = vi.fn(), page = vi.fn(), select = vi.fn(), row = { id: 'one' };
    const root = mount(AppTable, { rows: [row], columns: [{ field: 'id', header: '编号' }], sortable: false, server: true, sortField: 'id', sortOrder: 1, onSort: sort, onPage: page, onSelect: select });
    const table = all(root, row => row.tag === 'table-probe')[0];
    expect(all(root, row => row.tag === 'column-probe')[0].props.sortable).toBe(false);
    expect(table.props.sortField).toBeUndefined(); expect(table.props.sortOrder).toBeUndefined();
    table.props.sort({ sortField: 'id', sortOrder: -1 }); table.props.page({ first: 10, rows: 10 }); table.props.select(row);
    expect(sort).not.toHaveBeenCalled(); expect(page).toHaveBeenCalledWith({ first: 10, rows: 10 }); expect(select).toHaveBeenCalledWith(row);
  });
  it('行详情保留零值、否值、集合及缺值，展开不触发行选择', async () => {
    const select = vi.fn(), root = mount(AppTable, { rows: [{ id: 'one', zero: 0, flag: false, ids: ['A', 'B'], missing: null }], columns: [{ field: 'id', header: '编号' }], compact: true, detailColumns: [{ field: 'zero', header: '数值' }, { field: 'flag', header: '备用' }, { field: 'ids', header: '节点' }, { field: 'missing', header: '说明' }], onSelect: select });
    all(root, row => row.tag === 'table-probe')[0].props.expand('one'); await nextTick();
    expect(text(root)).toContain('数值0备用否节点A / B说明未提供'); expect(select).not.toHaveBeenCalled();
  });
  it('同 ID 换快照、数据重读或翻页均清理展开现场', async () => {
    const props = reactive({ rows: [{ id: 'one', note: '旧快照' }], columns: [{ field: 'id', header: '编号' }], detailColumns: [{ field: 'note', header: '说明' }], detailsKey: 'first' });
    const root = mount(AppTable, props), table = () => all(root, row => row.tag === 'table-probe')[0];
    table().props.expand('one'); await nextTick(); expect(text(root)).toContain('旧快照');
    props.detailsKey = 'second'; await nextTick(); expect(text(root)).not.toContain('旧快照');
    table().props.expand('one'); await nextTick(); props.rows = [{ id: 'one', note: '新快照' }]; await nextTick(); expect(text(root)).not.toContain('新快照');
    table().props.expand('one'); await nextTick(); expect(text(root)).toContain('新快照');
    table().props.page({ first: 10, rows: 10 }); await nextTick(); expect(text(root)).not.toContain('新快照');
  });
  it('阅读抽屉可加宽，默认宽度和窄屏上限保持', async () => {
    const props = reactive({ visible: true, title: '配置', width: undefined as string | undefined }), root = mount(AppDrawer, props);
    const drawer = () => all(root, row => row.tag === 'drawer-probe')[0];
    expect(drawer().props.style).toEqual({ width: '460px', maxWidth: '95vw' });
    props.width = '960px'; await nextTick(); expect(drawer().props.style).toEqual({ width: '960px', maxWidth: '95vw' });
  });
});
