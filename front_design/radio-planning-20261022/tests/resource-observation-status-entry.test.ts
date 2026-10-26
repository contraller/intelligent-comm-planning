import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ResourcesView from '../src/views/ResourcesView.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useResourceStatusStore } from '../src/stores/resource-status';
import { allPermissions, type Permission } from '../src/config/permissions';
import type { ObservationDeviceStatusRefInput } from '../src/types/observation';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';

type Target = { datasetId: string; datasetRevision: string; ref: ObservationDeviceStatusRefInput };
const transport = vi.hoisted(() => ({
  observations: { getObservationDeviceStatusRef: vi.fn(), importObservation: vi.fn() },
  deviceStatuses: { getSnapshot: vi.fn(), queryDevices: vi.fn(), importSnapshot: vi.fn() },
  frequencies: {}, spectrumSources: {}, deviceTraces: {}, deviceConfigurations: {},
}));
const panels = vi.hoisted(() => ({ monitorLeave: vi.fn(async () => true), monitorStop: vi.fn(), monitorClear: vi.fn() }));
vi.mock('../src/services/http', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/http')>();
  return { ...actual, collaborationHttp: transport };
});
vi.mock('../src/components/SpectrumMonitoringPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({
    props: ['services', 'canView', 'canImport', 'sessionGeneration', 'initialSelection'],
    emits: ['select-status-ref', 'select-dataset', 'dirty-change', 'busy-change'],
    setup(props, { emit, expose }) {
      expose({ requestLeave: panels.monitorLeave, stop: panels.monitorStop, clearForSession: panels.monitorClear });
      return () => h('observation-monitor-probe', { ...props,
        onReference: (value: Target) => emit('select-status-ref', value),
        onDataset: (value: unknown) => emit('select-dataset', value),
      });
    },
  }) };
});
// 仅替换只读抽屉；真实ResourcesView负责目标冻结、权限与生命周期接线。
vi.mock('../src/components/ObservationStatusReferenceDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({
    props: ['visible', 'target', 'services', 'canView', 'sessionGeneration', 'currentResourceRevision'],
    emits: ['update:visible', 'busy-change'],
    setup(props, { emit }) {
      return () => h('observation-reference-probe', { ...props, onClose: () => emit('update:visible', false) });
    },
  }) };
});
vi.mock('../src/components/ResourceStatusPanel.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({
    props: ['services', 'resourceRevision', 'enabled', 'allowImport'],
    setup(props, { expose }) {
      expose({ requestLeave: async () => true, canRefreshDirectoryInBackground: () => false });
      return () => h('resource-status-probe', { ...props });
    },
  }) };
});
vi.mock('../src/components/DeviceInfoPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DeviceConfigurationDrawer.vue', async () => {
  const { defineComponent } = await import('vue');
  return { default: defineComponent({ setup(_props, { expose }) { expose({ requestLeave: async () => true }); return () => null; } }) };
});
vi.mock('../src/components/ResourceLedgerEditDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerImportDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DevicePortsEditDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerExportDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceReadStatus.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerTree.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceLedgerFilters.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/AppTable.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SpectrumConfigPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/FrequencyResourcePanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SpectrumObservationImportDialog.vue', async () => {
  const { defineComponent } = await import('vue');
  return { default: defineComponent({ setup(_props, { expose }) {
    expose({ requestLeave: async () => true, clearForSession: () => {} }); return () => null;
  } }) };
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible', 'title'],
    setup: (props, { slots }) => () => props.visible ? h('drawer-probe', { ...props }, slots.default?.()) : null }) };
});
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));

