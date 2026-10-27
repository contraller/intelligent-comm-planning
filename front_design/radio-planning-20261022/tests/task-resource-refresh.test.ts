import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposePinia } from 'pinia';
import { toRaw } from 'vue';
import { previewService } from '../src/services';
import { ApiError } from '../src/services/types';
import { apiTask, readNode, storeFixture } from './fixtures/planning-api';

const sessions: Awaited<ReturnType<typeof storeFixture>>[] = [];
async function setup() {
  const value = await storeFixture();
  sessions.push(value);
  vi.spyOn(previewService, 'loadResourceReadContext').mockImplementation(async () => ({
    ...value.resources.workspace!, revision: 'r2',
    stats: { ...value.resources.workspace!.stats, interferences: 1 },
  }));
  vi.spyOn(previewService, 'queryResourceMap').mockImplementation(async q => ({
    revision: q.revision, bbox: q.bbox, zoom: q.zoom, points: [], clusters: [],
    totalNodes: 2, totalInterferences: 0,
  }));
  vi.mocked(previewService.getResourceObject).mockImplementation(async q => ({
    revision: q.revision, object: readNode(q.id), model: null, antenna: null,
  }));
  return value;
}
afterEach(() => {
  for (const value of sessions.splice(0)) { value.task.clearForSession(); disposePinia(value.pinia); }
  vi.restoreAllMocks();
});

describe('GIS资源编辑后重新绑定旧任务', () => {
  it('显式刷新同时采用新版引用，保留草稿与旧保存快照，另存输入版本后恢复规划', async () => {
    const { task, resources } = await setup();
    const original = JSON.stringify(task.saved);
    task.draft!.description = '回到GIS前的未保存备注';
    // GIS编辑页已刷新共享资源，但任务仍引用旧版；再次刷新同版也必须更新任务。
    resources.workspace!.revision = 'r2';
    expect(task.resourceStale).toBe(true);
    expect(await task.refreshResources()).toBe(true);
    expect(task.resourceRevision).toBe('r2');
    expect(task.resourceStale).toBe(false);
    expect(task.draft!.description).toBe('回到GIS前的未保存备注');
    expect(JSON.stringify(task.saved)).toBe(original);
    expect(task.changed).toBe(true);
    expect(task.notice).toContain('请保存任务');
    expect(vi.mocked(previewService.getResourceObject).mock.calls.slice(-2).map(([q]) => q.revision)).toEqual(['r2', 'r2']);
    vi.mocked(previewService.saveTaskInput).mockImplementationOnce(async q => ({
      ...apiTask(), revision: 't2', inputVersion: 't2', resourceRevision: q.resourceRevision,
      input: structuredClone(toRaw(q.input)),
    }));
    expect(await task.save()).toBe(true);
    expect(vi.mocked(previewService.saveTaskInput).mock.calls.at(-1)![0]).toMatchObject({ revision: 't1', resourceRevision: 'r2' });
    expect(task.saved!.revision).toBe('t2');
    expect(task.changed).toBe(false);
  });

  it('未刷新前拒绝把旧任务写入当前资源，提示有可操作的刷新入口', async () => {
    const { task, resources } = await setup();
    resources.workspace!.revision = 'r2';
    const save = vi.mocked(previewService.saveTaskInput);
    expect(await task.save()).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(task.error).toContain('刷新资源');
    expect(task.pendingSave).toBeNull();
  });

  it('资源主视图失败保留原版与用户草稿，重试后清除错误', async () => {
    const { task, resources } = await setup();
    task.draft!.name = '我的任务2';
    vi.mocked(previewService.queryResourceMap).mockRejectedValueOnce(new ApiError('暂时断网', 'NETWORK_ERROR'));
    expect(await task.refreshResources()).toBe(false);
    expect(resources.workspace!.revision).toBe('r1');
    expect(task.resourceRevision).toBe('r1');
    expect(task.draft!.name).toBe('我的任务2');
    expect(task.error).toBe('暂时断网');
    expect(task.referencesRefreshing).toBe(false);
    expect(await task.refreshResources()).toBe(true);
    expect(task.error).toBe('');
  });

  it('新版引用缺失时不冒充已刷新，也不修改原保存版本', async () => {
    const { task, resources } = await setup();
    const original = JSON.stringify(task.saved);
    vi.mocked(previewService.getResourceObject).mockRejectedValueOnce(new ApiError('节点N1已不存在，请重新选择', 'RESOURCE_NOT_FOUND'));
    expect(await task.refreshResources()).toBe(false);
    expect(resources.workspace!.revision).toBe('r2');
    expect(task.resourceRevision).toBe('r1');
    expect(task.resourceStale).toBe(true);
    expect(task.error).toContain('N1');
    expect(JSON.stringify(task.saved)).toBe(original);
    expect(task.editable).toBe(true);
  });

  it('引用加载中禁止保存，离页取消后迟到响应不替换任务版本', async () => {
    const { task } = await setup();
    let resolve!: (value: Awaited<ReturnType<typeof previewService.getResourceObject>>) => void;
    vi.mocked(previewService.getResourceObject).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const refresh = task.refreshResources();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect(task.referencesRefreshing).toBe(true);
    expect(task.editable).toBe(false);
    expect(await task.save()).toBe(false);
    task.stop();
    resolve({ revision: 'r2', object: readNode(), model: null, antenna: null });
    expect(await refresh).toBe(false);
    expect(task.resourceRevision).toBe('r1');
    expect(task.referencesRefreshing).toBe(false);
  });

  it.each(['busy', 'running'] as const)('%s时刷新不与正在写入或规划的冻结版本竞态', async key => {
    const { task } = await setup();
    task[key] = true;
    expect(await task.refreshResources()).toBe(false);
    expect(previewService.loadResourceReadContext).not.toHaveBeenCalled();
    expect(task.resourceRevision).toBe('r1');
  });
});
