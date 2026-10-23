import { describe, expect, it, vi } from 'vitest';
import { createSystemManagementHttp } from '../src/services/system-http';
import { accountDto, eventDto, optionsDto, pageDto, parameterDto, resultDto, roleDto } from '../src/services/system-http-validation';
import type { AuthenticatedRequest } from '../src/services/auth-http';

const result = () => ({ revision: 'SYS-2', objectId: 'ACC-one', changed: true, operationId: 'OP-one' });
const account = () => ({ id: 'ACC-one', username: 'operator', name: '维护员', department: '测试', roleId: 'ROLE-one', roleName: '维护角色', enabled: true, mustChangePassword: false, lastLogin: null });
const role = () => ({ id: 'ROLE-one', name: '维护角色', description: '', permissions: ['system.view', 'system.accounts'], permissionCount: 2, accountCount: 1 });
const parameter = () => ({ id: 'PAR-01', name: '展示周期', value: 30, unit: 's', description: '仅展示', readonly: false, min: 1, max: 3600, applicationState: 'STORED_ONLY', appliesTo: '展示' });
const page = (items: unknown[]) => ({ revision: 'SYS-1', epoch: 'epoch-one', items, total: items.length, pageNum: 1, pageSize: 20 });
const event = () => ({ id: 'AUD-one', sequence: 1, epoch: 'LOCAL_AUDIT_V1', time: '2026-10-23T12:00:00Z', actor: null, attemptedUsername: '', module: 'auth', action: 'auth.login', objectId: '', requestId: null, outcome: 'DENIED', summary: '请求被拒绝', errorCode: '1101', dedupeKey: 'AUD-one', changes: {}, authSource: 'LOCAL_PASSWORD' });
function fixture(value: unknown) { const request = vi.fn(async (_path: string, _init?: RequestInit) => structuredClone(value)); return { request, service: createSystemManagementHttp(request as AuthenticatedRequest) }; }

describe('系统管理专用 HTTP 适配', () => {
  it('列表筛选和取消信号在请求发起时冻结', async () => {
    const f = fixture(page([account()])), controller = new AbortController();
    const query = { search: '维护', enabled: false, pageNum: 1, pageSize: 20, signal: controller.signal };
    const pending = f.service.queryAccountSummaries(query); query.search = '随后修改'; query.pageNum = 8;
    expect((await pending).items[0]!.id).toBe('ACC-one');
    expect(f.request.mock.calls[0]).toEqual(['/system/accounts?search=%E7%BB%B4%E6%8A%A4&enabled=false&pageNum=1&pageSize=20', { signal: controller.signal }]);
  });
  it('新增密码只进入真实请求体，不进入账号 DTO', async () => {
    const f = fixture(result());
    await expect(f.service.saveSystemAccount({ baseRevision: 'SYS-1', requestId: 'new-account', account: { id: null, username: 'viewer', name: '查看', department: '测试', roleId: 'ROLE-one' } })).rejects.toMatchObject({ code: 'INITIAL_PASSWORD_REQUIRED' });
    expect(f.request).not.toHaveBeenCalled();
    const password: string = crypto.randomUUID();
    const input = { baseRevision: 'SYS-1', requestId: 'new-account', initialPassword: password, account: { id: null, username: 'viewer', name: '查看', department: '测试', roleId: 'ROLE-one' } };
    const pending = f.service.saveSystemAccount(input); input.initialPassword = 'changed'; input.account.name = 'changed'; await pending;
    const [path, init] = f.request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/system/accounts'); expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ baseRevision: 'SYS-1', requestId: 'new-account', account: { username: 'viewer', name: '查看', department: '测试', roleId: 'ROLE-one' }, initialPassword: password });
  });
  it('更新账号不携带用户名或客户端扩展身份', async () => {
    const f = fixture(result());
    await f.service.saveSystemAccount({ baseRevision: 'SYS-1', requestId: 'update-account', account: { ...account(), id: 'ACC-one' }, initialPassword: 'not-sent' });
    const init = f.request.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ baseRevision: 'SYS-1', requestId: 'update-account', account: { name: '维护员', department: '测试', roleId: 'ROLE-one' } });
  });
  it('角色权限数组和恢复参数数组在 await 前复制', async () => {
    const f = fixture(result()); const input = { baseRevision: 'SYS-1', requestId: 'role', role: { id: null, name: '角色', description: '', permissions: ['system.view'] as const as any } };
    const pending = f.service.saveSystemRole(input); input.role.permissions.push('system.accounts'); await pending;
    expect(JSON.parse((f.request.mock.calls[0]![1] as RequestInit).body as string).role.permissions).toEqual(['system.view']);
    const reset = fixture({ ...result(), objectId: 'parameters' });
    await reset.service.resetSystemParameters({ baseRevision: 'SYS-1', requestId: 'restore', parameterIds: ['PAR-01'], reason: '显式恢复', confirm: 'RESTORE_PARAMETER_DEFAULTS' });
    expect(reset.request.mock.calls[0]![0]).toBe('/system/actions/reset-parameters');
  });
  it('归档与回执使用独立路径，不物理清理日志', async () => {
    const f = fixture({ ...result(), objectId: 'audit-view' });
    await f.service.archiveSystemLogs({ baseAuditRevision: 'AUD-1', requestId: 'archive', throughSequence: 1, reason: '显式归档', confirm: 'ARCHIVE_LOG_VIEW' });
    expect(f.request.mock.calls[0]![0]).toBe('/system/actions/archive-logs');
    const missing = fixture({ status: 'NOT_FOUND' }); expect(await missing.service.getSystemOperation({ requestId: 'a/b' })).toEqual({ status: 'NOT_FOUND' });
    expect(missing.request.mock.calls[0]![0]).toBe('/system/operations/a%2Fb');
  });
  it('详情拒绝错对象，读取取消原样传播', async () => {
    const f = fixture({ revision: 'SYS-1', account: account() });
    await expect(f.service.getSystemAccount({ id: 'OTHER' })).rejects.toMatchObject({ code: 'INVALID_SYSTEM_RESPONSE' });
    const request = vi.fn().mockRejectedValue(new Error('aborted')); const service = createSystemManagementHttp(request);
    await expect(service.loadSystemOptions()).rejects.toThrow('aborted'); expect(request).toHaveBeenCalledTimes(1);
  });
  it('写回执对象不一致视为未知结果，不接受另一对象的成功', async () => {
    const f = fixture(result());
    await expect(f.service.saveSystemParameter({ baseRevision: 'SYS-1', requestId: 'parameter', parameterId: 'PAR-01', value: 43 })).rejects.toMatchObject({ code: 'INVALID_SYSTEM_RESPONSE' });
  });
});

