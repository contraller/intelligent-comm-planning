import { describe, expect, it, vi } from 'vitest';
import Papa from 'papaparse';
import Excel from 'exceljs';
import { createResourceExportHttp } from '../src/services/resource-export-http';
import type { ResourceExportRequest } from '../src/types/resource-edit';
import { ApiError } from '../src/services/types';

const revision = 'resource-0123456789abcdef', snapshotId = 'selected-status-snapshot';
const source = { snapshot_id: snapshotId, snapshot_revision: 'device-status-' + 'a'.repeat(64), resource_revision: revision,
  data_origin: 'SYNTHETIC_INTEGRATION', source_label: '构造来源，非实测' };
const deviceHeaders = 'device_id,node_id,model_id,antenna_id,antenna_height_m,tilt_deg,azimuth_deg,tx_power_dbm,work_freq_khz,status,install_time,availability'.split(',');
const nodeHeaders = 'node_id,node_name,echelon,node_subtype,parent_node_id,node_role,mobility,lon,lat,elevation_m,region,device_class,relay_capable,status,is_key,remark'.split(',');
const metadata = { status_mode: 'observed', ...source, node_status_mode: 'baseline' };
const observedHeaders = [...deviceHeaders, 'alert', 'observed_at', 'record_kind', ...Object.keys(metadata)];
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
function input(range: 'all' | 'selected' | 'filtered' = 'filtered'): ResourceExportRequest {
  return { context: 'ledger', format: 'csv', kinds: ['devices'], ledger: { revision, range,
    filter: { statusMode: 'observed', observationSnapshotId: snapshotId, ...(range === 'filtered' ? { status: 'FAULT' } : {}) },
    ...(range === 'selected' ? { selectedIds: ['DV-1'] } : {}) } };
}
function preview(total = 1, nodes = false) {
  return { revision, data_origin: 'SYNTHETIC_INTEGRATION', source: '构造资源', status_mode: 'observed', observation: { ...source }, node_status_mode: 'baseline',
    tables: [{ kind: 'devices', count: total }, ...(nodes ? [{ kind: 'nodes', count: 1 }] : [])], added: nodes ? 1 : 0 };
}
function rows() {
  const device = { device_id: 'DV-1', node_id: 'N1', model_id: 'M1', antenna_id: 'A1', antenna_height_m: '10', tx_power_dbm: '20',
    work_freq_khz: '2500', status: 'FAULT', availability: 'ACTIVE', alert: 'false', observed_at: '2026-10-23T02:00:00.000000Z', record_kind: 'device', ...metadata };
  const meta: Record<string, string> = { record_kind: 'metadata', ...metadata };
  return [observedHeaders, observedHeaders.map(key => meta[key] ?? ''), observedHeaders.map(key => (device as Record<string, string>)[key] ?? '')];
}
const csv = (data = rows()) => new Blob([Papa.unparse(data, { newline: '\r\n' }) + '\r\n'], { type: 'text/csv; charset=utf-8' });
function fixture(file: Blob = csv(), inspection: unknown = preview()) {
  const request = vi.fn().mockImplementation(async (path: string) => path.endsWith('/preview') ? inspection : file);
  return { request, api: createResourceExportHttp(request) };
}
async function workbook(nodes = false, mutate?: (book: import('exceljs').Workbook) => void) {
  const book = new Excel.Workbook();
  const sheet = book.addWorksheet('devices'); sheet.addRow(observedHeaders); sheet.addRow(rows()[2]);
  sheet.getCell(2, observedHeaders.indexOf('alert') + 1).value = false;
  if (nodes) {
    const sheet = book.addWorksheet('nodes'); sheet.addRow(nodeHeaders);
    sheet.addRow(nodeHeaders.map(key => key === 'node_id' ? 'N1' : key === 'status' ? 'NORMAL' : ''));
  }
  const notes = book.addWorksheet('说明');
  for (const row of [['资源版本', revision], ['状态口径', 'observed'], ...Object.entries(source), ['节点状态口径', 'baseline']]) notes.addRow(row);
  mutate?.(book);
  return new Blob([new Uint8Array(await book.xlsx.writeBuffer())], { type: xlsxMime });
}

