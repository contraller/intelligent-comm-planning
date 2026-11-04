import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createAuthHttp } from '../src/services/auth-http';
import { useAuthStore } from '../src/stores/auth';

const dto = (sid = 'embedded-session') => ({ session_id: sid, account_id: 'ACC-LOCAL-SINGLE-USER', username: 'local_single_user',
  display_name: '本地使用者', role_id: 'ROLE-LOCAL-SINGLE-USER', role_name: '本地全部功能', permissions: ['planning.view'],
  identity_revision: '1', session_generation: 'stable-generation', auth_source: 'LOCAL_SINGLE_USER', single_user_mode: true, allow_self_review: true });
const response = (data: unknown, code = 0, status = 200) => new Response(JSON.stringify({ code, data, message: code ? '接口拒绝' : 'success' }), { status });
let pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('仅独立单页启用嵌入会话协议', () => {
  it('多个独立frame客户端取得同一服务端身份，Cookie代表的其他端口身份变化不冻结嵌入页', async () => {
    let cookieIdentity = 'cookie-a';
    const fetcher = vi.fn<typeof fetch>(async (path, init) => {
      const embedded = new Headers(init?.headers).get('X-Radio-Embedded') === '1';
      if (String(path).endsWith('/auth/session')) return response(dto(embedded ? 'embedded-session' : cookieIdentity));
      if (String(path).endsWith('/auth/csrf')) return response({ csrf_token: 'server-csrf', session_id: 'embedded-session' });
      expect(new Headers(init?.headers).get('X-Session-Id')).toBe('embedded-session');
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('server-csrf');
      return response({ saved: true });
    });
    const frames = Array.from({ length: 6 }, () => createAuthHttp({ baseUrl: () => '/api/v1', fetcher, embedded: true }));
    expect((await Promise.all(frames.map(frame => frame.getSession()))).every(who => who?.sessionId === 'embedded-session')).toBe(true);
    cookieIdentity = 'cookie-from-other-port';
    expect((await Promise.all(frames.map(frame => frame.getSession()))).every(who => who?.sessionId === 'embedded-session')).toBe(true);
    await expect(frames[0].authenticatedRequest('/saved-input', { method: 'POST', body: '{}' })).resolves.toEqual({ saved: true });
    for (const [, init] of fetcher.mock.calls) {
      expect(new Headers(init?.headers).get('X-Radio-Embedded')).toBe('1');
      expect(init).toMatchObject({ credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
      expect(new Headers(init?.headers).has('Cookie')).toBe(false); expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    }
  });

  it.each(['/embed/planning', '/embed/diagnosis?scenarioId=FS-1', '/embed'])('已知入口 %s 才自动带非凭据模式标记', async path => {
    vi.stubGlobal('location', { hash: '#' + path });
    const fetcher = vi.fn<typeof fetch>(async () => response(dto()));
    await createAuthHttp({ baseUrl: () => '/api/v1', fetcher }).getSession();
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('X-Radio-Embedded')).toBe('1');
  });

  it.each(['/embed-evil/planning', '/embed/unknown', '/planning'])('普通或未知入口 %s 不启用免登录模式', async path => {
    vi.stubGlobal('location', { hash: '#' + path });
    const fetcher = vi.fn<typeof fetch>(async () => response(dto()));
    await createAuthHttp({ baseUrl: () => '/api/v1', fetcher }).getSession();
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('X-Radio-Embedded')).toBe(false);
  });

  it('页面绑定模式固定，导航过程中不静默从普通Cookie切到内部身份', async () => {
    const location = { hash: '#/planning' }; vi.stubGlobal('location', location);
    const fetcher = vi.fn<typeof fetch>(async () => response(dto()));
    const auth = createAuthHttp({ baseUrl: () => '/api/v1', fetcher });
    location.hash = '#/embed/planning'; await auth.getSession();
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).has('X-Radio-Embedded')).toBe(false);
  });

  it('普通入口不能由业务调用参数塞入嵌入标记，原会话替换仍冻结', async () => {
    let sid = 'original';
    const fetcher = vi.fn<typeof fetch>(async () => response(dto(sid)));
    const auth = createAuthHttp({ baseUrl: () => '/api/v1', fetcher, embedded: false });
    await auth.authenticatedRequest('/read', { headers: { 'X-Radio-Embedded': '1' } });
    expect(fetcher.mock.calls.every(([, init]) => !new Headers(init?.headers).has('X-Radio-Embedded'))).toBe(true);
    sid = 'replaced'; await expect(auth.getSession()).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    await expect(auth.authenticatedRequest('/read')).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
  });

  it('嵌入页的真实内部session/epoch轮换仍冻结，不据单用户标志放行旧输入', async () => {
    let sid = 'embedded-before';
    const fetcher = vi.fn<typeof fetch>(async () => response(dto(sid)));
    const auth = createAuthHttp({ baseUrl: () => '/api/v1', fetcher, embedded: true });
    await auth.getSession(); sid = 'embedded-after';
    await expect(auth.getSession()).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
  });

  it('多用户服务器拒绝嵌入时直接显示拒绝，不回退成伪造的统一身份', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(null, 1104, 403));
    await expect(createAuthHttp({ baseUrl: () => '/api/v1', fetcher, embedded: true }).getSession()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('嵌入实际路径与逻辑权限', () => {
  it('已知embed目标保持前缀，权限拒绝和fallback均不跳回带菜单页', async () => {
    pinia = createPinia(); setActivePinia(pinia);
    const who = await createAuthHttp({ baseUrl: () => '/api/v1', fetcher: async () => response(dto()), embedded: true }).getSession();
    const auth = useAuthStore(); auth.accept(who); auth.currentPath = '/embed/planning';
    expect(auth.pageDenied).toBe(false); expect(auth.blocked).toBe(false);
    expect(auth.firstPath('/embed/planning?taskId=TASK-1')).toBe('/embed/planning?taskId=TASK-1');
    auth.currentPath = '/embed/resources'; expect(auth.pageDenied).toBe(true); expect(auth.blocked).toBe(true);
    expect(auth.firstPath()).toBe('/embed/planning');
    auth.currentPath = '/planning'; expect(auth.firstPath()).toBe('/planning');
  });
});
