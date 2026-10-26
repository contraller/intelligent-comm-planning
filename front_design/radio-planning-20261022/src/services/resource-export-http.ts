import type { AuthenticatedRequest } from './auth-http';
import type { ResourceExportObservation, ResourceExportPreview, ResourceExportRequest, ResourceKind, ResourceServices } from '../types/resource-edit';
import Papa from 'papaparse';
import { assertPageQuery } from './resource-read-validation';
import { ApiError } from './types';

const allowedKinds = ['nodes', 'devices', 'interference_sources'];
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const invalid = () => new ApiError('资源导出字段或范围无效', 'VALIDATION_ERROR');
const invalidResponse = () => new ApiError('资源导出响应不符合契约', 'INVALID_RESOURCE_EXPORT_RESPONSE');
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 120 && !/[\s\u0000-\u001f\u007f]/.test(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const headers = {
  nodes: 'node_id,node_name,echelon,node_subtype,parent_node_id,node_role,mobility,lon,lat,elevation_m,region,device_class,relay_capable,status,is_key,remark'.split(','),
  devices: 'device_id,node_id,model_id,antenna_id,antenna_height_m,tilt_deg,azimuth_deg,tx_power_dbm,work_freq_khz,status,install_time,availability'.split(','),
  interference_sources: 'interference_id,name,lon,lat,elevation_m,antenna_height_m,center_freq_khz,bandwidth_khz,tx_power_dbm,antenna_gain_dbi,interference_type,pattern_type,azimuth_deg,duty_cycle,active'.split(','),
  topology_links: 'link_id,node_a_id,node_b_id,device_a_id,device_b_id,device_class,freq_khz,bandwidth_khz,distance_m,path_loss_db,rx_power_dbm,link_margin_db,is_available,link_state,is_backup'.split(','),
};
const observationKeys = ['snapshot_id', 'snapshot_revision', 'resource_revision', 'data_origin', 'source_label'] as const;
const observedHeaders = [...headers.devices, 'alert', 'observed_at', 'record_kind', 'status_mode', ...observationKeys, 'node_status_mode'];
interface ExportPayload {
  context: 'ledger'; revision: string; format: 'csv' | 'xlsx'; kinds: ResourceKind[];
  range: 'all' | 'filtered' | 'selected'; selected_ids?: string[]; filter?: Record<string, unknown>;
  status_mode?: 'observed'; observation_snapshot_id?: string;
}
interface GisExportPayload {
  context: 'gis'; revision: string; format: 'csv' | 'xlsx'; kinds: ResourceKind[];
  range: 'all' | 'filtered' | 'selected'; browse: 'devices' | 'stations';
  selected_ids?: Partial<Record<ResourceKind, string[]>>; filter?: Record<string, unknown>;
}
type AnyExportPayload = ExportPayload | GisExportPayload;

function gisBody(input: ResourceExportRequest): GisExportPayload {
  const scope = input.gis, candidate = Array.isArray(input.kinds) && input.kinds.includes('topology_links');
  if (Object.keys(input).some(key => !['context', 'format', 'kinds', 'gis'].includes(key))
    || !['csv', 'xlsx'].includes(input.format) || !Array.isArray(input.kinds) || !input.kinds.length
    || new Set(input.kinds).size !== input.kinds.length || input.kinds.some(kind => !Object.hasOwn(headers, kind))
    || (candidate || input.format === 'csv') && input.kinds.length !== 1 || !record(scope)
    || !id(scope.revision) || !['all', 'filtered', 'selected'].includes(scope.range)
    || !['devices', 'stations'].includes(scope.browse)
    || Object.keys(scope).some(key => !['revision', 'range', 'browse', 'filter', 'selectedIds'].includes(key))) throw invalid();
  const result: GisExportPayload = { context: 'gis', revision: scope.revision, format: input.format,
    kinds: [...input.kinds], range: scope.range, browse: scope.browse };
  if (scope.range === 'selected') {
    if (!record(scope.selectedIds) || Object.keys(scope.selectedIds).some(key => !input.kinds.includes(key as ResourceKind))) throw invalid();
    result.selected_ids = {};
    for (const kind of input.kinds) {
      const values = scope.selectedIds[kind];
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.length > 50 || values.some(value => !id(value)) || new Set(values).size !== values.length) throw invalid();
      result.selected_ids[kind] = [...values];
    }
    if (!Object.values(result.selected_ids).some(values => values.length)) throw invalid();
  } else if (Object.hasOwn(scope, 'selectedIds')) throw invalid();
  if (scope.range !== 'filtered') {
    if (Object.hasOwn(scope, 'filter')) throw invalid();
    return result;
  }
  const filter = scope.filter;
  if (!record(filter) || Object.keys(filter).some(key => !['search', 'deviceClass', 'status', 'availability', 'alert', 'mobility', 'nodeRole', 'relayCapable', 'frequency'].includes(key))) throw invalid();
  if (candidate && Object.entries(filter).some(([key, value]) => value !== undefined && !['search', 'deviceClass', 'alert'].includes(key)))
    throw new ApiError('候选链路筛选导出仅支持搜索、设备类别和告警；请清除其他条件后重试', 'VALIDATION_ERROR');
  if (candidate && filter.alert !== undefined && filter.alert !== 'YES') throw invalid();
  try { assertPageQuery({ context: 'gis', revision: scope.revision, pageNum: 1, pageSize: 5, ...filter }); }
  catch { throw invalid(); }
  const mapped: Record<string, unknown> = {};
  for (const [a, b] of [['search', 'search'], ['deviceClass', 'device_class'], ['status', 'status'], ['availability', 'availability'],
    ['alert', 'alert'], ['mobility', 'mobility'], ['nodeRole', 'node_role'], ['relayCapable', 'relay_capable']] as const) {
    if (filter[a] !== undefined) mapped[b] = filter[a];
  }
  if (filter.frequency !== undefined) {
    const f = filter.frequency;
    if (!record(f) || Object.keys(f).some(key => !['mode', 'presence', 'minKhz', 'maxKhz'].includes(key))
      || f.mode !== 'DEVICE' && f.presence !== 'ALL'
      || (f.mode === 'ALL' || f.presence === 'MISSING') && (f.minKhz !== null || f.maxKhz !== null)) throw invalid();
    mapped.frequency = { mode: f.mode, presence: f.presence, min_khz: f.minKhz, max_khz: f.maxKhz };
  }
  result.filter = mapped;
  return result;
}

