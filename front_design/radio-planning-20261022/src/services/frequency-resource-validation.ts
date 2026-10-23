import type {
  FrequencyDisableInput, FrequencyDisableReceipt, FrequencyDisableValidation,
  FrequencyDisableValidationInput, FrequencyResourceItem, FrequencyResourceSnapshot,
  FrequencyPageQuery, FrequencyResourcePage, FrequencyHistoryQuery, FrequencyOperationQuery,
  FrequencyOperation, FrequencyOperationPage, FrequencyOperationSummary,
  FrequencyAction, FrequencyChangesInput, FrequencyChangeReceipt, FrequencyReceipt,
  FrequencyChangesValidation, FrequencyChangesValidationInput,
} from '../types/frequency-resource';
import { ApiError } from './types';

function fail(field: string): never {
  throw new ApiError('规划频点响应不符合契约：' + field, 'INVALID_FREQUENCY_RESOURCE_RESPONSE');
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('object');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) fail('fields');
  return row;
}
function text(value: unknown, field: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fail(field);
}
function id(value: unknown): string {
  const result = text(value, 'id');
  if (result.length > 120 || /\s|[\u0000-\u001f\u007f]/u.test(result)) fail('id');
  return result;
}
function revision(value: unknown): string {
  return typeof value === 'string' && value.length === 25 && /^resource-[0-9a-f]{16}$/.test(value) ? value : fail('revision');
}
function number(value: unknown, field: string, positive = false): number {
  return typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0)
    ? value : fail(field);
}
function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}
const equal = (left: string[], right: string[]) => left.length === right.length && left.every((v, i) => v === right[i]);
function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return fail('ids');
  const result = value.map(id);
  if (new Set(result).size !== result.length || !equal(result, [...result].sort(compareFrequencyIds))) fail('ids order/duplicates');
  return result;
}
function item(value: unknown): FrequencyResourceItem {
  const row = record(value, ['freq_id', 'device_class', 'center_freq_khz', 'bandwidth_khz', 'channel_no',
    'is_available', 'occupied_by', 'reuse_min_distance_m', 'adjacent_guard_khz', 'note']);
  if (row.device_class !== 'HF' && row.device_class !== 'VUHF') fail('device_class');
  if (typeof row.is_available !== 'boolean') fail('is_available');
  const channel = row.channel_no === null ? null : number(row.channel_no, 'channel_no');
  if (channel !== null && !Number.isSafeInteger(channel)) fail('channel_no');
  return {
    freqId: id(row.freq_id), deviceClass: row.device_class as 'HF' | 'VUHF',
    centerFreqKhz: number(row.center_freq_khz, 'center_freq_khz', true),
    bandwidthKhz: row.bandwidth_khz === null ? null : number(row.bandwidth_khz, 'bandwidth_khz', true),
    channelNo: channel, isAvailable: row.is_available as boolean,
    occupiedBy: nullableText(row.occupied_by, 'occupied_by'),
    reuseMinDistanceM: row.reuse_min_distance_m === null ? null : number(row.reuse_min_distance_m, 'reuse_min_distance_m'),
    adjacentGuardKhz: row.adjacent_guard_khz === null ? null : number(row.adjacent_guard_khz, 'adjacent_guard_khz'),
    note: nullableText(row.note, 'note'),
  };
}
function items(value: unknown): FrequencyResourceItem[] {
  if (!Array.isArray(value)) return fail('items');
  const result = value.map(item);
  ids(result.map(row => row.freqId));
  return result;
}
function source(row: Record<string, unknown>) {
  if (row.data_origin !== 'SYNTHETIC_INTEGRATION') fail('data_origin');
  return { dataOrigin: 'SYNTHETIC_INTEGRATION' as const, source: text(row.source, 'source') };
}
const metadataKeys = ['revision', 'base_revision', 'data_origin', 'source', 'content_hash', 'items'];
function snapshot(row: Record<string, unknown>, expectedRevision: string): FrequencyResourceSnapshot {
  const rev = revision(row.revision);
  if (rev !== expectedRevision || row.base_revision !== rev || typeof row.content_hash !== 'string'
    || row.content_hash.length !== 64 || !/^[0-9a-f]{64}$/.test(row.content_hash)) fail('snapshot version/hash');
  return { ...source(row), revision: rev, baseRevision: rev, contentHash: row.content_hash, items: items(row.items) };
}
function partition(selected: string[], updated: string[], unchanged: string[], expected: string[]) {
  if (!equal(selected, [...expected].sort(compareFrequencyIds)) || updated.some(value => unchanged.includes(value))
    || !equal([...updated, ...unchanged].sort(compareFrequencyIds), selected)) fail('selection partition');
}

