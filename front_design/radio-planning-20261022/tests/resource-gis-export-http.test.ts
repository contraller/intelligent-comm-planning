import { describe, expect, it, vi } from 'vitest';
import Papa from 'papaparse';
import Excel from 'exceljs';
import { createResourceExportHttp } from '../src/services/resource-export-http';
import { ApiError } from '../src/services/types';
import type { ResourceExportRequest, ResourceKind } from '../src/types/resource-edit';

const revision = 'resource-0123456789abcdef';
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const warnings = ['仅已保存构造资源，非实测。', '状态不包含临时同步观测。'];
const headers = {
  nodes: 'node_id,node_name,echelon,node_subtype,parent_node_id,node_role,mobility,lon,lat,elevation_m,region,device_class,relay_capable,status,is_key,remark'.split(','),
  devices: 'device_id,node_id,model_id,antenna_id,antenna_height_m,tilt_deg,azimuth_deg,tx_power_dbm,work_freq_khz,status,install_time,availability'.split(','),
  interference_sources: 'interference_id,name,lon,lat,elevation_m,antenna_height_m,center_freq_khz,bandwidth_khz,tx_power_dbm,antenna_gain_dbi,interference_type,pattern_type,azimuth_deg,duty_cycle,active'.split(','),
  topology_links: 'link_id,node_a_id,node_b_id,device_a_id,device_b_id,device_class,freq_khz,bandwidth_khz,distance_m,path_loss_db,rx_power_dbm,link_margin_db,is_available,link_state,is_backup'.split(','),
};
function input(kind: ResourceKind = 'devices'): ResourceExportRequest {
  return { context: 'gis', format: 'csv', kinds: [kind], gis: { revision, range: 'all', browse: 'devices' } };
}
function preview(q: ResourceExportRequest = input(), total = 1, added = 0) {
  return { revision, data_origin: 'SYNTHETIC_INTEGRATION', source: '构造联调，非实测', tables: q.kinds.map(kind => ({ kind, count: total })), added, warnings: [...warnings] };
}
function csv(kind: ResourceKind = 'devices', ids = ['D1']) {
  return new Blob([Papa.unparse([headers[kind], ...ids.map(id => headers[kind].map((_, i) => i === 0 ? id : ''))])], { type: 'text/csv' });
}
function fixture(q = input(), file = csv(), inspection: unknown = preview(q)) {
  const request = vi.fn().mockImplementation(async (path: string) => path.endsWith('/preview') ? inspection : file);
  return { request, api: createResourceExportHttp(request) };
}
async function workbook(q: ResourceExportRequest, ids = ['D1'], patch?: (book: Excel.Workbook) => void) {
  const book = new Excel.Workbook();
  for (const kind of q.kinds) {
    const sheet = book.addWorksheet(kind); sheet.addRow(headers[kind]);
    for (const id of ids) sheet.addRow(headers[kind].map((_, i) => i === 0 ? id : null));
  }
  const notes = book.addWorksheet('说明');
  notes.addRows([['资源版本', revision], ['数据来源', 'SYNTHETIC_INTEGRATION'], ['导出范围', q.gis!.range], ['补齐上级节点数', 0], ['浏览方式', q.gis!.browse],
    ...warnings.map(warning => ['范围与来源说明', warning])]);
  if (q.kinds[0] === 'topology_links') {
    notes.addRow(['参考边界', '冻结参考不拼接到当前待评估配置']);
    notes.addRow(['link_id', 'assessment_state', 'source_json', 'reference_json']);
    for (const id of ids) notes.addRow([id, 'PENDING', JSON.stringify({ kind: 'MANUAL', file: null, row: null }), 'null']);
  }
  patch?.(book);
  return new Blob([new Uint8Array(await book.xlsx.writeBuffer())], { type: mime });
}
const payload = (f: ReturnType<typeof fixture>, index = 0) => JSON.parse(String(f.request.mock.calls[index]?.[1]?.body));

