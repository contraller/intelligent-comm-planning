import { describe, expect, it, vi } from 'vitest';
import { createLocalIdentityHttp, readLocalIdentityCapabilities } from '../src/services/local-identity-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';

const caps = () => ({ authMode: 'LOCAL_PASSWORD', initialized: true, passwordChangeRequired: false, passwordPolicy: { minScalars: 8, maxScalars: 128 }, capabilities: { passwordMaintenance: true, anonymousRecovery: false } });
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'success', data }), { headers: { 'Content-Type': 'application/json' } });
describe('本地正式身份专用适配', () => {
  it('匿名仅读取同源能力，不发送凭据或建立会话', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(caps()));
    expect((await readLocalIdentityCapabilities({ baseUrl: '/api/v1', origin: 'https://local.example', fetcher })).authMode).toBe('LOCAL_PASSWORD');
    expect(fetcher).toHaveBeenCalledWith('/api/v1/auth/capabilities', expect.objectContaining({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' }));
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty('body');
  });
  it.each(['https://other.example/api/v1', '//other.example/api', '/api/v1?token=value'])('拒绝不安全 API %s', async baseUrl => {
    const fetcher = vi.fn(); await expect(readLocalIdentityCapabilities({ baseUrl, origin: 'https://local.example', fetcher })).rejects.toMatchObject({ code: 'INVALID_AUTH_BASE_URL' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([{ ...caps(), authMode: 'DEMO' }, { ...caps(), initialized: 'yes' }, { ...caps(), passwordPolicy: { minScalars: 128, maxScalars: 15 } }, { ...caps(), capabilities: { passwordMaintenance: true, anonymousRecovery: true } }])('拒绝伪本地能力', async data => {
    await expect(readLocalIdentityCapabilities({ baseUrl: '/api/v1', fetcher: async () => response(data) })).rejects.toMatchObject({ code: 'INVALID_AUTH_RESPONSE' });
  });
  it('改密快照只提交一次，不自动重试，强制重新认证状态', async () => {
    const raw = { revision: 'SYS-2', objectId: 'ACC-one', changed: true, operationId: 'OP-one', reauthenticationRequired: true };
    const request = vi.fn(async () => raw), service = createLocalIdentityHttp(request as AuthenticatedRequest);
    const input: { requestId: string; currentPassword: string; newPassword: string } = { requestId: 'self-change', currentPassword: crypto.randomUUID(), newPassword: crypto.randomUUID() }, expected = { ...input };
    const pending = service.changeOwnPassword(input); input.newPassword = 'changed'; await pending;
    expect(request.mock.calls[0]).toEqual(['/auth/password', { method: 'POST', body: JSON.stringify(expected) }]);
    const failing = vi.fn().mockRejectedValue(new Error('timeout')); await expect(createLocalIdentityHttp(failing).changeOwnPassword(expected)).rejects.toThrow('timeout'); expect(failing).toHaveBeenCalledTimes(1);
    await expect(createLocalIdentityHttp(vi.fn(async () => ({ ...raw, reauthenticationRequired: false })) as AuthenticatedRequest).changeOwnPassword(expected)).rejects.toMatchObject({ code: 'INVALID_SYSTEM_RESPONSE' });
  });
});
