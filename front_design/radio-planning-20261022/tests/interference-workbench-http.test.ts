import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { createInterferenceWorkbenchHttp } from '../src/services/interference-workbench-http';
import { ApiError } from '../src/services/types';
import type { MeasurePreview, Operation, RunProgress, WorkbenchContext, WriteReceipt } from '../src/types/interference-workbench';

const hash = 'a'.repeat(64), stamp = '2026-10-23T08:00:00Z';
const body = () => ({ request_id: 'R1', task_id: 'T1', plan_id: 'P1', plan_version: 'V1', resource_revision: 'resource-1', scene_id: 'SC1', scene_version_id: 'SV1', snapshot_hash: hash });
const receipt = (operation: Operation = 'SUBMIT_ANALYSIS', object_type: WriteReceipt['object_type'] = 'RUN'): WriteReceipt => ({ request_id: 'R1', operation, actor_id: 'actual-user', task_id: 'T1', object_type,
  object_id: object_type === 'RUN' ? 'RUN1' : 'AD1', accepted_version: 1, changed: true, status: 'ACCEPTED', source_hash: hash, data_origin: 'SYNTHETIC_INTEGRATION', accepted_at: stamp });
const progress = (): RunProgress => ({ run_id: 'RUN1', task_id: 'T1', scene_id: 'SC1', scene_version_id: 'SV1', plan_id: 'P1', plan_version: 'V1', resource_revision: 'resource-1', run_version: 2,
  state: 'RUNNING', progress: 30, phase: '计算阶段', cancel_requested: false, error: null, source_hash: hash, source_state: { state: 'CURRENT', reasons: [] }, data_origin: 'SYNTHETIC_INTEGRATION', started_at: stamp, updated_at: stamp });
const context = (): WorkbenchContext => ({ task_id: 'T1', resource_revision: 'resource-1', source_options: [], scene_count: 0, run_count: 0, active_run_ids: [], data_origin: 'SYNTHETIC_INTEGRATION', interference_sources: [],
  capabilities: { scene_save: { enabled: false, reasons: ['没有来源'] }, analyze: { enabled: false, reasons: ['没有来源'] },
    cancel: { enabled: false, reasons: ['没有来源'] }, preview: { enabled: false, reasons: ['没有来源'] }, adopt_replan: { enabled: false, reasons: ['没有来源'] } } });
const preview = (): MeasurePreview => ({ run_id: 'RUN1', measure_id: 'CM1', run_version: 2, source_hash: hash, preview_hash: hash, before_configuration: {}, proposed_changes: {}, impact_after: null, metrics: null, available: true, unavailable_reasons: [] });
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(done => { resolve = done; }); return { promise, resolve }; }
function setup(result: unknown) { const transport = vi.fn(async (_path: string, _init?: RequestInit) => result); return { transport, api: createInterferenceWorkbenchHttp(transport as AuthenticatedRequest) }; }

