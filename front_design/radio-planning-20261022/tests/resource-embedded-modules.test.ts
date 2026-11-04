import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ResourcesView from '../src/views/ResourcesView.vue';
import SpectrumConfigPanel from '../src/components/SpectrumConfigPanel.vue';
import FrequencyResourcePanel from '../src/components/FrequencyResourcePanel.vue';
import SpectrumMonitoringPanel from '../src/components/SpectrumMonitoringPanel.vue';
import ResourceLedgerTree from '../src/components/ResourceLedgerTree.vue';
import ResourceLedgerFilters from '../src/components/ResourceLedgerFilters.vue';
import ResourceStatusPanel from '../src/components/ResourceStatusPanel.vue';
import ResourceReadStatus from '../src/components/ResourceReadStatus.vue';
import ResourceLedgerEditDrawer from '../src/components/ResourceLedgerEditDrawer.vue';
import ResourceLedgerImportDrawer from '../src/components/ResourceLedgerImportDrawer.vue';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useResourceLedgerEditStore } from '../src/stores/resource-ledger-edit';
import { useResourceStatusStore } from '../src/stores/resource-status';
import { previewService } from '../src/services';
import { collaborationHttp, httpService } from '../src/services/http';
import { createMockService } from '../src/services/mock';
import { ApiError } from '../src/services/types';
import { deviceStatusSchema, type DeviceStatusHeader } from '../src/types/device-status-snapshot';
import type { SpectrumSourceRow } from '../src/types/spectrum-source';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

// 仅隔离第三方表格和弹层DOM；业务组件、服务调用和离开决策使用原实现。
vi.mock('../src/components/AppTable.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['rows', 'columns'], emits: ['select'],
    setup: (props, { emit, slots }) => () => h('table-probe', { columns: props.columns }, (props.rows ?? []).map((row: any) => h('row-probe', [
      h('button', { onClick: () => emit('select', row) }, row.id), slots.actions?.({ row }),
    ]))) }) };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'title'], setup: (props, { slots }) => () => props.visible
    ? h('aside', { 'aria-label': props.title }, [slots.default?.(), slots.footer?.()]) : null }) };
});
vi.mock('../src/components/DecisionDialog.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['request'], emits: ['answer'], setup: (props, { emit }) => () => props.request
    ? h('div', { role: 'dialog' }, [h('p', props.request.title), ...(['cancel', 'discard', 'save'] as const)
      .filter(value => props.request[value + 'Label']).map(value => h('button', {
        onClick: () => emit('answer', value),
      }, props.request[value + 'Label']))]) : null }) };
});
vi.mock('../src/components/DeviceInfoPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DeviceConfigurationDrawer.vue', () => ({ default: { render: () => null } }));

beforeAll(async () => {
  for (const [component, name] of [[ResourcesView, 'views/ResourcesView'], [SpectrumConfigPanel, 'components/SpectrumConfigPanel'],
    [FrequencyResourcePanel, 'components/FrequencyResourcePanel'], [SpectrumMonitoringPanel, 'components/SpectrumMonitoringPanel'],
    [ResourceLedgerTree, 'components/ResourceLedgerTree'], [ResourceLedgerFilters, 'components/ResourceLedgerFilters'],
    [ResourceStatusPanel, 'components/ResourceStatusPanel'], [ResourceReadStatus, 'components/ResourceReadStatus'],
    [ResourceLedgerEditDrawer, 'components/ResourceLedgerEditDrawer'], [ResourceLedgerImportDrawer, 'components/ResourceLedgerImportDrawer']] as const)
    await clientTemplate(component, 'src/' + name + '.vue', 'resource-embedded-render.ts');
});
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function settle() { for (let i = 0; i < 16; i++) await nextTick(); }
function button(root: HostNode, label: string) { return find(root, row => row.tag === 'button' && textOf(row).trim() === label); }
async function click(root: HostNode, label: string) { const target = button(root, label); expect(target, label).toBeDefined(); await (target!.props.onClick as Function)(); await settle(); }
function field(root: HostNode, label: string) {
  const row = find(root, item => item.tag === 'label' && textOf(item).startsWith(label)); expect(row, label).toBeDefined();
  return find(row!, item => ['input', 'textarea'].includes(item.tag))!;
}
async function fill(root: HostNode, label: string, value: string) { (field(root, label).props['onUpdate:modelValue'] as Function)(value); await settle(); }
function inputValue(root: HostNode, label: string) { return (field(root, label) as unknown as { value: string }).value; }
const sourceRow: SpectrumSourceRow = { schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', sourceId: 'source-A',
  configRevision: 'SPV-' + 'a'.repeat(64), contentHash: 'a'.repeat(64), createdAt: '2026-11-04T00:00:00Z', actorId: 'test-editor',
  latestOfflineCheck: null, draft: { name: '独立接口来源', protocolHint: null, endpoint: null, intervalSeconds: null,
    minKhz: null, maxKhz: null, enabled: false, provenanceNote: '本地组件测试构造配置，非实测' } };