describe('GIS resource export HTTP contract', () => {
  it.each(['devices', 'stations'] as const)('sends an explicit GIS all request for %s without filter or ids', async browse => {
    const q = input(); q.gis!.browse = browse; const f = fixture(q);
    expect(await f.api.previewResourceExport(q)).toEqual({ tables: [{ kind: 'devices', count: 1 }], added: 0, warnings });
    expect(payload(f)).toEqual({ context: 'gis', revision, format: 'csv', kinds: ['devices'], range: 'all', browse });
    expect(f.request.mock.calls[0]?.[0]).toBe('/resource/export/preview');
    expect(f.request.mock.calls[0]?.[2]).toBe('json');
  });
  it('maps every filtered device condition without dropping zero or false', async () => {
    const q = input(); q.gis = { revision, range: 'filtered', browse: 'devices', filter: { search: '设备', deviceClass: 'HF', status: 'UNKNOWN', availability: 'OFF_SHELF',
      alert: 'NO', mobility: 'FIXED', nodeRole: 'RELAY', relayCapable: false, frequency: { mode: 'MODEL', presence: 'ALL', minKhz: 0, maxKhz: 3000 } } };
    const f = fixture(q); await f.api.previewResourceExport(q);
    expect(payload(f).filter).toEqual({ search: '设备', device_class: 'HF', status: 'UNKNOWN', availability: 'OFF_SHELF', alert: 'NO',
      mobility: 'FIXED', node_role: 'RELAY', relay_capable: false, frequency: { mode: 'MODEL', presence: 'ALL', min_khz: 0, max_khz: 3000 } });
    expect(payload(f)).not.toHaveProperty('selected_ids');
  });
  it('keeps station browse explicit and sends shared node predicates', async () => {
    const q = input('nodes'); q.gis = { revision, range: 'filtered', browse: 'stations', filter: { search: '站点', status: 'NORMAL', alert: 'UNKNOWN',
      deviceClass: 'VUHF', mobility: 'MOBILE', nodeRole: 'RELAY', relayCapable: false } };
    const f = fixture(q); await f.api.previewResourceExport(q);
    expect(payload(f)).toMatchObject({ browse: 'stations', filter: { search: '站点', status: 'NORMAL', alert: 'UNKNOWN', device_class: 'VUHF', mobility: 'MOBILE', node_role: 'RELAY', relay_capable: false } });
  });
  it.each([{}, { devices: [] }, { devices: ['D1'] }])('requires a nonempty overall selection, never falling back to all: %j', async selectedIds => {
    const q = input(); q.gis = { revision, browse: 'devices', range: 'selected', selectedIds };
    const f = fixture(q, csv('devices', selectedIds.devices ?? []), preview(q, selectedIds.devices?.length ?? 0));
    if (!selectedIds.devices?.length) {
      await expect(f.api.exportResources(q)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(f.request).not.toHaveBeenCalled(); return;
    }
    await f.api.exportResources(q);
    expect(payload(f)).toMatchObject({ range: 'selected', selected_ids: selectedIds });
    expect(payload(f)).not.toHaveProperty('filter'); expect(payload(f, 1)).toEqual(payload(f));
  });
  it('allows XLSX ancestor closure but binds added to the node bucket', async () => {
    const q = input('nodes'); q.format = 'xlsx'; q.kinds = ['devices', 'nodes'];
    q.gis = { revision, browse: 'devices', range: 'selected', selectedIds: { devices: ['D1'] } };
    const f = fixture(q, undefined, { ...preview(q), tables: [{ kind: 'devices', count: 1 }, { kind: 'nodes', count: 2 }], added: 2 });
    expect((await f.api.previewResourceExport(q)).added).toBe(2);
    expect(payload(f).selected_ids).toEqual({ devices: ['D1'] });
  });
  it.each([
    { gis: undefined }, { ledger: { revision, range: 'all' } }, { ids: { devices: ['D1'] } }, { actor: 'admin' },
    { kinds: [] }, { kinds: {} }, { kinds: ['devices', 'devices'] }, { kinds: ['missing'] }, { kinds: ['nodes', 'devices'] },
    { format: 'pdf' }, { format: 'xlsx', kinds: ['topology_links', 'nodes'] },
    { gis: { revision, browse: 'devices', range: 'all', filter: {} } },
    { gis: { revision, browse: 'devices', range: 'all', selectedIds: {} } },
    { gis: { revision, browse: 'devices', range: 'filtered' } },
    { gis: { revision, browse: 'devices', range: 'filtered', filter: {}, selectedIds: {} } },
    { gis: { revision, browse: 'devices', range: 'selected', selectedIds: {}, filter: {} } },
    { gis: { revision, browse: 'devices', range: 'selected', selectedIds: { devices: ['D1', 'D1'] } } },
    { gis: { revision, browse: 'devices', range: 'selected', selectedIds: { devices: Array.from({ length: 51 }, (_, i) => `D${i}`) } } },
    { gis: { revision, browse: 'devices', range: 'selected', selectedIds: { nodes: ['N1'] } } },
    { gis: { revision, browse: 'devices', range: 'filtered', filter: { statusMode: 'observed', observationSnapshotId: 'SS1' } } },
    { gis: { revision, browse: 'stations', range: 'filtered', filter: { relayCapable: 'false' } } },
    { gis: { revision, browse: 'devices', range: 'filtered', filter: { frequency: { mode: 'ALL', presence: 'ALL', minKhz: 1, maxKhz: null } } } },
    { gis: { revision, browse: 'devices', range: 'all', viewport: [1, 2, 3, 4] } },
  ])('rejects an invalid scope before HTTP: %j', async patch => {
    const f = fixture(); await expect(f.api.previewResourceExport({ ...input(), ...patch } as ResourceExportRequest)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([{ status: 'FAULT' }, { availability: 'ACTIVE' }, { mobility: 'FIXED' }, { nodeRole: 'RELAY' }, { relayCapable: false },
    { frequency: { mode: 'ALL', presence: 'ALL', minKhz: null, maxKhz: null } }])('rejects unsupported candidate filters without silently pruning: %j', async filter => {
    const q = input('topology_links'); q.gis = { revision, browse: 'devices', range: 'filtered', filter: filter as NonNullable<ResourceExportRequest['gis']>['filter'] };
    const f = fixture(q); await expect(f.api.exportResources(q)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(f.request).not.toHaveBeenCalled();
  });
  it('exports the dedicated candidate file, with alert YES explicitly empty', async () => {
    const q = input('topology_links'); q.gis = { revision, browse: 'stations', range: 'filtered', filter: { search: 'LINK', deviceClass: 'HF', alert: 'YES' } };
    const f = fixture(q, csv('topology_links', []), preview(q, 0)); await f.api.exportResources(q);
    expect(payload(f)).toMatchObject({ context: 'gis', kinds: ['topology_links'], filter: { search: 'LINK', device_class: 'HF', alert: 'YES' } });
  });
  it.each(['NO', 'UNKNOWN'] as const)('rejects unsupported candidate alert %s without dropping it', async alert => {
    const q = input('topology_links'); q.gis = { revision, browse: 'devices', range: 'filtered', filter: { alert } };
    const f = fixture(q); await expect(f.api.previewResourceExport(q)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(f.request).not.toHaveBeenCalled();
  });
  it.each([{ revision: 'other' }, { data_origin: 'MEASURED' }, { source: '' }, { tables: [] }, { tables: [{ kind: 'nodes', count: 1 }] },
    { tables: [{ kind: 'devices', count: -1 }] }, { added: 1 }, { observation: {} }])('rejects an invalid preview and does not fetch a file: %j', async patch => {
    const f = fixture(input(), csv(), { ...preview(), ...patch });
    await expect(f.api.exportResources(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' }); expect(f.request).toHaveBeenCalledOnce();
  });
  it('rejects a selected preview that has fallen back to all', async () => {
    const q = input(); q.gis = { revision, browse: 'devices', range: 'selected', selectedIds: { devices: ['D1'] } };
    const f = fixture(q, csv(), preview(q, 2)); await expect(f.api.exportResources(q)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' }); expect(f.request).toHaveBeenCalledOnce();
  });
  it.each(['nodes', 'devices', 'interference_sources', 'topology_links'] as const)('accepts the exact %s CSV contract after fresh preflight', async kind => {
    const q = input(kind), f = fixture(q, csv(kind)); const file = await f.api.exportResources(q);
    expect(file.mime).toBe('text/csv'); expect(f.request.mock.calls.map(call => call[0])).toEqual(['/resource/export/preview', '/resource/export']);
  });
  it.each([
    new Blob(['device_id,node_id\r\nD1,N1\r\n'], { type: 'text/csv' }),
    csv('nodes'), csv('devices', []), csv('devices', ['D1', 'D1']),
    new Blob(['{}'], { type: 'application/json' }),
  ])('rejects malformed CSV content or a preview/file mismatch', async file => {
    const f = fixture(input(), file); await expect(f.api.exportResources(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it('rejects a same-count CSV with different selected ids', async () => {
    const q = input(); q.gis = { revision, browse: 'devices', range: 'selected', selectedIds: { devices: ['D1'] } };
    await expect(fixture(q, csv('devices', ['D2'])).api.exportResources(q)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it.each(['devices', 'topology_links'] as const)('validates a real %s XLSX including version notes', async kind => {
    const q = input(kind); q.format = 'xlsx'; const f = fixture(q, await workbook(q));
    expect((await f.api.exportResources(q)).mime).toBe(mime);
  });
  it('validates the actual XLSX owning/ancestor closure while leaving the unselected interference bucket empty', async () => {
    const q = input(); q.format = 'xlsx'; q.kinds = ['devices', 'nodes', 'interference_sources'];
    q.gis = { revision, browse: 'devices', range: 'selected', selectedIds: { devices: ['D1'] } };
    const file = await workbook(q, ['D1'], book => {
      const nodes = book.getWorksheet('nodes')!;
      nodes.getCell('A2').value = 'N1'; nodes.addRow(['P1']);
      book.getWorksheet('interference_sources')!.spliceRows(2, 1);
      book.getWorksheet('说明')!.getCell('B4').value = 2;
    });
    const f = fixture(q, file, { ...preview(q), tables: [{ kind: 'devices', count: 1 }, { kind: 'nodes', count: 2 }, { kind: 'interference_sources', count: 0 }], added: 2 });
    expect((await f.api.exportResources(q)).mime).toBe(mime);
  });
  it.each(['revision', 'origin', 'range', 'added', 'header', 'count', 'extra-sheet'] as const)('rejects an XLSX %s mismatch', async problem => {
    const q = input(); q.format = 'xlsx';
    const file = await workbook(q, ['D1'], book => {
      const notes = book.getWorksheet('说明')!, sheet = book.getWorksheet('devices')!;
      if (problem === 'revision') notes.getCell('B1').value = 'other';
      if (problem === 'origin') notes.getCell('B2').value = 'MEASURED';
      if (problem === 'range') notes.getCell('B3').value = 'filtered';
      if (problem === 'added') notes.getCell('B4').value = 1;
      if (problem === 'header') sheet.getCell('A1').value = 'node_id';
      if (problem === 'count') sheet.addRow(['D2']);
      if (problem === 'extra-sheet') book.addWorksheet('unexpected');
    });
    await expect(fixture(q, file).api.exportResources(q)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it('does not accept a ZIP signature as an XLSX workbook', async () => {
    const q = input(); q.format = 'xlsx';
    await expect(fixture(q, new Blob([new Uint8Array([80, 75, 3, 4, 0])], { type: mime })).api.exportResources(q)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it.each([undefined, null, {}, 'warning', [1], ['']])('rejects malformed GIS warnings before file download: %j', async value => {
    const f = fixture(input(), csv(), { ...preview(), warnings: value });
    await expect(f.api.exportResources(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' }); expect(f.request).toHaveBeenCalledOnce();
  });
  it('preserves warnings verbatim and accepts an explicit empty warning list', async () => {
    const messages = ['来源：构造数据', '<script>not markup</script>'];
    const result = await fixture(input(), csv(), { ...preview(), warnings: messages }).api.previewResourceExport(input());
    expect(result.warnings).toEqual(messages); expect(result.warnings).not.toBe(messages);
    expect((await fixture(input(), csv(), { ...preview(), warnings: [] }).api.previewResourceExport(input())).warnings).toEqual([]);
  });
  it('accepts repeated warning rows and a frozen candidate reference without rewriting bytes', async () => {
    const q = input('topology_links'); q.format = 'xlsx';
    const file = await workbook(q, ['L1'], book => {
      const row = book.getWorksheet('说明')!.lastRow!;
      row.getCell(3).value = JSON.stringify({ kind: 'IMPORT', file: 'external.csv', row: 2 });
      row.getCell(4).value = JSON.stringify({ data: { id: 'L1', nodeAId: 'frozen-old-node' }, source: { kind: 'SOURCE', file: 'original.csv', row: 3 } });
    });
    const result = await fixture(q, file).api.exportResources(q);
    expect(result.bytes).toEqual(new Uint8Array(await file.arrayBuffer()));
  });
  it.each(['warnings', 'source-json', 'reference-json', 'reference-id', 'reference-missing'] as const)('rejects an XLSX %s contract mismatch', async problem => {
    const q = input('topology_links'); q.format = 'xlsx';
    const file = await workbook(q, ['L1'], book => {
      const notes = book.getWorksheet('说明')!, row = notes.lastRow!;
      if (problem === 'warnings') notes.getCell('B6').value = 'wrong source warning';
      if (problem === 'source-json') row.getCell(3).value = 'not JSON';
      if (problem === 'reference-json') row.getCell(4).value = '[]';
      if (problem === 'reference-id') row.getCell(1).value = 'other-link';
      if (problem === 'reference-missing') notes.spliceRows(notes.rowCount, 1);
    });
    await expect(fixture(q, file).api.exportResources(q)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it('freezes query, selected buckets and format before awaiting preflight', async () => {
    const q = input(); q.gis = { revision, browse: 'devices', range: 'selected', selectedIds: { devices: ['D1'] } };
    let resolve!: (value: unknown) => void;
    const f = fixture(q); f.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.api.exportResources(q); q.format = 'xlsx'; q.gis.selectedIds!.devices!.push('D2'); q.kinds[0] = 'nodes';
    resolve(preview(input())); const file = await pending;
    expect(file.mime).toBe('text/csv'); expect(payload(f, 1)).toEqual(payload(f)); expect(payload(f).selected_ids.devices).toEqual(['D1']);
  });
  it('preserves a version conflict without issuing a download or fallback', async () => {
    const f = fixture(); f.request.mockRejectedValueOnce(new ApiError('版本已变化', 1205, null, 'gis-trace', 409));
    await expect(f.api.exportResources(input())).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CHANGED', requestId: 'gis-trace' }); expect(f.request).toHaveBeenCalledOnce();
  });
});
