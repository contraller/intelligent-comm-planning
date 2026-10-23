import type { AuthenticatedRequest } from './auth-http';
import type { ResourceExportPreview, ResourceExportRequest, ResourceServices } from '../types/resource-edit';
import { assertPageQuery } from './resource-read-validation';
import { ApiError } from './types';

const allowedKinds = ['nodes', 'devices', 'interference_sources'];
const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const invalid = () => new ApiError('资源导出字段或范围无效', 'VALIDATION_ERROR');
const invalidResponse = () => new ApiError('资源导出响应不符合契约', 'INVALID_RESOURCE_EXPORT_RESPONSE');
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 120 && !/[\s\u0000-\u001f\u007f]/.test(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function body(input: ResourceExportRequest) {
  if (input?.context === 'gis') throw new ApiError('GIS 专用资源导出尚未接入', 'NOT_IMPLEMENTED');
  if (!record(input) || input.context !== 'ledger' || Object.keys(input).some(k => !['context', 'format', 'kinds', 'ledger'].includes(k))
    || !['csv', 'xlsx'].includes(input.format) || !Array.isArray(input.kinds) || !input.kinds.length
    || new Set(input.kinds).size !== input.kinds.length || input.kinds.some(k => !allowedKinds.includes(k))
    || input.format === 'csv' && input.kinds.length !== 1 || !record(input.ledger)) throw invalid();
  const scope = input.ledger;
  if (!id(scope.revision) || !['all', 'filtered', 'selected'].includes(scope.range)
    || Object.keys(scope).some(k => !['revision', 'range', 'filter', 'selectedIds'].includes(k))) throw invalid();
  const result: Record<string, unknown> = { context: 'ledger', revision: scope.revision, format: input.format, kinds: [...input.kinds], range: scope.range };
  if (scope.range === 'selected') {
    if (!Array.isArray(scope.selectedIds) || !scope.selectedIds.length || scope.selectedIds.length > 50
      || scope.selectedIds.some(v => !id(v)) || new Set(scope.selectedIds).size !== scope.selectedIds.length) throw invalid();
    result.selected_ids = [...scope.selectedIds];
  } else if (Object.hasOwn(scope, 'selectedIds')) throw invalid();
  if (scope.range === 'filtered') {
    const filter = scope.filter;
    if (!record(filter) || Object.keys(filter).some(k => !['search', 'deviceClass', 'status', 'availability', 'alert', 'mobility', 'nodeRole', 'relayCapable', 'frequency', 'statusMode', 'observationSnapshotId'].includes(k))) throw invalid();
    if (filter.statusMode === 'observed' || filter.observationSnapshotId !== undefined) throw new ApiError('观测快照导出尚未接入', 'NOT_IMPLEMENTED');
    try { assertPageQuery({ context: 'ledger', revision: scope.revision, pageNum: 1, pageSize: 5, ...filter }); }
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
  } else if (Object.hasOwn(scope, 'filter')) throw invalid();
  return result;
}

export function createResourceExportHttp(request: AuthenticatedRequest): Pick<ResourceServices, 'previewResourceExport' | 'exportResources'> {
  async function call(path: string, payload: Record<string, unknown>, file = false) {
    try { return await request(path, { method: 'POST', body: JSON.stringify(payload) }, file ? 'blob' : 'json'); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const codes: Record<number, string> = { 1001: 'VALIDATION_ERROR', 1002: 'RESOURCE_NOT_FOUND', 1205: 'RESOURCE_VERSION_CHANGED' };
      if (typeof error.code !== 'number' || !codes[error.code]) throw error;
      throw new ApiError(error.message, codes[error.code], error.data, error.requestId, error.status);
    }
  }
  return {
    async previewResourceExport(input): Promise<ResourceExportPreview> {
      const payload = body(input), data = await call('/resource/export/preview', payload);
      if (!record(data) || Object.keys(data).some(k => !['revision', 'data_origin', 'source', 'tables', 'added'].includes(k))
        || data.revision !== payload.revision || data.data_origin !== 'SYNTHETIC_INTEGRATION' || typeof data.source !== 'string' || !data.source.trim()
        || !Array.isArray(data.tables) || data.tables.length !== input.kinds.length || !count(data.added)) throw invalidResponse();
      const tables = data.tables.map((item: unknown, i: number) => {
        if (!record(item) || Object.keys(item).some(k => !['kind', 'count'].includes(k)) || item.kind !== input.kinds[i] || !count(item.count)) throw invalidResponse();
        return { kind: input.kinds[i]!, count: item.count };
      });
      if (data.added > (tables.find(t => t.kind === 'nodes')?.count ?? 0)
        || data.added && (input.format !== 'xlsx' || input.ledger!.range === 'all')) throw invalidResponse();
      return { tables, added: data.added };
    },
    async exportResources(input) {
      const payload = body(input), blob = await call('/resource/export', payload, true);
      const mime = input.format === 'csv' ? 'text/csv' : xlsxMime;
      if (!(blob instanceof Blob) || blob.type.split(';')[0].trim().toLowerCase() !== mime || !blob.size || blob.size > 20 * 1024 * 1024) throw invalidResponse();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (input.format === 'xlsx') {
        if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) throw invalidResponse();
      } else {
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalidResponse(); }
        const first = { nodes: 'node_id,', devices: 'device_id,', interference_sources: 'interference_id,' };
        if (!text.startsWith(first[input.kinds[0] as keyof typeof first])) throw invalidResponse();
      }
      return { name: `synthetic-resources-${payload.revision}.${input.format}`, mime, bytes };
    },
  };
}
