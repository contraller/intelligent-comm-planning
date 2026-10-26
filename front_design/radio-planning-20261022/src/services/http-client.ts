import { ApiError, type ApiEnvelope } from './types';

const fileMimes = new Set([
  'application/json', 'application/pdf', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const maxFileSize = 20 * 1024 * 1024;

// 通用请求只处理传输与包络，业务字段和认证错误由各自适配器解释。
export function createHttpClient(baseUrl: string, fetcher: typeof fetch = fetch) {
  return async function request<T>(path: string, init?: RequestInit, responseType: 'json' | 'blob' = 'json'): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`, init);
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : '网络请求失败', 'NETWORK_ERROR');
    }
    const mime = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    const attachment = /^attachment(?:;|$)/i.test(response.headers.get('Content-Disposition')?.trim() ?? '');
    // 只有 PNG 或白名单附件进入文件分支；错误包络始终保留业务失败语义。
    if (responseType === 'blob' && response.ok && (mime === 'image/png' || attachment && fileMimes.has(mime ?? ''))) {
      const invalidFile = () => new ApiError('下载文件为空、格式错误或超过 20 MiB', mime === 'image/png' ? 'INVALID_COVERAGE_IMAGE' : 'INVALID_DOWNLOAD_FILE');
      if (Number(response.headers.get('Content-Length')) > maxFileSize) throw invalidFile();
      const blob = await response.blob();
      if (!blob.size || blob.size > maxFileSize) throw invalidFile();
      if (mime === 'application/json') {
        let value: unknown;
        try { value = JSON.parse(await blob.text()); } catch { throw invalidFile(); }
        // 即使服务端误加附件头，也不能把鉴权失败 JSON 保存成报告。
        if (value && typeof value === 'object' && 'code' in value && 'message' in value && 'data' in value) {
          const envelope = value as ApiEnvelope<unknown>;
          if (typeof envelope.code !== 'number' || typeof envelope.message !== 'string') throw invalidFile();
          if (envelope.code !== 0) throw new ApiError(envelope.message, envelope.code, envelope.data, envelope.request_id, response.status);
          throw invalidFile();
        }
      }
      return blob as T;
    }
    if (responseType === 'blob' && response.ok && attachment && mime !== 'application/json') {
      throw new ApiError('下载接口返回了不支持的文件类型', 'INVALID_DOWNLOAD_FILE', undefined, undefined, response.status);
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
