import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, toRaw, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import SituationView from '../src/views/SituationView.vue';
import InterferenceAnalysisPanel from '../src/components/InterferenceAnalysisPanel.vue';
import { safeReturnPath } from '../src/config/permissions';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useTaskInputStore } from '../src/stores/task-input';
import { useInterferenceStore } from '../src/stores/interference';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceReadStore } from '../src/stores/resource-read';
import { authorizeStore } from './helpers/auth';
import { interferenceFixture } from './helpers/interference';
import { savedRequest } from './helpers/tasks';
// 仅复用模板编译，忽略注释节点文本的宿主保留本地。
import { clientTemplate } from './helpers/vue-client';

// 保留页面真实模板、路由和离页守卫，仅替换无关图表及组件库外壳。
vi.mock('../src/components/MapCanvas.vue', () => ({ default: Vue.defineComponent({ inheritAttrs: false, setup(_p, { expose }) {
  expose({ locate() {}, locateResource() {}, fitDeviceCoverage() {}, expandResource() {} }); return () => h('map-probe');
} }) }));
vi.mock('../src/components/AppDrawer.vue', () => ({ default: Vue.defineComponent({ props: ['visible'], setup: (p, { slots }) => () => p.visible ? h('aside', [slots.default?.(), slots.footer?.()]) : null }) }));
vi.mock('../src/components/TaskApiPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningApiResultPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningApiProgressPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningApiVersionsPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningAdjustmentDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningAdjustmentPreview.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningHistoryDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningSolutionsPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/PlanningOptionsSummary.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DeploymentConstraintsSummary.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ObjectInfoPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/GisResourceTree.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/GisDeviceLayerPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/GisResultLayerPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DeviceCoveragePanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/GisDeviceClusterPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceStatusPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/SituationMonitoringDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/MonitoringObjectPanel.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/InterferenceHistoryDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/InterferenceMeasureDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/InterferenceSourceDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/ResourceExportDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/DecisionDialog.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/StatusBadge.vue', () => ({ default: { render: () => null } }));

interface HostNode { tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[]; props: Record<string, any>; style: Record<string, string>; value?: unknown; readonly options: HostNode[]; addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document }
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {}, get options() { return this.children.filter(c => c.tag === 'option'); }, addEventListener() {}, removeEventListener() {}, getRootNode: () => document });
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) { remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, child); }
const renderer = createRenderer<HostNode, HostNode>({ insert, remove, createElement: tag => node(tag), createText: t => node('#text', t), createComment: t => node('#comment', t), setText: (n, t) => { n.text = t; }, setElementText: (n, t) => { n.text = t; n.children = []; }, parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null, patchProp: (n, key, _old, value) => { n.props[key] = value; }, insertStaticContent: (t, p, a) => { const n = node('#static', t); insert(n, p, a); return [n, n]; } });
function find(root: HostNode, predicate: (n: HostNode) => boolean): HostNode | undefined { if (predicate(root)) return root; for (const child of root.children) { const match = find(child, predicate); if (match) return match; } }
const textOf = (root: HostNode): string => root.tag === '#comment' ? '' : root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
const button = (root: HostNode, label: string) => find(root, n => n.tag === 'button' && textOf(n).trim() === label)!;
async function settle() { for (let i = 0; i < 25; i++) { await Promise.resolve(); await nextTick(); } }
async function click(root: HostNode, label: string) { const hit = button(root, label); expect(hit, label).toBeDefined(); await hit.props.onClick(); await settle(); }

