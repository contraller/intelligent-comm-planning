import { describe, expect, expectTypeOf, it } from 'vitest';
import { RUNTIME_PARAMETER_LIMITS, RUNTIME_PARAMETERS_VERSION } from '../../src/types/runtime-parameters';
import type { RuntimeParameterApplication, RuntimeParameterId, RuntimeParametersSnapshot } from '../../src/types/runtime-parameters';

describe('runtime parameters contract', () => {
  it('defines the exact version, two parameter IDs and no default values', () => {
    expect(RUNTIME_PARAMETERS_VERSION).toBe('runtime-parameters-v1');
    expect(RUNTIME_PARAMETER_LIMITS).toEqual({ 'PAR-01': { min: 1, max: 3600 }, 'PAR-02': { min: 1, max: 120 } });
    expect(Object.keys(RUNTIME_PARAMETER_LIMITS)).toEqual(['PAR-01', 'PAR-02']);
    expect(RUNTIME_PARAMETER_LIMITS['PAR-01']).not.toHaveProperty('value');
    expect(RUNTIME_PARAMETER_LIMITS['PAR-02']).not.toHaveProperty('value');
  });
  it('freezes both the catalog and its individual limits', () => {
    expect(Object.isFrozen(RUNTIME_PARAMETER_LIMITS)).toBe(true);
    for (const limits of Object.values(RUNTIME_PARAMETER_LIMITS)) expect(Object.isFrozen(limits)).toBe(true);
    expect(() => Object.assign(RUNTIME_PARAMETER_LIMITS['PAR-01'], { max: 30 })).toThrow(TypeError);
  });
  it('keeps snapshots and local application markers readonly', () => {
    expectTypeOf<RuntimeParameterId>().toEqualTypeOf<'PAR-01' | 'PAR-02'>();
    expectTypeOf<RuntimeParametersSnapshot>().toEqualTypeOf<{
      readonly version: 'runtime-parameters-v1'; readonly epoch: string; readonly revision: string;
      readonly values: Readonly<Record<'PAR-01' | 'PAR-02', number>>;
    }>();
    expectTypeOf<RuntimeParameterApplication>().toEqualTypeOf<{
      readonly consumer: string; readonly epoch: string; readonly revision: string;
    }>();
  });
});
