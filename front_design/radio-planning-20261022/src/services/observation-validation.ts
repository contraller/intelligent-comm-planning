import { OBSERVATION_ORIGIN } from '../types/observation';
import type { ObservationContext, ObservationDataset, ObservationFrame, ObservationFramePage, ObservationFrameQuery, ObservationFrameResult, ObservationIndexQuery, ObservationPage, ObservationPageQuery, ObservationSelection } from '../types/observation';
import { ApiError } from './types';

type RecordValue = Record<string, unknown>;
const idPattern = /^[A-Za-z0-9_.:-]{1,120}$/;
const revisionPattern = /^observation-[0-9a-f]{64}$/;
const frameFields = ['frameId', 'index', 'observedAt', 'label', 'bins', 'occupancyPercent', 'abnormalBandCount', 'unknownReasons', 'datasetId', 'datasetRevision', 'dataOrigin'];
const identityFields = ['schemaVersion', 'dataOrigin', 'datasetId', 'datasetRevision', 'resourceRevision', 'sourceId', 'configRevision', 'frameCount'];
const summaryFields = ['datasetId', 'datasetRevision', 'schemaVersion', 'dataOrigin', 'provenanceNote', 'resourceRevision', 'deviceStatusSnapshotId', 'source', 'frameCount', 'firstObservedAt', 'lastObservedAt', 'importedAt', 'contentHash'];
function fail(): never { throw new ApiError('观测响应不符合契约，原结果已保留', 'INVALID_OBSERVATION_RESPONSE'); }
function check(condition: unknown): asserts condition { if (!condition) fail(); }
function record(value: unknown, fields?: string[]): RecordValue {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  const result = value as RecordValue;
  if (fields) check(Object.keys(result).length === fields.length && fields.every(key => Object.hasOwn(result, key)));
  return result;
}
function text(value: unknown, max = 120): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max; }
function identifier(value: unknown): value is string { return typeof value === 'string' && idPattern.test(value); }
function revision(value: unknown): value is string { return typeof value === 'string' && revisionPattern.test(value); }
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function percent(value: unknown): boolean { return value === null || finite(value) && value >= 0 && value <= 100; }
function time(value: unknown, nullable = true): boolean {
  return nullable && value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function reasons(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 16 && value.every(item => text(item, 200)) && new Set(value).size === value.length; }
function header(data: RecordValue) { check(data.schemaVersion === 1 && data.dataOrigin === OBSERVATION_ORIGIN); }

export function assertObservationQuery(input: unknown, mode: 'context' | 'datasets' | 'frames' | 'index'): void {
  const invalid = () => { throw new ApiError('观测查询参数无效', 'INVALID_OBSERVATION_QUERY'); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const data = input as RecordValue;
  const allowed = mode === 'context' ? ['datasetId', 'datasetRevision', 'signal'] : mode === 'datasets' ? ['page', 'pageSize', 'signal'] : mode === 'frames' ? ['datasetId', 'datasetRevision', 'page', 'pageSize', 'signal'] : ['datasetId', 'datasetRevision', 'index', 'signal'];
  if (Object.keys(data).some(key => !allowed.includes(key))) invalid();
  if (data.signal !== undefined && !(data.signal instanceof AbortSignal)) invalid();
  const selected = data.datasetId !== undefined || data.datasetRevision !== undefined;
  if ((mode === 'frames' || mode === 'index' || selected) && (!identifier(data.datasetId) || !revision(data.datasetRevision))) invalid();
  if ((mode === 'datasets' || mode === 'frames') && (!integer(data.page, 1) || !integer(data.pageSize, 1, 100))) invalid();
  if (mode === 'index' && !integer(data.index)) invalid();
}

function summary(value: unknown): ObservationDataset {
  const data = record(value, summaryFields); header(data);
  check(identifier(data.datasetId) && revision(data.datasetRevision) && identifier(data.resourceRevision));
  check(typeof data.contentHash === 'string' && /^[0-9a-f]{64}$/.test(data.contentHash) && data.datasetRevision === 'observation-' + data.contentHash);
  check(text(data.provenanceNote, 500) && data.deviceStatusSnapshotId === null && integer(data.frameCount, 1, 256));
  check(time(data.firstObservedAt) && time(data.lastObservedAt) && time(data.importedAt, false));
  if (typeof data.firstObservedAt === 'string' && typeof data.lastObservedAt === 'string') check(data.firstObservedAt <= data.lastObservedAt);
  const source = record(data.source, ['sourceId', 'name', 'configRevision', 'minKhz', 'maxKhz', 'intervalSeconds']);
  check(identifier(source.sourceId) && identifier(source.configRevision) && text(source.name, 60) && source.name === source.name.trim());
  check(finite(source.minKhz) && finite(source.maxKhz) && source.minKhz > 0 && source.minKhz < source.maxKhz);
  check(source.intervalSeconds === null || integer(source.intervalSeconds, 1, 3600));
  return value as ObservationDataset;
}

function frame(value: unknown, selection: ObservationSelection, index: number): ObservationFrame {
  const data = record(value, frameFields);
  check(data.dataOrigin === OBSERVATION_ORIGIN && data.datasetId === selection.datasetId && data.datasetRevision === selection.datasetRevision);
  check(identifier(data.frameId) && integer(data.index, 0, 255) && data.index === index && text(data.label));
  check(time(data.observedAt) && percent(data.occupancyPercent) && reasons(data.unknownReasons));
  check(Array.isArray(data.bins) && data.bins.length >= 1 && data.bins.length <= 256);
  let upper = 0, abnormalCount = 0, unknownAbnormal = false;
  const ids = new Set<string>();
  for (const value of data.bins) {
    const bin = record(value, ['binId', 'minKhz', 'maxKhz', 'occupancyPercent', 'powerDbm', 'abnormal', 'reason', 'unknownReasons']);
    check(identifier(bin.binId) && !ids.has(bin.binId)); ids.add(bin.binId);
    check(finite(bin.minKhz) && finite(bin.maxKhz) && bin.minKhz > 0 && bin.minKhz < bin.maxKhz && bin.minKhz >= upper); upper = bin.maxKhz;
    check(percent(bin.occupancyPercent) && (bin.powerDbm === null || finite(bin.powerDbm)) && (bin.abnormal === null || typeof bin.abnormal === 'boolean'));
    check((bin.reason === null || text(bin.reason, 500)) && reasons(bin.unknownReasons));
    if (bin.occupancyPercent === null || bin.powerDbm === null || bin.abnormal === null) check(bin.unknownReasons.length > 0);
    if (bin.abnormal === true) { check(text(bin.reason, 500)); abnormalCount++; }
    if (bin.abnormal === null) unknownAbnormal = true;
  }
  check(unknownAbnormal ? data.abnormalBandCount === null : data.abnormalBandCount === abnormalCount);
  if (data.observedAt === null || data.occupancyPercent === null || data.abnormalBandCount === null) check(data.unknownReasons.length > 0);
  return value as ObservationFrame;
}

function page(data: RecordValue, input: ObservationPageQuery) {
  header(data);
  check(data.page === input.page && data.pageSize === input.pageSize && integer(data.total) && Array.isArray(data.items));
  const expected = input.page > Math.ceil(data.total / input.pageSize) ? 0 : Math.min(input.pageSize, data.total - (input.page - 1) * input.pageSize);
  check(data.items.length === expected);
}
function identity(data: RecordValue, input: ObservationSelection) {
  header(data);
  check(data.datasetId === input.datasetId && data.datasetRevision === input.datasetRevision && identifier(data.resourceRevision));
  check(identifier(data.sourceId) && identifier(data.configRevision) && integer(data.frameCount, 1, 256));
}

export function decodeObservationContext(value: unknown, input: { datasetId?: string; datasetRevision?: string }): ObservationContext {
  const data = record(value, ['schemaVersion', 'dataOrigin', 'datasetCount', 'selected', 'reasons', 'replay']); header(data);
  check(integer(data.datasetCount) && Array.isArray(data.reasons));
  const replay = record(data.replay, ['mode', 'loop', 'maxFramesPerDataset', 'maxBinsPerFrame']);
  check(replay.mode === 'FINITE' && replay.loop === false && replay.maxFramesPerDataset === 256 && replay.maxBinsPerFrame === 256);
  if (input.datasetId !== undefined) {
    const selected = summary(data.selected);
    check(data.datasetCount > 0 && selected.datasetId === input.datasetId && selected.datasetRevision === input.datasetRevision && data.reasons.length === 0);
  } else {
    check(data.selected === null && data.reasons.length === 1 && data.reasons[0] === (data.datasetCount === 0 ? 'NO_IMPORTED_DATA' : 'DATASET_NOT_SELECTED'));
  }
  return value as ObservationContext;
}

export function decodeObservationDatasets(value: unknown, input: ObservationPageQuery): ObservationPage<ObservationDataset> {
  const data = record(value, ['schemaVersion', 'dataOrigin', 'items', 'page', 'pageSize', 'total']); page(data, input);
  let previous = '';
  for (const item of data.items as unknown[]) { const row = summary(item); check(previous < row.datasetId); previous = row.datasetId; }
  return value as ObservationPage<ObservationDataset>;
}

export function decodeObservationFrames(value: unknown, input: ObservationFrameQuery): ObservationFramePage {
  const data = record(value, [...identityFields, 'items', 'page', 'pageSize', 'total']); page(data, input); identity(data, input);
  check(data.total === data.frameCount);
  const ids = new Set<string>();
  let previous: string | null = null;
  for (const [position, item] of (data.items as unknown[]).entries()) {
    const row = frame(item, input, (input.page - 1) * input.pageSize + position);
    check(!ids.has(row.frameId)); ids.add(row.frameId);
    if (row.observedAt !== null) { if (previous !== null) check(previous <= row.observedAt); previous = row.observedAt; }
  }
  return value as ObservationFramePage;
}

export function decodeObservationFrame(value: unknown, input: ObservationIndexQuery): ObservationFrameResult {
  const data = record(value, [...identityFields, 'index', 'hasPrevious', 'hasNext', 'frame']); identity(data, input);
  check(data.index === input.index && integer(data.frameCount) && input.index < data.frameCount);
  check(data.hasPrevious === (input.index > 0) && data.hasNext === (input.index + 1 < data.frameCount));
  frame(data.frame, input, input.index);
  return value as ObservationFrameResult;
}