export function readFrequencyResources(value: unknown, expectedRevision: string): FrequencyResourceSnapshot {
  const result = snapshot(record(value, metadataKeys), expectedRevision);
  if (result.items.length === 0) fail('empty frequency resources');
  return result;
}

export function readFrequencyDisableValidation(value: unknown, input: FrequencyDisableValidationInput): FrequencyDisableValidation {
  const row = record(value, [...metadataKeys, 'selected_ids', 'would_disable', 'unchanged', 'impact']);
  const result = snapshot(row, input.revision);
  const selectedIds = ids(row.selected_ids), wouldDisable = ids(row.would_disable), unchanged = ids(row.unchanged);
  partition(selectedIds, wouldDisable, unchanged, input.ids);
  if (!equal(result.items.map(v => v.freqId), selectedIds)
    || !equal(result.items.filter(v => v.isAvailable).map(v => v.freqId), wouldDisable)) fail('preview items');
  const impact = record(row.impact, ['resource_revision_will_change', 'historical_resources_preserved',
    'saved_plans_require_recompute', 'link_impact']);
  const changed = wouldDisable.length > 0;
  if (impact.resource_revision_will_change !== changed || impact.saved_plans_require_recompute !== changed
    || impact.historical_resources_preserved !== true || impact.link_impact !== 'UNKNOWN') fail('impact');
  return { ...result, selectedIds, wouldDisable, unchanged,
    impact: { resourceRevisionWillChange: changed, historicalResourcesPreserved: true,
      savedPlansRequireRecompute: changed, linkImpact: 'UNKNOWN' } };
}

function readReceipt(value: unknown, input: FrequencyDisableInput, objectId: FrequencyReceipt['objectId']): FrequencyReceipt {
  const row = record(value, ['object_id', 'request_id', 'base_revision', 'selected_ids', 'affected_ids', 'updated',
    'unchanged', 'items', 'data_origin', 'source', 'warnings', 'changed', 'revision', 'read_revision']);
  const rev = revision(row.revision), base = revision(row.base_revision);
  const selectedIds = ids(row.selected_ids), updated = ids(row.updated), unchanged = ids(row.unchanged);
  const affectedIds = ids(row.affected_ids), savedItems = items(row.items);
  partition(selectedIds, updated, unchanged, input.ids);
  if (row.object_id !== objectId || row.request_id !== input.requestId || base !== input.baseRevision
    || row.read_revision !== rev || typeof row.changed !== 'boolean' || row.changed !== (updated.length > 0)
    || row.changed === (rev === base) || !equal(affectedIds, updated)
    || !equal(savedItems.map(v => v.freqId), selectedIds) || objectId === 'resource-frequency-disable' && savedItems.some(v => v.isAvailable)
    || !Array.isArray(row.warnings) || row.warnings.length !== 0) fail('receipt');
  // 回执固定在原提交版本；不将后续当前资源状态混入幂等重放结果。
  return { ...source(row), objectId, requestId: input.requestId,
    baseRevision: base, revision: rev, readRevision: rev, changed: row.changed as boolean,
    selectedIds, affectedIds, updated, unchanged, items: savedItems, warnings: [] };
}
export function readFrequencyDisableReceipt(value: unknown, input: FrequencyDisableInput): FrequencyDisableReceipt {
  return readReceipt(value, input, 'resource-frequency-disable') as FrequencyDisableReceipt;
}
export const constructedFrequencyNote = (note: string | null) => note === null || note.startsWith('[人工构造规划频点；非正式频率授权] ')
  ? note : '[人工构造规划频点；非正式频率授权] ' + note;
const sameItem = (left: FrequencyResourceItem, right: FrequencyResourceItem) =>
  (Object.keys(left) as (keyof FrequencyResourceItem)[]).every(key => left[key] === right[key]);