let app: App | undefined, pinia: ReturnType<typeof createPinia> | undefined;
beforeAll(async () => { for (const [component, path] of [[PlanningApiView, 'src/views/PlanningApiView.vue'], [SituationView, 'src/views/SituationView.vue'], [InterferenceAnalysisPanel, 'src/components/InterferenceAnalysisPanel.vue']] as const) await clientTemplate(component, path, 'planning-interference-render.ts'); });
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', new EventTarget()); class TestDocument extends EventTarget { activeElement = null; hidden = false; } vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {}); });
afterEach(() => { app?.unmount(); app = undefined; if (pinia) disposePinia(pinia); pinia = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function fixture(options: { second?: boolean; path?: string; interferenceOnly?: boolean } = {}) {
  const f = await interferenceFixture();
  let second: typeof f.plan | undefined;
  if (options.second) {
    const submitted = await f.planning.submitPlanning(await savedRequest(f.storage, { baseRevision: (await f.planning.loadPlanningWorkspace()).workspace.revision, requestId: 'submit-B', taskId: null, parentPlanVersionId: null, input: structuredClone(planningPresets.find(p => p.id === 'economical')!.input) }));
    f.advance(); const saved = await f.planning.savePlanVersion({ baseRevision: submitted.workspace.revision, jobId: submitted.view.job.id, requestId: 'save-B', name: '网络 B', note: '' });
    second = (await f.planning.confirmPlanVersion({ baseRevision: saved.workspace.revision, planId: saved.plan.id, requestId: 'confirm-B' })).plan;
  }
  if (options.interferenceOnly) await f.resource.commit({ baseRevision: f.resource.read().meta.revision, stations: [], devices: [], interferences: [{ id: 'IF-0008', txPowerDbm: 47.9 }] });
  pinia = createPinia(); setActivePinia(pinia); const auth = authorizeStore(); vi.spyOn(auth, 'check').mockResolvedValue(true);
  Object.assign(window, { localStorage: f.storage });
  const raw = createMockService(() => f.storage);
  for (const [key, method] of Object.entries(raw)) if (key !== 'getSession') vi.spyOn(previewService as any, key).mockImplementation(method.bind(raw));
  await usePreviewStore().load();
  const planning = usePlanningApiStore(), task = useTaskInputStore(), store = useInterferenceStore(), gis = useGisWorkspaceStore(), editor = useResourceEditStore();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/planning', component: PlanningApiView }, { path: '/situation', component: SituationView }, { path: '/elsewhere', component: { render: () => null } }] });
  const planningPath = router.resolve({ path: '/planning', query: { taskId: f.plan.taskId, planId: f.plan.id } }).fullPath;
  const targetPath = (plan = f.plan) => router.resolve({ path: '/situation', query: { analysisTaskId: plan.taskId, analysisPlanId: plan.id } }).fullPath;
  await router.push(options.path ?? planningPath); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() });
  const root = node('root'); app.mount(root); await settle(); await settle();
  return { ...f, second, raw, auth, planning, task, store, gis, editor, router, root, planningPath, targetPath };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function assertNoBusinessWrite(s: Fixture, writes: number) {
  expect(s.storage.writes).toBe(writes);
  for (const name of ['submitInterferenceReceipt', 'adoptInterferenceReceipt', 'cancelInterferenceReceipt', 'confirmPlanningReceipt', 'commitResources'] as const) expect(previewService[name]).not.toHaveBeenCalled();
}

describe('规划到 GIS 干扰分析精确入口', () => {
  it('真实按钮精确进入已确认方案，返回同方案，不提交分析或写业务', async () => {
    const s = await fixture(), writes = s.storage.writes;
    expect(button(s.root, '进入干扰分析').props.disabled).toBe(false);
    await click(s.root, '进入干扰分析');
    expect(s.router.currentRoute.value.fullPath).toBe(s.targetPath()); expect(s.store.planId).toBe(s.plan.id); expect(s.store.analysisId).toBe('');
    expect(find(s.root, n => n.props.class === 'analysis-panel')).toBeDefined();
    await click(s.root, '返回规划方案'); expect(s.router.currentRoute.value.fullPath).toBe(s.planningPath); expect(s.planning.selectedPlan?.id).toBe(s.plan.id);
    assertNoBusinessWrite(s, writes);
  });
  it('仅干扰源变化沿现有资格进入，不把 current=false 当作不可分析', async () => {
    const s = await fixture({ interferenceOnly: true }); expect(s.planning.selectedPlan?.current).toBe(false);
    await click(s.root, '进入干扰分析'); expect(s.store.planId).toBe(s.plan.id); expect(textOf(s.root)).toContain('仅因干扰源修改失效');
  });
  it.each(['unconfirmed', 'reference', 'missing', 'permission'])('%s 目标无可执行入口，旧按钮也不能跳转', async kind => {
    const s = await fixture(), old = button(s.root, '进入干扰分析').props.onClick;
    if (kind === 'missing') s.planning.selectedPlan = null;
    else if (kind === 'permission') s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'situation.view') });
    else s.planning.selectedPlan!.state = kind === 'reference' ? 'REFERENCE' : 'SAVED';
    await settle(); expect(button(s.root, '进入干扰分析').props.disabled).toBe(true); await old(); expect(s.router.currentRoute.value.path).toBe('/planning');
  });
  it('已替换版本按服务原因拒绝，不回落另一个已确认版本', async () => {
    const s = await fixture();
    vi.mocked(previewService.loadInterferenceContext).mockResolvedValueOnce({ ...(await s.raw.loadInterferenceContext()), sources: { ...(await s.raw.loadInterferenceContext()).sources, plans: [{ plan: s.plan, eligible: false, reason: '该确认版本已被替换', interferenceOnly: false }] } });
    await click(s.root, '进入干扰分析'); expect(s.router.currentRoute.value.path).toBe('/planning'); expect(textOf(s.root)).toContain('该确认版本已被替换');
  });
  it('旧历史 B 不覆盖目标 A，刷新和焦点恢复仍保持 A 的分析输入', async () => {
    const s = await fixture({ second: true });
    const receipt = await s.raw.submitInterferenceReceipt({ ...(await s.request()), planId: s.second!.id }); await vi.advanceTimersByTimeAsync(10000);
    const old = await s.raw.getInterferenceDetail({ analysisId: receipt.objectId }); s.store.views = [old]; s.store.analysisId = old.run.analysisId; s.store.planId = s.second!.id;
    const writes = s.storage.writes; await click(s.root, '进入干扰分析');
    expect(s.store.planId).toBe(s.plan.id); expect(s.store.selected).toBeNull(); expect(s.store.historyTotal).toBe(1);
    await s.store.load(); window.dispatchEvent(new Event('focus')); await settle();
    expect(s.store.planId).toBe(s.plan.id); expect(s.store.analysisId).toBe(''); assertNoBusinessWrite(s, writes);
  });
  it.each(['same', 'other'])('%s 方案正在分析时复用原运行或阻止切换，不取消任务', async kind => {
    const s = await fixture({ second: true }), target = kind === 'same' ? s.plan : s.second!;
    const receipt = await s.raw.submitInterferenceReceipt({ ...(await s.request()), planId: target.id }); const writes = s.storage.writes;
    await click(s.root, '进入干扰分析');
    if (kind === 'same') { expect(s.store.analysisId).toBe(receipt.objectId); expect(s.store.selected?.run.network.id).toBe(s.plan.id); }
    else { expect(s.router.currentRoute.value.path).toBe('/planning'); expect(textOf(s.root)).toContain('其他方案的干扰分析正在运行'); }
    assertNoBusinessWrite(s, writes);
  });
  it.each(['cancel', 'failed-save', 'discard'] as const)('规划输入 %s 沿原离页保护', async choice => {
    const s = await fixture(); s.task.updateInput({ ...structuredClone(toRaw(s.task.saved!.input)), name: '保留规划输入' });
    if (choice === 'failed-save') s.storage.failWrite = true;
    const pending = button(s.root, '进入干扰分析').props.onClick(); await settle(); expect(s.task.decision).not.toBeNull();
    s.task.answer(choice === 'failed-save' ? 'save' : choice); await pending; await settle();
    if (choice === 'discard') expect(s.router.currentRoute.value.path).toBe('/situation');
    else { expect(s.router.currentRoute.value.path).toBe('/planning'); expect(s.task.draft!.name).toBe('保留规划输入'); }
  });
  it.each(['selection', 'permission', 'leave', 'unmount'])('%s 后迟到入口资格响应不能导航', async kind => {
    const s = await fixture(), response = await s.raw.loadInterferenceContext(); let finish!: (value: typeof response) => void;
    vi.mocked(previewService.loadInterferenceContext).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = button(s.root, '进入干扰分析').props.onClick(); await settle();
    if (kind === 'selection') s.planning.step = 1;
    if (kind === 'permission') s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'situation.view') });
    if (kind === 'leave') await s.router.push('/elsewhere');
    if (kind === 'unmount') { app?.unmount(); app = undefined; }
    finish(response); await pending; await settle(); expect(s.router.currentRoute.value.path).not.toBe('/situation');
  });
  it('等待规划离页决定期间目标变化，旧导航不能提交放弃决定', async () => {
    const s=await fixture();s.task.updateInput({...structuredClone(toRaw(s.task.saved!.input)),name:'等待决定的规划输入'});
    const pending=button(s.root,'进入干扰分析').props.onClick();await settle();expect(s.task.decision).not.toBeNull();
    s.planning.step=1;s.task.answer('discard');await pending;await settle();
    expect(s.router.currentRoute.value.path).toBe('/planning');expect(s.task.draft!.name).toBe('等待决定的规划输入');
  });
  it.each(['wrong-task', 'missing'])('GIS %s 深链不回落首个方案', async kind => {
    const s = await fixture({ path: '/situation' }), writes = s.storage.writes;
    await s.router.push({ path: '/situation', query: { analysisTaskId: kind === 'wrong-task' ? 'other' : s.plan.taskId, analysisPlanId: kind === 'missing' ? 'missing' : s.plan.id } }); await settle();
    expect(textOf(s.root)).toContain('目标方案不存在或不属于指定任务'); expect(button(s.root, '返回规划方案')).toBeUndefined(); assertNoBusinessWrite(s, writes);
  });
  it.each(['cancel', 'failed-save', 'discard'] as const)('GIS 同页深链 %s 保留原资源决定', async choice => {
    const s = await fixture({ path: '/situation' }); await useResourceReadStore().activate('gis'); await s.gis.begin(); await s.editor.openForm('station', 'ND-0100');
    s.editor.form!.fields.name = 'GIS 未保存输入'; s.editor.applyForm(); if (choice === 'failed-save') s.storage.failWrite = true;
    await s.router.push(s.targetPath()); await settle(); expect(s.editor.decision).not.toBeNull(); s.editor.answer(choice === 'failed-save' ? 'save' : choice); await settle();
    if(choice==='failed-save')await vi.waitFor(()=>expect(s.gis.busy||s.editor.busy).toBe(false));
    if (choice === 'discard') { expect(s.store.planId).toBe(s.plan.id); expect(button(s.root, '返回规划方案')).toBeDefined(); }
    else { expect(s.gis.dirty).toBe(true); expect(button(s.root, '返回规划方案')).toBeUndefined(); expect(textOf(s.root)).toContain('当前现场已保留'); }
  });
  it.each(['route','permission','session'] as const)('GIS %s 变化后迟到回调不接纳旧目标', async kind => {
    const s = await fixture({ path: '/situation' }), response = await s.raw.loadInterferenceContext(); let finish!: (value: typeof response) => void;
    vi.mocked(previewService.loadInterferenceContext).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await s.router.push(s.targetPath()); await settle();
    if(kind==='route')await s.router.push('/situation');
    if(kind==='permission')s.auth.accept({...s.auth.identity!,permissions:s.auth.identity!.permissions.filter(p=>p!=='planning.view')});
    if(kind==='session')s.auth.accept({...s.auth.identity!,sessionId:'changed-session'});
    if(kind==='session')await s.router.push('/elsewhere');
    finish(response); await settle();
    expect(button(s.root, '返回规划方案')).toBeUndefined(); expect(s.gis.mapMode).toBe('resource');
  });
  it('GIS 返回等待资源决定时换号，旧返回不能离页或丢失资源输入', async()=>{
    const s=await fixture();await click(s.root,'进入干扰分析');
    await s.gis.begin();await s.editor.openForm('station','ND-0100');s.editor.form!.fields.name='返回前的资源输入';s.editor.applyForm();
    const pending=button(s.root,'返回规划方案').props.onClick();await settle();expect(s.editor.decision).not.toBeNull();
    s.auth.accept({...s.auth.identity!,sessionId:'other-session'});s.editor.answer('discard');await pending;await settle();
    expect(s.router.currentRoute.value.path).toBe('/situation');expect(s.gis.dirty).toBe(true);
  });
});

describe('分析导航参数白名单', () => {
  it('仅接受成对分析身份，保留不透明 ID 的编码', () => { expect(safeReturnPath('/situation?analysisTaskId=task%3A1&analysisPlanId=plan%2F2')).toBe('/situation?analysisTaskId=task%3A1&analysisPlanId=plan%2F2'); });
  it.each(['analysisTaskId=T', 'analysisPlanId=P', 'analysisTaskId=T&analysisPlanId=P&taskId=T', 'analysisTaskId=T&analysisPlanId=P&stationId=N', 'analysisTaskId=T&analysisPlanId=P&diagnosisId=D', 'analysisTaskId=T&analysisPlanId=P&faultEdit=1', 'analysisTaskId=T&analysisPlanId=P&analysisPlanId=Q'])('拒绝 %s', query => { expect(safeReturnPath('/situation?' + query)).toBeNull(); });
});