async function setup(tab?: string, embedded = true, holdLedger = false) {
  class FixtureDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', FixtureDocument); vi.stubGlobal('document', new FixtureDocument()); vi.stubGlobal('ShadowRoot', class {});
  vi.stubGlobal('window', new EventTarget());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const storage = new TestStorage(), raw = createMockService(() => storage);
  for (const key of ['loadResourceReadContext', 'queryResourceDevices', 'queryResourceMap', 'getResourceObject',
    'loadResourceMaintenanceContext', 'previewResourceExport', 'loadDeviceStatusOptions'] as const)
    vi.spyOn(previewService, key).mockImplementation(raw[key] as never);
  const read = useResourceReadStore(), stop = vi.spyOn(read, 'stop'); if (holdLedger) read.refreshing = true;
  const contexts = vi.mocked(previewService.loadResourceReadContext), devices = vi.mocked(previewService.queryResourceDevices);
  const sourceList = vi.spyOn(collaborationHttp.spectrumSources, 'querySources').mockImplementation(async input => ({ schemaVersion: 1,
    dataOrigin: 'SYNTHETIC_INTEGRATION', page: input.page, pageSize: input.pageSize, total: 1, items: [structuredClone(sourceRow)] }));
  vi.spyOn(collaborationHttp.spectrumSources, 'getSource').mockResolvedValue(structuredClone(sourceRow));
  const sourceSave = vi.spyOn(collaborationHttp.spectrumSources, 'saveSource').mockRejectedValue(new ApiError('测试禁止提交', 1204));
  vi.spyOn(collaborationHttp.deviceStatuses, 'listSnapshots').mockImplementation(async input => ({ schema_version: deviceStatusSchema,
    page: input.page ?? 1, page_size: input.page_size ?? 20, total: 0, items: [] }));
  const frequencyContext = vi.spyOn(httpService, 'loadResourceReadContext').mockImplementation(raw.loadResourceReadContext);
  const revision = 'resource-' + 'a'.repeat(16);
  frequencyContext.mockImplementation(async input => ({ ...await raw.loadResourceReadContext(input), revision }));
  const frequencies = vi.spyOn(collaborationHttp.frequencies, 'queryFrequencyResources').mockResolvedValue({ revision, baseRevision: revision,
    contentHash: 'a'.repeat(64), dataOrigin: 'SYNTHETIC_INTEGRATION', source: '本地构造频点，非实测', items: [], page: 1, pageSize: 10, total: 0 });
  vi.spyOn(collaborationHttp.frequencies, 'queryFrequencyOperations').mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0 });
  const observations = vi.spyOn(collaborationHttp.observations, 'queryObservationDatasets').mockResolvedValue({ schemaVersion: 1,
    dataOrigin: 'SYNTHETIC_INTEGRATION', page: 1, pageSize: 10, total: 0, items: [] });
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/resources', component: ResourcesView }] });
  await router.push('/resources' + (tab ? '?tab=' + tab : '')); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() });
  if (embedded) app.provide('embeddedModule', true);
  const root = node('root'); app.mount(root); await settle();
  return { root, router, auth, storage, read, stop, contexts, devices, sourceList, sourceSave, frequencyContext, frequencies, observations,
    editor: useResourceLedgerEditStore() };
}