export function assertFrequencyChangesReceipt(value: FrequencyChangeReceipt, changes: FrequencyAction[]) {
  if (!equal(value.selectedIds, changes.map(action => action.freqId).sort(compareFrequencyIds))) fail('changes association');
  for (const action of changes) {
    const saved = value.items.find(item => item.freqId === action.freqId);
    if (!saved) fail('changes items');
    if (action.kind === 'ENABLE') { if (!saved.isAvailable) fail('enable result'); }
    else {
      const fields = action.kind === 'ADD' ? action.item : action.fields;
      for (const [key, raw] of Object.entries(fields)) {
        const expected = action.kind === 'ADD' && key === 'note' ? constructedFrequencyNote(raw as string | null) : raw;
        if (saved[key as keyof FrequencyResourceItem] !== expected
          && !(action.kind === 'PATCH' && key === 'note' && saved.note === constructedFrequencyNote(raw as string | null))) fail('changes fields');
      }
      if (action.kind === 'ADD' && (saved.isAvailable || saved.occupiedBy !== null || !value.updated.includes(action.freqId))) fail('add result');
    }
  }
}
export function readFrequencyChangesReceipt(value: unknown, input: FrequencyChangesInput): FrequencyChangeReceipt {
  const receipt = readReceipt(value, { ...input, ids: input.changes.map(action => action.freqId) }, 'resource-frequency-changes') as FrequencyChangeReceipt;
  assertFrequencyChangesReceipt(receipt, input.changes); return receipt;
}
export function readFrequencyChangesValidation(value: unknown, input: FrequencyChangesValidationInput): FrequencyChangesValidation {
  const row = record(value, ['revision', 'base_revision', 'data_origin', 'source', 'selected_ids', 'would_change', 'unchanged', 'items', 'impact']);
  const rev = revision(row.revision);
  if (rev !== input.revision || row.base_revision !== rev || !Array.isArray(row.items)) fail('changes preview version');
  const selectedIds = ids(row.selected_ids), wouldChange = ids(row.would_change), unchanged = ids(row.unchanged);
  partition(selectedIds, wouldChange, unchanged, input.changes.map(action => action.freqId));
  const values = (row.items as unknown[]).map(value => {
    const v = record(value, ['kind', 'freq_id', 'before', 'after']), action = input.changes.find(action => action.freqId === v.freq_id);
    if (!action || v.kind !== action.kind) fail('preview action');
    const before = v.before === null ? null : item(v.before), after = item(v.after);
    if (after.freqId !== action.freqId || before && before.freqId !== action.freqId || (action.kind === 'ADD') !== (before === null)) fail('preview identity');
    let expected: FrequencyResourceItem;
    if (action.kind === 'ADD') expected = { freqId: action.freqId, ...action.item, note: constructedFrequencyNote(action.item.note), isAvailable: false, occupiedBy: null };
    else {
      expected = { ...before!, ...(action.kind === 'PATCH' ? action.fields : { isAvailable: true }) };
      if (action.kind === 'PATCH' && !sameItem(expected, before!)) expected.note = constructedFrequencyNote(expected.note);
    }
    if (!sameItem(after, expected) || wouldChange.includes(action.freqId) !== (!before || !sameItem(before, after))) fail('preview result');
    return { kind: action.kind, freqId: action.freqId, before, after };
  });
  if (!equal(values.map(value => value.freqId), selectedIds)) fail('preview selection');
  const impact = record(row.impact, ['resource_revision_will_change', 'historical_resources_preserved', 'saved_plans_require_recompute', 'link_impact']);
  const changed = wouldChange.length > 0;
  if (impact.resource_revision_will_change !== changed || impact.saved_plans_require_recompute !== changed
    || impact.historical_resources_preserved !== true || impact.link_impact !== 'UNKNOWN') fail('changes impact');
  return { ...source(row), revision: rev, baseRevision: rev, selectedIds, wouldChange, unchanged, items: values,
    impact: { resourceRevisionWillChange: changed, historicalResourcesPreserved: true, savedPlansRequireRecompute: changed, linkImpact: 'UNKNOWN' } };
}

