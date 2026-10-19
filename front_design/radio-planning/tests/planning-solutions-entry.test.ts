import { afterEach,beforeEach,beforeAll,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer,h,nextTick,ssrContextKey,type App,type Component,type ComponentOptions } from 'vue';
import { parse,compileScript,compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { createMemoryHistory,createRouter,RouterView } from 'vue-router';
import PlanningView from '../src/views/PlanningView.vue';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import PlanningSolutionsPanel from '../src/components/PlanningSolutionsPanel.vue';
import PlanningOptionsSummary from '../src/components/PlanningOptionsSummary.vue';
import PlanningOptimizationPanel from '../src/components/PlanningOptimizationPanel.vue';
import PlanningApiResultPanel from '../src/components/PlanningApiResultPanel.vue';
import PlanningApiVersionsPanel from '../src/components/PlanningApiVersionsPanel.vue';
import PlanningProgressPanel from '../src/components/PlanningProgressPanel.vue';
import PlanningMetricPanel from '../src/components/PlanningMetricPanel.vue';
import PlanningApiProgressPanel from '../src/components/PlanningApiProgressPanel.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { usePlanningStore } from '../src/stores/planning';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceReadStore } from '../src/stores/resource-read';
import { optionsPlanningPresets } from '../src/mocks/planning-options-presets';
import { ApiError } from '../src/services/types';
import { TestStorage } from './helpers/storage';
import { savedRequest } from './helpers/tasks';
import { authorizeStore } from './helpers/auth';
import { apiJob,apiPlan,storeFixture } from './fixtures/planning-api';
vi.mock('../src/components/PlanningAdjustmentDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/PlanningAdjustmentPreview.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/TaskWorkspacePanel.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/TaskApiPanel.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/DeploymentConstraintsSummary.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/PlanningCandidatePanel.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/ResourceReadStatus.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/PlanComparisonPanel.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/PlanExportDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/PlanningApiFeedback.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/MapCanvas.vue',async()=>{const {h}=await import('vue');return{default:{inheritAttrs:false,props:['stations','links','planningOverlay','mockCoverage','selectedLinkId'],setup:(p:any,{expose}:any)=>{const locate=vi.fn();expose({locateResource:locate});return()=>h('map-probe',{...p,locate});}}};});
vi.mock('../src/components/ChartCanvas.vue',async()=>{const {h}=await import('vue');return{default:{props:['option'],setup:(p:any)=>()=>h('chart-probe',{option:p.option})}};});
vi.mock('../src/components/AppTable.vue',async()=>{const {h}=await import('vue');return{default:{props:['rows','columns'],setup:(p:any,{slots}:any)=>()=>h('table-probe',{rows:p.rows},p.rows.flatMap((row:any)=>slots.actions?.({row})??[]))}};});
vi.mock('../src/components/AppDrawer.vue',async()=>{const {h}=await import('vue');return{default:{props:['visible','title'],setup:(p:any,{slots}:any)=>()=>p.visible?h('drawer-probe',{title:p.title},[slots.default?.(),slots.footer?.()]):null}};});
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'resource-ledger-render.ts', { loader: 'ts' });
  (component as ComponentOptions).render = new Function('Vue', code + ';return createRender(Vue);')(Vue);
}
interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown; readonly options: HostNode[];
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
  get options() { return this.children.filter(child => child.tag === 'option'); },
  addEventListener() {}, removeEventListener() {}, getRootNode: () => document });
function remove(child: HostNode) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null; }
function insert(child: HostNode, parent: HostNode, anchor?: HostNode | null) {
  remove(child); child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1;
  parent.children.splice(i < 0 ? parent.children.length : i, 0, child);
}
const renderer = createRenderer<HostNode, HostNode>({
  insert, remove, createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (el, text) => { el.text = text; }, setElementText: (el, text) => { el.text = text; el.children = []; },
  parentNode: el => el.parent, nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp: (el, key, _old, value) => { el.props[key] = value; },
  insertStaticContent: (text, parent, anchor) => { const el = node('#static', text); insert(el, parent, anchor); return [el, el]; },
});
function find(root: HostNode, predicate: (n: HostNode) => boolean): HostNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const hit = find(child, predicate); if (hit) return hit; }
}
function all(root: HostNode, predicate: (n: HostNode) => boolean): HostNode[] {
  return [...(predicate(root) ? [root] : []),...root.children.flatMap(child => all(child,predicate))];
}
const textOf = (root: HostNode): string => root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


