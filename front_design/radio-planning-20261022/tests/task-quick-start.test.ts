import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ssrContextKey, toRaw, type App, type Component } from 'vue';
import { disposePinia } from 'pinia';
import TaskQuickStart from '../src/components/TaskQuickStart.vue';
import TaskApiPanel from '../src/components/TaskApiPanel.vue';
import TaskApiLibraryDrawer from '../src/components/TaskApiLibraryDrawer.vue';
import TaskApiImportDrawer from '../src/components/TaskApiImportDrawer.vue';
import { previewService } from '../src/services';
import { downloadFile } from '../src/services/file-download';
import { apiTask, input, storeFixture } from './fixtures/planning-api';
import { all, clientTemplate, find, node, renderer, textOf, type HostNode } from './helpers/vue-client';
import type { PlanningCatalog } from '../src/types/planning-api';
import type { ResourceFile } from '../src/types/resource-edit';

vi.mock('../src/services/file-download', () => ({ downloadFile: vi.fn() }));
vi.mock('../src/components/TaskApiForm.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/AppDrawer.vue', () => ({ default: { props: ['visible', 'title'], render(this: any) { return this.visible ? h('drawer', [h('h2', this.title), this.$slots.default?.()]) : null; } } }));
vi.mock('../src/components/AppTable.vue', () => ({ default: { render: () => h('saved-task-table') } }));
beforeAll(async () => {
  for (const [component, name] of [[TaskQuickStart, 'TaskQuickStart'], [TaskApiPanel, 'TaskApiPanel'], [TaskApiLibraryDrawer, 'TaskApiLibraryDrawer'], [TaskApiImportDrawer, 'TaskApiImportDrawer']] as const)
    await clientTemplate(component, `src/components/${name}.vue`, 'task-quick-start-render.ts');
});
let fixture: Awaited<ReturnType<typeof storeFixture>> | undefined;
const apps: App[] = [];
const presets: PlanningCatalog['presets'] = [['balanced', '均衡规划'], ['reliable', '高可靠规划'], ['economical', '经济规划']].map(([id, label]) => ({
  id, label, description: '构造例程', defaults: { ...input(), name: `${label}任务`, presetId: id },
}));
const file: ResourceFile = { name: 'task-template.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: new Uint8Array([80, 75, 3, 4]) };
async function setup() {
  fixture = await storeFixture();
  fixture.task.catalog = { ...fixture.task.catalog!, presets: presets.map(({ defaults: _defaults, ...row }) => row) };
  vi.mocked(previewService.getPlanningPreset).mockImplementation(async request => structuredClone(presets.find(row => row.id === request.presetId)!));
  vi.spyOn(previewService, 'getTaskInputTemplate').mockResolvedValue(file);
  vi.spyOn(previewService, 'submitPlanningTask');
  class TestDocument extends EventTarget { activeElement = null; }
  vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument());
  return fixture;
}
const snapshot = (task: ReturnType<typeof import('../src/stores/task-input').useTaskInputStore>) => JSON.stringify([task.taskId, task.saved, task.draft, task.resourceRevision, task.nodes, task.devices, task.importFiles]);
function mount(component: Component = TaskQuickStart, props: Record<string, unknown> = {}) {
  const root = node('root'), app = renderer.createApp({ render: () => h(component, props) });
  apps.push(app); app.use(fixture!.pinia); app.provide(ssrContextKey, {}); app.mount(root); return root;
}
const button = (root: HostNode, label: string) => find(root, row => row.tag === 'button' && row.props['aria-label'] === label)!;
const click = (row: HostNode) => (row.props.onClick as () => void | Promise<void>)();
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); if (fixture) { fixture.task.clearForSession(); disposePinia(fixture.pinia); fixture = undefined; } vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('new task from current real preset contract', () => {
  it.each(presets.map(row => [row.id, row.label]))('starts %s as a new UUID draft only after all same-revision references resolve', async (id, label) => {
    const s = await setup(), old = structuredClone(toRaw(s.task.saved)), previousId = s.task.taskId;
    expect(await s.task.startFromPreset(id)).toBe(true);
    expect(s.task.taskId).not.toBe(previousId); expect(s.task.taskId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    expect(s.task.saved).toBeNull(); expect(s.task.draft!.presetId).toBe(id); expect(s.task.draft!.name).toBe(label + '任务');
    expect(s.task.nodes.map(row => row.id)).toEqual(['N1', 'N2']); expect(s.task.resourceRevision).toBe('r1'); expect(s.task.changed).toBe(true);
    expect(old).toEqual(apiTask());
    expect(previewService.getResourceObject).toHaveBeenCalledWith(expect.objectContaining({ context: 'planning', revision: 'r1', id: 'N1' }));
    expect(previewService.saveTaskInput).not.toHaveBeenCalled(); expect(previewService.submitPlanningTask).not.toHaveBeenCalled();
  });
  it('honors cancel and preserves even a discarded old draft when later resource reading fails', async () => {
    const s = await setup(); s.task.draft!.name = '原未保存输入'; const before = snapshot(s.task);
    const cancelled = s.task.startFromPreset('reliable');
    await vi.waitFor(() => expect(s.task.decision).not.toBeNull()); s.task.answer('cancel');
    expect(await cancelled).toBe(false); expect(snapshot(s.task)).toBe(before);
    vi.mocked(previewService.getResourceObject).mockRejectedValue(new Error('节点读取失败'));
    const failed = s.task.startFromPreset('economical');
    await vi.waitFor(() => expect(s.task.decision).not.toBeNull()); s.task.answer('discard');
    expect(await failed).toBe(false); expect(snapshot(s.task)).toBe(before); expect(s.task.error).toBe('节点读取失败');
    expect(s.task.referencesRefreshing).toBe(false);
  });
  it('rejects wrong-frame references without clearing the saved identity', async () => {
    const s = await setup(), before = snapshot(s.task), original = vi.mocked(previewService.getResourceObject).getMockImplementation()!;
    vi.mocked(previewService.getResourceObject).mockImplementation(async request => ({ ...await original(request), revision: 'another-revision' }));
    expect(await s.task.startFromPreset('balanced')).toBe(false); expect(snapshot(s.task)).toBe(before);
    expect(s.task.error).toContain('资源引用不匹配');
  });
  it('aborting while the unsaved-input decision is open cancels only this action and retains the draft', async () => {
    const s = await setup(), controller = new AbortController(); s.task.draft!.name = '保留未存输入';
    const before = snapshot(s.task), pending = s.task.startFromPreset('balanced', controller.signal);
    await vi.waitFor(() => expect(s.task.decision).not.toBeNull()); controller.abort();
    expect(await pending).toBe(false); expect(s.task.decision).toBeNull(); expect(snapshot(s.task)).toBe(before);
  });
  it.each(['abort', 'permission', 'resource', 'stop'] as const)('a late preset cannot replace the original after %s', async reason => {
    const s = await setup(), before = snapshot(s.task), controller = new AbortController();
    let resolve!: (value: PlanningCatalog['presets'][number]) => void;
    vi.mocked(previewService.getPlanningPreset).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = s.task.startFromPreset('balanced', controller.signal);
    await vi.waitFor(() => expect(s.task.referencesRefreshing).toBe(true));
    if (reason === 'abort') controller.abort();
    if (reason === 'permission') s.auth.identity!.permissions = s.auth.identity!.permissions.filter(value => value !== 'planning.execute');
    if (reason === 'resource') s.resources.workspace!.revision = 'r2';
    if (reason === 'stop') s.task.stop();
    resolve(structuredClone(presets[0])); expect(await pending).toBe(false); expect(snapshot(s.task)).toBe(before);
    expect(s.task.referencesRefreshing).toBe(false);
  });
  it('each complete XLSX gets a distinct task id, class name, and current preset input without changing the draft', async () => {
    const s = await setup(); s.task.draft!.name = '尚未保存的用户草稿'; const before = snapshot(s.task), ids: string[] = [];
    for (const preset of [...presets, presets[0]]) {
      const result = await s.task.getPresetExampleFile(preset.id);
      expect(result!.name).toContain(preset.label); expect(result!.name).toMatch(/\.xlsx$/);
      const request = vi.mocked(previewService.getTaskInputTemplate).mock.lastCall![0];
      expect(request).toMatchObject({ context: 'planning', format: 'xlsx', input: preset.defaults });
      expect(request.taskId).not.toBe('TASK-NEW'); expect(request.taskId).not.toBe('T1'); ids.push(request.taskId!);
    }
    expect(new Set(ids).size).toBe(4); expect(snapshot(s.task)).toBe(before); expect(s.task.decision).toBeNull();
    expect(previewService.saveTaskInput).not.toHaveBeenCalled(); expect(previewService.submitPlanningTask).not.toHaveBeenCalled();
  });
  it('opening a history task cannot race with preparation of the new preset draft', async () => {
    const s = await setup(); let resolve!: (value: PlanningCatalog['presets'][number]) => void;
    vi.mocked(previewService.getPlanningPreset).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = s.task.startFromPreset('balanced'); await vi.waitFor(() => expect(s.task.referencesRefreshing).toBe(true));
    const count = vi.mocked(previewService.getTaskInput).mock.calls.length;
    expect(await s.task.open('T2')).toBe(false); expect(previewService.getTaskInput).toHaveBeenCalledTimes(count);
    resolve(structuredClone(presets[0])); expect(await pending).toBe(true); expect(s.task.saved).toBeNull(); expect(s.task.taskId).not.toBe('T1'); expect(s.task.error).toBe('');
  });
});

describe('visible built-in examples in all three entry points', () => {
  it.each([[TaskApiPanel, {}], [TaskApiLibraryDrawer, { visible: true }], [TaskApiImportDrawer, {}]] as const)('shows the actual three choices in %s', async (component, props) => {
    const s = await setup(); s.task.importVisible = true;
    const root = mount(component, props); await nextTick();
    const block = find(root, row => row.props['aria-label'] === '内置构造例程')!;
    expect(block).toBeDefined(); expect(all(block, row => row.tag === 'article')).toHaveLength(3);
    expect(all(block, row => row.tag === 'button')).toHaveLength(6);
    for (const preset of presets) expect(textOf(block)).toContain(preset.label);
    expect(textOf(block)).toContain('保存任务'); expect(textOf(block)).toContain('提交规划');
    if (component === TaskApiLibraryDrawer) expect(textOf(root)).toContain('已保存任务');
    expect(s.task.taskId).toBe('T1'); expect(s.task.saved!.taskId).toBe('T1');
  });
  it('one click starts a new draft and emits success without saving or computing', async () => {
    const s = await setup(), started = vi.fn(), root = mount(TaskQuickStart, { onStarted: started });
    await click(button(root, '载入高可靠规划构造例程为新任务')); await nextTick();
    expect(s.task.saved).toBeNull(); expect(s.task.draft!.presetId).toBe('reliable'); expect(started).toHaveBeenCalledOnce();
    expect(previewService.saveTaskInput).not.toHaveBeenCalled(); expect(previewService.submitPlanningTask).not.toHaveBeenCalled();
  });
  it.each(['busy', 'running', 'permission'] as const)('disables all example actions during %s', async reason => {
    const s = await setup(), root = mount();
    if (reason === 'busy') s.task.busy = true;
    if (reason === 'running') s.task.running = true;
    if (reason === 'permission') s.auth.identity!.permissions = s.auth.identity!.permissions.filter(value => value !== 'planning.execute');
    await nextTick(); const buttons = all(root, row => row.tag === 'button');
    expect(buttons.every(row => row.props.disabled)).toBe(true);
    const calls = vi.mocked(previewService.getPlanningPreset).mock.calls.length;
    await click(buttons[0]); expect(previewService.getPlanningPreset).toHaveBeenCalledTimes(calls);
  });
  it('closing or unmounting prevents a late download, then reopening restores the buttons', async () => {
    await setup(); const props = reactive({ active: true }), root = mount(TaskQuickStart, props);
    let resolve!: (value: ResourceFile) => void;
    vi.mocked(previewService.getTaskInputTemplate).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = click(button(root, '下载经济规划完整XLSX导入例程'));
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    props.active = false; await nextTick(); resolve(file); await pending; await nextTick();
    expect(downloadFile).not.toHaveBeenCalled(); props.active = true; await nextTick();
    expect(button(root, '下载经济规划完整XLSX导入例程').props.disabled).toBe(false);
    await click(button(root, '下载经济规划完整XLSX导入例程')); expect(downloadFile).toHaveBeenCalledOnce();
    vi.mocked(previewService.getTaskInputTemplate).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const last = click(button(root, '下载均衡规划完整XLSX导入例程'));
    await vi.waitFor(() => expect(fixture!.task.referencesRefreshing).toBe(true));
    // Wait until the template call has begun, not merely the preset reference read.
    await vi.waitFor(() => expect(previewService.getTaskInputTemplate).toHaveBeenCalledTimes(3));
    apps.pop()!.unmount(); resolve(file); await last; expect(downloadFile).toHaveBeenCalledOnce();
  });
});