describe('严格系统 DTO', () => {
  it('接受真实元数据并隔离响应引用', () => {
    expect(accountDto(account()).mustChangePassword).toBe(false); expect(roleDto(role()).permissionCount).toBe(2);
    expect(parameterDto(parameter()).applicationState).toBe('STORED_ONLY'); expect(eventDto(event()).authSource).toBe('LOCAL_PASSWORD');
    expect(resultDto(result()).operationId).toBe('OP-one');
    const raw = { revision: 'SYS-1', roles: [{ id: 'ROLE-one', name: '角色' }], permissions: [{ code: 'system.view', name: '系统', group: '系统', requires: [] }] };
    const decoded = optionsDto(raw); raw.roles[0]!.name = 'mutated'; expect(decoded.roles[0]!.name).toBe('角色');
  });
  it.each(['password', 'password_hash', 'csrf', 'cookie', 'accessToken', 'secret'])('拒绝响应秘密字段 %s', key => {
    expect(() => accountDto({ ...account(), [key]: 'not-accepted' })).toThrow();
    expect(() => resultDto({ ...result(), [key]: 'not-accepted' })).toThrow();
  });
  it.each([undefined, null, {}, { ...role(), permissions: ['not.registered'], permissionCount: 1 }, { ...role(), permissions: ['system.view', 'system.view'] }])('拒绝缺失/未知角色', value => expect(() => roleDto(value)).toThrow());
  it('拒绝分页错位、总数不一致、重复行与未知来源', () => {
    for (const value of [{ ...page([account()]), pageNum: 2 }, { ...page([account()]), total: 0 }, page([account(), account()])]) expect(() => pageDto(value, accountDto, {})).toThrow();
    expect(() => eventDto({ ...event(), authSource: 'SYNTHETIC_INTEGRATION' })).toThrow();
    expect(() => parameterDto({ ...parameter(), applicationState: 'MAYBE' })).toThrow();
  });
});
