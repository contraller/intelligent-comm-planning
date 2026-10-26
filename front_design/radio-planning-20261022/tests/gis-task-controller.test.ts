import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { useGisTaskSelection, type GisTaskSelectionController } from '../src/composables/useGisTaskSelection';
import { previewService } from '../src/services';
import { ApiError } from '../src/services/types';
import { storeFixture, apiTask, readNode } from './fixtures/planning-api';
import { usePlanningStore } from '../src/stores/planning';
import { useTaskInputStore } from '../src/stores/task-input';
import { authorizeStore } from './helpers/auth';
import { planningPresets } from '../src/mocks/planning-presets';

const mode = vi.hoisted(() => ({ value: 'http' }));
vi.mock('../src/config/env', async original => ({ ...await original<object>(), env: { get mode() { return mode.value; } } }));
// 此宿主只验证只读选择生命周期；规划写入保护继续由任务状态层测试覆盖。
const renderer = createRenderer<any, any>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insertStaticContent: () => [{}, {}] });
let app: App | undefined, dispose: (() => void) | undefined;
afterEach(() => { app?.unmount(); app = undefined; dispose?.(); dispose = undefined; mode.value = 'http'; vi.restoreAllMocks(); });
function mount(pinia: ReturnType<typeof createPinia>) {
  let controller!: GisTaskSelectionController;
  app = renderer.createApp({ setup() { controller = useGisTaskSelection(); return () => h('div'); } });
  app.use(pinia); app.mount({});
  return controller;
}
async function setup() {
  const state = await storeFixture(); dispose = () => disposePinia(state.pinia);
  const controller = mount(state.pinia); await nextTick(); return { ...state, controller };
}
describe('GIS 保存任务只读选择', () => {
  it('HTTP显式选择只读保存版本，不覆盖规划草稿或触发保存', async () => {
    const s = await setup(); s.task.draft!.name = '规划未保存输入';
    const target = { ...apiTask(), taskId: 'T2', input: { ...apiTask().input, name: '已保存任务二' } };
    vi.mocked(previewService.getTaskInput).mockResolvedValue(target);
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
  it('HTTP只读取任务明确引用的同版本节点，版本变化不拼旧坐标', async () => {
    const s = await setup(), read = vi.mocked(previewService.getResourceObject); read.mockClear();
    expect(await s.controller.initialize('T1')).toBe(true); expect(s.controller.nodes.map(node => node.id)).toEqual(['N1', 'N2']);
    expect(read.mock.calls.map(([request]) => [request.context, request.revision, request.id])).toEqual([['gis', 'r1', 'N1'], ['gis', 'r1', 'N2']]);
    read.mockResolvedValue({ revision: 'wrong', object: readNode(), model: null, antenna: null });
    await s.controller.loadReferences(); expect(s.controller.nodes).toEqual([]); expect(s.controller.referenceNotice).toContain('身份或资源版本不一致');
    s.resources.workspace!.revision = 'r2'; await nextTick(); expect(s.controller.nodes).toEqual([]); expect(s.controller.referenceNotice).toContain('资源版本不一致');
  });
  it('正式任务按规划分区保存后，GIS沿同一任务上下文回读，节点仍为GIS', async () => {
    const s = await setup(), nodes = vi.mocked(previewService.getResourceObject); nodes.mockClear();
    vi.mocked(previewService.getTaskInput).mockImplementation(async request => {
      if (request.context !== 'planning') throw new ApiError('该分区没有任务', 'TASK_NOT_FOUND');
      return apiTask();
    });
    expect(await s.controller.initialize('T1')).toBe(true);
    expect(s.controller.selected?.taskId).toBe('T1');
    expect(vi.mocked(previewService.queryTaskInputs).mock.calls.at(-1)![0].context).toBe('planning');
    expect(nodes.mock.calls).not.toHaveLength(0);
    expect(nodes.mock.calls.every(([request]) => request.context === 'gis')).toBe(true);
    expect(s.task.context).toBe('planning');
  });
  it('节点引用失权清空选择，失效引用只提示缺失且不补造节点', async () => {
    const s = await setup(), read = vi.mocked(previewService.getResourceObject);
    read.mockRejectedValue(new ApiError('节点不存在', 'NOT_FOUND'));
    expect(await s.controller.initialize('T1')).toBe(true); expect(s.controller.nodes).toEqual([]); expect(s.controller.referenceNotice).toContain('N1、N2');
    read.mockRejectedValue(new ApiError('禁止读取节点', 'FORBIDDEN'));
    expect(await s.controller.select('T1')).toBe(false); expect(s.controller.selected).toBeNull(); expect(s.controller.nodes).toEqual([]);
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
