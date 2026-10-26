import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { createResourceResetHttp } from '../src/services/resource-reset-http';
import { ApiError } from '../src/services/types';

const initial = 'resource-0000000000000000';
const base = 'resource-1111111111111111';
const next = 'resource-2222222222222222';
const input = () => ({ baseRevision: base, requestId: 'reset-stable-request-1' });

function receipt(changed = true) {
  return { objectId: 'resource-reset', changed, revision: changed ? next : base,
    readRevision: changed ? next : base, affectedIds: changed ? ['D1', 'N1'] : [], warnings: [],
    restoredFromRevision: initial };
}
function service(value: unknown = receipt()) {
  const request = vi.fn<AuthenticatedRequest>().mockResolvedValue(value);
  const stub: AuthenticatedRequest = <T>(...args: Parameters<AuthenticatedRequest>) => request(...args) as Promise<T>;
  return { request, api: createResourceResetHttp(stub) };
}
function body(call: Parameters<AuthenticatedRequest>) {
  return JSON.parse(String(call[1]?.body));
}

describe('资源恢复 HTTP 请求桩契约', () => {
  it('只 POST 明确的版本与原请求号，不注入身份、资源或删除选项', async () => {
    const s = service();
    const submitted = Object.freeze(input());
    const result = await s.api.resetResourceData(submitted);
    expect(s.request).toHaveBeenCalledTimes(1);
    expect(s.request.mock.calls[0][0]).toBe('/resource/reset');
    expect(s.request.mock.calls[0][1]).toEqual({ method: 'POST',
      body: JSON.stringify({ base_revision: base, request_id: submitted.requestId }) });
    expect(result).toEqual({ objectId: 'resource-reset', changed: true, revision: next,
      readRevision: next, affectedIds: ['D1', 'N1'], warnings: [] });
  });

  it('接受初始 noop 及已恢复后版本不变的 noop，不把 restoredFromRevision 当当前版本', async () => {
    const s = service(receipt(false));
    expect(await s.api.resetResourceData(input())).toEqual({ objectId: 'resource-reset', changed: false,
      revision: base, readRevision: base, affectedIds: [], warnings: [] });
    const value = { ...receipt(false), restoredFromRevision: base };
    expect(await service(value).api.resetResourceData(input())).toMatchObject({ changed: false, revision: base });
  });

  it('原请求重复提交保持完全相同的请求体和回执', async () => {
    const s = service();
    const first = await s.api.resetResourceData(input());
    expect(await s.api.resetResourceData(input())).toEqual(first);
    expect(s.request.mock.calls.map(body)).toEqual([
      { base_revision: base, request_id: 'reset-stable-request-1' },
      { base_revision: base, request_id: 'reset-stable-request-1' },
    ]);
  });

  it('超时不自动重发；调用方重试使用同一版本和 requestId', async () => {
    const s = service();
    const failure = new ApiError('恢复超时', 'REQUEST_TIMEOUT', { pending: true }, 'trace-timeout', 504);
    s.request.mockRejectedValueOnce(failure);
    await expect(s.api.resetResourceData(input())).rejects.toBe(failure);
    expect(s.request).toHaveBeenCalledTimes(1);
    await expect(s.api.resetResourceData(input())).resolves.toMatchObject({ revision: next });
    expect(s.request.mock.calls[0]).toEqual(s.request.mock.calls[1]);
  });

  it('响应按发起时版本解释，后续页面修改不改变已提交请求', async () => {
    let resolve: (value: unknown) => void = () => {};
    const s = service();
    s.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }) as ReturnType<AuthenticatedRequest>);
    const submitted = input();
    const pending = s.api.resetResourceData(submitted);
    submitted.baseRevision = next;
    submitted.requestId = 'later-page-request';
    resolve(receipt());
    await expect(pending).resolves.toMatchObject({ changed: true, revision: next });
    expect(body(s.request.mock.calls[0])).toEqual({ base_revision: base, request_id: 'reset-stable-request-1' });
  });

  it.each([
    ['undefined', undefined], ['null', null], ['array', []], ['string', 'reset'],
    ['missing request', { baseRevision: base }],
    ['missing revision', { requestId: 'reset-1' }],
    ['empty request', { ...input(), requestId: '' }],
    ['number request', { ...input(), requestId: 7 }],
    ['space request', { ...input(), requestId: 'has space' }],
    ['control request', { ...input(), requestId: 'control\n' }],
    ['long request', { ...input(), requestId: 'x'.repeat(121) }],
    ['null revision', { ...input(), baseRevision: null }],
    ['latest revision', { ...input(), baseRevision: 'latest' }],
    ['short revision', { ...input(), baseRevision: 'resource-111' }],
    ['uppercase revision', { ...input(), baseRevision: 'resource-AAAAAAAAAAAAAAAA' }],
    ['actor injection', { ...input(), actor_id: 'admin' }],
    ['delete injection', { ...input(), hard_delete: true }],
    ['force injection', { ...input(), force: true }],
    ['snapshot injection', { ...input(), restoreFrom: {} }],
    ['context injection', { ...input(), context: 'gis' }],
    ['undefined extra', { ...input(), extra: undefined }],
  ])('发送前拒绝非法输入：%s', async (_name, value) => {
    const s = service();
    await expect(s.api.resetResourceData(value as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.request).not.toHaveBeenCalled();
  });

  it.each(['inherited', 'class'])('严格请求必须为含自有字段的普通对象：%s', async kind => {
    class ResetInput { baseRevision = base; requestId = 'reset-stable-request-1'; }
    const value = kind === 'inherited' ? Object.create(input()) : new ResetInput();
    const s = service();
    await expect(s.api.resetResourceData(value)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(s.request).not.toHaveBeenCalled();
  });

  it.each(['objectId', 'changed', 'revision', 'readRevision', 'affectedIds', 'warnings', 'restoredFromRevision'])(
    '回执不得缺少字段：%s', async field => {
      const value: Record<string, unknown> = receipt();
      delete value[field];
      await expect(service(value).api.resetResourceData(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    });

  it.each([
    ['wrong object', { objectId: 'other-resource' }],
    ['nonboolean changed', { changed: 1 }],
    ['null changed', { changed: null }],
    ['invalid revision', { revision: 'latest' }],
    ['different read revision', { readRevision: base }],
    ['changed with old revision', { revision: base, readRevision: base }],
    ['noop with new revision', { changed: false, affectedIds: [] }],
    ['invalid restored revision', { restoredFromRevision: 'resource-bad' }],
    ['null restored revision', { restoredFromRevision: null }],
    ['duplicate affected IDs', { affectedIds: ['D1', 'D1'] }],
    ['nonarray affected IDs', { affectedIds: 'D1' }],
    ['invalid affected ID', { affectedIds: [null] }],
    ['nonarray warnings', { warnings: {} }],
    ['invalid warning', { warnings: [{ objectId: '', field: 'reset', message: '' }] }],
    ['extra field', { deletedAll: true }],
  ])('拒绝不完整或矛盾回执：%s', async (_name, patch) => {
    const s = service({ ...receipt(), ...patch });
    await expect(s.api.resetResourceData(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    expect(s.request).toHaveBeenCalledTimes(1);
  });

  it('noop 回执不得声称存在受影响对象', async () => {
    const s = service({ ...receipt(false), affectedIds: ['D1'] });
    await expect(s.api.resetResourceData(input())).rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
    expect(s.request).toHaveBeenCalledTimes(1);
  });

  it('保留合法警告内容，不接受再次嵌套 envelope 作为 data', async () => {
    const warning = { objectId: 'D1', field: 'reset', message: '历史记录保留', sheet: 'devices', row: 2 };
    const s = service({ ...receipt(), warnings: [warning] });
    expect((await s.api.resetResourceData(input())).warnings).toEqual([warning]);
    await expect(service({ code: 0, message: 'success', data: receipt() }).api.resetResourceData(input()))
      .rejects.toMatchObject({ code: 'INVALID_RESOURCE_RESPONSE' });
  });

  it.each([
    [1001, 'VALIDATION_ERROR', 422], [1002, 'RESOURCE_NOT_FOUND', 404],
    [1205, 'RESOURCE_VERSION_CHANGED', 409], [1206, 'REQUEST_CONFLICT', 409],
    ['FORBIDDEN', 'FORBIDDEN', 403], ['CSRF_REJECTED', 'CSRF_REJECTED', 403],
    ['SESSION_REPLACED', 'SESSION_REPLACED', 409], ['AUTH_REQUIRED', 'AUTH_REQUIRED', 401],
    ['REQUEST_TIMEOUT', 'REQUEST_TIMEOUT', 504], [5002, 5002, 503],
  ] as const)('错误 %s 保留业务信息、追踪号和状态，且不自动重发', async (code, expected, status) => {
    const failure = new ApiError('明确拒绝恢复', code, { retained: true }, 'reset-trace-1', status);
    const s = service();
    s.request.mockRejectedValue(failure);
    await expect(s.api.resetResourceData(input())).rejects.toMatchObject({ code: expected, status,
      requestId: 'reset-trace-1', data: { retained: true }, message: '明确拒绝恢复' });
    expect(s.request).toHaveBeenCalledTimes(1);
  });

  it('保留传输异常，不返回本地恢复成功', async () => {
    const failure = new TypeError('connection lost');
    const s = service();
    s.request.mockRejectedValue(failure);
    await expect(s.api.resetResourceData(input())).rejects.toBe(failure);
    expect(s.request).toHaveBeenCalledTimes(1);
  });
});
