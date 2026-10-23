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
import { ApiError } from '../src/services/types';
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
import { compileWorkbenchTemplates, createWorkbenchFixture, clickWorkbench, deferred, settleWorkbench, workbenchText } from './helpers/interference-workbench';

vi.mock('../src/config/env', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config/env')>();
  return { ...actual, env: { ...actual.env, mode: 'http' } };
});

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
vi.mock('../src/components/ResourceStatusPanel.vue', () => ({ default: Vue.defineComponent({ setup(_props, { expose }) { expose({ requestLeave: async () => true }); return () => null; } }) }));
vi.mock('../src/components/SituationMonitoringDrawer.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/components/MonitoringObjectPanel.vue', () => ({ default: { render: () => null } }));
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
beforeAll(async () => { for (const [component, path] of [[PlanningApiView, 'src/views/PlanningApiView.vue'], [SituationView, 'src/views/SituationView.vue'], [InterferenceAnalysisPanel, 'src/components/InterferenceAnalysisPanel.vue']] as const) await clientTemplate(component, path, 'planning-interference-render.ts'); await compileWorkbenchTemplates(); });
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', Object.assign(new EventTarget(), { confirm: vi.fn(() => false) })); class TestDocument extends EventTarget { activeElement = null; hidden = false; } vi.stubGlobal('Document', TestDocument); vi.stubGlobal('document', new TestDocument()); vi.stubGlobal('ShadowRoot', class {}); });
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
  const spyTarget: Record<keyof typeof previewService, (...args: never[]) => unknown> = previewService;
  for (const [key, method] of Object.entries(raw)) if (key !== 'getSession') vi.spyOn(spyTarget, key as keyof typeof spyTarget).mockImplementation(method.bind(raw));
  const wb = await createWorkbenchFixture(await raw.getPlanningPlan({ context: 'gis', taskId: f.plan.taskId, planId: f.plan.id }));
  if (options.interferenceOnly) { wb.source.current = false; wb.source.unavailable_reasons = ['仅因干扰源修改失效，允许冻结分析']; }
  wb.bind();
  await usePreviewStore().load();
  const planning = usePlanningApiStore(), task = useTaskInputStore(), store = useInterferenceStore(), gis = useGisWorkspaceStore(), editor = useResourceEditStore();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/planning', component: PlanningApiView }, { path: '/situation', component: SituationView }, { path: '/elsewhere', component: { render: () => null } }] });
  const planningPath = router.resolve({ path: '/planning', query: { taskId: f.plan.taskId, planId: f.plan.id } }).fullPath;
  const targetPath = (plan = f.plan) => router.resolve({ path: '/situation', query: { analysisTaskId: plan.taskId, analysisPlanId: plan.id } }).fullPath;
  await router.push(options.path ?? planningPath); await router.isReady();
  app = renderer.createApp({ render: () => h(RouterView) }); app.use(pinia); app.use(router); app.provide(ssrContextKey, { modules: new Set() });
  const root = node('root'); app.mount(root); await settle(); await settle();
  await settleWorkbench();
  return { ...f, second, raw, auth, planning, task, store, gis, editor, router, root, planningPath, targetPath, wb };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function assertNoBusinessWrite(s: Fixture, writes: number) {
  expect(s.storage.writes).toBe(writes);
  for (const name of ['submitInterferenceReceipt', 'adoptInterferenceReceipt', 'cancelInterferenceReceipt', 'confirmPlanningReceipt', 'commitResources'] as const) expect(previewService[name]).not.toHaveBeenCalled();
  s.wb.assertNoWrites();
}