function body(input: ResourceExportRequest): AnyExportPayload {
  if (record(input) && input.context === 'gis') return gisBody(input);
  if (!record(input) || input.context !== 'ledger' || Object.keys(input).some(k => !['context', 'format', 'kinds', 'ledger'].includes(k))
    || !['csv', 'xlsx'].includes(input.format) || !Array.isArray(input.kinds) || !input.kinds.length
    || new Set(input.kinds).size !== input.kinds.length || input.kinds.some(k => !allowedKinds.includes(k))
    || input.format === 'csv' && input.kinds.length !== 1 || !record(input.ledger)) throw invalid();
  const scope = input.ledger;
  if (!id(scope.revision) || !['all', 'filtered', 'selected'].includes(scope.range)
    || Object.keys(scope).some(k => !['revision', 'range', 'filter', 'selectedIds'].includes(k))) throw invalid();
  const result: ExportPayload = { context: 'ledger', revision: scope.revision, format: input.format, kinds: [...input.kinds], range: scope.range };
  if (scope.range === 'selected') {
    if (!Array.isArray(scope.selectedIds) || !scope.selectedIds.length || scope.selectedIds.length > 50
      || scope.selectedIds.some(v => !id(v)) || new Set(scope.selectedIds).size !== scope.selectedIds.length) throw invalid();
    result.selected_ids = [...scope.selectedIds];
  } else if (Object.hasOwn(scope, 'selectedIds')) throw invalid();
  if (Object.hasOwn(scope, 'filter')) {
    const filter = scope.filter;
    if (!record(filter) || Object.keys(filter).some(k => !['search', 'deviceClass', 'status', 'availability', 'alert', 'mobility', 'nodeRole', 'relayCapable', 'frequency', 'statusMode', 'observationSnapshotId'].includes(k))) throw invalid();
    if (filter.statusMode !== undefined && (typeof filter.statusMode !== 'string' || !['baseline', 'observed'].includes(filter.statusMode))) throw invalid();
    if (filter.statusMode === 'observed') {
      if (!id(filter.observationSnapshotId) || !input.kinds.includes('devices')) throw invalid();
      result.status_mode = 'observed'; result.observation_snapshot_id = filter.observationSnapshotId;
    } else if (filter.observationSnapshotId !== undefined) throw invalid();
    const { statusMode: _mode, observationSnapshotId: _snapshot, ...business } = filter;
    if (scope.range !== 'filtered') {
      if (filter.statusMode === undefined || Object.values(business).some(value => value !== undefined)) throw invalid();
      return result;
    }
    try { assertPageQuery({ context: 'ledger', revision: scope.revision, pageNum: 1, pageSize: 5, ...business }); }
    catch { throw invalid(); }
    const mapped: Record<string, unknown> = {};
    for (const [a, b] of [['search', 'search'], ['deviceClass', 'device_class'], ['status', 'status'], ['availability', 'availability'],
      ['alert', 'alert'], ['mobility', 'mobility'], ['nodeRole', 'node_role'], ['relayCapable', 'relay_capable']] as const) {
      if (filter[a] !== undefined) mapped[b] = filter[a];
    }
    if (filter.frequency) {
      const f = filter.frequency;
      if (!record(f) || Object.keys(f).some(k => !['mode', 'presence', 'minKhz', 'maxKhz'].includes(k))
        || f.mode !== 'DEVICE' && f.presence !== 'ALL'
        || (f.mode === 'ALL' || f.presence === 'MISSING') && (f.minKhz !== null || f.maxKhz !== null)) throw invalid();
      mapped.frequency = { mode: f.mode, presence: f.presence, min_khz: f.minKhz, max_khz: f.maxKhz };
    }
    result.filter = mapped;
  } else if (scope.range === 'filtered') throw invalid();
  return result;
}

