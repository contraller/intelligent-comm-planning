import type { PlanningInput, PlanningIssue } from './planning';
import type { TaskFileInput, TaskImportPreview } from './task';
import type { ResourceFile } from './resource-edit';

// 输入版本与业务条件版本分离；分页记录不伪装成完整 Mock 工作区。
export interface TaskApiOptions { context: 'gis' | 'planning'; signal?: AbortSignal }
export interface ApiPageQuery extends TaskApiOptions { page: number; pageSize: number; search?: string }
export interface ApiPage<T> { items: T[]; total: number; page: number; pageSize: number }
export interface ApiTask {
  taskId: string; revision: string; inputVersion: string; conditionVersion: string;
  resourceRevision: string; input: PlanningInput; updatedAt: string; activeJobId: string | null;
}
export interface TaskApiSave extends TaskApiOptions {
  taskId: string; revision: string | null; resourceRevision: string; requestId: string; input: PlanningInput;
}
export interface TaskApiValidation extends TaskApiOptions {
  taskId: string; revision: string | null; resourceRevision: string; input: PlanningInput;
}
export interface TaskApiImport extends TaskApiValidation { files: TaskFileInput[] }
export interface ApiTaskImportPreview extends TaskImportPreview { taskRevision: string | null; resourceRevision: string }
export interface TaskValidationResult { valid: boolean; issues: PlanningIssue[]; task: ApiTask | null }
export type OperationKind = 'saveTask' | 'submit' | 'cancel' | 'savePlan' | 'confirm';
export interface ApiReceipt {
  requestId: string; kind: OperationKind; state: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'NOT_FOUND';
  taskId: string; entityId: string | null; message: string;
}
export interface TaskApiServices {
  queryTaskInputs(input: ApiPageQuery): Promise<ApiPage<ApiTask>>;
  getTaskInput(input: TaskApiOptions & { taskId: string }): Promise<ApiTask>;
  saveTaskInput(input: TaskApiSave): Promise<ApiTask>;
  validateTaskInputApi(input: TaskApiValidation): Promise<TaskValidationResult>;
  previewTaskInputImport(input: TaskApiImport): Promise<ApiTaskImportPreview>;
  getTaskInputTemplate(input: TaskApiOptions & { format: 'csv' | 'xlsx'; kind?: 'task_scenarios' | 'task_links'; input: PlanningInput }): Promise<ResourceFile>;
  getPlanningOperation(input: TaskApiOptions & { requestId: string; taskId: string; kind: OperationKind }): Promise<ApiReceipt>;
}