describe('observed ledger export', () => {
  it.each(['all', 'selected', 'filtered'] as const)('keeps snapshot source at the root for %s', async range => {
    const f = fixture(), q = input(range);
    const result = await f.api.previewResourceExport(q);
    const payload = JSON.parse(f.request.mock.calls[0]![1].body);
    expect(payload).toMatchObject({ status_mode: 'observed', observation_snapshot_id: snapshotId, range });
    if (range === 'filtered') expect(payload.filter).toEqual({ status: 'FAULT' });
    else expect(payload).not.toHaveProperty('filter');
    expect(result).toMatchObject({ statusMode: 'observed', nodeStatusMode: 'baseline', observation: { snapshotId, snapshotRevision: source.snapshot_revision, resourceRevision: revision, dataOrigin: source.data_origin, sourceLabel: source.source_label } });
  });
  it.each([
    { statusMode: 'observed' }, { statusMode: 'baseline', observationSnapshotId: snapshotId }, { observationSnapshotId: snapshotId },
    { statusMode: 'observed', observationSnapshotId: '' }, { statusMode: 'observed', observationSnapshotId: 'bad id' },
    { statusMode: 'latest', observationSnapshotId: snapshotId },
  ])('rejects an ambiguous source before a request: %j', async filter => {
    const f = fixture(), q = input(); q.ledger!.filter = filter as NonNullable<typeof q.ledger>['filter'];
    await expect(f.api.previewResourceExport(q)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['all', 'selected'] as const)('rejects hidden business filters in %s', async range => {
    const f = fixture(), q = input(range); q.ledger!.filter!.status = 'FAULT';
    await expect(f.api.previewResourceExport(q)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(f.request).not.toHaveBeenCalled();
  });
  it.each(['nodes', 'interference_sources'] as const)('does not infer observed state for %s', async kind => {
    const f = fixture(), q = input(); q.kinds = [kind];
    await expect(f.api.previewResourceExport(q)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    { status_mode: 'baseline' }, { observation: null }, { node_status_mode: 'observed' },
    { observation: { ...source, snapshot_id: 'other' } }, { observation: { ...source, resource_revision: 'other' } },
    { observation: { ...source, snapshot_revision: 'latest' } }, { observation: { ...source, data_origin: 'MEASURED' } },
    { observation: { ...source, source_label: '' } }, { observation: { ...source, online: true } },
  ])('rejects a preflight with a different binding: %j', async patch => {
    await expect(fixture(csv(), { ...preview(), ...patch }).api.previewResourceExport(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it('checks CSV rows against preflight and preserves the server bytes', async () => {
    const file = csv(), f = fixture(file), output = await f.api.exportResources(input('selected'));
    expect(output.name).toBe(`synthetic-resources-${revision}-observed.csv`);
    expect(output.bytes).toEqual(new Uint8Array(await file.arrayBuffer()));
    expect(f.request.mock.calls.map(call => call[0])).toEqual(['/resource/export/preview', '/resource/export']);
    expect(f.request.mock.calls[1]![2]).toBe('blob');
  });
  it('accepts an empty result with explicit metadata and retains unknown values as empty cells', async () => {
    const empty = fixture(csv(rows().slice(0, 2)), preview(0)); expect((await empty.api.exportResources(input())).bytes.length).toBeGreaterThan(0);
    const data = rows();
    for (const field of ['status', 'alert', 'observed_at']) data[2]![observedHeaders.indexOf(field)] = '';
    expect((await fixture(csv(data)).api.exportResources(input())).bytes.length).toBeGreaterThan(0);
  });
  it('decodes formula-safe metadata for comparison without rewriting the file', async () => {
    const inspection = preview(), label = '=构造,"来源"'; inspection.observation.source_label = label;
    const data = rows();
    for (const row of data.slice(1)) row[observedHeaders.indexOf('source_label')] = '~rp~' + JSON.stringify(label);
    expect((await fixture(csv(data), inspection).api.exportResources(input())).bytes.length).toBeGreaterThan(0);
  });
  it.each(['snapshot_id', 'snapshot_revision', 'resource_revision', 'source_label', 'record_kind', 'status', 'alert', 'observed_at'])('rejects tampered CSV %s', async field => {
    const data = rows(); data[2]![observedHeaders.indexOf(field)] = 'wrong';
    await expect(fixture(csv(data)).api.exportResources(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it('rejects missing metadata, truncated columns, duplicate devices and count mismatches', async () => {
    const duplicate = rows(); duplicate.push([...duplicate[2]!]);
    for (const [data, total] of [[rows().filter((_, i) => i !== 1), 1], [rows().map(row => row.slice(0, -1)), 1], [duplicate, 2], [rows(), 2]] as const)
      await expect(fixture(csv(data as string[][]), preview(total)).api.exportResources(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it('rejects a different selection despite equal counts', async () => {
    const data = rows(); data[2]![0] = 'DV-other';
    await expect(fixture(csv(data)).api.exportResources(input('selected'))).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it('parses an actual XLSX and checks the baseline node closure metadata', async () => {
    const q = input('selected'); q.format = 'xlsx'; q.kinds = ['devices', 'nodes'];
    expect((await fixture(await workbook(true), preview(1, true)).api.exportResources(q)).mime).toBe(xlsxMime);
  }, 60000);
  it.each(['notes', 'formula', 'header', 'node-mode'] as const)('rejects a tampered workbook %s', async mode => {
    const file = await workbook(false, book => {
      const notes = book.getWorksheet('说明')!;
      if (mode === 'notes') notes.getCell(4, 2).value = 'device-status-' + 'b'.repeat(64);
      if (mode === 'formula') book.getWorksheet('devices')!.getCell(2, 10).value = { formula: '1+1', result: 'FAULT' };
      if (mode === 'header') book.getWorksheet('devices')!.getCell(1, 2).value = 'other';
      if (mode === 'node-mode') notes.getCell(notes.rowCount, 2).value = 'observed';
    });
    const q = input(); q.format = 'xlsx';
    await expect(fixture(file).api.exportResources(q)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it('rejects a fake XLSX and a JSON error returned with CSV MIME', async () => {
    const q = input(); q.format = 'xlsx';
    await expect(fixture(new Blob([new Uint8Array([80, 75, 3, 4, 1])], { type: xlsxMime })).api.exportResources(q)).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
    await expect(fixture(new Blob(['{}'], { type: 'text/csv' })).api.exportResources(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_EXPORT_RESPONSE' });
  });
  it('freezes the request binding before either asynchronous response', async () => {
    let resolve!: (value: unknown) => void;
    const request = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(csv());
    const api = createResourceExportHttp(request), q = input(), pending = api.exportResources(q);
    q.ledger!.filter!.observationSnapshotId = 'other'; q.kinds[0] = 'nodes'; q.format = 'xlsx';
    resolve(preview()); await expect(pending).resolves.toMatchObject({ mime: 'text/csv' });
    expect(JSON.parse(request.mock.calls[1]![1].body)).toMatchObject({ observation_snapshot_id: snapshotId, kinds: ['devices'], format: 'csv' });
  });
  it('preserves source/version errors and never retries a baseline export', async () => {
    const request = vi.fn().mockRejectedValue(new ApiError('source mismatch', 1205, null, 'trace', 409)), api = createResourceExportHttp(request);
    await expect(api.exportResources(input())).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CHANGED', requestId: 'trace' });
    expect(request).toHaveBeenCalledOnce(); expect(JSON.parse(request.mock.calls[0]![1].body).status_mode).toBe('observed');
  });
  it('keeps baseline responses and headers compatible, and rejects a GIS request with ledger scope', async () => {
    const f = fixture(new Blob(['device_id,node_id\r\nD1,N1\r\n'], { type: 'text/csv' }), { revision, data_origin: 'SYNTHETIC_INTEGRATION', source: '构造', tables: [{ kind: 'devices', count: 1 }], added: 0 });
    const q: ResourceExportRequest = { context: 'ledger', format: 'csv', kinds: ['devices'], ledger: { revision, range: 'all' } };
    expect(await f.api.previewResourceExport(q)).toEqual({ tables: [{ kind: 'devices', count: 1 }], added: 0 });
    expect((await f.api.exportResources(q)).name).toBe(`synthetic-resources-${revision}.csv`);
    await expect(f.api.exportResources({ ...q, context: 'gis' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
