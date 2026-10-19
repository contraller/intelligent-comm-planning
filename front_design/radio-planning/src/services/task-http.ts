import type { TaskApiServices, TaskApiOptions, TaskApiValidation } from '../types/task-api';
import type { AuthenticatedRequest } from './auth-http';
import { apiId, assertApiPage, assertTaskOptions, invalidApi, readApiPage, readApiTask, readReceipt, readTaskInput, readTaskValidation, taskInputIssues, uniqueIds } from './task-api-validation';
import { parseTaskFileInput, taskTemplate } from './task-files';
import { sameValue } from './planning-validation';
import { planningOptionKeys } from './planning-options';
import { routingClearNotes } from './planning-routing';

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
  return {
    async queryTaskInputs(input) {
      assertApiPage(input);
      const page = readApiPage(await request(`/task-inputs?${query(input, { page: input.page, page_size: input.pageSize, search: input.search })}`, { signal: input.signal }), input, v => readApiTask(v));
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
    async previewTaskInputImport(input) {
      assertTaskOptions(input);
      const { taskRow, ...filePreview } = await parseTaskFileInput({ files: input.files, input: input.input, context: input.context, baseResourceRevision: input.resourceRevision, baseTaskRevision: input.revision ?? 'new' });
      const parsed = { ...filePreview, taskRevision: null as string | null, resourceRevision: input.resourceRevision };
      // 新任务条件同样定位实际任务行，需求仍按原ID映射。
      const issueLocation = (issue: { objectId: string; field: string }) => ['deploymentConstraints',...planningOptionKeys].some(key=>issue.field.startsWith(key))
        ? { sheet: 'task_scenarios', row: taskRow }
        : { sheet: parsed.sourceRows[issue.objectId] ? 'task_links' : 'task_scenarios', row: parsed.sourceRows[issue.objectId] ?? 2 };
      if (!parsed.input) return parsed;
      const localIssues = taskInputIssues(parsed.input);
      if (localIssues.length) { parsed.issues.push(...localIssues.map(issue => ({ ...issue, ...issueLocation(issue) })));parsed.input=null;return parsed; }
      const checked = await validate({ ...input, taskId: parsed.taskId, revision: parsed.taskId === input.taskId ? input.revision : null, input: parsed.input });
      parsed.existing = !!checked.task;
      parsed.taskRevision = checked.task?.revision ?? null;
      if (checked.task) parsed.notes.push('同编号任务已存在；应用后须按该任务当前版本保存。');
      const before = checked.task?.input ?? input.input, candidate = parsed.input;
      // 服务可能返回同编号的另一保存版本，清空提示以该版本为准。
      for (const note of routingClearNotes(before,candidate)) if (!parsed.notes.includes(note)) parsed.notes.push(note);
      // 完整导入移除部署条件也必须可审阅，不能只比较新对象仍存在的键。
      const compareKeys = [...new Set([...Object.keys(candidate), ...['deploymentConstraints',...planningOptionKeys].filter(key=>Object.hasOwn(before,key))])];
      parsed.differences = compareKeys.filter(k => !sameValue(candidate[k as keyof typeof candidate], before[k as keyof typeof before])).map(field => ({ field, before: before[field as keyof typeof before], after: candidate[field as keyof typeof candidate] }));
      if (before.deploymentConstraints && candidate.deploymentConstraints === undefined && !parsed.notes.some(note => note.includes('清空原部署条件')))
        parsed.notes.push('文件未设置部署条件，确认应用后将清空原部署条件；尚未保存。');
      for(const key of planningOptionKeys)if(before[key]&&candidate[key]===undefined){
        const label=key==='frequencyConstraints'?'频率过滤':'部署求解';
        if(!parsed.notes.some(note=>note.includes('文件未设置'+label)))parsed.notes.push('文件未设置'+label+'，确认应用后将清空原设置；尚未保存。');
      }
      parsed.issues.push(...checked.issues.map(issue => ({ ...issue, ...issueLocation(issue) })));
      if (!checked.valid) parsed.input = null;
      return parsed;
    },
    async getTaskInputTemplate(input) { assertTaskOptions(input); return taskTemplate(input.format, input.kind, input.input); },
    async getPlanningOperation(input) {
      apiId(input.requestId); apiId(input.taskId);
      return readReceipt(await request(`/planning-operations/${encodeURIComponent(input.requestId)}?${query(input, { task_id: input.taskId, kind: input.kind })}`, { signal: input.signal }), input);
    },
  };
}
