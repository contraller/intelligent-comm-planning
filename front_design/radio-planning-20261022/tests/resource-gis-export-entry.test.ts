import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import Papa from 'papaparse';
import Drawer from '../src/components/ResourceExportDrawer.vue';
import { createResourceExportHttp } from '../src/services/resource-export-http';
import { useAuthStore } from '../src/stores/auth';
import type { ResourceExportRequest, ResourceKind } from '../src/types/resource-edit';
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
await clientTemplate(Drawer, 'src/components/ResourceExportDrawer.vue', 'resource-gis-export-entry-render.ts');
const revision = 'resource-0123456789abcdef';
type GisScope = NonNullable<ResourceExportRequest['gis']>;
interface Props {
  visible: boolean; context: 'gis' | 'ledger'; gisQuery?: Omit<GisScope, 'range' | 'selectedIds'>;
  selectedIds?: Partial<Record<ResourceKind, string[]>>; filteredIds?: Partial<Record<ResourceKind, string[]>>;
  candidateSelectedIds?: string[]; candidateFilteredIds?: string[];
}
interface Payload {
  revision: string; format: string; kinds: ResourceKind[]; range: string; browse: string;
  selected_ids?: Partial<Record<ResourceKind, string[]>>; filter?: Record<string, unknown>;
}
function ids(payload: Payload, kind: ResourceKind): string[] {
  if (payload.range === 'selected') return payload.selected_ids?.[kind] ?? [];
  if (kind === 'topology_links' && payload.range === 'filtered' && payload.filter?.alert === 'YES') return [];
  return kind === 'devices' ? ['D1', 'D2'] : kind === 'topology_links' ? ['L1', 'L2'] : kind === 'nodes' ? ['N1'] : ['I1'];
}
function inspection(payload: Payload) {
  return { revision: payload.revision, data_origin: 'SYNTHETIC_INTEGRATION', source: '构造资源',
    tables: payload.kinds.map(kind => ({ kind, count: ids(payload, kind).length })), added: 0,
    warnings: ['构造来源说明：' + payload.revision, '冻结参考不代表当前算法评估。'] };
}
function csv(payload: Payload) {
  const kind = payload.kinds[0]!;
  const headers = (kind === 'topology_links'
    ? 'link_id,node_a_id,node_b_id,device_a_id,device_b_id,device_class,freq_khz,bandwidth_khz,distance_m,path_loss_db,rx_power_dbm,link_margin_db,is_available,link_state,is_backup'
    : 'device_id,node_id,model_id,antenna_id,antenna_height_m,tilt_deg,azimuth_deg,tx_power_dbm,work_freq_khz,status,install_time,availability').split(',');
  return new Blob([Papa.unparse([headers, ...ids(payload, kind).map(id => headers.map((_, i) => i === 0 ? id : ''))])], { type: 'text/csv' });
}
let app: App<HostNode> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function settle() { for (let i = 0; i < 20; i++) await nextTick(); }
async function mountDrawer(missing: 'resources.view' | 'situation.view' | null = null, initial: Partial<Props> = {}) {
  class HostDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', HostDocument); vi.stubGlobal('document', new HostDocument());
  pinia = createPinia(); setActivePinia(pinia); const auth = useAuthStore();
  auth.accept({ sessionId: 'gis-export', id: 'reader', username: 'reader', name: '测试读取者', roleId: 'reader', roleName: 'reader', epoch: 'test', revision: 'identity-1',
    permissions: (['resources.view', 'situation.view'] as const).filter(value => value !== missing) });
  service.getSession.mockImplementation(async () => auth.identity);
  const request = vi.fn().mockImplementation(async (path: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as Payload;
    return path.endsWith('/preview') ? inspection(payload) : csv(payload);
  });
  const api = createResourceExportHttp(request);
  service.previewResourceExport.mockImplementation(api.previewResourceExport); service.exportResources.mockImplementation(api.exportResources);
  const props = reactive<Props>({ visible: true, context: 'gis', gisQuery: { revision, browse: 'devices', filter: { search: '设备', status: 'FAULT', alert: 'NO',
    deviceClass: 'HF', availability: 'ACTIVE', relayCapable: false, frequency: { mode: 'MODEL', presence: 'ALL', minKhz: 0, maxKhz: 3000 } } },
    selectedIds: { devices: ['D1'], nodes: ['N1'] }, filteredIds: { devices: ['CURRENT-PAGE-ONLY'] },
    candidateFilteredIds: ['CURRENT-PAGE-LINK'], ...initial });
  app = renderer.createApp({ render: () => h(Drawer, props) }); app.use(pinia); app.provide(ssrContextKey, {});
  const root = node('root'); app.mount(root); await settle(); return { props, root, request, auth };
}
type Fixture = Awaited<ReturnType<typeof mountDrawer>>;
const payloads = (f: Fixture) => f.request.mock.calls.map(call => JSON.parse(String(call[1].body)) as Payload);
function button(root: HostNode, label = '下载文件') {
  const found = find(root, value => value.tag === 'button' && textOf(value).trim() === label); expect(found, label).toBeDefined(); return found!;
}
async function click(root: HostNode, label = '下载文件') { await (button(root, label).props.onClick as () => unknown)(); await settle(); }
async function choose(root: HostNode, label: string, value: string) {
  const parent = find(root, item => item.tag === 'label' && textOf(item).trim().startsWith(label)); expect(parent).toBeDefined();
  const control = find(parent!, item => item.tag === 'select'); expect(control).toBeDefined();
  (control!.props['onUpdate:modelValue'] as (value: string) => void)(value); await settle();
}

