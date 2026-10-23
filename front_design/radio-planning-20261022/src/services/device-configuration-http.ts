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
  return {
    async loadContext(input: ConfigurationContextQuery) {
      configurationContextQuery(input);
      return readConfigurationContext(await call('/device-configurations/context?' + new URLSearchParams({ ...input })), input);
    },
    async validateRequest(input: ConfigurationRequestInput) {
      configurationRequestInput(input);
      return readConfigurationValidation(await call('/device-configurations/validate', { method: 'POST', body: JSON.stringify(input) }), input);
    },
    async submitRequest(input: ConfigurationSubmissionInput) {
      configurationRequestInput(input, true);
      return readConfigurationAcceptance(await call('/device-configurations', { method: 'POST', body: JSON.stringify(input) }), input);
    },
    async getRequest(input: ConfigurationDetailQuery) {
      configurationDetailQuery(input);
      return readConfigurationAcceptance(await call('/device-configurations/' + encodeURIComponent(input.request_id) + '?context=ledger'), input);
    },
    async queryHistory(input: ConfigurationHistoryQuery) {
      configurationHistoryQuery(input);
      const query = new URLSearchParams({ context: input.context, page: String(input.page ?? 1), page_size: String(input.page_size ?? 20) });
      if (input.device_id !== undefined) query.set('device_id', input.device_id);
      return readConfigurationHistory(await call('/device-configurations/history?' + query), input);
    },
  };
}
