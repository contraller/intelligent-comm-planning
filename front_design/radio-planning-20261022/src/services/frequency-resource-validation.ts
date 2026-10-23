import type {
  FrequencyDisableInput, FrequencyDisableReceipt, FrequencyDisableValidation,
  FrequencyDisableValidationInput, FrequencyResourceItem, FrequencyResourceSnapshot,
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
  if (new Set(result).size !== result.length || !equal(result, [...result].sort())) fail('ids order/duplicates');
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
  if (!equal(selected, [...expected].sort()) || updated.some(value => unchanged.includes(value))
    || !equal([...updated, ...unchanged].sort(), selected)) fail('selection partition');
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

export function readFrequencyDisableReceipt(value: unknown, input: FrequencyDisableInput): FrequencyDisableReceipt {
  const row = record(value, ['object_id', 'request_id', 'base_revision', 'selected_ids', 'affected_ids', 'updated',
    'unchanged', 'items', 'data_origin', 'source', 'warnings', 'changed', 'revision', 'read_revision']);
  const rev = revision(row.revision), base = revision(row.base_revision);
  const selectedIds = ids(row.selected_ids), updated = ids(row.updated), unchanged = ids(row.unchanged);
  const affectedIds = ids(row.affected_ids), savedItems = items(row.items);
  partition(selectedIds, updated, unchanged, input.ids);
  if (row.object_id !== 'resource-frequency-disable' || row.request_id !== input.requestId || base !== input.baseRevision
    || row.read_revision !== rev || typeof row.changed !== 'boolean' || row.changed !== (updated.length > 0)
    || row.changed === (rev === base) || !equal(affectedIds, updated)
    || !equal(savedItems.map(v => v.freqId), selectedIds) || savedItems.some(v => v.isAvailable)
    || !Array.isArray(row.warnings) || row.warnings.length !== 0) fail('receipt');
  // 回执固定在原提交版本；不将后续当前资源状态混入幂等重放结果。
  return { ...source(row), objectId: 'resource-frequency-disable', requestId: input.requestId,
    baseRevision: base, revision: rev, readRevision: rev, changed: row.changed as boolean,
    selectedIds, affectedIds, updated, unchanged, items: savedItems, warnings: [] };
}
