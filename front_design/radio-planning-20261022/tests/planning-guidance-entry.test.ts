import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import PlanningHistoryDrawer from '../src/components/PlanningHistoryDrawer.vue';
import DiagnosisView from '../src/views/DiagnosisView.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { useTaskInputStore } from '../src/stores/task-input';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useDiagnosisStore } from '../src/stores/diagnosis';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';

// 运行真实页面、历史查询、路由及离页保护；只替换地图与无关的结果呈现。
vi.mock('../src/components/MapCanvas.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceReadStatus.vue', () => ({default:{render:()=>null}}));
vi.mock('../src/components/PlanningApiProgressPanel.vue', () => ({default:{render:()=>null}}));
vi.mock('../src/components/PlanningApiResultPanel.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiVersionsPanel.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningAdjustmentEditor.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningAdjustmentPreview.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanComparisonPanel.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanExportDrawer.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DiagnosisResultPanel.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DiagnosisSourceDrawer.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DiagnosisImportDrawer.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DiagnosisReportDrawer.vue', () => ({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/TaskApiPanel.vue', async () => {
  const {defineComponent,h}=await import('vue');
  return {default:defineComponent({setup:(_p,{slots})=>()=>h('task-probe',[slots.actions?.(),slots['submit-hint']?.(),slots.feedback?.()])})};
});
vi.mock('../src/components/AppTable.vue', async () => {
  const {defineComponent,h}=await import('vue');
  return {default:defineComponent({props:['rows'],setup:(props,{slots})=>()=>h('table-probe',(props.rows as any[]??[]).map(row=>h('div',[row.name,slots.actions?.({row})])))})};
});
vi.mock('../src/components/AppDrawer.vue', async () => {
  const {defineComponent,h}=await import('vue');
  return {default:defineComponent({props:['visible','title'],emits:['update:visible'],setup:(props,{slots,emit})=>()=>props.visible?h('drawer-probe',{title:props.title},[h('button',{onClick:()=>emit('update:visible',false)},'关闭'+props.title),slots.default?.(),slots.footer?.()]):null})};
});

beforeAll(async()=>{
  for(const [component,path] of [[PlanningApiView,'src/views/PlanningApiView.vue'],[PlanningHistoryDrawer,'src/components/PlanningHistoryDrawer.vue'],[DiagnosisView,'src/views/DiagnosisView.vue']] as const)await clientTemplate(component,path,'guidance-render.ts');
});
let app:App|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia){useTaskInputStore(pinia).clearForSession();disposePinia(pinia);}pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();});
async function settle(){for(let i=0;i<20;i++)await nextTick();}
async function setup(path:string,maintained=false){
  vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',Object.assign(new EventTarget(),{activeElement:null}));
  let time=Date.parse('2026-10-22T03:00:00Z');vi.spyOn(Date,'now').mockImplementation(()=>time);
  pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore();vi.spyOn(auth,'check').mockResolvedValue(true);
  const storage=new TestStorage(),raw=createMockService(()=>storage);
  for(const [name,method]of Object.entries(raw))if(typeof method==='function')vi.spyOn(previewService as any,name).mockImplementation(method);
  // 用真实维护保存复现原工作区阻塞，后续页面仍调用同一业务服务。
  if(maintained){
    const context=await raw.loadResourceReadContext({context:'ledger'});
    const detail=await raw.getDeviceMaintenance({context:'ledger',deviceId:'DV-0001',revision:context.revision});
    const ports=structuredClone(detail.device.ports!);ports[0].rateKbps=12;
    await raw.saveResourceChanges({context:'ledger',baseRevision:'initial',stations:[],devices:[{id:'DV-0001',currentWorkMode:'MOCK_FIXED',ports}],requestId:'guidance-maintenance'});
  }
  const resources=await raw.loadPreview(),tasks=await raw.loadTaskWorkspace();
  await raw.saveTask({context:'planning',taskId:'T1',input:structuredClone(planningPresets[0].input),baseResourceRevision:resources.resourceMeta.revision,baseTaskRevision:tasks.revision,requestId:'guidance-task'});
  const task=useTaskInputStore();await task.initialize('planning');await task.open('T1',false);
  const planning=usePlanningApiStore();vi.spyOn(planning,'start').mockImplementation(()=>{});
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/planning',component:PlanningApiView},{path:'/diagnosis',component:DiagnosisView},{path:'/situation',component:{render:()=>null}}]});
  await router.push(path);await router.isReady();const root=node('root');app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia);app.use(router);app.provide(ssrContextKey,{});app.mount(root);await settle();
  return{root,task,planning,auth,storage,router,raw,advance:()=>{time+=10000;}};
}
async function click(root:HostNode,label:string){
  const control=find(root,node=>['button','a'].includes(node.tag)&&textOf(node).trim()===label);
  expect(control,label).toBeDefined();await (control!.props.onClick as Function)({button:0,preventDefault(){}});await settle();
}

