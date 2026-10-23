import type { AuthenticatedRequest } from './auth-http';
import type { ApiTaskImportPreview, TaskApiServices } from '../types/task-api';
import { TASK_MAX_FILE_BYTES } from '../config/demo';
import {
  apiBool,
  apiChoice,
  apiId,
  apiList,
  apiNumber,
  apiRecord,
  apiText,
  assertTaskOptions,
  invalidApi,
  readIssue,
  readTaskInput,
} from './task-api-validation';
import { ApiError } from './types';

type FileServices = Pick<TaskApiServices, 'previewTaskInputImport' | 'getTaskInputTemplate'>;

function body(value: unknown) {
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('nonfinite');
      return item;
    });
  } catch {
    throw new ApiError('任务文件输入不能包含非有限数值或循环引用', 'VALIDATION_ERROR');
  }
}
function encoded(bytes: Uint8Array) {
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += 16384)
    parts.push(String.fromCharCode(...bytes.slice(start, start + 16384)));
  return btoa(parts.join(''));
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalidApi('task file fields');
}

export function createTaskFileHttp(request: AuthenticatedRequest): FileServices {
  return {
    async previewTaskInputImport(input) {
      assertTaskOptions(input);
      apiId(input.taskId);
      apiId(input.resourceRevision);
      if (input.revision !== null) apiId(input.revision);
      if (!Array.isArray(input.files) || !input.files.length || input.files.length > 2)
        throw new ApiError('请选择一个XLSX或两个CSV', 'IMPORT_LIMIT');
      const files = input.files.map((file) => {
        if (
          !file ||
          typeof file.name !== 'string' ||
          !file.name ||
          file.name.length > 255 ||
          /[\\/\u0000-\u001f]/.test(file.name) ||
          !(file.bytes instanceof Uint8Array) ||
          !file.bytes.length ||
          file.bytes.length > TASK_MAX_FILE_BYTES
        )
          throw new ApiError('任务文件名、大小或内容无效', 'IMPORT_LIMIT');
        return { name: file.name, bytes_base64: encoded(file.bytes) };
      });
      const expected = {
        context: input.context,
        taskId: input.taskId,
        taskRevision: input.revision,
        resourceRevision: input.resourceRevision,
      };
      // 请求体在await之前冻结；原文件交后端解析，本地不再调用Mock解析器。
      const payload = body({
        context: expected.context,
        task_id: expected.taskId,
        expected_revision: expected.taskRevision,
        resource_revision: expected.resourceRevision,
        input: input.input,
        files,
      });
      const value = apiRecord(
        await request('/task-files/preview', {
          method: 'POST',
          body: payload,
          signal: input.signal,
        }),
      );
      exactKeys(value, [
        'taskId',
        'input',
        'issues',
        'notes',
        'differences',
        'signature',
        'existing',
        'taskRevision',
        'resourceRevision',
        'requestContext',
      ]);
      const context = apiRecord(value.requestContext);
      exactKeys(context, ['context', 'taskId', 'taskRevision', 'resourceRevision']);
      if (
        Object.entries(expected).some(([key, item]) => context[key] !== item) ||
        value.resourceRevision !== expected.resourceRevision
      )
        invalidApi('task file context');
      const existing = apiBool(value.existing, 'existing');
      const revision = value.taskRevision === null ? null : apiId(value.taskRevision);
      if (existing !== (revision !== null)) invalidApi('task file revision');
      const signature = apiText(value.signature, 'signature');
      if (!/^[0-9a-f]{64}$/.test(signature)) invalidApi('task file fingerprint');
      const issues = apiList(value.issues, 'issues', (raw) => {
        const row = apiRecord(raw),
          issue = readIssue(row);
        return {
          ...issue,
          ...(row.sheet === undefined
            ? {}
            : { sheet: apiChoice(row.sheet, ['task_scenarios', 'task_links'], 'sheet') }),
          ...(row.row === undefined ? {} : { row: apiNumber(row.row, 'row', 1, 1048576) }),
        };
      });
      if (issues.some((issue) => issue.row !== undefined && !Number.isInteger(issue.row)))
        invalidApi('task file row');
      let candidate: ReturnType<typeof readTaskInput> | null = null;
      if (value.input !== null) {
        try { candidate = readTaskInput(value.input); }
        catch { invalidApi('task file candidate'); }
      }
      if ((issues.length && candidate !== null) || (!issues.length && candidate === null))
        invalidApi('task file validation');
      const taskId = candidate ? apiId(value.taskId) : apiText(value.taskId, 'taskId', true);
      return {
        taskId,
        input: candidate,
        issues,
        notes: apiList(value.notes, 'notes', (row) => apiText(row, 'note')),
        differences: apiList(value.differences, 'differences', (raw) => {
          const row = apiRecord(raw);
          exactKeys(row, ['field', 'before', 'after']);
          return { field: apiText(row.field, 'field'), before: row.before, after: row.after };
        }),
        signature,
        existing,
        taskRevision: revision,
        resourceRevision: expected.resourceRevision,
      } satisfies ApiTaskImportPreview;
    },
    async getTaskInputTemplate(input) {
      assertTaskOptions(input);
      const format = apiChoice(input.format, ['csv', 'xlsx'], 'format'),
        kind = apiChoice(input.kind ?? 'task_scenarios', ['task_scenarios', 'task_links'], 'kind');
      const file = await request<Blob>(
        '/task-files/template',
        {
          method: 'POST',
          body: body({ context: input.context, format, kind, input: input.input }),
          signal: input.signal,
        },
        'blob',
      );
      const mime =
        format === 'csv'
          ? 'text/csv'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      if (
        !(file instanceof Blob) ||
        !file.size ||
        file.size > TASK_MAX_FILE_BYTES ||
        file.type.split(';')[0].trim().toLowerCase() !== mime
      )
        invalidApi('task template file');
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (format === 'xlsx') {
        if (bytes[0] !== 80 || bytes[1] !== 75 || bytes[2] !== 3 || bytes[3] !== 4)
          invalidApi('task template xlsx');
      } else {
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          return invalidApi('task template UTF8');
        }
        if (
          !text.startsWith(kind === 'task_scenarios' ? 'task_id,task_name,' : 'demand_id,task_id,')
        )
          invalidApi('task template header');
      }
      return {
        name: format === 'csv' ? kind + '.csv' : 'task-template.xlsx',
        mime: file.type,
        bytes,
      };
    },
  };
}
