import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ref, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import ResourceStatusPanel from '../src/components/ResourceStatusPanel.vue';
import ResourceStatusBadge from '../src/components/ResourceStatusBadge.vue';
import DeviceInfoPanel from '../src/components/DeviceInfoPanel.vue';
import StatusBadge from '../src/components/StatusBadge.vue';
import { createDeviceStatusHttp } from '../src/services/device-status-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { ApiError } from '../src/services/types';
import { initialResources } from '../src/mocks/resource-presets';
import { useResourceStatusStore } from '../src/stores/resource-status';
import { deviceStatusSchema as schema, type DeviceStatusHeader, type DeviceStatusItem, type DeviceStatusImport, type DeviceStatusReceipt, type StatusPage } from '../src/types/device-status-snapshot';
import { authorizeStore } from './helpers/auth';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';

vi.mock('../src/components/DeviceDetailTabs.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ setup(_, { slots }) { return () => h('details-probe', [slots.basic?.(), slots.parameters?.(), slots.actions?.()]); } }) };
});
vi.mock('../src/composables/useDeviceKnowledgeSummary', async () => {
  const { ref } = await import('vue');
  return { useDeviceKnowledgeSummary: () => ({ summary: ref(null), status: ref('forbidden'), error: ref(''), retry() {} }) };
});
await Promise.all([
  clientTemplate(ResourceStatusPanel, 'src/components/ResourceStatusPanel.vue', 'p06-status-entry.ts'),
  clientTemplate(ResourceStatusBadge, 'src/components/ResourceStatusBadge.vue', 'p06-status-badge.ts'),
  clientTemplate(DeviceInfoPanel, 'src/components/DeviceInfoPanel.vue', 'p06-device-detail.ts'),
  clientTemplate(StatusBadge, 'src/components/StatusBadge.vue', 'p06-status-label.ts'),
]);
const revision = 'resource-1111111111111111', observedAt = '2026-10-21T00:00:00.000000Z';
function header(): DeviceStatusHeader {
  return { schema_version: schema, snapshot_id: 'DSS-' + 'a'.repeat(32), snapshot_revision: 'device-status-' + 'b'.repeat(64),
    content_hash: 'b'.repeat(64), resource_revision: revision, resource_content_hash: 'e'.repeat(64), data_origin: 'SYNTHETIC_INTEGRATION',
    source_label: '已持久化构造批次', provenance_note: '测试替身响应，非真实遥测', imported_at: '2026-10-23T10:00:00.000000Z', actor_id: 'editor',
    total: 2, counts: { NORMAL: 0, FAULT: 1, OFFLINE: 0, UNKNOWN: 1, total: 2 }, first_observed_at: observedAt, last_observed_at: observedAt };
}
function records(): DeviceStatusItem[] {
  const devices = initialResources().devices, first = devices.find(item => item.id === 'DV-0001')!, unknown = devices.find(item => item.id === 'DV-0004')!;
  return [
    { device_id: first.id, node_id: first.stationId, model_id: first.modelId, status: 'FAULT', alert: false, observed_at: observedAt, unknown_reasons: [], availability: first.availability ?? 'ACTIVE' },
    { device_id: unknown.id, node_id: unknown.stationId, model_id: unknown.modelId, status: null, alert: null, observed_at: null, unknown_reasons: ['原始来源未提供状态、告警和采集时间'], availability: unknown.availability ?? 'ACTIVE' },
  ];
}
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function settle() { for (let i = 0; i < 15; i++) await nextTick(); }
async function click(root: HostNode, label: string) {
  const element = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(element, label).toBeDefined();
  const handler = element!.props.onClick;
  if (typeof handler !== 'function') throw new Error('控件缺少实际click事件');
  await handler(); await settle();
}
function transportFixture() {
  const headers = [header()], batches = new Map<string, DeviceStatusItem[]>([[header().snapshot_id, records()]]);
  const receipts = new Map<string, DeviceStatusReceipt>(), posted: DeviceStatusImport[] = [];
  const request = vi.fn<AuthenticatedRequest>().mockImplementation(async (path, init) => {
    const url = new URL(path, 'http://unit-test.invalid'), query = url.searchParams;
    const page = Number(query.get('page') ?? 1), pageSize = Number(query.get('page_size') ?? 20);
    const pageOf = <T,>(items: T[]) => ({ schema_version: schema, items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, page_size: pageSize });
    if (url.pathname === '/device-status/imports' && init?.method === 'POST') {
      const input: unknown = JSON.parse(String(init.body));
      // 工厂已严格校验请求；测试替身保存原body供断言，不在生产store计算观测。
      const value = input as DeviceStatusImport; posted.push(value);
      const added: DeviceStatusHeader = { ...header(), snapshot_id: 'DSS-' + 'c'.repeat(32), snapshot_revision: 'device-status-' + 'd'.repeat(64),
        content_hash: 'd'.repeat(64), source_label: value.source_label, provenance_note: value.provenance_note, imported_at: '2026-10-23T11:00:00.000000Z' };
      headers.unshift(added); batches.set(added.snapshot_id, value.records.map(item => {
        const source = records().find(record => record.device_id === item.device_id);
        if (!source) throw new ApiError('fixture device not found', 1002);
        return { ...item, availability: source.availability };
      }));
      const receipt: DeviceStatusReceipt = { schema_version: schema, request_id: value.request_id, snapshot_id: added.snapshot_id, snapshot_revision: added.snapshot_revision,
        resource_revision: added.resource_revision, imported_at: added.imported_at, total: added.total, content_hash: added.content_hash, data_origin: added.data_origin };
      receipts.set(value.request_id, receipt); return receipt;
    }
    if (url.pathname.startsWith('/device-status/imports/')) {
      const receipt = receipts.get(decodeURIComponent(url.pathname.split('/').at(-1)!));
      if (!receipt) throw new ApiError('not found', 1002);
      return structuredClone(receipt);
    }
    if (url.pathname === '/device-status/snapshots') {
      return pageOf(headers.filter(item => !query.has('resource_revision') || item.resource_revision === query.get('resource_revision')));
    }
    const parts = url.pathname.split('/'), selected = headers.find(item => item.snapshot_id === parts[3]);
    if (!selected) throw new ApiError('not found', 1002);
    if (parts[4] === 'devices') {
      const filter = query.get('status_filter') ?? 'ALL';
      const rows = (batches.get(selected.snapshot_id) ?? []).filter(item => filter === 'ALL' || filter === 'UNKNOWN' && item.status === null || item.status === filter);
      return { ...pageOf(rows), snapshot_id: selected.snapshot_id, snapshot_revision: selected.snapshot_revision, resource_revision: selected.resource_revision };
    }
    return structuredClone(selected);
  });
  return { request, posted, client: createDeviceStatusHttp(request as AuthenticatedRequest) };
}
async function mountEntry(allowImport = false) {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const permissions = auth.identity!.permissions as string[];
  if (!permissions.includes('resources.device.status.import')) permissions.push('resources.device.status.import');
  const status = useResourceStatusStore(), transport = transportFixture(), resources = initialResources();
  const props = reactive({ revision, enabled: true, allowImport, deviceId: 'DV-0001', observed: true });
  const panel = ref<InstanceType<typeof ResourceStatusPanel> | null>(null), selected = vi.fn(), dirty = vi.fn(), busy = vi.fn();
  const root = node('root');
  app = renderer.createApp({ render: () => {
    const device = resources.devices.find(item => item.id === props.deviceId)!;
    return h('module-host', [
      h(ResourceStatusPanel, { ref: panel, resourceRevision: props.revision, total: resources.devices.length, enabled: props.enabled,
        allowImport: props.allowImport, services: transport.client, 'onSnapshot-selected': selected, onDirty: dirty, onBusy: busy }),
      h(DeviceInfoPanel, { device, resources, statusDisplay: props.observed ? status.display(device) : undefined,
        statusSnapshotRef: props.observed ? status.project(device.id, props.revision)?.ref ?? null : null,
        maintenanceBinding: { context: 'gis', revision: props.revision, editable: false } }),
    ]);
  } });
  app.use(pinia); app.provide(ssrContextKey, {}); app.mount(root); await settle();
  return { root, auth, status, transport, resources, props, selected, dirty, busy, leave: () => panel.value!.requestLeave() };
}
function updateRaw(root: HostNode, value: string) {
  const input = find(root, n => n.props['aria-label'] === '状态导入 JSON')!, update = input?.props['onUpdate:modelValue'];
  expect(input).toBeDefined();
  if (typeof update !== 'function') throw new Error('导入输入缺少实际v-model事件');
  update(value);
}

