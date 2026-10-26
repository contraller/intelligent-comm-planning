export const RUNTIME_PARAMETERS_VERSION = 'runtime-parameters-v1' as const;

export const RUNTIME_PARAMETER_LIMITS = Object.freeze({
  'PAR-01': Object.freeze({ min: 1, max: 3600 }),
  'PAR-02': Object.freeze({ min: 1, max: 120 }),
});

export type RuntimeParameterId = keyof typeof RUNTIME_PARAMETER_LIMITS;

export interface RuntimeParametersSnapshot {
  readonly version: typeof RUNTIME_PARAMETERS_VERSION;
  readonly epoch: string;
  readonly revision: string;
  readonly values: Readonly<Record<RuntimeParameterId, number>>;
}

export interface RuntimeParametersServices {
  getRuntimeParameters(input?: { readonly signal?: AbortSignal }): Promise<RuntimeParametersSnapshot>;
}

export interface RuntimeParameterApplication {
  readonly consumer: string;
  readonly epoch: string;
  readonly revision: string;
}
