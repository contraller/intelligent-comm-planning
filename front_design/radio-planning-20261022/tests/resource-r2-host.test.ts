import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ResourcesView from '../src/views/ResourcesView.vue';
import ConfigurationDrawer from '../src/components/DeviceConfigurationDrawer.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useResourceLedgerEditStore } from '../src/stores/resource-ledger-edit';
import { useResourceStatusStore } from '../src/stores/resource-status';
import { useDeviceConfigurationAcceptanceStore } from '../src/stores/device-configuration-acceptance';
import { useFrequencyResourceStore } from '../src/stores/frequency-resource';
import { allPermissions, type Permission } from '../src/config/permissions';
import type { ConfigurationAcceptanceContext } from '../src/services/device-configuration-decode';
import type { RestoreProposal } from '../src/types/device-trace';
import type { DeviceStatusHeader } from '../src/types/device-status-snapshot';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';

const transport = vi.hoisted(() => ({
  context: vi.fn(), frequencies: {}, deviceStatuses: {}, deviceTraces: {}, observations: {},
  spectrumSources: { getSource: vi.fn() },
  deviceConfigurations: { loadContext: vi.fn(), queryHistory: vi.fn(), getRequest: vi.fn(), validateRequest: vi.fn(), submitRequest: vi.fn() },
}));
const panels = vi.hoisted(() => ({
  spectrumLeave: vi.fn(async () => true), spectrumClear: vi.fn(), spectrumStop: vi.fn(),
  statusLeave: vi.fn(async () => true), frequencyLeave: vi.fn(async () => true),
  monitorLeave: vi.fn(async () => true), monitorClear: vi.fn(), monitorStop: vi.fn(),
  importLeave: vi.fn(async () => true), importClear: vi.fn(),
}));
vi.mock('../src/services/http', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/http')>();
  return { ...actual, collaborationHttp: transport, httpService: { ...actual.httpService, loadResourceReadContext: transport.context } };
});
vi.mock('../src/components/FrequencyResourcePanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['active', 'session', 'services', 'loadContext'], emits: ['resourceChanged', 'busyChange', 'pendingOperationChange'],
    setup(props, { emit, expose }) {
      expose({ requestLeave: panels.frequencyLeave, stopReading: vi.fn() });
      return () => h('frequency-probe', { ...props, onChanged: (value: unknown) => emit('resourceChanged', value) });
    } }) };
});
vi.mock('../src/components/SpectrumConfigPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['services', 'canView', 'canEdit', 'sessionGeneration'], emits: ['dirty-change', 'busy-change', 'select-source'],
    setup(props, { emit, expose }) {
      expose({ requestLeave: panels.spectrumLeave, clearForSession: panels.spectrumClear, stop: panels.spectrumStop });
      return () => h('spectrum-probe', { ...props, onDirty: (value: boolean) => emit('dirty-change', value), onSource: (value: unknown) => emit('select-source', value) });
    } }) };
});
vi.mock('../src/components/ResourceStatusPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['services', 'resourceRevision', 'enabled', 'allowImport'], emits: ['snapshot-selected', 'dirty', 'busy'],
    setup(props, { emit, expose }) {
      expose({ requestLeave: panels.statusLeave });
      return () => h('status-probe', { ...props, onSnapshot: (value: unknown) => emit('snapshot-selected', value), onDirty: (value: boolean) => emit('dirty', value) });
    } }) };
});
vi.mock('../src/components/SpectrumMonitoringPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['services', 'canView', 'canImport', 'sessionGeneration', 'initialSelection'], emits: ['dirty-change', 'busy-change'],
    setup(props, { expose }) {
      expose({ requestLeave: panels.monitorLeave, clearForSession: panels.monitorClear, stop: panels.monitorStop });
      return () => h('monitor-probe', { ...props });
    } }) };
});
vi.mock('../src/components/SpectrumObservationImportDialog.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'services', 'resourceRevision', 'sourceSelection', 'canImport', 'sessionGeneration'], emits: ['update:visible', 'dirty-change', 'busy-change', 'committed'],
    setup(props, { expose, emit }) {
      expose({ requestLeave: panels.importLeave, clearForSession: panels.importClear });
      return () => h('observation-import-probe', { ...props, onCommitted: (value: unknown) => emit('committed', value) });
    } }) };
});
vi.mock('../src/components/DeviceInfoPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['device', 'traceServices', 'statusSnapshotRef', 'statusDisplay', 'configuration', 'maintenanceBinding'], emits: ['configure', 'restore-candidate'],
    setup(props, { emit, slots }) {
      return () => h('device-probe', { ...props, onConfigure: (history: boolean) => emit('configure', history), onRestoreProposal: (value: unknown) => emit('restore-candidate', value) }, slots.actions?.());
    } }) };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'title'], setup: (props, { slots }) => () => props.visible ? h('drawer-probe', { ...props }, slots.default?.()) : null }) };
});
vi.mock('../src/components/AppTable.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['rows', 'total'], emits: ['select'], setup: (props, { emit }) => () => h('table-probe', {
    ...props, onSelectDevice: (id: string) => emit('select', { id }),
  }) }) };
});
vi.mock('../src/components/ResourceLedgerEditDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerImportDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DevicePortsEditDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerExportDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceReadStatus.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerTree.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerFilters.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));

await clientTemplate(ResourcesView, 'src/views/ResourcesView.vue', 'resource-r2-host-render.ts');
await clientTemplate(ConfigurationDrawer, 'src/components/DeviceConfigurationDrawer.vue', 'resource-r2-configuration-render.ts');
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
async function settle() { for (let i = 0; i < 20; i++) await nextTick(); }
const probe = (root: HostNode, tag: string) => {
  const found = find(root, value => value.tag === tag); expect(found, tag).toBeDefined(); return found!;
};
async function invoke(root: HostNode, tag: string, event: string, ...args: unknown[]) {
  await (probe(root, tag).props[event] as (...values: unknown[]) => unknown)(...args); await settle();
}
async function click(root: HostNode, label: string) {
  const button = find(root, value => value.tag === 'button' && textOf(value).trim() === label);
  expect(button, label).toBeDefined(); await (button!.props.onClick as () => unknown)(); await settle();
}
function context(deviceId: string, revision: string): ConfigurationAcceptanceContext {
  return { schema_version: 'device-configuration-a1', context: 'ledger', resource_revision: revision, resource_content_hash: 'a'.repeat(64),
    device: { device_id: deviceId, node_id: 'N1', model_id: 'M1', availability: 'ACTIVE', source_values: { tx_power_dbm: 20, work_freq_khz: 3000 } },
    model: { model_id: 'M1', freq_min_khz: 2000, freq_max_khz: 30000, tx_power_max_dbm: 50 },
    provenance: { data_origin: 'SYNTHETIC_INTEGRATION', resource_source: '构造资料', source_files: {} },
    protocol: { port_options: null, mode_options: null, confirmation: '待确认' } };
}
beforeEach(() => {
  vi.clearAllMocks();
  panels.spectrumLeave.mockResolvedValue(true); panels.statusLeave.mockResolvedValue(true);
  panels.frequencyLeave.mockResolvedValue(true); panels.importLeave.mockResolvedValue(true); panels.monitorLeave.mockResolvedValue(true);
});
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mountHost() {
  const pendingStorage = new TestStorage();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: pendingStorage })); vi.stubGlobal('localStorage', pendingStorage);
  class HostDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', HostDocument); vi.stubGlobal('document', new HostDocument());
  pinia = createPinia(); setActivePinia(pinia);
  const auth = authorizeStore();
  auth.accept({ ...auth.identity!, permissions: [...allPermissions.filter(permission => permission !== 'resources.edit'), 'resources.frequency.maintain', 'resources.spectrum.edit', 'resources.device.status.import', 'situation.observation.import'] as Permission[] });
  const storage = new TestStorage(), raw = createMockService(() => storage);
  for (const key of ['loadPreview', 'loadResourceReadContext', 'queryResourceDevices', 'getResourceObject', 'loadResourceMaintenanceContext', 'saveResourceChanges'] as const)
    vi.spyOn(previewService, key).mockImplementation(raw[key] as never);
  const preview = usePreviewStore(); await preview.load();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/resources', component: ResourcesView }, { path: '/other', component: { render: () => null } }] });
  await router.push('/resources'); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  const root = node('root'); app.mount(root); await settle();
  await vi.waitFor(() => expect(useResourceReadStore().workspace).not.toBeNull(), { interval: 5 }); await settle();
  const read = useResourceReadStore(), editor = useResourceLedgerEditStore(), configuration = useDeviceConfigurationAcceptanceStore();
  transport.deviceConfigurations.loadContext.mockImplementation(async (input: { device_id: string; revision: string }) => context(input.device_id, input.revision));
  transport.deviceConfigurations.queryHistory.mockResolvedValue({ schema_version: 'device-configuration-a1', context: 'ledger', items: [], page: 1, page_size: 20, total: 0 });
  return { root, auth, router, read, editor, configuration, raw };
}

