import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { h, nextTick, shallowReactive, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
import Panel from '../src/components/ResourceStatusPanel.vue';
import { deviceStatusSchema as schema, type DeviceStatusHeader, type DeviceStatusImport, type StatusPage } from '../src/types/device-status-snapshot';
import type { DeviceStatusClient } from '../src/services/device-status-http';
import { useResourceStatusStore } from '../src/stores/resource-status';
import { createMockService } from '../src/services/mock';
import { TestStorage } from './helpers/storage';
import { gisDevicePoints, defaultGisDeviceSettings, GIS_DEVICE_COLORS } from '../src/maps/gis-device-display';
import { gisDeviceStyles } from '../src/maps/gis-device-layers';
import GisDeviceClusterPanel from '../src/components/GisDeviceClusterPanel.vue';
await clientTemplate(Panel, 'src/components/ResourceStatusPanel.vue', 'p06-status-render.ts');
await clientTemplate(GisDeviceClusterPanel, 'src/components/GisDeviceClusterPanel.vue', 'p06-cluster-render.ts');
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
beforeEach(() => {
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {});
});
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const revision = 'resource-1111111111111111';
const header: DeviceStatusHeader = { schema_version: schema, snapshot_id: 'DSS-' + 'a'.repeat(32), snapshot_revision: 'device-status-' + 'b'.repeat(64),
  content_hash: 'b'.repeat(64), resource_revision: revision, resource_content_hash: 'c'.repeat(64), data_origin: 'SYNTHETIC_INTEGRATION',
  source_label: '历史构造批次', provenance_note: '没有真实上报', imported_at: '2026-10-23T10:00:00.000000Z', actor_id: 'editor', total: 1,
  counts: { NORMAL: 0, FAULT: 0, OFFLINE: 0, UNKNOWN: 1, total: 1 }, first_observed_at: null, last_observed_at: null };