await clientTemplate(ResourcesView, 'src/views/ResourcesView.vue', 'resource-observation-status-entry-render.ts');
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
async function settle() { for (let i = 0; i < 30; i++) await nextTick(); }
function probe(root: HostNode, tag: string) {
  const value = find(root, item => item.tag === tag); expect(value, tag).toBeDefined(); return value!;
}
const drawer = (root: HostNode) => probe(root, 'observation-reference-probe');
async function click(root: HostNode, label: string) {
  const button = find(root, item => item.tag === 'button' && textOf(item).trim() === label);
  expect(button, label).toBeDefined(); await (button!.props.onClick as () => unknown)(); await settle();
}
function emitReference(root: HostNode, value = target()) {
  (probe(root, 'observation-monitor-probe').props.onReference as (value: Target) => void)(value);
  return value;
}
function selectDataset(root: HostNode) {
  (probe(root, 'observation-monitor-probe').props.onDataset as (value: unknown) => void)({ datasetId: 'other-observation', datasetRevision: 'observation-' + 'e'.repeat(64) });
}
function target(): Target {
  return { datasetId: 'historical-observation', datasetRevision: 'observation-' + 'a'.repeat(64),
    ref: { snapshotId: 'DSS-' + 'b'.repeat(32), snapshotRevision: 'device-status-' + 'c'.repeat(64),
      resourceRevision: 'resource-historical', deviceIds: ['device-A', 'device-B'] } };
}
function statusState() {
  const status = useResourceStatusStore();
  return JSON.stringify({ revision: status.revision, mode: status.mode, batch: status.batch,
    details: status.batchDetails, records: status.snapshotRecords, snapshotId: status.snapshotId });
}
beforeEach(() => { vi.clearAllMocks(); panels.monitorLeave.mockResolvedValue(true); });
afterEach(() => {
  app?.unmount(); app = undefined;
  if (pinia) disposePinia(pinia); pinia = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function mountHost() {
  const storage = new TestStorage();
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage })); vi.stubGlobal('localStorage', storage);
  class HostDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', HostDocument); vi.stubGlobal('document', new HostDocument());
  pinia = createPinia(); setActivePinia(pinia);
  const auth = authorizeStore();
  auth.accept({ ...auth.identity!, permissions: [...allPermissions] as Permission[] });
  // 所有宿主读取来自同一个内存fixture，不接运行服务或数据库。
  const fixtureStorage = new TestStorage(), fixture = createMockService(() => fixtureStorage);
  for (const key of ['loadPreview', 'loadResourceReadContext', 'queryResourceDevices', 'getResourceObject', 'loadResourceMaintenanceContext', 'saveResourceChanges'] as const)
    vi.spyOn(previewService, key).mockImplementation(fixture[key] as never);
  const preview = usePreviewStore(); await preview.load();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/resources', component: ResourcesView }] });
  await router.push('/resources'); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {});
  const root = node('root'); app.mount(root); await settle();
  const read = useResourceReadStore();
  await vi.waitFor(() => expect(read.workspace).not.toBeNull(), { interval: 5 }); await settle();
  await click(root, '频谱观测');
  return { root, read, auth };
}

