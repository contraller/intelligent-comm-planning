import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ResourcesView from '../src/views/ResourcesView.vue';
import SpectrumView from '../src/views/SpectrumView.vue';
import SpectrumObservationImportDialog from '../src/components/SpectrumObservationImportDialog.vue';
import { spectrumObservationPresets } from '../src/mocks/spectrum-observation-presets';
import type { ObservationDataset, ObservationImportFile } from '../src/types/observation';
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
vi.mock('../src/components/ChartCanvas.vue', () => ({ default: { render: () => null } }));

beforeAll(async () => {
  for (const [component, name] of [[ResourcesView, 'views/ResourcesView'], [SpectrumView, 'views/SpectrumView'], [SpectrumObservationImportDialog, 'components/SpectrumObservationImportDialog'], [SpectrumConfigPanel, 'components/SpectrumConfigPanel'],
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
    minKhz: spectrumObservationPresets[0].minKhz, maxKhz: spectrumObservationPresets[0].maxKhz, enabled: true, provenanceNote: '本地组件测试构造配置，非实测' } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function setup(tab?: string, embedded = true, holdLedger = false, options: { page?: 'resources' | 'spectrum'; contextRequest?: typeof httpService.loadResourceReadContext } = {}) {
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
  const getSource = vi.spyOn(collaborationHttp.spectrumSources, 'getSource').mockResolvedValue(structuredClone(sourceRow));
  const sourceSave = vi.spyOn(collaborationHttp.spectrumSources, 'saveSource').mockRejectedValue(new ApiError('测试禁止提交', 1204));
  vi.spyOn(collaborationHttp.deviceStatuses, 'listSnapshots').mockImplementation(async input => ({ schema_version: deviceStatusSchema,
    page: input.page ?? 1, page_size: input.page_size ?? 20, total: 0, items: [] }));
  const frequencyContext = vi.spyOn(httpService, 'loadResourceReadContext').mockImplementation(raw.loadResourceReadContext);
  const revision = 'resource-' + 'a'.repeat(16);
  frequencyContext.mockImplementation(options.contextRequest ?? (async input => ({ ...await raw.loadResourceReadContext(input), revision })));
  const frequencies = vi.spyOn(collaborationHttp.frequencies, 'queryFrequencyResources').mockResolvedValue({ revision, baseRevision: revision,
    contentHash: 'a'.repeat(64), dataOrigin: 'SYNTHETIC_INTEGRATION', source: '本地构造频点，非实测', items: [], page: 1, pageSize: 10, total: 0 });
  vi.spyOn(collaborationHttp.frequencies, 'queryFrequencyOperations').mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0 });
  let imported: ObservationImportFile | null = null;
  const hash = 'b'.repeat(64), datasetRevision = 'observation-' + hash;
  const dataset = (): ObservationDataset | null => imported ? { ...imported.dataset, schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION',
    datasetRevision, frameCount: imported.dataset.frames.length, firstObservedAt: imported.dataset.frames[0].observedAt,
    lastObservedAt: imported.dataset.frames.at(-1)!.observedAt, contentHash: hash, importedAt: '2026-11-04T08:00:00Z' } : null;
  const identity = () => ({ schemaVersion: 1 as const, dataOrigin: 'SYNTHETIC_INTEGRATION' as const, datasetId: imported!.dataset.datasetId,
    datasetRevision, resourceRevision: imported!.dataset.resourceRevision, sourceId: imported!.dataset.source.sourceId,
    configRevision: imported!.dataset.source.configRevision, frameCount: imported!.dataset.frames.length });
  const frame = (index: number) => ({ ...imported!.dataset.frames[index], datasetId: imported!.dataset.datasetId,
    datasetRevision, dataOrigin: 'SYNTHETIC_INTEGRATION' as const });
  const observations = vi.spyOn(collaborationHttp.observations, 'queryObservationDatasets').mockImplementation(async () => ({ schemaVersion: 1,
    dataOrigin: 'SYNTHETIC_INTEGRATION', page: 1, pageSize: 10, total: imported ? 1 : 0, items: imported ? [dataset()!] : [] }));
  const observationContext = vi.spyOn(collaborationHttp.observations, 'loadObservationContext').mockImplementation(async () => ({ schemaVersion: 1,
    dataOrigin: 'SYNTHETIC_INTEGRATION', datasetCount: imported ? 1 : 0, selected: dataset(), reasons: [],
    replay: { mode: 'FINITE', loop: false, maxFramesPerDataset: 256, maxBinsPerFrame: 256 } }));
  vi.spyOn(collaborationHttp.observations, 'queryObservationFrames').mockImplementation(async () => ({ ...identity(), page: 1, pageSize: 10,
    total: imported!.dataset.frames.length, items: imported!.dataset.frames.map((_item, index) => frame(index)) }));
  vi.spyOn(collaborationHttp.observations, 'getObservationFrame').mockImplementation(async input => ({ ...identity(), index: input.index,
    hasPrevious: input.index > 0, hasNext: input.index + 1 < imported!.dataset.frames.length, frame: frame(input.index) }));
  vi.spyOn(collaborationHttp.observations, 'getObservationDeviceStatusRef').mockImplementation(async () => ({ schemaVersion: 1,
    dataOrigin: 'SYNTHETIC_INTEGRATION', datasetId: imported!.dataset.datasetId, datasetRevision,
    resourceRevision: imported!.dataset.resourceRevision, deviceStatusRef: null }));
  const previewImport = vi.spyOn(collaborationHttp.observations, 'previewObservationImport').mockImplementation(async input => ({ schemaVersion: 1,
    dataOrigin: 'SYNTHETIC_INTEGRATION', previewHash: hash, datasetId: input.file.dataset.datasetId,
    resourceRevision: input.file.dataset.resourceRevision, source: input.file.dataset.source,
    frameCount: input.file.dataset.frames.length, sourceBinding: 'REGISTERED_VERSION', warnings: [] }));
  const importObservation = vi.spyOn(collaborationHttp.observations, 'importObservation').mockImplementation(async input => {
    imported = structuredClone(input.file); return { schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', requestId: input.requestId,
      operationType: 'OBSERVATION_IMPORT', status: 'COMMITTED', receipt: { requestId: input.requestId, actorId: 'test-actor',
        datasetId: imported.dataset.datasetId, datasetRevision, dataOrigin: 'SYNTHETIC_INTEGRATION', resourceRevision: imported.dataset.resourceRevision,
        frameCount: imported.dataset.frames.length, changed: true, importedAt: '2026-11-04T08:00:00Z' } };
  });
  const page = options.page ?? (tab && tab !== 'ledger' ? 'spectrum' : 'resources');
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/resources', component: ResourcesView }, { path: '/spectrum', component: SpectrumView }] });
  await router.push('/' + page + (tab ? '?tab=' + tab : '')); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() });
  if (embedded) app.provide('embeddedModule', true);
  const root = node('root'); app.mount(root); await settle();
  return { root, router, auth, storage, read, stop, contexts, devices, sourceList, getSource, sourceSave, frequencyContext, frequencies, observations,
    observationContext, previewImport, importObservation, dataset,
    editor: useResourceLedgerEditStore() };
}

