import type { AuthenticatedRequest } from './auth-http';
import { ApiError } from './types';
import {
  configurationContextQuery, configurationDetailQuery, configurationHistoryQuery, configurationRequestInput,
  readConfigurationAcceptance, readConfigurationContext, readConfigurationHistory, readConfigurationValidation,
  type ConfigurationContextQuery, type ConfigurationDetailQuery, type ConfigurationHistoryQuery,
  type ConfigurationRequestInput, type ConfigurationSubmissionInput,
} from './device-configuration-decode';

export function createDeviceConfigurationHttp(request: AuthenticatedRequest) {
  async function call(path: string, init?: RequestInit): Promise<unknown> {
    try { return await request(path, init); }
    catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const codes: Record<number, string> = { 1001: 'VALIDATION_ERROR', 1002: 'CONFIGURATION_NOT_FOUND',
        1203: 'CONFIGURATION_SOURCE_CHANGED', 1205: 'RESOURCE_VERSION_CHANGED', 1206: 'REQUEST_CONFLICT' };
      const code = typeof error.code === 'number' ? codes[error.code] : undefined;
      if (!code) throw error;
      throw new ApiError(error.message, code, error.data, error.requestId, error.status);
    }
  }
  // 传输与响应绑定使用同一请求副本，页面后续编辑不改变本次期望。
  return {
    async loadContext(input: ConfigurationContextQuery, options: { signal?: AbortSignal } = {}) {
      configurationContextQuery(input);
      const captured = { ...input };
      return readConfigurationContext(await call('/device-configurations/context?' + new URLSearchParams(captured), { signal: options.signal }), captured);
    },
    async validateRequest(input: ConfigurationRequestInput, options: { signal?: AbortSignal } = {}) {
      configurationRequestInput(input);
      const captured = { ...input, values: { ...input.values } };
      return readConfigurationValidation(await call('/device-configurations/validate', { method: 'POST', body: JSON.stringify(captured), signal: options.signal }), captured);
    },
    async submitRequest(input: ConfigurationSubmissionInput, options: { signal?: AbortSignal } = {}) {
      configurationRequestInput(input, true);
      const captured = { ...input, values: { ...input.values } };
      return readConfigurationAcceptance(await call('/device-configurations', { method: 'POST', body: JSON.stringify(captured), signal: options.signal }), captured);
    },
    async getRequest(input: ConfigurationDetailQuery, options: { signal?: AbortSignal } = {}) {
      configurationDetailQuery(input);
      const captured = { ...input };
      return readConfigurationAcceptance(await call('/device-configurations/' + encodeURIComponent(captured.request_id) + '?context=ledger', { signal: options.signal }), captured);
    },
    async queryHistory(input: ConfigurationHistoryQuery, options: { signal?: AbortSignal } = {}) {
      configurationHistoryQuery(input);
      const captured = { ...input };
      const query = new URLSearchParams({ context: captured.context, page: String(captured.page ?? 1), page_size: String(captured.page_size ?? 20) });
      if (captured.device_id !== undefined) query.set('device_id', captured.device_id);
      return readConfigurationHistory(await call('/device-configurations/history?' + query, { signal: options.signal }), captured);
    },
  };
}
