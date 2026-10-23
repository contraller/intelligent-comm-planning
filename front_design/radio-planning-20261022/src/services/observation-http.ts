import { resolveAuthApiBaseUrl } from '../config/env';
import type { ObservationRead, ObservationServices } from '../types/observation';
import { createHttpClient } from './http-client';
import { assertObservationQuery, decodeObservationContext, decodeObservationDatasets, decodeObservationFrame, decodeObservationFrames } from './observation-validation';
import { ApiError } from './types';
import type { AuthenticatedRequest } from './auth-http';

interface Options { baseUrl: () => string; fetcher?: typeof fetch; origin?: () => string | undefined; timeoutMs?: number; authenticatedRequest?: AuthenticatedRequest }
const prefix = '/observations/spectrum';

export function createObservationHttp(options: Options): ObservationServices {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new ApiError('观测超时设置无效', 'INVALID_OBSERVATION_QUERY');
  const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  async function get(path: string, params: Record<string, string | number | undefined>, input: ObservationRead): Promise<unknown> {
    if (input.signal?.aborted) throw new ApiError('观测读取已取消', 'REQUEST_ABORTED');
    const base = options.authenticatedRequest ? '' : resolveAuthApiBaseUrl(options.baseUrl(), options.origin?.() ?? globalThis.location?.origin);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => { reject(new ApiError('观测读取已取消', 'REQUEST_ABORTED')); controller.abort(); };
      input.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { reject(new ApiError('观测读取超时', 'REQUEST_TIMEOUT')); controller.abort(); }, options.timeoutMs ?? 15000);
    });
    try {
      const url = `${prefix}${path}${query.size ? '?' + query : ''}`;
      // 交付入口注入同一认证客户端，读取也受会话代次和取消保护。
      const pending = options.authenticatedRequest
        ? options.authenticatedRequest(url, { method: 'GET', signal: controller.signal })
        : createHttpClient(base, fetcher)(url, {
          method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json' }, signal: controller.signal,
        });
      return await Promise.race([pending, interrupted]);
    } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); }
  }
  return {
    async loadObservationContext(input = {}) {
      assertObservationQuery(input, 'context');
      const query = Object.freeze({ ...input });
      return decodeObservationContext(await get('/context', { dataset_id: query.datasetId, dataset_revision: query.datasetRevision }, query), query);
    },
    async queryObservationDatasets(input) {
      assertObservationQuery(input, 'datasets');
      const query = Object.freeze({ ...input });
      return decodeObservationDatasets(await get('/datasets', { page: query.page, page_size: query.pageSize }, query), query);
    },
    async queryObservationFrames(input) {
      assertObservationQuery(input, 'frames');
      const query = Object.freeze({ ...input });
      return decodeObservationFrames(await get(`/datasets/${encodeURIComponent(query.datasetId)}/frames`, {
        dataset_revision: query.datasetRevision, page: query.page, page_size: query.pageSize,
      }, query), query);
    },
    async getObservationFrame(input) {
      assertObservationQuery(input, 'index');
      const query = Object.freeze({ ...input });
      return decodeObservationFrame(await get(`/datasets/${encodeURIComponent(query.datasetId)}/frames/${query.index}`, {
        dataset_revision: query.datasetRevision,
      }, query), query);
    },
  };
}
