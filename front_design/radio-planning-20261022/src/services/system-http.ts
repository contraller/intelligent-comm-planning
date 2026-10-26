import type { AuthenticatedRequest } from './auth-http';
import type { ReadRequest } from '../types/data-access';
import type { SystemServices, SystemQuery } from '../types/system';
import type { SystemManagementActions } from '../types/system-management';
import { accountDto, eventDto, object, optionsDto, pageDto, parameterDto, receiptDto, resultDto, roleDto, text } from './system-http-validation';
import { ApiError } from './types';

type Methods = Pick<SystemServices, 'loadSystemOptions' | 'queryAccountSummaries' | 'queryRoleSummaries' | 'queryParameterSummaries' | 'queryOperationSummaries' | 'getSystemAccount' | 'getSystemRole' | 'getSystemParameter' | 'getOperationEvent' | 'querySystemAccounts' | 'saveSystemAccount' | 'setSystemAccountState' | 'querySystemRoles' | 'saveSystemRole' | 'querySystemParameters' | 'saveSystemParameter' | 'queryOperationLogs'> & SystemManagementActions;
const pathId = (value: string) => encodeURIComponent(text(value));
export function createSystemManagementHttp(request: AuthenticatedRequest): Methods {
  const base = '/system';
  async function list<T extends { id: string }>(kind: string, query: SystemQuery & ReadRequest = {}, decode: (v: unknown) => T) {
    const { signal, ...snapshot } = query, frozen = { ...snapshot };
    const fields = new URLSearchParams();
    for (const [key, value] of Object.entries(frozen)) if (value !== undefined && value !== '') fields.set(key, String(value));
    return pageDto(await request(base + '/' + kind + (fields.size ? '?' + fields : ''), { signal }), decode, frozen);
  }
  async function detail<T extends { id: string }>(kind: string, field: string, input: ReadRequest & { id: string }, decode: (v: unknown) => T) {
    const id = input.id, signal = input.signal;
    const dto = object(await request(base + '/' + kind + '/' + pathId(id), { signal })), value = decode(dto[field]);
    if (value.id !== id) throw new ApiError('系统对象与请求不一致', 'INVALID_SYSTEM_RESPONSE');
    return { revision: text(dto.revision), value };
  }
  const write = async (path: string, method: string, body: unknown, expectedId?: string) => {
    // JSON 在第一次 await 前生成，调用方随后修改表单不影响已发出的事务。
    const encoded = JSON.stringify(body);
    const result = resultDto(await request(base + path, { method, body: encoded }));
    if (expectedId !== undefined && result.objectId !== expectedId) throw new ApiError('系统写回执与请求对象不一致', 'INVALID_SYSTEM_RESPONSE');
    return result;
  };
  return {
    async loadSystemOptions(input = {}) { const signal = input.signal; return optionsDto(await request(base + '/options', { signal })); },
    queryAccountSummaries: q => list('accounts', q, accountDto), querySystemAccounts: q => list('accounts', q, accountDto),
    queryRoleSummaries: q => list('roles', q, roleDto), querySystemRoles: q => list('roles', q, roleDto),
    queryParameterSummaries: q => list('parameters', q, parameterDto), querySystemParameters: q => list('parameters', q, parameterDto),
    queryOperationSummaries: q => list('logs', q, eventDto), queryOperationLogs: q => list('logs', q, eventDto),
    async getSystemAccount(input) { const d = await detail('accounts', 'account', input, accountDto); return { revision: d.revision, account: d.value }; },
    async getSystemRole(input) { const d = await detail('roles', 'role', input, roleDto); return { revision: d.revision, role: d.value }; },
    async getSystemParameter(input) { const d = await detail('parameters', 'parameter', input, parameterDto); return { revision: d.revision, parameter: d.value }; },
    async getOperationEvent(input) { const id = input.id, signal = input.signal, dto = eventDto(await request(base + '/logs/' + pathId(id), { signal })); if (dto.id !== id) throw new ApiError('日志对象不一致', 'INVALID_SYSTEM_RESPONSE'); return dto; },
    saveSystemAccount(input) {
      const { account: a, baseRevision, requestId, initialPassword } = input;
      const profile = { name: a.name, department: a.department, roleId: a.roleId };
      if (!a.id && !initialPassword) return Promise.reject(new ApiError('新增账号必须显式设置初始密码', 'INITIAL_PASSWORD_REQUIRED'));
      return write('/accounts' + (a.id ? '/' + pathId(a.id) : ''), a.id ? 'PUT' : 'POST', { baseRevision, requestId, account: a.id ? profile : { username: a.username, ...profile }, ...(!a.id ? { initialPassword } : {}) }, a.id ?? undefined);
    },
    setSystemAccountState: i => write('/accounts/' + pathId(i.accountId) + '/state', 'POST', { baseRevision: i.baseRevision, requestId: i.requestId, enabled: i.enabled }, i.accountId),
    saveSystemRole: i => write('/roles' + (i.role.id ? '/' + pathId(i.role.id) : ''), i.role.id ? 'PUT' : 'POST', { baseRevision: i.baseRevision, requestId: i.requestId, role: { name: i.role.name, description: i.role.description, permissions: [...i.role.permissions] } }, i.role.id ?? undefined),
    saveSystemParameter: i => write('/parameters/' + pathId(i.parameterId), 'PUT', { baseRevision: i.baseRevision, requestId: i.requestId, value: i.value }, i.parameterId),
    async getSystemOperation(input) { const id = input.requestId, signal = input.signal; return receiptDto(await request(base + '/operations/' + pathId(id), { signal })); },
    maintainSystemAccountPassword: i => write('/accounts/' + pathId(i.accountId) + '/password', 'POST', { baseRevision: i.baseRevision, requestId: i.requestId, operatorPassword: i.operatorPassword, newPassword: i.newPassword }, i.accountId),
    resetSystemParameters: i => write('/actions/reset-parameters', 'POST', { ...i, parameterIds: [...i.parameterIds] }, 'parameters'),
    archiveSystemLogs: i => write('/actions/archive-logs', 'POST', { ...i }, 'audit-view'),
  };
}