function integer(value: unknown, field: string, minimum = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : fail(field);
}
function pageFields(row: Record<string, unknown>, input: { page: number; pageSize: number }, count: number) {
  const page = integer(row.page, 'page', 1), pageSize = integer(row.page_size, 'page_size', 1), total = integer(row.total, 'total');
  if (page !== input.page || pageSize !== input.pageSize
    || count !== Math.min(pageSize, Math.max(0, total - (page - 1) * pageSize))) fail('page association');
  return { page, pageSize, total };
}
export function readFrequencyPage(value: unknown, input: FrequencyPageQuery): FrequencyResourcePage {
  const row = record(value, [...metadataKeys, 'page', 'page_size', 'total']);
  const result = snapshot(row, input.revision);
  for (const item of result.items) {
    if (input.deviceClass && item.deviceClass !== input.deviceClass
      || input.availability && item.isAvailable !== (input.availability === 'AVAILABLE')
      || input.minKhz !== undefined && item.centerFreqKhz < input.minKhz
      || input.maxKhz !== undefined && item.centerFreqKhz > input.maxKhz
      || input.search && !item.freqId.includes(input.search) && !item.note?.includes(input.search)) fail('filter association');
  }
  return { ...result, ...pageFields(row, input, result.items.length) };
}
function timestamp(value: unknown): string {
  const result = text(value, 'created_at');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result)
    || !Number.isFinite(Date.parse(result))) fail('created_at');
  return result;
}
function compareOperationTime(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds) return milliseconds;
  // 原回执包含微秒；Date.parse 只保留毫秒，不能据此误用请求号排序。
  const a = left.match(/\.(\d+)/)?.[1]?.slice(3) ?? '', b = right.match(/\.(\d+)/)?.[1]?.slice(3) ?? '';
  const width = Math.max(a.length, b.length), first = a.padEnd(width, '0'), second = b.padEnd(width, '0');
  return first < second ? -1 : first > second ? 1 : 0;
}
export function compareFrequencyIds(left: string, right: string): number {
  const a = Array.from(left, char => char.codePointAt(0)!), b = Array.from(right, char => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
export function readFrequencyOperation(value: unknown, input: FrequencyOperationQuery): FrequencyOperation {
  const row = record(value, ['operation', 'request_id', 'created_at', 'receipt']);
  if (!['FREQUENCY_DISABLE', 'FREQUENCY_CHANGES'].includes(row.operation as string) || row.request_id !== input.requestId) fail('operation association');
  if (!row.receipt || typeof row.receipt !== 'object' || Array.isArray(row.receipt)) fail('receipt');
  const raw = row.receipt as Record<string, unknown>;
  const receipt = readReceipt(raw, { context: 'ledger', requestId: input.requestId,
    baseRevision: revision(raw.base_revision), ids: ids(raw.selected_ids) }, row.operation === 'FREQUENCY_DISABLE' ? 'resource-frequency-disable' : 'resource-frequency-changes');
  if (receipt.selectedIds.length < 1 || receipt.selectedIds.length > 50) fail('receipt count');
  return { operation: row.operation as FrequencyOperation['operation'], requestId: input.requestId, createdAt: timestamp(row.created_at), receipt };
}
export function readFrequencyOperations(value: unknown, input: FrequencyHistoryQuery): FrequencyOperationPage {
  const row = record(value, ['page', 'page_size', 'total', 'items']);
  if (!Array.isArray(row.items)) fail('history items');
  const values: FrequencyOperationSummary[] = (row.items as unknown[]).map(value => {
    const v = record(value, ['operation', 'request_id', 'created_at', 'base_revision', 'revision', 'changed',
      'selected_count', 'updated_count', 'unchanged_count']);
    const requestId = id(v.request_id), baseRevision = revision(v.base_revision), rev = revision(v.revision);
    const selectedCount = integer(v.selected_count, 'selected_count', 1), updatedCount = integer(v.updated_count, 'updated_count');
    const unchangedCount = integer(v.unchanged_count, 'unchanged_count');
    if (!['FREQUENCY_DISABLE', 'FREQUENCY_CHANGES'].includes(v.operation as string) || typeof v.changed !== 'boolean' || selectedCount > 50
      || selectedCount !== updatedCount + unchangedCount || v.changed !== (updatedCount > 0)
      || v.changed === (rev === baseRevision) || input.search && !requestId.includes(input.search)) fail('history summary');
    return { operation: v.operation as FrequencyOperationSummary['operation'], requestId, createdAt: timestamp(v.created_at), baseRevision,
      revision: rev, changed: v.changed as boolean, selectedCount, updatedCount, unchangedCount };
  });
  if (new Set(values.map(v => v.requestId)).size !== values.length) fail('duplicate operations');
  for (let i = 1; i < values.length; i++) {
    const before = values[i - 1]!, after = values[i]!;
    const time = compareOperationTime(before.createdAt, after.createdAt);
    if (time < 0 || time === 0 && compareFrequencyIds(before.requestId, after.requestId) > 0) fail('history order');
  }
  return { ...pageFields(row, input, values.length), items: values };
}
