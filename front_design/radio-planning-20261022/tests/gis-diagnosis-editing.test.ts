import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRenderer, defineComponent, h, nextTick, type App } from 'vue';
import { createMemoryHistory, createRouter, onBeforeRouteLeave, onBeforeRouteUpdate, RouterView } from 'vue-router';
import { useGisDiagnosisEditing } from '../src/composables/useGisDiagnosisEditing';
import { useDiagnosisStore } from '../src/stores/diagnosis';
import { previewService } from '../src/services';
import { createDiagnosisMock } from '../src/services/diagnosis-mock';
import { createPlanningMock } from '../src/services/planning-mock';
import { initialMeta } from '../src/services/resource-storage';
import { planningPresets } from '../src/mocks/planning-presets';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import resources from '../src/mocks/resources.json';
import type { ResourcesData } from '../src/types/domain';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { savedRequest, taskMeta } from './helpers/tasks';

// 内存宿主挂载真实 composable、路由、诊断 Store 和 Mock 保存边界。
interface Host { text: string; parent: Host | null; children: Host[] }
const host = (text = ''): Host => ({ text, parent: null, children: [] });
const renderer = createRenderer<Host, Host>({
  createElement: () => host(), createText: host, createComment: host,
  insert(child, parent) { child.parent = parent; parent.children.push(child); },
  remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; },
  setText(el, text) { el.text = text; }, setElementText(el, text) { el.text = text; },
  parentNode: el => el.parent, nextSibling: () => null, patchProp: () => {},
  insertStaticContent(text, parent) { const el = host(text); el.parent = parent; parent.children.push(el); return [el, el]; },
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
async function settle() { for (let i = 0; i < 35; i++) await Promise.resolve(); await nextTick(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
let app: App<Host> | undefined, pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(query?: Record<string, string>, transfer = true) {
  const events = new EventTarget();
  vi.stubGlobal('window', events); vi.stubGlobal('document', { hidden: false });
  pinia = createPinia(); setActivePinia(pinia);
  const auth = authorizeStore(), storage = new TestStorage();
  let time = Date.parse('2026-10-19T00:00:00Z');
  const current = { resources: structuredClone(resources) as ResourcesData, meta: initialMeta() };
  const source = () => ({ ...current, meta: { ...current.meta, taskWorkspace: taskMeta(storage) } });
  const planning = createPlanningMock(() => storage, source, () => time);
  const job = await planning.submitPlanning(await savedRequest(storage, { baseRevision: 'initial', requestId: 'submit', taskId: null, parentPlanVersionId: null, input: structuredClone(planningPresets[0].input) }));
  time += 10000;
  const saved = await planning.savePlanVersion({ baseRevision: job.workspace.revision, requestId: 'save', jobId: job.view.job.id, name: 'GIS 标绘网络', note: '' });
  const confirmed = await planning.confirmPlanVersion({ baseRevision: saved.workspace.revision, requestId: 'confirm', planId: saved.plan.id });
  const service = createDiagnosisMock(() => storage, source, () => time);
  const initial = await service.loadDiagnosisWorkspace();
  const workspace = await service.saveDiagnosisScenario({ baseRevision: initial.workspace!.revision, requestId: 'scene', scenarioId: null,
    draft: { name: '标绘场景', description: '', planId: confirmed.plan.id, faults: structuredClone(diagnosisPresets.find(row => row.id === 'balanced:hardware')!.faults) } });
  const version = workspace.scenarios[0].versions[0];
  const target = previewService as unknown as Record<string, (...args: any[]) => Promise<any>>;
  for (const [name, method] of Object.entries(service)) vi.spyOn(target, name).mockImplementation(method);
  const diagnosis = useDiagnosisStore();
  await diagnosis.load(); await diagnosis.selectVersion(version);
  if (transfer) expect(diagnosis.prepareGisEditing()).toBe(true);
  let state!: ReturnType<typeof useGisDiagnosisEditing>;
  const Probe = defineComponent({ setup() {
    state = useGisDiagnosisEditing();
    onBeforeRouteLeave(to => state.isReturnTarget(to) || state.leave());
    onBeforeRouteUpdate(to => state.allowRouteUpdate(to));
    return () => h('p', state.error.value);
  } });
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/situation', component: Probe }, { path: '/diagnosis', component: { render: () => null } }, { path: '/other', component: { render: () => null } },
  ] });
  const destination = query ?? { faultEdit: '1', scenarioId: version.scenarioId, versionId: version.id };
  await router.push({ path: '/situation', query: destination }); await router.isReady();
  async function mount() {
    app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia!); app.use(router); app.mount(host()); await settle(); return state;
  }
  return { auth, storage, current, service, diagnosis, version, plan: confirmed.plan, router, events, mount, get state() { return state; } };
}

