import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import FrequencyResourcePanel from '../src/components/FrequencyResourcePanel.vue';
import { useFrequencyResourceStore } from '../src/stores/frequency-resource';
import { all, clientTemplate, node, renderer, textOf, type HostNode } from './helpers/vue-client';
import { ApiError } from '../src/services/types';

vi.mock('../src/components/AppTable.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['rows', 'columns', 'total', 'pageSize'], emits: ['page', 'select'],
    setup: (props, { slots, emit }) => () => h('div', { 'data-table': true }, [
      ...(props.rows ?? []).map((row: Record<string, unknown>) => h('div', [
        h('button', { onClick: () => emit('select', row) }, String(row.id)),
        slots.selected?.({ row }), slots.isAvailable?.({ row }), slots.changed?.({ row }), slots.actions?.({ row }),
      ])), h('span', '总数 ' + props.total),
      h('button', { 'aria-label': '下一页', onClick: () => emit('page', { first: 10, rows: 10 }) }, '下一页'),
    ]) }) };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup: (p, { slots }) => () => p.visible ? h('aside', slots.default?.()) : null }) };
});
vi.mock('../src/components/DecisionDialog.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['request'], emits: ['answer'], setup: (p, { emit }) => () => p.request ? h('div', { role: 'dialog' }, [
    h('p', p.request.title), h('p', p.request.message),
    ...(['cancelLabel', 'discardLabel', 'saveLabel'] as const).filter(key => p.request[key]).map(key => h('button', {
      onClick: () => emit('answer', { cancelLabel: 'cancel', discardLabel: 'discard', saveLabel: 'save' }[key]),
    }, p.request[key])),
  ]) : null }) };
});
beforeAll(() => clientTemplate(FrequencyResourcePanel, 'src/components/FrequencyResourcePanel.vue', 'frequency-panel-render.ts'));
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.unstubAllGlobals(); });
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); await nextTick(); }
const base = 'resource-1111111111111111', next = 'resource-2222222222222222';
async function fixture(canDisable = true) {
  vi.stubGlobal('document', { activeElement: null });
  pinia = createPinia(); setActivePinia(pinia);
  const item = { freqId: 'FQ-0002', deviceClass: 'HF', centerFreqKhz: 3195.7, bandwidthKhz: null, channelNo: null,
    isAvailable: true, occupiedBy: null, reuseMinDistanceM: null, adjacentGuardKhz: null, note: null };
  const page = { revision: base, baseRevision: base, contentHash: 'a'.repeat(64), dataOrigin: 'SYNTHETIC_INTEGRATION',
    source: '项目构造资源，非生产非实测', page: 1, pageSize: 10, total: 1, items: [item] };
  const services = { loadFrequencyResources: vi.fn(), queryFrequencyResources: vi.fn().mockResolvedValue(page),
    validateFrequencyDisable: vi.fn().mockResolvedValue({ ...page, selectedIds: ['FQ-0002'], wouldDisable: ['FQ-0002'], unchanged: [],
      impact: { resourceRevisionWillChange: true, historicalResourcesPreserved: true, savedPlansRequireRecompute: true, linkImpact: 'UNKNOWN' } }),
    disableFrequencyResources: vi.fn().mockImplementation(async request => ({ objectId: 'resource-frequency-disable', requestId: request.requestId,
      baseRevision: base, revision: next, readRevision: next, changed: true, selectedIds: ['FQ-0002'], updated: ['FQ-0002'], unchanged: [],
      affectedIds: ['FQ-0002'], items: [{ ...item, isAvailable: false }], dataOrigin: 'SYNTHETIC_INTEGRATION', source: page.source, warnings: [] })),
    queryFrequencyOperations: vi.fn().mockResolvedValue({ page: 1, pageSize: 10, total: 0, items: [] }), getFrequencyOperation: vi.fn() };
  const loadContext = vi.fn().mockResolvedValue({ revision: base }), changed = vi.fn();
  function mount() {
    const root = node('root');
    app = renderer.createApp({ render: () => h(FrequencyResourcePanel, { active: true, services,
      session: { accountId: 'actor', generation: 1, readable: true, canDisable, canMaintain: false }, loadContext, onResourceChanged: changed }) });
    app.use(pinia!); app.provide(ssrContextKey, {}); app.mount(root); return root;
  }
  const root = mount(); await flush();
  return { root, mount, services, loadContext, changed, store: useFrequencyResourceStore() };
}
function button(root: HostNode, label: string) { const hit = all(root, n => n.tag === 'button' && textOf(n).trim() === label)[0]; expect(hit).toBeTruthy(); return hit; }
async function click(root: HostNode, label: string) {
  const value = button(root, label);
  await (value.props.onClick as (event: unknown) => unknown)({ stopPropagation() {}, preventDefault() {} }); await flush();
}
describe('规划频点专用管理面板', () => {
  it('加载来源及服务器列表，显示只读详情中的未知值', async () => {
    const f = await fixture(); expect(textOf(f.root)).toContain('项目构造资源'); expect(textOf(f.root)).toContain('总数 1');
    expect(f.services.queryFrequencyResources).toHaveBeenCalledOnce();
    await click(f.root, '详情'); expect(textOf(f.root)).toContain('未提供'); expect(textOf(f.root)).toContain('中心频率 / kHz');
    expect(textOf(f.root)).not.toContain('新增配置'); expect(textOf(f.root)).not.toContain('执行 Mock 检查');
  });
  it('只读身份停用控件禁用，详情和列表仍可浏览', async () => {
    const f = await fixture(false); expect(button(f.root, '停用所选').props.disabled).toBe(true);
    const checkboxes = all(f.root, n => n.tag === 'input' && n.props.type === 'checkbox');
    expect(checkboxes.every(n => n.props.disabled === true)).toBe(true);
    expect(f.services.validateFrequencyDisable).not.toHaveBeenCalled();
  });
  it('同会话重新挂载回填服务器筛选，不显示全部却保留隐藏筛选', async () => {
    const f = await fixture(); await f.store.applyFilters({ search: 'FQ-0002' });
    app!.unmount(); const root = f.mount(); await flush();
    const search = all(root, n => n.tag === 'input' && n.props['aria-label'] === '频点编号或备注')[0];
    expect(search.value).toBe('FQ-0002');
    expect(f.services.queryFrequencyResources.mock.lastCall?.[0]).toMatchObject({ search: 'FQ-0002' });
  });
  it('选择行后预检，取消不提交，确认显示真实回执并发换版事件', async () => {
    const f = await fixture();
    f.store.select('FQ-0002', true); await flush(); await click(f.root, '停用所选');
    expect(textOf(f.root)).toContain('链路级影响未提供'); await click(f.root, '取消');
    expect(f.services.disableFrequencyResources).not.toHaveBeenCalled();
    await click(f.root, '停用所选'); f.loadContext.mockResolvedValue({ revision: next }); await click(f.root, '确认停用');
    expect(f.services.disableFrequencyResources).toHaveBeenCalledOnce(); expect(textOf(f.root)).toContain('停用回执');
    expect(f.changed).toHaveBeenCalledWith(expect.objectContaining({ previousRevision: base, revision: next, changed: true }));
  });
  it('分页使用宿主表格事件请求服务器，不在本页过滤后伪报数量', async () => {
    const f = await fixture(); await click(f.root, '下一页');
    expect(f.services.queryFrequencyResources.mock.lastCall?.[0]).toMatchObject({ page: 2, pageSize: 10, revision: base });
  });
  it('超时显示待核实请求和原请求重试入口，不假报取消成功', async () => {
    const f = await fixture(); f.services.disableFrequencyResources.mockRejectedValueOnce(new ApiError('超时', 'REQUEST_TIMEOUT'));
    f.store.select('FQ-0002', true); await flush(); await click(f.root, '停用所选'); await click(f.root, '确认停用');
    expect(textOf(f.root)).toContain('提交结果待核实'); expect(button(f.root, '核实原回执')).toBeTruthy();
    expect(button(f.root, '重试原请求')).toBeTruthy(); expect(button(f.root, '停用所选').props.disabled).toBe(true);
  });
});
