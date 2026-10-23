import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../src/config/permissions';
import type { OperationLogger } from '../src/services/operation-log';
import type { PreviewService } from '../src/services/types';
import type { AuthIdentity } from '../src/types/system';

const fixture = vi.hoisted(() => {
  const actions = () => ({
    getSystemOperation: vi.fn<(input: unknown) => Promise<unknown>>(),
    changeOwnPassword: vi.fn<(input: unknown) => Promise<unknown>>(),
    maintainSystemAccountPassword: vi.fn<(input: unknown) => Promise<unknown>>(),
    resetSystemParameters: vi.fn<(input: unknown) => Promise<unknown>>(),
    archiveSystemLogs: vi.fn<(input: unknown) => Promise<unknown>>(),
  });
  const httpActions = actions(), mockActions = actions();
  return {
    env: { mode: 'http' }, httpActions, mockActions,
    http: { ...httpActions, getSession: vi.fn<() => Promise<AuthIdentity | null>>() },
    mock: { ...mockActions, getSession: vi.fn<() => Promise<AuthIdentity | null>>() },
    logger: { record: vi.fn<OperationLogger['record']>(), retry: vi.fn(), reset: vi.fn(),
      status: vi.fn(() => ({ pending: 0, warning: '' })), subscribe: vi.fn(() => () => {}) },
  };
});

// 只替换传输端点；真实 index 分派、权限表、access 和身份快照逻辑均保留。
vi.mock('../src/config/env', () => ({ env: fixture.env }));
vi.mock('../src/services/http', () => ({ httpService: fixture.http, releaseHttpSessionBinding: vi.fn() }));
vi.mock('../src/services/mock', () => ({ mockService: fixture.mock }));
vi.mock('../src/services/operation-log', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/operation-log')>(), operationLogger: fixture.logger,
}));

import { previewService } from '../src/services';
import { createAccessService, isWriteMethod, subscribeAccess, type AccessNotice } from '../src/services/access';
import { servicePermissions } from '../src/config/permissions';
import { ApiError } from '../src/services/types';

const cases = [
  { name: 'getSystemOperation', permissions: [], writing: false, input: { requestId: 'operation-1' } },
  { name: 'changeOwnPassword', permissions: [], writing: true,
    input: { requestId: 'own-password-1', currentPassword: 'isolated-old-secret', newPassword: 'isolated-new-secret' } },
  { name: 'maintainSystemAccountPassword', permissions: ['system.accounts'], writing: true,
    input: { baseRevision: 'SYS-1', requestId: 'account-password-1', accountId: 'ACC-target',
      operatorPassword: 'isolated-operator-secret', newPassword: 'isolated-new-secret' } },
  { name: 'resetSystemParameters', permissions: ['system.parameters', 'system.reset'], writing: true,
    input: { baseRevision: 'SYS-1', requestId: 'reset-1', parameterIds: ['PAR-01'], reason: '构造恢复', confirm: 'RESTORE_PARAMETER_DEFAULTS' } },
  { name: 'archiveSystemLogs', permissions: ['system.logs', 'system.reset'], writing: true,
    input: { baseAuditRevision: 'AUD-1', requestId: 'archive-1', throughSequence: 1, reason: '构造归档', confirm: 'ARCHIVE_LOG_VIEW' } },
] as const;
type ActionName = typeof cases[number]['name'];
const allSystemPermissions: Permission[] = ['system.view', 'system.accounts', 'system.roles', 'system.parameters', 'system.logs', 'system.reset'];

function identity(permissions: readonly Permission[] = allSystemPermissions, suffix = 'before'): AuthIdentity {
  return { sessionId: 'session-' + suffix, id: 'ACC-' + suffix, username: 'fixture-' + suffix, name: '构造主体-' + suffix,
    roleId: 'ROLE-' + suffix, roleName: '构造角色-' + suffix, permissions: [...permissions], epoch: 'LOCAL-TEST', revision: 'SYS-1' };
}
function call(name: ActionName, input: unknown) {
  const method = previewService[name] as (input: unknown) => Promise<unknown>;
  return method(input);
}
function noMockCalls() {
  expect(fixture.mock.getSession).not.toHaveBeenCalled();
  for (const action of Object.values(fixture.mockActions)) expect(action).not.toHaveBeenCalled();
}
let notices: AccessNotice[] = [], unsubscribe: (() => void) | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(fixture.http, fixture.httpActions);
  Object.assign(fixture.mock, fixture.mockActions);
  fixture.env.mode = 'http';
  fixture.http.getSession.mockResolvedValue(identity());
  fixture.mock.getSession.mockResolvedValue(identity());
  notices = [];
  unsubscribe = subscribeAccess(notice => notices.push(notice));
});
afterEach(() => { unsubscribe?.(); });

