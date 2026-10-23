import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../../src/services/auth-http';
import { createRuntimeParametersHttp, decodeRuntimeParameters } from '../../src/services/runtime-parameters-http';
import { ApiError } from '../../src/services/types';

const wire = () => ({ version: 'runtime-parameters-v1', epoch: 'epoch-one', revision: 'SYS-1', values: { 'PAR-01': 30, 'PAR-02': 15 } });
const invalid = { code: 'INVALID_RUNTIME_PARAMETERS_RESPONSE', message: '运行参数响应不符合契约' };

describe('runtime parameters HTTP', () => {
  it('uses only the injected authenticated request, exact GET path and signal', async () => {
    const raw = wire(), request = vi.fn(async () => raw), signal = new AbortController().signal;
    const result = await createRuntimeParametersHttp(request as AuthenticatedRequest).getRuntimeParameters({ signal });
    expect(request.mock.calls).toEqual([['/system/runtime-parameters', { method: 'GET', cache: 'no-store', signal }]]);
    expect(result).toEqual(raw);
    expect(result).not.toBe(raw);
    raw.values['PAR-01'] = 99;
    expect(result.values['PAR-01']).toBe(30);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.values)).toBe(true);
    expect(() => Object.assign(result.values, { 'PAR-01': 99 })).toThrow(TypeError);
  });
  it.each([[1, 1], [3600, 120]])('accepts exact inclusive bounds %s/%s', (p1, p2) => {
    expect(decodeRuntimeParameters({ ...wire(), values: { 'PAR-01': p1, 'PAR-02': p2 } }).values).toEqual({ 'PAR-01': p1, 'PAR-02': p2 });
  });
  it.each([null, [], true, 'runtime', { ...wire(), extra: true }, { ...wire(), contractVersion: 'runtime-parameters-v1' },
    { ...wire(), version: 'runtime-parameters-v2' }, { ...wire(), version: undefined },
    { epoch: 'e', revision: 'SYS-1', values: { 'PAR-01': 30, 'PAR-02': 15 } },
    { ...wire(), values: { 'PAR-01': 30 } }, { ...wire(), values: { ...wire().values, 'PAR-03': 4326 } },
    { ...wire(), values: [] }, { ...wire(), values: null }, new Date(),
  ])('rejects unknown/missing/extra fields without defaults', value => {
    expect(() => decodeRuntimeParameters(value)).toThrowError(expect.objectContaining(invalid));
  });
  it.each(['', ' ', ' epoch', 'epoch ', 'epoch\n', 'epoch\x00', 'epoch\x7f', 'x'.repeat(65), 123, null])('rejects invalid epoch', epoch => {
    expect(() => decodeRuntimeParameters({ ...wire(), epoch })).toThrowError(expect.objectContaining(invalid));
  });
  it.each(['SYS-0', 'SYS-01', 'SYS--1', 'SYS-1.0', 'sys-1', 'SYS-1\n', 'SYS-9007199254740992', 1, null])('rejects noncanonical revision', revision => {
    expect(() => decodeRuntimeParameters({ ...wire(), revision })).toThrowError(expect.objectContaining(invalid));
  });
  it.each([0, 3601, 1.5, NaN, Infinity, '30', true, null, undefined])('rejects PAR-01 outside strict integer range', value => {
    expect(() => decodeRuntimeParameters({ ...wire(), values: { ...wire().values, 'PAR-01': value } })).toThrowError(expect.objectContaining(invalid));
  });
  it.each([0, 121, 1.5, NaN, Infinity, '15', false, null, undefined])('rejects PAR-02 outside strict integer range', value => {
    expect(() => decodeRuntimeParameters({ ...wire(), values: { ...wire().values, 'PAR-02': value } })).toThrowError(expect.objectContaining(invalid));
  });
  it('rejects hidden/symbol/prototype additions and does not echo invalid payload', () => {
    const hidden = wire(); Object.defineProperty(hidden, 'hidden', { value: 'do-not-echo' });
    const symbol = { ...wire(), [Symbol('hidden')]: 'do-not-echo' };
    const inherited = Object.assign(Object.create({ hidden: true }), wire());
    for (const value of [hidden, symbol, inherited]) {
      expect(() => decodeRuntimeParameters(value)).toThrowError(expect.objectContaining(invalid));
    }
  });
  it('propagates authorization/transport errors without retry or fallback', async () => {
    const error = new ApiError('login required', 'AUTH_REQUIRED', undefined, undefined, 401);
    const request = vi.fn().mockRejectedValue(error);
    await expect(createRuntimeParametersHttp(request as AuthenticatedRequest).getRuntimeParameters()).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not request with a pre-aborted signal', async () => {
    const controller = new AbortController(), request = vi.fn(); controller.abort();
    await expect(createRuntimeParametersHttp(request as AuthenticatedRequest).getRuntimeParameters({ signal: controller.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects a late result after cancellation even if the injected client ignores abort', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { controller.abort(); return wire(); });
    await expect(createRuntimeParametersHttp(request as AuthenticatedRequest).getRuntimeParameters({ signal: controller.signal })).rejects.toMatchObject({ code: 'REQUEST_ABORTED' });
  });
  it.each([null, [], { page: 1 }, { signal: 'not-a-signal' }, { signal: null }])('rejects unknown request inputs before HTTP', async input => {
    const request = vi.fn();
    await expect(createRuntimeParametersHttp(request as AuthenticatedRequest).getRuntimeParameters(input as never)).rejects.toMatchObject({ code: 'INVALID_RUNTIME_PARAMETERS_REQUEST' });
    expect(request).not.toHaveBeenCalled();
  });
});
