import { ApiError } from './types';

export const deviceConfigurationSchema = 'device-configuration-a1' as const;
export const acceptanceMessage = '配置请求已持久化，系统受理；未下发，设备执行与生效状态待确认';
export interface RequestValues { tx_power_dbm: number; work_freq_khz: number }
export interface ConfigurationRequestInput {
  schema_version: typeof deviceConfigurationSchema; context: 'ledger'; base_revision: string;
  device_id: string; model_id: string; values: RequestValues;
}
export interface ConfigurationSubmissionInput extends ConfigurationRequestInput { request_id: string }
export interface ConfigurationContextQuery { context: 'ledger'; device_id: string; revision: string }
export interface ConfigurationDetailQuery { context: 'ledger'; request_id: string }
export interface ConfigurationHistoryQuery { context: 'ledger'; device_id?: string; page?: number; page_size?: number }
export interface DeviceSnapshot {
  device_id: string; node_id: string; model_id: string; availability: 'ACTIVE';
  source_values: { tx_power_dbm: number | null; work_freq_khz: number | null };
}
export interface ModelConstraints { model_id: string; freq_min_khz: number; freq_max_khz: number; tx_power_max_dbm: number }
export interface Provenance {
  data_origin: 'SYNTHETIC_INTEGRATION'; resource_source: string;
  source_files: Record<string, { path: string; sha256: string }>;
}
export interface ConfigurationAcceptanceContext {
  schema_version: typeof deviceConfigurationSchema; context: 'ledger'; resource_revision: string; resource_content_hash: string;
  device: DeviceSnapshot; model: ModelConstraints; provenance: Provenance;
  protocol: { port_options: null; mode_options: null; confirmation: '待确认' };
}
export interface ConfigurationSystemAcceptance {
  schema_version: typeof deviceConfigurationSchema | 'device-configuration-a2'; configuration_id: string; request_id: string; request_digest: string;
  context: 'ledger'; device_id: string; model_id: string; base_revision: string; resource_content_hash: string;
  requested_values: RequestValues; device_snapshot: DeviceSnapshot; model_constraints: ModelConstraints; provenance: Provenance;
  actor: { account_id: string; display_name: string; role_id: string; identity_revision: string } &
    ({ integration_mode: true } | { authentication_mode: 'LOCAL_PASSWORD' | 'INTEGRATION' });
  accepted_at: string; status: 'ACCEPTED'; receipt_scope: 'SYSTEM_ACCEPTANCE'; dispatch_status: 'NOT_DISPATCHED';
  device_execution_status: 'UNKNOWN'; applied_values: null; online: null; effective: null; device_reported_at: null; message: string;
}
export interface ConfigurationAcceptanceHistoryItem {
  configuration_id: string; request_id: string; device_id: string; model_id: string; base_revision: string;
  requested_values: RequestValues; accepted_at: string; status: 'ACCEPTED'; receipt_scope: 'SYSTEM_ACCEPTANCE';
  dispatch_status: 'NOT_DISPATCHED'; data_origin: 'SYNTHETIC_INTEGRATION';
}
export interface ConfigurationAcceptanceHistory {
  schema_version: typeof deviceConfigurationSchema; context: 'ledger'; items: ConfigurationAcceptanceHistoryItem[];
  total: number; page: number; page_size: number;
}

