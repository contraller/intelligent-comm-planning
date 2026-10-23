import { resolveAuthApiBaseUrl } from '../config/env';
import type { ObservationRead, ObservationServices } from '../types/observation';
import { createHttpClient } from './http-client';
import { assertObservationQuery, decodeObservationContext, decodeObservationDatasets, decodeObservationFrame, decodeObservationFrames } from './observation-validation';
import { ApiError } from './types';
import type { AuthenticatedRequest } from './auth-http';
import { assertObservationImportKey, decodeObservationImportFile, decodeObservationImportOperation, decodeObservationImportPreview, decodeObservationDeviceStatusRef, sameObservationStatusRef } from './observation-validation';

interface Options { baseUrl: () => string; fetcher?: typeof fetch; origin?: () => string | undefined; timeoutMs?: number; authenticatedRequest?: AuthenticatedRequest }
const prefix = '/observations/spectrum';

export function createObservationHttp(options: Options): ObservationServices {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new ApiError('观测超时设置无效', 'INVALID_OBSERVATION_QUERY');
  const fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  function importQuery(input: unknown, fields: string[], optional: string[] = []) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('导入参数无效', 'INVALID_OBSERVATION_QUERY');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => ![...fields, ...optional, 'signal'].includes(key)) || fields.some(key => !Object.hasOwn(value, key)) || value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw new ApiError('导入参数含未知、缺失或无效字段', 'INVALID_OBSERVATION_QUERY');
    if (value.includeDeviceStatusRef !== undefined && typeof value.includeDeviceStatusRef !== 'boolean') throw new ApiError('关联投影参数无效', 'INVALID_OBSERVATION_QUERY');
  }
  function bound<T>(path: string, init: RequestInit, responseType: 'json' | 'blob' = 'json'): Promise<T> {
    if (!options.authenticatedRequest) throw new ApiError('显式导入需注入当前认证会话', 'AUTH_REQUIRED');
    if (init.signal?.aborted) throw new ApiError('请求已取消；写入结果须另查回执', 'REQUEST_ABORTED');
    return options.authenticatedRequest<T>(prefix + path, init, responseType);
  }
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
    async previewObservationImport(input) {
      importQuery(input, ['file']);
      decodeObservationImportFile(input.file);
      const file = structuredClone(input.file), signal = input.signal;
      return decodeObservationImportPreview(await bound('/import-preview', { method: 'POST', signal, body: JSON.stringify({ file }) }), file);
    },
    async importObservation(input) {
      importQuery(input, ['requestId', 'previewHash', 'file'], ['datasetContentHash']);
      assertObservationImportKey(input); decodeObservationImportFile(input.file);
      if (!/^[0-9a-f]{64}$/.test(input.previewHash)) throw new ApiError('预检摘要无效', 'INVALID_OBSERVATION_QUERY');
      const file = structuredClone(input.file), requestId = input.requestId, previewHash = input.previewHash, signal = input.signal, datasetContentHash = input.datasetContentHash;
      if (file.schemaVersion === 1 ? Object.hasOwn(input, 'datasetContentHash') : typeof datasetContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(datasetContentHash)) throw new ApiError('导入协议与正文摘要不匹配', 'INVALID_OBSERVATION_QUERY');
      const result = decodeObservationImportOperation(await bound('/imports', { method: 'POST', signal, body: JSON.stringify({ requestId, previewHash, file, ...(file.schemaVersion === 2 ? { datasetContentHash } : {}) }) }), requestId, file.schemaVersion === 2);
      if (!result.receipt || result.receipt.datasetId !== file.dataset.datasetId || result.receipt.resourceRevision !== file.dataset.resourceRevision || result.receipt.frameCount !== file.dataset.frames.length || result.receipt.datasetRevision !== 'observation-' + (file.schemaVersion === 2 ? datasetContentHash : previewHash)
        || file.schemaVersion === 2 && (result.schemaVersion !== 2 || !result.deviceStatusRef || !sameObservationStatusRef(result.deviceStatusRef, file.deviceStatusRef))) throw new ApiError('导入回执与提交内容或冻结关联不一致', 'INVALID_OBSERVATION_RESPONSE');
      return result;
    },
    async getObservationImportReceipt(input) {
      importQuery(input, ['requestId'], ['includeDeviceStatusRef']);
      assertObservationImportKey(input);
      const query = Object.freeze({ ...input });
      const suffix = query.includeDeviceStatusRef === undefined ? '' : '?include_device_status_ref=' + query.includeDeviceStatusRef;
      return decodeObservationImportOperation(await bound(`/imports/${encodeURIComponent(query.requestId)}${suffix}`, { method: 'GET', signal: query.signal }), query.requestId, query.includeDeviceStatusRef === true);
    },
    async getObservationDeviceStatusRef(input) {
      assertObservationQuery(input, 'context');
      const query = Object.freeze({ ...input });
      if (!query.datasetId || !query.datasetRevision) throw new ApiError('请选择精确观测版本', 'INVALID_OBSERVATION_QUERY');
      return decodeObservationDeviceStatusRef(await bound(`/datasets/${encodeURIComponent(query.datasetId)}/device-status-ref?dataset_revision=${encodeURIComponent(query.datasetRevision)}`, { method: 'GET', signal: query.signal }), query);
    },
    async exportObservationDataset(input) {
      importQuery(input, ['datasetId', 'datasetRevision'], ['includeDeviceStatusRef']);
      const { includeDeviceStatusRef, ...selection } = input;
      assertObservationQuery(selection, 'context');
      const query = Object.freeze({ ...input });
      if (!query.datasetId || !query.datasetRevision) throw new ApiError('请选择精确观测版本', 'INVALID_OBSERVATION_QUERY');
      const suffix = includeDeviceStatusRef === undefined ? '' : '&include_device_status_ref=' + includeDeviceStatusRef;
      const blob = await bound<Blob>(`/datasets/${encodeURIComponent(query.datasetId)}/export?dataset_revision=${encodeURIComponent(query.datasetRevision)}${suffix}`, { method: 'GET', signal: query.signal }, 'blob');
      if (!(blob instanceof Blob) || blob.size > 2 * 1024 * 1024) throw new ApiError('导出文件无效或超过2MiB', 'INVALID_OBSERVATION_RESPONSE');
      let file;
      try { file = decodeObservationImportFile(JSON.parse(await blob.text())); }
      catch { throw new ApiError('导出文件未通过完整校验', 'INVALID_OBSERVATION_RESPONSE'); }
      if (file.dataset.datasetId !== query.datasetId || !includeDeviceStatusRef && file.schemaVersion !== 1) throw new ApiError('导出观测编号或协议不一致', 'INVALID_OBSERVATION_RESPONSE');
      return blob;
    },
  };
}