function client(): DeviceStatusClient { return {
  listSnapshots: vi.fn().mockResolvedValue({ schema_version: schema, items: [header], total: 1, page: 1, page_size: 20 }),
  getSnapshot: vi.fn().mockResolvedValue(header), queryDevices: vi.fn().mockResolvedValue({ schema_version: schema, snapshot_id: header.snapshot_id, snapshot_revision: header.snapshot_revision,
    resource_revision: revision, items: [{ device_id: 'D1', node_id: 'N1', model_id: 'M1', status: null, alert: null, observed_at: null, unknown_reasons: ['缺原始采集时间'], availability: 'ACTIVE' }], total: 1, page: 1, page_size: 20 }),
  importSnapshot: vi.fn(), getImport: vi.fn(),
}; }
async function settle() { for (let i = 0; i < 15; i++) await nextTick(); }
async function mount(services?: DeviceStatusClient, allowImport = false, options: { allowFollow?: boolean; completeSnapshot?: boolean; backgroundEnabled?: boolean } = {}) {
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const permissions = auth.identity!.permissions as string[];
  if (!permissions.includes('resources.device.status.import')) permissions.push('resources.device.status.import');
  const selected = vi.fn(), root = node('root');
  const dirty = vi.fn(), busy = vi.fn(), imported = vi.fn();
  let exposed!: { requestLeave(): Promise<boolean>; canRefreshDirectoryInBackground(): boolean; refreshDirectoryInBackground(signal?: AbortSignal): Promise<boolean> };
  const state = shallowReactive({ resourceRevision: revision, services, enabled: true, queryBusy: false, ...options });
  app = renderer.createApp({ render: () => h(Panel, { ...state, total: null, allowImport,
    ref: value => { exposed = value as unknown as typeof exposed; }, 'onSnapshot-selected': selected, onDirty: dirty, onBusy: busy, onImported: imported }) });
  app.use(pinia); app.provide(ssrContextKey, {}); app.mount(root); await settle();
  return { root, selected, dirty, busy, imported, state, auth, leave: () => exposed.requestLeave(),
    canBackground: () => exposed.canRefreshDirectoryInBackground(), background: (signal?: AbortSignal) => exposed.refreshDirectoryInBackground(signal) };
}
it('missing service is explicit and does not create mock batches', async () => {
  const { root } = await mount(); expect(textOf(root)).toContain('状态服务未接入'); expect(textOf(root)).toContain('未知');
  expect(textOf(root)).not.toContain('教学样例'); expect(textOf(root)).not.toContain('同步全部');
});
it('frozen panel reads same-version snapshots, emits frozen identity and never offers import', async () => {
  const services = client(), { root, selected } = await mount(services);
  const button = find(root, n => n.tag === 'button' && textOf(n) === '历史构造批次')!;
  await (button.props.onClick as () => Promise<unknown>)(); await settle();
  expect(selected).toHaveBeenCalledWith({ snapshot_id: header.snapshot_id, snapshot_revision: header.snapshot_revision, resource_revision: revision });
  expect(textOf(root)).toContain('缺原始采集时间'); expect(textOf(root)).toContain('非真实遥测');
  expect(find(root, n => n.tag === 'input' && n.props.type === 'file')).toBeUndefined();
  expect(services.importSnapshot).not.toHaveBeenCalled();
});
it('blocks leaving unsubmitted raw input until explicit discard, not just pending imports', async () => {
  const s = await mount(client(), true);
  const input = find(s.root, n => n.props['aria-label'] === '状态导入 JSON')!;
  expect(input).toBeDefined(); (input.props['onUpdate:modelValue'] as Function)('{unsubmitted'); await settle();
  expect(s.dirty).toHaveBeenLastCalledWith(true); expect(await s.leave()).toBe(false);
  const discard = find(s.root, n => n.tag === 'button' && textOf(n) === '放弃未提交导入输入')!;
  (discard.props.onClick as Function)(); await settle(); expect(s.dirty).toHaveBeenLastCalledWith(false); expect(await s.leave()).toBe(true);
});
it('blocks leaving while file content is still being read and reports busy', async () => {
  const s = await mount(client(), true); let done!: (value: string) => void;
  const input = find(s.root, n => n.tag === 'input' && n.props.type === 'file')!;
  const reading = (input.props.onChange as Function)({ target: { files: [{ name: 'status.json', size: 10, text: () => new Promise(resolve => { done = resolve; }) }] } });
  await settle(); expect(s.busy).toHaveBeenLastCalledWith(true); expect(await s.leave()).toBe(false);
  done('unsubmitted-file-content'); await reading; await settle(); expect(s.busy).toHaveBeenLastCalledWith(false); expect(await s.leave()).toBe(false);
});
it('allows opening another detail during a pending read-only directory and discards its late result', async () => {
  const services = client(), done = deferredDirectory(services), s = await mount(services), status = useResourceStatusStore();
  const signal = vi.mocked(services.listSnapshots).mock.calls[0][1]?.signal;
  expect(status.busy).toBe(true); expect(status.pendingImport).toBeNull();
  expect(await s.leave()).toBe(true); expect(signal?.aborted).toBe(true); expect(status.busy).toBe(false);
  done(directory([nextHeader])); await settle(); expect(status.snapshots).toBeNull();
  expect(textOf(s.root)).not.toContain('尚有文件读取、待核实原号或未提交导入输入');
});
const fileRequest: DeviceStatusImport = {
  schema_version: schema, context: 'ledger', request_id: 'status-file-original', base_revision: revision,
  data_origin: 'SYNTHETIC_INTEGRATION', source_label: '原构造文件', provenance_note: '测试构造，不是真实上报',
  records: [{ device_id: 'D1', node_id: 'N1', model_id: 'M1', status: null, alert: false, observed_at: null, unknown_reasons: ['缺采集时间和状态'] }],
};
type TestFile = { name: string; size: number; text(): Promise<string> };
function chooseFile(root: HostNode, file: TestFile): Promise<void> {
  const input = find(root, n => n.tag === 'input' && n.props.type === 'file')!;
  return (input.props.onChange as (event: Event) => Promise<void>)({ target: { files: [file] } } as unknown as Event);
}
it('still refuses leaving during an actual import and never cancels its signal', async () => {
  const services = client(); let done!: (value: Awaited<ReturnType<DeviceStatusClient['importSnapshot']>>) => void;
  vi.mocked(services.importSnapshot).mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
  const s = await mount(services, true);
  await chooseFile(s.root, { name: 'status.json', size: 100, text: async () => JSON.stringify(fileRequest) });
  const submit = find(s.root, n => n.tag === 'button' && textOf(n) === '校验并导入')!;
  const pending = (submit.props.onClick as () => Promise<void>)(); await settle();
  const signal = vi.mocked(services.importSnapshot).mock.calls[0][1]?.signal;
  expect(useResourceStatusStore().pendingImport?.request_id).toBe(fileRequest.request_id);
  expect(await s.leave()).toBe(false); expect(signal?.aborted).toBe(false);
  done({ schema_version: schema, request_id: fileRequest.request_id, snapshot_id: header.snapshot_id, snapshot_revision: header.snapshot_revision,
    resource_revision: revision, imported_at: header.imported_at, total: 1, content_hash: header.content_hash, data_origin: header.data_origin });
  await pending; await settle(); expect(await s.leave()).toBe(true);
});
it.each(['oversize', 'read-error'] as const)('invalidates old JSON when replacement file fails: %s', async failure => {
  const services = client(), s = await mount(services, true);
  await chooseFile(s.root, { name: 'original.json', size: 100, text: async () => JSON.stringify(fileRequest) });
  const read = vi.fn().mockRejectedValue(new Error('file unavailable'));
  await chooseFile(s.root, { name: 'replacement.json', size: failure === 'oversize' ? 2 * 1024 * 1024 + 1 : 100, text: read });
  await settle(); expect(textOf(s.root)).toContain(failure === 'oversize' ? '不能超过 2 MiB' : '文件读取失败');
  if (failure === 'oversize') expect(read).not.toHaveBeenCalled();
  const submit = find(s.root, n => n.tag === 'button' && textOf(n) === '校验并导入')!;
  await (submit.props.onClick as () => Promise<void>)(); await settle();
  expect(services.importSnapshot).not.toHaveBeenCalled(); expect(await s.leave()).toBe(false);
});
it('does not restore old content when a superseded file finishes after an invalid replacement', async () => {
  const services = client(), s = await mount(services, true); let done!: (value: string) => void;
  const first = chooseFile(s.root, { name: 'first.json', size: 100, text: () => new Promise<string>(resolve => { done = resolve; }) });
  await chooseFile(s.root, { name: 'oversize.json', size: 2 * 1024 * 1024 + 1, text: vi.fn() });
  done(JSON.stringify(fileRequest)); await first; await settle();
  expect(textOf(s.root)).toContain('不能超过 2 MiB');
  const submit = find(s.root, n => n.tag === 'button' && textOf(n) === '校验并导入')!;
  await (submit.props.onClick as () => Promise<void>)(); expect(services.importSnapshot).not.toHaveBeenCalled();
});
it.each(['request', 'revision', 'total'] as const)('keeps pending import and leave protection on a mismatched %s receipt', async mismatch => {
  const services = client(); vi.mocked(services.importSnapshot).mockRejectedValueOnce(new Error('timeout'));
  const s = await mount(services, true);
  await chooseFile(s.root, { name: 'original.json', size: 100, text: async () => JSON.stringify(fileRequest) });
  const submit = find(s.root, n => n.tag === 'button' && textOf(n) === '校验并导入')!;
  await (submit.props.onClick as () => Promise<void>)(); await settle();
  const status = useResourceStatusStore(); expect(status.pendingImport).toEqual(fileRequest);
  vi.mocked(services.getImport).mockResolvedValueOnce({ schema_version: schema, request_id: mismatch === 'request' ? 'wrong-import' : fileRequest.request_id,
    snapshot_id: header.snapshot_id, snapshot_revision: header.snapshot_revision, resource_revision: mismatch === 'revision' ? 'resource-2222222222222222' : revision,
    content_hash: header.content_hash, total: mismatch === 'total' ? 2 : 1, imported_at: header.imported_at, data_origin: header.data_origin });
  await status.verifyImport(); await settle();
  expect(status.pendingImport).toEqual(fileRequest); expect(status.receipt).toBeNull(); expect(status.error).toContain('不符');
  expect(s.imported).not.toHaveBeenCalled(); expect(s.dirty).toHaveBeenLastCalledWith(true); expect(await s.leave()).toBe(false);
});
function directory(items = [header], page = 1): StatusPage<DeviceStatusHeader> {
  return { schema_version: schema, items, total: items.length, page, page_size: 20 };
}
const nextHeader: DeviceStatusHeader = { ...header, snapshot_id: 'DSS-' + 'd'.repeat(32), snapshot_revision: 'device-status-' + 'e'.repeat(64),
  content_hash: 'e'.repeat(64), source_label: '新构造批次', imported_at: '2026-10-24T10:00:00.000000Z' };
