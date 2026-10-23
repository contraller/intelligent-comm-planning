import { allPermissions, type Permission } from '../config/permissions';
import { resolveAuthApiBaseUrl } from '../config/env';
import type { AuthIdentity } from '../types/system';
import { ApiError } from './types';
import { createHttpClient } from './http-client';
import { createHttpSessionBinding } from './http-session';

interface AuthHttpOptions {
  baseUrl: () => string;
  fetcher?: typeof fetch;
  origin?: () => string | undefined;
  timeoutMs?: number;
}
// 业务请求沿用当前页面的会话绑定；适配器只指定路径、数据和响应类型。
export type AuthenticatedRequest = <T>(path: string, init?: RequestInit, responseType?: 'json' | 'blob') => Promise<T>;
const errorCodes: Record<number, string> = {
  1101: 'AUTH_CREDENTIALS', 1102: 'AUTH_EXPIRED', 1103: 'AUTH_DISABLED',
  1104: 'FORBIDDEN', 1105: 'CSRF_REJECTED', 1106: 'SESSION_REPLACED', 1107: 'AUTH_ALREADY_SIGNED_IN',
};
const invalid = () => new ApiError('认证响应不符合 auth-cookie-draft-0.1 契约', 'INVALID_AUTH_RESPONSE');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);

// 严格映射正式身份，不补管理员、不接受未知权限、不把会话关联标识当访问令牌。
function identityFromDto(value: unknown): AuthIdentity {
  if (!record(value)) throw invalid();
  const keys = ['session_id', 'account_id', 'username', 'display_name', 'role_id', 'role_name', 'identity_revision', 'session_generation'];
  if (keys.some(key => !nonempty(value[key])) || !Array.isArray(value.permissions)
    || value.permissions.some(p => typeof p !== 'string' || !allPermissions.includes(p as Permission))
    || new Set(value.permissions).size !== value.permissions.length) throw invalid();
  return {
    sessionId: value.session_id as string, id: value.account_id as string,
    username: value.username as string, name: value.display_name as string,
    roleId: value.role_id as string, roleName: value.role_name as string,
    permissions: [...value.permissions] as Permission[],
    revision: value.identity_revision as string, epoch: value.session_generation as string,
    ...(value.integration_mode === true ? { integrationMode: true } : {}),
  };
}

