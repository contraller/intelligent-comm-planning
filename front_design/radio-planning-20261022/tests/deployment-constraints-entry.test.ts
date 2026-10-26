import { afterEach,describe,expect,it,vi } from 'vitest';
import { h,nextTick,ssrContextKey,type App,type Component } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { createMemoryHistory,createRouter,RouterView } from 'vue-router';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import SituationView from '../src/views/SituationView.vue';
import DeploymentConstraintsSummary from '../src/components/DeploymentConstraintsSummary.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { usePreviewStore } from '../src/stores/preview';
import { usePlanningStore } from '../src/stores/planning';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useTaskInputStore } from '../src/stores/task-input';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { deploymentPlanningPresets } from '../src/mocks/deployment-constraint-presets';
import { authorizeStore } from './helpers/auth';
import { savedRequest } from './helpers/tasks';
import { TestStorage } from './helpers/storage';
// 编译与同型基础宿主复用公共工具，保留本文件的事件和生命周期。
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
import { storeFixture,apiPlan,apiTask } from './fixtures/planning-api';
import type { DeploymentConstraintFrame } from '../src/types/deployment-constraints';
const mode = vi.hoisted(() => ({ value: 'mock' }));
vi.mock('../src/config/env', async original => { const module = await original<typeof import('../src/config/env')>(); return { ...module, env: { ...module.env, get mode() { return mode.value; } } }; });
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
vi.mock('../src/components/ResourceExportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceReadStatus.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceStatusPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SituationMonitoringDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/StatusBadge.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/TaskApiPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisTaskPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


for(const [c,f] of [[PlanningApiView,'views/PlanningApiView'],[SituationView,'views/SituationView'],[DeploymentConstraintsSummary,'components/DeploymentConstraintsSummary']] as const)await clientTemplate(c,'src/'+f+'.vue', 'resource-ledger-render.ts');
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();mode.value='mock';app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
const input=()=>structuredClone(deploymentPlanningPresets[0].input);
function environment(){vi.useFakeTimers({toFake:['setInterval','clearInterval']});vi.stubGlobal('window',new EventTarget());class Doc extends EventTarget{hidden=false;activeElement=null;}vi.stubGlobal('Document',Doc);vi.stubGlobal('document',new Doc());}
async function mount(component:Component,path='/planning'){const router=createRouter({history:createMemoryHistory(),routes:[{path:path.split('?')[0],component},{path:'/other',component:{render:()=>null}}]});await router.push(path);await router.isReady();app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia!);app.use(router);app.provide(ssrContextKey,{});const root=node('root');app.mount(root);await settle();return{root,router};}
const frame=(root:HostNode)=>find(root,n=>n.tag==='map-probe')!.props.deploymentConstraints as DeploymentConstraintFrame|null;
async function mockState(){environment();pinia=createPinia();setActivePinia(pinia);authorizeStore();const storage=new TestStorage(),raw=createMockService(()=>storage);for(const [name,method]of Object.entries(raw))if(typeof method==='function')vi.spyOn(previewService as any,name).mockImplementation(method);const preview=usePreviewStore();await preview.load();return{storage,raw,preview,planning:usePlanningStore()};}
describe('部署约束真实页面来源切换',()=>{
 it('Mock规划草稿和冻结版本分别读取条件，第三步不补当前值',async()=>{
  const s=await mockState();let time=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>time);
  const run=await s.raw.submitPlanning(await savedRequest(s.storage,{baseRevision:'initial',requestId:'run',taskId:'T',parentPlanVersionId:null,input:input()}));time+=20000;
  const saved=await s.raw.savePlanVersion({baseRevision:run.workspace.revision,jobId:run.view.job.id,requestId:'save',name:'部署方案',note:''});
  // 当前页面按保存方案身份读取冻结约束，任务草稿独立保留。
  await useResourceReadStore().activate('planning');const task=useTaskInputStore();await task.initialize('planning');await task.open(saved.plan.taskId,false);
  const planning=usePlanningApiStore();await nextTick();planning.selectedPlan=await s.raw.getPlanningPlan({context:'planning',taskId:saved.plan.taskId,planId:saved.plan.id});planning.step=2;
  const {root}=await mount(PlanningApiView);expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
  task.draft!.deploymentConstraints!.maxSlopeDeg=30;await nextTick();expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
  planning.step=1;await nextTick();expect(frame(root)!.constraints!.maxSlopeDeg).toBe(30);
  planning.step=3;await nextTick();const summary=find(root,n=>n.props.class==='deployment-summary')!;expect(textOf(find(summary,n=>n.tag==='dd')!)).toBe('18');
 });
 it('HTTP规划读取选定方案输入，旧历史缺项仍未设置',async()=>{
  environment();const s=await storeFixture();pinia=s.pinia;vi.spyOn(s.resources,'activate').mockResolvedValue(true);vi.spyOn(s.task,'initialize').mockResolvedValue();
  const planning=usePlanningApiStore();vi.spyOn(planning,'start').mockImplementation(()=>{});planning.selectedPlan=apiPlan();planning.selectedPlan.input.deploymentConstraints=input().deploymentConstraints;planning.step=2;s.task.draft!.deploymentConstraints={...input().deploymentConstraints!,maxSlopeDeg:40};
  const {root}=await mount(PlanningApiView);expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
  delete planning.selectedPlan.input.deploymentConstraints;await nextTick();expect(frame(root)!.constraints).toBeUndefined();expect(textOf(root)).toContain('未设置');
  planning.step=1;await nextTick();expect(frame(root)!.constraints!.maxSlopeDeg).toBe(40);
 });
 it('HTTP GIS只读保存任务，图层开关不覆盖规划草稿或改变任务来源',async()=>{
  mode.value='http';environment();const s=await storeFixture();pinia=s.pinia;s.task.draft!.deploymentConstraints={...input().deploymentConstraints!,maxSlopeDeg:40};
  vi.spyOn(s.resources,'activate').mockResolvedValue(true);vi.spyOn(s.task,'initialize').mockResolvedValue();
  const saved={...apiTask(),input:{...apiTask().input,deploymentConstraints:input().deploymentConstraints}};
  vi.mocked(previewService.getTaskInput).mockResolvedValue(saved);vi.mocked(previewService.queryTaskInputs).mockResolvedValue({items:[saved],total:1,pageNum:1,pageSize:10});
  // 只读选择直接读取保存版本，规划页的不同草稿留在原状态层。
  const before=JSON.stringify(s.task.draft);
  s.resources.context='gis';
  // 本例只核对任务自己的冻结输入，独立区域读取失败不改变测试身份。
  for(const name of ['loadGisResourceDirectory','loadGisResourceScene','loadInterferenceWorkspace','loadInterferenceContext','loadPlanningReadContext','loadMonitoringContext','loadSpectrumMonitoringContext'] as const)
    vi.spyOn(previewService,name).mockRejectedValue(new Error('本例未提供该区域资料'));
  vi.spyOn(previewService,'queryResourceDevices').mockResolvedValue({revision:'r1',pageNum:1,pageSize:10,total:0,items:[]});
   const {root,router}=await mount(SituationView,'/situation?taskId=T1');const gis=useGisWorkspaceStore();await settle();expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);expect(frame(root)!.label).toContain('已保存任务');
   expect(find(root,n=>n.tag==='button'&&textOf(n).trim()==='返回资源浏览')).toBeUndefined();
  await click(root,'图层管理');expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
  const control=find(root,n=>n.tag==='label'&&textOf(n).includes('任务通联与部署约束'))!.children.find(n=>n.tag==='input')!;
  (control.props['onUpdate:modelValue'] as Function)(false);await nextTick();expect(frame(root)).toBeNull();
   (control.props['onUpdate:modelValue'] as Function)(true);await nextTick();expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);await click(root,'资源树');expect(frame(root)).toBeNull();expect(gis.mapMode).toBe('resource');expect(router.currentRoute.value.query.taskId).toBe('T1');
  await click(root,'任务查看');expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);expect(JSON.stringify(s.task.draft)).toBe(before);expect(s.task.nodes.map(n=>n.id)).toEqual(['N1','N2']);
 });
 it('Mock GIS保存任务的区域开关和诊断快照均不混入规划草稿',async()=>{
  const s=await mockState();const saved=await s.raw.saveTask({context:'planning',taskId:'T',input:input(),baseResourceRevision:'initial',baseTaskRevision:'initial',requestId:'gis-saved-task'});
  s.planning.tasks=saved.tasks;s.planning.taskId='T';
  // 保存身份与当前草稿分离，真实打开保存任务后只改编辑现场。
  await useResourceReadStore().activate('planning');const task=useTaskInputStore();await task.initialize('planning');expect(await task.open('T',false)).toBe(true);
  task.updateInput({...input(),deploymentConstraints:{...input().deploymentConstraints!,maxSlopeDeg:40}});
  const before=JSON.stringify(task.draft);
  const {root,router}=await mount(SituationView,'/situation?taskId=T'),gis=useGisWorkspaceStore();await vi.waitFor(()=>expect(frame(root)).not.toBeNull());expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
   expect(find(root,n=>n.tag==='button'&&textOf(n).trim()==='返回资源浏览')).toBeUndefined();
   expect(JSON.stringify(task.draft)).toBe(before);await click(root,'图层管理');expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);const control=find(root,n=>n.tag==='label'&&textOf(n).includes('任务通联与部署约束'))!.children.find(n=>n.tag==='input')!;
  (control.props['onUpdate:modelValue'] as Function)(false);await nextTick();expect(frame(root)).toBeNull();(control.props['onUpdate:modelValue'] as Function)(true);await nextTick();expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);
    await click(root,'资源树');expect(frame(root)).toBeNull();expect(gis.mapMode).toBe('resource');expect(router.currentRoute.value.query.taskId).toBe('T');await click(root,'任务查看');expect(frame(root)!.constraints!.maxSlopeDeg).toBe(18);expect(JSON.stringify(task.draft)).toBe(before);
   await router.push('/situation?diagnosisId=DG-HW');await settle();expect(gis.mapMode).toBe('diagnosis');expect(frame(root)).toBeNull();expect(JSON.stringify(task.draft)).toBe(before);
 });
});

