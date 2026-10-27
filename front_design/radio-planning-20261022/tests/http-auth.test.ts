import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthHttp } from '../src/services/auth-http';
import { resolveAuthApiBaseUrl } from '../src/config/env';
import { createHttpSessionBinding } from '../src/services/http-session';
import { ApiError } from '../src/services/types';

const dto = (name = 'alpha') => ({ session_id: `session-${name}`, account_id: name, username: name,
  display_name: name, role_id: 'role-viewer', role_name: '查看人员', permissions: ['resources.view'],
  identity_revision: 'identity-1', session_generation: 'generation-1' });
const response = (data: unknown, code = 0, status = 200) => new Response(JSON.stringify({ code, data, message: code ? '接口拒绝' : 'success', request_id: 'req-test' }), { status });

// 仅模拟响应契约与共享 Cookie 所代表的服务器身份，不启动后端或声称浏览器 Cookie 已验证。
function fixture(initial: ReturnType<typeof dto> | null = null) {
  const state = { identity: initial };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (path.endsWith('/auth/session')) return response(state.identity);
    if (path.endsWith('/auth/csrf')) return response({ csrf_token: 'test-nonce', session_id: state.identity?.session_id ?? null });
    if (path.endsWith('/auth/login')) { state.identity = dto(JSON.parse(String(init?.body)).username); return response(state.identity); }
    if (path.endsWith('/auth/logout')) {
      if (new Headers(init?.headers).get('X-Session-Id') !== state.identity?.session_id) return response({ reason: 'changed' }, 1106, 409);
      state.identity = null; return response(null);
    }
    throw new Error('测试出现未约定路径');
  });
  const auth = createAuthHttp({ baseUrl: () => '/api/v1', fetcher });
  return { auth, fetcher, state };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('同源 Cookie 认证契约', () => {
  it('登录、会话与退出使用真实 HTTP 适配，凭据不进入浏览器存储', async () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage);
    const { auth, fetcher } = fixture();
    const identity = await auth.login({ username: ' alpha ', password: ' password with spaces ' });
    expect(identity).toMatchObject({ id: 'alpha', sessionId: 'session-alpha', permissions: ['resources.view'], epoch: 'generation-1' });
    expect(await auth.getSession()).toEqual(identity);
    await auth.logout(); expect(await auth.getSession()).toBeNull();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ username: 'alpha', password: ' password with spaces ' });
    expect(new Headers(posts[0][1]?.headers).get('X-CSRF-Token')).toBe('test-nonce');
    expect(new Headers(posts[0][1]?.headers).get('X-Session-Id')).toBe('');
    expect(new Headers(posts[1][1]?.headers).get('X-Session-Id')).toBe('session-alpha');
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
      expect(new Headers(init?.headers).has('Cookie')).toBe(false);
      expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    }
    expect(storage.getItem).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled(); expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it('活跃共享会话不允许在登录表单直接覆盖为另一账号', async () => {
    const { auth, fetcher, state } = fixture(dto('alpha'));
    await expect(auth.login({ username: 'beta', password: 'x' })).rejects.toMatchObject({ code: 'AUTH_ALREADY_SIGNED_IN' });
    expect(state.identity?.account_id).toBe('alpha'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('本人改密使旧会话失效后，主动重新登录接受新会话而无需刷新页面', async () => {
    const { auth, fetcher, state } = fixture();
    await auth.login({ username: 'alpha', password: 'initial-password' });
    // 后端改密撤销 Cookie；读取未登录状态不能误释放其他业务页面的绑定。
    state.identity = null;
    expect(await auth.getSession()).toBeNull();
    const next = { ...dto('alpha'), session_id: 'session-alpha-after-password', session_generation: 'generation-2' };
    fetcher.mockResolvedValueOnce(response({ csrf_token: 'fresh-nonce', session_id: null }))
      .mockImplementationOnce(async () => { state.identity = next; return response(next); });
    await expect(auth.login({ username: 'alpha', password: 'new-password' }))
      .resolves.toMatchObject({ id: 'alpha', sessionId: next.session_id });
    expect((await auth.getSession())?.sessionId).toBe(next.session_id);
  });
  it('重新登录失败时不释放旧绑定，随后出现其他账号仍触发冻结', async () => {
    const { auth, fetcher, state } = fixture(dto('alpha'));
    await auth.getSession(); state.identity = null;
    expect(await auth.getSession()).toBeNull();
    fetcher.mockResolvedValueOnce(response({ csrf_token: 'fresh-nonce', session_id: null }))
      .mockResolvedValueOnce(response(null, 1101, 401));
    await expect(auth.login({ username: 'alpha', password: 'wrong' })).rejects.toMatchObject({ code: 'AUTH_CREDENTIALS' });
    state.identity = dto('beta');
    await expect(auth.getSession()).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
  });
  it.each([1101, 1102, 1103, 1104, 1105, 1106, 1107])('认证错误码 %s 保留原始错误、有效 data 和请求编号', async code => {
    const { auth, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(response({ csrf_token: 'nonce', session_id: null })).mockResolvedValueOnce(response({ field: 'username' }, code, code === 1106 ? 409 : 403));
    const caught = await auth.login({ username: 'alpha', password: 'wrong' }).catch(e => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ requestId: 'req-test', data: { field: 'username' }, cause: { code } });
    expect(caught.code).not.toBe('NOT_IMPLEMENTED'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([null, [], {}, { ...dto(), permissions: ['administrator'] }, { ...dto(), permissions: ['resources.view', 'resources.view'] }, { ...dto(), session_id: 'bad\nheader' }, { ...dto(), session_generation: '' }])('拒绝不完整或非法的登录身份 %#', async payload => {
    const { auth, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(response({ csrf_token: 'nonce', session_id: null })).mockResolvedValueOnce(response(payload));
    await expect(auth.login({ username: 'alpha', password: 'x' })).rejects.toMatchObject({ code: 'INVALID_AUTH_RESPONSE' });
  });
  it.each([{}, { csrf_token: '', session_id: null }, { csrf_token: 'x' }, { csrf_token: 'x', session_id: 42 }])('无有效 CSRF 上下文时不发送登录 %#', async payload => {
    const { auth, fetcher } = fixture(); fetcher.mockResolvedValueOnce(response(payload));
    await expect(auth.login({ username: 'alpha', password: 'x' })).rejects.toMatchObject({ code: 'INVALID_AUTH_RESPONSE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([[0, 200], [1102, 401], [9999, 401]])('未登录和过期映射为无会话 code=%s', async (code, status) => {
    const { auth, fetcher } = fixture(); fetcher.mockResolvedValueOnce(response(null, code, status));
    expect(await auth.getSession()).toBeNull();
  });
  it('网络失败与非 JSON 不伪装成未登录，且不自动重试', async () => {
    const { auth, fetcher } = fixture(); fetcher.mockRejectedValueOnce(new TypeError('network unavailable'));
    await expect(auth.getSession()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    fetcher.mockResolvedValueOnce(new Response('<html>error</html>'));
    await expect(auth.getSession()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('超时主动取消且不重发登录，迟到响应不会设置身份', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const auth = createAuthHttp({ baseUrl: () => '/api/v1', fetcher, timeoutMs: 50 });
    const result = expect(auth.login({ username: 'alpha', password: 'x' })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(50); await result;
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});

describe('共享会话的页面绑定', () => {
  it('刷新读取绑定当前身份，权限更新不视为换人，换人后必须明确释放', async () => {
    const { auth, state, fetcher } = fixture(dto()); await auth.getSession();
    state.identity = { ...dto(), identity_revision: 'identity-2', permissions: ['planning.view'] };
    expect((await auth.getSession())?.permissions).toEqual(['planning.view']);
    state.identity = dto('beta');
    await expect(auth.getSession()).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    const count = fetcher.mock.calls.length;
    await expect(auth.getSession()).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    await expect(auth.logout()).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    expect(fetcher).toHaveBeenCalledTimes(count);
    auth.releaseSessionBinding(); expect((await auth.getSession())?.id).toBe('beta');
  });
  it('过期后的新会话即使账号相同，也不能恢复旧现场', async () => {
    const { auth, state } = fixture(dto()); await auth.getSession(); state.identity = null;
    expect(await auth.getSession()).toBeNull(); state.identity = { ...dto(), session_id: 'new-session' };
    await expect(auth.getSession()).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
  });
  it('退出前发现共享身份变化，不发送 logout；校验之后的竞态由服务端拒绝', async () => {
    const { auth, state, fetcher } = fixture(dto()); await auth.getSession(); state.identity = dto('beta');
    await expect(auth.logout()).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/auth/logout'))).toHaveLength(0);
    auth.releaseSessionBinding(); await auth.getSession();
    fetcher.mockResolvedValueOnce(response({ csrf_token: 'old-token', session_id: 'session-beta' })).mockResolvedValueOnce(response({ reason: 'changed-after-check' }, 1106, 409));
    await expect(auth.logout()).rejects.toMatchObject({ code: 'SESSION_REPLACED', data: { reason: 'changed-after-check' }, cause: { code: 1106 } });
    expect(state.identity?.account_id).toBe('beta');
  });
  it('已退出时幂等成功，退出失败保留原页面绑定', async () => {
    const { auth, state, fetcher } = fixture(dto()); await auth.getSession();
    fetcher.mockResolvedValueOnce(response({ csrf_token: 'nonce', session_id: 'session-alpha' })).mockRejectedValueOnce(new TypeError('offline'));
    await expect(auth.logout()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect((await auth.getSession())?.id).toBe('alpha');
    state.identity = null; const before = fetcher.mock.calls.length; await auth.logout();
    expect(fetcher).toHaveBeenCalledTimes(before + 1);
  });
  it('会话读取合并在途请求，显式释放使旧结果失效', async () => {
    const { auth, fetcher } = fixture(); let finish!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = auth.getSession(), second = auth.getSession(); expect(first).toBe(second);
    const rejected = expect(first).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    auth.releaseSessionBinding(); finish(response(dto())); await rejected;
    expect(await auth.getSession()).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('登录使旧会话读取失效；同一页面禁止并发认证操作', async () => {
    const { auth, fetcher } = fixture(); let finish!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = auth.getSession(), rejected = expect(old).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    const login = auth.login({ username: 'beta', password: 'x' });
    await expect(auth.logout()).rejects.toMatchObject({ code: 'HTTP_AUTH_BUSY' });
    await expect(auth.getSession()).rejects.toMatchObject({ code: 'HTTP_AUTH_BUSY' });
    await login; finish(response(dto('alpha'))); await rejected;
    expect((await auth.getSession())?.id).toBe('beta');
  });
  it('页面绑定不受调用者修改返回对象影响', () => {
    const binding = createHttpSessionBinding(); const identity = { sessionId: 's', id: 'a', epoch: 'e' } as Parameters<typeof binding.accept>[0];
    binding.accept(identity); binding.owner!.id = 'changed';
    expect(binding.owner?.id).toBe('a'); binding.release(); expect(binding.owner).toBeNull();
  });
});

describe('认证 API 地址边界', () => {
  it.each(['/api/v1', '/api/v1/', 'https://radio.example/api/v1'])('接受同源配置 %s', base => {
    expect(resolveAuthApiBaseUrl(base, 'https://radio.example')).toBe('/api/v1');
  });
  it.each(['https://other.example/api', '//other.example/api', 'https://user:pass@radio.example/api', '/api?token=x', '/api#hash', 'api/v1', '/\\other.example/api', ' /api', 'javascript:alert(1)', ''])('拒绝配置 %s 且不发凭据', async base => {
    const fetcher = vi.fn<typeof fetch>(); const auth = createAuthHttp({ baseUrl: () => base, origin: () => 'https://radio.example', fetcher });
    await expect(auth.login({ username: 'a', password: 'x' })).rejects.toMatchObject({ code: 'INVALID_AUTH_BASE_URL' }); expect(fetcher).not.toHaveBeenCalled();
  });
});
