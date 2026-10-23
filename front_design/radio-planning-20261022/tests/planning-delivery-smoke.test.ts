import { beforeAll, describe, expect, it } from 'vitest';
import { createAuthHttp } from '../src/services/auth-http';
import { createPlanningHttp } from '../src/services/planning-http';
import { createResourceReadHttp } from '../src/services/resource-read-http';
import { createTaskHttp } from '../src/services/task-http';
import type { ApiTask } from '../src/types/task-api';
import type { PlanningCatalog } from '../src/types/planning-api';
import { loadTerrainBasemap } from '../src/services/terrain-basemap';

const liveUrl = process.env.PLANNING_DELIVERY_URL;

// 本组会创建任务并运行真实算法，只在显式指定的本机隔离服务上执行。
describe.skipIf(!liveUrl)('新版前端交付流程真实 HTTP 冒烟', () => {
  let tasks: ReturnType<typeof createTaskHttp>;
  let planning: ReturnType<typeof createPlanningHttp>;
  let catalog: PlanningCatalog;
  let resourceRevision: string;

  beforeAll(async () => {
    const base = new URL(liveUrl!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
      || process.env.PLANNING_DELIVERY_ISOLATED !== '1') {
      throw new Error('请使用项目内隔离数据库启动本机服务，并设置 PLANNING_DELIVERY_ISOLATED=1');
    }
    const fetcher: typeof fetch = (input, init) => fetch(new URL(input instanceof Request ? input.url : String(input), base), init);
    const auth = createAuthHttp({ baseUrl: () => '/api/v1', origin: () => base.origin, fetcher, timeoutMs: 30000 });
    expect((await auth.getSession())?.permissions).toEqual(expect.arrayContaining(['planning.execute', 'planning.save', 'planning.confirm']));
    tasks = createTaskHttp(auth.authenticatedRequest);
    planning = createPlanningHttp(auth.authenticatedRequest, () => '/api/v1');
    const resources = createResourceReadHttp({ baseUrl: () => '/api/v1', origin: () => base.origin, fetcher, timeoutMs: 30000 });
    const workspace = await resources.loadResourceReadContext({ context: 'planning' });
    resourceRevision = workspace.revision;
    // 从同源静态服务实际读取并校验图片字节，不以本地文件校验代替部署验证。
    const terrain = await loadTerrainBasemap(workspace.terrain, fetcher, '/');
    expect(terrain.extent).toEqual(workspace.terrain?.bounds);
    terrain.dispose();
    catalog = await planning.loadPlanningCatalog({ context: 'planning' });
    expect(catalog.presets.length).toBeGreaterThan(0);
  }, 60000);

  async function saveNewTask(label: string): Promise<ApiTask> {
    const taskId = 'delivery-' + crypto.randomUUID();
    const input = structuredClone(catalog.presets[0]!.defaults);
    input.name = `交付冒烟-${label}-${taskId.slice(-8)}`;
    input.description = '构造联调数据，非生产、非实测；交付流程测试保留记录。';
    const request = { context: 'planning' as const, taskId, revision: null, resourceRevision, input };
    const checked = await tasks.validateTaskInputApi(request);
    expect(checked.valid).toBe(true);
    expect(checked.task).toBeNull();
    return tasks.saveTaskInput({ ...request, requestId: crypto.randomUUID() });
  }

  it('保存、列表、回读及版本冲突均由真实服务响应', async () => {
    const first = await saveNewTask('版本回读');
    const requestId = crypto.randomUUID();
    const input = { ...first.input, name: first.input.name + '-改名' };
    const request = { context: 'planning' as const, taskId: first.taskId, revision: first.revision,
      resourceRevision, input, requestId };
    const updated = await tasks.saveTaskInput(request);
    expect(updated.revision).not.toBe(first.revision);
    expect(updated.conditionVersion).toBe(first.conditionVersion);
    expect((await tasks.saveTaskInput(request)).revision).toBe(updated.revision);
    const detail = await tasks.getTaskInput({ context: 'planning', taskId: first.taskId });
    expect(detail).toEqual(updated);
    const page = await tasks.queryTaskInputs({ context: 'planning', pageNum: 1, pageSize: 10, search: first.taskId });
    expect(page.items.map(row => row.taskId)).toEqual([first.taskId]);
    expect(page.items[0]!.input.name).toBe(input.name);
    expect((await tasks.getPlanningOperation({ context: 'planning', taskId: first.taskId, requestId, kind: 'saveTask' })).state).toBe('SUCCEEDED');
    await expect(tasks.saveTaskInput({ ...request, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: 1203, status: 409 });
    await expect(tasks.validateTaskInputApi({ ...request, revision: updated.revision,
      resourceRevision: 'stale-delivery-resource' })).rejects.toMatchObject({ code: 1205, status: 409 });
  }, 60000);

  it('提交冻结输入、轮询 SR4、保存回读并确认正式方案', async () => {
    const saved = await saveNewTask('规划计算');
    const request = { context: 'planning' as const, taskId: saved.taskId, revision: saved.revision,
      inputVersion: saved.inputVersion, conditionVersion: saved.conditionVersion,
      resourceRevision: saved.resourceRevision, parentPlanId: null, requestId: crypto.randomUUID() };
    let job = await planning.submitPlanningTask(request);
    expect((await planning.submitPlanningTask(request)).id).toBe(job.id);
    const startedAt = Date.now();
    let previousState = '';
    while (['PENDING', 'RUNNING'].includes(job.state) && Date.now() - startedAt < 300000) {
      if (job.state !== previousState) {
        console.info('SR4', job.id, job.state);
        previousState = job.state;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = await planning.getPlanningTask({ context: 'planning', taskId: saved.taskId, jobId: job.id });
    }
    expect(job.state, job.error ?? 'SR4 未在 300 秒内完成').toBe('SUCCESS');
    expect(job.input).toEqual(saved.input);
    expect(job.result?.nodes.length).toBeGreaterThan(0);
    expect(job.result?.links.length).toBeGreaterThan(0);
    expect(job.outcome?.code, '本构造预设需产生可确认方案；不得放宽硬约束').toBe(0);
    const history = await planning.queryPlanningJobs({ context: 'planning', pageNum: 1, pageSize: 10, search: saved.taskId });
    expect(history.items).toEqual([{ id: job.id, taskId: saved.taskId, name: saved.input.name,
      startedAt: history.items[0]!.startedAt, state: 'SUCCESS' }]);
    expect((await tasks.getTaskInput({ context: 'planning', taskId: saved.taskId })).activeJobId).toBe(job.id);
    const saveRequest = { context: 'planning' as const, taskId: saved.taskId, revision: saved.revision,
      jobId: job.id, name: saved.input.name, note: '构造联调，非生产、非实测', requestId: crypto.randomUUID() };
    const plan = await planning.savePlanningPlan(saveRequest);
    expect(plan.state).toBe('SAVED');
    expect((await planning.querySavedPlanningPlans({ context: 'planning', pageNum: 1, pageSize: 10, search: plan.id, state: 'SAVED' })).items.map(row => row.id)).toEqual([plan.id]);
    expect((await planning.savePlanningPlan(saveRequest)).id).toBe(plan.id);
    expect(await planning.getPlanningPlan({ context: 'planning', taskId: saved.taskId, planId: plan.id })).toEqual(plan);
    expect((await planning.queryPlanningPlans({ context: 'planning', taskId: saved.taskId, pageNum: 1, pageSize: 10 })).items.map(row => row.id)).toContain(plan.id);
    const confirmRequest = { context: 'planning' as const, taskId: saved.taskId, planId: plan.id,
      revision: plan.revision, requestId: crypto.randomUUID() };
    const confirmed = await planning.confirmPlanningPlan(confirmRequest);
    expect(confirmed).toMatchObject({ state: 'CONFIRMED', current: true, id: plan.id });
    const savedHistory = await planning.querySavedPlanningPlans({ context: 'planning', pageNum: 1, pageSize: 10, search: plan.id, state: 'CONFIRMED' });
    expect(savedHistory.items[0]).toMatchObject({ id: plan.id, taskId: saved.taskId, state: 'CONFIRMED', current: true });
    expect((await planning.querySavedPlanningPlans({ context: 'planning', pageNum: 1, pageSize: 10, search: plan.id, state: 'SAVED' })).total).toBe(0);
    expect((await planning.getPlanningPlan({ context: 'planning', taskId: savedHistory.items[0]!.taskId, planId: savedHistory.items[0]!.id })).result.snapshotId).toBe(plan.result.snapshotId);
    expect((await planning.confirmPlanningPlan(confirmRequest)).revision).toBe(confirmed.revision);
    expect(await planning.getPlanningPlan({ context: 'planning', taskId: saved.taskId, planId: plan.id })).toEqual(confirmed);
    // revision 是冻结输入版本；确认状态变更不生成新的输入版本。
    expect((await planning.confirmPlanningPlan({ ...confirmRequest, requestId: crypto.randomUUID() })).id).toBe(confirmed.id);
    await expect(planning.confirmPlanningPlan({ ...confirmRequest, revision: 'stale-delivery-revision', requestId: crypto.randomUUID() })).rejects.toMatchObject({ status: 409, code: 1203 });
    console.info('SR4_RESULT', JSON.stringify({ taskId: saved.taskId, jobId: job.id,
      outcome: job.outcome?.code, nodes: job.result?.nodes.length, links: job.result?.links.length,
      planId: plan.id, state: confirmed.state }));
  }, 360000);
});