describe('资源独立功能嵌入，保留完整系统工作区', () => {
  it('状态管理默认收起；关闭仍保留导入输入和挂载，离页拒绝后重新展开提示', async () => {
    const s = await setup('ledger'); await vi.waitFor(() => expect(s.read.ledger).not.toBeNull());
    const disclosure = find(s.root, row => row.tag === 'details' && row.props.class === 'resource-status-controls')!;
    expect(disclosure.props.open).toBe(false);
    const panel = find(disclosure, row => row.props['aria-label'] === '设备状态快照')!;
    expect(panel).toBeDefined(); expect(textOf(s.root)).toContain('状态来源：台账基线');
    (disclosure.props.onToggle as Function)({ target: { open: true } }); await settle();
    const input = find(panel, row => row.props['aria-label'] === '状态导入 JSON')!;
    (input.props['onUpdate:modelValue'] as Function)('{"未提交":"必须保留"}'); await settle();
    await click(s.root, '关闭状态快照');
    expect(disclosure.props.open).toBe(false); expect(textOf(disclosure)).toContain('未保存导入');
    expect(find(disclosure, row => row.props['aria-label'] === '设备状态快照')).toBe(panel);
    expect(find(panel, row => row.props['aria-label'] === '状态导入 JSON')).toBe(input);
    await s.router.push('/resources?tab=spectrum-config'); await settle();
    expect(s.router.currentRoute.value.query.tab).toBe('ledger'); expect(disclosure.props.open).toBe(true);
    expect(input.value).toBe('{"未提交":"必须保留"}'); expect(textOf(panel)).toContain('未提交导入输入');
    await click(s.root, '放弃未提交导入输入'); await s.router.push('/resources?tab=spectrum-config'); await settle();
    expect(s.router.currentRoute.value.query.tab).toBe('spectrum-config'); expect(s.storage.writes).toBe(0);
  });
  it('收起状态浮层不清批次、模式或刷新方式，常显来源区分构造快照', async () => {
    const s = await setup('ledger'); await vi.waitFor(() => expect(s.read.ledger).not.toBeNull());
    const status = useResourceStatusStore();
    const header: DeviceStatusHeader = { schema_version: deviceStatusSchema, snapshot_id: 'DSS-LOCAL', snapshot_revision: 'DSR-LOCAL',
      content_hash: 'a'.repeat(64), resource_revision: s.read.workspace!.revision, resource_content_hash: 'a'.repeat(64), data_origin: 'SYNTHETIC_INTEGRATION',
      source_label: '组件构造状态批次', provenance_note: '构造数据，非遥测', imported_at: '2026-11-04T00:00:00Z', actor_id: 'test-actor', total: 0,
      counts: { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: 0, total: 0 }, first_observed_at: null, last_observed_at: null };
    status.batch = header; status.setMode('observed'); status.setRefreshMode('latest'); await settle();
    const disclosure = find(s.root, row => row.tag === 'details' && row.props.class === 'resource-status-controls')!;
    const directoryReads = vi.mocked(collaborationHttp.deviceStatuses.listSnapshots).mock.calls.length;
    (disclosure.props.onToggle as Function)({ target: { open: true } }); await settle(); await click(s.root, '关闭状态快照');
    expect(status.batch?.snapshot_id).toBe(header.snapshot_id); expect(status.mode).toBe('observed'); expect(status.refreshMode).toBe('latest');
    expect(textOf(find(s.root, row => row.props.class === 'resource-status-source')!)).toContain('构造状态快照 · 非真实遥测');
    expect(textOf(s.root)).toContain(header.source_label);
    expect(vi.mocked(collaborationHttp.deviceStatuses.listSnapshots)).toHaveBeenCalledTimes(directoryReads);
  });
  it.each([undefined, 'ledger'])('默认或ledger入口只呈现短波／超短波设备：%s', async tab => {
    const s = await setup(tab); await vi.waitFor(() => expect(s.read.ledger?.items.length).toBeGreaterThan(0));
    expect(textOf(find(s.root, row => row.tag === 'h1')!)).toBe('短波／超短波设备');
    expect(button(s.root, '新增设备')).toBeDefined(); expect(find(s.root, row => row.props['aria-label'] === '设备状态快照')).toBeDefined();
    for (const label of ['设备台账', '规划频点', '频谱接口配置', '频谱观测']) expect(button(s.root, label)).toBeUndefined();
    expect(s.sourceList).not.toHaveBeenCalled(); expect(s.frequencyContext).not.toHaveBeenCalled(); expect(s.observations).not.toHaveBeenCalled();
  });
  it('接口入口不加载台账，也不被无关资源刷新阻塞编辑；无跨观测选择或台账工具', async () => {
    const s = await setup('spectrum-config', true, true); await vi.waitFor(() => expect(textOf(s.root)).toContain('独立接口来源'));
    expect(textOf(find(s.root, row => row.tag === 'h1')!)).toBe('频谱接口管理');
    for (const label of ['选择', '新增设备', '刷新资源', '配置记录', '规划频点', '频谱观测']) expect(button(s.root, label)).toBeUndefined();
    expect(find(s.root, row => row.props['aria-label'] === '资源统计')).toBeUndefined();
    expect(button(s.root, '新增来源')?.props.disabled).toBe(false); await click(s.root, '新增来源');
    expect(find(s.root, row => row.props['aria-label'] === '采集源配置')).toBeDefined();
    expect(s.contexts).not.toHaveBeenCalled(); expect(s.devices).not.toHaveBeenCalled(); expect(s.stop).not.toHaveBeenCalled();
  });
  it.each([['frequencies', '规划频点'], ['spectrum-monitor', '频谱观测']] as const)('%s入口只挂载本功能且不查询设备台账', async (tab, title) => {
    const s = await setup(tab); await vi.waitFor(() => expect(tab === 'frequencies' ? s.frequencies : s.observations).toHaveBeenCalled());
    expect(textOf(find(s.root, row => row.tag === 'h1')!)).toBe(title);
    expect(button(s.root, '新增设备')).toBeUndefined(); expect(find(s.root, row => row.props['aria-label'] === '搜索采集源')).toBeUndefined();
    expect(s.contexts).not.toHaveBeenCalled(); expect(s.devices).not.toHaveBeenCalled(); expect(s.sourceList).not.toHaveBeenCalled();
    expect(tab === 'frequencies' ? s.observations : s.frequencies).not.toHaveBeenCalled();
  });
  it('接口草稿取消query切换保留输入，明确放弃后才激活台账；前后退按功能重新装配', async () => {
    const s = await setup('spectrum-config'); await click(s.root, '新增来源'); await fill(s.root, '名称', '必须保留的接口草稿');
    const canceled = s.router.push('/resources?tab=ledger'); await vi.waitFor(() => expect(textOf(s.root)).toContain('未保存配置'));
    await click(s.root, '继续编辑'); await canceled;
    expect(s.router.currentRoute.value.query.tab).toBe('spectrum-config'); expect(inputValue(s.root, '名称')).toBe('必须保留的接口草稿');
    expect(s.contexts).not.toHaveBeenCalled(); expect(s.devices).not.toHaveBeenCalled();
    const accepted = s.router.push('/resources?tab=ledger'); await vi.waitFor(() => expect(textOf(s.root)).toContain('未保存配置'));
    await click(s.root, '放弃草稿'); await accepted; await vi.waitFor(() => expect(s.read.ledger).not.toBeNull());
    expect(button(s.root, '新增设备')).toBeDefined(); expect(find(s.root, row => row.props['aria-label'] === '搜索采集源')).toBeUndefined();
    s.router.back(); await vi.waitFor(() => expect(s.router.currentRoute.value.query.tab).toBe('spectrum-config'));
    await vi.waitFor(() => expect(s.sourceList).toHaveBeenCalledTimes(2)); expect(s.stop).toHaveBeenCalled();
    expect(find(s.root, row => row.props['aria-label'] === '采集源配置')).toBeUndefined(); expect(button(s.root, '新增设备')).toBeUndefined();
    s.router.forward(); await vi.waitFor(() => expect(s.router.currentRoute.value.query.tab).toBe('ledger'));
    await vi.waitFor(() => expect(button(s.root, '新增设备')).toBeDefined());
  });
  it('台账草稿拒绝切换时不提前stop，放弃后停台账并只呈现接口模块', async () => {
    const s = await setup('ledger'); await vi.waitFor(() => expect(s.read.ledger).not.toBeNull()); await click(s.root, '新增设备');
    s.editor.form!.fields.stationId = 'ND-0001'; const count = s.stop.mock.calls.length;
    const canceled = s.router.push('/resources?tab=spectrum-config'); await vi.waitFor(() => expect(s.editor.decision).not.toBeNull());
    expect(s.stop).toHaveBeenCalledTimes(count); s.editor.answer('cancel'); await canceled;
    expect(s.editor.form!.fields.stationId).toBe('ND-0001'); expect(s.router.currentRoute.value.query.tab).toBe('ledger');
    const accepted = s.router.push('/resources?tab=spectrum-config'); await vi.waitFor(() => expect(s.editor.decision).not.toBeNull());
    s.editor.answer('discard'); await accepted; await vi.waitFor(() => expect(s.sourceList).toHaveBeenCalled());
    expect(s.stop.mock.calls.length).toBeGreaterThan(count); expect(s.editor.form).toBeNull(); expect(button(s.root, '新增设备')).toBeUndefined();
  });
  it('接口配置保存中拒绝query切换，明确拒绝后保留原草稿及错误', async () => {
    const s = await setup('spectrum-config'); await vi.waitFor(() => expect(textOf(s.root)).toContain('独立接口来源'));
    const edit = find(s.root, row => row.props['aria-label'] === '查看或编辑')!;
    await (edit.props.onClick as Function)(); await settle(); await fill(s.root, '名称', '保存中的接口草稿');
    let reject!: (reason: unknown) => void;
    s.sourceSave.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const drawer = find(s.root, row => row.props['aria-label'] === '采集源配置')!;
    const form = find(drawer, row => row.tag === 'form')!;
    const saving = (form.props.onSubmit as Function)({ preventDefault() {} });
    await vi.waitFor(() => expect(s.sourceSave).toHaveBeenCalledTimes(1)); await settle();
    await s.router.push('/resources?tab=ledger');
    expect(s.router.currentRoute.value.query.tab).toBe('spectrum-config'); expect(s.contexts).not.toHaveBeenCalled();
    expect(inputValue(s.root, '名称')).toBe('保存中的接口草稿');
    reject(new ApiError('构造配置校验拒绝', 1204)); await saving; await settle();
    expect(inputValue(s.root, '名称')).toBe('保存中的接口草稿'); expect(textOf(s.root)).toContain('构造配置校验拒绝');
  });
  it('完整系统仍保留四页签、台账加载与采集源的观测选择入口', async () => {
    const s = await setup('spectrum-config', false); await vi.waitFor(() => expect(textOf(s.root)).toContain('独立接口来源'));
    expect(textOf(find(s.root, row => row.tag === 'h1')!)).toBe('资源管理');
    for (const label of ['设备台账', '规划频点', '频谱接口配置', '频谱观测']) expect(button(s.root, label)).toBeDefined();
    expect(button(s.root, '选择')).toBeDefined(); await vi.waitFor(() => expect(s.devices).toHaveBeenCalled());
  });
  it('接口页读取权限保留，但撤去维护权限后不能新增配置', async () => {
    const s = await setup('spectrum-config'); s.auth.accept({ ...s.auth.identity!, permissions: ['resources.view'] }); await settle();
    expect(button(s.root, '新增来源')?.props.disabled).toBe(true); expect(s.sourceSave).not.toHaveBeenCalled();
    expect(s.devices).not.toHaveBeenCalled();
  });
});