describe('干扰工作流真实HTTP专用工厂', () => {
  it('提交受理不等于分析成功，发起body和核验共用副本', async () => {
    const pending = deferred(), transport = vi.fn((_path: string, _init?: RequestInit) => pending.promise), api = createInterferenceWorkbenchHttp(transport as AuthenticatedRequest), input = body();
    const request = api.submitRun(input); input.task_id = 'T2'; input.request_id = 'changed'; input.snapshot_hash = 'b'.repeat(64);
    pending.resolve(receipt()); expect((await request).status).toBe('ACCEPTED');
    expect(JSON.parse(transport.mock.calls[0]![1]!.body as string)).toEqual(body());
  });
  it('等待上下文时改写调用者task不会接受新任务解释旧响应', async () => {
    const pending = deferred(), transport = vi.fn((_path: string, _init?: RequestInit) => pending.promise), api = createInterferenceWorkbenchHttp(transport as AuthenticatedRequest), input = { task_id: 'T1' };
    const request = api.getContext(input); input.task_id = 'T2'; pending.resolve(context()); expect((await request).task_id).toBe('T1');
    expect(transport.mock.calls[0]![0]).toContain('task_id=T1');
  });
  it('进度和措施预览同样冻结发起身份及版本', async () => {
    const pending = deferred(), transport = vi.fn((_path: string, _init?: RequestInit) => pending.promise), api = createInterferenceWorkbenchHttp(transport as AuthenticatedRequest), input = { task_id: 'T1', run_id: 'RUN1' };
    const request = api.getProgress(input); input.run_id = 'RUN2'; pending.resolve(progress()); expect((await request).run_id).toBe('RUN1');
    const next = setup(preview()), query = { task_id: 'T1', run_id: 'RUN1', measure_id: 'CM1', expected_run_version: 2 };
    const value = next.api.getPreview(query); query.expected_run_version = 3; expect((await value).run_version).toBe(2);
  });
  it('真实错误不回退Mock，版本冲突保留原错误身份', async () => {
    const transport = vi.fn(async () => { throw new ApiError('版本变化', 1203); });
    await expect(createInterferenceWorkbenchHttp(transport as AuthenticatedRequest).submitRun(body())).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...body(), actor_id: 'admin' }, { ...body(), scene_id: '../x' }, { ...body(), plan_version: 'V0' }, { ...body(), snapshot_hash: 'unknown' }])('非法请求不发送 %j', async input => {
    const { api, transport } = setup(receipt()); await expect(api.submitRun(input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' }); expect(transport).not.toHaveBeenCalled();
  });
  it.each([{ ...progress(), run_id: 'other' }, { ...progress(), progress: 101 }, { ...progress(), state: 'CANCEL_REQUESTED', cancel_requested: false }, { ...progress(), progress: NaN }])('拒绝身份、状态或有限数错误 %j', async response => {
    await expect(setup(response).api.getProgress({ task_id: 'T1', run_id: 'RUN1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('未知全网指标保持null，拒绝伪造有限数或缺失字段', async () => {
    expect((await setup(preview()).api.getPreview({ task_id: 'T1', run_id: 'RUN1', measure_id: 'CM1', expected_run_version: 2 })).metrics).toBeNull();
    for (const metrics of [undefined, 100, { coverage: NaN }]) await expect(setup({ ...preview(), metrics }).api.getPreview({ task_id: 'T1', run_id: 'RUN1', measure_id: 'CM1', expected_run_version: 2 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('分页捕获独立期望，拒绝不完整空页', async () => {
    const input = { task_id: 'T1', page: 2, page_size: 20 }, pending = deferred(), transport = vi.fn((_path: string, _init?: RequestInit) => pending.promise), api = createInterferenceWorkbenchHttp(transport as AuthenticatedRequest);
    const request = api.listSources(input); input.page = 1; pending.resolve({ items: [], total: 0, page: 2, page_size: 20 }); expect((await request).page).toBe(2);
    await expect(setup({ items: [], total: 1, page: 1, page_size: 20 }).api.listSources({ task_id: 'T1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('采纳回执必须关联子请求，不得把缺方案的成功对象当已生成', async () => {
    const value = { ...receipt('ADOPT_MEASURE', 'ADOPTION'), adoption_id: 'AD1', planning_request_id: 'child-key', planning_job_id: null, plan_id: null };
    const input = { ...body(), run_id: 'RUN1', measure_id: 'CM1', expected_run_version: 2 }; const { scene_id: unused, ...adopt } = input;
    expect((await setup(value).api.adoptMeasure(adopt)).planning_job_id).toBeNull();
    await expect(setup({ ...value, adoption_id: 'wrong' }).api.adoptMeasure(adopt)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('子规划进度使用明确百分比且拒绝越界值', async () => {
    const value = { adoption_id: 'AD1', task_id: 'T1', run_id: 'RUN1', measure_id: 'CM1', adoption_version: 2,
      state: 'RUNNING', source_hash: hash, source_state: { state: 'CURRENT', reasons: [] }, planning_request_id: 'child-key',
      planning_job_id: 'JOB1', planning_state: 'RUNNING', planning_progress: 25, result_plan_id: null, result_plan_state: null,
      error: null, data_origin: 'SYNTHETIC_INTEGRATION', created_at: stamp, updated_at: stamp };
    expect((await setup(value).api.getAdoption({ task_id: 'T1', adoption_id: 'AD1' })).planning_progress).toBe(25);
    await expect(setup({ ...value, planning_progress: 125 }).api.getAdoption({ task_id: 'T1', adoption_id: 'AD1' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
