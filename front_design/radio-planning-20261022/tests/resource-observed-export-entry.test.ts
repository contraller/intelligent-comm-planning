import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import { parse as parseSfc } from 'vue/compiler-sfc';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import Papa from 'papaparse';
import Drawer from '../src/components/ResourceLedgerExportDrawer.vue';
import { createResourceExportHttp } from '../src/services/resource-export-http';
import { useAuthStore } from '../src/stores/auth';
import type { ResourceReadFilter } from '../src/types/resource-read';
import type { ResourceExportRequest } from '../src/types/resource-edit';
import { ApiError } from '../src/services/types';
import { clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';

const service = vi.hoisted(() => ({ getSession: vi.fn(), previewResourceExport: vi.fn(), exportResources: vi.fn() }));
const fileDownload = vi.hoisted(() => vi.fn());
vi.mock('../src/services', () => ({ previewService: service, releasePageSessionBinding: vi.fn(), switchIntegrationIdentity: vi.fn() }));
vi.mock('../src/services/file-download', () => ({ downloadFile: fileDownload }));
vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return { default: defineComponent({ props: ['visible'], setup: (props, { slots }) => () => props.visible ? h('drawer-probe', [slots.default?.(), slots.footer?.()]) : null }) };
});
await clientTemplate(Drawer, 'src/components/ResourceLedgerExportDrawer.vue', 'resource-observed-export-entry-render.ts');

const revision = 'resource-0123456789abcdef';
const appliedFilter = (): ResourceReadFilter => ({ statusMode: 'observed', observationSnapshotId: 'SS1', search: '设备', status: 'FAULT', alert: 'NO',
  availability: 'ACTIVE', deviceClass: 'HF', mobility: 'FIXED', nodeRole: 'RELAY', relayCapable: false,
  frequency: { mode: 'MODEL', presence: 'ALL', minKhz: 0, maxKhz: 3000 } });
