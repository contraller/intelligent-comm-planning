import type { TaskApiServices, TaskApiOptions, TaskApiValidation } from '../types/task-api';
import type { AuthenticatedRequest } from './auth-http';
import { apiId, assertApiPage, assertTaskOptions, invalidApi, readApiPage, readApiTask, readReceipt, readTaskInput, readTaskValidation, uniqueIds } from './task-api-validation';
import { createTaskFileHttp } from './task-file-http';
import { sameValue } from './planning-validation';

// 新增任务输入端点属于 planning-http-draft-0.1，不使用异步作业 ID 保存任务。
export function createTaskHttp(request: AuthenticatedRequest): TaskApiServices {
  const query = (input: TaskApiOptions, values: Record<string, string | number | undefined> = {}) => {
    assertTaskOptions(input); const q = new URLSearchParams({ context: input.context });
    Object.entries(values).forEach(([k, v]) => { if (v !== undefined) q.set(k, String(v)); }); return q;
  };
  const payload = (input: TaskApiValidation) => {
    assertTaskOptions(input); apiId(input.taskId); apiId(input.resourceRevision); if (input.revision !== null) apiId(input.revision);
    return { context: input.context, task_id: input.taskId, expected_revision: input.revision, resource_revision: input.resourceRevision, input: readTaskInput(input.input) };
  };
  const validate: TaskApiServices['validateTaskInputApi'] = async input => readTaskValidation(await request('/task-inputs/validate', { method: 'POST', body: JSON.stringify(payload(input)), signal: input.signal }), input.taskId);
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
      assertApiPage(input);
      const page = readApiPage(await request(`/task-inputs?${query(input, { page: input.pageNum, page_size: input.pageSize, search: input.search })}`, { signal: input.signal }), input, v => readApiTask(v));
      uniqueIds(page.items, t => t.taskId, 'task ids'); return page;
    },
    async getTaskInput(input) { apiId(input.taskId); return readApiTask(await request(`/task-inputs/${encodeURIComponent(input.taskId)}?${query(input)}`, { signal: input.signal }), input.taskId); },
    async saveTaskInput(input) {
      apiId(input.requestId); const body = { ...payload(input), request_id: input.requestId };
      const saved = readApiTask(await request(`/task-inputs/${encodeURIComponent(input.taskId)}`, { method: 'PUT', body: JSON.stringify(body), signal: input.signal }), input.taskId);
      if (!sameValue(saved.input, body.input)) invalidApi('saved task input');
      return saved;
    },
    validateTaskInputApi: validate,
    ...createTaskFileHttp(request),
    async getPlanningOperation(input) {
      apiId(input.requestId); apiId(input.taskId);
      return readReceipt(await request(`/planning-operations/${encodeURIComponent(input.requestId)}?${query(input, { task_id: input.taskId, kind: input.kind })}`, { signal: input.signal }), input);
    },
  };
  return service;
}