describe('规划历史与诊断准备入口',()=>{
  it('已保存方案按钮绑定任务归属，失败留在目录并提示，成功后关闭',async()=>{
    const s=await setup('/planning?history=saved');
    const row={id:'P-HISTORY',taskId:'T1',name:'数据库历史方案',version:'V1',state:'SAVED' as const,current:false,sourceChanged:false,savedAt:'2026-10-23T00:00:00Z'};
    vi.mocked(previewService.querySavedPlanningPlans).mockResolvedValue({items:[row],pageNum:1,pageSize:10,total:1});
    await (find(s.root,n=>n.tag==='form')!.props.onSubmit as Function)({preventDefault(){}});await settle();
    const opening=vi.spyOn(s.planning,'openHistoricalPlan').mockImplementationOnce(async()=>{s.planning.localError('历史详情读取失败');return false;}).mockResolvedValueOnce(true);
    await click(s.root,'打开方案');
    expect(opening).toHaveBeenCalledWith(row.taskId,row.id,expect.any(AbortSignal));
    expect(textOf(s.root)).toContain('历史详情读取失败');expect(find(s.root,n=>n.tag==='drawer-probe')).toBeDefined();
    await click(s.root,'打开方案');await vi.waitFor(()=>expect(find(s.root,n=>n.tag==='drawer-probe')).toBeUndefined());
  });
  it('旧历史用途打开已保存页签，关闭后同步身份不会重复弹出或写入',async()=>{
    const s=await setup('/planning?history=references'),writes=s.storage.writes;
    await vi.waitFor(()=>expect(previewService.querySavedPlanningPlans).toHaveBeenCalled());await settle();
    expect(find(s.root,node=>node.tag==='button'&&textOf(node)==='已保存方案')?.props.class).toContain('primary');
    expect(previewService.getPlanningReference).not.toHaveBeenCalled();expect(s.storage.writes).toBe(writes);
    await click(s.root,'关闭规划历史');await vi.waitFor(()=>expect(s.router.currentRoute.value.query.history).toBeUndefined());
    await s.task.save();await settle();expect(find(s.root,node=>node.tag==='drawer-probe')).toBeUndefined();
  });
  it('诊断两处引导带来源，准备未完成可显式返回并重新读取来源',async()=>{
    const s=await setup('/diagnosis');await vi.waitFor(()=>expect(useDiagnosisStore().loading).toBe(false));await settle();
    expect(textOf(s.root)).toContain('当前没有有效的已确认方案');
    for(const label of ['前往网络规划保存并转正方案','前往网络规划准备并转正方案'])expect(find(s.root,node=>node.tag==='a'&&textOf(node)===label)?.props.href).toBe('/planning?from=diagnosis');
    await click(s.root,'前往网络规划保存并转正方案');expect(textOf(s.root)).toContain('诊断准备');
    const reads=vi.mocked(previewService.loadDiagnosisContext).mock.calls.length;
    await click(s.root,'返回故障诊断');await vi.waitFor(()=>expect(previewService.loadDiagnosisContext).toHaveBeenCalledTimes(reads+1));
    expect(s.router.currentRoute.value.path).toBe('/diagnosis');expect(previewService.saveDiagnosisReceipt).not.toHaveBeenCalled();expect(previewService.submitDiagnosisReceipt).not.toHaveBeenCalled();
  });
  it('设备维护后可保存、规划与转正，用户点击返回诊断取得有效网络',async()=>{
    const s=await setup('/planning?from=diagnosis',true),maintained=(await s.raw.loadPreview()).resources;
    await s.task.save();await s.planning.submit();s.advance();await s.planning.refreshJob(s.planning.job!.id);await settle();
    expect(s.planning.canSave).toBe(true);expect(await s.planning.savePlan('诊断准备网络','')).toBe(true);
    const pending=s.planning.confirm();await vi.waitFor(()=>expect(s.task.decision).not.toBeNull());s.task.answer('save');await pending;await settle();
    expect(s.planning.selectedPlan?.state).toBe('CONFIRMED');expect(s.router.currentRoute.value.query.from).toBe('diagnosis');expect(s.router.currentRoute.value.path).toBe('/planning');
    await click(s.root,'返回故障诊断');await vi.waitFor(()=>expect(useDiagnosisStore().sources.plans.length).toBe(1));await settle();
    expect(find(s.root,node=>node.tag==='button'&&textOf(node)==='新建场景')?.props.disabled).toBe(false);
    expect((await s.raw.loadPreview()).resources).toEqual(maintained);
    expect(previewService.saveDiagnosisReceipt).not.toHaveBeenCalled();expect(previewService.submitDiagnosisReceipt).not.toHaveBeenCalled();
  });
  it('返回沿用离页保护，取消和保存失败保留输入，成功后才离开',async()=>{
    const s=await setup('/planning?from=diagnosis');s.task.draft!.name='待保护的准备输入';
    for(const answer of ['cancel','save'] as const){
      if(answer==='save')s.storage.failWrite=true;
      const pending=click(s.root,'返回故障诊断');await vi.waitFor(()=>expect(s.task.decision).not.toBeNull());s.task.answer(answer);await pending;
      expect(s.router.currentRoute.value.path).toBe('/planning');expect(s.task.draft!.name).toBe('待保护的准备输入');
    }
    s.storage.failWrite=false;const pending=click(s.root,'返回故障诊断');await vi.waitFor(()=>expect(s.task.decision).not.toBeNull());s.task.answer('save');await pending;
    await vi.waitFor(()=>expect({path:s.router.currentRoute.value.path,error:s.task.error,pending:s.task.pendingSave,decision:s.task.decision}).toMatchObject({path:'/diagnosis',pending:null,decision:null}));
  });
  it('普通规划无诊断引导，失权隐藏返回，非法用途不覆盖现场或打开历史',async()=>{
    const s=await setup('/planning');expect(textOf(s.root)).not.toContain('诊断准备');
    await s.router.push('/planning?from=diagnosis');await settle();
    s.auth.accept({...s.auth.identity!,permissions:s.auth.identity!.permissions.filter(permission=>permission!=='diagnosis.view')});await settle();
    expect(find(s.root,node=>node.tag==='button'&&textOf(node)==='返回故障诊断')).toBeUndefined();
    const before=JSON.stringify(s.task.draft),writes=s.storage.writes;await s.router.push('/planning?history=invalid');await settle();
    expect(find(s.root,node=>node.tag==='drawer-probe')).toBeUndefined();expect(JSON.stringify(s.task.draft)).toBe(before);expect(s.storage.writes).toBe(writes);
  });
});
