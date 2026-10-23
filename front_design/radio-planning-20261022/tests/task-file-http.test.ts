import { describe, expect, it } from 'vitest';
import { createTaskFileHttp } from '../src/services/task-file-http';
import { input, httpFixture, response } from './fixtures/planning-api';

const context = {
  context: 'planning' as const,
  taskId: 'T1',
  taskRevision: 't1',
  resourceRevision: 'r1',
};
const options = {
  context: context.context,
  taskId: context.taskId,
  revision: context.taskRevision,
  resourceRevision: context.resourceRevision,
  input: input(),
  files: [{ name: 'input.xlsx', bytes: new Uint8Array([80, 75, 3, 4]) }],
};
function preview() {
  return {
    taskId: 'TASK-NEW',
    input: input(),
    issues: [],
    notes: ['仅替换草稿；尚未保存'],
    differences: [],
    signature: 'a'.repeat(64),
    existing: false,
    taskRevision: null,
    resourceRevision: 'r1',
    requestContext: { ...context },
  };
}

describe('任务原文件HTTP契约', () => {
  it('上传原始字节及版本上下文，仅预检不保存或执行规划', async () => {
    const f = httpFixture(() => response(preview()));
    const value = await createTaskFileHttp(f.request).previewTaskInputImport(options);
    expect(value.input).toEqual(input());
    expect(f.calls.filter(row => !row.path.includes('/auth/')).map((row) => row.path)).toEqual(['/api/v1/task-files/preview']);
    const call = f.calls.at(-1)!,
      body = JSON.parse(String(call.init.body));
    expect(body).toMatchObject({
      context: 'planning',
      task_id: 'T1',
      expected_revision: 't1',
      resource_revision: 'r1',
      files: [{ name: 'input.xlsx', bytes_base64: 'UEsDBA==' }],
    });
    expect(new Headers(call.init.headers).get('X-CSRF-Token')).toBe('csrf1');
  });
  it('原文件与输入在发起时冻结，晚修改不改变请求体', async () => {
    const f = httpFixture(() => response(preview())),
      service = createTaskFileHttp(f.request);
    const request = {
      ...options,
      input: input(),
      files: [{ name: 'input.xlsx', bytes: new Uint8Array([80, 75, 3, 4]) }],
    };
    const pending = service.previewTaskInputImport(request);
    request.files[0].bytes.fill(0);
    request.input.name = 'late-change';
    await pending;
    const body = JSON.parse(String(f.calls.at(-1)!.init.body));
    expect(body.input.name).not.toBe('late-change');
    expect(body.files[0].bytes_base64).toBe('UEsDBA==');
  });
  it.each(['context', 'taskId', 'taskRevision', 'resourceRevision'] as const)(
    '拒绝%s不属于发起上下文的预览',
    async (key) => {
      const value = { ...preview(), requestContext: { ...context, [key]: 'other' } };
      const f = httpFixture(() => response(value));
      await expect(
        createTaskFileHttp(f.request).previewTaskInputImport(options),
      ).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
    },
  );
  it.each(['', 'bad', 'A'.repeat(64)])('拒绝无效指纹%s', async (signature) => {
    const f = httpFixture(() => response({ ...preview(), signature }));
    await expect(
      createTaskFileHttp(f.request).previewTaskInputImport(options),
    ).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
  });
  it('保留后端行级失败，不伪造可应用输入', async () => {
    const issues = [
      {
        objectId: 'D1',
        field: 'devices',
        message: '端点设备不属于节点',
        sheet: 'task_links',
        row: 3,
      },
    ];
    const f = httpFixture(() => response({ ...preview(), input: null, issues }));
    const result = await createTaskFileHttp(f.request).previewTaskInputImport(options);
    expect(result.input).toBeNull();
    expect(result.issues).toEqual(issues);
  });
  it.each([
    { existing: true, taskRevision: null },
    { existing: false, taskRevision: 'saved' },
  ])('既有任务版本不能与existing矛盾', async (change) => {
    const f = httpFixture(() => response({ ...preview(), ...change }));
    await expect(
      createTaskFileHttp(f.request).previewTaskInputImport(options),
    ).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
  });
  it('拒绝预检成功却缺输入、失败却带可应用输入及伪行号', async () => {
    for (const change of [
      { input: null },
      { issues: [{ objectId: 'D1', field: 'id', message: 'bad' }] },
      { input: null, issues: [{ objectId: 'D1', field: 'id', message: 'bad', row: 1.5 }] },
    ]) {
      const f = httpFixture(() => response({ ...preview(), ...change }));
      await expect(
        createTaskFileHttp(f.request).previewTaskInputImport(options),
      ).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
    }
  });
  it('空文件/路径名/非有限输入在发请求前失败', async () => {
    const f = httpFixture(() => response(preview())),
      service = createTaskFileHttp(f.request);
    for (const file of [
      { name: 'empty.xlsx', bytes: new Uint8Array() },
      { name: '../file.xlsx', bytes: new Uint8Array([1]) },
    ])
      await expect(service.previewTaskInputImport({ ...options, files: [file] })).rejects.toThrow();
    const value = input();
    value.bbox[0] = NaN;
    await expect(
      service.previewTaskInputImport({ ...options, input: value }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.calls).toEqual([]);
  });
  it('成功响应中无效的候选不能冒充本地输入拒绝', async () => {
    const value = preview(); value.input.demands[0].requiredRateKbps = 0;
    const f = httpFixture(() => response(value));
    await expect(createTaskFileHttp(f.request).previewTaskInputImport(options)).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
  });
  it('后端冲突/权限失败不回退本地解析', async () => {
    for (const [code, status] of [
      [1205, 409],
      [1104, 403],
    ]) {
      const f = httpFixture(() => response(null, code, status));
      await expect(
        createTaskFileHttp(f.request).previewTaskInputImport(options),
      ).rejects.toMatchObject({ code: code === 1104 ? 'FORBIDDEN' : code, status });
      expect(f.calls.filter(row => !row.path.includes('/auth/'))).toHaveLength(1);
    }
  });
  it('模板从后端下载并核对CSV表头/UTF8/XLSX文件头', async () => {
    for (const format of ['csv', 'xlsx'] as const) {
      const mime =
        format === 'csv'
          ? 'text/csv;charset=utf-8'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const data =
        format === 'csv'
          ? new TextEncoder().encode('demand_id,task_id,src_node_id\r\n')
          : new Uint8Array([80, 75, 3, 4]);
      const f = httpFixture(
        () => new Response(Uint8Array.from(data).buffer, { headers: { 'Content-Type': mime, 'Content-Disposition': 'attachment; filename="task-file"' } }),
      );
      const result = await createTaskFileHttp(f.request).getTaskInputTemplate({
        context: 'planning',
        format,
        kind: 'task_links',
        input: input(),
      });
      expect(result.bytes).toEqual(data);
      expect(f.calls.at(-1)!.path).toBe('/api/v1/task-files/template');
      expect(JSON.parse(String(f.calls.at(-1)!.init.body))).toMatchObject({
        context: 'planning',
        format,
        kind: 'task_links',
      });
    }
  });
  it('错误模板MIME、空文件与假CSV不能成为成功下载', async () => {
    for (const file of [
      new Response('bad', { headers: { 'Content-Type': 'text/csv' } }),
      new Response('', { headers: { 'Content-Type': 'text/csv' } }),
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    ]) {
      const f = httpFixture(() => file);
      await expect(
        createTaskFileHttp(f.request).getTaskInputTemplate({
          context: 'planning',
          format: 'csv',
          input: input(),
        }),
      ).rejects.toThrow();
    }
  });
});