function deferredDirectory(services: DeviceStatusClient) {
  let done!: (value: StatusPage<DeviceStatusHeader>) => void;
  vi.mocked(services.listSnapshots).mockImplementationOnce(() => new Promise<StatusPage<DeviceStatusHeader>>(resolve => { done = resolve; }));
  return (value: StatusPage<DeviceStatusHeader>) => done(value);
}
async function clickDirectory(root: HostNode) {
  const button = find(root, n => n.tag === 'button' && textOf(n) === '读取批次')!;
  await (button.props.onClick as () => Promise<void>)(); await settle();
}
it('stages same-page directory in isolation and applies only on an explicit refresh, never selects a new batch', async () => {
  const services = client(), s = await mount(services), status = useResourceStatusStore();
  await status.select(header); await settle();
  status.error = '保留前台错误'; status.notice = '保留前台提示';
  const selectedBatch = status.batch, selectedRecords = status.snapshotRecords, visibleDirectory = status.snapshots;
  const busyEvents = s.busy.mock.calls.length, selectedEvents = s.selected.mock.calls.length;
  const done = deferredDirectory(services), refreshing = s.background();
  expect(s.canBackground()).toBe(false); expect(await s.background()).toBe(false);
  expect(services.listSnapshots).toHaveBeenLastCalledWith({ context: 'ledger', resource_revision: revision, page: 1, page_size: 20 }, { signal: expect.any(AbortSignal) });
  expect(status.busy).toBe(false); expect(s.busy).toHaveBeenCalledTimes(busyEvents);
  expect(find(s.root, n => n.tag === 'button' && textOf(n) === '读取批次')!.props.disabled).toBe(false);
  done(directory([nextHeader, header])); expect(await refreshing).toBe(true); await settle();
  expect(status.snapshots).toBe(visibleDirectory); expect(textOf(s.root)).not.toContain('新构造批次');
  expect(status.error).toBe('保留前台错误'); expect(status.notice).toBe('保留前台提示');
  await clickDirectory(s.root);
  expect(status.snapshots?.items[0]?.snapshot_id).toBe(nextHeader.snapshot_id); expect(textOf(s.root)).toContain('新构造批次');
  expect(status.batch).toBe(selectedBatch); expect(status.snapshotRecords).toBe(selectedRecords);
  expect(s.selected).toHaveBeenCalledTimes(selectedEvents); expect(services.listSnapshots).toHaveBeenCalledTimes(2);
  expect(services.getSnapshot).toHaveBeenCalledTimes(1); expect(services.queryDevices).toHaveBeenCalledTimes(1);
  expect(services.importSnapshot).not.toHaveBeenCalled(); expect(s.imported).not.toHaveBeenCalled(); expect(s.dirty).toHaveBeenLastCalledWith(false);
});
it('background failure preserves foreground directory and messages, and explicit refresh still performs the normal read', async () => {
  const services = client(), s = await mount(services), status = useResourceStatusStore(), previous = status.snapshots;
  status.error = '前台失败'; status.notice = '原提示';
  vi.mocked(services.listSnapshots).mockRejectedValueOnce(new Error('background timeout'));
  expect(await s.background()).toBe(false); expect(s.canBackground()).toBe(true);
  expect(status.snapshots).toBe(previous); expect(status.error).toBe('前台失败'); expect(status.notice).toBe('原提示'); expect(status.busy).toBe(false);
  expect(await s.leave()).toBe(true); await clickDirectory(s.root); expect(services.listSnapshots).toHaveBeenCalledTimes(3);
});
it('a background request never blocks leaving and ignores a late result after leaving', async () => {
  const services = client(), s = await mount(services), status = useResourceStatusStore(), previous = status.snapshots;
  const done = deferredDirectory(services), refreshing = s.background(), signal = vi.mocked(services.listSnapshots).mock.calls.at(-1)![1]?.signal;
  expect(await s.leave()).toBe(true); expect(signal?.aborted).toBe(true);
  done(directory([nextHeader])); expect(await refreshing).toBe(false); expect(status.snapshots).toBe(previous); expect(status.busy).toBe(false);
});
it('uses the current directory page and page size without returning to page one', async () => {
  const services = client(), s = await mount(services), status = useResourceStatusStore();
  status.snapshots = { ...directory(), total: 2, page: 2, page_size: 1 };
  vi.mocked(services.listSnapshots).mockResolvedValueOnce({ ...directory([nextHeader]), total: 2, page: 2, page_size: 1 });
  expect(await s.background()).toBe(true);
  expect(services.listSnapshots).toHaveBeenLastCalledWith({ context: 'ledger', resource_revision: revision, page: 2, page_size: 1 }, { signal: expect.any(AbortSignal) });
  expect(status.snapshots?.items[0]?.snapshot_id).toBe(header.snapshot_id); await clickDirectory(s.root);
  expect(status.snapshots?.page).toBe(2); expect(status.snapshots?.page_size).toBe(1); expect(status.snapshots?.items[0]?.snapshot_id).toBe(nextHeader.snapshot_id);
});
it('skips an already aborted scheduler signal without making a request', async () => {
  const services = client(), s = await mount(services), scheduler = new AbortController(); scheduler.abort();
  expect(await s.background(scheduler.signal)).toBe(false); expect(s.canBackground()).toBe(true); expect(services.listSnapshots).toHaveBeenCalledTimes(1);
});
it('scheduler abort cancels only the background directory and discards its late response', async () => {
  const services = client(), s = await mount(services), status = useResourceStatusStore(), previous = status.snapshots, scheduler = new AbortController();
  const done = deferredDirectory(services), refreshing = s.background(scheduler.signal), signal = vi.mocked(services.listSnapshots).mock.calls.at(-1)![1]?.signal;
  scheduler.abort(); expect(signal?.aborted).toBe(true); expect(status.busy).toBe(false);
  done(directory([nextHeader])); expect(await refreshing).toBe(false); expect(status.snapshots).toBe(previous); expect(await s.leave()).toBe(true);
});
it('an old scheduler abort cannot cancel the foreground snapshot read which superseded it', async () => {
  const services = client(), s = await mount(services), status = useResourceStatusStore(), scheduler = new AbortController();
  const done = deferredDirectory(services), refreshing = s.background(scheduler.signal);
  let finish!: (value: DeviceStatusHeader) => void;
  vi.mocked(services.getSnapshot).mockImplementationOnce(() => new Promise<DeviceStatusHeader>(resolve => { finish = resolve; }));
  const selecting = status.select(header), foregroundSignal = vi.mocked(services.getSnapshot).mock.calls.at(-1)![1]?.signal;
  scheduler.abort(); done(directory([nextHeader])); expect(await refreshing).toBe(false);
  expect(foregroundSignal?.aborted).toBe(false); expect(status.busy).toBe(true);
  finish(header); await selecting; expect(status.batch?.snapshot_id).toBe(header.snapshot_id); expect(status.busy).toBe(false);
});
it.each(['raw', 'file', 'busy', 'pending', 'permission', 'service', 'revision', 'binding', 'disabled', 'query', 'identity-busy'] as const)('skips background directory for gate: %s', async gate => {
  const services = client(), s = await mount(services, true), status = useResourceStatusStore();
  if (gate === 'raw') (find(s.root, n => n.props['aria-label'] === '状态导入 JSON')!.props['onUpdate:modelValue'] as (value: string) => void)('unsaved');
  if (gate === 'file') await chooseFile(s.root, { name: 'unsubmitted.json', size: 0, text: async () => '' });
  if (gate === 'busy') status.busy = true;
  if (gate === 'pending') status.pendingImport = fileRequest;
  if (gate === 'permission') s.auth.identity = { ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(value => value !== 'resources.view') };
  if (gate === 'service') s.state.services = undefined;
  if (gate === 'revision') s.state.resourceRevision = '';
  if (gate === 'binding') status.bind(services, 'resource-2222222222222222');
  if (gate === 'disabled') s.state.enabled = false;
  if (gate === 'query') s.state.queryBusy = true;
  if (gate === 'identity-busy') s.auth.busy = 1;
  await settle(); const calls = vi.mocked(services.listSnapshots).mock.calls.length;
  expect(s.canBackground()).toBe(false); expect(await s.background()).toBe(false); expect(services.listSnapshots).toHaveBeenCalledTimes(calls);
  expect(services.getSnapshot).not.toHaveBeenCalled(); expect(services.queryDevices).not.toHaveBeenCalled();
});
it.each(['revision', 'page', 'page-size'] as const)('does not stage a directory with a mismatched %s response', async mismatch => {
  const services = client(), s = await mount(services), status = useResourceStatusStore(), previous = status.snapshots;
  const value = directory([{ ...nextHeader, resource_revision: mismatch === 'revision' ? 'resource-2222222222222222' : revision }]);
  if (mismatch === 'page') value.page = 2;
  if (mismatch === 'page-size') value.page_size = 1;
  status.error = '保留原错误';
  vi.mocked(services.listSnapshots).mockResolvedValueOnce(value);
  expect(await s.background()).toBe(false); expect(status.snapshots).toBe(previous); expect(status.error).toBe('保留原错误');
  await clickDirectory(s.root); expect(services.listSnapshots).toHaveBeenCalledTimes(3); expect(status.snapshots?.items[0]?.snapshot_id).toBe(header.snapshot_id);
});
it('discards an already staged directory when input becomes dirty and never clears the draft', async () => {
  const services = client(), s = await mount(services, true), status = useResourceStatusStore();
  vi.mocked(services.listSnapshots).mockResolvedValueOnce(directory([nextHeader])); expect(await s.background()).toBe(true);
  const input = find(s.root, n => n.props['aria-label'] === '状态导入 JSON')!;
  (input.props['onUpdate:modelValue'] as (value: string) => void)('unsaved'); await settle(); await clickDirectory(s.root);
  expect(services.listSnapshots).toHaveBeenCalledTimes(3); expect(status.snapshots?.items[0]?.snapshot_id).toBe(header.snapshot_id);
  expect(s.dirty).toHaveBeenLastCalledWith(true); expect(await s.leave()).toBe(false);
});
it('does not start directory refresh while reading a file', async () => {
  const services = client(), s = await mount(services, true); let done!: (value: string) => void;
  const reading = chooseFile(s.root, { name: 'waiting.json', size: 10, text: () => new Promise<string>(resolve => { done = resolve; }) });
  expect(s.canBackground()).toBe(false); expect(await s.background()).toBe(false); expect(services.listSnapshots).toHaveBeenCalledTimes(1);
  done(''); await reading;
});
it.each(['service', 'revision', 'session', 'generation', 'page', 'permission', 'dirty', 'busy', 'pending', 'disabled', 'unmount'] as const)('aborts and discards a late background directory on %s change', async change => {
  const services = client(), s = await mount(services, true), status = useResourceStatusStore();
  const done = deferredDirectory(services), refreshing = s.background(), signal = vi.mocked(services.listSnapshots).mock.calls.at(-1)![1]?.signal;
  if (change === 'service') s.state.services = client();
  if (change === 'revision') {
    const nextRevision = 'resource-2222222222222222';
    vi.mocked(services.listSnapshots).mockResolvedValueOnce(directory([{ ...header, resource_revision: nextRevision }]));
    s.state.resourceRevision = nextRevision;
  }
  if (change === 'session') s.auth.identity = { ...s.auth.identity!, sessionId: 'new-session' };
  if (change === 'generation') s.auth.generation++;
  if (change === 'page') status.snapshots = { ...directory(), total: 21, page: 2 };
  if (change === 'permission') s.auth.identity = { ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(value => value !== 'resources.view') };
  if (change === 'dirty') (find(s.root, n => n.props['aria-label'] === '状态导入 JSON')!.props['onUpdate:modelValue'] as (value: string) => void)('unsaved');
  if (change === 'busy') status.busy = true;
  if (change === 'pending') status.pendingImport = fileRequest;
  if (change === 'disabled') s.state.enabled = false;
  if (change === 'unmount') { app!.unmount(); app = undefined; }
  await settle(); const visibleDirectory = status.snapshots;
  expect(signal?.aborted).toBe(true); done(directory([nextHeader])); expect(await refreshing).toBe(false);
  expect(status.snapshots).toBe(visibleDirectory); expect(s.selected).not.toHaveBeenCalled(); expect(services.getSnapshot).not.toHaveBeenCalled(); expect(services.queryDevices).not.toHaveBeenCalled();
  if (change === 'busy') expect(status.busy).toBe(true);
});
it('retains GIS unknown-state color and cluster behavior independently of status snapshot import', async () => {
  const storage = new TestStorage(), raw = createMockService(() => storage), data = await raw.loadPreview();
  const points = gisDevicePoints(data.resources).points.filter(p => ['DV-0004', 'DV-0005'].includes(p.id));
  points.forEach(row => { row.status = null; row.alert = null; });
  const styles = gisDeviceStyles([points[0]], defaultGisDeviceSettings(), '');
  expect((styles[0].getImage() as any).getStroke().getColor()).toBe(GIS_DEVICE_COLORS.UNKNOWN);
  expect(gisDeviceStyles(points, defaultGisDeviceSettings(), '').some(style => style.getText()?.getText() === '状态/告警未提供 2')).toBe(true);
  const choose = vi.fn(), root = node('root');
  app = renderer.createApp({ render: () => h(GisDeviceClusterPanel, { members: points, disabled: false, onSelect: choose }) }); app.provide(ssrContextKey, {}); app.mount(root);
  expect(textOf(root)).toContain('状态未提供 · 告警未提供');
  const el = find(root, n => n.props['aria-label'] === '查看聚合设备 DV-0004')!; (el.props.onClick as Function)(); expect(choose).toHaveBeenCalledWith('DV-0004');
});

