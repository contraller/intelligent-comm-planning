import type { Device, DeviceModel } from './domain';

// 配置回执独立于台账：服务返回执行结果，页面不回填资源。
export type ConfigurationContext = 'gis' | 'ledger';
export type ConfigurationScenario = 'success' | 'validation-rejected' | 'send-failed' | 'receipt-failed' | 'reply-lost';
export interface ConfigurationValues { txPowerDbm: number; workFreqKhz: number }
export interface ConfigurationPreset { id: string; modelId: string; name: string; version: string; source: string; values: ConfigurationValues }
export interface ConfigurationIdentity { deviceId: string; modelId: string; resourceEpoch: string; deviceVersion: string }
export interface ConfigurationQuery { context: ConfigurationContext; deviceId: string }
export interface DeviceConfigurationContext extends ConfigurationIdentity {
  device: Device; model: DeviceModel; powerLevels: number[] | null;
  presets: ConfigurationPreset[]; defaultPresetId: string | null; unavailableReason: string;
  source: string;
  scenarios: { id: ConfigurationScenario; name: string }[];
}
export interface ConfigurationValidationRequest extends ConfigurationIdentity {
  context: ConfigurationContext; values: ConfigurationValues; scenario: ConfigurationScenario; presetVersion: string;
}
export interface ConfigurationIssue { field: string; message: string }
export interface ConfigurationValidation { valid: boolean; issues: ConfigurationIssue[]; preset: ConfigurationPreset | null }
export interface ConfigurationSubmit extends ConfigurationValidationRequest { requestId: string; retryOf?: string }
export type ConfigurationPhase = 'DISPATCH' | 'RECEIPT';
export type ConfigurationStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export interface ConfigurationOperation {
  id: string; request: ConfigurationSubmit; signature: string; device: Device; modelName: string;
  acceptedAt: string; updatedAt: string; phase: ConfigurationPhase; status: ConfigurationStatus;
  message: string; appliedValues: ConfigurationValues | null; source: string;
}
export interface ConfigurationOperationResult { status: ConfigurationStatus | 'NOT_FOUND'; operation: ConfigurationOperation | null; sourceChanged: boolean }
export interface ConfigurationHistoryQuery { context: ConfigurationContext; deviceId?: string; page: number; pageSize: number }
export interface ConfigurationHistory { items: ConfigurationOperationResult[]; page: number; pageSize: number; total: number }
export interface ConfigurationWorkspace { schemaVersion: number; operations: ConfigurationOperation[] }
export interface ConfigurationPending { ownerId: string; request: ConfigurationSubmit }
export interface DeviceConfigurationServices {
  loadDeviceConfigurationContext(request: ConfigurationQuery): Promise<DeviceConfigurationContext>;
  validateDeviceConfiguration(request: ConfigurationValidationRequest): Promise<ConfigurationValidation>;
  submitDeviceConfiguration(request: ConfigurationSubmit): Promise<ConfigurationOperationResult>;
  getDeviceConfigurationOperation(request: { context: ConfigurationContext; requestId: string; deviceId?: string }): Promise<ConfigurationOperationResult>;
  queryDeviceConfigurationOperations(request: ConfigurationHistoryQuery): Promise<ConfigurationHistory>;
}
