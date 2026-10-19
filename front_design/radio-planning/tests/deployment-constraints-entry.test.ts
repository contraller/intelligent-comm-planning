import { afterEach,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer,h,nextTick,ssrContextKey,type App,type Component,type ComponentOptions } from 'vue';
import { parse,compileScript,compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { createMemoryHistory,createRouter,RouterView } from 'vue-router';
import PlanningView from '../src/views/PlanningView.vue';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import SituationView from '../src/views/SituationView.vue';
import ResourceMapView from '../src/views/ResourceMapView.vue';
import DeploymentConstraintsSummary from '../src/components/DeploymentConstraintsSummary.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { usePreviewStore } from '../src/stores/preview';
import { usePlanningStore } from '../src/stores/planning';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { deploymentPlanningPresets } from '../src/mocks/deployment-constraint-presets';
import { authorizeStore } from './helpers/auth';
import { savedRequest } from './helpers/tasks';
import { TestStorage } from './helpers/storage';
import { storeFixture,apiPlan } from './fixtures/planning-api';
import type { DeploymentConstraintFrame } from '../src/types/deployment-constraints';
// 四个页面和自身作用域真实运行，地图绘制与无关面板独立测试。
vi.mock('../src/components/MapCanvas.vue',async()=>{const {h}=await import('vue');return{default:{inheritAttrs:false,props:['deploymentConstraints','planningOverlay'],setup:(p:any)=>()=>h('map-probe',{...p})}};});
vi.mock('../src/components/AppDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/AppTable.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/CandidateLinkPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DeviceCoveragePanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisDeviceClusterPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisDeviceLayerPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisDiagnosisPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisResourceTree.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisResultLayerPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisValidationPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceAnalysisPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceHistoryDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceMeasureDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceSourceDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/LinkDetailPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/MonitoringObjectPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ObjectInfoPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanComparisonPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanExportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningAdjustmentDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningAdjustmentPreview.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiFeedback.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiProgressPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiResultPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiVersionsPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningCandidatePanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningMetricPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningProgressPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceExportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceReadDetail.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceReadStatus.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceReadTree.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceStatusPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SituationMonitoringDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/StatusBadge.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/TaskApiPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/TaskWorkspacePanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
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


for(const [c,f] of [[PlanningView,'views/PlanningView'],[PlanningApiView,'views/PlanningApiView'],[SituationView,'views/SituationView'],[ResourceMapView,'views/ResourceMapView'],[DeploymentConstraintsSummary,'components/DeploymentConstraintsSummary']] as const)await clientTemplate(c,'src/'+f+'.vue');
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
const input=()=>structuredClone(deploymentPlanningPresets[0].input);
function environment(){vi.useFakeTimers({toFake:['setInterval','clearInterval']});vi.stubGlobal('window',new EventTarget());class Doc extends EventTarget{hidden=false;activeElement=null;}vi.stubGlobal('Document',Doc);vi.stubGlobal('document',new Doc());}
async function mount(component:Component,path='/planning'){const router=createRouter({history:createMemoryHistory(),routes:[{path,component},{path:'/other',component:{render:()=>null}}]});await router.push(path);await router.isReady();app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia!);app.use(router);app.provide(ssrContextKey,{});const root=node('root');app.mount(root);await settle();return{root,router};}
const frame=(root:HostNode)=>find(root,n=>n.tag==='map-probe')!.props.deploymentConstraints as DeploymentConstraintFrame|null;
async function mockState(){environment();pinia=createPinia();setActivePinia(pinia);authorizeStore();const storage=new TestStorage(),raw=createMockService(()=>storage);for(const [name,method]of Object.entries(raw))if(typeof method==='function')vi.spyOn(previewService as any,name).mockImplementation(method);const preview=usePreviewStore();await preview.load();return{storage,raw,preview,planning:usePlanningStore()};}
describe('部署约束真实页面来源切换',()=>{
 it('Mock规划草稿和冻结版本分别读取条件，第三步不补当前值',async()=>{
  const s=await mockState();let time=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>time);
  const run=await s.raw.submitPlanning(await savedRequest(s.storage,{baseRevision:'initial',requestId:'run',taskId:'T',parentPlanVersionId:null,input:input()}));time+=20000;
  const saved=await s.raw.savePlanVersion({baseRevision:run.workspace.revision,jobId:run.view.job.id,requestId:'save',name:'部署方案',note:''});
  s.preview.mergePlanning(saved.workspace.plans);s.planning.workspace=saved.workspace;s.planning.selectedPlanId=saved.plan.id;s.planning.draft=input();s.planning.baseline=input();s.planning.step=2;
  const {root}=await mount(PlanningView);expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
  s.planning.draft!.deploymentConstraints!.maxSlopeDeg=30;await nextTick();expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
  s.planning.step=1;await nextTick();expect(frame(root)!.constraints!.maxSlopeDeg).toBe(30);
  s.planning.step=3;await nextTick();const summary=find(root,n=>n.props.class==='deployment-summary')!;expect(textOf(find(summary,n=>n.tag==='dd')!)).toBe('18');
 });
 it('HTTP规划读取选定方案输入，旧历史缺项仍未设置',async()=>{
  environment();const s=await storeFixture();pinia=s.pinia;vi.spyOn(s.resources,'activate').mockResolvedValue(true);vi.spyOn(s.task,'initialize').mockResolvedValue();
  const planning=usePlanningApiStore();vi.spyOn(planning,'start').mockImplementation(()=>{});planning.selectedPlan=apiPlan();planning.selectedPlan.input.deploymentConstraints=input().deploymentConstraints;planning.step=2;s.task.draft!.deploymentConstraints={...input().deploymentConstraints!,maxSlopeDeg:40};
  const {root}=await mount(PlanningApiView);expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
  delete planning.selectedPlan.input.deploymentConstraints;await nextTick();expect(frame(root)!.constraints).toBeUndefined();expect(textOf(root)).toContain('未设置');
  planning.step=1;await nextTick();expect(frame(root)!.constraints!.maxSlopeDeg).toBe(40);
 });
 it('HTTP GIS 隐藏任务预览时清理输入图层，重新打开保留草稿',async()=>{
  environment();const s=await storeFixture();pinia=s.pinia;s.task.draft!.deploymentConstraints=input().deploymentConstraints;
  vi.spyOn(s.resources,'activate').mockResolvedValue(true);vi.spyOn(s.task,'initialize').mockResolvedValue();
  const {root}=await mount(ResourceMapView,'/situation');expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
  await click(root,'返回资源树');expect(frame(root)).toBeNull();await click(root,'任务输入');expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);expect(s.task.nodes.map(n=>n.id)).toEqual(['N1','N2']);
 });
 it('Mock GIS 任务开关与诊断快照都隔离当前输入层',async()=>{
  const s=await mockState();s.planning.draft=input();s.planning.baseline=input();s.planning.taskId='T';
  const {root,router}=await mount(SituationView,'/situation'),gis=useGisWorkspaceStore();gis.mapMode='resource';await settle();expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
  await click(root,'图层管理');const control=find(root,n=>n.tag==='label'&&textOf(n).includes('任务通联需求'))!.children.find(n=>n.tag==='input')!;
  (control.props['onUpdate:modelValue'] as Function)(false);await nextTick();expect(frame(root)).toBeNull();(control.props['onUpdate:modelValue'] as Function)(true);await nextTick();expect(frame(root)).not.toBeNull();
  await router.push('/situation?diagnosisId=DG-HW');await settle();expect(gis.mapMode).toBe('diagnosis');expect(frame(root)).toBeNull();expect(s.planning.draft!.deploymentConstraints!.maxSlopeDeg).toBe(18);
 });
});