describe('资源页观测冻结状态引用接线', () => {
  it('历史版本事件冻结后传抽屉，绑定真实服务pair且不重绑当前资源或状态store', async () => {
    const { root, read } = await mountHost();
    const revision = read.workspace!.revision, baseline = statusState();
    const status = useResourceStatusStore(), bind = vi.spyOn(status, 'bind'), select = vi.spyOn(status, 'select'), setMode = vi.spyOn(status, 'setMode');
    const input = target(), expected = structuredClone(input);
    expect(input.ref.resourceRevision).not.toBe(revision);
    emitReference(root, input);
    input.datasetId = 'late-mutation'; input.datasetRevision = 'observation-' + 'f'.repeat(64);
    input.ref.snapshotId = 'DSS-' + '0'.repeat(32); input.ref.snapshotRevision = 'device-status-' + '0'.repeat(64);
    input.ref.resourceRevision = revision; input.ref.deviceIds.push('late-device'); await settle();
    const reference = drawer(root);
    expect(reference.props).toMatchObject({ visible: true, target: expected, canView: true, currentResourceRevision: revision });
    expect(reference.props.target).not.toBe(input);
    const pair = reference.props.services as { observations: unknown; deviceStatuses: unknown };
    expect(pair.observations).toBe(transport.observations); expect(pair.deviceStatuses).toBe(transport.deviceStatuses);
    expect(bind).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); expect(setMode).not.toHaveBeenCalled();
    expect(statusState()).toBe(baseline); expect(read.workspace!.revision).toBe(revision); expect(read.ledgerQuery.statusMode).not.toBe('observed');
    expect(previewService.saveResourceChanges).not.toHaveBeenCalled(); expect(transport.observations.importObservation).not.toHaveBeenCalled(); expect(transport.deviceStatuses.importSnapshot).not.toHaveBeenCalled();
    // 子抽屉被stub，本测试不冒充其HTTP核验或分页明细测试。
    expect(transport.observations.getObservationDeviceStatusRef).not.toHaveBeenCalled(); expect(transport.deviceStatuses.getSnapshot).not.toHaveBeenCalled();
  });

  it.each([{ missing: ['resources.view'] }, { missing: ['situation.view'] }, { missing: ['resources.view', 'situation.view'] }])('缺少权限$missing时canView为false且父事件不能打开抽屉', async ({ missing }) => {
    const { root, auth } = await mountHost();
    emitReference(root); await settle(); expect(drawer(root).props.visible).toBe(true);
    auth.accept({ ...auth.identity!, permissions: allPermissions.filter(permission => !missing.includes(permission)) }); await settle();
    expect(drawer(root).props.canView).toBe(false); emitReference(root); await settle();
    expect(drawer(root).props.visible).toBe(false); expect(drawer(root).props.target).toBeNull();
  });

  it('切换观测集清除旧目标，再次显式选Ref才打开', async () => {
    const { root } = await mountHost(); emitReference(root); await settle(); expect(drawer(root).props.visible).toBe(true);
    selectDataset(root); await settle(); expect(drawer(root).props.visible).toBe(false); expect(drawer(root).props.target).toBeNull();
    const next = target(); next.datasetId = 'next-observation'; emitReference(root, next); await settle();
    expect(drawer(root).props.target).toEqual(next); expect(drawer(root).props.visible).toBe(true);
  });

  it.each(['generation', 'identity'] as const)('会话%s变化清理目标并更新抽屉sessionGeneration', async change => {
    const { root, auth } = await mountHost(); emitReference(root); await settle();
    const generation = drawer(root).props.sessionGeneration;
    if (change === 'generation') auth.generation++;
    else auth.accept({ ...auth.identity!, id: 'other-reader', sessionId: 'other-reader-session' });
    await settle(); expect(drawer(root).props.visible).toBe(false); expect(drawer(root).props.target).toBeNull();
    expect(drawer(root).props.sessionGeneration).not.toBe(generation);
  });

  it('页签离开清理目标，返回频谱不复活旧引用', async () => {
    const { root, read } = await mountHost(); emitReference(root); await settle();
    const revision = read.workspace!.revision; await click(root, '设备台账');
    expect(drawer(root).props.visible).toBe(false); expect(drawer(root).props.target).toBeNull();
    expect(read.workspace!.revision).toBe(revision); expect(probe(root, 'resource-status-probe').props.resourceRevision).toBe(revision);
    await click(root, '频谱观测'); expect(drawer(root).props.visible).toBe(false); expect(drawer(root).props.target).toBeNull();
  });

  it('离开保护拒绝时不打开只读抽屉', async () => {
    const { root } = await mountHost(); panels.monitorLeave.mockResolvedValue(false);
    emitReference(root); await settle(); expect(panels.monitorLeave).toHaveBeenCalled();
    expect(drawer(root).props.visible).toBe(false); expect(drawer(root).props.target).toBeNull();
  });

  it.each(['dataset', 'generation'] as const)('父离开决定尚未完成时%s变化使旧事件失效', async change => {
    const { root, auth } = await mountHost(); let finish!: (value: boolean) => void;
    panels.monitorLeave.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    emitReference(root); await vi.waitFor(() => expect(finish).toBeTypeOf('function'), { interval: 5 });
    if (change === 'dataset') selectDataset(root); else auth.generation++;
    finish(true); await settle(); expect(drawer(root).props.visible).toBe(false); expect(drawer(root).props.target).toBeNull();
  });
});
