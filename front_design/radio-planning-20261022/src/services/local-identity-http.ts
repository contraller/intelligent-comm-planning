import { resolveAuthApiBaseUrl } from '../config/env';
import type { LocalIdentityActions, LocalIdentityCapabilities } from '../types/local-identity';
import type { AuthenticatedRequest } from './auth-http';
import { createHttpClient } from './http-client';
import { integer, object, resultDto } from './system-http-validation';
import { ApiError } from './types';

export function createLocalIdentityHttp(request: AuthenticatedRequest): LocalIdentityActions {
  return { async changeOwnPassword(input) {
    const body = JSON.stringify({ requestId: input.requestId, currentPassword: input.currentPassword, newPassword: input.newPassword });
    const result = resultDto(await request('/auth/password', { method: 'POST', body }));
    if (!result.reauthenticationRequired) throw new ApiError('改密回执缺少重新认证状态', 'INVALID_SYSTEM_RESPONSE');
    return result;
  } };
}
// 匿名只读取能力，不借此生成身份、管理员、密码或联调入口。
export async function readLocalIdentityCapabilities(options: { baseUrl: string; origin?: string; fetcher?: typeof fetch; signal?: AbortSignal }): Promise<LocalIdentityCapabilities> {
  const url = resolveAuthApiBaseUrl(options.baseUrl, options.origin ?? globalThis.location?.origin);
  const v = object(await createHttpClient(url, options.fetcher)('/auth/capabilities', { credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: options.signal }));
  const p = object(v.passwordPolicy), c = object(v.capabilities);
  if (v.authMode !== 'LOCAL_PASSWORD' || typeof v.initialized !== 'boolean' || typeof v.passwordChangeRequired !== 'boolean' || c.passwordMaintenance !== true || c.anonymousRecovery !== false || integer(p.minScalars, 1) > integer(p.maxScalars, 1)) throw new ApiError('本地认证能力响应无效', 'INVALID_AUTH_RESPONSE');
  return { authMode: 'LOCAL_PASSWORD', initialized: v.initialized, passwordChangeRequired: v.passwordChangeRequired, passwordPolicy: { minScalars: p.minScalars as number, maxScalars: p.maxScalars as number }, capabilities: { passwordMaintenance: true, anonymousRecovery: false } };
}
