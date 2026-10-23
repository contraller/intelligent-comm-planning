import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewService } from '../src/services/types';

const fixture = vi.hoisted(() => ({
  env: { mode: 'http' },
  http: {
    getSystemOperation: vi.fn(), changeOwnPassword: vi.fn(),
    maintainSystemAccountPassword: vi.fn(), resetSystemParameters: vi.fn(), archiveSystemLogs: vi.fn(),
  },
  mock: { resetSystemParameters: vi.fn() },
}));
vi.mock('../src/config/env', () => ({ env: fixture.env }));
vi.mock('../src/services/http', () => ({ httpService: fixture.http, releaseHttpSessionBinding: vi.fn() }));
vi.mock('../src/services/mock', () => ({ mockService: fixture.mock }));
vi.mock('../src/services/operation-log', () => ({ operationLogger: null }));
// 此处只验证真实分派表；授权及会话检查由 access 专项验证。
vi.mock('../src/services/access', () => ({ createAccessService: (select: () => PreviewService) => select() }));
import { previewService } from '../src/services';

beforeEach(() => { vi.resetAllMocks(); fixture.env.mode = 'http'; });

describe('正式系统操作的统一入口', () => {
  it.each([
    ['getSystemOperation', { requestId: 'receipt-1' }],
    ['changeOwnPassword', { requestId: 'password-1', currentPassword: 'old-test-value', newPassword: 'new-test-value' }],
    ['maintainSystemAccountPassword', { baseRevision: 'SYS-1', requestId: 'account-password-1', accountId: 'ACC-1', operatorPassword: 'operator-test-value', newPassword: 'new-test-value' }],
    ['resetSystemParameters', { baseRevision: 'SYS-1', requestId: 'restore-1', parameterIds: ['PAR-01', 'PAR-02'], reason: '显式恢复', confirm: 'RESTORE_PARAMETER_DEFAULTS' }],
    ['archiveSystemLogs', { baseAuditRevision: 'AUD-1', requestId: 'archive-1', throughSequence: 1, reason: '显式归档', confirm: 'ARCHIVE_LOG_VIEW' }],
  ] as const)('%s 转发原始参数并返回真实回执', async (name, input) => {
    const expected = { revision: 'SYS-2', objectId: 'object-1', changed: true, operationId: 'OP-1' };
    fixture.http[name].mockResolvedValue(expected);
    const call = previewService[name] as (input: unknown) => Promise<unknown>;
    expect(await call(input)).toBe(expected);
    expect(fixture.http[name]).toHaveBeenCalledExactlyOnceWith(input);
    expect(fixture.mock.resetSystemParameters).not.toHaveBeenCalled();
  });

  it('HTTP 失败原样返回，不调用 Mock', async () => {
    const failure = new Error('版本冲突'); fixture.http.resetSystemParameters.mockRejectedValue(failure);
    await expect(previewService.resetSystemParameters!({ baseRevision: 'SYS-1', requestId: 'restore-2', parameterIds: ['PAR-02'], reason: '显式恢复', confirm: 'RESTORE_PARAMETER_DEFAULTS' })).rejects.toBe(failure);
    expect(fixture.mock.resetSystemParameters).not.toHaveBeenCalled();
  });

  it('明确选择 Mock 才使用其已实现动作', async () => {
    fixture.env.mode = 'mock'; fixture.mock.resetSystemParameters.mockResolvedValue({ changed: false });
    await previewService.resetSystemParameters!({ baseRevision: 'SYS-1', requestId: 'restore-3', parameterIds: ['PAR-02'], reason: '显式恢复', confirm: 'RESTORE_PARAMETER_DEFAULTS' });
    expect(fixture.mock.resetSystemParameters).toHaveBeenCalledOnce();
    expect(fixture.http.resetSystemParameters).not.toHaveBeenCalled();
  });

  it('未实现的可选动作明确拒绝', () => {
    fixture.env.mode = 'mock';
    expect(() => previewService.getSystemOperation!({ requestId: 'missing' })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_SYSTEM_ACTION' }));
    expect(fixture.http.getSystemOperation).not.toHaveBeenCalled();
  });
});