let app:App|undefined,pinia:ReturnType<typeof createPinia>|undefined;
// Vue v-model 需要文档类型判断，内存渲染器不提供真实浏览器。
beforeEach(()=>{vi.stubGlobal('Document',class {});vi.stubGlobal('ShadowRoot',class {});});
beforeAll(async()=>{for(const [component,path] of [[PlanningMetricPanel,'components/PlanningMetricPanel'],[PlanningView,'views/PlanningView'],[PlanningApiView,'views/PlanningApiView'],[PlanningSolutionsPanel,'components/PlanningSolutionsPanel'],[PlanningOptionsSummary,'components/PlanningOptionsSummary'],[PlanningOptimizationPanel,'components/PlanningOptimizationPanel'],[PlanningApiResultPanel,'components/PlanningApiResultPanel'],[PlanningApiVersionsPanel,'components/PlanningApiVersionsPanel'],[PlanningProgressPanel,'components/PlanningProgressPanel'],[PlanningApiProgressPanel,'components/PlanningApiProgressPanel']] as const)await clientTemplate(component,'src/'+path+'.vue');});
afterEach(()=>{app?.unmount();app=undefined;if(pinia){usePlanningApiStore().clearForSession();usePlanningStore().clearForSession();disposePinia(pinia);}pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();});
const multi=()=>{const job=apiJob();job.solutions=[1,2].map(n=>({solutionId:'solution-'+n,label:'完整结果'+n,radioCount:0,result:{...structuredClone(job.result!),snapshotId:'S'+n,metrics:{...job.result!.metrics,totalRadiatedPowerW:n*10}},outcome:structuredClone(job.outcome!),savedPlanId:null,expired:false}));job.defaultSolutionId='solution-1';job.result=structuredClone(job.solutions[0].result);return job;};
async function mount(component:Component){const router=createRouter({history:createMemoryHistory(),routes:[{path:'/planning',component},{path:'/other',component:{render:()=>null}}]});await router.push('/planning');await router.isReady();app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia!);app.use(router);app.provide(ssrContextKey,{modules:new Set()});const root=node('root');app.mount(root);await settle();return{root,router};}
async function apiEntry(){vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',{activeElement:null});const s=await storeFixture();pinia=s.pinia;vi.spyOn(s.resources,'activate').mockResolvedValue(true);vi.spyOn(s.task,'initialize').mockResolvedValue();const planning=usePlanningApiStore();vi.spyOn(planning,'start').mockImplementation(()=>{});await nextTick();planning.job=multi();planning.step=2;return{...s,planning,...await mount(PlanningApiView)};}
async function mockEntry(id='options-min'){vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',{activeElement:null});pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore(),storage=new TestStorage(),raw=createMockService(()=>storage);for(const [name,method] of Object.entries(raw))if(typeof method==='function')vi.spyOn(previewService as any,name).mockImplementation(method);let time=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>time);const input=structuredClone(optionsPlanningPresets.find(p=>p.id===id)!.input);const submitted=await raw.submitPlanning(await savedRequest(storage,{input,taskId:'multi-task',baseRevision:'initial',requestId:'submit',parentPlanVersionId:null}));time+=20000;const preview=usePreviewStore();preview.data=await raw.loadPreview();const planning=usePlanningStore();planning.workspace=submitted.workspace;planning.view=await raw.getPlanningJob(submitted.view.job.id);planning.jobId=planning.view.job.id;planning.draft=structuredClone(input);planning.baseline=structuredClone(input);planning.taskId=planning.view.job.taskId;planning.baselineTaskId=planning.taskId;planning.step=2;vi.spyOn(planning,'startPolling').mockResolvedValue();return{auth,raw,storage,planning,...await mount(PlanningView)};}
const map=(root:HostNode)=>find(root,n=>n.tag==='map-probe')!;
// 页面真实选择与服务状态一起验证，地图绘制替身只记录收到的冻结数据。
describe('多份完整结果页面闭环',()=>{
  it('Mock保存草稿按结果保留，明确放弃后不得再次恢复',async()=>{
    const s=await mockEntry(),rows=s.planning.view!.solutions!;
    const name=()=>find(s.root,n=>n.tag==='input'&&n.props.maxlength==='60')!;
    await click(s.root,'保存方案版本');(name().props['onUpdate:modelValue'] as Function)('A草稿');await settle();await click(s.root,'取消');
    s.planning.selectSolution(rows[1].solutionId);await settle();await click(s.root,'保存方案版本');(name().props['onUpdate:modelValue'] as Function)('B草稿');await settle();await click(s.root,'取消');
    s.planning.selectSolution(rows[0].solutionId);await settle();await click(s.root,'保存方案版本');expect(name().value).toBe('A草稿');await click(s.root,'取消');expect(s.planning.auxiliaryDirty).toBe(true);
    const leave=s.planning.allowDiscard();s.planning.answer('discard');expect(await leave).toBe(true);await settle();await click(s.root,'保存方案版本');expect(name().value).toBe(s.planning.view!.job.input.name);
  });
  it('Mock切换使地图、频率、指标与保存对象同步，旧选择事件失效',async()=>{const s=await mockEntry(),rows=s.planning.view!.solutions!,old=find(s.root,n=>n.tag==='button'&&textOf(n)===rows[0].label)!.props.onClick as Function;await click(s.root,rows[1].label);expect(s.planning.currentResult!.metrics.totalRadiatedPowerW).toBe(60);expect(map(s.root).props.links).toEqual(rows[1].result!.links);expect(map(s.root).props.mockCoverage).toEqual(rows[1].result!.coverage);old();await settle();expect(s.planning.selectedSolutionId).toBe(rows[1].solutionId);expect(await s.planning.save('第二份','说明B')).toBe(true);expect(s.planning.selectedPlan?.solutionId).toBe(rows[1].solutionId);s.planning.selectSolution(rows[0].solutionId);await settle();expect(s.planning.savedCurrent).toBeUndefined();expect(await s.planning.save('第一份','说明A')).toBe(true);expect(s.planning.workspace!.plans.map(p=>p.solutionId)).toEqual([rows[1].solutionId,rows[0].solutionId]);});
  it('HTTP切换选择后轮询保持选择，过期B显示空图并禁止保存',async()=>{const s=await apiEntry();await click(s.root,'完整结果2');expect(s.planning.result!.metrics.totalRadiatedPowerW).toBe(20);const next=multi();next.solutions![1].expired=true;next.solutions![1].result=null;vi.spyOn(previewService,'getPlanningTask').mockResolvedValue(next);await s.planning.refreshJob();await settle();expect(s.planning.selectedSolutionId).toBe('solution-2');expect(s.planning.result).toBeNull();expect(s.planning.canSave).toBe(false);expect((map(s.root).props.planningOverlay as any).nodes).toEqual([]);expect(textOf(s.root)).toContain('未保存结果已过期');});
  it('HTTP待核实保存冻结B身份，错误A回执不能释放，正确B才恢复',async()=>{const s=await apiEntry();s.planning.selectSolution('solution-2');vi.spyOn(previewService,'savePlanningPlan').mockRejectedValue(new ApiError('断线','NETWORK_ERROR'));await s.planning.savePlan('保存B','说明B');expect(s.planning.pending).toMatchObject({solutionId:'solution-2',snapshotId:'S2',jobId:'J1'});expect(s.planning.selectSolution('solution-1')).toBe(false);const pending=s.planning.pending!;vi.spyOn(previewService,'getPlanningOperation').mockResolvedValue({...pending,state:'SUCCEEDED',entityId:'P-2',message:'已保存'});const plan={...apiPlan('P-2'),name:'保存B',note:'说明B',solutionId:'solution-1',solutionLabel:'第一份',radioCount:0};const get=vi.spyOn(previewService,'getPlanningPlan').mockResolvedValue(plan);await s.planning.reconcile();expect(s.planning.pending).not.toBeNull();get.mockResolvedValue({...plan,solutionId:'solution-2',solutionLabel:'第二份',result:{...plan.result,snapshotId:'S2'}});await s.planning.reconcile();expect(s.planning.pending).toBeNull();expect(s.planning.selectedPlan!.solutionId).toBe('solution-2');expect(s.planning.job!.solutions![0].savedPlanId).toBeNull();expect(s.planning.job!.solutions![1].savedPlanId).toBe('P-2');});
  it('Mock成功但丢失回包后核实原请求，不能切换或重复保存',async()=>{const s=await mockEntry(),selected=s.planning.view!.solutions![1];s.planning.selectSolution(selected.solutionId);vi.spyOn(previewService,'savePlanVersion').mockImplementation(async request=>{await s.raw.savePlanVersion(request);throw new ApiError('丢失回包','NETWORK_ERROR');});expect(await s.planning.save('B','说明')).toBe(false);expect(s.planning.savePending?.solutionId).toBe(selected.solutionId);expect(s.planning.selectSolution(s.planning.view!.solutions![0].solutionId)).toBe(false);await s.planning.reconcileSave();expect(s.planning.savePending).toBeNull();expect(s.planning.selectedPlan!.solutionId).toBe(selected.solutionId);expect(s.planning.workspace!.plans).toHaveLength(1);});
  it('保存说明按结果分别保留，HTTP页离开标记覆盖未选中的草稿',async()=>{const s=await apiEntry();s.planning.step=3;await settle();let name=find(s.root,n=>n.tag==='input'&&n.props.maxlength==='60')!;(name.props['onUpdate:modelValue'] as Function)('A的未保存名称');await settle();s.planning.selectSolution('solution-2');s.planning.step=3;await settle();name=find(s.root,n=>n.tag==='input'&&n.props.maxlength==='60')!;(name.props['onUpdate:modelValue'] as Function)('B的未保存名称');await settle();expect(s.task.auxiliary.planSave).toBe(true);s.planning.selectSolution('solution-1');s.planning.step=3;await settle();name=find(s.root,n=>n.tag==='input'&&n.props.maxlength==='60')!;expect(name.value).toBe('A的未保存名称');});
  it('关键链路由服务声明定位，切换结果后旧按钮无效',async()=>{const s=await mockEntry('options-bridge');await click(s.root,'优化权衡');const locate=find(s.root,n=>n.tag==='button'&&textOf(n)==='定位链路')!.props.onClick as Function;locate();await settle();expect(map(s.root).props.selectedLinkId).toBe('LINK-A');expect(map(s.root).props.locate).toHaveBeenCalled();await click(s.root,'路由结果');locate();await settle();expect(map(s.root).props.selectedLinkId).toBe('');});
});

