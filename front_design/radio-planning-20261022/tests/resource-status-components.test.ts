import { afterEach, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
import Panel from '../src/components/ResourceStatusPanel.vue';
import { deviceStatusSchema as schema, type DeviceStatusHeader, type DeviceStatusImport } from '../src/types/device-status-snapshot';
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
afterEach(() => { app?.unmount(); if (pinia) disposePinia(pinia); vi.restoreAllMocks(); });
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
async function mount(services?: DeviceStatusClient, allowImport = false) {
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore();
  const permissions = auth.identity!.permissions as string[];
  if (!permissions.includes('resources.device.status.import')) permissions.push('resources.device.status.import');
  const selected = vi.fn(), root = node('root');
  const dirty = vi.fn(), busy = vi.fn(), imported = vi.fn();
  let exposed!: { requestLeave(): Promise<boolean> };
  app = renderer.createApp({ render: () => h(Panel, { resourceRevision: revision, total: null, services, allowImport,
    ref: value => { exposed = value as unknown as typeof exposed; }, 'onSnapshot-selected': selected, onDirty: dirty, onBusy: busy, onImported: imported }) });
  app.use(pinia); app.provide(ssrContextKey, {}); app.mount(root); await settle(); return { root, selected, dirty, busy, imported, leave: () => exposed.requestLeave() };
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

