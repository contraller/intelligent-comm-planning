import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia } from 'pinia';
import * as Vue from 'vue';
import { createRenderer, nextTick, type App, type Component } from 'vue';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
// 特殊编译参数由调用处显式指定，宿主和业务断言保持本地。
import { clientTemplate } from './helpers/vue-client';
import { previewService, releasePageSessionBinding } from '../src/services';
import { useTaskInputStore } from '../src/stores/task-input';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useAuthStore } from '../src/stores/auth';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useSessionAccess } from '../src/composables/useSessionAccess';
import { router as applicationRouter } from '../src/router';
import AppShell from '../src/layouts/AppShell.vue';
import PlanningPage from '../src/views/PlanningApiView.vue';
import GisPage from '../src/views/SituationView.vue';
import TaskPanel from '../src/components/TaskApiPanel.vue';
import TaskForm from '../src/components/TaskApiForm.vue';
import TaskLibrary from '../src/components/TaskApiLibraryDrawer.vue';
import TaskImport from '../src/components/TaskApiImportDrawer.vue';
import DemandEditor from '../src/components/TaskDemandEditor.vue';
import ProgressPanel from '../src/components/PlanningApiProgressPanel.vue';
import FeedbackPanel from '../src/components/PlanningApiFeedback.vue';
import ResultPanel from '../src/components/PlanningApiResultPanel.vue';
import VersionsPanel from '../src/components/PlanningApiVersionsPanel.vue';
import PlanExport from '../src/components/PlanExportDrawer.vue';
import AppTable from '../src/components/AppTable.vue';
import AppDrawer from '../src/components/AppDrawer.vue';
import DecisionDialog from '../src/components/DecisionDialog.vue';
import ReadStatus from '../src/components/ResourceReadStatus.vue';
import ReadTree from '../src/components/GisResourceTree.vue';
import { taskDto, jobDto, planDto, presetDto, frequencyDto, response, apiTask } from './fixtures/planning-api';

