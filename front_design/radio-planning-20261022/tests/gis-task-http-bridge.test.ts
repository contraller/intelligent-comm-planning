import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { disposePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import GisTaskPanel from '../src/components/GisTaskPanel.vue';
import GisTaskPlanVersions from '../src/components/GisTaskPlanVersions.vue';
import { useGisTaskSelection, type GisTaskSelectionController } from '../src/composables/useGisTaskSelection';
import { previewService } from '../src/services';
import { ApiError } from '../src/services/types';
import { apiTask, readNode, storeFixture } from './fixtures/planning-api';
import { clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';
import { saveTaskForGis } from '../src/services/gis-task-edit-entry';
import type { ApiTask } from '../src/types/task-api';
const snapshotHttp = vi.hoisted(() => ({ getSnapshot: vi.fn() }));
vi.mock('../src/config/env', async original => ({ ...await original<object>(), env: { mode: 'http' } }));
vi.mock('../src/services/http', async original => {
  const actual = await original<typeof import('../src/services/http')>();
  return { ...actual, collaborationHttp: { ...actual.collaborationHttp, gisTasks: snapshotHttp } };
});
await clientTemplate(GisTaskPanel, 'src/components/GisTaskPanel.vue', 'gis-task-panel-render.ts');
await clientTemplate(GisTaskPlanVersions, 'src/components/GisTaskPlanVersions.vue', 'gis-task-plan-versions-render.ts');

let app: App | undefined, dispose: (() => void) | undefined;
afterEach(() => { app?.unmount(); app = undefined; dispose?.(); dispose = undefined; snapshotHttp.getSnapshot.mockReset(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mountPanel() {
  vi.stubGlobal('document', { activeElement: null });
  const state = await storeFixture(); dispose = () => disposePinia(state.pinia);
  const task = apiTask();
  snapshotHttp.getSnapshot.mockResolvedValue({ task, resourceRevision: 'r1', taskRevision: 't1', snapshotId: 'GIS-TASK-t1',
    sourceChanged: true, nodes: [readNode(), readNode('N2')], missingNodeIds: [], message: '' });
  const viewed = vi.fn(); let controller!: GisTaskSelectionController;
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }, { path: '/planning', component: { render: () => null } }] });
  await router.push('/'); await router.isReady();
  app = renderer.createApp({ setup() { controller = useGisTaskSelection(); return () => h(GisTaskPanel, { controller, onViewTask: viewed }); } });
  const root = node('root'); app.use(state.pinia); app.use(router); app.provide(ssrContextKey, {}); app.mount(root);
  await controller.initialize('T1'); await nextTick();
  return { ...state, root, controller, viewed };
}
const button = (root: HostNode, label: string) => find(root, item => item.tag === 'button' && textOf(item).trim() === label)!;
const click = (item: HostNode) => (item.props.onClick as () => Promise<void>)();
function fixture() {
  const saved: Pick<ApiTask, 'taskId' | 'revision' | 'resourceRevision'> = {
    taskId: 'T',
    revision: 'task-r2',
    resourceRevision: 'R',
  };
  const task = { taskId: 'T', saved: saved as typeof saved | null, save: vi.fn(async () => true) };
  return { task, current: vi.fn(() => true) };
}

// 保存服务桩与静态装配门禁；真实TaskApi/同源页面验收另行登记。
describe('GIS任务编辑与独立资源保存', () => {
  it('只在真实保存已接受后返回同任务/资源版本，不写任何资源', async () => {
    const f = fixture();
    expect(await saveTaskForGis(f.task, f.current)).toEqual({
      taskId: 'T',
      revision: 'task-r2',
      resourceRevision: 'R',
    });
    expect(f.task.save).toHaveBeenCalledTimes(1);
  });
  it('保存被拒绝时保持在编辑现场，不生成返回身份', async () => {
    const f = fixture();
    f.task.save.mockResolvedValue(false);
    expect(await saveTaskForGis(f.task, f.current)).toBeNull();
  });
  it.each(['task', 'saved', 'missing', 'revision'] as const)(
    '返回前%s身份核实失败时不冒充保存成功',
    async (mode) => {
      const f = fixture();
      f.task.save.mockImplementationOnce(async () => {
        if (mode === 'task') f.task.taskId = 'OTHER';
        if (mode === 'saved') f.task.saved!.taskId = 'OTHER';
        if (mode === 'missing') f.task.saved = null;
        if (mode === 'revision') f.task.saved!.revision = '';
        return true;
      });
      expect(await saveTaskForGis(f.task, f.current)).toBeNull();
    },
  );
  it('没有来源身份不调用保存，等待期间换身份/离页不继续导航', async () => {
    const f = fixture();
    f.current.mockReturnValueOnce(false);
    expect(await saveTaskForGis(f.task, f.current)).toBeNull();
    expect(f.task.save).not.toHaveBeenCalled();
    let resolve!: (value: boolean) => void;
    f.task.save.mockImplementationOnce(
      () =>
        new Promise((value) => {
          resolve = value;
        }),
    );
    const done = saveTaskForGis(f.task, f.current);
    f.current.mockReturnValue(false);
    resolve(true);
    expect(await done).toBeNull();
  });
  it('保存异常交由页面显示，不伪造成功回执', async () => {
    const f = fixture();
    f.task.save.mockRejectedValueOnce(new Error('资源版本冲突'));
    await expect(saveTaskForGis(f.task, f.current)).rejects.toThrow('资源版本冲突');
  });
  it('GIS资源与任务使用两条独立真实路径，不再调用旧联合保存', () => {
    const workspace = readFileSync(
      new URL('../src/stores/gis-workspace.ts', import.meta.url),
      'utf8',
    );
    const selection = readFileSync(
      new URL('../src/composables/useGisTaskSelection.ts', import.meta.url),
      'utf8',
    );
    const view = readFileSync(new URL('../src/views/PlanningApiView.vue', import.meta.url), 'utf8');
    expect(workspace).toContain('resources.workspace.edit');
    expect(workspace).toContain('previewService.saveResourceChanges(');
    expect(workspace).not.toContain('commitGisWorkspace(');
    expect(workspace).not.toContain('saveTask(');
    expect(selection).toContain('previewService.queryTaskSummaries(');
    expect(selection).toContain('previewService.getTaskInput(');
    expect(selection).toContain('collaborationHttp.gisTasks.getSnapshot(');
    expect(selection).toContain("env.mode !== 'http'");
    expect(selection).not.toContain('loadTaskWorkspace(');
    expect(view).toContain('saveTaskForGis(task, current)');
    expect(view).toContain("path: '/situation', query: { taskId: saved.taskId }");
    expect(view).toContain('保存任务并返回 GIS');
  });
});

describe('GIS任务态势可见操作与地图事件', () => {
  it('查看按钮读取所选冻结版本并反馈，发送viewTask供页面聚焦和fit，不修改规划输入', async () => {
    const f = await mountPanel(); f.task.draft!.name = '规划页保留草稿';
    const before = JSON.stringify(f.task.draft), save = vi.spyOn(previewService, 'saveTaskInput');
    const action = button(f.root, '查看任务态势'); expect(action).toBeDefined(); expect(action.props.disabled).toBe(false);
    vi.mocked(previewService.getTaskInput).mockResolvedValue({ ...apiTask(), revision: 't2' });
    await click(action); await nextTick();
    expect(snapshotHttp.getSnapshot.mock.calls.at(-1)![0]).toEqual({ context: 'planning', taskId: 'T1', revision: 't1' });
    expect(f.viewed).toHaveBeenCalledWith({ taskId: 'T1', revision: 't1', snapshotId: 'GIS-TASK-t1' });
    expect(textOf(f.root)).toContain('已载入任务'); expect(textOf(f.root)).toContain('历史冻结'); expect(textOf(f.root)).toContain('通联需求');
    expect(textOf(f.root)).not.toContain('规划链路'); expect(JSON.stringify(f.task.draft)).toBe(before); expect(save).not.toHaveBeenCalled();
  });
  it('按钮失败保留错误反馈且不发地图成功事件，缺历史资源不使用当前坐标', async () => {
    const f = await mountPanel(); snapshotHttp.getSnapshot.mockRejectedValue(new ApiError('历史资源缺失', 2004, undefined, undefined, 404));
    await click(button(f.root, '查看任务态势')); await nextTick();
    expect(f.viewed).not.toHaveBeenCalled(); expect(textOf(f.root)).toContain('任务态势未载入');
    expect(textOf(f.root)).toContain('不能拼接当前资源坐标'); expect(f.controller.nodes).toEqual([]);
  });
  it('正在载入时禁用按钮，完成后恢复，选择任务默认读取也发送同一地图事件', async () => {
    const f = await mountPanel();
    let reject!: (reason: unknown) => void;
    snapshotHttp.getSnapshot.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = click(button(f.root, '查看任务态势')); await nextTick();
    expect(button(f.root, '正在载入任务态势…').props.disabled).toBe(true);
    reject(new Error('读取失败')); await pending; await nextTick();
    expect(button(f.root, '查看任务态势').props.disabled).toBe(false);
    const select = find(f.root, item => item.tag === 'select')!;
    await (select.props.onChange as (event: unknown) => Promise<void>)({ target: { value: 'T1' } }); await nextTick();
    expect(f.viewed).toHaveBeenCalledOnce(); expect(f.viewed).toHaveBeenCalledWith({ taskId: 'T1', revision: 't1', snapshotId: 'GIS-TASK-t1' });
  });
});
