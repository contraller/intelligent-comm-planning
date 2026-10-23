import type { MonitoringServices } from '../types/monitoring';
import type { DeviceConfigurationServices } from '../types/device-configuration';
import type { ResourceStatusServices } from '../types/resource-status';
import type { InterferenceServices } from '../types/interference';
import type { TaskServices } from '../types/task';
import type { PreviewData } from '../types/domain';
import type { ResourceCommit, ResourceSaveResult, ResourceServices } from '../types/resource-edit';
import type { PlanningServices } from '../types/planning';
import type { DiagnosisServices } from '../types/diagnosis';
import type { KnowledgeServices } from '../types/knowledge';
import type { SystemServices } from '../types/system';
import type { SpectrumServices } from '../types/spectrum';
import type { ResourceReadServices } from '../types/resource-read';
import type { TaskApiServices } from '../types/task-api';
import type { PlanningApiServices } from '../types/planning-api';
import type { GisResourceServices } from '../types/gis-workspace';
import type { DeviceMaintenanceServices } from '../types/device-maintenance';
import type { DeviceNetworkDetailServices } from '../types/device-network';

// 维护读取共用数据源契约，页面不直接导入教学资料。
export interface PreviewService extends DeviceMaintenanceServices, DeviceNetworkDetailServices {}

// 配置演示使用独立契约，成功回执不改变资源保存返回体。
export interface PreviewService extends GisResourceServices, DeviceConfigurationServices, ResourceStatusServices, TaskApiServices, PlanningApiServices, ResourceReadServices, MonitoringServices, InterferenceServices, TaskServices, PlanningServices, DiagnosisServices, KnowledgeServices, SystemServices, ResourceServices, SpectrumServices {
  loadPreview(): Promise<PreviewData>;
  commitResources(request: ResourceCommit): Promise<ResourceSaveResult>;
  resetResources(
    baseRevision: string | null,
  ): Promise<ResourceSaveResult & { preview: PreviewData }>;
}
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  request_id?: string;
}

// 业务失败响应中的建议、缺口等数据必须随错误保留。
export class ApiError<T = unknown> extends Error {
  constructor(
    message: string,
    public code: number | string,
    public data?: T,
    public requestId?: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