type Row = Record<string, unknown>;
const fail = (): never => { throw new ApiError('设备配置受理响应不符合契约', 'INVALID_CONFIGURATION_RESPONSE'); };
const invalid = (): never => { throw new ApiError('设备配置受理请求无效', 'VALIDATION_ERROR'); };
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 120 && !/\s|[\u0000-\u001f\u007f]/.test(v);
const isRequestId = (v: unknown): v is string => isId(v) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v) && !['context', 'validate', 'history'].includes(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const hash = (v: unknown) => typeof v === 'string' && v.length === 64 && /^[0-9a-f]{64}$/.test(v);
const revision = (v: unknown) => typeof v === 'string' && v.length === 25 && /^resource-[0-9a-f]{16}$/.test(v);
const configurationId = (v: unknown) => typeof v === 'string' && v.length === 35 && /^DC-[0-9a-f]{32}$/.test(v);
const stamp = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19);
// Date.parse 丢失微秒；保留服务端六位小数后再验证历史排序。
const timeKey = (v: string) => v.slice(0, 19) + '.' + (v.split('.')[1]?.slice(0, -1) ?? '').padEnd(6, '0');
function object(v: unknown, keys: readonly string[], onError: () => never = fail): Row {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return onError();
  const row = v as Row;
  if (Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k))) return onError();
  return row;
}
function values(v: unknown, onError: () => never = fail): RequestValues {
  const row = object(v, ['tx_power_dbm', 'work_freq_khz'], onError);
  if (!finite(row.tx_power_dbm) || !finite(row.work_freq_khz) || row.work_freq_khz <= 0) return onError();
  return row as unknown as RequestValues;
}
function device(v: unknown): DeviceSnapshot {
  const row = object(v, ['device_id', 'node_id', 'model_id', 'availability', 'source_values']);
  if (![row.device_id, row.node_id, row.model_id].every(isId) || row.availability !== 'ACTIVE') fail();
  const source = object(row.source_values, ['tx_power_dbm', 'work_freq_khz']);
  if (Object.values(source).some(x => x !== null && !finite(x))) fail();
  return row as unknown as DeviceSnapshot;
}
function model(v: unknown): ModelConstraints {
  const row = object(v, ['model_id', 'freq_min_khz', 'freq_max_khz', 'tx_power_max_dbm']);
  if (!isId(row.model_id) || !finite(row.freq_min_khz) || row.freq_min_khz <= 0 || !finite(row.freq_max_khz)
    || row.freq_max_khz < row.freq_min_khz || !finite(row.tx_power_max_dbm)) fail();
  return row as unknown as ModelConstraints;
}
function provenance(v: unknown) {
  const row = object(v, ['data_origin', 'resource_source', 'source_files']);
  if (row.data_origin !== 'SYNTHETIC_INTEGRATION' || typeof row.resource_source !== 'string' || !row.resource_source.trim()
    || !row.source_files || typeof row.source_files !== 'object' || Array.isArray(row.source_files) || !Object.keys(row.source_files).length) fail();
  for (const source of Object.values(row.source_files as Row)) {
    const file = object(source, ['path', 'sha256']);
    if (typeof file.path !== 'string' || !file.path.startsWith('data/') || !hash(file.sha256)) fail();
  }
}
function within(v: RequestValues, m: ModelConstraints) {
  if (v.tx_power_dbm > m.tx_power_max_dbm || v.work_freq_khz < m.freq_min_khz || v.work_freq_khz > m.freq_max_khz) fail();
}

