import { describe, expect, it } from 'vitest';
import { createPlanningHttp } from '../src/services/planning-http';
import { httpFixture, response } from './fixtures/planning-api';

const history = (items: unknown[] = []) => ({
  items, total: items.length, page: 1, page_size: 10,
  data_origin: 'SYNTHETIC_INTEGRATION',
});
const job = {
  job_id: 'J1', task_id: 'T1', name: '冻结任务',
  created_at: '2026-10-22T09:01:00+00:00', status: 'SUCCESS',
};

describe('规划作业历史 HTTP 适配', () => {
  it.skipIf(!process.env.PLANNING_HISTORY_INTEGRATION_URL)('经真实 Vite 代理读取构造联调作业', async () => {
    const base = process.env.PLANNING_HISTORY_INTEGRATION_URL!;
    const f = httpFixture((path, init) => fetch(new URL(path, base), init), 15000);
    const service = createPlanningHttp(f.request, () => '/api/v1');
    const result = await service.queryPlanningJobs({
      context: 'planning', pageNum: 1, pageSize: 5,
    });
    expect(result.total).toBeGreaterThan(0);
    expect(result.items.every(item => item.id && item.taskId && item.name && item.startedAt)).toBe(true);
    const first = result.items[0]!;
    const detail = await service.getPlanningTask({ context: 'planning', jobId: first.id, taskId: first.taskId });
    expect(detail.id).toBe(first.id);
    expect(detail.taskId).toBe(first.taskId);
  });

  it('查询后转换持久化摘要，保留页码与筛选条件', async () => {
    const f = httpFixture(() => response(history([job])));
    const result = await createPlanningHttp(f.request, () => '/api/v1').queryPlanningJobs({
      context: 'planning', pageNum: 1, pageSize: 10, search: '冻结',
    });
    expect(result.items).toEqual([{
      id: 'J1', taskId: 'T1', name: '冻结任务',
      startedAt: '2026-10-22T09:01:00+00:00', state: 'SUCCESS',
    }]);
    expect(result.total).toBe(1);
    expect(f.calls.some(call => call.path.includes('/plan/jobs?context=planning&page=1&page_size=10&search='))).toBe(true);
  });

  it('空页和无效输入分别返回明确结果或错误', async () => {
    const f = httpFixture(() => response(history()));
    const service = createPlanningHttp(f.request, () => '/api/v1');
    expect((await service.queryPlanningJobs({ context: 'planning', pageNum: 1, pageSize: 10 })).items).toEqual([]);
    await expect(service.queryPlanningJobs({ context: 'gis', pageNum: 1, pageSize: 10 })).rejects.toMatchObject({ code: 'INVALID_TASK_QUERY' });
    await expect(service.queryPlanningJobs({ context: 'planning', pageNum: 0, pageSize: 10 })).rejects.toMatchObject({ code: 'INVALID_TASK_QUERY' });
  });

  it('拒绝无来源标记、错误时间、重复作业与不一致分页', async () => {
    for (const bad of [
      { ...history([job]), data_origin: undefined },
      history([{ ...job, created_at: '2026-10-22' }]),
      { ...history([job, job]), total: 2 },
      { ...history([job]), page: 2 },
    ]) {
      const f = httpFixture(() => response(bad));
      await expect(createPlanningHttp(f.request, () => '/api/v1').queryPlanningJobs({
        context: 'planning', pageNum: 1, pageSize: 10,
      })).rejects.toMatchObject({ code: 'INVALID_PLANNING_RESPONSE' });
    }
  });

  it('后端参数拒绝按业务错误透传', async () => {
    const f = httpFixture(() => response(null, 1001, 422));
    await expect(createPlanningHttp(f.request, () => '/api/v1').queryPlanningJobs({
      context: 'planning', pageNum: 1, pageSize: 10,
    })).rejects.toMatchObject({ code: 1001 });
  });
});
