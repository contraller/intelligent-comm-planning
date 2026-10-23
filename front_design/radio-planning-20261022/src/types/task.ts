import type { PlanningInput, PlanningIssue } from './planning';
import type { ResourceChanges, ResourceFile, ResourceSaveResult } from './resource-edit';

// 任务身份、输入修订和影响结果的条件版本分别记录。
export interface TaskVersion { id:string; number:number; conditionVersion:string; savedAt:string; input:PlanningInput }
export interface SavedTask { id:string; versions:TaskVersion[] }
export interface TaskReceipt { requestId:string; signature:string; taskId:string|null; changed:boolean }
export interface TaskWorkspace { revision:string; tasks:SavedTask[]; receipts:TaskReceipt[] }
export interface TaskSaveRequest { baseTaskRevision:string; baseResourceRevision:string; requestId:string; taskId:string; input:PlanningInput; context?:'gis'|'planning' }
export interface GisSaveRequest { baseResourceRevision:string; baseTaskRevision:string; requestId:string; changes:ResourceChanges; task:{taskId:string;input:PlanningInput}|null; context:'gis' }
export interface TaskSaveResult extends ResourceSaveResult { tasks:TaskWorkspace; task:SavedTask|null }
export interface TaskFileInput { name:string; bytes:Uint8Array }
export interface TaskImportRequest { files:TaskFileInput[]; baseResourceRevision:string; baseTaskRevision:string; input:PlanningInput; context:'gis'|'planning'; draftChanges?:ResourceChanges }
export interface TaskImportIssue extends PlanningIssue { sheet?:string; row?:number }
export interface TaskImportPreview { notes:string[]; taskId:string; input:PlanningInput|null; issues:TaskImportIssue[]; signature:string; existing:boolean; differences:{field:string;before:unknown;after:unknown}[] }
export interface TaskServices {
  loadTaskWorkspace():Promise<TaskWorkspace>;
  saveTask(request:TaskSaveRequest):Promise<TaskSaveResult>;
  commitGisWorkspace(request:GisSaveRequest):Promise<TaskSaveResult>;
  getTaskTemplate(format:'xlsx'|'csv',kind?:'task_scenarios'|'task_links'):Promise<ResourceFile>;
  previewTaskImport(request:TaskImportRequest):Promise<TaskImportPreview>;
}
