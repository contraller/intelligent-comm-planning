import type { ApiReceipt, ApiTask, TaskApiServices } from '../types/task-api';
import type { ResourceMeta, ResourceStorage } from '../types/resource-edit';
import type { ResourcesData } from '../types/domain';
import type { SavedTask } from '../types/task';
import { createTaskMock } from './task-mock';
import { readPlanning } from './planning-storage';
// 活动作业及回执读取使用完整目录，业务语义保持。
import { planningPresets } from './planning-preset-catalog';
import { assertApiPage, assertTaskOptions, readTaskInput } from './task-api-validation';
import { validateTaskInput } from './task-validation';
import { taskTemplate } from './task-files';
import { ApiError } from './types';

// 桥接既有事务和持久化，不创建另一套 Mock 任务状态机。
export function createTaskApiMock(getStorage: () => ResourceStorage, source: () => { resources: ResourcesData; meta: ResourceMeta }, receipts = new Map<string, ApiReceipt>()): TaskApiServices {
  const legacy = createTaskMock(getStorage);
  function convert(task: SavedTask): ApiTask {
    const last = task.versions.at(-1)!; let activeJobId: string | null = null;
    try { activeJobId = readPlanning(getStorage(), planningPresets).jobs.filter(j => j.taskId === task.id).at(-1)?.id ?? null; } catch { /* 任务读取不依赖损坏的规划记录。 */ }
    return { taskId: task.id, revision: last.id, inputVersion: last.id, conditionVersion: last.conditionVersion, resourceRevision: source().meta.revision, input: structuredClone(last.input), updatedAt: last.savedAt, activeJobId };
  }
  const get: TaskApiServices['getTaskInput'] = async input => {
    assertTaskOptions(input); const found = (await legacy.loadTaskWorkspace()).tasks.find(t => t.id === input.taskId);
    if (!found) throw new ApiError('任务不存在', 'TASK_NOT_FOUND'); return convert(found);
  };
  return {
    async queryTaskInputs(input) {
      assertApiPage(input); const items = (await legacy.loadTaskWorkspace()).tasks.map(convert).filter(t => !input.search || (t.taskId + t.input.name).includes(input.search));
      return { items: items.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), total: items.length, page: input.page, pageSize: input.pageSize };
    }, getTaskInput: get,
    async saveTaskInput(input) {
      assertTaskOptions(input); readTaskInput(input.input);
      const workspace = await legacy.loadTaskWorkspace(), old = workspace.tasks.find(t => t.id === input.taskId);
      if (!workspace.receipts.some(r => r.requestId === input.requestId) && (old?.versions.at(-1)?.id ?? null) !== input.revision) throw new ApiError('任务版本已变化', 'TASK_REVISION_CONFLICT');
      const saved = await legacy.saveTask({ taskId: input.taskId, input: input.input, requestId: input.requestId, baseTaskRevision: workspace.revision, baseResourceRevision: input.resourceRevision, context: input.context });
      const task = convert(saved.task!); receipts.set(input.requestId, { requestId: input.requestId, taskId: input.taskId, entityId: task.taskId, kind: 'saveTask', state: 'SUCCEEDED', message: '任务已保存' }); return task;
    },
    async validateTaskInputApi(input) {
      assertTaskOptions(input); const current = source(); if (current.meta.revision !== input.resourceRevision) throw new ApiError('资源版本已变化', 'RESOURCE_VERSION_CHANGED');
      const issues = validateTaskInput(input.input, current.resources), task = (await legacy.loadTaskWorkspace()).tasks.find(t => t.id === input.taskId);
      return { valid: !issues.length, issues, task: task ? convert(task) : null };
    },
    async previewTaskInputImport(input) {
      assertTaskOptions(input); const tasks = await legacy.loadTaskWorkspace();
      const preview = await legacy.previewTaskImport({ files: input.files, input: input.input, context: input.context, baseResourceRevision: input.resourceRevision, baseTaskRevision: tasks.revision });
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
        if (input.kind === 'savePlan') result.entityId = w.plans.find(p => p.workflow?.saveRequestId === input.requestId && p.taskId === input.taskId)?.id ?? null;
        if (input.kind === 'confirm') result.entityId = w.plans.find(p => p.workflow?.confirmation?.requestId === input.requestId && p.taskId === input.taskId)?.id ?? null;
      }
      if (result.entityId) { result.state = 'SUCCEEDED'; result.message = '已读取保存回执'; } return result;
    },
  };
}