// 实际 HTTP 服务、权限、状态层和客户端模板一起运行；地图宿主只记录显示数据。
vi.mock('../src/config/env',async original=>{const m=await original<typeof import('../src/config/env')>();return{...m,env:{...m.env,mode:'http'}};});
vi.mock('vue-router',async original=>{const m=await original<typeof import('vue-router')>();return{...m,createWebHashHistory:m.createMemoryHistory};});
vi.mock('primevue/dialog',async()=>{const {h}=await import('vue');return{default:{props:['visible'],setup:(p:any,{slots}:any)=>()=>p.visible?h('dialog',{},[slots.default?.(),slots.footer?.()]):null}};});
vi.mock('primevue/drawer',async()=>{const {h}=await import('vue');return{default:{props:['visible'],setup:(p:any,{slots}:any)=>()=>p.visible?h('aside',{},[slots.default?.(),slots.footer?.()]):null}};});
vi.mock('primevue/column',()=>({default:{render:()=>null}}));
vi.mock('primevue/datatable',async()=>{const {h}=await import('vue');return{default:{inheritAttrs:false,props:['value','selection'],emits:['update:selection'],setup:(p:any,{emit}:any)=>()=>h('table-stub',{rows:p.value,selection:p.selection,select:(row:unknown)=>emit('update:selection',row)})}};});
vi.mock('../src/components/MapCanvas.vue',async()=>{const {h}=await import('vue');return{default:{props:['planningOverlay','showCoverage','coverageDisplay','selectedId','selectedLinkId','highlightStationIds','highlightLinkIds'],emits:['viewport','selectCluster','selectResource','select'],setup:(p:any,{emit,expose}:any)=>{expose({locate:()=>{},locateResource:()=>{},expandResource:()=>{}});return()=>h('map-stub',{overlay:p.planningOverlay,showCoverage:p.showCoverage,coverageDisplay:p.coverageDisplay,selectedId:p.selectedId,selectedLinkId:p.selectedLinkId,highlightStationIds:p.highlightStationIds,highlightLinkIds:p.highlightLinkIds,onTestSelect:(id:string)=>emit('select',id),onTestViewport:(bbox:any,zoom:number)=>emit('viewport',bbox,zoom)});}}};});
const components = [[AppShell,'layouts/AppShell'],[PlanningPage,'views/PlanningApiView'],[GisPage,'views/SituationView'],[TaskPanel,'components/TaskApiPanel'],[TaskForm,'components/TaskApiForm'],[TaskLibrary,'components/TaskApiLibraryDrawer'],[TaskImport,'components/TaskApiImportDrawer'],[DemandEditor,'components/TaskDemandEditor'],[ProgressPanel,'components/PlanningApiProgressPanel'],[FeedbackPanel,'components/PlanningApiFeedback'],[ResultPanel,'components/PlanningApiResultPanel'],[VersionsPanel,'components/PlanningApiVersionsPanel'],[PlanExport,'components/PlanExportDrawer'],[AppTable,'components/AppTable'],[AppDrawer,'components/AppDrawer'],[DecisionDialog,'components/DecisionDialog'],[ReadStatus,'components/ResourceReadStatus'],[ReadTree,'components/GisResourceTree']] as const;
for(const [component,file] of components){
  const filename=`src/${file}.vue`;
  await clientTemplate(component,filename,'planning-template.ts',{hoistStatic:false});
}
interface Host {tag:string;tagName:string;text:string;parent:Host|null;children:Host[];options:Host[];props:Record<string,any>;style:Record<string,string>;value?:unknown;addEventListener:()=>void;removeEventListener:()=>void;getRootNode:()=>{activeElement:null}}
const node=(tag:string,text=''):Host=>({tag,tagName:tag.toUpperCase(),text,parent:null,children:[],get options(){return this.children.filter(n=>n.tag==='option');},props:{},style:{},addEventListener(){},removeEventListener(){},getRootNode:()=>({activeElement:null})});
function remove(child:Host){if(child.parent)child.parent.children.splice(child.parent.children.indexOf(child),1);child.parent=null;}
function insert(child:Host,parent:Host,anchor?:Host|null){remove(child);child.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,child);}
const renderer=createRenderer<Host,Host>({insert,remove,createElement:tag=>node(tag),createText:text=>node('#text',text),createComment:text=>node('#comment',text),setText:(el,text)=>{el.text=text;},setElementText:(el,text)=>{el.text=text;el.children=[];},parentNode:el=>el.parent,nextSibling:el=>el.parent?.children[el.parent.children.indexOf(el)+1]??null,patchProp:(el,key,_old,value)=>{el.props[key]=value;},insertStaticContent:(text,parent,anchor)=>{const el=node('#static',text);insert(el,parent,anchor);return[el,el];}});
const text=(root:Host):string=>root.text+root.children.map(text).join('');
function find(root:Host,predicate:(n:Host)=>boolean):Host|undefined{if(predicate(root))return root;for(const child of root.children){const value=find(child,predicate);if(value)return value;}}
// 排除 v-show 隐藏的步骤，确认用户当前可见的区域没有重复失败详情。
function visible(el:Host):boolean{for(let current:Host|null=el;current;current=current.parent)if(current.style.display==='none')return false;return true;}
function all(root:Host,predicate:(n:Host)=>boolean):Host[]{return [...(predicate(root)?[root]:[]),...root.children.flatMap(child=>all(child,predicate))];}
const feedbackPanels=(root:Host)=>all(root,n=>n.props['data-feedback-operation']!==undefined&&visible(n));
const button=(root:Host,label:string)=>find(root,n=>n.tag==='button'&&text(n).trim()===label)!;
const nodeDto=(id:string)=>({node_id:id,node_name:'节点'+id,lon:id==='N1'?114:115,lat:id==='N1'?37:38,parent_node_id:'',echelon:'营',mobility:'固定',device_class:'HF',status:'NORMAL',relay_capable:true,is_key:false,child_count:0,device_count:1});
let pinia:ReturnType<typeof createPinia>,apps:App[],fetcher:ReturnType<typeof vi.fn<typeof fetch>>,serverTask:ReturnType<typeof taskDto>,serverJob:ReturnType<typeof jobDto>,serverPlans:ReturnType<typeof planDto>[],permissions:string[];
beforeEach(()=>{
  releasePageSessionBinding();pinia=createPinia();apps=[];serverTask=taskDto();serverJob={...jobDto(),status:'RUNNING',progress:0.1,result:null as any,outcome:null as any};serverPlans=[];permissions=['situation.view','planning.view','planning.execute','planning.save','planning.confirm'];
  // 当前 GIS 页面统一注册可见性监听，宿主提供真实的事件目标生命周期。
  class TestDocument extends EventTarget {title='';hidden=false;activeElement=null;}
  vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('document',new TestDocument());vi.stubGlobal('Document',TestDocument);vi.stubGlobal('ShadowRoot',class{});
  fetcher=vi.fn<typeof fetch>(async(url,init={})=>{
    const u=new URL(String(url),'http://local'),path=u.pathname,p=u.searchParams,body=init.body?JSON.parse(String(init.body)):{};
    if(path.endsWith('/auth/session'))return response({session_id:'S1',account_id:'U1',username:'planner',display_name:'规划员',role_id:'R1',role_name:'规划员',permissions,identity_revision:'a1',session_generation:'e1'});
    if(path.endsWith('/auth/csrf'))return response({csrf_token:'csrf',session_id:'S1'});
    if(path.endsWith('/resource/context'))return response({revision:'r1',bounds:[113,36,116,39],updated_at:'2026-10-05T00:00:00Z',source:'测试接口',stats:{nodes:2,devices:2,models:1,interferences:0,hf:2,vuhf:0}});
    if(path.endsWith('/resource/param-presets'))return response(presetDto());if(path.endsWith('/resource/frequency-pool'))return response(frequencyDto());
    if(path.endsWith('/resource/map'))return response({revision:'r1',bbox:p.get('bbox')!.split(',').map(Number),zoom:Number(p.get('zoom')),points:[],clusters:[],total_nodes:0,total_interferences:0});
    if(path.endsWith('/resource/nodes'))return response({revision:'r1',items:['N1','N2'].map(nodeDto),page:Number(p.get('page')),page_size:Number(p.get('page_size')),total:2});
    if(path.includes('/resource/nodes/'))return response({revision:'r1',item:nodeDto(path.split('/').at(-1)!)});
    if(path.endsWith('/resource/devices'))return response({revision:'r1',items:[],page:Number(p.get('page')),page_size:Number(p.get('page_size')),total:0});
    if(path.endsWith('/task-inputs'))return response({items:[serverTask],page:Number(p.get('page')),page_size:Number(p.get('page_size')),total:1});
    if(path.endsWith('/task-inputs/validate'))return response({valid:true,issues:[],task:body.task_id==='T1'?serverTask:null});
    if(path.endsWith('/task-inputs/T1')){if(init.method==='PUT')serverTask={...serverTask,input:body.input,revision:'t2',input_version:'i2'};return response(serverTask);}
    if(path.endsWith('/plan/sr4-flow')){serverJob={...serverJob,input:serverTask.input,input_version:body.input_version,condition_version:body.condition_version,resource_revision:body.resource_revision};serverTask.active_job_id='J1';return response(serverJob);}
    if(path.endsWith('/plan/tasks/J1'))return response(serverJob);
    if(path.endsWith('/plans')&&init.method==='POST'){const plan={...planDto(),name:body.name,note:body.note,input:serverJob.input,input_version:serverJob.input_version};serverPlans.push(plan);return response(plan);}
    if(path.endsWith('/plans'))return response({items:serverPlans,page:Number(p.get('page')),page_size:Number(p.get('page_size')),total:serverPlans.length});
    if(path.endsWith('/plans/P-1/confirm')){serverPlans[0]={...serverPlans[0],revision:'p2',state:'CONFIRMED',current:true,confirmed_at:'2026-10-05T01:00:00Z'};return response(serverPlans[0]);}
    if(path.endsWith('/plans/P-1'))return response(serverPlans[0]);
    throw new Error('意外请求 '+path);
  });vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{for(const app of apps)app.unmount();disposePinia(pinia);releasePageSessionBinding();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function mount(path='/planning?taskId=T1'){
  const auth=useAuthStore(pinia);await auth.check();auth.currentPath=path.split('?')[0];
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:AppShell,children:[{path:'planning',component:PlanningPage},{path:'situation',component:GisPage}]}]});await router.push(path);
  const app=renderer.createApp({setup(){useSessionAccess();return()=>Vue.h(RouterView);}}),root=node('root');app.use(pinia);app.use(router);app.provide(Vue.ssrContextKey,{});apps.push(app);app.mount(root);await vi.waitFor(()=>expect(useTaskInputStore(pinia).saved?.taskId).toBe('T1'));await vi.waitFor(()=>expect(useTaskInputStore(pinia).nodes).toHaveLength(2));await nextTick();return{root,router,auth,task:useTaskInputStore(pinia),planning:usePlanningApiStore(pinia)};
}
// 此夹具只描述接口提供的结果明细，数值和结论不会由页面重新推算。
function resultDetailsDto() { return { schemaVersion: 1 as const, assetVersion: 'http-detail-v1',
  deviceParameters: [{ deviceId: 'E1', tiltDeg: 0, tiltEffective: false }],
  routeQuality: [{ routeId: 'R1', demandId: 'D1', hopCount: 0, totalDistanceM: 0, totalDelayMs: null, bottleneckMarginDb: -2, reliability: 0, isFeasible: false, bottleneckLinkId: 'L1' }],
  frequencyAssignments: [{ id: 'A1', linkId: 'L1', resourceGroupId: 'F1', freqId: null, frequencyKhz: 3000, bandwidthKhz: 25, reuseGroup: 0 }],
  frequencyConflicts: [], frequencyGap: { requiredChannels: 353, availableChannels: 48, shortage: 0 }, conflictFree: true, unreachableDemandIds: [] }; }
