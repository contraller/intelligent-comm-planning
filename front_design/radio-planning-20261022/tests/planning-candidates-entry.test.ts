import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { h, nextTick, ssrContextKey, type App, type Component } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import PlanningApiResultPanel from '../src/components/PlanningApiResultPanel.vue';
import PlanningCandidatePanel from '../src/components/PlanningCandidatePanel.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { createPlanningHttp } from '../src/services/planning-http';
import { usePreviewStore } from '../src/stores/preview';
import { useTaskInputStore } from '../src/stores/task-input';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useResourceReadStore } from '../src/stores/resource-read';
import { planningPresets } from '../src/mocks/planning-presets';
import { getPresetResultDetails } from '../src/services/planning-result-details-mock';
import { authorizeStore } from './helpers/auth';
import { savedRequest } from './helpers/tasks';
import { TestStorage } from './helpers/storage';
import { storeFixture, httpFixture, planDto, response } from './fixtures/planning-api';
import type { CandidateMapFrame, CandidateRow } from '../src/types/planning-candidates';
import type { PlanningResultDetails } from '../src/types/planning-result-details';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';

// 实际页面/候选组件/Store运行；地图和表格宿主暴露事件，实屏另验。
vi.mock('../src/components/MapCanvas.vue',async()=>{const {h}=await import('vue');return{default:{inheritAttrs:false,props:['planningCandidates'],emits:['selectPlanningCandidate'],setup:(p:any,{emit,expose}:any)=>{const locate=vi.fn();expose({locateResource:locate});return()=>h('map-probe',{frame:p.planningCandidates,locate,select:(row:unknown)=>emit('selectPlanningCandidate',row)});}}};});
vi.mock('../src/components/AppTable.vue',async()=>{const {h}=await import('vue');return{default:{inheritAttrs:false,props:['rows','selected','columns'],emits:['select'],setup:(p:any,{emit,slots}:any)=>()=>h('table-probe',{...p,select:(row:unknown)=>emit('select',row)},p.rows.map((row:any)=>h('row-probe',{id:row.id},slots.actions?.({row}))))}};});
vi.mock('../src/components/AppDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/TaskApiPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceReadStatus.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiProgressPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiVersionsPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiFeedback.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanComparisonPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanExportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


for(const [c,f] of [[PlanningApiView,'views/PlanningApiView'],[PlanningApiResultPanel,'components/PlanningApiResultPanel'],[PlanningCandidatePanel,'components/PlanningCandidatePanel']] as const)await clientTemplate(c,'src/'+f+'.vue', 'candidate-entry-render.ts');
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
const table=(root:HostNode)=>find(root,n=>n.tag==='table-probe'&&(n.props.rows as CandidateRow[])?.some(r=>!!r.siteId))!;
const map=(root:HostNode)=>find(root,n=>n.tag==='map-probe'&&!!n.props.frame)!;
const panel=(root:HostNode)=>find(root,n=>n.props['aria-label']==='候选部署点')!;
const row=(root:HostNode)=>(table(root).props.rows as CandidateRow[])[0];
async function mount(component:Component){
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/planning',component},{path:'/other',component:{render:()=>null}}]});
  await router.push('/planning');await router.isReady();app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia!);app.use(router);app.provide(ssrContextKey,{});
  const root=node('root');app.mount(root);await settle();return{root,router};
}
async function entry(mode:'mock'|'api'){
  vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',{activeElement:null});vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  if(mode==='mock'){
    pinia=createPinia();setActivePinia(pinia);const storage=new TestStorage(),raw=createMockService(()=>storage);
    for(const [name,method]of Object.entries(raw))if(typeof method==='function')vi.spyOn(previewService as any,name).mockImplementation(method);
    const auth=authorizeStore();let time=Date.parse('2026-10-16T00:00:00Z');vi.spyOn(Date,'now').mockImplementation(()=>time);
    const first=await raw.submitPlanning(await savedRequest(storage,{baseRevision:'initial',requestId:'run',taskId:'same-task',parentPlanVersionId:null,input:structuredClone(planningPresets[0].input)}));time+=20000;
    const saved=await raw.savePlanVersion({baseRevision:first.workspace.revision,jobId:first.view.job.id,requestId:'save',name:'候选方案',note:''});
    // Mock 与 HTTP 均验证路由实际使用的页面，结果从共同契约读取。
    await useResourceReadStore().activate('planning');const task=useTaskInputStore();await task.initialize('planning');await task.open(saved.plan.taskId,false);
    const planning=usePlanningApiStore();await nextTick();planning.selectedPlan=await raw.getPlanningPlan({context:'planning',taskId:saved.plan.taskId,planId:saved.plan.id});planning.step=2;
    const mounted=await mount(PlanningApiView);await click(mounted.root,'部署点位');
    return{...mounted,auth,planning,storage,configuration:()=>planning.selectedPlan!.result.configuration,input:()=>task.draft,
      swap:()=>{planning.selectedPlan!.version+='-other';},details:()=>planning.selectedPlan!.result.resultDetails!,writes:()=>storage.writes};
  }
  const f=await storeFixture();pinia=f.pinia;
  vi.spyOn(useResourceReadStore(),'activate').mockResolvedValue(true);vi.spyOn(f.task,'initialize').mockResolvedValue();
  const planning=usePlanningApiStore();vi.spyOn(planning,'start').mockImplementation(()=>{});
  const dto=planDto(),screening=getPresetResultDetails('balanced',planningPresets[0].input)!.candidateScreening!;
  screening.sourceLabel='服务独立候选结果';screening.candidateCount=1137;screening.deployableCount=1117;screening.candidates=screening.candidates!.slice(0,1);
  const details:PlanningResultDetails={schemaVersion:1,assetVersion:'service-candidates-v1',deviceParameters:null,routeQuality:null,frequencyAssignments:null,frequencyConflicts:null,frequencyGap:null,conflictFree:null,unreachableDemandIds:null,candidateScreening:screening};
  const transport=httpFixture(()=>response({...dto,result:{...dto.result,result_details:details}}));
  planning.selectedPlan=await createPlanningHttp(transport.request,()=>'/api/v1').getPlanningPlan({context:'planning',taskId:'T1',planId:'P-1'});planning.step=2;
  return{...await mount(PlanningApiView),auth:f.auth,planning,storage:undefined,configuration:()=>planning.selectedPlan!.result.configuration,input:()=>f.task.draft,
    swap:()=>{planning.selectedPlan!.version='V2';},details:()=>planning.selectedPlan!.result.resultDetails!,writes:()=>transport.calls.length};
}
describe('候选两种真实规划入口',()=>{
  it.each(['mock','api'] as const)('%s 清单地图双向联动，隐藏后定位不恢复图层且不写业务数据',async mode=>{
    const s=await entry(mode),before=JSON.stringify([s.input(),s.configuration(),s.details()]),writes=s.writes();
    const first=row(s.root);(table(s.root).props.select as Function)(first);await nextTick();expect((map(s.root).props.frame as CandidateMapFrame).selectedId).toBe(first.siteId);expect(textOf(panel(s.root))).toContain(first.siteId);
    const checkbox=find(panel(s.root),n=>n.tag==='input'&&n.props.type==='checkbox')!;(checkbox.props.onChange as Function)({target:{checked:false}});await nextTick();
    expect((map(s.root).props.frame as CandidateMapFrame).visible).toBe(false);await click(find(table(s.root),n=>n.tag==='row-probe'&&n.props.id===first.id)!,'定位候选');
    expect(map(s.root).props.locate).toHaveBeenCalledWith(first.coordinate);expect((map(s.root).props.frame as CandidateMapFrame).visible).toBe(false);
    const control=find(panel(s.root),n=>n.tag==='input'&&n.props.type==='checkbox')!;(control.props.onChange as Function)({target:{checked:true}});await nextTick();
    await click(s.root,'清除候选选择');(map(s.root).props.select as Function)(row(s.root));await nextTick();expect(table(s.root).props.selected).not.toBeNull();
    expect(JSON.stringify([s.input(),s.configuration(),s.details()])).toBe(before);expect(s.writes()).toBe(writes);
    if(mode==='api')expect(textOf(panel(s.root))).toContain('已返回明细条数：1');
  });
  it.each(['mock','api'] as const)('%s 标签/版本/权限切换后旧控件和旧地图事件不能影响新结果',async mode=>{
    const s=await entry(mode),oldRow=row(s.root),oldSelect=table(s.root).props.select as Function,oldMap=map(s.root).props.select as Function;
    oldSelect(oldRow);await nextTick();await click(s.root,'路由路径');expect((map(s.root).props.frame as CandidateMapFrame).visible).toBe(false);
    await click(s.root,'部署点位');oldSelect(oldRow);oldMap(oldRow);await nextTick();expect(table(s.root).props.selected).toBeNull();
    const prior=row(s.root);s.swap();await settle();(table(s.root).props.select as Function)(prior);await nextTick();expect(table(s.root).props.selected).toBeNull();
    const current=row(s.root);const identity=structuredClone(Vue.toRaw(s.auth.identity!));s.auth.accept({...identity,permissions:identity.permissions.filter(p=>p!=='planning.view')});await settle();s.auth.accept(identity);await settle();
    oldMap(current);await nextTick();expect((map(s.root).props.frame as CandidateMapFrame).selectedId).toBe('');
  });
  it('Mock 缺坐标可看详情且禁用定位，筛选排除后清除候选',async()=>{
    const s=await entry('mock'),unknown=(table(s.root).props.rows as CandidateRow[]).find(r=>r.coordinate===null)!;
    (table(s.root).props.select as Function)(unknown);await nextTick();expect(textOf(panel(s.root))).toContain('未提供坐标，无法定位');
    const candidate=find(table(s.root),n=>n.tag==='row-probe'&&n.props.id===unknown.id)!;
    expect(find(candidate,n=>n.tag==='button'&&textOf(n)==='定位候选')!.props.disabled).toBe(true);
    const filter=find(panel(s.root),n=>n.props['aria-label']==='候选部署结论')!;(filter.props.onChange as Function)({target:{value:'yes'}});await nextTick();
    expect(table(s.root).props.selected).toBeNull();expect(textOf(panel(s.root))).toContain('已被当前筛选隐藏');
  });
  it('API 缺扩展保持未提供，离开页面后旧地图回调无效',async()=>{
    const s=await entry('api'),old=row(s.root),oldMap=map(s.root).props.select as Function;
    delete s.details().candidateScreening;await settle();expect(textOf(panel(s.root))).toContain('此结果未提供候选筛选明细');
    expect((map(s.root).props.frame as CandidateMapFrame).points).toEqual([]);
    await s.router.push('/other');await settle();expect(()=>oldMap(old)).not.toThrow();
  });
});