describe('R2 resource host', () => {
  it('binds frequency permissions to the authenticated principal and reloads current resources after a receipt', async () => {
    const { root, auth, read } = await mountHost(); await click(root, '规划频点');
    const panel = probe(root, 'frequency-probe');
    expect(panel.props.services).toBe(transport.frequencies);
    expect(panel.props.session).toMatchObject({ accountId: auth.identity!.id, generation: auth.generation, canDisable: true, canMaintain: true });
    const live = { revision: 'current-server-version' }; transport.context.mockResolvedValue(live);
    const signal = new AbortController().signal;
    expect(await (panel.props.loadContext as (signal: AbortSignal) => Promise<unknown>)(signal)).toBe(live);
    expect(transport.context).toHaveBeenCalledWith({ context: 'ledger', signal });
    const revision = read.workspace!.revision, refresh = vi.spyOn(read, 'refresh');
    await invoke(root, 'frequency-probe', 'onChanged', { changed: true, previousRevision: 'old-base', revision: 'historical-receipt', readRevision: 'old-read', requestId: 'old-id' });
    expect(refresh).toHaveBeenCalledOnce(); expect(read.workspace!.revision).toBe(revision);
  });
  it('queries and selects configuration history without a selected device, and reports failures', async () => {
    const { root, auth } = await mountHost();
    await click(root, '配置记录');
    expect(transport.deviceConfigurations.queryHistory).toHaveBeenCalledWith({ context: 'ledger', page: 1, page_size: 20 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    transport.deviceConfigurations.queryHistory.mockResolvedValueOnce({ schema_version: 'device-configuration-a1', context: 'ledger', items: [{ request_id: 'history-1', device_id: 'D-old', base_revision: 'old', accepted_at: '2026-10-23' }], total: 1, page: 1, page_size: 20 });
    await click(root, '刷新历史');
    transport.deviceConfigurations.getRequest.mockResolvedValueOnce({ request_id: 'history-1', device_id: 'D-old', model_id: 'M-old', base_revision: 'old', requested_values: { tx_power_dbm: 18, work_freq_khz: 2500 }, actor: { account_id: auth.identity!.id }, message: '系统受理；未下发' });
    await click(root, 'history-1'); expect(textOf(root)).toContain('系统受理；未下发');
    transport.deviceConfigurations.queryHistory.mockRejectedValueOnce(new Error('history unavailable'));
    await click(root, '刷新历史'); expect(textOf(root)).toContain('history unavailable');
  });
  it('opens the acceptance drawer with real services and preserves dirty input across tabs, routes and logout', async () => {
    const { root, read, configuration, router, auth } = await mountHost();
    const id = read.ledger!.items[0]!.id; await invoke(root, 'table-probe', 'onSelectDevice', id);
    expect(probe(root, 'device-probe').props.traceServices).toBe(transport.deviceTraces);
    expect(probe(root, 'device-probe').props.maintenanceBinding).toMatchObject({ editable: true });
    await invoke(root, 'device-probe', 'onConfigure', false);
    expect(transport.deviceConfigurations.loadContext).toHaveBeenCalledWith({ context: 'ledger', device_id: id, revision: read.workspace!.revision }, expect.anything());
    configuration.power = '21'; await settle();
    await click(root, '规划频点'); expect(find(root, value => value.tag === 'frequency-probe')).toBeUndefined();
    await router.push('/other'); expect(router.currentRoute.value.path).toBe('/resources');
    expect(await auth.leaveSession()).toBe(false); expect(configuration.power).toBe('21');
    const unload = new Event('beforeunload', { cancelable: true }); Object.defineProperty(unload, 'returnValue', { writable: true, value: '' });
    window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
  });
  it('preserves pending configuration after stop/close and reopens the original request for verification', async () => {
    const { root, read, configuration } = await mountHost();
    const id = read.ledger!.items[0]!.id; await invoke(root, 'table-probe', 'onSelectDevice', id); await invoke(root, 'device-probe', 'onConfigure', false);
    configuration.pending = { schema_version: 'device-configuration-a1', context: 'ledger', request_id: 'pending-1', device_id: id, model_id: 'M1', base_revision: read.workspace!.revision, values: { tx_power_dbm: 20, work_freq_khz: 3000 } };
    configuration.cancel(); await settle(); await click(root, '保留原号并关闭');
    expect(configuration.pending?.request_id).toBe('pending-1'); expect(configuration.visible).toBe(false);
    await click(root, '配置记录'); expect(configuration.visible).toBe(true); expect(configuration.pending?.request_id).toBe('pending-1');
  });
  it('uses registered spectrum leave checks and keeps the panel mounted when leaving is denied', async () => {
    const { root, router, auth } = await mountHost(); await click(root, '频谱接口配置');
    expect(probe(root, 'spectrum-probe').props).toMatchObject({ services: transport.spectrumSources, canView: true, canEdit: true });
    panels.spectrumLeave.mockResolvedValue(false); await invoke(root, 'spectrum-probe', 'onDirty', true);
    await click(root, '设备台账'); expect(panels.spectrumLeave).toHaveBeenCalled(); expect(panels.spectrumClear).not.toHaveBeenCalled();
    await router.push('/other'); expect(router.currentRoute.value.path).toBe('/resources'); expect(await auth.leaveSession()).toBe(false);
    expect(auth.hasUnsaved()).toBe(true);
    panels.spectrumLeave.mockResolvedValue(true); await invoke(root, 'spectrum-probe', 'onDirty', false); await click(root, '设备台账');
    expect(probe(root, 'spectrum-probe')).toBeDefined();
  });
  it('passes a selected source version to observation import and retains its imported dataset identity', async () => {
    const { root } = await mountHost(); await click(root, '频谱接口配置');
    transport.spectrumSources.getSource.mockResolvedValueOnce({ sourceId: 'SRC1', configRevision: 'v1', draft: { name: '构造来源', minKhz: 2000, maxKhz: 3000, intervalSeconds: null } });
    await invoke(root, 'spectrum-probe', 'onSource', { sourceId: 'SRC1', configRevision: 'v1' });
    expect(transport.spectrumSources.getSource).toHaveBeenCalledWith({ sourceId: 'SRC1', configRevision: 'v1', signal: expect.any(AbortSignal) });
    expect(probe(root, 'observation-import-probe').props).toMatchObject({ visible: true, services: transport.observations, sourceSelection: { sourceId: 'SRC1', configRevision: 'v1', minKhz: 2000, maxKhz: 3000 } });
    await invoke(root, 'observation-import-probe', 'onCommitted', { datasetId: 'OBS1', datasetRevision: 'obs-v1' });
    await click(root, '频谱观测'); expect(probe(root, 'monitor-probe').props).toMatchObject({ services: transport.observations, initialSelection: { datasetId: 'OBS1', datasetRevision: 'obs-v1' } });
  });
  it('keeps observed filtering at the service boundary and captures only same-revision snapshot references', async () => {
    const { root, read } = await mountHost();
    expect(probe(root, 'status-probe').props).toMatchObject({ services: transport.deviceStatuses, allowImport: true });
    const deviceId = read.ledger!.items[0]!.id; await invoke(root, 'table-probe', 'onSelectDevice', deviceId);
    const status = useResourceStatusStore(), revision = read.workspace!.revision;
    status.batch = { snapshot_id: 'SS1', snapshot_revision: 'sv1', resource_revision: revision } as DeviceStatusHeader;
    status.mode = 'observed';
    await invoke(root, 'status-probe', 'onSnapshot', { snapshot_id: 'SS1', snapshot_revision: 'sv1', resource_revision: revision });
    expect(probe(root, 'device-probe').props.statusSnapshotRef).toEqual({ snapshotId: 'SS1', snapshotRevision: 'sv1', resourceRevision: revision, deviceId });
    await invoke(root, 'status-probe', 'onSnapshot', { snapshot_id: 'SS1', snapshot_revision: 'sv1', resource_revision: 'wrong-resource' });
    expect(probe(root, 'device-probe').props.statusSnapshotRef).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 280)); await settle();
    expect(read.ledgerQuery).toMatchObject({ statusMode: 'observed', observationSnapshotId: 'SS1' });
    expect(previewService.queryResourceDevices).toHaveBeenLastCalledWith(expect.objectContaining({ statusMode: 'observed', observationSnapshotId: 'SS1' }));
    // 拒绝来自服务，页面不退回基线查询，也不在当前页筛选。
    expect(status.mode).toBe('observed');
    const rows = probe(root, 'table-probe').props.rows as { statusDisplay: { mode: string; status: unknown } }[];
    expect(rows[0]!.statusDisplay).toMatchObject({ mode: 'observed', status: null });
  });
  it('loads only three restore parameters into the existing P01 form and saves through its original path', async () => {
    const { root, read, editor } = await mountHost();
    const device = read.ledger!.items[0]!; await invoke(root, 'table-probe', 'onSelectDevice', device.id);
    const candidate: RestoreProposal = { schema_version: 'device-trace-a1', device_id: device.id, model_id: device.modelId, base_revision: read.workspace!.revision,
      source_revision: 'old', source_request_id: null, compatible: true, changes: [], patch: { tx_power_dbm: 15, work_freq_khz: 2600, antenna_height_m: 12 }, blocked_fields: [], warnings: [] };
    await invoke(root, 'device-probe', 'onRestoreProposal', candidate);
    expect(editor.form?.fields).toMatchObject({ txPowerDbm: '15', workFreqKhz: '2600', antennaHeightM: '12' });
    expect(editor.form?.fields.ports).toBe(editor.form?.initial.ports); expect(editor.form?.fields.currentWorkMode).toBe(editor.form?.initial.currentWorkMode);
    const save = vi.spyOn(previewService, 'saveResourceChanges'); await editor.save(); expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0].devices[0]).toMatchObject({ id: device.id, txPowerDbm: 15, workFreqKhz: 2600, antennaHeightM: 12 });
  });
  it('blocks departure with an unverified frequency write even if panel reads were stopped', async () => {
    const { root, router } = await mountHost(); await click(root, '规划频点');
    const frequency = useFrequencyResourceStore(); frequency.pending = { context: 'ledger', requestId: 'unknown-write', baseRevision: 'old', ids: ['F1'] };
    frequency.stopReading(); await click(root, '设备台账'); await router.push('/other');
    expect(router.currentRoute.value.path).toBe('/resources'); expect(frequency.pending?.requestId).toBe('unknown-write');
    const event = new Event('beforeunload', { cancelable: true }); Object.defineProperty(event, 'returnValue', { writable: true, value: '' });
    window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  });
  it('drops a late history read after authenticated generation changes', async () => {
    const { root, auth } = await mountHost();
    let resolve!: (value: unknown) => void;
    transport.deviceConfigurations.queryHistory.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const opening = click(root, '配置记录'); await settle(); const signal = transport.deviceConfigurations.queryHistory.mock.calls.at(-1)![1].signal as AbortSignal;
    auth.generation++; resolve({ items: [], page: 1, page_size: 20, total: 99 }); await opening;
    expect(signal.aborted).toBe(true); expect(find(root, value => value.tag === 'drawer-probe' && value.props.title === '配置受理历史')).toBeUndefined();
    expect(textOf(root)).not.toContain('99 条');
  });
});