export function createAuthHttp(options: AuthHttpOptions) {
  const binding = createHttpSessionBinding();
  const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  const origin = options.origin ?? (() => globalThis.location?.origin);
  let pending: { generation: number; promise: Promise<AuthIdentity | null> } | null = null;
  let mutating = false;

  async function request(path: string, init?: RequestInit, responseType: 'json' | 'blob' = 'json'): Promise<unknown> {
    const baseUrl = resolveAuthApiBaseUrl(options.baseUrl(), origin());
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      // 不跟随重定向、不缓存身份；超时包含响应体读取，不自动重试写请求。
      return await Promise.race([
        createHttpClient(baseUrl, fetcher)(path, {
          ...init, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json', ...init?.headers }, signal: controller.signal,
        }, responseType),
        new Promise<never>((_, reject) => {
          abort = () => { reject(new ApiError('请求已取消', 'REQUEST_ABORTED')); controller.abort(); };
          init?.signal?.addEventListener('abort', abort, { once: true });
          if (init?.signal?.aborted) abort();
          timer = setTimeout(() => {
            reject(new ApiError('认证请求超时，请重新校验会话后再操作', 'REQUEST_TIMEOUT'));
            controller.abort();
          }, options.timeoutMs ?? 15000);
        }),
      ]);
    } catch (reason) {
      if (!(reason instanceof ApiError)) throw reason;
      const code = typeof reason.code === 'number' ? errorCodes[reason.code] : undefined;
      const mapped = code ?? (reason.status === 401 ? 'AUTH_REQUIRED' : reason.status === 403 ? 'FORBIDDEN' : undefined);
      if (!mapped) throw reason;
      const error = new ApiError(reason.message, mapped, reason.data, reason.requestId, reason.status);
      // 保留原业务码及有效 data，便于与甲方追踪暂定错误码的差异。
      error.cause = reason;
      throw error;
    } finally { if (timer !== undefined) clearTimeout(timer); init?.signal?.removeEventListener('abort', abort); }
  }
  async function csrf(generation: number) {
    const value = await request('/auth/csrf');
    binding.assertGeneration(generation);
    if (!record(value) || !nonempty(value.csrf_token) || (value.session_id !== null && !nonempty(value.session_id))) throw invalid();
    return { token: value.csrf_token, sessionId: value.session_id as string | null };
  }
  function postHeaders(token: string, sessionId: string | null) {
    return { 'Content-Type': 'application/json', 'X-CSRF-Token': token, 'X-Session-Id': sessionId ?? '' };
  }
  async function mutation<T>(action: (generation: number) => Promise<T>): Promise<T> {
    if (mutating) throw new ApiError('认证操作正在进行，请等待完成', 'HTTP_AUTH_BUSY');
    const generation = binding.beginMutation();
    mutating = true;
    try { return await action(generation); }
    catch (reason) {
      if (reason instanceof ApiError && reason.code === 'SESSION_REPLACED') binding.replace(reason);
      throw reason;
    } finally { mutating = false; }
  }
  function getSession(): Promise<AuthIdentity | null> {
    try { binding.assertReady(); } catch (error) { return Promise.reject(error); }
    if (mutating) return Promise.reject(new ApiError('认证操作正在进行，请稍后校验', 'HTTP_AUTH_BUSY'));
    const generation = binding.generation;
    if (pending?.generation === generation) return pending.promise;
    const promise = (async () => {
      let value: unknown;
      try { value = await request('/auth/session'); }
      catch (reason) {
        binding.assertGeneration(generation);
        if (reason instanceof ApiError && ['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(String(reason.code))) value = null;
        else if (reason instanceof ApiError && reason.code === 'SESSION_REPLACED') binding.replace(reason);
        else throw reason;
      }
      binding.assertGeneration(generation);
      return binding.accept(value === null ? null : identityFromDto(value));
    })();
    pending = { generation, promise };
    void promise.finally(() => { if (pending?.promise === promise) pending = null; }).catch(() => {});
    return promise;
  }
  return {
    getSession,
    async integrationIdentities(): Promise<{ accounts: { id: string; name: string; role: string }[]; currentId: string }> {
      const value = await request('/auth/integration/identities');
      if (!record(value) || value.dataOrigin !== 'SYNTHETIC_INTEGRATION' || !nonempty(value.currentId) || !Array.isArray(value.accounts)
        || value.accounts.some(a => !record(a) || !nonempty(a.id) || !nonempty(a.name) || !['PLANNER','EDITOR','REVIEWER'].includes(String(a.role)))) throw invalid();
      return value as { accounts: { id: string; name: string; role: string }[]; currentId: string };
    },
    switchIntegrationIdentity(accountId: string): Promise<AuthIdentity> {
      return mutation(async generation => {
        if (!nonempty(accountId)) throw invalid();
        const challenge = await csrf(generation);
        if (binding.owner && challenge.sessionId !== binding.owner.sessionId) binding.replace();
        const value = await request('/auth/integration/switch', { method:'POST', headers:postHeaders(challenge.token,challenge.sessionId), body:JSON.stringify({accountId}) });
        binding.assertGeneration(generation);
        const identity=identityFromDto(value);
        if (!identity.integrationMode || identity.id !== accountId) throw invalid();
        // 只有明确切换成功才释放原绑定；其他标签页换号仍触发冻结保护。
        binding.release();
        return binding.accept(identity)!;
      });
    },
    async authenticatedRequest<T>(path: string, init: RequestInit = {}, responseType: 'json' | 'blob' = 'json'): Promise<T> {
      binding.assertReady();
      if (mutating) throw new ApiError('认证操作正在进行', 'HTTP_AUTH_BUSY');
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new ApiError('业务接口路径无效', 'INVALID_API_PATH');
      const actor = await getSession();
      if (!actor) throw new ApiError('请先登录', 'AUTH_REQUIRED');
      const generation = binding.generation;
      const writing = !['GET', 'HEAD'].includes(init.method ?? 'GET');
      const headers = new Headers(init.headers);
      headers.set('X-Session-Id', actor.sessionId);
      if (writing) {
        const challenge = await csrf(generation);
        if (challenge.sessionId !== actor.sessionId) binding.replace();
        headers.set('X-CSRF-Token', challenge.token); headers.set('Content-Type', 'application/json');
      }
      try {
        const value = await request(path, { ...init, headers: Object.fromEntries(headers.entries()) }, responseType);
        // 写入已成功时不因事后会话变化伪报失败；调用方仍按身份隔离页面状态。
        if (!writing) { binding.assertGeneration(generation); binding.assertReady(); }
        return value as T;
      } catch (reason) {
        if (reason instanceof ApiError && reason.code === 'SESSION_REPLACED') binding.replace(reason);
        throw reason;
      }
    },
    login(input: { username: string; password: string }): Promise<AuthIdentity> {
      return mutation(async generation => {
        const challenge = await csrf(generation);
        if (challenge.sessionId !== null) throw new ApiError('浏览器已有登录会话，请重新读取登录状态', 'AUTH_ALREADY_SIGNED_IN');
        const value = await request('/auth/login', {
          method: 'POST', headers: postHeaders(challenge.token, null),
          body: JSON.stringify({ username: input.username.trim(), password: input.password }),
        });
        binding.assertGeneration(generation);
        return binding.accept(identityFromDto(value))!;
      });
    },
    logout(): Promise<void> {
      return mutation(async generation => {
        const challenge = await csrf(generation);
        // 已无服务端会话时按幂等退出；绝不为了清理旧页面而退出新账号。
        if (challenge.sessionId === null) { binding.release(); return; }
        if (challenge.sessionId !== binding.owner?.sessionId) binding.replace();
        const value = await request('/auth/logout', {
          method: 'POST', headers: postHeaders(challenge.token, challenge.sessionId), body: '{}',
        });
        binding.assertGeneration(generation);
        if (value !== null) throw invalid();
        binding.release();
      });
    },
    releaseSessionBinding() {
      if (mutating) throw new ApiError('认证操作正在进行，暂不能清理页面会话', 'HTTP_AUTH_BUSY');
      binding.release();
    },
  };
}
