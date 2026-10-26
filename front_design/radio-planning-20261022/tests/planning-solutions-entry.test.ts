import { afterEach,beforeEach,beforeAll,describe,expect,it,vi } from 'vitest';
import { h,nextTick,ssrContextKey,toRaw,type App,type Component } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { createMemoryHistory,createRouter,RouterView } from 'vue-router';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import PlanningSolutionsPanel from '../src/components/PlanningSolutionsPanel.vue';
import PlanningOptionsSummary from '../src/components/PlanningOptionsSummary.vue';
import PlanningOptimizationPanel from '../src/components/PlanningOptimizationPanel.vue';
import PlanningApiResultPanel from '../src/components/PlanningApiResultPanel.vue';
import PlanningApiVersionsPanel from '../src/components/PlanningApiVersionsPanel.vue';
import PlanningApiProgressPanel from '../src/components/PlanningApiProgressPanel.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { useTaskInputStore } from '../src/stores/task-input';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceReadStore } from '../src/stores/resource-read';
import { optionsPlanningPresets } from '../src/mocks/planning-options-presets';
import { ApiError } from '../src/services/types';
import { TestStorage } from './helpers/storage';
import { savedRequest } from './helpers/tasks';
import { authorizeStore } from './helpers/auth';
import { apiJob,apiPlan,storeFixture } from './fixtures/planning-api';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
vi.mock('../src/components/PlanningAdjustmentDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/PlanningAdjustmentPreview.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{render:()=>null}}));
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
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


let app:App|undefined,pinia:ReturnType<typeof createPinia>|undefined;
// Vue v-model 需要文档类型判断，内存渲染器不提供真实浏览器。
beforeEach(()=>{vi.stubGlobal('Document',class {});vi.stubGlobal('ShadowRoot',class {});});
beforeAll(async()=>{for(const [component,path] of [[PlanningApiView,'views/PlanningApiView'],[PlanningSolutionsPanel,'components/PlanningSolutionsPanel'],[PlanningOptionsSummary,'components/PlanningOptionsSummary'],[PlanningOptimizationPanel,'components/PlanningOptimizationPanel'],[PlanningApiResultPanel,'components/PlanningApiResultPanel'],[PlanningApiVersionsPanel,'components/PlanningApiVersionsPanel'],[PlanningApiProgressPanel,'components/PlanningApiProgressPanel']] as const)await clientTemplate(component,'src/'+path+'.vue', 'resource-ledger-render.ts');});
afterEach(()=>{app?.unmount();app=undefined;if(pinia){usePlanningApiStore().clearForSession();useTaskInputStore().clearForSession();disposePinia(pinia);}pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();});
const multi=()=>{const job=apiJob();job.solutions=[1,2].map(n=>({solutionId:'solution-'+n,label:'完整结果'+n,radioCount:0,result:{...structuredClone(job.result!),snapshotId:'S'+n,metrics:{...job.result!.metrics,totalRadiatedPowerW:n*10}},outcome:structuredClone(job.outcome!),savedPlanId:null,expired:false}));job.defaultSolutionId='solution-1';job.result=structuredClone(job.solutions[0].result);return job;};
async function mount(component:Component){const router=createRouter({history:createMemoryHistory(),routes:[{path:'/planning',component},{path:'/other',component:{render:()=>null}}]});await router.push('/planning');await router.isReady();app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia!);app.use(router);app.provide(ssrContextKey,{modules:new Set()});const root=node('root');app.mount(root);await vi.waitFor(()=>expect(usePlanningApiStore().start).toHaveBeenCalled());await settle();return{root,router};}
async function apiEntry(){vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',{activeElement:null});const s=await storeFixture();pinia=s.pinia;vi.spyOn(s.resources,'activate').mockResolvedValue(true);vi.spyOn(s.task,'initialize').mockResolvedValue();const planning=usePlanningApiStore();vi.spyOn(planning,'start').mockImplementation(()=>{});await nextTick();planning.job=multi();planning.step=2;vi.spyOn(previewService,'getPlanningTask').mockImplementation(async()=>structuredClone(toRaw(planning.job!)));return{...s,planning,...await mount(PlanningApiView)};}
async function mockEntry(id='options-min'){
  vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',{activeElement:null});pinia=createPinia();setActivePinia(pinia);
  const auth=authorizeStore(),storage=new TestStorage(),raw=createMockService(()=>storage);
  for(const [name,method] of Object.entries(raw))if(typeof method==='function')vi.spyOn(previewService as any,name).mockImplementation(method);
  let time=Date.now();vi.spyOn(Date,'now').mockImplementation(()=>time);
  const input=structuredClone(optionsPlanningPresets.find(p=>p.id===id)!.input);
  const submitted=await raw.submitPlanning(await savedRequest(storage,{input,taskId:'multi-task',baseRevision:'initial',requestId:'submit',parentPlanVersionId:null}));time+=20000;
  await usePreviewStore().load();const resources=useResourceReadStore();await resources.activate('planning');
  const task=useTaskInputStore();await task.initialize('planning');await task.open(submitted.view.job.taskId,false);
  // 当前页只加载一次已准备的任务，避免挂载期间的重复初始化干扰结果交互。
  vi.spyOn(resources,'activate').mockResolvedValue(true);vi.spyOn(task,'initialize').mockResolvedValue();
  const planning=usePlanningApiStore();vi.spyOn(planning,'start').mockImplementation(()=>{});await nextTick();
  planning.job=await raw.getPlanningTask({context:'planning',taskId:task.taskId,jobId:submitted.view.job.id});planning.step=2;
  return{auth,task,raw,storage,planning,...await mount(PlanningApiView)};
}
const map=(root:HostNode)=>find(root,n=>n.tag==='map-probe')!;
// 页面真实选择与服务状态一起验证，地图绘制替身只记录收到的冻结数据。
describe('多份完整结果页面闭环',()=>{
  it('Mock保存草稿按结果保留，明确放弃后不得再次恢复',async()=>{
    const s=await mockEntry(),rows=s.planning.job!.solutions!;
    s.planning.step=3;await settle();
    const name=()=>find(s.root,n=>n.tag==='input'&&n.props.maxlength==='60')!;
    (name().props['onUpdate:modelValue'] as Function)('A草稿');await settle();
    s.planning.selectSolution(rows[1].solutionId);await settle();(name().props['onUpdate:modelValue'] as Function)('B草稿');await settle();
    s.planning.selectSolution(rows[0].solutionId);await settle();expect(name().value).toBe('A草稿');expect(s.task.auxiliary.planSave).toBe(true);
    const leave=s.task.allowLeave();s.task.answer('discard');expect(await leave).toBe(true);await settle();
    s.planning.selectSolution(rows[1].solutionId);await settle();s.planning.selectSolution(rows[0].solutionId);await settle();
    expect(name().value).toBe(s.planning.job!.input.name);

  });
  it('Mock切换使地图、频率、指标与保存对象同步，旧选择事件失效',async()=>{const s=await mockEntry(),rows=s.planning.job!.solutions!,old=find(s.root,n=>n.tag==='button'&&textOf(n)===rows[0].label)!.props.onClick as Function;await click(s.root,rows[1].label);expect(s.planning.currentResult!.metrics.totalRadiatedPowerW).toBe(60);expect((map(s.root).props.planningOverlay as any).links).toEqual(rows[1].result!.links);expect((map(s.root).props.planningOverlay as any).coverage).toEqual(rows[1].result!.coverage);old();await settle();expect(s.planning.selectedSolutionId).toBe(rows[1].solutionId);expect(await s.planning.savePlan('第二份','说明B')).toBe(true);expect(s.planning.selectedPlan?.solutionId).toBe(rows[1].solutionId);await vi.waitFor(()=>expect(s.router.currentRoute.value.query.planId).toBe(s.planning.selectedPlan!.id));s.planning.selectSolution(rows[0].solutionId);await settle();expect(s.planning.currentSavedPlanId).toBeNull();expect(await s.planning.savePlan('第一份','说明A')).toBe(true);expect((await s.raw.loadPlanningWorkspace()).workspace.plans.map(p=>p.solutionId)).toEqual([rows[1].solutionId,rows[0].solutionId]);});
  it('保存后刷新失败仍保留已保存方案，重试读取完成前不能用旧版本保存另一份',async()=>{
    const s=await mockEntry(),rows=s.planning.job!.solutions!,jobId=s.planning.job!.id;
    s.planning.selectSolution(rows[1].solutionId);s.planning.step=3;await settle();
    const save=vi.mocked(previewService.savePlanningReceipt),progress=vi.mocked(previewService.getPlanningTaskProgress);
    progress.mockRejectedValueOnce(new ApiError('作业版本刷新失败','NETWORK_ERROR'));
    expect(await s.planning.savePlan('第二份','说明B')).toBe(true);
    const savedId=s.planning.selectedPlan!.id;
    await vi.waitFor(()=>expect(s.router.currentRoute.value.query.planId).toBe(savedId));
    expect(s.planning.notice).toContain('已保存');expect(s.planning.queryError).toContain('作业版本刷新失败');expect(s.planning.pending).toBeNull();
    expect(textOf(s.root)).toContain('作业状态刷新失败，可返回本次备选方案后恢复查询');
    expect((await s.raw.loadPlanningWorkspace()).workspace.plans.map(p=>p.id)).toEqual([savedId]);expect(save).toHaveBeenCalledTimes(1);
    s.planning.selectSolution(rows[0].solutionId);expect(s.planning.canSave).toBe(false);
    expect(await s.planning.savePlan('第一份','说明A')).toBe(false);expect(save).toHaveBeenCalledTimes(1);
    // 重试开始会清除查询错误，但拿到新版本前仍不能再次提交保存。
    let finish!:(value:Awaited<ReturnType<typeof previewService.getPlanningTaskProgress>>)=>void;
    progress.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve));
    const retry=click(s.root,'恢复查询');await settle();expect(s.planning.queryError).toBe('');expect(s.planning.canSave).toBe(false);
    finish(await s.raw.getPlanningTaskProgress({context:'planning',taskId:s.task.taskId,jobId}));await retry;
    expect(s.planning.selectedSolutionId).toBe(rows[0].solutionId);expect(s.planning.canSave).toBe(true);
    expect(s.planning.job!.solutions![1].savedPlanId).toBe(savedId);
    expect(await s.planning.savePlan('第一份','说明A')).toBe(true);expect(save).toHaveBeenCalledTimes(2);
    expect((await s.raw.loadPlanningWorkspace()).workspace.plans.map(p=>p.solutionId)).toEqual([rows[1].solutionId,rows[0].solutionId]);
  });
  it('接口契约中方案与作业版本各自独立，连续保存使用读取到的新作业版本',async()=>{
    const s=await apiEntry(),server=multi();
    vi.spyOn(previewService,'getPlanningTask').mockImplementation(async()=>structuredClone(server));
    const save=vi.spyOn(previewService,'savePlanningPlan').mockImplementation(async request=>{
      expect(request.revision).toBe(server.revision);
      const row=server.solutions!.find(item=>item.solutionId===request.solutionId)!;
      const plan={...apiPlan('P-'+request.solutionId),name:request.name,note:request.note,revision:'plan-'+request.solutionId,
        solutionId:row.solutionId,solutionLabel:row.label,result:structuredClone(row.result!)};
      row.savedPlanId=plan.id;server.revision+='-next';return plan;
    });
    s.planning.selectSolution('solution-2');expect(await s.planning.savePlan('第二份','说明B')).toBe(true);
    expect(s.planning.job!.revision).toBe('j1-next');expect(s.planning.selectedPlan!.revision).toBe('plan-solution-2');
    s.planning.selectSolution('solution-1');expect(await s.planning.savePlan('第一份','说明A')).toBe(true);
    expect(save.mock.calls.map(([request])=>request.revision)).toEqual(['j1','j1-next']);
    expect(s.planning.job!.solutions!.map(row=>row.savedPlanId)).toEqual(['P-solution-1','P-solution-2']);
  });
  it.each(['direct','receipt'] as const)('Mock %s 确认第一份后可直接保存另一备选，不重复确认',async mode=>{
    const s=await mockEntry(),rows=s.planning.job!.solutions!;
    expect(await s.planning.savePlan('第一份','说明A')).toBe(true);
    const first=s.planning.selectedPlan!.id,confirm=vi.mocked(previewService.confirmPlanningReceipt);
    // 回包丢失只核实原请求，不重新执行确认。
    if(mode==='receipt')confirm.mockImplementationOnce(async request=>{await s.raw.confirmPlanningReceipt(request);throw new ApiError('确认回包丢失','NETWORK_ERROR');});
    const action=s.planning.confirm();s.task.answer('save');await action;
    if(mode==='receipt'){expect(s.planning.pending?.kind).toBe('confirm');await s.planning.reconcile();}
    expect(s.planning.pending).toBeNull();expect(s.planning.selectedPlan).toMatchObject({id:first,state:'CONFIRMED',current:true});
    s.planning.selectSolution(rows[1].solutionId);expect(await s.planning.savePlan('第二份','说明B')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);expect((await s.raw.loadPlanningWorkspace()).workspace.plans.map(p=>p.solutionId)).toEqual(rows.map(row=>row.solutionId));
  });
  it.each(['direct','receipt'] as const)('%s 确认后刷新失败保留确认结果，恢复查询后才可保存另一份',async mode=>{
    const s=await mockEntry(),rows=s.planning.job!.solutions!;
    expect(await s.planning.savePlan('第一份','')).toBe(true);
    const first=s.planning.selectedPlan!.id,confirm=vi.mocked(previewService.confirmPlanningReceipt),save=vi.mocked(previewService.savePlanningReceipt);
    if(mode==='receipt')confirm.mockImplementationOnce(async request=>{await s.raw.confirmPlanningReceipt(request);throw new ApiError('确认回包丢失','NETWORK_ERROR');});
    vi.mocked(previewService.getPlanningTaskProgress).mockRejectedValueOnce(new ApiError('确认后的状态读取失败','NETWORK_ERROR'));
    const action=s.planning.confirm();s.task.answer('save');await action;if(mode==='receipt')await s.planning.reconcile();
    expect(s.planning.pending).toBeNull();expect(s.planning.selectedPlan).toMatchObject({id:first,state:'CONFIRMED',current:true});expect(s.planning.queryError).toContain('确认后的状态读取失败');
    expect(s.planning.notice).toContain('作业状态刷新失败');s.planning.selectSolution(rows[1].solutionId);expect(s.planning.canSave).toBe(false);
    expect(await s.planning.savePlan('第二份','')).toBe(false);expect(save).toHaveBeenCalledTimes(1);
    await s.planning.refreshJob();expect(s.planning.canSave).toBe(true);expect(await s.planning.savePlan('第二份','')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);expect(save).toHaveBeenCalledTimes(2);
  });
  it('HTTP切换选择后轮询保持选择，过期B显示空图并禁止保存',async()=>{const s=await apiEntry();await click(s.root,'完整结果2');expect(s.planning.result!.metrics.totalRadiatedPowerW).toBe(20);const next=multi();next.solutions![1].expired=true;next.solutions![1].result=null;vi.spyOn(previewService,'getPlanningTask').mockResolvedValue(next);await s.planning.refreshJob();await settle();expect(s.planning.selectedSolutionId).toBe('solution-2');expect(s.planning.result).toBeNull();expect(s.planning.canSave).toBe(false);expect((map(s.root).props.planningOverlay as any).nodes).toEqual([]);expect(textOf(s.root)).toContain('未保存结果已过期');});
  it('HTTP待核实保存冻结B身份，错误A回执不能释放，正确B才恢复',async()=>{const s=await apiEntry();s.planning.selectSolution('solution-2');vi.spyOn(previewService,'savePlanningPlan').mockRejectedValue(new ApiError('断线','NETWORK_ERROR'));await s.planning.savePlan('保存B','说明B');expect(s.planning.pending).toMatchObject({solutionId:'solution-2',snapshotId:'S2',jobId:'J1'});expect(s.planning.selectSolution('solution-1')).toBe(false);const pending=s.planning.pending!;vi.spyOn(previewService,'getPlanningOperation').mockResolvedValue({...pending,state:'SUCCEEDED',entityId:'P-2',message:'已保存'});const plan={...apiPlan('P-2'),name:'保存B',note:'说明B',solutionId:'solution-1',solutionLabel:'第一份',radioCount:0};const get=vi.spyOn(previewService,'getPlanningPlan').mockResolvedValue(plan);await s.planning.reconcile();expect(s.planning.pending).not.toBeNull();get.mockResolvedValue({...plan,solutionId:'solution-2',solutionLabel:'第二份',result:{...plan.result,snapshotId:'S2'}});await s.planning.reconcile();expect(s.planning.pending).toBeNull();expect(s.planning.selectedPlan!.solutionId).toBe('solution-2');expect(s.planning.job!.solutions![0].savedPlanId).toBeNull();expect(s.planning.job!.solutions![1].savedPlanId).toBe('P-2');});
  it('Mock成功但丢失回包后核实原请求，不重复保存且可继续保存另一份',async()=>{const s=await mockEntry(),selected=s.planning.job!.solutions![1];s.planning.selectSolution(selected.solutionId);vi.spyOn(previewService,'savePlanningReceipt').mockImplementationOnce(async request=>{await s.raw.savePlanningReceipt(request);throw new ApiError('丢失回包','NETWORK_ERROR');});expect(await s.planning.savePlan('B','说明')).toBe(false);expect(s.planning.pending?.solutionId).toBe(selected.solutionId);expect(s.planning.selectSolution(s.planning.job!.solutions![0].solutionId)).toBe(false);await s.planning.reconcile();expect(s.planning.pending).toBeNull();expect(s.planning.selectedPlan!.solutionId).toBe(selected.solutionId);expect((await s.raw.loadPlanningWorkspace()).workspace.plans).toHaveLength(1);s.planning.selectSolution(s.planning.job!.solutions![0].solutionId);expect(await s.planning.savePlan('A','说明A')).toBe(true);expect((await s.raw.loadPlanningWorkspace()).workspace.plans).toHaveLength(2);});
  it('保存说明按结果分别保留，HTTP页离开标记覆盖未选中的草稿',async()=>{const s=await apiEntry();s.planning.step=3;await settle();let name=find(s.root,n=>n.tag==='input'&&n.props.maxlength==='60')!;(name.props['onUpdate:modelValue'] as Function)('A的未保存名称');await settle();s.planning.selectSolution('solution-2');s.planning.step=3;await settle();name=find(s.root,n=>n.tag==='input'&&n.props.maxlength==='60')!;(name.props['onUpdate:modelValue'] as Function)('B的未保存名称');await settle();expect(s.task.auxiliary.planSave).toBe(true);s.planning.selectSolution('solution-1');s.planning.step=3;await settle();name=find(s.root,n=>n.tag==='input'&&n.props.maxlength==='60')!;expect(name.value).toBe('A的未保存名称');});
  it('备选结果复用快照和对象 ID 时，仍拒绝上一份结果的定位回调',async()=>{
    const s=await apiEntry();s.planning.job!.solutions![1].result!.snapshotId=s.planning.job!.solutions![0].result!.snapshotId;
    await click(s.root,'路由路径');const old=find(s.root,n=>n.tag==='button'&&textOf(n)==='高亮路径')!.props.onClick as Function;
    old();await settle();const locate=map(s.root).props.locate as ReturnType<typeof vi.fn>;expect(locate).toHaveBeenCalled();
    await click(s.root,'完整结果2');locate.mockClear();old();await settle();expect(locate).not.toHaveBeenCalled();
  });
  it('关键链路由服务声明定位，切换结果后旧按钮无效',async()=>{const s=await mockEntry('options-bridge');await click(s.root,'优化权衡');const locate=find(s.root,n=>n.tag==='button'&&textOf(n)==='定位链路')!.props.onClick as Function;locate();await settle();expect(map(s.root).props.selectedLinkId).toBe('LINK-A');expect(map(s.root).props.locate).toHaveBeenCalled();await click(s.root,'路由路径');locate();await settle();expect(map(s.root).props.selectedLinkId).toBe('');});
});