// 专用模块宿主使用实际组件和严格HTTP工厂；完整资源/GIS页由main/P02各自验收。
describe('冻结状态面板与设备详情入口', () => {
  it('显式选择真实批次才投影同版ref，未知记录和未覆盖设备都不借基线正常', async () => {
    const s = await mountEntry(), before = JSON.stringify(s.resources);
    expect(s.status.project('DV-0001', revision)).toBeNull(); await click(s.root, '已持久化构造批次');
    expect(s.selected).toHaveBeenCalledWith({ snapshot_id: header().snapshot_id, snapshot_revision: header().snapshot_revision, resource_revision: revision });
    expect(textOf(s.root)).toContain('设备故障'); expect(textOf(s.root)).toContain(observedAt);
    s.props.deviceId = 'DV-0004'; await settle();
    expect(textOf(s.root)).toContain('状态未提供'); expect(textOf(s.root)).toContain('告警未提供');
    expect(s.status.project('DV-0004', revision)).toMatchObject({ status: null, alert: null, observedAt: null });
    s.props.deviceId = 'DV-0005'; await settle(); expect(s.status.project('DV-0005', revision)).toBeNull();
    expect(JSON.stringify(s.resources)).toBe(before);
  });
  it('冻结资源R只读，普通资源展示仍用保存值，不把构造状态写回设备', async () => {
    const s = await mountEntry(); await click(s.root, '已持久化构造批次');
    expect(find(s.root, n => n.tag === 'input' && n.props.type === 'file')).toBeUndefined();
    expect(s.transport.posted).toEqual([]); s.props.observed = false; await settle();
    expect(s.status.mode).toBe('observed'); expect(s.resources.devices[0].status).toBe('NORMAL');
    expect(s.transport.request.mock.calls.filter(([path]) => path.startsWith('/device-status/snapshots?')).every(([path]) => new URL(path, 'http://unit-test.invalid').searchParams.get('resource_revision') === revision)).toBe(true);
  });
  it('状态筛选向服务端传批次和UNKNOWN，不对资源当前页筛出伪全库结论', async () => {
    const s = await mountEntry(); await click(s.root, '已持久化构造批次');
    const input = find(s.root, n => n.props['aria-label'] === '快照状态筛选')!, change = input.props.onChange;
    if (typeof change !== 'function') throw new Error('状态筛选缺少实际change事件');
    await change({ target: { value: 'UNKNOWN' } }); await settle();
    expect(s.status.batchDetails?.total).toBe(1); expect(s.status.batchDetails?.items[0]?.device_id).toBe('DV-0004');
    expect(s.transport.request.mock.calls.at(-1)?.[0]).toContain('status_filter=UNKNOWN');
  });
  it('显式导入前保护原始JSON，真实工厂只发校验后的body，回执后标记发起副本', async () => {
    const s = await mountEntry(true), before = JSON.stringify(s.resources);
    const value: DeviceStatusImport = { schema_version: schema, context: 'ledger', request_id: 'entry-import-one', base_revision: revision,
      data_origin: 'SYNTHETIC_INTEGRATION', source_label: '入口显式构造导入', provenance_note: '测试用显式请求',
      records: records().map(({ availability: _, ...record }) => record) };
    updateRaw(s.root, JSON.stringify(value)); await settle();
    expect(s.dirty).toHaveBeenLastCalledWith(true); expect(await s.leave()).toBe(false);
    await click(s.root, '校验并导入');
    expect(s.transport.posted).toEqual([value]); expect(s.status.receipt?.request_id).toBe(value.request_id);
    expect(s.dirty).toHaveBeenLastCalledWith(false); expect(await s.leave()).toBe(true);
    expect(JSON.stringify(s.resources)).toBe(before);
  });
  it('脏JSON必须显式放弃，离开确认不隐式清空或生成导入', async () => {
    const s = await mountEntry(true); updateRaw(s.root, '{invalid-but-retained'); await settle();
    expect(await s.leave()).toBe(false); expect(s.transport.posted).toEqual([]);
    await click(s.root, '放弃未提交导入输入'); expect(await s.leave()).toBe(true); expect(s.dirty).toHaveBeenLastCalledWith(false);
  });
  it('暂停/换版后拒绝迟到读取，失权后清除ref并隐藏导入', async () => {
    const s = await mountEntry(true); let finish!: (value: StatusPage<DeviceStatusHeader>) => void;
    s.transport.request.mockImplementationOnce(() => new Promise<StatusPage<DeviceStatusHeader>>(resolve => { finish = resolve; }));
    const pending = s.status.list(); const signal = s.transport.request.mock.calls.at(-1)?.[1]?.signal;
    s.props.enabled = false; await settle();
    finish({ schema_version: schema, items: [header()], total: 1, page: 1, page_size: 20 }); await pending;
    expect(signal?.aborted).toBe(true); expect(s.status.batch).toBeNull();
    s.props.enabled = true; await settle(); await click(s.root, '已持久化构造批次');
    s.props.revision = 'resource-2222222222222222'; await settle();
    expect(s.status.project('DV-0001', revision)).toBeNull(); expect(s.status.mode).toBe('baseline');
    s.auth.accept({ ...s.auth.identity!, permissions: [] }); await settle();
    expect(s.status.importable).toBe(false); expect(find(s.root, n => n.tag === 'input' && n.props.type === 'file')).toBeUndefined();
    expect(s.status.snapshotRecords).toEqual({});
  });
});

