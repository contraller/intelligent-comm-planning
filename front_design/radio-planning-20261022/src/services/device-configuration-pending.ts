import { ApiError } from './types';
import { configurationRequestInput, type ConfigurationSubmissionInput } from './device-configuration-decode';

export type PendingStorage = Pick<Storage, 'getItem' | 'setItem'>;
const key = (account: string) => 'device-configuration-pending-a1:' + encodeURIComponent(account);
const fail = (): never => { throw new ApiError('待核实请求存储不可用或已损坏，请保留原记录', 'PENDING_STORAGE_ERROR'); };
function storage(value?: PendingStorage): PendingStorage {
  if (value) return value;
  try { if (typeof window !== 'undefined' && window.localStorage) return window.localStorage; } catch { /* 明确失败，不能内存假保存。 */ }
  return fail();
}
export function readPendingConfiguration(account: string, value?: PendingStorage): ConfigurationSubmissionInput | null {
  try {
    if (!account) return fail();
    const raw = storage(value).getItem(key(account));
    if (raw === null) return null;
    const row = JSON.parse(raw);
    if (!row || Object.keys(row).length !== 3 || row.schema !== 'device-configuration-pending-a1' || row.account_id !== account || !Object.hasOwn(row, 'request')) return fail();
    if (row.request === null) return null;
    configurationRequestInput(row.request, true);
    return structuredClone(row.request) as ConfigurationSubmissionInput;
  } catch { return fail(); }
}
export function savePendingConfiguration(account: string, request: ConfigurationSubmissionInput, value?: PendingStorage) {
  configurationRequestInput(request, true);
  const captured = { ...request, values: { ...request.values } }, target = storage(value);
  const prior = readPendingConfiguration(account, target);
  if (prior && JSON.stringify(prior) !== JSON.stringify(captured)) throw new ApiError('该账号已有待核实请求，请先核实原号', 'PENDING_REQUEST_EXISTS');
  try {
    target.setItem(key(account), JSON.stringify({ schema: 'device-configuration-pending-a1', account_id: account, request: captured }));
    if (JSON.stringify(readPendingConfiguration(account, target)) !== JSON.stringify(captured)) return fail();
  } catch { return fail(); }
}
export function clearPendingConfiguration(account: string, requestId: string, value?: PendingStorage) {
  const target = storage(value), prior = readPendingConfiguration(account, target);
  if (!prior || prior.request_id !== requestId) return;
  try { target.setItem(key(account), JSON.stringify({ schema: 'device-configuration-pending-a1', account_id: account, request: null })); }
  catch { return fail(); }
}