describe('资源与频谱分离后的真实组件装配', () => {
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
    await s.router.push('/spectrum?tab=spectrum-config'); await settle();
    expect(s.router.currentRoute.value.query.tab).toBe('ledger'); expect(disclosure.props.open).toBe(true);
    expect(input.value).toBe('{"未提交":"必须保留"}'); expect(textOf(panel)).toContain('未提交导入输入');
    await click(s.root, '放弃未提交导入输入'); await s.router.push('/spectrum?tab=spectrum-config'); await settle();
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
  it('频谱入口不加载台账，保留三页签和来源选择，资源刷新不阻塞配置编辑', async () => {
    const s = await setup('spectrum-config', true, true); await vi.waitFor(() => expect(textOf(s.root)).toContain('独立接口来源'));
    expect(textOf(find(s.root, row => row.tag === 'h1')!)).toBe('频谱接口');
    for (const label of ['新增设备', '刷新资源', '配置记录', '设备台账']) expect(button(s.root, label)).toBeUndefined();
    expect(find(s.root, row => row.props['aria-label'] === '资源统计')).toBeUndefined();
    for (const label of ['规划频点', '频谱接口配置', '频谱观测', '选择']) expect(button(s.root, label)).toBeDefined();
    expect(button(s.root, '新增来源')?.props.disabled).toBe(false); await click(s.root, '新增来源');
    expect(find(s.root, row => row.props['aria-label'] === '采集源配置')).toBeDefined();
    expect(s.contexts).not.toHaveBeenCalled(); expect(s.devices).not.toHaveBeenCalled(); expect(s.stop).not.toHaveBeenCalled();
  });
  it.each([['frequencies', '规划频点'], ['spectrum-monitor', '频谱观测']] as const)('%s入口只挂载本功能且不查询设备台账', async (tab, title) => {
    const s = await setup(tab); await vi.waitFor(() => expect(tab === 'frequencies' ? s.frequencies : s.observations).toHaveBeenCalled());
    expect(textOf(find(s.root, row => row.tag === 'h1')!)).toBe('频谱接口');
    expect(button(s.root, title)).toBeDefined();
    expect(button(s.root, '新增设备')).toBeUndefined(); expect(find(s.root, row => row.props['aria-label'] === '搜索采集源')).toBeUndefined();
    expect(s.contexts).not.toHaveBeenCalled(); expect(s.devices).not.toHaveBeenCalled(); expect(s.sourceList).not.toHaveBeenCalled();
    expect(tab === 'frequencies' ? s.observations : s.frequencies).not.toHaveBeenCalled();
  });
  it('接口草稿取消跨页离开保留输入，明确放弃后才激活台账；前后退按功能重新装配', async () => {
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
    const canceled = s.router.push('/spectrum?tab=spectrum-config'); await vi.waitFor(() => expect(s.editor.decision).not.toBeNull());
    expect(s.stop).toHaveBeenCalledTimes(count); s.editor.answer('cancel'); await canceled;
    expect(s.editor.form!.fields.stationId).toBe('ND-0001'); expect(s.router.currentRoute.value.query.tab).toBe('ledger');
    const accepted = s.router.push('/spectrum?tab=spectrum-config'); await vi.waitFor(() => expect(s.editor.decision).not.toBeNull());
    s.editor.answer('discard'); await accepted; await vi.waitFor(() => expect(s.sourceList).toHaveBeenCalled());
    expect(s.stop.mock.calls.length).toBeGreaterThan(count); expect(s.editor.form).toBeNull(); expect(button(s.root, '新增设备')).toBeUndefined();
  });
  it('接口配置保存中拒绝跨页离开，明确拒绝后保留原草稿及错误', async () => {
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
  it('完整资源页只保留台账和设备工具，频谱不再混入资源工作区', async () => {
    const s = await setup(undefined, false); await vi.waitFor(() => expect(s.devices).toHaveBeenCalled());
    expect(textOf(find(s.root, row => row.tag === 'h1')!)).toBe('资源管理'); expect(button(s.root, '新增设备')).toBeDefined();
    for (const label of ['设备台账', '规划频点', '频谱接口配置', '频谱观测']) expect(button(s.root, label)).toBeUndefined();
    expect(s.sourceList).not.toHaveBeenCalled(); expect(s.frequencyContext).not.toHaveBeenCalled();
  });
  it('完整频谱页也并列保留三个页签和来源选择，完全不查询设备台账', async () => {
    const s = await setup('spectrum-config', false); await vi.waitFor(() => expect(textOf(s.root)).toContain('独立接口来源'));
    expect(textOf(find(s.root, row => row.tag === 'h1')!)).toBe('频谱接口');
    for (const label of ['规划频点', '频谱接口配置', '频谱观测', '选择']) expect(button(s.root, label)).toBeDefined();
    expect(button(s.root, '设备台账')).toBeUndefined(); expect(s.contexts).not.toHaveBeenCalled(); expect(s.devices).not.toHaveBeenCalled();
  });
  it('接口页读取权限保留，但撤去维护权限后不能新增配置', async () => {
    const s = await setup('spectrum-config'); s.auth.accept({ ...s.auth.identity!, permissions: ['resources.view'] }); await settle();
    expect(button(s.root, '新增来源')?.props.disabled).toBe(true); expect(s.sourceSave).not.toHaveBeenCalled();
    expect(s.devices).not.toHaveBeenCalled();
  });
  it('同页query切换取消保留接口草稿，放弃后只切频谱功能且保留已访问组件', async () => {
    const s = await setup('spectrum-config'); await click(s.root, '新增来源'); await fill(s.root, '名称', '页签未保存输入');
    const canceled = s.router.push('/spectrum?tab=frequencies'); await vi.waitFor(() => expect(textOf(s.root)).toContain('未保存配置'));
    await click(s.root, '继续编辑'); await canceled; expect(s.router.currentRoute.value.query.tab).toBe('spectrum-config');
    expect(inputValue(s.root, '名称')).toBe('页签未保存输入'); expect(s.frequencies).not.toHaveBeenCalled();
    const accepted = s.router.push('/spectrum?tab=frequencies'); await vi.waitFor(() => expect(textOf(s.root)).toContain('未保存配置'));
    await click(s.root, '放弃草稿'); await accepted; await vi.waitFor(() => expect(s.frequencies).toHaveBeenCalled());
    const sourcePanel = find(s.root, row => row.props['aria-label'] === '搜索采集源'); expect(sourcePanel).toBeDefined();
    await click(s.root, '频谱观测'); await vi.waitFor(() => expect(s.observations).toHaveBeenCalled());
    await click(s.root, '频谱接口配置'); expect(find(s.root, row => row.props['aria-label'] === '搜索采集源')).toBe(sourcePanel);
    await vi.waitFor(() => expect(s.sourceList).toHaveBeenCalledTimes(2)); expect(s.devices).not.toHaveBeenCalled(); expect(s.contexts).not.toHaveBeenCalled();
  });
  it('嵌入来源选择到显式导入与观测集联动：进入已访问监测页不能中断刚触发的目标读取', async () => {
    const s = await setup('spectrum-config'); await click(s.root, '频谱观测'); await vi.waitFor(() => expect(s.observations).toHaveBeenCalled());
    await click(s.root, '频谱接口配置'); expect(s.read.workspace).toBeNull(); await click(s.root, '选择');
    expect(s.frequencyContext).toHaveBeenCalledWith(expect.objectContaining({ context: 'ledger' }));
    expect(inputValue(s.root, '资源来源版本')).toBe('resource-' + 'a'.repeat(16));
    await fill(s.root, '观测集编号', 'obs-embedded-import'); await click(s.root, '使用此构造示例');
    await click(s.root, '预检'); expect(s.previewImport).toHaveBeenCalledTimes(1); expect(s.importObservation).not.toHaveBeenCalled();
    const held = deferred<Awaited<ReturnType<typeof collaborationHttp.observations.loadObservationContext>>>();
    s.observationContext.mockReturnValueOnce(held.promise); await click(s.root, '确认导入');
    await vi.waitFor(() => expect(s.observationContext).toHaveBeenCalledTimes(1));
    const selection = s.observationContext.mock.lastCall![0]!, signal = selection.signal!;
    expect(selection.datasetId).toBe('obs-embedded-import'); expect(signal.aborted).toBe(false);
    await click(s.root, '关闭'); await click(s.root, '频谱观测'); expect(signal.aborted).toBe(false);
    held.resolve({ schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', datasetCount: 1, selected: s.dataset(), reasons: [],
      replay: { mode: 'FINITE', loop: false, maxFramesPerDataset: 256, maxBinsPerFrame: 256 } });
    await vi.waitFor(() => expect(collaborationHttp.observations.getObservationFrame).toHaveBeenCalled());
    expect(collaborationHttp.observations.getObservationFrame).toHaveBeenCalledWith(expect.objectContaining({
      datasetId: 'obs-embedded-import', datasetRevision: 'observation-' + 'b'.repeat(64), index: 0,
    }));
    await vi.waitFor(() => expect(textOf(s.root)).toContain('历史观测版本observation-' + 'b'.repeat(64)));
    expect(textOf(s.root)).toContain(spectrumObservationPresets[0].frames[0].label);
    const directory = find(s.root, row => row.tag === 'table' && row.props['aria-label'] === '观测集')!;
    expect(textOf(directory)).toContain('obs-embedded-import'); expect(textOf(directory)).not.toContain('暂无已导入观测');
    expect(s.importObservation).toHaveBeenCalledTimes(1); expect(s.contexts).not.toHaveBeenCalled(); expect(s.devices).not.toHaveBeenCalled();
  });
  it('旧会话迟到资源上下文不能替换新会话版本或打开导入', async () => {
    const held = deferred<Awaited<ReturnType<typeof httpService.loadResourceReadContext>>>();
    const s = await setup('spectrum-config', true, false, { contextRequest: () => held.promise });
    const initialSignal = s.frequencyContext.mock.calls[0][0]!.signal!, revision = 'resource-' + 'c'.repeat(16);
    s.frequencyContext.mockResolvedValue({ revision } as Awaited<ReturnType<typeof httpService.loadResourceReadContext>>);
    s.auth.accept({ ...s.auth.identity!, sessionId: 'new-spectrum-session' }); await settle();
    await vi.waitFor(() => expect(s.frequencyContext.mock.calls.length).toBeGreaterThan(1)); expect(initialSignal.aborted).toBe(true);
    held.resolve({ revision: 'resource-' + 'd'.repeat(16) } as Awaited<ReturnType<typeof httpService.loadResourceReadContext>>); await settle();
    await click(s.root, '选择'); expect(inputValue(s.root, '资源来源版本')).toBe(revision);
    expect(s.previewImport).not.toHaveBeenCalled(); expect(s.importObservation).not.toHaveBeenCalled(); expect(s.devices).not.toHaveBeenCalled();
  });
  it('来源选择读取未结束时身份变化，旧返回不能打开新会话导入', async () => {
    const s = await setup('spectrum-config'), held = deferred<SpectrumSourceRow>(); s.getSource.mockReturnValueOnce(held.promise);
    const selecting = (button(s.root, '选择')!.props.onClick as Function)(); await settle();
    s.auth.accept({ ...s.auth.identity!, id: 'new-reader', sessionId: 'new-reader-session' }); await settle();
    held.resolve(structuredClone(sourceRow)); await selecting; await settle();
    expect(find(s.root, row => row.props['aria-label'] === '显式导入观测')).toBeUndefined();
    expect(s.previewImport).not.toHaveBeenCalled(); expect(s.importObservation).not.toHaveBeenCalled();
  });
  it('冷启动元数据失败不借旧台账版本导入；重试成功后才使用新版本', async () => {
    const s = await setup('spectrum-config', true, false, { contextRequest: async () => { throw new Error('资源元数据暂不可用'); } });
    await vi.waitFor(() => expect(textOf(s.root)).toContain('资源元数据暂不可用')); await click(s.root, '选择');
    expect(find(s.root, row => row.props['aria-label'] === '显式导入观测')).toBeUndefined();
    expect(s.importObservation).not.toHaveBeenCalled(); expect(s.read.workspace).toBeNull(); expect(s.devices).not.toHaveBeenCalled();
    const revision = 'resource-' + 'e'.repeat(16);
    s.frequencyContext.mockResolvedValue({ revision } as Awaited<ReturnType<typeof httpService.loadResourceReadContext>>);
    await click(s.root, '重新读取资源版本'); await click(s.root, '选择'); expect(inputValue(s.root, '资源来源版本')).toBe(revision);
    expect(s.previewImport).not.toHaveBeenCalled(); expect(s.contexts).not.toHaveBeenCalled();
  });
  it('只读来源查询可切走：clean配置弹层关闭，迟到查询丢弃，返回时恢复目录读取', async () => {
    const s = await setup('spectrum-config'); await vi.waitFor(() => expect(textOf(s.root)).toContain('独立接口来源'));
    await (find(s.root, row => row.props['aria-label'] === '查看或编辑')!.props.onClick as Function)(); await settle();
    expect(find(s.root, row => row.props['aria-label'] === '采集源配置')).toBeDefined();
    const held = deferred<Awaited<ReturnType<typeof collaborationHttp.spectrumSources.querySources>>>();
    s.sourceList.mockReturnValueOnce(held.promise);
    const loading = (find(s.root, row => row.props['aria-label'] === '刷新')!.props.onClick as Function)(); await settle();
    const request = s.sourceList.mock.lastCall![0], signal = request.signal!;
    await click(s.root, '频谱观测'); expect(signal.aborted).toBe(true);
    expect(find(s.root, row => row.props['aria-label'] === '采集源配置')).toBeUndefined();
    held.resolve({ schemaVersion: 1, dataOrigin: 'SYNTHETIC_INTEGRATION', page: 1, pageSize: 20, total: 1,
      items: [{ ...structuredClone(sourceRow), draft: { ...sourceRow.draft, name: '迟到旧目录' } }] }); await loading; await settle();
    expect(textOf(s.root)).not.toContain('迟到旧目录'); await click(s.root, '频谱接口配置');
    await vi.waitFor(() => expect(s.sourceList).toHaveBeenCalledTimes(3)); expect(textOf(s.root)).toContain('独立接口来源');
    expect(find(s.root, row => row.props['aria-label'] === '采集源配置')).toBeUndefined(); expect(s.sourceSave).not.toHaveBeenCalled();
  });
  it('监测导入取消切换保留输入，明确放弃后关闭浮层，返回不会复活未提交文件', async () => {
    const s = await setup('spectrum-monitor'); await click(s.root, '显式导入');
    await vi.waitFor(() => expect(inputValue(s.root, '资源来源版本')).toBe('resource-' + 'a'.repeat(16)));
    await fill(s.root, '观测集编号', 'obs-unsaved'); await click(s.root, '使用此构造示例');
    const canceled = s.router.push('/spectrum?tab=frequencies'); await vi.waitFor(() => expect(button(s.root, '继续导入')).toBeDefined());
    await click(s.root, '继续导入'); await canceled; expect(s.router.currentRoute.value.query.tab).toBe('spectrum-monitor');
    expect(inputValue(s.root, '观测集编号')).toBe('obs-unsaved'); expect(s.frequencies).not.toHaveBeenCalled();
    const accepted = s.router.push('/spectrum?tab=frequencies'); await vi.waitFor(() => expect(button(s.root, '放弃输入')).toBeDefined());
    await click(s.root, '放弃输入'); await accepted; await vi.waitFor(() => expect(s.frequencies).toHaveBeenCalled());
    expect(find(s.root, row => row.props['aria-label'] === '显式导入观测')).toBeUndefined();
    const reads = s.observations.mock.calls.length;
    await click(s.root, '频谱观测'); await vi.waitFor(() => expect(s.observations).toHaveBeenCalledTimes(reads + 1));
    expect(find(s.root, row => row.props['aria-label'] === '显式导入观测')).toBeUndefined();
    await click(s.root, '显式导入'); expect(button(s.root, '预检')?.props.disabled).toBe(true);
    expect(s.previewImport).not.toHaveBeenCalled(); expect(s.importObservation).not.toHaveBeenCalled();
  });

});