interface Payload {
  revision: string; kinds: string[]; range: string; selected_ids?: string[];
  status_mode?: string; observation_snapshot_id?: string; filter?: Record<string, unknown>;
}
function source(payload: Payload) {
  return { snapshot_id: payload.observation_snapshot_id!, snapshot_revision: 'device-status-' + (payload.observation_snapshot_id === 'SS1' ? 'a' : 'b').repeat(64),
    resource_revision: payload.revision, data_origin: 'SYNTHETIC_INTEGRATION', source_label: '构造来源 ' + payload.observation_snapshot_id };
}
function inspection(payload: Payload) {
  return { revision: payload.revision, data_origin: 'SYNTHETIC_INTEGRATION', source: '构造台账',
    tables: payload.kinds.map(kind => ({ kind, count: kind === 'devices' ? payload.selected_ids?.length ?? 2 : kind === 'nodes' ? 1 : 0 })),
    added: payload.range !== 'all' && payload.kinds.includes('nodes') ? 1 : 0,
    ...(payload.status_mode === 'observed' ? { status_mode: 'observed', observation: source(payload), node_status_mode: 'baseline' } : {}) };
}
function csv(payload: Payload) {
  if (payload.status_mode !== 'observed') return new Blob(['device_id,node_id\r\nD1,N1\r\n'], { type: 'text/csv' });
  const base = 'device_id,node_id,model_id,antenna_id,antenna_height_m,tilt_deg,azimuth_deg,tx_power_dbm,work_freq_khz,status,install_time,availability'.split(',');
  const metadata = { status_mode: 'observed', ...source(payload), node_status_mode: 'baseline' };
  const headers = [...base, 'alert', 'observed_at', 'record_kind', ...Object.keys(metadata)];
  const meta: Record<string, string> = { record_kind: 'metadata', ...metadata };
  const rows = (payload.selected_ids ?? ['D1', 'D2']).map(device_id => {
    const row: Record<string, string> = { device_id, node_id: 'N1', model_id: 'M1', antenna_id: 'A1', availability: 'ACTIVE',
      status: 'FAULT', alert: 'false', observed_at: '2026-10-23T00:00:00.000000Z', record_kind: 'device', ...metadata };
    return headers.map(key => row[key] ?? '');
  });
  return new Blob([Papa.unparse([headers, headers.map(key => meta[key] ?? ''), ...rows])], { type: 'text/csv' });
}
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function settle() { for (let i = 0; i < 18; i++) await nextTick(); }
async function mountDrawer(filter: ResourceReadFilter = appliedFilter(), queryReady = true) {
  class HostDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', HostDocument); vi.stubGlobal('document', new HostDocument());
  pinia = createPinia(); setActivePinia(pinia);
  const auth = useAuthStore();
  auth.accept({ sessionId: 'export-session', id: 'export-reader', username: 'reader', name: '测试读取者', roleId: 'reader', roleName: 'reader',
    permissions: ['resources.view'], epoch: 'test', revision: 'identity-1' });
  service.getSession.mockImplementation(async () => auth.identity);
  const request = vi.fn().mockImplementation(async (path: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as Payload;
    return path.endsWith('/preview') ? inspection(payload) : csv(payload);
  });
  const api = createResourceExportHttp(request);
  service.previewResourceExport.mockImplementation(api.previewResourceExport);
  service.exportResources.mockImplementation(api.exportResources);
  const props = reactive({ visible: true, revision, filter, selectedIds: ['D1', 'D2'], queryReady });
  app = renderer.createApp({ render: () => h(Drawer, props) }); app.use(pinia); app.provide(ssrContextKey, {});
  const root = node('root'); app.mount(root); await settle();
  return { root, props, auth, request };
}
type Fixture = Awaited<ReturnType<typeof mountDrawer>>;
const payloads = (f: Fixture) => f.request.mock.calls.map(call => JSON.parse(String(call[1].body)) as Payload);
function button(root: HostNode, label: string) {
  const found = find(root, value => value.tag === 'button' && textOf(value).trim() === label); expect(found, label).toBeDefined(); return found!;
}
async function click(root: HostNode, label: string) { await (button(root, label).props.onClick as () => unknown)(); await settle(); }
async function choose(root: HostNode, label: string, value: string) {
  const parent = find(root, item => item.tag === 'label' && textOf(item).trim().startsWith(label)); expect(parent, label).toBeDefined();
  const control = find(parent!, item => item.tag === 'select'); expect(control).toBeDefined();
  (control!.props['onUpdate:modelValue'] as (value: string) => void)(value); await settle();
}

