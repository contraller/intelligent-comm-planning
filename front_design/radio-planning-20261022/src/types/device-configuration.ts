import type { Device, DeviceModel } from './domain';
import type { PageQuery, PageResult } from './data-access';

// 配置回执独立于台账：服务返回执行结果，页面不回填资源。
export type ConfigurationContext = 'gis' | 'ledger';
export type ConfigurationScenario = 'success' | 'validation-rejected' | 'send-failed' | 'receipt-failed' | 'reply-lost';
// 配置提交明确携带工作模式；设备台账的未知模式仍独立保留。
export interface ConfigurationValues { txPowerDbm: number; workFreqKhz: number; currentWorkMode: string }
export interface ConfigurationPreset { id: string; modelId: string; name: string; version: string; source: string; values: ConfigurationValues }
export interface ConfigurationIdentity { deviceId: string; modelId: string; resourceEpoch: string; deviceVersion: string }
export interface ConfigurationQuery { context: ConfigurationContext; deviceId: string }
export interface DeviceConfigurationContext extends ConfigurationIdentity {
  modeOptions?: { value: string; label: string }[];
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
  actor?: import('./system').ActorSnapshot | null;
  id: string; request: ConfigurationSubmit; signature: string; device: Device; modelName: string;
  acceptedAt: string; updatedAt: string; phase: ConfigurationPhase; status: ConfigurationStatus;
  message: string; appliedValues: ConfigurationValues | null; source: string;
}
export interface ConfigurationOperationResult { status: ConfigurationStatus | 'NOT_FOUND'; operation: ConfigurationOperation | null; sourceChanged: boolean }
export interface ConfigurationHistoryQuery extends PageQuery { context: ConfigurationContext; deviceId?: string }
export type ConfigurationHistory = PageResult<ConfigurationOperationResult>;
export interface ConfigurationWorkspace { schemaVersion: number; operations: ConfigurationOperation[] }
export interface ConfigurationPending { ownerId: string; request: ConfigurationSubmit }
export interface DeviceConfigurationServices {
  queryDeviceConfigurationHistory(request: ConfigurationHistoryQuery): Promise<PageResult<ConfigurationHistoryItem>>;
  submitDeviceConfigurationReceipt(request: ConfigurationSubmit): Promise<{ objectId:string; requestId:string; deviceId:string; status:ConfigurationStatus|'NOT_FOUND' }>;
  getDeviceConfigurationProgress(request:{context:ConfigurationContext;requestId:string;deviceId?:string}):Promise<ConfigurationProgress>;
  loadDeviceConfigurationContext(request: ConfigurationQuery): Promise<DeviceConfigurationContext>;
  validateDeviceConfiguration(request: ConfigurationValidationRequest): Promise<ConfigurationValidation>;
  submitDeviceConfiguration(request: ConfigurationSubmit): Promise<ConfigurationOperationResult>;
  getDeviceConfigurationOperation(request: { context: ConfigurationContext; requestId: string; deviceId?: string }): Promise<ConfigurationOperationResult>;
  queryDeviceConfigurationOperations(request: ConfigurationHistoryQuery): Promise<ConfigurationHistory>;
}
// 历史行不包含完整冻结设备及请求；选中后按原请求编号读取。
export interface ConfigurationHistoryItem { id:string;requestId:string;deviceId:string;acceptedAt:string;status:ConfigurationStatus|'NOT_FOUND';sourceChanged:boolean;values:ConfigurationValues }
export interface ConfigurationProgress { requestId:string;status:ConfigurationStatus|'NOT_FOUND';sourceChanged:boolean;phase?:ConfigurationOperation['phase'];message?:string;updatedAt?:string }
