import type { PlanningInput, PlanningIssue } from './planning';
import type { TaskFileInput, TaskImportPreview } from './task';
import type { ResourceFile } from './resource-edit';
import type { PageQuery, PageResult, SearchQuery } from './data-access';

// 输入版本与业务条件版本分离；分页记录不伪装成完整 Mock 工作区。
export interface TaskApiOptions { context: 'gis' | 'planning'; signal?: AbortSignal }
export interface ApiPageQuery extends TaskApiOptions, PageQuery, SearchQuery {}
export type ApiPage<T> = PageResult<T>;
// resourceRevision 与资源读取工作区的 revision 相同，页面不拆解其内部组成。
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
  queryTaskSummaries(input: ApiPageQuery): Promise<ApiPage<ApiTaskSummary>>;
  saveTaskInputReceipt(input: TaskApiSave): Promise<Omit<ApiTaskSummary, 'activeJobId'> & { objectId: string; changed: boolean }>;
  queryTaskInputs(input: ApiPageQuery): Promise<ApiPage<ApiTask>>;
  getTaskInput(input: TaskApiOptions & { taskId: string }): Promise<ApiTask>;
  saveTaskInput(input: TaskApiSave): Promise<ApiTask>;
  validateTaskInputApi(input: TaskApiValidation): Promise<TaskValidationResult>;
  previewTaskInputImport(input: TaskApiImport): Promise<ApiTaskImportPreview>;
  getTaskInputTemplate(input: TaskApiOptions & { format: 'csv' | 'xlsx'; kind?: 'task_scenarios' | 'task_links'; input: PlanningInput }): Promise<ResourceFile>;
  getPlanningOperation(input: TaskApiOptions & { requestId: string; taskId: string; kind: OperationKind }): Promise<ApiReceipt>;
}

// 目录只含选择和展示身份，完整任务输入由 getTaskInput 返回。
export interface ApiTaskSummary extends Omit<ApiTask, 'input'> { name: string }