function readObservation(value: unknown, payload: ExportPayload): ResourceExportObservation {
  if (!record(value) || Object.keys(value).length !== observationKeys.length
    || observationKeys.some(key => !Object.hasOwn(value, key))
    || value.snapshot_id !== payload.observation_snapshot_id || value.resource_revision !== payload.revision
    || !id(value.snapshot_id) || typeof value.snapshot_revision !== 'string' || !/^device-status-[0-9a-f]{64}$/.test(value.snapshot_revision)
    || value.data_origin !== 'SYNTHETIC_INTEGRATION' || typeof value.source_label !== 'string' || !value.source_label.trim() || value.source_label.length > 120) throw invalidResponse();
  return { snapshotId: value.snapshot_id, snapshotRevision: value.snapshot_revision, resourceRevision: payload.revision,
    dataOrigin: 'SYNTHETIC_INTEGRATION', sourceLabel: value.source_label };
}
function observationMetadata(value: ResourceExportObservation): Record<string, string> {
  return { status_mode: 'observed', snapshot_id: value.snapshotId, snapshot_revision: value.snapshotRevision,
    resource_revision: value.resourceRevision, data_origin: value.dataOrigin, source_label: value.sourceLabel, node_status_mode: 'baseline' };
}
function scalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw invalidResponse();
}
function decodeCsv(value: string): string {
  if (!value.startsWith('~rp~')) return value;
  try { const decoded: unknown = JSON.parse(value.slice(4)); if (typeof decoded === 'string') return decoded; } catch { /* 非法转义不能解释为来源文本。 */ }
  throw invalidResponse();
}
function checkDeviceRows(rows: string[][], payload: ExportPayload, preview: ResourceExportPreview) {
  const expected = observationMetadata(preview.observation!), ids = new Set<string>();
  if (rows.length !== preview.tables.find(table => table.kind === 'devices')?.count) throw invalidResponse();
  for (const row of rows) {
    if (row.length !== observedHeaders.length) throw invalidResponse();
    const value = Object.fromEntries(observedHeaders.map((key, i) => [key, row[i]!]));
    if (!id(value.device_id) || ids.has(value.device_id) || value.record_kind !== 'device'
      || !['', 'NORMAL', 'FAULT', 'OFFLINE'].includes(value.status!) || !['', 'true', 'false'].includes(value.alert!)
      || value.observed_at !== '' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value.observed_at!) || !Number.isFinite(Date.parse(value.observed_at!)))
      || Object.entries(expected).some(([key, item]) => value[key] !== item)) throw invalidResponse();
    ids.add(value.device_id);
  }
  if (payload.range === 'selected' && (ids.size !== payload.selected_ids!.length || payload.selected_ids!.some(id => !ids.has(id)))) throw invalidResponse();
}
function checkObservedCsv(text: string, payload: ExportPayload, preview: ResourceExportPreview) {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  if (parsed.errors.length || parsed.data.length < 2 || JSON.stringify(parsed.data[0]) !== JSON.stringify(observedHeaders)) throw invalidResponse();
  const metadata = parsed.data[1]!.map(decodeCsv), expected = observationMetadata(preview.observation!);
  if (metadata.length !== observedHeaders.length || observedHeaders.some((key, index) =>
    metadata[index] !== (key === 'record_kind' ? 'metadata' : expected[key] ?? ''))) throw invalidResponse();
  checkDeviceRows(parsed.data.slice(2).map(row => row.map(decodeCsv)), payload, preview);
}
async function checkObservedWorkbook(bytes: Uint8Array, payload: ExportPayload, preview: ResourceExportPreview) {
  try {
    const Excel = (await import('exceljs')).default, book = new Excel.Workbook();
    await book.xlsx.load(new Uint8Array(bytes).buffer);
    if (JSON.stringify(book.worksheets.map(sheet => sheet.name)) !== JSON.stringify([...payload.kinds, '说明'])) throw invalidResponse();
    for (const table of preview.tables) {
      const sheet = book.getWorksheet(table.kind)!, columns = table.kind === 'devices' ? observedHeaders : headers[table.kind as keyof typeof headers];
      if (sheet.rowCount !== table.count + 1 || sheet.columnCount !== columns.length
        || columns.some((key, i) => sheet.getCell(1, i + 1).value !== key)) throw invalidResponse();
      const rows: string[][] = [];
      for (let row = 2; row <= sheet.rowCount; row++) rows.push(columns.map((_, column) => scalar(sheet.getCell(row, column + 1).value)));
      if (table.kind === 'devices') checkDeviceRows(rows, payload, preview);
    }
    const notes = book.getWorksheet('说明')!, metadata = new Map<string, string>();
    notes.eachRow(row => {
      const key = scalar(row.getCell(1).value);
      if (metadata.has(key)) throw invalidResponse();
      metadata.set(key, scalar(row.getCell(2).value));
    });
    const { status_mode, node_status_mode, ...expected } = observationMetadata(preview.observation!);
    if (metadata.get('资源版本') !== payload.revision || metadata.get('状态口径') !== status_mode || metadata.get('节点状态口径') !== node_status_mode
      || Object.entries(expected).some(([key, item]) => metadata.get(key) !== item)) throw invalidResponse();
  } catch { throw invalidResponse(); }
}