describe('规划到 GIS 干扰分析精确入口', () => {
  it('真实按钮精确进入已确认方案，返回同方案，不提交分析或写业务', async () => {
    const s = await fixture(), writes = s.storage.writes;
    expect(button(s.root, '进入干扰分析').props.disabled).toBe(false);
    await click(s.root, '进入干扰分析');
    await settleWorkbench();
    expect(s.router.currentRoute.value.fullPath).toBe(s.targetPath()); expect(s.store.taskContext).toEqual(s.wb.target); expect(s.store.analysisId).toBe('');
    expect(s.wb.workbench.getContext).toHaveBeenCalledWith({ task_id: s.plan.taskId }, expect.any(AbortSignal));
    expect(find(s.root, n => n.props.class === 'analysis-panel')).toBeDefined();
    await click(s.root, '返回规划方案'); expect(s.router.currentRoute.value.fullPath).toBe(s.planningPath); expect(s.planning.selectedPlan?.id).toBe(s.plan.id);
    assertNoBusinessWrite(s, writes);
  });
  it('仅干扰源变化沿现有资格进入，不把 current=false 当作不可分析', async () => {
    const s = await fixture({ interferenceOnly: true }); expect(s.planning.selectedPlan?.current).toBe(false);
    await click(s.root, '进入干扰分析'); await settleWorkbench(); expect(s.store.taskContext).toEqual(s.wb.target); expect(textOf(s.root)).toContain('仅因干扰源修改失效'); s.wb.assertNoWrites();
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
    s.wb.source.eligible = false; s.wb.source.unavailable_reasons = ['该确认版本已被替换'];
    await click(s.root, '进入干扰分析'); expect(s.router.currentRoute.value.path).toBe('/planning'); expect(textOf(s.root)).toContain('该确认版本已被替换');
  });
  it.each(['task','plan','version'] as const)('服务返回%s身份变化不能进入另一个冻结来源',async kind=>{
    const s=await fixture();
    if(kind==='task')s.wb.source.task_id='UNIT-OTHER-TASK';
    if(kind==='plan')s.wb.source.plan_id='UNIT-OTHER-PLAN';
    if(kind==='version')s.wb.source.plan_version='V999';
    await click(s.root,'进入干扰分析');expect(s.router.currentRoute.value.path).toBe('/planning');
    expect(textOf(s.root)).toContain('所选确认方案已不存在或版本已变化');s.wb.assertNoWrites();
  });
  it('旧历史 B 不覆盖目标 A，刷新和焦点恢复仍保持 A 的分析输入', async () => {
    const s = await fixture(), oldTarget={taskId:s.plan.taskId,planId:'UNIT-HISTORY-B',planVersion:'V2'};
    s.wb.context.source_options.push({...s.wb.source,plan_id:oldTarget.planId,plan_version:oldTarget.planVersion});
    s.wb.run.plan_id=oldTarget.planId;s.wb.run.plan_version=oldTarget.planVersion;
    s.wb.run.source.planId=oldTarget.planId;s.wb.run.source.planVersion=oldTarget.planVersion;
    s.wb.run.source.planSnapshot.planId=oldTarget.planId;s.wb.run.source.planSnapshot.planVersion=oldTarget.planVersion;
    s.store.bindServices(s.wb); expect(await s.store.enterPlan(oldTarget)).toBe(true); await s.store.selectRun(s.wb.run.run_id);
    expect(s.store.selected?.plan_id).toBe(oldTarget.planId);
    const writes = s.storage.writes; await click(s.root, '进入干扰分析');
    await settleWorkbench(); expect(s.store.taskContext).toEqual(s.wb.target); expect(s.store.selected).toBeNull(); expect(s.store.historyTotal).toBe(1);
    await s.store.load(); window.dispatchEvent(new Event('focus')); await settle();
    expect(s.store.taskContext).toEqual(s.wb.target); expect(s.store.analysisId).toBe(''); assertNoBusinessWrite(s, writes);
  });
  it.each(['same', 'other'])('%s 方案正在分析时复用原运行或阻止切换，不取消任务', async kind => {
    const s = await fixture({ second: true }), target = kind === 'same' ? s.plan : s.second!;
    s.wb.context.active_run_ids = [s.wb.run.run_id]; s.wb.run.state = 'RUNNING'; s.wb.run.progress = 30; s.wb.run.result = null; s.wb.run.result_hash = null; s.wb.run.plan_id = target.id;
    const writes = s.storage.writes;
    await click(s.root, '进入干扰分析');
    if (kind === 'same') {
      await settleWorkbench(); expect(s.store.taskContext).toEqual(s.wb.target); expect(s.store.selected).toBeNull();
      await clickWorkbench(s.root, row => workbenchText(row).trim().startsWith('历史 '));
      await clickWorkbench(s.root, row => String(row.props.class).includes('history-row'));
      expect(s.store.analysisId).toBe(s.wb.run.run_id); expect(s.store.selected?.plan_id).toBe(s.plan.id);
    }
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
    const s = await fixture(), response = await s.wb.workbench.getContext({ task_id: s.plan.taskId }), late = deferred<typeof response>();
    s.wb.workbench.getContext.mockReturnValueOnce(late.promise);
    const pending = button(s.root, '进入干扰分析').props.onClick(); await settle();
    if (kind === 'selection') s.planning.step = 1;
    if (kind === 'permission') s.auth.accept({ ...s.auth.identity!, permissions: s.auth.identity!.permissions.filter(p => p !== 'situation.view') });
    if (kind === 'leave') await s.router.push('/elsewhere');
    if (kind === 'unmount') { app?.unmount(); app = undefined; }
    late.resolve(response); await pending; await settle(); expect(s.router.currentRoute.value.path).not.toBe('/situation'); s.wb.assertNoWrites();
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
    await settleWorkbench(); expect(textOf(s.root)).toContain('目标方案不存在或不属于指定任务'); expect(button(s.root, '返回规划方案')).toBeUndefined(); assertNoBusinessWrite(s, writes);
  });
  it.each(['cancel', 'failed-save', 'discard'] as const)('GIS 同页深链 %s 保留原资源决定', async choice => {
    const s = await fixture({ path: '/situation' }); await useResourceReadStore().activate('gis'); await s.gis.begin(); await s.editor.openForm('station', 'ND-0100');
    s.editor.form!.fields.name = 'GIS 未保存输入'; s.editor.applyForm(); if (choice === 'failed-save') s.storage.failWrite = true;
    await s.router.push(s.targetPath()); await settle(); expect(s.editor.decision).not.toBeNull(); s.editor.answer(choice === 'failed-save' ? 'save' : choice); await settle();
    if(choice==='failed-save')await vi.waitFor(()=>expect(s.gis.busy||s.editor.busy).toBe(false));
    if (choice === 'discard') { await settleWorkbench(); expect(s.store.taskContext).toEqual(s.wb.target); expect(button(s.root, '返回规划方案')).toBeDefined(); }
    else { expect(s.gis.dirty).toBe(true); expect(button(s.root, '返回规划方案')).toBeUndefined(); expect(textOf(s.root)).toContain('当前现场已保留'); }
  });
  it.each(['route','permission','session'] as const)('GIS %s 变化后迟到回调不接纳旧目标', async kind => {
    const s = await fixture({ path: '/situation' }), response = structuredClone(s.wb.plan), late = deferred<typeof response>();
    vi.mocked(previewService.getPlanningPlan).mockReturnValueOnce(late.promise);
    await s.router.push(s.targetPath()); await settle();
    if(kind==='route')await s.router.push('/situation');
    if(kind==='permission')s.auth.accept({...s.auth.identity!,permissions:s.auth.identity!.permissions.filter(p=>p!=='planning.view')});
    if(kind==='session')s.auth.accept({...s.auth.identity!,sessionId:'changed-session'});
    if(kind==='session')await s.router.push('/elsewhere');
    late.resolve(response); await settleWorkbench();
    expect(button(s.root, '返回规划方案')).toBeUndefined(); expect(s.gis.mapMode).toBe('resource');
  });
  it('GIS 返回等待资源决定时换号，旧返回不能离页或丢失资源输入', async()=>{
    const s=await fixture();await click(s.root,'进入干扰分析');
    await s.gis.begin();await s.editor.openForm('station','ND-0100');s.editor.form!.fields.name='返回前的资源输入';s.editor.applyForm();
    const pending=button(s.root,'返回规划方案').props.onClick();await settle();expect(s.editor.decision).not.toBeNull();
    s.auth.accept({...s.auth.identity!,sessionId:'other-session'});s.editor.answer('discard');await pending;await settle();
    expect(s.router.currentRoute.value.path).toBe('/situation');expect(s.gis.dirty).toBe(true);
  });
  it('新版冻结工作区场景草稿取消离开时保留输入，不隐式保存或取消运行',async()=>{
    const s=await fixture();await click(s.root,'进入干扰分析');await settleWorkbench();
    s.store.draft.name='保留场景草稿';await clickWorkbench(s.root,'返回当前资源');
    expect(find(s.root,row=>row.props['aria-label']==='数据库冻结方案')).toBeDefined();expect(s.store.draft.name).toBe('保留场景草稿');
    expect(window.confirm).toHaveBeenCalled();s.wb.assertNoWrites();
  });
  it('分析提交超时保留原号，取消离开不重试/取消，明确离开仍不取消服务器任务',async()=>{
    const s=await fixture();await click(s.root,'进入干扰分析');await settleWorkbench();
    await s.store.selectScene({sceneId:s.wb.scene.sceneId,versionId:s.wb.scene.versionId});
    s.wb.workbench.submitRun.mockRejectedValueOnce(new Error('传输超时，受理待核实'));
    await clickWorkbench(s.root,'提交干扰分析');expect(s.store.pendingWrites).toHaveLength(1);
    const request=s.store.pendingWrites[0]!.request_id;
    await clickWorkbench(s.root,'返回当前资源');expect(s.store.pendingWrites[0]!.request_id).toBe(request);
    expect(find(s.root,row=>row.props['aria-label']==='数据库冻结方案')).toBeDefined();
    vi.mocked(window.confirm).mockReturnValue(true);await clickWorkbench(s.root,'返回当前资源');
    expect(find(s.root,row=>row.props['aria-label']==='数据库冻结方案')).toBeUndefined();
    expect(s.wb.workbench.submitRun).toHaveBeenCalledTimes(1);expect(s.wb.workbench.cancelRun).not.toHaveBeenCalled();
    expect(s.wb.workbench.getOperation).not.toHaveBeenCalled();expect(s.store.pendingWrites[0]!.request_id).toBe(request);
  });
});

