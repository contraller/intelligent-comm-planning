import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ssrContextKey, toRaw, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useTaskInputStore } from '../src/stores/task-input';
import { useResourceReadStore } from '../src/stores/resource-read';
import { usePreviewStore } from '../src/stores/preview';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

// 这里运行真实页面 setup、路由和离开守卫；可视模板由入口测试覆盖。
Object.assign(PlanningApiView, { render: () => h('planning-view') });
const renderer = createRenderer<any, any>({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insertStaticContent: () => [{}, {}] });
let app: App | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function settle() { for (let index = 0; index < 15; index++) await nextTick(); }
async function setup(path = '/planning?taskId=T1') {
  vi.stubGlobal('window', new EventTarget());
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore(); vi.spyOn(auth, 'check').mockResolvedValue(true);
  const storage = new TestStorage(), raw = createMockService(() => storage);
  for (const [name, method] of Object.entries(raw)) if (typeof method === 'function') vi.spyOn(previewService as any, name).mockImplementation(method);
  const input = structuredClone(planningPresets[0]!.input);
  for (const id of ['T1', 'T2']) {
    const resources = await raw.loadPreview(), tasks = await raw.loadTaskWorkspace();
    await raw.saveTask({ context: 'planning', taskId: id, input: { ...input, name: id }, baseResourceRevision: resources.resourceMeta.revision, baseTaskRevision: tasks.revision, requestId: 'save-' + id });
  }
  const preview = usePreviewStore(); await preview.load();await useResourceReadStore().activate('planning');
  const task=useTaskInputStore();await task.initialize('planning');await task.open('T1',false);
  const planning=usePlanningApiStore();vi.spyOn(planning,'start').mockImplementation(()=>{});
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/planning', component: PlanningApiView }, { path: '/situation', component: { render: () => h('gis-view') } }] });
  await router.push(path); await router.isReady(); app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, {}); app.mount({}); await settle();
  return { planning, task, router, storage, raw, auth };
}

describe('Mock 保存任务跨页定位与草稿保护', () => {
  it('显式任务编辑定位进入第一步，同任务重新定位不覆盖草稿', async () => {
  const s = await setup('/planning?taskId=T2&editTask=1'); await vi.waitFor(()=>expect(s.task.taskId).toBe('T2')); expect(s.planning.step).toBe(1);
    s.task.updateInput({ ...structuredClone(toRaw(s.task.saved!.input)), name: '未保存编辑' }); s.planning.step = 2;
    await s.router.push('/planning?taskId=T2'); await settle(); await s.router.push('/planning?taskId=T2&editTask=1'); await settle();
    expect(s.planning.step).toBe(1); expect(s.task.draft!.name).toBe('未保存编辑'); expect(s.task.changed).toBe(true);
  });
  it('异任务定位复用原保存保护，取消时不覆盖原任务', async () => {
    const s = await setup(); s.task.updateInput({ ...structuredClone(toRaw(s.task.saved!.input)), name: 'T1草稿' });
    await s.router.push('/planning?taskId=T2&editTask=1'); await settle(); expect(s.task.decision).not.toBeNull();
    s.task.answer('cancel'); await settle(); expect(s.task.taskId).toBe('T1'); expect(s.task.draft!.name).toBe('T1草稿');
  });
  it('不存在和非法目标不会回退首条或改动现有任务', async () => {
    const s = await setup('/planning?taskId=MISSING&editTask=1'); expect(s.task.taskId).toBe('T1'); expect(s.task.decision).toBeNull();
    await s.router.push('/planning?taskId=T2&editTask=1&planId=P1'); await settle(); expect(s.task.taskId).toBe('T1');
  });
  it('任务读取尚未完成时保留现场，完成后才按显式目标定位', async () => {
    const s = await setup();let finish!:(value:Awaited<ReturnType<typeof previewService.getTaskInput>>)=>void;
    // 延迟实际读取，验证当前页面不在响应前替换任务草稿。
    vi.mocked(previewService.getTaskInput).mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
    await s.router.push('/planning?taskId=T2&editTask=1');await settle();expect(s.task.taskId).toBe('T1');
    finish(await s.raw.getTaskInput({context:'planning',taskId:'T2'}));
    await vi.waitFor(()=>expect(s.task.taskId).toBe('T2'));
  });
  it('去 GIS 不再共享未保存任务，取消或保存失败都留在规划页', async () => {
    const s = await setup(); s.task.updateInput({ ...structuredClone(toRaw(s.task.saved!.input)), name: '需要保护的草稿' });
    let pending = s.router.push('/situation'); await vi.waitFor(() => expect(s.task.decision).not.toBeNull()); s.task.answer('cancel'); await pending;
    expect(s.router.currentRoute.value.path).toBe('/planning'); expect(s.task.draft!.name).toBe('需要保护的草稿');
    s.storage.failWrite = true; pending = s.router.push('/situation'); await vi.waitFor(() => expect(s.task.decision).not.toBeNull()); s.task.answer('save'); await pending;
    expect(s.router.currentRoute.value.path).toBe('/planning'); expect(s.task.draft!.name).toBe('需要保护的草稿');
    s.storage.failWrite = false; pending = s.router.push('/situation'); await vi.waitFor(() => expect(s.task.decision).not.toBeNull()); s.task.answer('save'); await pending;
    expect(s.router.currentRoute.value.path).toBe('/situation'); expect(s.task.changed).toBe(false); expect(s.task.saved!.input.name).toBe('需要保护的草稿');
  });
});