describe('observed export drawer', () => {
  it.each(['all', 'selected', 'filtered'] as const)('sends only the applied source for %s, preserving all filtered conditions', async range => {
    const f = await mountDrawer(); await choose(f.root, '导出范围', range);
    const payload = payloads(f).at(-1)!;
    expect(payload).toMatchObject({ status_mode: 'observed', observation_snapshot_id: 'SS1', range });
    if (range === 'filtered') expect(payload.filter).toEqual({ search: '设备', device_class: 'HF', status: 'FAULT', availability: 'ACTIVE', alert: 'NO',
      mobility: 'FIXED', node_role: 'RELAY', relay_capable: false, frequency: { mode: 'MODEL', presence: 'ALL', min_khz: 0, max_khz: 3000 } });
    else expect(payload).not.toHaveProperty('filter');
    if (range === 'selected') expect(payload.selected_ids).toEqual(['D1', 'D2']);
    expect(textOf(f.root)).toContain('已应用状态来源：观测快照 SS1');
    expect(textOf(f.root)).toContain('device-status-' + 'a'.repeat(64)); expect(textOf(f.root)).toContain(revision);
    expect(textOf(f.root)).toContain('构造来源 SS1'); expect(button(f.root, '导出').props.disabled).toBe(false);
  });
  it.each(['all', 'selected', 'filtered'] as const)('keeps baseline requests compatible for %s', async range => {
    const f = await mountDrawer({ statusMode: 'baseline', status: 'FAULT', alert: 'NO' }); await choose(f.root, '导出范围', range);
    const payload = payloads(f).at(-1)!;
    expect(payload).not.toHaveProperty('status_mode'); expect(payload).not.toHaveProperty('observation_snapshot_id');
    if (range === 'filtered') expect(payload.filter).toEqual({ status: 'FAULT', alert: 'NO' });
    else expect(payload).not.toHaveProperty('filter');
    expect(textOf(f.root)).toContain('已应用状态来源：台账基线'); expect(button(f.root, '导出').props.disabled).toBe(false);
  });
  it('keeps an unapplied next snapshot out of requests, then rebinds only when applied props change', async () => {
    const f = await mountDrawer(), nextQuery = { statusMode: 'observed', observationSnapshotId: 'SS2' };
    await choose(f.root, '格式', 'csv'); await choose(f.root, '导出范围', 'selected'); await click(f.root, '导出');
    expect(nextQuery.observationSnapshotId).toBe('SS2'); expect(payloads(f).every(value => value.observation_snapshot_id === 'SS1')).toBe(true);
    expect(fileDownload).toHaveBeenCalledOnce(); expect(textOf(f.root)).not.toContain('观测快照 SS2');
    let resolve!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.props.filter = { ...f.props.filter, observationSnapshotId: 'SS2' }; await settle();
    expect(button(f.root, '导出').props.disabled).toBe(true); expect(textOf(f.root)).not.toContain('构造来源 SS1');
    resolve(inspection(payloads(f).at(-1)!)); await settle();
    expect(textOf(f.root)).toContain('观测快照 SS2'); expect(textOf(f.root)).toContain('构造来源 SS2');
    expect(button(f.root, '导出').props.disabled).toBe(false);
  });
  it('requires a successful query of the current resource version before preflight', async () => {
    const f = await mountDrawer(appliedFilter(), false);
    expect(f.request).not.toHaveBeenCalled(); expect(button(f.root, '导出').props.disabled).toBe(true);
    await click(f.root, '导出'); expect(service.exportResources).not.toHaveBeenCalled();
    expect(textOf(f.root)).toContain('尚无当前资源版本的已应用查询');
    f.props.queryReady = true; await settle(); expect(button(f.root, '导出').props.disabled).toBe(false);
    f.props.revision = 'resource-ffffffffffffffff'; f.props.queryReady = false; await settle();
    expect(button(f.root, '导出').props.disabled).toBe(true); expect(f.request).toHaveBeenCalledOnce();
  });
  it('invalidates a successful preflight on failure and requires explicit successful retry', async () => {
    const f = await mountDrawer();
    f.request.mockRejectedValueOnce(new ApiError('所选快照资源已变化', 1205, null, 'trace', 409));
    f.props.filter = { ...f.props.filter, observationSnapshotId: 'SS2' }; await settle();
    expect(textOf(f.root)).toContain('所选快照资源已变化'); expect(textOf(f.root)).not.toContain('构造来源 SS1');
    expect(button(f.root, '导出').props.disabled).toBe(true); await click(f.root, '导出'); expect(service.exportResources).not.toHaveBeenCalled();
    await click(f.root, '重试预检'); expect(button(f.root, '导出').props.disabled).toBe(false); expect(textOf(f.root)).toContain('构造来源 SS2');
  });
  it('rejects a mismatched source response and never starts a file request', async () => {
    const f = await mountDrawer();
    f.request.mockResolvedValueOnce(inspection({ ...payloads(f)[0]!, observation_snapshot_id: 'wrong-source' }));
    f.props.filter = { ...f.props.filter, observationSnapshotId: 'SS2' }; await settle();
    expect(button(f.root, '导出').props.disabled).toBe(true); await click(f.root, '导出');
    expect(service.exportResources).not.toHaveBeenCalled(); expect(fileDownload).not.toHaveBeenCalled();
  });
  it('does not let a late preflight overwrite a newer source', async () => {
    const f = await mountDrawer(); let resolve!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.props.filter = { ...f.props.filter, observationSnapshotId: 'SS2' }; await settle(); const old = payloads(f).at(-1)!;
    f.props.filter = { ...f.props.filter, observationSnapshotId: 'SS3' }; await settle();
    resolve(inspection(old)); await settle();
    expect(textOf(f.root)).toContain('构造来源 SS3'); expect(textOf(f.root)).not.toContain('构造来源 SS2');
    expect(button(f.root, '导出').props.disabled).toBe(false);
  });
  it('refuses observed node-only export instead of inferring node state', async () => {
    const f = await mountDrawer(); await choose(f.root, '格式', 'csv'); const count = f.request.mock.calls.length;
    await choose(f.root, '资源类型', 'nodes'); expect(f.request).toHaveBeenCalledTimes(count);
    expect(textOf(f.root)).toContain('观测导出必须包含设备表'); expect(button(f.root, '导出').props.disabled).toBe(true);
    await choose(f.root, '资源类型', 'devices'); expect(button(f.root, '导出').props.disabled).toBe(false);
  });
  it.each(['source', 'identity', 'unmount'] as const)('drops a late file after %s changes', async change => {
    const f = await mountDrawer(); await choose(f.root, '格式', 'csv');
    let resolve!: (value: Blob) => void, downloadPayload!: Payload;
    f.request.mockImplementation((path: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as Payload;
      if (path.endsWith('/preview')) return Promise.resolve(inspection(payload));
      downloadPayload = payload; return new Promise<Blob>(done => { resolve = done; });
    });
    const pending = click(f.root, '导出'); await settle();
    if (change === 'source') f.props.filter = { ...f.props.filter, observationSnapshotId: 'SS2' };
    if (change === 'identity') f.auth.generation++;
    if (change === 'unmount') { app!.unmount(); app = undefined; }
    await settle(); resolve(csv(downloadPayload)); await pending;
    expect(fileDownload).not.toHaveBeenCalled();
  });
  it('clears the preflight when download revalidation fails', async () => {
    const f = await mountDrawer(); await choose(f.root, '格式', 'csv');
    f.request.mockRejectedValueOnce(new ApiError('导出前快照已失效', 1205, null, 'download-trace', 409));
    await click(f.root, '导出'); expect(button(f.root, '导出').props.disabled).toBe(true);
    expect(textOf(f.root)).toContain('导出前快照已失效'); expect(fileDownload).not.toHaveBeenCalled();
    expect(payloads(f).every(payload => payload.status_mode === 'observed')).toBe(true);
  });
  it('binds the actual resource page export fragment to applied query and ledger revision', () => {
    const { descriptor } = parseSfc(readFileSync('src/views/ResourcesView.vue', 'utf8'));
    interface TemplateNode { tag?: string; children?: TemplateNode[]; props?: { name?: string; arg?: { content?: string }; exp?: { content?: string } }[] }
    function visit(value: TemplateNode): TemplateNode | undefined {
      if (value.tag === 'ResourceLedgerExportDrawer') return value;
      for (const child of value.children ?? []) { const found = visit(child); if (found) return found; }
    }
    const element = visit(descriptor.template!.ast as unknown as TemplateNode)!;
    expect(element).toBeDefined();
    const binding = (name: string) => element.props!.find(prop => prop.name === 'bind' && prop.arg?.content === name)?.exp?.content;
    expect(binding('filter')).toBe('appliedFilter'); expect(binding('revision')).toBe("read.ledger?.revision ?? ''");
    expect(binding('query-ready')).toContain('read.ledgerApplied'); expect(binding('query-ready')).toContain('read.ledger.revision === read.workspace?.revision');
  });
});