describe('GIS 故障场景接力与保存', () => {
  it('同一草稿和撤销历史跨页接力，绑定网络不读取台账或触发诊断', async () => {
    const s = await fixture(), input = copy(s.diagnosis.draft!);
    input.description = '在诊断页已应用'; s.diagnosis.updateDraft(input); expect(s.diagnosis.prepareGisEditing()).toBe(true);
    const before = JSON.stringify(s.diagnosis.draft), history = JSON.stringify(s.diagnosis.undoStack), writes = s.storage.writes;
    const submit = vi.spyOn(previewService, 'submitDiagnosis'), state = await s.mount();
    expect(state.ready.value).toBe(true); expect(state.canEdit.value).toBe(true);
    expect(JSON.stringify(s.diagnosis.draft)).toBe(before); expect(JSON.stringify(s.diagnosis.undoStack)).toBe(history);
    expect(state.network.value?.id).toBe(s.plan.id); expect(state.network.value?.inputSnapshot).toEqual(s.plan.inputSnapshot);
    expect(s.storage.writes).toBe(writes); expect(submit).not.toHaveBeenCalled();
  });
  it('节点设备链路选择只接受绑定网络；应用可撤销，保存生成新版本且不执行诊断', async () => {
    const s = await fixture(), state = await s.mount(), writes = s.storage.writes;
    expect(state.pick('NODE', 'NOT-IN-NETWORK')).toBe(false);
    const node = s.plan.inputSnapshot.stations[0], device = s.plan.inputSnapshot.devices[0], link = s.plan.links[0];
    state.actions.value.node(node.id); state.actions.value.pick('DEVICE', device.id); state.actions.value.link(link.id);
    expect(state.selected.value.map(row => row.objectType)).toEqual(['NODE', 'DEVICE', 'LINK']);
    expect(await state.save()).toBe(false); expect(state.drawerOpen.value).toBe(true); expect(s.storage.writes).toBe(writes);
    const input = copy(s.diagnosis.draft!); input.description = 'GIS 已应用';
    for (const target of state.selected.value) if (!input.faults.some(row => row.objectType === target.objectType && row.objectId === target.objectId)) input.faults.push({ ...target, faultType: target.objectType === 'LINK' ? 'LINK_DOWN' : 'HW_FAILURE', symptomIds: [], occurTime: null, interferenceId: null });
    expect(state.actions.value.apply(input)).toBe(true); expect(s.diagnosis.dirty).toBe(true); expect(s.storage.writes).toBe(writes);
    s.diagnosis.undo(); expect(s.diagnosis.draft!.description).toBe(''); s.diagnosis.redo();
    expect(await state.save()).toBe(true); expect(s.diagnosis.versionId).not.toBe(s.version.id);
    expect(s.diagnosis.workspace!.scenarios[0].versions).toHaveLength(2); expect(s.diagnosis.dirty).toBe(false); expect(s.diagnosis.view).toBeNull();
  });
  it('未应用表单不能被保存遗漏，取消关闭保留输入；应用后保存返回精确版本', async () => {
    const s = await fixture(), state = await s.mount(), writes = s.storage.writes;
    state.openEditor(); state.actions.value.dirty(true);
    expect(await state.saveAndReturn()).toBe(false); expect(s.router.currentRoute.value.path).toBe('/situation'); expect(s.storage.writes).toBe(writes);
    const closing = state.closeEditor(); await settle(); s.diagnosis.answer('cancel'); expect(await closing).toBe(false);
    expect(state.drawerOpen.value).toBe(true); expect(s.diagnosis.formDirty).toBe(true);
    const input = copy(s.diagnosis.draft!); input.description = '应用并返回'; state.actions.value.apply(input);
    expect(await state.saveAndReturn()).toBe(true); expect(s.router.currentRoute.value.path).toBe('/diagnosis');
    expect(s.router.currentRoute.value.query).toEqual({ scenarioId: s.diagnosis.scenarioId, versionId: s.diagnosis.versionId });
    expect(s.diagnosis.view).toBeNull(); expect(s.diagnosis.runId).toBe('');
  });
  it('保存失败、取消切出与同页导航都保留原草稿，明确放弃才还原', async () => {
    const s = await fixture(), state = await s.mount(), input = copy(s.diagnosis.draft!);
    input.description = '失败保留'; state.apply(input);
    vi.spyOn(previewService, 'saveDiagnosisReceipt').mockRejectedValueOnce(new Error('保存失败'));
    expect(await state.saveAndReturn()).toBe(false); expect(s.diagnosis.draft!.description).toBe('失败保留'); expect(s.diagnosis.error).toBe('保存失败');
    const leaving = s.router.push('/other'); await settle(); s.diagnosis.answer('cancel'); await leaving;
    expect(s.router.currentRoute.value.path).toBe('/situation'); expect(s.diagnosis.draft!.description).toBe('失败保留');
    const updating = s.router.push('/situation'); await settle(); s.diagnosis.answer('cancel'); await updating;
    expect(s.router.currentRoute.value.query.faultEdit).toBe('1');
    const discard = s.router.push('/other'); await settle(); s.diagnosis.answer('discard'); await discard;
    expect(s.router.currentRoute.value.path).toBe('/other'); expect(s.diagnosis.draft!.description).toBe(''); expect(s.diagnosis.dirty).toBe(false);
  });
});

