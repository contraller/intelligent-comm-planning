import type { AuthenticatedRequest } from './auth-http';
import { ApiError } from './types';
import { RUNTIME_PARAMETER_LIMITS, RUNTIME_PARAMETERS_VERSION } from '../types/runtime-parameters';
import type { RuntimeParameterId, RuntimeParametersServices, RuntimeParametersSnapshot } from '../types/runtime-parameters';

const invalid = () => new ApiError('运行参数响应不符合契约', 'INVALID_RUNTIME_PARAMETERS_RESPONSE');

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
}

export function decodeRuntimeParameters(value: unknown): RuntimeParametersSnapshot {
  if (!exact(value, ['version', 'epoch', 'revision', 'values'])
    || value.version !== RUNTIME_PARAMETERS_VERSION
    || typeof value.epoch !== 'string' || !value.epoch.length || value.epoch.length > 64
    || value.epoch !== value.epoch.trim() || /[\u0000-\u001f\u007f]/.test(value.epoch)
    || typeof value.revision !== 'string' || !/^SYS-[1-9][0-9]*$/.test(value.revision)
    || !Number.isSafeInteger(Number(value.revision.slice(4)))
    || !exact(value.values, ['PAR-01', 'PAR-02'])) throw invalid();
  for (const id of Object.keys(RUNTIME_PARAMETER_LIMITS) as RuntimeParameterId[]) {
    const parameter = value.values[id], limits = RUNTIME_PARAMETER_LIMITS[id];
    if (typeof parameter !== 'number' || !Number.isInteger(parameter)
      || parameter < limits.min || parameter > limits.max) throw invalid();
  }
  return Object.freeze({ version: RUNTIME_PARAMETERS_VERSION, epoch: value.epoch, revision: value.revision,
    values: Object.freeze({ 'PAR-01': value.values['PAR-01'] as number, 'PAR-02': value.values['PAR-02'] as number }) });
}

export function createRuntimeParametersHttp(request: AuthenticatedRequest): RuntimeParametersServices {
  return {
    async getRuntimeParameters(input = {}) {
      if (!exact(input, []) && !exact(input, ['signal'])) {
        throw new ApiError('运行参数请求只接受取消信号', 'INVALID_RUNTIME_PARAMETERS_REQUEST');
      }
      const signal = input.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new ApiError('运行参数取消信号无效', 'INVALID_RUNTIME_PARAMETERS_REQUEST');
      }
      if (signal?.aborted) throw new ApiError('运行参数请求已取消', 'REQUEST_ABORTED');
      const value = await request('/system/runtime-parameters', { method: 'GET', cache: 'no-store', signal });
      if (signal?.aborted) throw new ApiError('运行参数请求已取消', 'REQUEST_ABORTED');
      return decodeRuntimeParameters(value);
    },
  };
}
