import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { useGisTaskSelection, type GisTaskSelectionController } from '../src/composables/useGisTaskSelection';
import { previewService } from '../src/services';
import { ApiError } from '../src/services/types';
import { storeFixture, apiTask, readNode } from './fixtures/planning-api';
import type { GisTaskSnapshot, GisTaskSnapshotQuery } from '../src/types/gis-task';
import { usePlanningStore } from '../src/stores/planning';
import { useTaskInputStore } from '../src/stores/task-input';
import { authorizeStore } from './helpers/auth';
import { planningPresets } from '../src/mocks/planning-presets';

const mode = vi.hoisted(() => ({ value: 'http' }));
const snapshotHttp = vi.hoisted(() => ({ getSnapshot: vi.fn() }));
vi.mock('../src/services/http', async original => {
  const actual = await original<typeof import('../src/services/http')>();
  return { ...actual, collaborationHttp: { ...actual.collaborationHttp, gisTasks: snapshotHttp } };
});
vi.mock('../src/config/env', async original => ({ ...await original<object>(), env: { get mode() { return mode.value; } } }));
// 此宿主只验证只读选择生命周期；规划写入保护继续由任务状态层测试覆盖。
const renderer = createRenderer<any, any>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insertStaticContent: () => [{}, {}] });
let app: App | undefined, dispose: (() => void) | undefined;
afterEach(() => { app?.unmount(); app = undefined; dispose?.(); dispose = undefined; mode.value = 'http'; snapshotHttp.getSnapshot.mockReset(); vi.restoreAllMocks(); });
function mount(pinia: ReturnType<typeof createPinia>) {
  let controller!: GisTaskSelectionController;
  app = renderer.createApp({ setup() { controller = useGisTaskSelection(); return () => h('div'); } });
  app.use(pinia); app.mount({});
  return controller;
}
async function setup() {
  const state = await storeFixture(); dispose = () => disposePinia(state.pinia);
  snapshotHttp.getSnapshot.mockImplementation(async (query: GisTaskSnapshotQuery): Promise<GisTaskSnapshot> => {
    const task = { ...apiTask(), taskId: query.taskId, revision: query.revision };
    return { task, resourceRevision: task.resourceRevision, taskRevision: task.revision, snapshotId: `GIS-TASK-${task.revision}`,
      sourceChanged: false, nodes: task.input.stationIds.map(readNode), missingNodeIds: [], message: '' };
  });
  const controller = mount(state.pinia); await nextTick(); return { ...state, controller };
}
describe('GIS 保存任务只读选择', () => {
  it('HTTP显式选择只读保存版本，不覆盖规划草稿或触发保存', async () => {
    const s = await setup(); s.task.draft!.name = '规划未保存输入';
    const target = { ...apiTask(), taskId: 'T2', input: { ...apiTask().input, name: '已保存任务二' } };
    vi.mocked(previewService.getTaskInput).mockResolvedValue(target);
    snapshotHttp.getSnapshot.mockResolvedValue({ task: target, resourceRevision: target.resourceRevision, taskRevision: target.revision,
      snapshotId: `GIS-TASK-${target.revision}`, sourceChanged: false, nodes: target.input.stationIds.map(readNode), missingNodeIds: [], message: '' });
    const save = vi.spyOn(previewService, 'saveTaskInput'), combined = vi.spyOn(previewService, 'commitGisWorkspace');
    expect(await s.controller.initialize('T2')).toBe(true);
    expect(s.controller.selected).toMatchObject({ taskId: 'T2', name: '已保存任务二', version: 'i1' });
    expect(vi.mocked(previewService.getTaskInput).mock.calls.at(-1)![0]).toMatchObject({ context: 'planning', taskId: 'T2' });
    expect(s.task.taskId).toBe('T1'); expect(s.task.draft!.name).toBe('规划未保存输入'); expect(s.task.context).toBe('planning');
    expect(save).not.toHaveBeenCalled(); expect(combined).not.toHaveBeenCalled();
  });
  it('默认仅采用当前已保存任务，没有目标时不选择列表首项', async () => {
    const s = await setup(); s.task.saved = null;
    const read = vi.mocked(previewService.getTaskInput); read.mockClear();
    expect(await s.controller.initialize()).toBe(true); expect(s.controller.taskId).toBeNull(); expect(s.controller.library).toHaveLength(1); expect(read).not.toHaveBeenCalled();
    s.task.saved = apiTask(); expect(await s.controller.initialize()).toBe(true); expect(s.controller.taskId).toBe('T1');
  });
  it.each(['FORBIDDEN', 'NOT_FOUND'])('显式目标%s清空旧选择且不回退其他任务', async code => {
    const s = await setup(); await s.controller.initialize('T1');
    vi.mocked(previewService.getTaskInput).mockRejectedValue(new ApiError('目标不可用', code));
    expect(await s.controller.select('MISSING')).toBe(false); expect(s.controller.selected).toBeNull(); expect(s.controller.error).toContain('目标不可用');
    expect(s.task.taskId).toBe('T1');
  });
  it('快速换任务、无效参数与失权均不能接受迟到响应', async () => {
    const s = await setup(); let complete!: (value: ReturnType<typeof apiTask>) => void;
    vi.mocked(previewService.getTaskInput).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const old = s.controller.select('OLD'); await s.controller.select('T1'); complete({ ...apiTask(), taskId: 'OLD' }); await old;
    expect(s.controller.taskId).toBe('T1');
    expect(await s.controller.select(['T1'])).toBe(false); expect(s.controller.taskId).toBeNull();
    vi.mocked(previewService.getTaskInput).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = s.controller.select('T1'); s.auth.accept({ ...s.auth.identity!, permissions: [] }); await nextTick();
    complete(apiTask()); await pending; expect(s.controller.taskId).toBeNull(); expect(s.controller.library).toEqual([]);
  });
  it('分页和搜索只读取HTTP任务目录，查询失败不保留旧目标', async () => {
    const s = await setup(); await s.controller.initialize('T1');
    await s.controller.queryLibrary(2, '通信');
    expect(vi.mocked(previewService.queryTaskInputs).mock.calls.at(-1)![0]).toMatchObject({ context: 'planning', pageNum: 2, pageSize: 10, search: '通信' });
    vi.mocked(previewService.queryTaskInputs).mockRejectedValue(new ApiError('禁止查看', 'FORBIDDEN'));
    expect(await s.controller.queryLibrary()).toBe(false); expect(s.controller.selected).toBeNull(); expect(s.controller.library).toEqual([]);
  });
  it('HTTP读取冻结节点，当前资源变化仍保留原节点且不查询当前资源详情', async () => {
    const s = await setup(), read = vi.mocked(previewService.getResourceObject); read.mockClear();
    expect(await s.controller.initialize('T1')).toBe(true); expect(s.controller.nodes.map(node => node.id)).toEqual(['N1', 'N2']);
    expect(snapshotHttp.getSnapshot.mock.calls[0]![0]).toEqual({ context: 'planning', taskId: 'T1', revision: 't1' });
    expect(read).not.toHaveBeenCalled();
    s.resources.workspace!.revision = 'r2'; await nextTick();
    expect(s.controller.nodes.map(node => node.id)).toEqual(['N1', 'N2']); expect(s.controller.referenceNotice).toContain('历史冻结');
    expect(snapshotHttp.getSnapshot).toHaveBeenCalledOnce();
  });
  it('正式任务与快照沿planning分区回读，不动规划页上下文', async () => {
    const s = await setup(), nodes = vi.mocked(previewService.getResourceObject); nodes.mockClear();
    vi.mocked(previewService.getTaskInput).mockImplementation(async request => {
      if (request.context !== 'planning') throw new ApiError('该分区没有任务', 'TASK_NOT_FOUND');
      return apiTask();
    });
    expect(await s.controller.initialize('T1')).toBe(true);
    expect(s.controller.selected?.taskId).toBe('T1');
    expect(vi.mocked(previewService.queryTaskInputs).mock.calls.at(-1)![0].context).toBe('planning');
    expect(nodes).not.toHaveBeenCalled();
    expect(snapshotHttp.getSnapshot.mock.calls[0]![0].context).toBe('planning');
    expect(s.task.context).toBe('planning');
  });
  it('节点引用失权清空选择，失效引用只提示缺失且不补造节点', async () => {
    const s = await setup();
    const task = apiTask();
    snapshotHttp.getSnapshot.mockResolvedValue({ task, resourceRevision: 'r1', taskRevision: 't1', snapshotId: 'GIS-TASK-t1',
      sourceChanged: true, nodes: [], missingNodeIds: ['N1', 'N2'], message: '以下节点在冻结资源中缺失或坐标无效，未绘制：N1、N2' });
    expect(await s.controller.initialize('T1')).toBe(true); expect(s.controller.nodes).toEqual([]); expect(s.controller.referenceNotice).toContain('N1、N2');
    expect(s.controller.referenceNotice.match(/N1/g)).toHaveLength(1); expect(s.controller.referenceNotice.match(/N2/g)).toHaveLength(1);
    snapshotHttp.getSnapshot.mockRejectedValue(new ApiError('禁止读取节点', 'FORBIDDEN'));
    expect(await s.controller.select('T1')).toBe(false); expect(s.controller.selected).toBeNull(); expect(s.controller.nodes).toEqual([]);
  });
  it('资源工作区读取失败不阻止任务查询和冻结快照读取', async () => {
    const s = await setup(); s.resources.workspace = null;
    expect(await s.controller.initialize('T1')).toBe(true);
    expect(s.controller.library).toHaveLength(1); expect(s.controller.nodes).toHaveLength(2);
    expect(snapshotHttp.getSnapshot).toHaveBeenCalledOnce();
  });
  it.each([[1205, 409], [2001, 404], [2004, 404]])('快照错误%s保留目录且绝不拼当前坐标', async (code, status) => {
    const s = await setup(), read = vi.mocked(previewService.getResourceObject); read.mockClear();
    snapshotHttp.getSnapshot.mockRejectedValue(new ApiError('快照不可用', code, undefined, undefined, status));
    expect(await s.controller.initialize('T1')).toBe(false); expect(s.controller.library).toHaveLength(1);
    expect(s.controller.snapshot).toBeNull(); expect(s.controller.nodes).toEqual([]); expect(read).not.toHaveBeenCalled();
    if (code === 2004) expect(s.controller.referenceNotice).toContain('不能拼接当前资源坐标');
  });
  it.each(['taskId', 'resourceRevision', 'input'] as const)('快照%s与先读保存版本不符时拒绝载入', async field => {
    const s = await setup();
    const task = apiTask();
    if (field === 'taskId') task.taskId = 'OTHER';
    if (field === 'resourceRevision') task.resourceRevision = 'OTHER';
    if (field === 'input') task.input.name = '同编号的错误输入';
    snapshotHttp.getSnapshot.mockResolvedValue({ task, resourceRevision: task.resourceRevision, taskRevision: 't1', snapshotId: 'GIS-TASK-t1',
      sourceChanged: false, nodes: [], missingNodeIds: ['N1', 'N2'], message: '' });
    expect(await s.controller.initialize('T1')).toBe(false); expect(s.controller.nodes).toEqual([]);
    expect(s.controller.error).toContain('不一致');
  });
  it('快照迟到、权限代次改变及卸载均不能恢复旧任务坐标', async () => {
    const s = await setup(); let complete!: (value: GisTaskSnapshot) => void;
    const oldSnapshot: GisTaskSnapshot = { task: apiTask(), resourceRevision: 'r1', taskRevision: 't1', snapshotId: 'GIS-TASK-t1', sourceChanged: false, nodes: [readNode()], missingNodeIds: ['N2'], message: '' };
    snapshotHttp.getSnapshot.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = s.controller.select('T1'); await nextTick();
    s.controller.clearSelection(); complete(oldSnapshot);
    expect(await pending).toBe(false); expect(s.controller.nodes).toEqual([]);
    snapshotHttp.getSnapshot.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const denied = s.controller.select('T1'); await nextTick();
    s.auth.accept({ ...s.auth.identity!, permissions: [] }); await nextTick(); complete(oldSnapshot);
    expect(await denied).toBe(false); expect(s.controller.selected).toBeNull();
    snapshotHttp.getSnapshot.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    authorizeStore(); await nextTick();
    const leaving = s.controller.select('T1'); await nextTick(); app!.unmount(); app = undefined; complete(oldSnapshot);
    expect(await leaving).toBe(false); expect(s.controller.nodes).toEqual([]);
  });
  it('Mock读取任务最新保存版本，不拿规划草稿冒充保存数据', async () => {
    mode.value = 'mock'; const pinia = createPinia(); setActivePinia(pinia); dispose = () => disposePinia(pinia); authorizeStore();
    const input = structuredClone(planningPresets[0]!.input);
    const versions = [1, 2].map(number => ({ id: 'v' + number, number, conditionVersion: 'c' + number, savedAt: '2026-10-19T00:00:00Z', input: { ...input, name: '保存版本' + number } }));
    const workspace = { revision: 'r1', tasks: [{ id: 'T1', versions }], receipts: [] };
    // Mock 同样返回共同分页契约，不能再依赖页面扫描完整任务库。
    const saved = { ...apiTask(), taskId: 'T1', revision: 'v2', inputVersion: 'v2', conditionVersion: 'c2', input: versions[1]!.input };
    const legacyRead = vi.spyOn(previewService, 'loadTaskWorkspace');
    vi.spyOn(previewService, 'queryTaskInputs').mockResolvedValue({ items: [saved], total: 1, pageNum: 1, pageSize: 10 });
    vi.spyOn(previewService, 'queryTaskSummaries').mockResolvedValue({items:[{...saved,name:saved.input.name}],total:1,pageNum:1,pageSize:10});
    vi.spyOn(previewService, 'getTaskInput').mockImplementation(async request => { if (request.taskId !== 'T1') throw new ApiError('任务不存在', 'TASK_NOT_FOUND'); return saved; });
    const planning = usePlanningStore(), task = useTaskInputStore(); planning.tasks = workspace; planning.taskId = 'T1';
    // 共享读取只提供保存身份，未保存输入留在当前任务 Store。
    task.updateInput({ ...input, name: '未保存草稿' }); expect(task.saved).toBeNull();
    const controller = mount(pinia); expect(await controller.initialize()).toBe(true);
    expect(controller.selected).toMatchObject({ taskId: 'T1', version: 'v2', name: '保存版本2' }); expect(task.draft!.name).toBe('未保存草稿'); expect(legacyRead).not.toHaveBeenCalled();
    expect(await controller.select('MISSING')).toBe(false); expect(controller.selected).toBeNull(); expect(controller.error).toContain('不存在');
  });
});
