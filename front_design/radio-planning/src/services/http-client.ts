import { ApiError, type ApiEnvelope } from './types';

// 通用请求只处理传输与包络，业务字段和认证错误由各自适配器解释。
export function createHttpClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  return async function request<T>(path: string, init?: RequestInit, responseType: 'json' | 'blob' = 'json'): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`, init);
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : '网络请求失败', 'NETWORK_ERROR');
    }
    // 图片错误仍按 JSON 业务包络解释，不能把登录页或错误文本当作图片。
    if (responseType === 'blob' && response.ok && response.headers.get('Content-Type')?.split(';')[0].trim() === 'image/png') {
      const blob = await response.blob();
      if (!blob.size || blob.size > 20 * 1024 * 1024) throw new ApiError('覆盖图片为空或超过 20 MiB', 'INVALID_COVERAGE_IMAGE');
      return blob as T;
    }
    let payload: ApiEnvelope<T>;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError('响应不是有效 JSON', 'INVALID_RESPONSE', undefined, undefined, response.status);
    }
    if (!payload || typeof payload.code !== 'number' || typeof payload.message !== 'string' || !('data' in payload)) {
      throw new ApiError('响应包络不符合契约', 'INVALID_ENVELOPE', payload, undefined, response.status);
    }
    if (!response.ok || payload.code !== 0) {
      throw new ApiError(payload.message || `HTTP ${response.status}`, payload.code, payload.data, payload.request_id, response.status);
    }
    if (responseType === 'blob') throw new ApiError('覆盖接口未返回 PNG 图片', 'INVALID_COVERAGE_IMAGE');
    return payload.data;
  };
}