describe('GIS export drawer entry', () => {
  it.each(['all', 'filtered', 'selected'] as const)('builds the mutually exclusive %s scope from the saved query', async range => {
    const f = await mountDrawer(); await choose(f.root, '数据范围', range);
    const payload = payloads(f).at(-1)!;
    expect(payload).toMatchObject({ context: 'gis', revision, browse: 'devices', range });
    if (range === 'filtered') expect(payload.filter).toEqual({ search: '设备', status: 'FAULT', alert: 'NO', device_class: 'HF', availability: 'ACTIVE',
      relay_capable: false, frequency: { mode: 'MODEL', presence: 'ALL', min_khz: 0, max_khz: 3000 } });
    else expect(payload).not.toHaveProperty('filter');
    if (range === 'selected') expect(payload.selected_ids).toEqual({ nodes: ['N1'], devices: ['D1'], interference_sources: [] });
    else expect(payload).not.toHaveProperty('selected_ids');
    expect(JSON.stringify(payload)).not.toContain('CURRENT-PAGE'); expect(textOf(f.root)).toContain(revision);
    expect(textOf(f.root)).toContain('状态来源：台账基线'); expect(button(f.root).props.disabled).toBe(false);
  });
  it('shows the station predicate/all-owned-devices semantics without replacing the filter', async () => {
    const f = await mountDrawer(null, { gisQuery: { revision, browse: 'stations', filter: { search: '站点', status: 'NORMAL', relayCapable: false } } });
    await choose(f.root, '数据范围', 'filtered');
    expect(payloads(f).at(-1)).toMatchObject({ browse: 'stations', filter: { search: '站点', status: 'NORMAL', relay_capable: false } });
    expect(textOf(f.root)).toContain('再取命中站点的全部设备'); expect(textOf(f.root)).toContain('干扰源仅使用自身搜索条件');
  });
  it.each(['resources.view', 'situation.view'] as const)('requires %s before preview and download', async missing => {
    const f = await mountDrawer(missing); expect(f.request).not.toHaveBeenCalled(); expect(button(f.root).props.disabled).toBe(true);
    await click(f.root); expect(service.exportResources).not.toHaveBeenCalled();
  });
  it('refuses to use paged ids when a saved GIS version is missing', async () => {
    const f = await mountDrawer(null, { gisQuery: undefined });
    expect(textOf(f.root)).toContain('尚无已保存资源版本'); expect(f.request).not.toHaveBeenCalled();
    await click(f.root); expect(service.exportResources).not.toHaveBeenCalled();
  });
  it('downloads only requested selection buckets and leaves other categories empty', async () => {
    const f = await mountDrawer(); await choose(f.root, '文件格式', 'csv'); await choose(f.root, '数据范围', 'selected'); await click(f.root);
    expect(payloads(f).at(-1)).toMatchObject({ kinds: ['devices'], selected_ids: { devices: ['D1'] } }); expect(fileDownload).toHaveBeenCalledOnce();
  });
  it('keeps candidate all and selected dedicated, without inheriting resource filters', async () => {
    const f = await mountDrawer(null, { candidateSelectedIds: ['L1'] }); await choose(f.root, '导出内容', 'candidates'); await choose(f.root, '文件格式', 'csv');
    await choose(f.root, '数据范围', 'all'); expect(payloads(f).at(-1)).toMatchObject({ kinds: ['topology_links'], range: 'all' });
    expect(payloads(f).at(-1)).not.toHaveProperty('filter'); await choose(f.root, '数据范围', 'selected'); await click(f.root);
    expect(payloads(f).at(-1)).toMatchObject({ kinds: ['topology_links'], selected_ids: { topology_links: ['L1'] } }); expect(fileDownload).toHaveBeenCalledOnce();
  });
  it('rejects unsupported candidate conditions visibly, without pruning or fallback', async () => {
    const f = await mountDrawer(); await choose(f.root, '导出内容', 'candidates'); const calls = f.request.mock.calls.length;
    await choose(f.root, '数据范围', 'filtered'); expect(f.request).toHaveBeenCalledTimes(calls);
    expect(textOf(f.root)).toContain('候选链路筛选导出仅支持'); expect(button(f.root).props.disabled).toBe(true);
    await click(f.root); expect(service.exportResources).not.toHaveBeenCalled();
    expect(f.props.gisQuery!.filter!.status).toBe('FAULT');
  });
  it('exports an empty candidate alert YES filter from the full query, not paged ids', async () => {
    const f = await mountDrawer(null, { gisQuery: { revision, browse: 'devices', filter: { search: 'LINK', deviceClass: 'HF', alert: 'YES' } } });
    await choose(f.root, '导出内容', 'candidates'); await choose(f.root, '文件格式', 'csv'); await choose(f.root, '数据范围', 'filtered'); await click(f.root);
    expect(payloads(f).at(-1)).toMatchObject({ filter: { search: 'LINK', device_class: 'HF', alert: 'YES' } });
    expect(payloads(f).at(-1)).not.toHaveProperty('selected_ids'); expect(textOf(f.root)).toContain('0'); expect(fileDownload).toHaveBeenCalledOnce();
  });
  it('clears failed preflight counts and requires a successful retry before download', async () => {
    const f = await mountDrawer(); f.request.mockRejectedValueOnce(new ApiError('资源版本已变化', 1205));
    f.props.gisQuery = { ...f.props.gisQuery!, revision: 'resource-new' }; await settle();
    expect(textOf(f.root)).toContain('资源版本已变化'); expect(button(f.root).props.disabled).toBe(true);
    await click(f.root); expect(service.exportResources).not.toHaveBeenCalled(); await click(f.root, '重试预检'); expect(button(f.root).props.disabled).toBe(false);
  });
  it('shows every backend warning and clears old warnings when the query fails', async () => {
    const f = await mountDrawer();
    expect(textOf(f.root)).toContain('构造来源说明：' + revision); expect(textOf(f.root)).toContain('冻结参考不代表当前算法评估。');
    f.request.mockImplementationOnce(async (_path: string, init: RequestInit) => ({ ...inspection(JSON.parse(String(init.body))), warnings: [12] }));
    f.props.gisQuery = { ...f.props.gisQuery!, revision: 'resource-new' }; await settle();
    expect(button(f.root).props.disabled).toBe(true); expect(textOf(f.root)).not.toContain('冻结参考不代表当前算法评估。');
    expect(textOf(f.root)).not.toContain('构造来源说明：' + revision);
    await click(f.root, '重试预检'); expect(textOf(f.root)).toContain('构造来源说明：resource-new');
  });
  it('does not let a late preview replace a newer query', async () => {
    const f = await mountDrawer(); let resolve!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.props.gisQuery = { ...f.props.gisQuery!, revision: 'resource-old' }; await settle(); const old = payloads(f).at(-1)!;
    f.props.gisQuery = { ...f.props.gisQuery!, revision: 'resource-new' }; await settle();
    resolve(inspection(old)); await settle(); expect(textOf(f.root)).toContain('resource-new'); expect(textOf(f.root)).not.toContain('resource-old');
    expect(button(f.root).props.disabled).toBe(false);
  });
  it.each(['query', 'identity', 'unmount'] as const)('drops a late file after %s changes', async change => {
    const f = await mountDrawer(); await choose(f.root, '文件格式', 'csv');
    let resolve!: (value: Blob) => void, downloadPayload!: Payload;
    f.request.mockImplementation((path: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as Payload;
      if (path.endsWith('/preview')) return Promise.resolve(inspection(payload));
      downloadPayload = payload; return new Promise<Blob>(done => { resolve = done; });
    });
    const pending = click(f.root); await settle();
    if (change === 'query') f.props.gisQuery = { ...f.props.gisQuery!, revision: 'resource-new' };
    if (change === 'identity') f.auth.generation++;
    if (change === 'unmount') { app!.unmount(); app = undefined; }
    await settle(); resolve(csv(downloadPayload)); await pending; expect(fileDownload).not.toHaveBeenCalled();
  });
  it('invalidates the preview if the returned file fails validation', async () => {
    const f = await mountDrawer(); await choose(f.root, '文件格式', 'csv');
    f.request.mockImplementation(async (path: string, init: RequestInit) => path.endsWith('/preview') ? inspection(JSON.parse(String(init.body))) : new Blob(['{}'], { type: 'text/csv' }));
    await click(f.root); expect(button(f.root).props.disabled).toBe(true); expect(textOf(f.root)).toContain('资源导出响应不符合契约'); expect(fileDownload).not.toHaveBeenCalled();
  });
});
