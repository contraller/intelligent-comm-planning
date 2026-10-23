import type { ResourceFile, ResourceFormat, ResourceImportPreview, ResourceImportRequest, ResourceImportRow, ResourceKind } from '../types/resource-edit';
import { ApiError } from './types';
import { readWorkspaceChanges, readWorkspaceIssues, readWorkspaceResources, workspaceFailure, workspaceId, workspaceKeys, workspaceRecord, workspaceRevision, workspaceText } from './resource-workspace-validation';

export const maxResourceImportBytes = 5 * 1024 * 1024;
export const resourceXlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const resourceImportKinds = ['nodes', 'devices', 'interference_sources'] as const;
export type ResourceImportKind = typeof resourceImportKinds[number];
export function importKind(value: unknown): ResourceImportKind {
  if (value !== 'nodes' && value !== 'devices' && value !== 'interference_sources') return workspaceFailure('import.kind');
  return value;
}
export function importSignature(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return workspaceFailure('signature');
  return value;
}
export function importValidationError(): ApiError { return new ApiError('资源导入请求无效，请保存 GIS 草稿后再导入', 'VALIDATION_ERROR'); }
export function snapshotImportRequest(input: ResourceImportRequest): ResourceImportRequest {
  try {
    const v = workspaceRecord(input); workspaceKeys(v, ['file', 'kind', 'baseRevision', 'context'], ['draftChanges']);
    const file = workspaceRecord(v.file); workspaceKeys(file, ['name', 'bytes']);
    const name = workspaceText(file.name, 'file.name', false, 255);
    if (!/\.(csv|xlsx)$/i.test(name) || /[\\/]/.test(name) || !(file.bytes instanceof Uint8Array) || !file.bytes.byteLength || file.bytes.byteLength > maxResourceImportBytes) throw importValidationError();
    if (v.context !== 'ledger' && v.context !== 'gis') throw importValidationError();
    if (v.draftChanges !== undefined) {
      const draft = readWorkspaceChanges(v.draftChanges, 'MANUAL');
      if (Object.values(draft).some(rows => Array.isArray(rows) && rows.length > 0)) throw importValidationError();
    }
    return { file: { name, bytes: new Uint8Array(file.bytes) }, kind: importKind(v.kind), baseRevision: workspaceRevision(v.baseRevision), context: v.context };
  } catch (error) {
    if (!(error instanceof ApiError) || !['INVALID_RESOURCE_RESPONSE', 'VALIDATION_ERROR'].includes(String(error.code))) throw error;
    throw importValidationError();
  }
}
export function resourceImportBody(input: ResourceImportRequest) {
  // 只编码原始字节；不在前端解析 CSV/XLSX 或计算业务差异。
  let binary = '';
  for (let offset = 0; offset < input.file.bytes.length; offset += 0x8000) binary += String.fromCharCode(...input.file.bytes.subarray(offset, offset + 0x8000));
  return { context: input.context, base_revision: input.baseRevision, kind: input.kind, file: { name: input.file.name, base64: btoa(binary) } };
}
function jsonValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return workspaceFailure('difference depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, item => jsonValue(item, depth + 1));
  const v = workspaceRecord(value);
  return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, jsonValue(item, depth + 1)]));
}
export function readResourceImportPreview(value: unknown, input: ResourceImportRequest): ResourceImportPreview {
  const v = workspaceRecord(value);
  workspaceKeys(v, ['base_revision', 'context', 'kind', 'file_name', 'signature', 'valid', 'rows', 'issues', 'warnings', 'candidate', 'changes']);
  if (v.base_revision !== input.baseRevision || v.context !== input.context || v.kind !== input.kind || v.file_name !== input.file.name) workspaceFailure('import binding');
  const signature = importSignature(v.signature);
  // 诊断保留 file 和非法工作表原名；业务行仍按 importKind 限定。
  const issues = readWorkspaceIssues(v.issues), warnings = readWorkspaceIssues(v.warnings);
  if (v.valid !== (issues.length === 0)) workspaceFailure('import valid');
  if (!Array.isArray(v.rows) || v.rows.length > 5000) workspaceFailure('import rows');
  const isCsv = /\.csv$/i.test(input.file.name), positions = new Set<string>();
  const rows: ResourceImportRow[] = Array.from(v.rows, value => {
    const row = workspaceRecord(value); workspaceKeys(row, ['sheet', 'row', 'id', 'action', 'differences']);
    const sheet = importKind(row.sheet);
    if (isCsv && sheet !== input.kind || typeof row.row !== 'number' || !Number.isSafeInteger(row.row) || row.row < 2 || row.row > 5001
      || !['NEW', 'UPDATE', 'UNCHANGED'].includes(String(row.action)) || !Array.isArray(row.differences)) workspaceFailure('import row');
    const position = sheet + ':' + row.row;
    if (positions.has(position)) workspaceFailure('duplicate import row');
    positions.add(position);
    const fields = new Set<string>();
    const differences = Array.from(row.differences, value => {
      const diff = workspaceRecord(value); workspaceKeys(diff, ['field', 'before', 'after']);
      const field = workspaceText(diff.field, 'difference.field');
      if (fields.has(field)) workspaceFailure('duplicate difference');
      fields.add(field);
      return { field, before: jsonValue(diff.before), after: jsonValue(diff.after) };
    });
    if (row.action === 'UNCHANGED' && differences.length || row.action === 'UPDATE' && !differences.length) workspaceFailure('row action');
    return { sheet, row: row.row, id: issues.length ? workspaceText(row.id, 'row.id', true) : workspaceId(row.id), action: row.action as ResourceImportRow['action'], differences };
  });
  const candidate = readWorkspaceResources(v.candidate, input.baseRevision), changes = readWorkspaceChanges(v.changes, 'IMPORT');
  if (issues.length && Object.values(changes).some(rows => Array.isArray(rows) && rows.length)) workspaceFailure('invalid preview changes');
  if (!issues.length) {
    const seen = new Set<string>();
    for (const row of rows) {
      const key = row.sheet + ':' + row.id;
      if (seen.has(key)) workspaceFailure('duplicate import id');
      seen.add(key);
      const table = row.sheet === 'nodes' ? candidate.stations : row.sheet === 'devices' ? candidate.devices : candidate.interferences ?? [];
      const item = table.find(item => item.id === row.id);
      if (!item || row.action === 'NEW' && item.origin !== 'IMPORT') workspaceFailure('import candidate reference');
    }
    for (const [field, sheet] of [['stations', 'nodes'], ['newStations', 'nodes'], ['devices', 'devices'], ['newDevices', 'devices'], ['interferences', 'interference_sources'], ['newInterferences', 'interference_sources']] as const) {
      for (const item of changes[field] ?? []) if (!rows.some(row => row.sheet === sheet && row.id === item.id && row.action !== 'UNCHANGED')) workspaceFailure('import changes reference');
    }
    if (changes.newCandidateLinks?.length || changes.importedCandidateLinks?.length || changes.candidateLinks?.length) workspaceFailure('unsupported candidate import');
  }
  // 返回的请求副本与调用方原始缓冲区无共享内存。
  return { request: snapshotImportRequest(input), signature, rows, issues, warnings, candidate, changes };
}
export function templateArguments(format: ResourceFormat, kind: ResourceKind) {
  try {
    if (format !== 'csv' && format !== 'xlsx') throw importValidationError();
    return { format, kind: importKind(kind) };
  } catch { throw importValidationError(); }
}
export async function readResourceTemplate(value: unknown, format: ResourceFormat, kind: ResourceImportKind, revision: string): Promise<ResourceFile> {
  const mime = format === 'csv' ? 'text/csv' : resourceXlsxMime;
  if (!(value instanceof Blob) || value.type.split(';')[0].trim().toLowerCase() !== mime || !value.size || value.size > maxResourceImportBytes) workspaceFailure('template blob');
  const bytes = new Uint8Array(await value.arrayBuffer());
  if (format === 'xlsx') {
    if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4) workspaceFailure('template xlsx');
  } else {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return workspaceFailure('template UTF-8'); }
    const first = { nodes: 'node_id,', devices: 'device_id,', interference_sources: 'interference_id,' };
    if (!text.startsWith(first[kind])) workspaceFailure('template header');
  }
  return { name: `SYNTHETIC_INTEGRATION-resource-template-${kind}-${revision}.${format}`, mime, bytes };
}
