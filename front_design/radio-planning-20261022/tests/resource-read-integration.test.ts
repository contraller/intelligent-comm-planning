import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import * as Vue from 'vue';
import { createRenderer, nextTick, ssrContextKey, type App, type Component } from 'vue';
// 特殊编译参数由调用处显式指定，宿主和业务断言保持本地。
import { clientTemplate } from './helpers/vue-client';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { router as applicationRouter } from '../src/router';
import { previewService, releasePageSessionBinding } from '../src/services';
import { useAuthStore } from '../src/stores/auth';
import { useResourceReadStore } from '../src/stores/resource-read';
import { decodeObject } from '../src/services/resource-read-validation';
import AppShell from '../src/layouts/AppShell.vue';
import Ledger from '../src/views/ResourcesView.vue';
import ResourceLedgerEditDrawer from '../src/components/ResourceLedgerEditDrawer.vue';
import ResourceLedgerImportDrawer from '../src/components/ResourceLedgerImportDrawer.vue';
import ResourceLedgerExportDrawer from '../src/components/ResourceLedgerExportDrawer.vue';
import DeviceConfigurationDrawer from '../src/components/DeviceConfigurationDrawer.vue';
import ResourceLedgerTree from '../src/components/ResourceLedgerTree.vue';
import ResourceLedgerFilters from '../src/components/ResourceLedgerFilters.vue';
import SpectrumConfigPanel from '../src/components/SpectrumConfigPanel.vue';
import { useSpectrumStore } from '../src/stores/spectrum';
import MapPage from '../src/views/SituationView.vue';
import GisResourceTree from '../src/components/GisResourceTree.vue';
import GisObjectInfoPanel from '../src/components/GisObjectInfoPanel.vue';
import DeviceInfoPanel from '../src/components/DeviceInfoPanel.vue';
import AppTable from '../src/components/AppTable.vue';
import AppDrawer from '../src/components/AppDrawer.vue';
import StatusBadge from '../src/components/StatusBadge.vue';
import ReadStatus from '../src/components/ResourceReadStatus.vue';

// 使用真实 HTTP 入口、访问校验、状态层与客户端模板；宿主不代替浏览器布局验收。
vi.mock('../src/config/env',async original=>{const module=await original<typeof import('../src/config/env')>();return{...module,env:{...module.env,mode:'http'}};});
vi.mock('vue-router',async original=>{const module=await original<typeof import('vue-router')>();return{...module,createWebHashHistory:module.createMemoryHistory};});
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/ResourceStatusPanel.vue',()=>({default:{render:()=>null}}));
vi.mock('primevue/dialog',async()=>{const {h}=await import('vue');return{default:{props:['visible'],setup:(props:any,{slots}:any)=>()=>props.visible?h('dialog',{},[slots.header?.(),slots.default?.(),slots.footer?.()]):null}};});
vi.mock('primevue/drawer',async()=>{const {h}=await import('vue');return{default:{props:['visible'],setup:(props:any,{slots}:any)=>()=>props.visible?h('aside',{},[slots.default?.(),slots.footer?.()]):null}};});
// 信息分组保留真实设备字段，PrimeVue 页签在独立组件测试验证。
vi.mock('../src/components/DeviceDetailTabs.vue', async () => {
  const { h } = await import('vue');
  return { default: { inheritAttrs: false, setup(_: unknown, { slots }: { slots: Vue.Slots }) {
    return () => h('div', [slots.basic?.(), slots.structure?.(), slots.functions?.(), slots.parameters?.(), slots.network?.(), slots.actions?.()]);
  } } };
});
vi.mock('primevue/column',()=>({default:{render:()=>null}}));
vi.mock('primevue/datatable',async()=>{const {h}=await import('vue');return{default:{props:['value','lazy','totalRecords','first','rows','sortField','sortOrder'],emits:['page','sort','update:selection'],setup:(props:any,{emit}:any)=>()=>h('table-stub',{...props,onTestPage:(value:any)=>emit('page',value),onTestSort:(value:any)=>emit('sort',value),onTestSelect:(value:any)=>emit('update:selection',value)})}};});
const mapCalls=vi.hoisted(()=>({locate:vi.fn(),expand:vi.fn()}));
vi.mock('../src/components/MapCanvas.vue',async()=>{const {h}=await import('vue');return{default:{props:['resourceRead','resourceFrame'],emits:['viewport','selectCluster','selectResource'],setup:(props:any,{emit,expose}:any)=>{expose({locateResource:mapCalls.locate,expandResource:mapCalls.expand});return()=>h('map-stub',{...props,onTestViewport:(bbox:any,zoom:number)=>emit('viewport',bbox,zoom),onTestCluster:(value:any)=>emit('selectCluster',value),onTestSelect:(value:any)=>emit('selectResource',value)});}}};});

