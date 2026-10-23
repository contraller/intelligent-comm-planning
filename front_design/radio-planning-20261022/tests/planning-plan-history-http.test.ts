import { describe, expect, it } from 'vitest';
import { createPlanningHttp } from '../src/services/planning-http';
import { httpFixture, response } from './fixtures/planning-api';

const row = () => ({ plan_id: 'P1', task_id: 'T1', name: '冻结方案', version: 'V1', state: 'SAVED',
  current: false, source_changed: false, saved_at: '2026-10-23T00:00:00Z' });
const dto = (items: unknown[] = [row()]) => ({ items, total: items.length, page: 1, page_size: 10, data_origin: 'SYNTHETIC_INTEGRATION' });
const input = { context: 'planning' as const, pageNum: 1, pageSize: 10 };
describe('已保存方案历史 HTTP', () => {
  it('摘要请求传送筛选，保留明确状态与保存时间', async () => {
    const f = httpFixture(() => response(dto())), service = createPlanningHttp(f.request, () => '/api/v1');
    const result = await service.querySavedPlanningPlans({ ...input, state: 'SAVED', search: '冻结' });
    expect(result.items[0]).toEqual({ id: 'P1', taskId: 'T1', name: '冻结方案', version: 'V1', state: 'SAVED',
      current: false, sourceChanged: false, savedAt: '2026-10-23T00:00:00Z' });
    const call = f.calls.find(c => c.path.includes('/plan/saved-plans'))!;
    expect(Object.fromEntries(new URL(call.path, 'http://local').searchParams)).toMatchObject({ context: 'planning', state: 'SAVED', search: '冻结', page: '1', page_size: '10' });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
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
    await expect(service.querySavedPlanningPlans({ ...input, context: 'gis' })).rejects.toMatchObject({ code: 'INVALID_TASK_QUERY' });
    await expect(service.querySavedPlanningPlans({ ...input, search: 'a\nb' })).rejects.toMatchObject({ code: 'INVALID_TASK_QUERY' });
    expect(f.calls).toHaveLength(0);
    await expect(service.querySavedPlanningPlans(input)).rejects.toMatchObject({ code: 5002, status: 503 });
  });
});