function checkGisRows(rows: string[][], kind: ResourceKind, payload: GisExportPayload, preview: ResourceExportPreview) {
  const columns = headers[kind], ids = new Set<string>();
  if (rows.length !== preview.tables.find(table => table.kind === kind)?.count) throw invalidResponse();
  for (const row of rows) {
    if (row.length !== columns.length || !id(row[0]) || ids.has(row[0])) throw invalidResponse();
    ids.add(row[0]);
  }
  if (payload.range === 'selected') {
    const selected = payload.selected_ids?.[kind] ?? [], added = kind === 'nodes' ? preview.added : 0;
    if (ids.size !== selected.length + added || selected.some(value => !ids.has(value))) throw invalidResponse();
  }
}
function checkGisCsv(text: string, payload: GisExportPayload, preview: ResourceExportPreview) {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true }), kind = payload.kinds[0]!;
  if (parsed.errors.length || JSON.stringify(parsed.data[0]) !== JSON.stringify(headers[kind])) throw invalidResponse();
  checkGisRows(parsed.data.slice(1).map(row => row.map(decodeCsv)), kind, payload, preview);
}
async function checkGisWorkbook(bytes: Uint8Array, payload: GisExportPayload, preview: ResourceExportPreview) {
  try {
    const Excel = (await import('exceljs')).default, book = new Excel.Workbook();
    await book.xlsx.load(new Uint8Array(bytes).buffer);
    if (JSON.stringify(book.worksheets.map(sheet => sheet.name)) !== JSON.stringify([...payload.kinds, '说明'])) throw invalidResponse();
    for (const table of preview.tables) {
      const sheet = book.getWorksheet(table.kind)!, columns = headers[table.kind];
      if (sheet.rowCount !== table.count + 1 || sheet.columnCount !== columns.length
        || columns.some((key, i) => sheet.getCell(1, i + 1).value !== key)) throw invalidResponse();
      const rows: string[][] = [];
      for (let row = 2; row <= sheet.rowCount; row++) rows.push(columns.map((_, column) => scalar(sheet.getCell(row, column + 1).value)));
      checkGisRows(rows, table.kind, payload, preview);
    }
    const metadata = new Map<string, string>(), warnings: string[] = [], references = new Set<string>();
    const candidate = payload.kinds[0] === 'topology_links';
    const candidateIds = new Set<string>();
    if (candidate) book.getWorksheet('topology_links')!.eachRow((row, index) => { if (index > 1) candidateIds.add(scalar(row.getCell(1).value)); });
    let referenceSection = false;
    // 提示行可重复；候选冻结来源附表与两列说明元数据分开解析。
    book.getWorksheet('说明')!.eachRow(row => {
      const values = [1, 2, 3, 4].map(column => scalar(row.getCell(column).value)), key = values[0]!;
      if (!referenceSection && JSON.stringify(values) === JSON.stringify(['link_id', 'assessment_state', 'source_json', 'reference_json'])) {
        if (!candidate) throw invalidResponse();
        referenceSection = true;
      } else if (referenceSection) {
        if (!candidateIds.has(key) || references.has(key) || !['PENDING', 'REFERENCE'].includes(values[1]!)) throw invalidResponse();
        const source: unknown = JSON.parse(values[2]!), reference: unknown = JSON.parse(values[3]!);
        if (!record(source) || reference !== null && (!record(reference) || !record(reference.data) || !record(reference.source))) throw invalidResponse();
        references.add(key);
      } else {
        if (values[2] !== '' || values[3] !== '') throw invalidResponse();
        if (key === '范围与来源说明') warnings.push(values[1]!);
        else {
          if (metadata.has(key)) throw invalidResponse();
          metadata.set(key, values[1]!);
        }
      }
    });
    if (metadata.get('资源版本') !== payload.revision || metadata.get('数据来源') !== 'SYNTHETIC_INTEGRATION'
      || metadata.get('导出范围') !== payload.range || metadata.get('浏览方式') !== payload.browse
      || metadata.get('补齐上级节点数') !== String(preview.added) || JSON.stringify(warnings) !== JSON.stringify(preview.warnings)
      || candidate && (!referenceSection || references.size !== candidateIds.size)) throw invalidResponse();
  } catch { throw invalidResponse(); }
}

