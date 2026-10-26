import { describe, expect, it } from 'vitest';
import { createPlanningHttp } from '../src/services/planning-http';
import { createGisFrozenPlanWorkspace } from '../src/stores/gis-frozen-plan';
import { httpFixture, response } from './fixtures/planning-api';

const row = () => ({ plan_id: 'P1', task_id: 'T1', name: '冻结方案', version: 'V1', state: 'SAVED',
  current: false, source_changed: false, saved_at: '2026-10-23T00:00:00Z' });
const dto = (items: unknown[] = [row()]) => ({ items, total: items.length, page: 1, page_size: 10, data_origin: 'SYNTHETIC_INTEGRATION' });
const input = { context: 'planning' as const, pageNum: 1, pageSize: 10 };
describe('已保存方案历史 HTTP', () => {
  it.each(['planning', 'gis'] as const)('摘要请求原样传送 %s 上下文及筛选，保留状态与保存时间', async context => {
    const f = httpFixture(() => response(dto())), service = createPlanningHttp(f.request, () => '/api/v1');
    const result = await service.querySavedPlanningPlans({ ...input, context, state: 'SAVED', search: '冻结' });
    expect(result.items[0]).toEqual({ id: 'P1', taskId: 'T1', name: '冻结方案', version: 'V1', state: 'SAVED',
      current: false, sourceChanged: false, savedAt: '2026-10-23T00:00:00Z' });
    const call = f.calls.find(c => c.path.includes('/plan/saved-plans'))!;
    expect(Object.fromEntries(new URL(call.path, 'http://local').searchParams)).toEqual({ context, state: 'SAVED', search: '冻结', page: '1', page_size: '10' });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });
  it('GIS工作区通过真实HTTP适配器查询目录，不改写为planning', async () => {
    const f = httpFixture(() => response(dto())), service = createPlanningHttp(f.request, () => '/api/v1');
    const workspace = createGisFrozenPlanWorkspace({ plans: {} as never, queryPlans: service.querySavedPlanningPlans });
    await workspace.queryPlans({ pageNum: 1, pageSize: 10, state: 'SAVED' });
    expect(workspace.listError.value).toBe('');
    expect(workspace.catalog.value?.items[0].id).toBe('P1');
    const call = f.calls.find(c => c.path.includes('/plan/saved-plans'))!;
    expect(new URL(call.path, 'http://local').searchParams.get('context')).toBe('gis');
  });
  it('空目录直接返回，不注入旧前端快照', async () => {
    const f = httpFixture(() => response(dto([])));
    expect((await createPlanningHttp(f.request, () => '/api/v1').querySavedPlanningPlans(input)).items).toEqual([]);
  });
  it.each([{ state: 'OTHER' }, { saved_at: '2026-10-23' }, { current: true }, { state: 'CONFIRMED', current: true, source_changed: true }, { source_changed: null }, { task_id: '' }])('非法摘要拒绝 %j', async patch => {
    const f = httpFixture(() => response(dto([{ ...row(), ...patch }])));
    await expect(createPlanningHttp(f.request, () => '/api/v1').querySavedPlanningPlans(input)).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
  });
  it('拒绝来源缺失、重复身份、筛选未生效和错误分页', async () => {
    for (const data of [{ ...dto(), data_origin: undefined }, dto([row(), row()]), { ...dto(), page: 2 }]) {
      const f = httpFixture(() => response(data));
      await expect(createPlanningHttp(f.request, () => '/api/v1').querySavedPlanningPlans(input)).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
    }
    const f = httpFixture(() => response(dto()));
    await expect(createPlanningHttp(f.request, () => '/api/v1').querySavedPlanningPlans({ ...input, state: 'REFERENCE' })).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
  });
  it('非法输入在发送前拒绝；服务错误不回退本地数据', async () => {
    const f = httpFixture(() => response(null, 5002, 503)), service = createPlanningHttp(f.request, () => '/api/v1');
    for (const context of ['ledger', 'unknown', ''])
      await expect(service.querySavedPlanningPlans({ ...input, context: context as never })).rejects.toMatchObject({ code: 'INVALID_TASK_QUERY' });
    await expect(service.querySavedPlanningPlans({ ...input, search: 'a\nb' })).rejects.toMatchObject({ code: 'INVALID_TASK_QUERY' });
    expect(f.calls).toHaveLength(0);
    await expect(service.querySavedPlanningPlans(input)).rejects.toMatchObject({ code: 5002, status: 503 });
  });
});