describe('GIS 标绘来源、身份与旧事件保护', () => {
  it('来源失效后保留绑定网络和输入，旧地图与抽屉提交失效', async () => {
    const s = await fixture(), state = await s.mount(), old = state.actions.value, network = JSON.stringify(state.network.value);
    const input = copy(s.diagnosis.draft!); input.description = '保留'; state.apply(input);
    vi.spyOn(previewService, 'loadDiagnosisSourceOptions').mockResolvedValue({ plans: [], error: null });
    s.events.dispatchEvent(new Event('focus')); await settle();
    expect(state.canEdit.value).toBe(false); expect(JSON.stringify(state.network.value)).toBe(network); expect(state.sourceNotice.value).toContain('不');
    old.node(s.plan.inputSnapshot.stations[0].id); expect(state.selected.value).toEqual([]);
    input.description = '迟到修改'; expect(old.apply(input)).toBe(false); expect(s.diagnosis.draft!.description).toBe('保留'); expect(await state.save()).toBe(false);
  });
  it('来源失效的干净保存版本仍可返回诊断查看，返回不写新版本', async () => {
    const s = await fixture(), state = await s.mount(), writes = s.storage.writes;
    vi.spyOn(previewService, 'loadDiagnosisSourceOptions').mockResolvedValue({ plans: [], error: null });
    s.events.dispatchEvent(new Event('focus')); await settle();
    expect(state.canEdit.value).toBe(false); expect(await state.save()).toBe(false);
    expect(await state.saveAndReturn()).toBe(true); expect(s.router.currentRoute.value.path).toBe('/diagnosis');
    expect(s.router.currentRoute.value.query).toEqual({ scenarioId: s.version.scenarioId, versionId: s.version.id }); expect(s.storage.writes).toBe(writes);
  });
  it('权限暂失后禁用旧事件，恢复也不能复用旧闭包；未应用表单状态保留', async () => {
    const s = await fixture(), state = await s.mount(), old = state.actions.value, identity = copy(s.auth.identity!);
    state.openEditor(); state.actions.value.dirty(true);
    s.auth.accept({ ...identity, permissions: identity.permissions.filter(value => value !== 'diagnosis.scenario') }); await settle();
    expect(state.canEdit.value).toBe(false); expect(state.drawerOpen.value).toBe(true); expect(s.diagnosis.formDirty).toBe(true);
    s.auth.accept(identity); await settle(); old.node(s.plan.inputSnapshot.stations[0].id);
    expect(state.selected.value).toEqual([]); expect(s.diagnosis.formDirty).toBe(true);
    expect(state.canEdit.value).toBe(true); expect(state.network.value?.id).toBe(s.plan.id);
  });
  it('身份变化后的迟到保存回包不能覆盖新会话，也不能导航返回', async () => {
    const s = await fixture(), state = await s.mount(), input = copy(s.diagnosis.draft!);
    input.description = '旧会话'; state.apply(input);
    const waiting = deferred<Awaited<ReturnType<typeof s.service.saveDiagnosisScenario>>>();
    vi.spyOn(previewService, 'saveDiagnosisReceipt').mockImplementationOnce(async request => { const response = await s.service.saveDiagnosisReceipt(request); await waiting.promise; return response; });
    const saving = state.saveAndReturn(); await settle();
    s.auth.accept({ ...copy(s.auth.identity!), sessionId: 'replacement-session' }); s.diagnosis.clearForSession(); await settle();
    waiting.resolve({} as Awaited<ReturnType<typeof s.service.saveDiagnosisScenario>>); expect(await saving).toBe(false);
    expect(s.diagnosis.draft).toBeNull(); expect(state.network.value).toBeNull(); expect(s.router.currentRoute.value.path).toBe('/situation'); expect(s.diagnosis.busy).toBe(false);
  });
  it('同账号权限刷新拒绝迟到保存但释放忙碌锁，仍保留可重试草稿', async () => {
    const s = await fixture(), state = await s.mount(), identity = copy(s.auth.identity!), input = copy(s.diagnosis.draft!);
    input.description = '权限刷新保留'; state.apply(input);
    const waiting = deferred<void>();
    vi.spyOn(previewService, 'saveDiagnosisReceipt').mockImplementationOnce(async request => { const response = await s.service.saveDiagnosisReceipt(request); await waiting.promise; return response; });
    const saving = state.saveAndReturn(); await settle();
    s.auth.accept({ ...identity, permissions: identity.permissions.filter(value => value !== 'diagnosis.scenario') }); await settle();
    waiting.resolve(); expect(await saving).toBe(false); expect(s.diagnosis.busy).toBe(false); expect(s.diagnosis.versionId).toBe(s.version.id);
    expect(s.diagnosis.draft!.description).toBe('权限刷新保留'); expect(s.router.currentRoute.value.path).toBe('/situation');
    s.auth.accept(identity); await settle(); expect(state.canEdit.value).toBe(true); expect(s.diagnosis.dirty).toBe(true);
    expect(await state.save()).toBe(true); expect(s.diagnosis.workspace!.scenarios[0].versions).toHaveLength(2);
    expect((await s.service.loadDiagnosisWorkspace()).workspace!.scenarios[0].versions).toHaveLength(2);
  });
  it('错误目标不借用当前草稿或历史报告；普通入口不接管诊断', async () => {
    const s = await fixture({ faultEdit: '1', diagnosisId: 'DG-HW' }, false), state = await s.mount();
    expect(state.ready.value).toBe(false); expect(state.network.value).toBeNull(); expect(state.error.value).toContain('参数无效');
    expect(await state.saveAndReturn()).toBe(false); expect(s.router.currentRoute.value.path).toBe('/situation');
  });
  it('普通资源入口不加载或切换诊断场景', async () => {
    const s = await fixture({}, false), before = JSON.stringify(s.diagnosis.draft);
    const load = vi.spyOn(previewService, 'loadDiagnosisContext'), source = vi.spyOn(previewService, 'loadDiagnosisSourceOptions');
    load.mockClear(); source.mockClear(); const state = await s.mount();
    expect(state.active.value).toBe(false); expect(state.network.value).toBeNull(); expect(load).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled();
    expect(JSON.stringify(s.diagnosis.draft)).toBe(before);
  });
  it('指定保存版本可直接进入，但不授权不同目标或身份的草稿交接', async () => {
    const s = await fixture(undefined, false), state = await s.mount();
    expect(state.ready.value).toBe(true); expect(s.diagnosis.versionId).toBe(s.version.id);
    expect(s.diagnosis.prepareGisEditing()).toBe(true);
    expect(s.diagnosis.allowsGisTransfer({ faultEdit: '1', scenarioId: 'other', versionId: s.version.id })).toBe(false);
    expect(s.diagnosis.allowsGisTransfer({ faultEdit: '1', diagnosisId: 'DG-HW' })).toBe(false);
    s.auth.generation++; expect(s.diagnosis.allowsGisTransfer({ faultEdit: '1' })).toBe(false);
  });
});