export function configurationRequestInput(v: unknown, submission = false): asserts v is ConfigurationRequestInput | ConfigurationSubmissionInput {
  const row = object(v, ['schema_version', 'context', 'base_revision', 'device_id', 'model_id', 'values', ...(submission ? ['request_id'] : [])], invalid);
  if (row.schema_version !== deviceConfigurationSchema || row.context !== 'ledger' || ![row.base_revision, row.device_id, row.model_id].every(isId)
    || submission && !isRequestId(row.request_id)) invalid();
  values(row.values, invalid);
}
export function configurationContextQuery(v: unknown): asserts v is ConfigurationContextQuery {
  const row = object(v, ['context', 'device_id', 'revision'], invalid);
  if (row.context !== 'ledger' || !isId(row.device_id) || !isId(row.revision)) invalid();
}
export function configurationDetailQuery(v: unknown): asserts v is ConfigurationDetailQuery {
  const row = object(v, ['context', 'request_id'], invalid);
  if (row.context !== 'ledger' || !isRequestId(row.request_id)) invalid();
}
export function configurationHistoryQuery(v: unknown): asserts v is ConfigurationHistoryQuery {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid();
  const row = v as Row;
  if (row.context !== 'ledger' || Object.keys(row).some(k => !['context', 'device_id', 'page', 'page_size'].includes(k))
    || Object.hasOwn(row, 'device_id') && !isId(row.device_id)) invalid();
  for (const key of ['page', 'page_size']) if (Object.hasOwn(row, key)) {
    if (!Number.isSafeInteger(row[key]) || (row[key] as number) < 1 || key === 'page_size' && (row[key] as number) > 100
      || key === 'page' && (row[key] as number) > 9999999999) invalid();
  }
}
export function readConfigurationContext(v: unknown, expected?: ConfigurationContextQuery): ConfigurationAcceptanceContext {
  const row = object(v, ['schema_version', 'context', 'resource_revision', 'resource_content_hash', 'device', 'model', 'provenance', 'protocol']);
  if (row.schema_version !== deviceConfigurationSchema || row.context !== 'ledger' || !revision(row.resource_revision) || !hash(row.resource_content_hash)) fail();
  const d = device(row.device), m = model(row.model);
  if (d.model_id !== m.model_id || expected && (row.resource_revision !== expected.revision || d.device_id !== expected.device_id)) fail();
  provenance(row.provenance);
  const protocol = object(row.protocol, ['port_options', 'mode_options', 'confirmation']);
  if (protocol.port_options !== null || protocol.mode_options !== null || protocol.confirmation !== '待确认') fail();
  return structuredClone(row) as unknown as ConfigurationAcceptanceContext;
}
export function readConfigurationValidation(v: unknown, expected: ConfigurationRequestInput) {
  const row = object(v, ['valid', 'context', 'requested_values']);
  if (row.valid !== true) fail();
  const context = readConfigurationContext(row.context, { context: 'ledger', device_id: expected.device_id, revision: expected.base_revision });
  const requested = values(row.requested_values);
  if (context.model.model_id !== expected.model_id || requested.tx_power_dbm !== expected.values.tx_power_dbm || requested.work_freq_khz !== expected.values.work_freq_khz) fail();
  within(requested, context.model);
  return { valid: true as const, context, requested_values: structuredClone(requested) };
}
export function readConfigurationAcceptance(v: unknown, expected: ConfigurationDetailQuery | ConfigurationSubmissionInput): ConfigurationSystemAcceptance {
  const row = object(v, ['schema_version', 'configuration_id', 'request_id', 'request_digest', 'context', 'device_id', 'model_id', 'base_revision',
    'resource_content_hash', 'requested_values', 'device_snapshot', 'model_constraints', 'provenance', 'actor', 'accepted_at', 'status', 'receipt_scope',
    'dispatch_status', 'device_execution_status', 'applied_values', 'online', 'effective', 'device_reported_at', 'message']);
  if (![deviceConfigurationSchema, 'device-configuration-a2'].includes(row.schema_version as string) || row.context !== 'ledger' || !configurationId(row.configuration_id) || !isRequestId(row.request_id)
    || row.request_id !== expected.request_id || !hash(row.request_digest) || !revision(row.base_revision) || !hash(row.resource_content_hash)
    || !stamp(row.accepted_at) || row.status !== 'ACCEPTED' || row.receipt_scope !== 'SYSTEM_ACCEPTANCE' || row.dispatch_status !== 'NOT_DISPATCHED'
    || row.device_execution_status !== 'UNKNOWN' || row.message !== acceptanceMessage
    || ['applied_values', 'online', 'effective', 'device_reported_at'].some(k => row[k] !== null)) fail();
  const d = device(row.device_snapshot), m = model(row.model_constraints), requested = values(row.requested_values);
  if (row.device_id !== d.device_id || row.model_id !== d.model_id || m.model_id !== d.model_id) fail();
  within(requested, m); provenance(row.provenance);
  const a1 = row.schema_version === deviceConfigurationSchema;
  const actor = object(row.actor, ['account_id', 'display_name', 'role_id', 'identity_revision', a1 ? 'integration_mode' : 'authentication_mode']);
  if (![actor.account_id, actor.role_id, actor.identity_revision].every(isId) || typeof actor.display_name !== 'string' || !actor.display_name.trim()
    || (a1 ? actor.integration_mode !== true : !['LOCAL_PASSWORD', 'INTEGRATION'].includes(actor.authentication_mode as string))) fail();
  if ('base_revision' in expected && (row.base_revision !== expected.base_revision || row.device_id !== expected.device_id || row.model_id !== expected.model_id
    || requested.tx_power_dbm !== expected.values.tx_power_dbm || requested.work_freq_khz !== expected.values.work_freq_khz)) fail();
  return structuredClone(row) as unknown as ConfigurationSystemAcceptance;
}
export function readConfigurationHistory(v: unknown, expected: ConfigurationHistoryQuery): ConfigurationAcceptanceHistory {
  const row = object(v, ['schema_version', 'context', 'items', 'total', 'page', 'page_size']);
  if (row.schema_version !== deviceConfigurationSchema || row.context !== 'ledger' || !Number.isSafeInteger(row.total) || (row.total as number) < 0
    || row.page !== (expected.page ?? 1) || row.page_size !== (expected.page_size ?? 20) || !Array.isArray(row.items)
    || row.items.length > (row.page_size as number) || row.items.length > (row.total as number)) fail();
  const requestIds = new Set(), ids = new Set();
  let previous: { time: string; id: string } | undefined;
  for (const v of row.items as unknown[]) {
    const item = object(v, ['configuration_id', 'request_id', 'device_id', 'model_id', 'base_revision', 'requested_values', 'accepted_at', 'status', 'receipt_scope', 'dispatch_status', 'data_origin']);
    if (!configurationId(item.configuration_id) || !isRequestId(item.request_id) || ![item.device_id, item.model_id].every(isId)
      || !revision(item.base_revision) || !stamp(item.accepted_at) || item.status !== 'ACCEPTED' || item.receipt_scope !== 'SYSTEM_ACCEPTANCE'
      || item.dispatch_status !== 'NOT_DISPATCHED' || item.data_origin !== 'SYNTHETIC_INTEGRATION'
      || expected.device_id !== undefined && item.device_id !== expected.device_id || requestIds.has(item.request_id) || ids.has(item.configuration_id)) fail();
    values(item.requested_values);
    const time = timeKey(item.accepted_at as string), id = item.configuration_id as string;
    if (previous && (time > previous.time || time === previous.time && id > previous.id)) fail();
    previous = { time, id }; requestIds.add(item.request_id); ids.add(item.configuration_id);
  }
  return structuredClone(row) as unknown as ConfigurationAcceptanceHistory;
}