describe('P02 M5 任务编辑返回真实页面命令', () => {
  async function editFixture() {
    const s = await fixture();
    await s.router.push({path:'/planning',query:{taskId:s.plan.taskId,editTask:'1'}});await settleWorkbench();
    expect(s.planning.step).toBe(1);expect(s.task.saved?.taskId).toBe(s.plan.taskId);
    return s;
  }
  it('只保存指定任务再回 GIS，同任务回读，不提交规划或保存资源', async () => {
    const s=await editFixture(), taskId=s.task.taskId;
    s.task.updateInput({...structuredClone(toRaw(s.task.draft!)),name:'GIS 编辑保存回读'});
    await clickWorkbench(s.root,'保存任务并返回 GIS');
    expect(s.router.currentRoute.value.path).toBe('/situation');expect(s.router.currentRoute.value.query).toEqual({taskId});
    expect(previewService.saveTaskInputReceipt).toHaveBeenCalledTimes(1);
    expect(previewService.saveTaskInputReceipt).toHaveBeenCalledWith(expect.objectContaining({context:'planning',taskId,input:expect.objectContaining({name:'GIS 编辑保存回读'})}));
    expect(previewService.getTaskInput).toHaveBeenCalledWith(expect.objectContaining({context:'gis',taskId}));
    for(const name of ['saveResourceChanges','commitResources','submitPlanningReceipt'] as const)expect(previewService[name]).not.toHaveBeenCalled();
    s.wb.assertNoWrites();
  });
  it('保存被拒绝保留任务输入，返回按钮仍走原取消/放弃决定', async () => {
    const s=await editFixture();s.task.updateInput({...structuredClone(toRaw(s.task.draft!)),name:'失败后保留'});
    vi.mocked(previewService.saveTaskInputReceipt).mockRejectedValueOnce(new ApiError('任务版本冲突','VERSION_CONFLICT'));
    await clickWorkbench(s.root,'保存任务并返回 GIS');expect(s.router.currentRoute.value.path).toBe('/planning');
    expect(s.task.draft?.name).toBe('失败后保留');expect(textOf(s.root)).toContain('任务版本冲突');
    const leaving=button(s.root,'返回 GIS 任务').props.onClick();await settleWorkbench();
    expect(s.task.decision).not.toBeNull();s.task.answer('cancel');await leaving;
    expect(s.router.currentRoute.value.path).toBe('/planning');expect(s.task.draft?.name).toBe('失败后保留');s.wb.assertNoWrites();
  });
  it('保存等待时换会话，晚回执不导航或覆盖新现场', async () => {
    const s=await editFixture();s.task.updateInput({...structuredClone(toRaw(s.task.draft!)),name:'等待保存'});
    const late=deferred<Awaited<ReturnType<typeof previewService.saveTaskInputReceipt>>>();
    vi.mocked(previewService.saveTaskInputReceipt).mockReturnValueOnce(late.promise);
    const pending=button(s.root,'保存任务并返回 GIS').props.onClick();await settleWorkbench();
    const request=vi.mocked(previewService.saveTaskInputReceipt).mock.calls.at(-1)![0];
    s.auth.accept({...s.auth.identity!,sessionId:'GIS-M5-next-session'});
    const before=JSON.stringify(s.task.draft);
    late.resolve({taskId:request.taskId,revision:'UNIT-ACCEPTED',inputVersion:'UNIT-INPUT-2',conditionVersion:'UNIT-CONDITION-2',
      resourceRevision:request.resourceRevision,updatedAt:'2026-10-23T08:00:00Z',name:request.input.name,objectId:request.taskId,changed:true});
    await pending;await settleWorkbench();expect(s.router.currentRoute.value.path).toBe('/planning');expect(JSON.stringify(s.task.draft)).toBe(before);s.wb.assertNoWrites();
  });
});

describe('分析导航参数白名单', () => {
  it('仅接受成对分析身份，保留不透明 ID 的编码', () => { expect(safeReturnPath('/situation?analysisTaskId=task%3A1&analysisPlanId=plan%2F2')).toBe('/situation?analysisTaskId=task%3A1&analysisPlanId=plan%2F2'); });
  it.each(['analysisTaskId=T', 'analysisPlanId=P', 'analysisTaskId=T&analysisPlanId=P&taskId=T', 'analysisTaskId=T&analysisPlanId=P&stationId=N', 'analysisTaskId=T&analysisPlanId=P&diagnosisId=D', 'analysisTaskId=T&analysisPlanId=P&faultEdit=1', 'analysisTaskId=T&analysisPlanId=P&analysisPlanId=Q'])('拒绝 %s', query => { expect(safeReturnPath('/situation?' + query)).toBeNull(); });
});
