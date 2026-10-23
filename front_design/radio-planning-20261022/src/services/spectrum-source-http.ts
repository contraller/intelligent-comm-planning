import type { AuthenticatedRequest } from './auth-http';
import type { ObservationPage } from '../types/observation';
import type { SpectrumOfflineCheck, SpectrumSourceServices, SpectrumSourceVersion, SpectrumSourceRow } from '../types/spectrum-source';
import { assertSpectrumSourceQuery, decodeSourceOperation, decodeSourcePage, decodeSourceReceipt, decodeSourceVersion, decodeSpectrumSourceConfigFile } from './spectrum-source-validation';
import { ApiError } from './types';

export function createSpectrumSourceHttp(request: AuthenticatedRequest): SpectrumSourceServices {
  const prefix = '/spectrum';
  function get(path: string, params: Record<string, string | number | boolean | undefined>, signal?: AbortSignal) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    return request<unknown>(prefix + path + (query.size ? '?' + query : ''), { method: 'GET', signal });
  }
  return {
    async querySources(input) {
      assertSpectrumSourceQuery(input, ['page', 'pageSize', 'search', 'enabled'], ['page', 'pageSize']);
      const query = Object.freeze({ ...input });
      const value = await get('/sources', { page: query.page, page_size: query.pageSize, search: query.search, enabled: query.enabled }, query.signal);
      return decodeSourcePage(value, query, 'sources') as ObservationPage<SpectrumSourceRow>;
    },
    async getSource(input) {
      assertSpectrumSourceQuery(input, ['sourceId', 'configRevision'], ['sourceId']);
      const query = Object.freeze({ ...input });
      return decodeSourceVersion(await get(`/sources/${encodeURIComponent(query.sourceId)}`, { config_revision: query.configRevision }, query.signal), query);
    },
    async saveSource(input) {
      assertSpectrumSourceQuery(input, ['requestId', 'sourceId', 'baseConfigRevision', 'draft'], ['requestId', 'sourceId', 'baseConfigRevision', 'draft']);
      const query = Object.freeze({ ...input, draft: Object.freeze({ ...input.draft }) });
      const { signal, ...body } = query;
      const value = await request('/spectrum/sources', { method: 'POST', signal, body: JSON.stringify({ schemaVersion: 1, ...body }) });
      const result = decodeSourceReceipt(value, { ...query, operationType: 'SOURCE_SAVE' });
      if (JSON.stringify(result.source?.draft) !== JSON.stringify(query.draft)) {
        // 字段顺序可变化，逐字段核对实际保存值。
        if (Object.keys(query.draft).some(key => result.source?.draft[key as keyof typeof query.draft] !== query.draft[key as keyof typeof query.draft])) throw new ApiError('保存回执与提交配置不一致', 'INVALID_SPECTRUM_SOURCE_RESPONSE');
      }
      return result;
    },
    async checkSource(input) {
      assertSpectrumSourceQuery(input, ['requestId', 'sourceId', 'configRevision'], ['requestId', 'sourceId', 'configRevision']);
      const query = Object.freeze({ ...input });
      const value = await request(`/spectrum/sources/${encodeURIComponent(query.sourceId)}/checks`, {
        method: 'POST', signal: query.signal, body: JSON.stringify({ schemaVersion: 1, requestId: query.requestId, configRevision: query.configRevision }),
      });
      return decodeSourceReceipt(value, { ...query, operationType: 'SOURCE_CHECK' });
    },
    async queryVersions(input) {
      assertSpectrumSourceQuery(input, ['sourceId', 'page', 'pageSize'], ['sourceId', 'page', 'pageSize']);
      const query = Object.freeze({ ...input });
      const value = await get(`/sources/${encodeURIComponent(query.sourceId)}/versions`, { page: query.page, page_size: query.pageSize }, query.signal);
      return decodeSourcePage(value, query, 'versions') as ObservationPage<SpectrumSourceVersion> & { sourceId: string };
    },
    async queryChecks(input) {
      assertSpectrumSourceQuery(input, ['sourceId', 'configRevision', 'page', 'pageSize'], ['sourceId', 'page', 'pageSize']);
      const query = Object.freeze({ ...input });
      const value = await get(`/sources/${encodeURIComponent(query.sourceId)}/checks`, { config_revision: query.configRevision, page: query.page, page_size: query.pageSize }, query.signal);
      const result = decodeSourcePage(value, query, 'checks') as ObservationPage<SpectrumOfflineCheck> & { sourceId: string };
      if (query.configRevision && result.items.some(item => item.configRevision !== query.configRevision)) throw new ApiError('检查记录配置版本不一致', 'INVALID_SPECTRUM_SOURCE_RESPONSE');
      return result;
    },
    async getSourceReceipt(input) {
      assertSpectrumSourceQuery(input, ['requestId', 'operationType'], ['requestId', 'operationType']);
      const query = Object.freeze({ ...input });
      return decodeSourceOperation(await get(`/source-operations/${encodeURIComponent(query.requestId)}`, { operation_type: query.operationType }, query.signal), query);
    },
    async exportSource(input) {
      assertSpectrumSourceQuery(input, ['sourceId', 'configRevision'], ['sourceId', 'configRevision']);
      const query = Object.freeze({ ...input });
      const blob = await request<Blob>(`/spectrum/sources/${encodeURIComponent(query.sourceId)}/export?config_revision=${encodeURIComponent(query.configRevision)}`, { method: 'GET', signal: query.signal }, 'blob');
      if (!(blob instanceof Blob) || blob.size > 2 * 1024 * 1024) throw new ApiError('来源导出文件无效或超过2MiB', 'INVALID_SPECTRUM_SOURCE_RESPONSE');
      let value;
      try { value = decodeSpectrumSourceConfigFile(JSON.parse(await blob.text())); }
      catch { throw new ApiError('来源导出文件无效', 'INVALID_SPECTRUM_SOURCE_RESPONSE'); }
      if (value.schemaVersion !== 1 || value.fileKind !== 'SPECTRUM_SOURCE_CONFIG' || value.dataOrigin !== 'SYNTHETIC_INTEGRATION' || value.sourceId !== query.sourceId || value.configRevision !== query.configRevision) throw new ApiError('来源导出身份不一致', 'INVALID_SPECTRUM_SOURCE_RESPONSE');
      return blob;
    },
  };
}
