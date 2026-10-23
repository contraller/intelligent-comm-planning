import type { ApiReceipt, ApiTask, TaskApiServices } from '../types/task-api';
import type { ResourceMeta, ResourceStorage } from '../types/resource-edit';
import type { ResourcesData } from '../types/domain';
import type { SavedTask, TaskReceipt, TaskSaveRequest } from '../types/task';
import { createTaskMock } from './task-mock';
import { readPlanning } from './planning-storage';
// 活动作业及回执读取使用完整目录，业务语义保持。
import { planningPresets } from './planning-preset-catalog';
import { assertApiPage, assertTaskOptions, readTaskInput } from './task-api-validation';
import { validateTaskInput } from './task-validation';
import { taskTemplate } from './task-files';
import { ApiError } from './types';
import { mockResourceRevision, requireMockResourceRevision } from './mock-resource-revision';
import { resourceFingerprint } from './resource-files';
import { RESOURCE_STORAGE_KEY } from '../config/demo';

interface ApiTaskReceipt extends TaskReceipt {
  apiSave?: { signature: string; baseTaskRevision: string; baseResourceRevision: string };
}

// 桥接既有事务和持久化，不创建另一套 Mock 任务状态机。
export function createTaskApiMock(getStorage: () => ResourceStorage, source: () => { resources: ResourcesData; meta: ResourceMeta }, receipts = new Map<string, ApiReceipt>()): TaskApiServices {
  const legacy = createTaskMock(getStorage);
  function convert(task: SavedTask): ApiTask {
    const last = task.versions.at(-1)!; let activeJobId: string | null = null;
    try { activeJobId = readPlanning(getStorage(), planningPresets).jobs.filter(j => j.taskId === task.id).at(-1)?.id ?? null; } catch { /* 任务读取不依赖损坏的规划记录。 */ }
    return { taskId: task.id, revision: last.id, inputVersion: last.id, conditionVersion: last.conditionVersion, resourceRevision: mockResourceRevision(source()), input: structuredClone(last.input), updatedAt: last.savedAt, activeJobId };
  }
  const get: TaskApiServices['getTaskInput'] = async input => {
    assertTaskOptions(input); const found = (await legacy.loadTaskWorkspace()).tasks.find(t => t.id === input.taskId);
    if (!found) throw new ApiError('任务不存在', 'TASK_NOT_FOUND'); return convert(found);
  };
  const service: TaskApiServices = {
    async queryTaskSummaries(input) {
      const page=await service.queryTaskInputs(input);
      return {...page,items:page.items.map(({input: taskInput,...summary})=>({...summary,name:taskInput.name}))};
    },
    async saveTaskInputReceipt(input) {
      const {input: taskInput,activeJobId:_active,...summary}=await service.saveTaskInput(input);
      return {...summary,name:taskInput.name,objectId:summary.taskId,changed:true};
    },
    async queryTaskInputs(input) {
      assertApiPage(input); const items = (await legacy.loadTaskWorkspace()).tasks.map(convert).filter(t => !input.search || (t.taskId + t.input.name).includes(input.search));
      return { items: items.slice((input.pageNum - 1) * input.pageSize, input.pageNum * input.pageSize), total: items.length, pageNum: input.pageNum, pageSize: input.pageSize };
    }, getTaskInput: get,
    async saveTaskInput(input) {
      assertTaskOptions(input); readTaskInput(input.input);
      const workspace = await legacy.loadTaskWorkspace(), old = workspace.tasks.find(t => t.id === input.taskId);
      const prior = workspace.receipts.find(r => r.requestId === input.requestId) as ApiTaskReceipt | undefined;
      const signature = await resourceFingerprint({ ...input, signal: undefined });
      if (prior && (!prior.apiSave || prior.apiSave.signature !== signature)) throw new ApiError('同一请求 ID 对应不同内容', 'IDEMPOTENCY_CONFLICT');
      if (!prior && (old?.versions.at(-1)?.id ?? null) !== input.revision) throw new ApiError('任务版本已变化', 'TASK_REVISION_CONFLICT');
      const request: TaskSaveRequest = { taskId: input.taskId, input: input.input, requestId: input.requestId,
        baseTaskRevision: prior?.apiSave?.baseTaskRevision ?? workspace.revision,
        baseResourceRevision: prior?.apiSave?.baseResourceRevision ?? requireMockResourceRevision(source(), input.resourceRevision), context: input.context };
      const storage = getStorage();
      // 将适配回执附在原事务的同一次写入中，刷新后仍可重放原请求，不新增一次资源写入。
      const transactional: ResourceStorage = { getItem: key => storage.getItem(key), setItem: (key, text) => {
        if (key === RESOURCE_STORAGE_KEY) {
          const record = JSON.parse(text), receipt = record.taskWorkspace?.receipts.find((r: TaskReceipt) => r.requestId === input.requestId);
          if (!receipt) throw new ApiError('任务回执缺失，未写入资源', 'INVALID_PLANNING_RESPONSE');
          receipt.apiSave = { signature, baseTaskRevision: request.baseTaskRevision, baseResourceRevision: request.baseResourceRevision };
          storage.setItem(key, JSON.stringify(record));
        } else storage.setItem(key, text);
      } };
      const saved = await createTaskMock(() => transactional).saveTask(request);
      const task = convert(saved.task!); receipts.set(input.requestId, { requestId: input.requestId, taskId: input.taskId, entityId: task.taskId, kind: 'saveTask', state: 'SUCCEEDED', message: '任务已保存' }); return task;
    },
    async validateTaskInputApi(input) {
      assertTaskOptions(input); const current = source(); requireMockResourceRevision(current, input.resourceRevision);
      const issues = validateTaskInput(input.input, current.resources), task = (await legacy.loadTaskWorkspace()).tasks.find(t => t.id === input.taskId);
      return { valid: !issues.length, issues, task: task ? convert(task) : null };
    },
    async previewTaskInputImport(input) {
      assertTaskOptions(input); const tasks = await legacy.loadTaskWorkspace();
      const revision = requireMockResourceRevision(source(), input.resourceRevision);
      const preview = await legacy.previewTaskImport({ files: input.files, input: input.input, context: input.context, baseResourceRevision: revision, baseTaskRevision: tasks.revision });
      return { ...preview, taskRevision: tasks.tasks.find(t=>t.id===preview.taskId)?.versions.at(-1)?.id ?? null, resourceRevision: input.resourceRevision };
    },
    async getTaskInputTemplate(input) { assertTaskOptions(input); return taskTemplate(input.format, input.kind, input.input); },
    async getPlanningOperation(input) {
      assertTaskOptions(input); const cached = receipts.get(input.requestId);
      if (cached) { if (cached.taskId !== input.taskId || cached.kind !== input.kind) throw new ApiError('回执归属不符', 'IDEMPOTENCY_CONFLICT'); return structuredClone(cached); }
      const result: ApiReceipt = { ...input, entityId: null, state: 'NOT_FOUND', message: '没有此请求回执' };
      if (input.kind === 'saveTask') { const r = (await legacy.loadTaskWorkspace()).receipts.find(r => r.requestId === input.requestId && r.taskId === input.taskId); if (r) result.entityId = r.taskId; }
      else {
        const w = readPlanning(getStorage(), planningPresets);
        if (input.kind === 'submit') result.entityId = w.jobs.find(j => j.requestId === input.requestId && j.taskId === input.taskId)?.id ?? null;
        if (input.kind === 'cancel') result.entityId = w.jobs.find(j => j.cancelRequestId === input.requestId && j.taskId === input.taskId)?.id ?? null;
        if (input.kind === 'savePlan') result.entityId = w.plans.find(p => p.workflow?.saveRequestId === input.requestId && p.taskId === input.taskId)?.id ?? null;
        if (input.kind === 'confirm') result.entityId = w.plans.find(p => p.workflow?.confirmation?.requestId === input.requestId && p.taskId === input.taskId)?.id ?? null;
      }
      if (result.entityId) { result.state = 'SUCCEEDED'; result.message = '已读取保存回执'; } return result;
    },
  };
  return service;
}
