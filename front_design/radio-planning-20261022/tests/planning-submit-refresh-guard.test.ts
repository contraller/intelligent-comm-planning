import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposePinia } from 'pinia';
import { nextTick } from 'vue';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { previewService } from '../src/services';
import { apiJob, readNode, storeFixture } from './fixtures/planning-api';

const sessions: Awaited<ReturnType<typeof storeFixture>>[] = [];
async function setup() {
  const fixture = await storeFixture(); sessions.push(fixture);
  const planning = usePlanningApiStore(); await nextTick();
  expect(planning.canSubmit).toBe(true);
  return { ...fixture, planning };
}
afterEach(() => {
  for (const fixture of sessions.splice(0)) { usePlanningApiStore().clearForSession(); fixture.task.clearForSession(); disposePinia(fixture.pinia); }
  vi.restoreAllMocks();
});

describe('规划提交与任务资源刷新竞态', () => {
  it.each(['referencesRefreshing', 'busy', 'loading'] as const)('任务%s时动作出口拒绝提交，结束后可恢复', async key => {
    const { task, planning } = await setup(), submit = vi.mocked(previewService.submitPlanningReceipt);
    task[key] = true;
    expect(planning.canSubmit).toBe(false); await planning.submit();
    expect(submit).not.toHaveBeenCalled(); expect(planning.pending).toBeNull();
    task[key] = false; expect(planning.canSubmit).toBe(true);
  });
  it('共享GIS资源已更新而任务尚未采纳时，不能提交旧版的干净任务', async () => {
    const { task, resources, planning } = await setup(), submit = vi.mocked(previewService.submitPlanningReceipt);
    resources.workspace!.revision = 'r2';
    expect(task.dirty).toBe(false); expect(task.resourceStale).toBe(true);
    expect(planning.canSubmit).toBe(false); await planning.submit();
    expect(submit).not.toHaveBeenCalled(); expect(task.resourceRevision).toBe('r1');
    expect(task.saved!.resourceRevision).toBe('r1');
    resources.workspace!.revision = 'r1'; expect(planning.canSubmit).toBe(true);
  });
  it('只读版本列表不影响任务输入，读取期间仍可提交同版任务', async () => {
    const { planning } = await setup(), submit = vi.mocked(previewService.submitPlanningReceipt);
    vi.spyOn(previewService, 'submitPlanningTask').mockResolvedValue(apiJob());
    let finish!: (page: Awaited<ReturnType<typeof previewService.queryPlanningPlanSummaries>>) => void;
    vi.mocked(previewService.queryPlanningPlanSummaries).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const read = planning.loadPlans();
    expect(planning.loading).toBe(true); expect(planning.canSubmit).toBe(true);
    await planning.submit(); expect(submit).toHaveBeenCalledOnce();
    const submittedJob=planning.job?.id; expect(submittedJob).toBeTruthy();
    finish({ items: [], pageNum: 1, pageSize: 10, total: 0 }); await read;
    expect(planning.loading).toBe(false); expect(planning.job?.id).toBe(submittedJob);
  });
  it('同版真实引用刷新在途时不夹入规划提交，引用回读后恢复且原任务不变', async () => {
    const { task, resources, planning } = await setup(), submit = vi.mocked(previewService.submitPlanningReceipt);
    const before = JSON.stringify(task.saved);
    vi.spyOn(previewService, 'loadResourceReadContext').mockResolvedValue({ ...resources.workspace! });
    vi.spyOn(previewService, 'queryResourceMap').mockImplementation(async query => ({ revision: query.revision,
      bbox: query.bbox, zoom: query.zoom, points: [], clusters: [], totalNodes: 2, totalInterferences: 0 }));
    let finish!: (value: Awaited<ReturnType<typeof previewService.getResourceObject>>) => void;
    vi.mocked(previewService.getResourceObject).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refresh = task.refreshResources();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(task.referencesRefreshing).toBe(true); expect(task.dirty).toBe(false); expect(task.resourceStale).toBe(false);
    expect(planning.canSubmit).toBe(false); await planning.submit(); expect(submit).not.toHaveBeenCalled();
    finish({ revision: 'r1', object: readNode('N1'), model: null, antenna: null });
    expect(await refresh).toBe(true); expect(task.referencesRefreshing).toBe(false);
    expect(planning.canSubmit).toBe(true); expect(JSON.stringify(task.saved)).toBe(before);
  });
});