describe('网络规划与 GIS HTTP 页面组合',()=>{
  it('各步骤保留资源过期提示，刷新只在输入步骤提供且不重算规划',async()=>{
    const {root,planning}=await mount(),resources=useResourceReadStore(pinia);
    await vi.waitFor(()=>expect(resources.workspace).not.toBeNull());await nextTick();
    // 接口来源仅用于内部读取契约，不进入正常页头。
    expect(text(root)).not.toContain('测试接口');expect(text(root)).not.toContain('资源版本 r1');
    resources.stale=true;resources.notice='';await nextTick();
    expect(text(root)).toContain('资源版本已变化');expect(button(root,'刷新资源').props.disabled).toBe(false);
    for(const step of [2,3]){
      planning.step=step;await nextTick();
      expect(text(root)).toContain('请返回“任务与约束输入”刷新资源');
      expect(button(root,'刷新资源')).toBeUndefined();
    }
    planning.step=1;await nextTick();await button(root,'刷新资源').props.onClick();await nextTick();
    expect(resources.stale).toBe(false);
    expect(fetcher.mock.calls.some(([url,init])=>String(url).endsWith('/plan/sr4-flow')&&init?.method==='POST')).toBe(false);
  });
  it('HTTP 明细直接展示，频率池和分配行互斥且不额外请求业务数据',async()=>{
    serverTask.active_job_id='J1';serverJob=jobDto();Object.assign(serverJob.result,{result_details:resultDetailsDto()});
    const {root,planning}=await mount();await vi.waitFor(()=>expect(planning.result?.resultDetails?.assetVersion).toBe('http-detail-v1'));
    const table=(id:string)=>find(root,n=>n.tag==='table-stub'&&n.props.rows.some((r:any)=>r.id===id))!;
    const map=()=>find(root,n=>n.tag==='map-stub')!;
    await button(root,'设备参数').props.onClick();await nextTick();expect(table('E1').props.rows[0]).toMatchObject({tiltDeg:0,tiltEffective:'未参与'});
    await button(root,'路由路径').props.onClick();await nextTick();expect(table('R1').props.rows[0]).toMatchObject({hopCount:0,reliability:'0%',isFeasible:'不可行',totalDelayMs:'未提供'});
    expect(text(root)).toContain('未列出不可达需求');
    await button(root,'频率分配').props.onClick();await nextTick();const calls=fetcher.mock.calls.length;
    expect(text(root)).toContain('缺口：0');expect(text(root)).toContain('服务结论：明确无冲突');expect(text(root)).toContain('没有记录');
    table('F1').props.select(table('F1').props.rows[0]);await nextTick();expect(map().props).toMatchObject({highlightStationIds:['N1','N2'],highlightLinkIds:['L1']});
    table('A1').props.select(table('A1').props.rows[0]);await nextTick();expect(table('F1').props.selection).toBeNull();expect(table('A1').props.selection.id).toBe('A1');
    await button(root,'清除选择').props.onClick();await nextTick();expect(map().props.highlightLinkIds).toEqual([]);
    planning.result!.resultDetails!.frequencyAssignments![0].resourceGroupId=null;await nextTick();table('F1').props.select(table('F1').props.rows[0]);await nextTick();
    expect(text(root)).toContain('未提供明确分配关系');expect(map().props.highlightLinkIds).toEqual([]);
    table('A1').props.select(table('A1').props.rows[0]);await nextTick();expect(map().props.highlightLinkIds).toEqual(['L1']);
    planning.result!.devices[0].stationId='missing';await nextTick();expect(map().props.highlightLinkIds).toEqual([]);expect(table('A1').props.selection).toBeNull();expect(text(root)).toContain('关联不完整');
    expect(fetcher.mock.calls).toHaveLength(calls);
  });
  it.each(['snapshot','job','plan','version','task','input','permission','absent'])('HTTP %s 变化清除定位，即使同 ID 旧行迟到也不能重选',async change=>{
    serverTask.active_job_id='J1';serverJob=jobDto();Object.assign(serverJob.result,{result_details:resultDetailsDto()});
    const {root,planning,task,auth}=await mount();await vi.waitFor(()=>expect(planning.result?.resultDetails).toBeDefined());
    const map=()=>find(root,n=>n.tag==='map-stub')!;
    await button(root,'频率分配').props.onClick();await nextTick();
    const table=()=>find(root,n=>n.tag==='table-stub'&&n.props.rows.some((r:any)=>r.id==='A1'))!;
    const oldRow=table().props.rows[0],oldSelect=table().props.select;oldSelect(oldRow);map().props.onTestSelect('N1');await nextTick();
    if(change==='snapshot')planning.result!.snapshotId='S2';
    if(change==='job')planning.job!.id='J2';
    if(change==='plan'||change==='version'){const {readApiPlan}=await import('../src/services/planning-api-validation');const dto=planDto();Object.assign(dto.result,{result_details:resultDetailsDto()});planning.selectedPlan=readApiPlan(dto,{taskId:'T1'});if(change==='version'){await nextTick();table().props.select(table().props.rows[0]);await nextTick();planning.selectedPlan.version='V2';}}
    if(change==='task')task.taskId='T2';
    if(change==='input')planning.step=1;
    if(change==='permission')auth.accept({...auth.identity!,permissions:auth.identity!.permissions.filter(p=>p!=='planning.view')});
    if(change==='absent')planning.job=null;
    await nextTick();expect(map().props).toMatchObject({selectedId:'',selectedLinkId:'',highlightStationIds:[],highlightLinkIds:[]});
    oldSelect(oldRow);await nextTick();expect(map().props.highlightLinkIds).toEqual([]);
  });
  it.each(['removed','ungrouped'])('同快照重读频率池关系 %s 后虽仍有有效分配，也清除旧选择和已消失的高亮',async change=>{
    serverTask.active_job_id='J1';serverJob=jobDto();
    const details=resultDetailsDto();
    details.frequencyAssignments.push({...details.frequencyAssignments[0],id:'A2',linkId:'L2'});
    serverJob.result.links.push({...serverJob.result.links[0],id:'L2'});
    Object.assign(serverJob.result,{result_details:details});
    const {root,planning}=await mount();await vi.waitFor(()=>expect(planning.result?.resultDetails?.frequencyAssignments).toHaveLength(2));
    await button(root,'频率分配').props.onClick();await nextTick();
    const pool=()=>find(root,n=>n.tag==='table-stub'&&n.props.rows.some((row:any)=>row.id==='F1'))!;
    pool().props.select(pool().props.rows[0]);await nextTick();
    const map=()=>find(root,n=>n.tag==='map-stub')!;
    expect(map().props.highlightLinkIds).toEqual(['L1','L2']);
    if(change==='removed')details.frequencyAssignments.pop();
    else Object.assign(details.frequencyAssignments[1],{resourceGroupId:null});
    await planning.refreshJob();await nextTick();
    expect(planning.result!.snapshotId).toBe('S1');expect(pool().props.selection).toBeNull();
    expect(map().props).toMatchObject({selectedId:'',selectedLinkId:'',highlightStationIds:[],highlightLinkIds:[]});
    expect(text(root)).toContain('所选频率关联已变化，已清除选择');
    pool().props.select(pool().props.rows[0]);await nextTick();expect(map().props.highlightLinkIds).toEqual(['L1']);
  });
  it('HTTP 同快照关系缺失后恢复合法数据，旧频率选择不自动复活',async()=>{
    serverTask.active_job_id='J1';serverJob=jobDto();const details=resultDetailsDto();Object.assign(serverJob.result,{result_details:details});
    const {root,planning}=await mount();await vi.waitFor(()=>expect(planning.result?.resultDetails).toBeDefined());
    await button(root,'频率分配').props.onClick();await nextTick();
    const pool=()=>find(root,n=>n.tag==='table-stub'&&n.props.rows.some((row:any)=>row.id==='F1'))!,map=()=>find(root,n=>n.tag==='map-stub')!;
    pool().props.select(pool().props.rows[0]);await nextTick();expect(map().props.highlightLinkIds).toEqual(['L1']);
    Object.assign(details.frequencyAssignments[0],{resourceGroupId:null});await planning.refreshJob();await nextTick();
    expect(pool().props.selection).toBeNull();expect(map().props.highlightLinkIds).toEqual([]);expect(text(root)).toContain('未提供明确分配关系');
    details.frequencyAssignments[0].resourceGroupId='F1';await planning.refreshJob();await nextTick();
    expect(pool().props.selection).toBeNull();expect(map().props.highlightLinkIds).toEqual([]);expect(text(root)).toContain('未提供明确分配关系');
    pool().props.select(pool().props.rows[0]);await nextTick();expect(pool().props.selection.id).toBe('F1');expect(map().props.highlightLinkIds).toEqual(['L1']);
  });
  it.each([
    {code:3001,data:{infeasible_reason:'业务约束无法满足',suggestions:['保留条件后重新选择场景','<img src=x onerror=alert(1)>'],extension:false},expected:['不可行原因：业务约束无法满足','保留条件后重新选择场景','<img src=x onerror=alert(1)>']},
    {code:3002,data:{gap:{required_channels:353,available_channels:48,shortage:0}},expected:['所需信道数：353','可用信道数：48','缺口数量：0']},
    {code:2003,data:{error_detail:{stage:'计算阶段',expression:'x < 0'},extra:0},expected:['错误详情','计算阶段','x < 0']},
  ])('第一步直接显示不完整 $code 响应的详情，不伪造可保存结果',async({code,data,expected})=>{
    const {root,planning}=await mount(),handler=fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url,init)=>String(url).endsWith('/plan/sr4-flow')?Promise.resolve(response(data,code)):handler(url,init));
    await button(root,'提交规划').props.onClick();await nextTick();
    expect(planning.step).toBe(1);expect(planning.job).toBeNull();expect(planning.result).toBeNull();expect(planning.canSave).toBe(false);
    const panels=feedbackPanels(root);expect(panels).toHaveLength(1);const value=text(panels[0]);
    for(const label of ['提交规划失败',`业务码：${code}`,'请求 ID：response-id','查看原始接口详情',...expected])expect(value).toContain(label);
    expect(find(panels[0],n=>n.tag==='img'||n.tag==='script')).toBeUndefined();
  });
  it('第二三步保留完整结果及单份失败详情，恢复查询只清所属查询反馈',async()=>{
    serverTask.active_job_id='J1';serverJob=jobDto();
    const {root,planning}=await mount();await vi.waitFor(()=>expect(planning.result?.snapshotId).toBe('S1'));
    const handler=fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url,init)=>String(url).endsWith('/plans')&&init?.method==='POST'?Promise.resolve(response({gap:[{objectId:'N1',field:'frequency',message:'请核查字段'}]},3002)):handler(url,init));
    await planning.savePlan('失败保存','');await nextTick();
    expect(feedbackPanels(root)).toHaveLength(1);expect(text(feedbackPanels(root)[0])).toContain('N1 / frequency：请核查字段');
    planning.step=3;await nextTick();expect(feedbackPanels(root)).toHaveLength(1);expect(planning.result?.snapshotId).toBe('S1');
    const previous=fetcher.getMockImplementation()!;let offline=true;
    fetcher.mockImplementation((url,init)=>String(url).includes('/plan/tasks/J1')&&offline?Promise.resolve(response({error_detail:'服务暂不可用'},2003)):previous(url,init));
    await planning.refreshJob();await nextTick();expect(feedbackPanels(root)).toHaveLength(2);expect(text(root)).toContain('当前显示上次成功结果');expect(planning.result?.snapshotId).toBe('S1');
    offline=false;await button(root,'恢复查询').props.onClick();await nextTick();
    expect(feedbackPanels(root)).toHaveLength(1);expect(planning.queryError).toBe('');expect(planning.error).toBe('业务拒绝');
  });
  it.each([3001,3002])('完整 %s 作业仍进入参考结果流程，保留原建议和字段缺口',async code=>{
    const {root,planning}=await mount(),handler=fetcher.getMockImplementation()!,reference=jobDto();
    reference.outcome={code,message:'参考结果',suggestions:['保留参考方案'],gap:[{objectId:'N1',field:'frequency',message:'资源不足'}]};
    reference.result.checks[0].passed=false;
    fetcher.mockImplementation((url,init)=>String(url).endsWith('/plan/sr4-flow')?Promise.resolve(response(reference,code)):handler(url,init));
    await button(root,'提交规划').props.onClick();await nextTick();
    expect(planning.step).toBe(2);expect(planning.result?.snapshotId).toBe('S1');expect(planning.canSave).toBe(true);expect(planning.feedback).toBeNull();
    expect(text(root)).toContain('保留参考方案');expect(text(root)).toContain('N1 / frequency：资源不足');expect(feedbackPanels(root)).toHaveLength(0);
  });
  it('HTTP 指标按显式结论显示颜色和文字，零值及缺失值不推算',async()=>{
    serverTask.active_job_id='J1';serverJob=jobDto();serverJob.result.metrics.connectivityPercent=0;serverJob.result.metrics.totalRadiatedPowerW=0;serverJob.result.checks[1].passed=false;
    const {root,planning}=await mount();await vi.waitFor(()=>expect(planning.result?.snapshotId).toBe('S1'));
    const card=(label:string)=>find(root,n=>n.tag==='article'&&text(n).includes(label))!;
    expect(card('连通率').props.class).toBe('passed');expect(text(card('连通率'))).toContain('0%');expect(text(card('连通率'))).toContain('达标');
    expect(card('抗毁性').props.class).toBe('failed');expect(text(card('抗毁性'))).toContain('未达标');
    expect(card('总辐射功率').props.class).toBe('objective');expect(text(card('总辐射功率'))).toContain('0W');expect(text(card('总辐射功率'))).toContain('最小化目标');
    // 在组件边界验证重复结论；HTTP 解析仍沿用原有校验规则。
    planning.result!.checks.push({...planning.result!.checks[0]});planning.result!.checks=planning.result!.checks.filter(x=>x.id!=='survivability');
    planning.result!.metrics.connectivityPercent=null;planning.result!.metrics.totalRadiatedPowerW=null;await nextTick();
    for(const label of ['连通率','抗毁性']){expect(card(label).props.class).toBe('unknown');expect(text(card(label))).toContain('未提供校验结论');}
    expect(text(find(card('连通率'),n=>n.tag==='strong')!)).toBe('未提供');expect(text(find(card('总辐射功率'),n=>n.tag==='strong')!)).toBe('未提供');expect(card('总辐射功率').props.class).toBe('objective');
  });
  it('覆盖控件接线到地图，切页签和结果保持偏好，重新进入恢复自动',async()=>{
    serverTask.active_job_id='J1';serverJob=jobDto();
    const {root,planning,router}=await mount();await vi.waitFor(()=>expect(planning.result?.snapshotId).toBe('S1'));
    await button(root,'覆盖与场强').props.onClick();await nextTick();
    const map=()=>find(root,n=>n.tag==='map-stub')!;
    const control=()=>find(root,n=>n.tag==='select'&&n.props['aria-label']==='覆盖显示方式')!;
    expect(map().props).toMatchObject({coverageDisplay:'auto',showCoverage:true});
    const calls=fetcher.mock.calls.length;
    control().props.onChange({target:{value:'contour'}});await nextTick();
    expect(map().props.coverageDisplay).toBe('contour');
    await button(root,'路由路径').props.onClick();await nextTick();expect(map().props.showCoverage).toBe(false);
    await button(root,'覆盖与场强').props.onClick();await nextTick();expect(control().props.value).toBe('contour');
    control().props.onChange({target:{value:'raster'}});await nextTick();expect(map().props.coverageDisplay).toBe('raster');
    expect(fetcher.mock.calls).toHaveLength(calls); // 纯显示选择不提交计算、保存或读取新业务数据。
    serverJob.result.snapshot_id='S2';await planning.refreshJob();await nextTick();
    expect(map().props.overlay.snapshotId).toBe('S2');expect(control().props.value).toBe('raster');
    await router.push('/situation');await nextTick();await router.push('/planning?taskId=T1');
    await vi.waitFor(()=>expect(find(root,n=>n.tag==='map-stub')?.props.coverageDisplay).toBe('auto'));
  });
  it('选择缺失的轮廓不改成场强图，空覆盖与缺PNG均有具体提示',async()=>{
    serverTask.active_job_id='J1';serverJob=jobDto();
    const {root,planning}=await mount();await vi.waitFor(()=>expect(planning.result?.snapshotId).toBe('S1'));
    await button(root,'覆盖与场强').props.onClick();await nextTick();
    const control=()=>find(root,n=>n.tag==='select'&&n.props['aria-label']==='覆盖显示方式')!;
    planning.result!.coverage.contour=null;control().props.onChange({target:{value:'contour'}});await nextTick();
    expect(text(root)).toContain('此结果未提供覆盖轮廓');expect(find(root,n=>n.tag==='map-stub')!.props.coverageDisplay).toBe('contour');
    planning.result!.coverage.rasterPng=null;control().props.onChange({target:{value:'auto'}});await nextTick();expect(text(root)).toContain('此结果未提供覆盖数据');
    planning.result!.coverage.contour={type:'FeatureCollection',features:[]};await nextTick();expect(text(root)).toContain('此结果未提供覆盖数据');
    await planning.refreshJob();planning.result!.coverage.rasterPng=null;control().props.onChange({target:{value:'raster'}});await nextTick();
    expect(text(root)).toContain('此结果未提供场强热力图，显示已有覆盖轮廓');
  });
  it('从保存方案调整后同步 URL 不重新打开旧作业',async()=>{
    serverPlans=[planDto()];serverTask.active_job_id='J1';serverJob=jobDto();
    const {planning,router,task}=await mount('/planning?taskId=T1&planId=P-1');await vi.waitFor(()=>expect(planning.selectedPlan?.id).toBe('P-1'));
    await planning.adjust();await vi.waitFor(()=>expect(router.currentRoute.value.query).toEqual({taskId:'T1'}));
    expect(planning.step).toBe(1);expect(planning.parentPlanId).toBe('P-1');expect(planning.job).toBeNull();expect(task.draft).not.toBeNull();
  });
  it('保存期间重复状态更新只同步一次 URL，保持第三步；外部定位和后退仍恢复目标',async()=>{
    serverTask.active_job_id='J1';serverJob=jobDto();const {root,planning,router}=await mount();
    await vi.waitFor(()=>expect(planning.job?.state).toBe('SUCCESS'));planning.step=3;await nextTick();
    // 模拟浏览器的异步导航守卫，让保存后的状态刷新与 URL 同步发生重叠。
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let navigations=0;
    const unregister=router.beforeEach(async to=>{if(to.query.planId==='P-1'){navigations++;await gate;}return true;});
    try{await button(root,'保存为方案').props.onClick();await nextTick();}finally{release();}
    await vi.waitFor(()=>expect(router.currentRoute.value.query.planId).toBe('P-1'));await nextTick();unregister();
    expect(navigations).toBe(1);expect(planning.step).toBe(3);expect(visible(button(root,'转正并设为当前方案'))).toBe(true);
    await router.push('/planning?taskId=T1&editTask=1');await vi.waitFor(()=>expect(planning.step).toBe(1));
    router.back();await vi.waitFor(()=>{expect(router.currentRoute.value.query.planId).toBe('P-1');expect(planning.step).toBe(2);});
    expect(planning.selectedPlan?.id).toBe('P-1');
  });
  it('内部 URL 同步等待时仍响应外部新任务定位，旧导航完成后不覆盖新目标',async()=>{
    serverTask.active_job_id='J1';serverJob=jobDto();const {root,planning,router,task}=await mount();
    await vi.waitFor(()=>expect(planning.job?.state).toBe('SUCCESS'));planning.step=3;await nextTick();
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    const unregister=router.beforeEach(async to=>{if(to.query.planId==='P-1')await gate;return true;});
    const replacements=vi.spyOn(router,'replace');vi.spyOn(previewService,'getTaskInput').mockImplementation(async request=>({...apiTask(),taskId:request.taskId}));
    try{
      await button(root,'保存为方案').props.onClick();await nextTick();expect(replacements).toHaveBeenCalled();
      await router.push('/planning?taskId=T2&editTask=1');await vi.waitFor(()=>expect(task.taskId).toBe('T2'));
    }finally{release();unregister();}
    await Promise.all(replacements.mock.results.map(result=>result.value));await nextTick();
    expect(task.taskId).toBe('T2');expect(planning.step).toBe(1);expect(router.currentRoute.value.query).toEqual({taskId:'T2',editTask:'1'});
  });
  it('独立规划路由渲染三步和真实任务字段，不调用全量 Mock 工作区',async()=>{
    const route=applicationRouter.getRoutes().find(r=>r.path==='/planning')?.components?.default as ()=>Promise<{default:Component}>;expect((await route()).default).toBe(PlanningPage);
    const preview=vi.spyOn(previewService,'loadPreview'),legacy=vi.spyOn(previewService,'loadPlanningWorkspace'),{root,task}=await mount();
    expect(text(root)).toContain('任务与约束输入');expect(text(root)).toContain('规划计算与结果');expect(task.nodes).toHaveLength(2);expect(preview).not.toHaveBeenCalled();expect(legacy).not.toHaveBeenCalled();expect(find(root,n=>n.tag==='map-stub')!.props.overlay.demands[0].id).toBe('D1');
  });
  it('页面保存任务→提交→查询结果→保存版本→确认，写入带同一会话保护',async()=>{
    const {root,task,planning,router}=await mount();task.draft!.name='页面修改';await nextTick();await button(root,'保存任务').props.onClick();expect(task.saved!.input.name).toBe('页面修改');
    await button(root,'提交规划').props.onClick();await vi.waitFor(()=>expect(planning.job?.state).toBe('RUNNING'));expect(planning.step).toBe(2);
    serverJob={...jobDto(),input:serverTask.input,input_version:serverTask.input_version};await planning.refreshJob();await nextTick();expect(text(root)).toContain('总辐射功率');expect(planning.result!.coverage.contour!.features).toHaveLength(1);
    planning.step=3;await nextTick();await button(root,'保存为方案').props.onClick();await vi.waitFor(()=>expect(router.currentRoute.value.query.planId).toBe('P-1'));expect(planning.selectedPlan!.state).toBe('SAVED');expect(planning.step).toBe(3);
    const confirm=button(root,'转正并设为当前方案').props.onClick();await nextTick();task.answer('save');await confirm;expect(planning.selectedPlan!.current).toBe(true);expect(planning.step).toBe(3);
    const writes=fetcher.mock.calls.filter(([,init])=>['POST','PUT','DELETE'].includes(init?.method??''));expect(writes.length).toBeGreaterThanOrEqual(4);expect(writes.every(([,init])=>new Headers(init!.headers).get('X-CSRF-Token')==='csrf')).toBe(true);
  });
  it('前往 GIS 先处理任务草稿，取消保留现场，保存成功才离开；视野变化不提交规划',async()=>{
    const {root,task,router}=await mount();task.draft!.description='规划未保存的草稿';
    let leaving=router.push('/situation');await vi.waitFor(()=>expect(task.decision).not.toBeNull());task.answer('cancel');await leaving;
    expect(router.currentRoute.value.path).toBe('/planning');expect(task.draft!.description).toBe('规划未保存的草稿');
    leaving=router.push('/situation');await vi.waitFor(()=>expect(task.decision).not.toBeNull());task.answer('save');await leaving;
    // 页面就绪以当前 GIS 主标题与实际路由为准，继续核对保存后才离开的业务结果。
    await vi.waitFor(()=>expect(find(root,n=>n.tag==='h1'&&text(n).trim()==='GIS 态势')).toBeDefined());expect(router.currentRoute.value.path).toBe('/situation');expect(serverTask.input.description).toBe('规划未保存的草稿');expect(task.dirty).toBe(false);
    await router.push('/planning');await vi.waitFor(()=>expect(task.context).toBe('planning'));find(root,n=>n.tag==='map-stub')!.props.onTestViewport([114,37,115,38],12);await new Promise(r=>setTimeout(r,280));expect(fetcher.mock.calls.some(([url])=>String(url).endsWith('/plan/sr4-flow'))).toBe(false);
  });
  it('GIS 编辑入口明确进入第一步，已有作业和方案定位仍进入原结果',async()=>{
    serverTask.active_job_id='J1';serverJob=jobDto();serverPlans=[planDto()];
    const {planning,router,task}=await mount('/planning?taskId=T1&editTask=1');
    expect(planning.step).toBe(1);expect(router.currentRoute.value.query).toEqual({taskId:'T1',editTask:'1'});expect(task.taskId).toBe('T1');
    await router.push('/planning?taskId=T1&jobId=J1');await vi.waitFor(()=>expect(planning.job?.id).toBe('J1'));expect(planning.step).toBe(2);
    await router.push('/planning?taskId=T1&planId=P-1');await vi.waitFor(()=>expect(planning.selectedPlan?.id).toBe('P-1'));expect(planning.step).toBe(2);
  });
  it('无效编辑定位或目标任务读取失败不冒充切换成功，也不覆盖草稿',async()=>{
    const {root,router,task}=await mount();task.draft!.name='原任务未保存输入';
    await router.push('/planning?taskId=T1&editTask=1&jobId=J1');await vi.waitFor(()=>expect(text(root)).toContain('定位参数无效'));expect(task.draft!.name).toBe('原任务未保存输入');
    task.draft!.name=task.saved!.input.name;
    const original=fetcher.getMockImplementation()!;fetcher.mockImplementation((url,init)=>String(url).includes('/task-inputs/MISSING')?Promise.resolve(response(null,1404,404)):original(url,init));
    await router.push('/planning?taskId=MISSING&editTask=1');await vi.waitFor(()=>expect(text(root)).toContain('尚未切换到目标任务'));expect(task.taskId).toBe('T1');
  });
  it('快速更换编辑目标时只恢复最新路由，迟到任务不覆盖当前任务',async()=>{
    const {router,task,planning}=await mount();let finish!:(value:ReturnType<typeof apiTask>)=>void;
    vi.spyOn(previewService,'getTaskInput').mockImplementation(async request=>request.taskId==='T2'?new Promise(resolve=>{finish=resolve;}):{...apiTask(),taskId:request.taskId});
    await router.push('/planning?taskId=T2&editTask=1');await vi.waitFor(()=>expect(finish).toBeDefined());
    await router.push('/planning?taskId=T3&editTask=1');await vi.waitFor(()=>expect(task.taskId).toBe('T3'));finish({...apiTask(),taskId:'T2'});await nextTick();
    expect(task.taskId).toBe('T3');expect(planning.step).toBe(1);expect(router.currentRoute.value.query).toEqual({taskId:'T3',editTask:'1'});
  });
  it('已有需求可以进入编辑抽屉，失权后草稿仍显示而写操作禁用',async()=>{
    const {root,task,auth}=await mount();await button(root,'编辑').props.onClick();await nextTick();expect(text(root)).toContain('应用到任务草稿');task.draft!.name='保留现场';permissions=['planning.view','situation.view'];await vi.waitFor(async()=>{await auth.check();expect(task.editable).toBe(false);});await nextTick();expect(task.draft!.name).toBe('保留现场');expect(button(root,'保存任务').props.disabled).toBe(true);
  });
});