async function changeRefreshMode(root: HostNode, value: 'fixed' | 'latest') {
  const radio = find(root, n => n.tag === 'input' && n.props.type === 'radio' && n.props.value === value)!;
  expect(radio).toBeDefined(); (radio.props.onChange as Function)(); await settle();
}
function serveFollow(services: DeviceStatusClient) {
  vi.mocked(services.listSnapshots).mockResolvedValue(directory([nextHeader, header]));
  vi.mocked(services.getSnapshot).mockImplementation(async input => input.snapshot_id === nextHeader.snapshot_id ? nextHeader : header);
  vi.mocked(services.queryDevices).mockImplementation(async input => ({ schema_version: schema, snapshot_id: input.snapshot_id, snapshot_revision: input.snapshot_revision, resource_revision: revision,
    total: 1, page: input.page ?? 1, page_size: input.page_size ?? 20,
    items: [{ device_id: 'D1', node_id: 'N1', model_id: 'M1', status: null, alert: null, observed_at: null, unknown_reasons: ['缺原始采集时间'], availability: 'ACTIVE' }] }));
}
it('keeps fixed mode by default and exposes checked time without switching the historical selection', async () => {
  const services = client(), s = await mount(services, false, { allowFollow: true }), status = useResourceStatusStore();
  await status.select(header); serveFollow(services);
  expect(status.refreshMode).toBe('fixed'); expect(await s.background()).toBe(true); await settle();
  expect(status.batch?.snapshot_id).toBe(header.snapshot_id); expect(textOf(s.root)).toContain('有待应用的目录检查结果');
  const marker = find(s.root, n => n.props['data-testid'] === 'gis-status-refresh')!;
  expect(marker.props['data-checked-at']).toBeTruthy(); expect(marker.props['data-mode']).toBe('fixed');
});
it('explicitly follows page-one latest and exposes the atomically applied identity and time in the actual template', async () => {
  const services = client(), s = await mount(services, false, { allowFollow: true, completeSnapshot: true }), status = useResourceStatusStore();
  serveFollow(services); await status.select(header); await changeRefreshMode(s.root, 'latest');
  expect(await s.background()).toBe(true); await settle();
  expect(services.listSnapshots).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, resource_revision: revision }), expect.anything());
  expect(services.queryDevices).toHaveBeenLastCalledWith(expect.objectContaining({ page_size: 100 }), expect.anything());
  const marker = find(s.root, n => n.props['data-testid'] === 'gis-status-state')!;
  expect(marker.props['data-snapshot-id']).toBe(nextHeader.snapshot_id); expect(marker.props['data-snapshot-revision']).toBe(nextHeader.snapshot_revision);
  expect(marker.props['data-applied-at']).toBeTruthy(); expect(textOf(marker)).toContain('已读 1/1 台');
  await changeRefreshMode(s.root, 'fixed'); expect(await s.background()).toBe(true); expect(status.refreshMode).toBe('fixed');
});
it('shows a latest-read failure while retaining the old applied version and its time', async () => {
  const services = client(), s = await mount(services, false, { allowFollow: true }), status = useResourceStatusStore();
  await status.select(header); const appliedAt = status.appliedAt; serveFollow(services);
  vi.mocked(services.queryDevices).mockRejectedValueOnce(new Error('latest details failed'));
  await changeRefreshMode(s.root, 'latest'); expect(await s.background()).toBe(false); await settle();
  expect(textOf(s.root)).toContain('latest details failed'); expect(status.batch?.snapshot_id).toBe(header.snapshot_id); expect(status.appliedAt).toBe(appliedAt);
  expect(await s.background()).toBe(true); await settle(); expect(textOf(s.root)).not.toContain('latest details failed');
});
it('an explicit historical batch selection ends following; unsupported or paused hosts do not start it', async () => {
  const services = client(), s = await mount(services, false, { allowFollow: true }), status = useResourceStatusStore(); serveFollow(services);
  await changeRefreshMode(s.root, 'latest'); expect(await s.background()).toBe(true); await settle();
  const historical = find(s.root, n => n.tag === 'button' && textOf(n) === header.source_label)!;
  await (historical.props.onClick as Function)(); await settle(); expect(status.refreshMode).toBe('fixed'); expect(status.batch?.snapshot_id).toBe(header.snapshot_id);
  s.state.backgroundEnabled = false; await settle(); expect(await s.background()).toBe(false);
  s.state.allowFollow = false; await settle(); expect(find(s.root, n => n.props['aria-label'] === '状态刷新方式')).toBeUndefined();
});