// 将 SFC 的客户端 render 放回原对象，让其子组件引用也执行客户端模板。
for(const [component,file] of [[ResourceLedgerEditDrawer,'components/ResourceLedgerEditDrawer'],[ResourceLedgerImportDrawer,'components/ResourceLedgerImportDrawer'],[ResourceLedgerExportDrawer,'components/ResourceLedgerExportDrawer'],[DeviceConfigurationDrawer,'components/DeviceConfigurationDrawer'],[AppShell,'layouts/AppShell'],[Ledger,'views/ResourcesView'],[ResourceLedgerTree,'components/ResourceLedgerTree'],[ResourceLedgerFilters,'components/ResourceLedgerFilters'],[SpectrumConfigPanel,'components/SpectrumConfigPanel'],[MapPage,'views/SituationView'],[GisResourceTree,'components/GisResourceTree'],[GisObjectInfoPanel,'components/GisObjectInfoPanel'],[DeviceInfoPanel,'components/DeviceInfoPanel'],[AppTable,'components/AppTable'],[AppDrawer,'components/AppDrawer'],[StatusBadge,'components/StatusBadge'],[ReadStatus,'components/ResourceReadStatus']] as const){
  const filename=`src/${file}.vue`;
  await clientTemplate(component,filename,'resource-template.ts',{hoistStatic:false});
}
interface Host {tag:string;tagName:string;text:string;parent:Host|null;children:Host[];options:Host[];props:Record<string,any>;style:Record<string,string>;value?:unknown;addEventListener:()=>void;removeEventListener:()=>void;getRootNode:()=>{activeElement:null}}
const node=(tag:string,text=''):Host=>({tag,tagName:tag.toUpperCase(),text,parent:null,children:[],get options(){return this.children.filter(n=>n.tag==='option');},props:{},style:{},addEventListener(){},removeEventListener(){},getRootNode:()=>({activeElement:null})});
function remove(child:Host){if(child.parent)child.parent.children.splice(child.parent.children.indexOf(child),1);child.parent=null;}
function insert(child:Host,parent:Host,anchor?:Host|null){remove(child);child.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,child);}
const renderer=createRenderer<Host,Host>({insert,remove,createElement:tag=>node(tag),createText:text=>node('#text',text),createComment:text=>node('#comment',text),setText:(el,text)=>{el.text=text;},setElementText:(el,text)=>{el.text=text;el.children=[];},parentNode:el=>el.parent,nextSibling:el=>el.parent?.children[el.parent.children.indexOf(el)+1]??null,patchProp:(el,key,_old,value)=>{el.props[key]=value;},insertStaticContent:(text,parent,anchor)=>{const el=node('#static',text);insert(el,parent,anchor);return[el,el];}});
function text(root:Host):string{return root.text+root.children.map(text).join('');}
function find(root:Host,predicate:(node:Host)=>boolean):Host|undefined{if(predicate(root))return root;for(const child of root.children){const match=find(child,predicate);if(match)return match;}}
const response=(data:unknown,code=0,status=200)=>new Response(JSON.stringify({code,message:code?'版本过期':'ok',data}),{status});
const device=(id='D1')=>({device_id:id,node_id:'N1',model_id:'M1',antenna_id:'A1',node_name:'节点一',node_lon:114,node_lat:37,model_name:'短波设备',antenna_name:'天线一',device_class:'HF',status:'NORMAL'});
const readNode=(id='N1')=>({node_id:id,node_name:'节点'+id,lon:114,lat:37,parent_node_id:'',echelon:'营',mobility:'固定',device_class:'HF;VUHF',status:'NORMAL',relay_capable:true,is_key:false,child_count:0,device_count:1});
let pinia:ReturnType<typeof createPinia>,fetcher:ReturnType<typeof vi.fn<typeof fetch>>,version:string,conflict:boolean,apps:App[],permissions:string[];
beforeEach(()=>{
  releasePageSessionBinding();pinia=createPinia();setActivePinia(pinia);version='v1';conflict=false;apps=[];permissions=['resources.view','situation.view'];mapCalls.locate.mockClear();mapCalls.expand.mockClear();
  // 新目录传输待确认，仅注入共同轻目录契约；地图和聚合仍走真实 HTTP 适配。
  vi.spyOn(previewService, 'loadGisResourceDirectory').mockImplementation(async input => ({ revision: input.revision, resources: {
    stations: Array.from({ length: 12 }, (_, i) => decodeObject('node', readNode('N' + (i + 1)))).filter(row => row.kind === 'node'),
    devices: Array.from({ length: 21 }, (_, i) => decodeObject('device', device('D' + (i + 1)))).filter(row => row.kind === 'device').map(({ id, stationId, modelId, status, alert, availability, origin }) => ({ id, stationId, modelId, status, alert, availability, origin })),
    models: [{ id: 'M1', name: '短波设备', deviceClass: 'HF' }], interferences: [], source: '资源接口', version: input.revision,
  } }));
  vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('document',{title:'',addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('Document',class{});vi.stubGlobal('ShadowRoot',class{});
  fetcher=vi.fn<typeof fetch>(async input=>{
    const url=new URL(String(input),'http://local'),path=url.pathname,p=url.searchParams;
    if(path.endsWith('/auth/session'))return response({session_id:'S1',account_id:'U1',username:'reader',display_name:'资源浏览者',role_id:'R1',role_name:'只读',permissions,identity_revision:'a1',session_generation:'e1'});
    if(path.endsWith('/resource/context'))return response({revision:version,bounds:[113,36,115,38],updated_at:'2026-10-05T00:00:00Z',source:'资源接口',stats:{nodes:12,devices:21,models:1,interferences:0,hf:21,vuhf:0}});
    if(conflict||p.get('revision')!==version)return response({},1201,409);
    if(path.endsWith('/resource/map'))return response({revision:version,bbox:p.get('bbox')!.split(',').map(Number),zoom:Number(p.get('zoom')),points:[],clusters:p.get('show_nodes')==='true'?[{kind:'node',cluster_id:'C1',lon:114,lat:37,count:12,bounds:[113.9,36.9,114.1,37.1],expansion_zoom:null}]:[],total_nodes:p.get('show_nodes')==='true'?12:0,total_interferences:0});
    if(path.endsWith('/resource/devices')||path.endsWith('/resource/nodes')||path.endsWith('/resource/interference-sources')){
      const page=Number(p.get('page')),size=Number(p.get('page_size')),isDevices=path.endsWith('devices'),total=path.endsWith('interference-sources')?0:isDevices?21:12;
      const items=Array.from({length:Math.min(size,Math.max(0,total-(page-1)*size))},(_,i)=>isDevices?device('D'+((page-1)*size+i+1)):readNode('N'+((page-1)*size+i+1)));
      return response({revision:version,page,page_size:size,total,items});
    }
    if(path.endsWith('/resource/device-models'))return response({revision:version,items:[{model_id:'M1',model_name:'短波设备',device_class:'HF',freq_min_khz:1,freq_max_khz:100,tx_power_max_dbm:40,modulation:['AM'],work_mode:['simplex']}]});
    if(path.endsWith('/resource/antenna-models'))return response({revision:version,items:[{antenna_id:'A1',antenna_name:'天线一'}]});
    if(path.includes('/resource/devices/'))return response({revision:version,item:device(path.split('/').at(-1))});
    if(path.includes('/resource/nodes/'))return response({revision:version,item:readNode(path.split('/').at(-1))});
    throw new Error('未授权业务路径：'+path);
  });vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{for(const app of apps)app.unmount();disposePinia(pinia);releasePageSessionBinding();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function mount(path='/resources',component:Component={render:()=>Vue.h(RouterView)}){
  const auth=useAuthStore();await auth.check();auth.currentPath=path.split('?')[0];
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:AppShell,children:[{path:'resources',component:Ledger},{path:'situation',component:MapPage}]}]});
  await router.push(path);const app=renderer.createApp(component),root=node('root');app.use(pinia);app.use(router);app.provide(ssrContextKey,{});apps.push(app);app.mount(root);
  await vi.waitFor(()=>expect(useResourceReadStore().workspace).not.toBeNull());await nextTick();return{root,router,store:useResourceReadStore()};
}
describe('资源 HTTP 页面组合',()=>{
  it('路由复用共用 GIS 页，进入台账不加载 Preview/规划/频谱或写接口',async()=>{
    const ledger=applicationRouter.getRoutes().find(r=>r.path==='/resources')?.components?.default as ()=>Promise<{default:Component}>;
    const map=applicationRouter.getRoutes().find(r=>r.path==='/situation')?.components?.default as ()=>Promise<{default:Component}>;
    expect((await ledger()).default).toBe(Ledger);expect((await map()).default).toBe(MapPage);
    const preview=vi.spyOn(previewService,'loadPreview'),planning=vi.spyOn(previewService,'loadPlanningWorkspace'),{root,store}=await mount();
    expect(preview).not.toHaveBeenCalled();expect(planning).not.toHaveBeenCalled();expect(text(root)).toContain('设备 21 台');expect(text(root)).toContain('21');
    expect(find(root,n=>n.tag==='table-stub')?.props).toMatchObject({lazy:true,totalRecords:21,first:0});
    expect(find(root,n=>n.tag==='button'&&text(n).trim()==='新增设备')?.props.disabled).toBe(true);
    expect(store.ledger?.items).toHaveLength(10);expect(fetcher.mock.calls.every(([,init])=>(init?.method??'GET')==='GET')).toBe(true);
    // 正常 HTTP 页面不展示传输来源或技术版本，也不保留空的状态条。
    expect(text(root)).not.toContain('资源接口');expect(text(root)).not.toContain('资源版本 v1');
    expect(find(root,n=>n.props.class==='read-status')).toBeUndefined();
  });
  it('HTTP 使用同一筛选和维护入口；未实现服务显示错误，不注入 Mock 工作区',async()=>{
    permissions.push('resources.edit'); const {root}=await mount(),load=vi.spyOn(previewService,'querySpectrumSources'),maintenance=vi.spyOn(previewService,'loadResourceMaintenanceContext');
    expect(find(root,n=>n.props['aria-label']==='频率下限（kHz）')?.props.disabled).toBe(false);
    expect(text(root)).not.toContain('HTTP 部署分类');
    find(root,n=>n.tag==='button'&&text(n).trim()==='新增设备')!.props.onClick();
    await vi.waitFor(()=>expect(maintenance).toHaveBeenCalled()); await nextTick(); expect(text(root)).toContain('资源维护上下文尚未接入');
    find(root,n=>n.tag==='button'&&text(n).trim()==='关闭')!.props.onClick(); await nextTick();
    find(root,n=>n.tag==='button'&&text(n).trim()==='频谱接口配置')!.props.onClick();
    await vi.waitFor(()=>expect(load).toHaveBeenCalled()); await nextTick();
    expect(text(root)).not.toContain('资源分类'); expect(text(root)).toContain('HTTP 频谱配置读取及回执协议尚未接入');
    expect(find(root,n=>n.tag==='table-stub')?.props.value).toEqual([]);
    expect(find(root,n=>n.tag==='button'&&text(n).trim()==='新增配置')?.props.disabled).toBe(false);
    const spectrum=useSpectrumStore(),table=find(root,n=>n.tag==='table-stub')!,calls=load.mock.calls.length;
    // 模拟底层旧排序事件，频谱列表不得改查询或重新读取。
    expect(table.props.sortField).toBeUndefined();expect(table.props.sortOrder).toBeUndefined();
    table.props.onTestSort({sortField:'intervalSeconds',sortOrder:-1});await nextTick();
    expect(load).toHaveBeenCalledTimes(calls);expect(spectrum.query).toMatchObject({sort:'name',order:'asc'});
    await spectrum.open(); expect(spectrum.workspace).toBeNull(); expect(spectrum.dirty).toBe(false);
    expect(await spectrum.leave()).toBe(true); expect(spectrum.decision).toBeNull();
  });
  it('台账不响应排序，分页与搜索沿用默认顺序',async()=>{
    const {root,store}=await mount();
    await vi.waitFor(()=>expect(store.ledgerApplied).toMatchObject({sort:'id',order:'asc'}));await nextTick();
    const table=find(root,n=>n.tag==='table-stub')!,load=vi.spyOn(store,'loadLedger');
    // 模拟底层旧排序事件，台账不得改查询或重新读取。
    expect(table.props.sortField).toBeUndefined();expect(table.props.sortOrder).toBeUndefined();
    table.props.onTestSort({sortField:'displayedStatus',sortOrder:-1});await nextTick();expect(load).not.toHaveBeenCalled();
    table.props.onTestPage({first:20,rows:10});await vi.waitFor(()=>expect(store.ledger?.pageNum).toBe(3));expect(store.ledger?.items).toHaveLength(1);
    find(root,n=>n.props['aria-label']==='搜索设备')!.props.onInput({target:{value:'D'}});
    await vi.waitFor(()=>expect(store.ledgerApplied?.search).toBe('D'));expect(store.ledgerApplied).toMatchObject({pageNum:1,sort:'id',order:'asc'});
  });
  it('设备详情失败可重试，地图定位携带稳定 ID 并读取关联对象',async()=>{
    const {root,router,store}=await mount();
    vi.spyOn(previewService,'getResourceObject').mockRejectedValueOnce(new Error('详情暂时不可用'));
    find(root,n=>n.tag==='table-stub')!.props.onTestSelect(store.ledger!.items[0]);
    await vi.waitFor(()=>expect(store.errors.detail).toBe('详情暂时不可用'));expect(text(root)).toContain('详情暂时不可用');
    find(root,n=>n.tag==='button'&&text(n).trim()==='重试')!.props.onClick();
    await vi.waitFor(()=>expect(store.detail?.object.id).toBe('D1'));await nextTick();expect(text(root)).toContain('告警未提供');expect(text(root)).toContain('未提供');
    find(root,n=>n.tag==='button'&&text(n)==='地图定位')!.props.onClick();
    await vi.waitFor(()=>expect(router.currentRoute.value.query).toEqual({stationId:'N1',deviceId:'D1'}));
    await vi.waitFor(()=>expect(mapCalls.locate).toHaveBeenCalledWith([114,37]));
    expect(store.context).toBe('gis');
  });
  it('完整目录显示重叠聚合成员，拖图独立按最后视野读取',async()=>{
    const {root,store}=await mount('/situation');
    find(root,n=>n.tag==='button'&&text(n)==='按站点浏览')!.props.onClick();await nextTick();
    await vi.waitFor(()=>expect(text(root)).toContain('节点N1'));
    const map=find(root,n=>n.tag==='map-stub')!,cluster=store.frame!.clusters[0];
    map.props.onTestCluster({...cluster,expansionZoom:12});expect(mapCalls.expand).toHaveBeenCalled();
    map.props.onTestCluster(cluster);await vi.waitFor(()=>expect(text(root)).toContain('聚合成员'));
    await vi.waitFor(()=>expect(fetcher.mock.calls.some(([url])=>String(url).includes('cluster_id=C1'))).toBe(true));
    await vi.waitFor(()=>expect(text(root)).toContain('节点N12')); expect(text(root)).not.toContain('项 · 第');
    map.props.onTestViewport([113.5,36.5,114.5,37.5],11);map.props.onTestViewport([113.8,36.8,114.2,37.2],12);
    await vi.waitFor(()=>expect(store.frame?.zoom).toBe(12));expect(store.frame?.bbox).toEqual([113.8,36.8,114.2,37.2]);
    expect(text(root)).not.toContain('请放大地图');
  });
  it('服务版本变化保留原页，刷新按钮才接纳新版本',async()=>{
    const {root,store}=await mount();conflict=true;find(root,n=>n.tag==='table-stub')!.props.onTestPage({first:10,rows:10});
    await vi.waitFor(()=>expect(store.stale).toBe(true));expect(store.ledger?.revision).toBe('v1');expect(text(root)).toContain('请刷新资源');
    // 版本冻结只禁用查询与维护，迁入页头的刷新仍须可用。
    const refresh=find(root,n=>n.tag==='button'&&text(n)==='刷新资源')!;
    expect(refresh.parent?.props.class).toBe('toolbar');expect(refresh.props.disabled).toBe(false);
    conflict=false;version='v2';refresh.props.onClick();
    await vi.waitFor(()=>expect(store.workspace?.revision).toBe('v2'));expect(store.ledger?.revision).toBe('v2');expect(store.stale).toBe(false);
  });
  it('恶意/错关联定位参数可见拒绝，不把其他节点当作设备位置',async()=>{
    const {root,store}=await mount('/situation?stationId=N9&deviceId=D1');
    await vi.waitFor(()=>expect(store.notice).toBe('设备与定位节点不匹配'));expect(store.detail).toBeNull();expect(mapCalls.locate).not.toHaveBeenCalled();expect(text(root)).toContain('不匹配');
  });
});