describe('真实访问包装下的正式系统分派', () => {
  it.each(cases)('$name 由实际权限白名单枚举注册并只调用 HTTP', async entry => {
    expect(Object.keys(servicePermissions)).toContain(entry.name);
    expect(Object.keys(previewService)).toContain(entry.name);
    expect(servicePermissions[entry.name]).toEqual({ all: [...entry.permissions] });
    expect(isWriteMethod(entry.name)).toBe(entry.writing);
    const actor = identity(entry.permissions);
    fixture.http.getSession.mockResolvedValue(actor);
    const receipt = { revision: 'SYS-2', objectId: 'ACC-before', changed: true, operationId: 'OP-1' };
    fixture.httpActions[entry.name].mockResolvedValue(receipt);
    expect(await call(entry.name, entry.input)).toBe(receipt);
    expect(fixture.httpActions[entry.name]).toHaveBeenCalledExactlyOnceWith(entry.input);
    expect(fixture.http.getSession).toHaveBeenCalledTimes(2);
    expect(notices.filter(notice => notice.busy !== undefined).map(notice => notice.busy)).toEqual(entry.writing ? [1, 0] : []);
    expect(fixture.logger.record).not.toHaveBeenCalled();
    noMockCalls();
  });

  it.each(cases)('$name 即使权限条件为空也必须先有真实会话', async entry => {
    fixture.http.getSession.mockResolvedValue(null);
    await expect(call(entry.name, entry.input)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fixture.httpActions[entry.name]).not.toHaveBeenCalled();
    noMockCalls();
  });

  it.each([
    ['maintainSystemAccountPassword', ['system.view']],
    ['maintainSystemAccountPassword', ['system.roles', 'system.reset']],
    ['resetSystemParameters', ['system.view']],
    ['resetSystemParameters', ['system.parameters']],
    ['resetSystemParameters', ['system.reset']],
    ['archiveSystemLogs', ['system.view']],
    ['archiveSystemLogs', ['system.logs']],
    ['archiveSystemLogs', ['system.reset']],
  ] satisfies [ActionName, Permission[]][])('%s 不接受缺少专项或组合权限的 %j', async (name, permissions) => {
    fixture.http.getSession.mockResolvedValue(identity(permissions));
    await expect(call(name, cases.find(entry => entry.name === name)!.input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.httpActions[name]).not.toHaveBeenCalled();
    noMockCalls();
  });

  it.each(cases)('$name 的 HTTP 错误不回落 Mock', async entry => {
    const failure = new ApiError('构造服务冲突', 'VERSION_CONFLICT');
    fixture.httpActions[entry.name].mockRejectedValue(failure);
    await expect(call(entry.name, entry.input)).rejects.toBe(failure);
    expect(fixture.httpActions[entry.name]).toHaveBeenCalledOnce();
    expect(fixture.logger.record).not.toHaveBeenCalled();
    noMockCalls();
  });

  it.each(cases)('$name 在 HTTP 缺失时异步拒绝且不清除有效身份', async entry => {
    Reflect.deleteProperty(fixture.http, entry.name);
    await expect(call(entry.name, entry.input)).rejects.toMatchObject({ code: 'UNSUPPORTED_SYSTEM_ACTION' });
    expect(fixture.httpActions[entry.name]).not.toHaveBeenCalled();
    expect(notices.some(notice => notice.identity === null)).toBe(false);
    noMockCalls();
  });

  it('明确选择 Mock 才调用 Mock；Mock 可选动作缺失不借用 HTTP', async () => {
    fixture.env.mode = 'mock';
    fixture.mockActions.resetSystemParameters.mockResolvedValue({ changed: false });
    const input = cases.find(entry => entry.name === 'resetSystemParameters')!.input;
    expect(await call('resetSystemParameters', input)).toEqual({ changed: false });
    expect(fixture.mockActions.resetSystemParameters).toHaveBeenCalledExactlyOnceWith(input);
    Reflect.deleteProperty(fixture.mock, 'getSystemOperation');
    await expect(call('getSystemOperation', { requestId: 'missing' })).rejects.toMatchObject({ code: 'UNSUPPORTED_SYSTEM_ACTION' });
    expect(fixture.http.getSession).not.toHaveBeenCalled();
    for (const action of Object.values(fixture.httpActions)) expect(action).not.toHaveBeenCalled();
  });
});

describe('读回执与改密前后会话的不同语义', () => {
  it.each(['same-account-new-session', 'peer-account'])('只读回执丢弃迟到的 %s 响应，不注销新会话', async kind => {
    const before = identity([]);
    const after = { ...before, sessionId: 'session-after', ...(kind === 'peer-account' ? { id: 'ACC-peer', username: 'fixture-peer' } : {}) };
    fixture.http.getSession.mockResolvedValue(before);
    fixture.httpActions.getSystemOperation.mockImplementation(async () => {
      fixture.http.getSession.mockResolvedValue(after);
      return { status: 'FOUND', objectId: 'old-private-receipt' };
    });
    await expect(call('getSystemOperation', { requestId: 'old-operation' })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(notices.filter(notice => 'identity' in notice).at(-1)?.identity).toEqual(after);
    expect(notices.some(notice => notice.identity === null)).toBe(false);
    noMockCalls();
  });

  it('改密成功导致会话失效时仍返回真实成功回执并要求重新认证', async () => {
    fixture.http.getSession.mockResolvedValueOnce(identity([])).mockResolvedValue(null);
    const receipt = { revision: 'SYS-2', objectId: 'ACC-before', changed: true, reauthenticationRequired: true };
    fixture.httpActions.changeOwnPassword.mockResolvedValue(receipt);
    expect(await call('changeOwnPassword', cases[1].input)).toBe(receipt);
    expect(fixture.httpActions.changeOwnPassword).toHaveBeenCalledOnce();
    expect(notices).toContainEqual({ identity: null });
    expect(notices.filter(notice => notice.busy !== undefined).map(notice => notice.busy)).toEqual([1, 0]);
    noMockCalls();
  });

  it('改密事后校验抛过期错误，不把已提交写入改成失败或再次提交', async () => {
    const expired = new ApiError('旧会话已撤销', 'AUTH_EXPIRED');
    fixture.http.getSession.mockResolvedValueOnce(identity([])).mockRejectedValue(expired);
    const receipt = { revision: 'SYS-2', objectId: 'ACC-before', changed: true, reauthenticationRequired: true };
    fixture.httpActions.changeOwnPassword.mockResolvedValue(receipt);
    expect(await call('changeOwnPassword', cases[1].input)).toBe(receipt);
    expect(fixture.httpActions.changeOwnPassword).toHaveBeenCalledOnce();
    expect(notices).toContainEqual({ identity: null, error: expired });
    noMockCalls();
  });

  it.each(cases.filter(entry => entry.writing))('$name 提交后失权不伪报业务失败', async entry => {
    const after = identity([]);
    fixture.http.getSession.mockResolvedValueOnce(identity(entry.permissions)).mockResolvedValue(after);
    const receipt = { revision: 'SYS-2', objectId: 'stored-object', changed: true };
    fixture.httpActions[entry.name].mockResolvedValue(receipt);
    expect(await call(entry.name, entry.input)).toBe(receipt);
    expect(notices).toContainEqual({ identity: after });
    expect(fixture.httpActions[entry.name]).toHaveBeenCalledOnce();
    noMockCalls();
  });

  it('首轮会话已经过期则禁止改密，不能用事后成功规则放行', async () => {
    const expired = new ApiError('尚未通过认证', 'AUTH_EXPIRED');
    fixture.http.getSession.mockRejectedValue(expired);
    await expect(call('changeOwnPassword', cases[1].input)).rejects.toBe(expired);
    expect(fixture.httpActions.changeOwnPassword).not.toHaveBeenCalled();
    noMockCalls();
  });

  it('真实 wrapper 日志归属使用写入前身份，不采用事后账号且不记录密码', async () => {
    const before = identity([]), after = identity([], 'peer');
    fixture.http.getSession.mockResolvedValueOnce(before).mockResolvedValue(after);
    const receipt = { revision: 'SYS-2', objectId: before.id, changed: true, reauthenticationRequired: true };
    fixture.httpActions.changeOwnPassword.mockResolvedValue(receipt);
    const observed: AccessNotice[] = [];
    const service = createAccessService(() => fixture.http as unknown as PreviewService, fixture.logger, notice => observed.push(notice));
    expect(await service.changeOwnPassword!(cases[1].input)).toBe(receipt);
    expect(fixture.logger.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      actor: { id: before.id, name: before.name, roleId: before.roleId, roleName: before.roleName },
      action: 'changeOwnPassword', requestId: cases[1].input.requestId, objectId: before.id, outcome: 'SUCCESS',
    }));
    const serialized = JSON.stringify(fixture.logger.record.mock.calls);
    expect(serialized).not.toContain(cases[1].input.currentPassword);
    expect(serialized).not.toContain(cases[1].input.newPassword);
    expect(serialized).not.toContain('currentPassword');
    expect(serialized).not.toContain('newPassword');
    expect(observed).toContainEqual({ identity: after });
  });
});