export function createResourceExportHttp(request: AuthenticatedRequest): Pick<ResourceServices, 'previewResourceExport' | 'exportResources'> {
  async function call(path: string, payload: AnyExportPayload, file = false) {
    try { return await request(path, { method: 'POST', body: JSON.stringify(payload) }, file ? 'blob' : 'json'); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const codes: Record<number, string> = { 1001: 'VALIDATION_ERROR', 1002: 'RESOURCE_NOT_FOUND', 1203: 'OBSERVATION_SOURCE_CHANGED', 1205: 'RESOURCE_VERSION_CHANGED' };
      if (typeof error.code !== 'number' || !codes[error.code]) throw error;
      throw new ApiError(error.message, codes[error.code], error.data, error.requestId, error.status);
    }
  }
  async function inspect(payload: AnyExportPayload): Promise<ResourceExportPreview> {
    const kinds = payload.kinds, format = payload.format, range = payload.range, observed = payload.context === 'ledger' && payload.status_mode === 'observed';
    // 响应只核对发起时的值，不能被页面后续修改输入改变解释。
    const data = await call('/resource/export/preview', payload);
    const allowed = ['revision', 'data_origin', 'source', 'tables', 'added', ...(payload.context === 'gis' ? ['warnings'] : []), ...(observed ? ['status_mode', 'observation', 'node_status_mode'] : [])];
    if (!record(data) || Object.keys(data).some(k => !allowed.includes(k))
      || data.revision !== payload.revision || data.data_origin !== 'SYNTHETIC_INTEGRATION' || typeof data.source !== 'string' || !data.source.trim()
      || !Array.isArray(data.tables) || data.tables.length !== kinds.length || !count(data.added)) throw invalidResponse();
    const tables = data.tables.map((item: unknown, i: number) => {
      if (!record(item) || Object.keys(item).some(k => !['kind', 'count'].includes(k)) || item.kind !== kinds[i] || !count(item.count)) throw invalidResponse();
      return { kind: kinds[i]!, count: item.count };
    });
    if (data.added > (tables.find(t => t.kind === 'nodes')?.count ?? 0)
      || data.added && (format !== 'xlsx' || range === 'all')) throw invalidResponse();
    const added = data.added;
    if (payload.context === 'gis' && range === 'selected' && tables.some(table =>
      table.count !== (payload.selected_ids?.[table.kind]?.length ?? 0) + (table.kind === 'nodes' ? added : 0))) throw invalidResponse();
    if (observed && payload.context === 'ledger') {
      if (data.status_mode !== 'observed' || data.node_status_mode !== 'baseline') throw invalidResponse();
      return { tables, added: data.added, statusMode: 'observed', observation: readObservation(data.observation, payload), nodeStatusMode: 'baseline' };
    }
    if (payload.context === 'gis') {
      if (!Array.isArray(data.warnings) || data.warnings.some((warning: unknown) => typeof warning !== 'string' || !warning.trim())) throw invalidResponse();
      return { tables, added: data.added, warnings: [...data.warnings] };
    }
    return { tables, added: data.added };
  }
  return {
    async previewResourceExport(input): Promise<ResourceExportPreview> {
      return inspect(body(input));
    },
    async exportResources(input) {
      const payload = body(input), format = input.format, kind = input.kinds[0]!;
      // 先冻结并核对本次快照来源，再下载；不复用另一身份或另一范围的预检缓存。
      const observedPreview = payload.context === 'ledger' && payload.status_mode === 'observed' ? await inspect(payload) : null;
      const gisPreview = payload.context === 'gis' ? await inspect(payload) : null;
      const blob = await call('/resource/export', payload, true);
      const mime = format === 'csv' ? 'text/csv' : xlsxMime;
      if (!(blob instanceof Blob) || blob.type.split(';')[0].trim().toLowerCase() !== mime || !blob.size || blob.size > 20 * 1024 * 1024) throw invalidResponse();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (format === 'xlsx') {
        if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) throw invalidResponse();
        if (observedPreview && payload.context === 'ledger') await checkObservedWorkbook(bytes, payload, observedPreview);
        if (gisPreview && payload.context === 'gis') await checkGisWorkbook(bytes, payload, gisPreview);
      } else {
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalidResponse(); }
        const first = { nodes: 'node_id,', devices: 'device_id,', interference_sources: 'interference_id,', topology_links: 'link_id,' };
        if (!text.startsWith(first[kind as keyof typeof first])) throw invalidResponse();
        if (observedPreview && payload.context === 'ledger') checkObservedCsv(text, payload, observedPreview);
        if (gisPreview && payload.context === 'gis') checkGisCsv(text, payload, gisPreview);
      }
      return { name: `synthetic-resources-${payload.revision}${observedPreview ? '-observed' : ''}.${format}`, mime, bytes };
    },
  };
}
