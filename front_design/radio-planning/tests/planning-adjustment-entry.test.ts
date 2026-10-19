import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import PlanningView from '../src/views/PlanningView.vue';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import PlanningApiVersionsPanel from '../src/components/PlanningApiVersionsPanel.vue';
import PlanningAdjustmentDrawer from '../src/components/PlanningAdjustmentDrawer.vue';
import PlanningAdjustmentPreview from '../src/components/PlanningAdjustmentPreview.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { ApiError } from '../src/services/types';
import { usePreviewStore } from '../src/stores/preview';
import { usePlanningStore } from '../src/stores/planning';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useResourceReadStore } from '../src/stores/resource-read';
import { planningPresets } from '../src/mocks/planning-presets';
import { authorizeStore } from './helpers/auth';
import { savedRequest } from './helpers/tasks';
import { TestStorage } from './helpers/storage';
import { apiJob, apiPlan, storeFixture } from './fixtures/planning-api';

// 只替换画布和浮层宿主；真实页面、调整输入和预览组件均运行编译模板。
vi.mock('../src/components/MapCanvas.vue',async()=>{const {defineComponent,h}=await import('vue');return{default:defineComponent({inheritAttrs:false,props:['stations','links','mockCoverage','planningOverlay'],setup:props=>()=>h('map-probe',{...props})})};});
vi.mock('../src/components/AppDrawer.vue',async()=>{const {defineComponent,h}=await import('vue');return{default:defineComponent({inheritAttrs:false,props:['visible','title'],render(){return this.visible?h('drawer-probe',{title:this.title},[this.$slots.default?.(),this.$slots.footer?.()]):null;}})};});
vi.mock('../src/components/AppTable.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/TaskWorkspacePanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/TaskApiPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceReadStatus.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiProgressPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiResultPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiFeedback.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningProgressPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanComparisonPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanExportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
for(const [component,filename] of [[PlanningView,'src/views/PlanningView.vue'],[PlanningApiView,'src/views/PlanningApiView.vue'],[PlanningApiVersionsPanel,'src/components/PlanningApiVersionsPanel.vue'],[PlanningAdjustmentDrawer,'src/components/PlanningAdjustmentDrawer.vue'],[PlanningAdjustmentPreview,'src/components/PlanningAdjustmentPreview.vue']] as const){
  const descriptor=parse(readFileSync(filename,'utf8'),{filename}).descriptor,bindings=compileScript(descriptor,{id:filename}).bindings;
  const compiled=compileTemplate({source:descriptor.template!.content,filename,id:filename,compilerOptions:{mode:'function',bindingMetadata:bindings}});
  if(compiled.errors.length)throw new Error(compiled.errors.map(String).join('\n'));
  const rendered=await transformWithEsbuild(`function createRender(Vue) { ${compiled.code} }`,'adjustment-entry-render.ts',{loader:'ts'});
  (component as Vue.ComponentOptions).render=new Function('Vue',rendered.code+';return createRender(Vue);')(Vue);
}
interface Host {tag:string;tagName:string;text:string;parent:Host|null;children:Host[];props:Record<string,any>;style:Record<string,string>;value?:unknown;options:Host[];selected?:boolean;selectedIndex?:number;multiple?:boolean;addEventListener:(event:string,handler:Function)=>void;removeEventListener:()=>void;getRootNode:()=>Document}
function node(tag:string,text=''):Host{return{tag,tagName:tag.toUpperCase(),text,parent:null,children:[],props:{},style:{},get options(){return this.children.filter(row=>row.tag==='option');},addEventListener:()=>{},removeEventListener:()=>{},getRootNode:()=>document};}
function remove(child:Host){if(child.parent)child.parent.children.splice(child.parent.children.indexOf(child),1);child.parent=null;}
function insert(child:Host,parent:Host,anchor?:Host|null){remove(child);child.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,child);}
const renderer=createRenderer<Host,Host>({insert,remove,createElement:tag=>node(tag),createText:text=>node('#text',text),createComment:text=>node('#comment',text),setText:(el,text)=>{el.text=text;},setElementText:(el,text)=>{el.text=text;el.children=[];},parentNode:el=>el.parent,nextSibling:el=>el.parent?.children[el.parent.children.indexOf(el)+1]??null,patchProp:(el,key,_old,value)=>{el.props[key]=value;if(key==='value')el.value=value;},insertStaticContent:(text,parent,anchor)=>{const el=node('#static',text);insert(el,parent,anchor);return[el,el];}});
const textOf=(root:Host):string=>root.text+root.children.map(textOf).join('');
const all=(root:Host,predicate:(row:Host)=>boolean):Host[]=>[...(predicate(root)?[root]:[]),...root.children.flatMap(child=>all(child,predicate))];
const button=(root:Host,label:string)=>all(root,row=>row.tag==='button'&&textOf(row).trim()===label)[0];
const control=(root:Host,label:string)=>all(root,row=>row.props['aria-label']===label)[0];
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();await nextTick();}
async function click(root:Host,label:string){const entry=button(root,label);expect(entry,label).toBeDefined();expect(entry.props.disabled,`${label} 可操作`).not.toBe(true);await entry.props.onClick();await flush();}
async function input(root:Host,label:string,value:string){const entry=control(root,label);expect(entry).toBeDefined();entry.props.onInput({target:{value}});await flush();}
let app:App<Host>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
async function mount(component:typeof PlanningView){
  vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',new EventTarget());
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/planning',component},{path:'/situation',component:{render:()=>null}}]});
  app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia!);app.use(router);app.provide(ssrContextKey,{});
  await router.push('/planning');await router.isReady();const root=node('root');app.mount(root);await flush();return{root,router};
}
async function mockEntry(){
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));pinia=createPinia();setActivePinia(pinia);
  const storage=new TestStorage(),raw=createMockService(()=>storage),target=previewService as unknown as Record<string,(...args:any[])=>Promise<any>>;
  for(const[name,method]of Object.entries(raw))if(typeof method==='function')vi.spyOn(target,name).mockImplementation(method);
  const auth=authorizeStore();
  const request=await savedRequest(storage,{baseRevision:'initial',requestId:'parent-job',taskId:null,parentPlanVersionId:null,input:structuredClone(planningPresets[0].input)});
  const submitted=await raw.submitPlanning(request);vi.setSystemTime(Date.now()+20000);
  const saved=await raw.savePlanVersion({baseRevision:submitted.workspace.revision,jobId:submitted.view.job.id,requestId:'parent-save',name:'父方案',note:''});
  await usePreviewStore().load();const planning=usePlanningStore();await planning.load();await planning.selectPlan(saved.plan.id);planning.step=3;
  return{...await mount(PlanningView),planning,storage,raw,auth,parent:saved.plan};
}
async function apiEntry(){
  const fixture=await storeFixture();pinia=fixture.pinia;vi.spyOn(useResourceReadStore(),'activate').mockResolvedValue(true);vi.spyOn(fixture.task,'initialize').mockResolvedValue();
  const planning=usePlanningApiStore();await nextTick();planning.selectedPlan=apiPlan();planning.step=3;
  return{...fixture,planning,...await mount(PlanningApiView)};
}

describe('具体方案调整真实页面入口',()=>{
  it('Mock 从保存父方案打开逐设备输入，示例只填草稿，成功后覆盖与三指标来自新结果',async()=>{
    const s=await mockEntry(),before=JSON.stringify(s.planning.draft),parent=JSON.stringify(s.parent);await click(s.root,'调整设备参数与路由');
    expect(control(s.root,'DV-0001 发射功率')).toBeDefined();expect(textOf(s.root)).toContain('原备份路径（只读）');
    await click(s.root,s.planning.adjustmentExamples.find(row=>row.id==='economical')!.label);
    expect(s.planning.adjustmentDraft!.manualOverrides).toHaveLength(6);expect(s.planning.adjustmentDraft!.manualOverrides.every(row=>row.txPowerDbm===40)).toBe(true);expect(s.planning.adjustmentResult).toBeNull();expect(JSON.stringify(s.planning.draft)).toBe(before);
    await click(s.root,'提交调整并预览');expect(s.planning.view!.state).toBe('PENDING');expect(s.planning.adjustmentOpen).toBe(false);expect(textOf(s.root)).toContain('尚无本次调整的成功结果');
    vi.setSystemTime(Date.now()+20000);await s.planning.query();await flush();expect(s.planning.adjustmentResult?.metrics.totalRadiatedPowerW).toBe(60);
    expect(textOf(s.root)).toContain('190 W');expect(textOf(s.root)).toContain('60 W');expect(textOf(s.root)).toContain('-130 W');
    const maps=all(s.root,row=>row.tag==='map-probe');expect(maps).toHaveLength(2);expect(maps[0].props.mockCoverage.rasterPng.url).not.toBe(maps[1].props.mockCoverage.rasterPng.url);
    expect(JSON.stringify(s.planning.draft)).toBe(before);expect(JSON.stringify(s.parent)).toBe(parent);
    const jobId=s.planning.jobId;s.planning.clearForSession();await s.planning.load();await flush();
    expect(s.planning.jobId).toBe(jobId);expect(s.planning.adjustmentParent?.id).toBe(s.parent.id);expect(s.planning.adjustmentResult?.metrics.totalRadiatedPowerW).toBe(60);expect(s.planning.adjustmentDirty).toBe(false);expect(s.planning.step).toBe(3);
  });
  it('0 与空白不同，非法数值阻止提交，路径可增删排序且备份路径不被改写',async()=>{
    const s=await mockEntry();await click(s.root,'调整设备参数与路由');
    await input(s.root,'DV-0001 发射功率','0');expect(s.planning.adjustmentDraft!.manualOverrides[0].txPowerDbm).toBe(0);
    await input(s.root,'DV-0001 天线高度','-1');expect(button(s.root,'提交调整并预览').props.disabled).toBe(true);
    await input(s.root,'DV-0001 天线高度','');await input(s.root,'DV-0001 发射功率','not-a-number');expect(button(s.root,'提交调整并预览').props.disabled).toBe(true);
    await click(s.root,'恢复原值');expect(s.planning.adjustmentDraft!.manualOverrides).toEqual([]);
    const route=all(s.root,row=>row.props['data-demand'])[0],demand=route.props['data-demand'],original=s.parent.workflow!.configuration.routes.filter(row=>row.backup);
    await click(route,'增加中间节点');const nodes=[...s.planning.adjustmentDraft!.manualPaths[0].nodePath];
    await click(route,'移除');expect(s.planning.adjustmentDraft!.manualPaths[0].nodePath).toHaveLength(nodes.length-1);
    await click(route,'恢复原路径');expect(s.planning.adjustmentDraft!.manualPaths.some(row=>row.demandId===demand)).toBe(false);expect(s.parent.workflow!.configuration.routes.filter(row=>row.backup)).toEqual(original);
  });
  it('无匹配结果保留输入与父预览，关闭和离开 GIS 路由都有草稿保护',async()=>{
    const s=await mockEntry();await click(s.root,'调整设备参数与路由');await input(s.root,'DV-0001 发射功率','33');await click(s.root,'提交调整并预览');
    expect(s.planning.error).toContain('暂无');expect(s.planning.adjustmentDraft!.manualOverrides[0].txPowerDbm).toBe(33);expect(s.planning.adjustmentResult).toBeNull();
    const close=button(s.root,'关闭').props.onClick();s.planning.answer('cancel');await close;expect(s.planning.adjustmentOpen).toBe(true);
    const leave=s.router.push('/situation');await flush();expect(s.planning.decision).not.toBeNull();s.planning.answer('cancel');await leave;expect(s.router.currentRoute.value.path).toBe('/planning');
    const discard=s.planning.closeAdjustment();s.planning.answer('discard');await discard;expect(s.planning.adjustmentDraft).toBeNull();expect(s.planning.dirty).toBe(false);
  });
  it('Mock 写入回包不确定时先读原请求记录，禁止改输入或重复作业',async()=>{
    const s=await mockEntry();await click(s.root,'调整设备参数与路由');await click(s.root,s.planning.adjustmentExamples[1].label);
    vi.mocked(previewService.submitPlanning).mockImplementationOnce(async request=>{await s.raw.submitPlanning(request);throw new ApiError('回包丢失','NETWORK_ERROR');});
    await click(s.root,'提交调整并预览');expect(s.planning.adjustmentPending).not.toBeNull();expect(control(s.root,'DV-0001 发射功率').props.disabled).toBe(true);
    await click(s.root,'核实原调整请求');expect(s.planning.adjustmentPending).toBeNull();expect(s.planning.adjustmentDirty).toBe(false);expect((await s.raw.loadPlanningWorkspace()).workspace.jobs).toHaveLength(2);
  });
  it('HTTP 页面同样打开具体调整且没有目录示例时不渲染演示按钮',async()=>{
    const s=await apiEntry();await click(s.root,'调整设备参数与路由');expect(control(s.root,'E1 发射功率')).toBeDefined();expect(textOf(s.root)).not.toContain('填入演示调整');
    await input(s.root,'E1 发射功率','0');const submitted=vi.spyOn(previewService,'submitPlanningTask').mockImplementation(async request=>({...apiJob(),parentPlanId:'P-1',adjustment:request.adjustment}));
    await click(s.root,'提交调整并预览');expect(submitted).toHaveBeenCalledWith(expect.objectContaining({adjustment:expect.objectContaining({manualOverrides:[{deviceId:'E1',txPowerDbm:0}]})}));expect(textOf(s.root)).toContain('调整完成');expect(s.task.saved!.input.demands).toEqual(apiPlan().input.demands);
  });
  it('HTTP 前后预览保留未提供的指标，不补 0；来源失效时入口说明原因',async()=>{
    const s=await apiEntry();s.planning.selectedPlan!.result.metrics.totalRadiatedPowerW=null;await click(s.root,'调整设备参数与路由');
    vi.spyOn(previewService,'submitPlanningTask').mockImplementation(async request=>({...apiJob(),parentPlanId:'P-1',adjustment:request.adjustment}));await click(s.root,'提交调整并预览');
    expect(textOf(s.root)).toContain('总辐射功率变化：未提供');expect(textOf(s.root)).not.toContain('总辐射功率变化：2 W');
    s.planning.selectedPlan={...apiPlan(),sourceChanged:true};await flush();expect(button(s.root,'调整设备参数与路由').props.disabled).toBe(true);expect(textOf(s.root)).toContain('方案来源已变化');
  });
  it('HTTP 独立调整跨 GIS 页面仍询问，失权保留原输入但拒绝迟到编辑',async()=>{
    const s=await apiEntry();await click(s.root,'调整设备参数与路由');await input(s.root,'E1 发射功率','22');
    const leave=s.router.push('/situation');await flush();expect(s.task.decision?.title).toBe('未提交的方案调整');s.task.answer('cancel');await leave;expect(s.router.currentRoute.value.path).toBe('/planning');
    const stale=control(s.root,'E1 发射功率').props.onInput,identity={...s.auth.identity!};s.auth.accept({...identity,permissions:identity.permissions.filter(p=>p!=='planning.execute')});await flush();
    stale({target:{value:'10'}});await flush();expect(s.planning.adjustmentDraft!.manualOverrides[0].txPowerDbm).toBe(22);expect(control(s.root,'E1 发射功率').props.disabled).toBe(true);
    s.planning.clearForSession();await flush();expect(s.planning.adjustmentDraft).toBeNull();expect(all(s.root,row=>row.tag==='drawer-probe')).toHaveLength(0);
  });
  it('Mock 会话清理后迟到提交不恢复旧父方案或调整草稿',async()=>{
    const s=await mockEntry();await click(s.root,'调整设备参数与路由');await click(s.root,s.planning.adjustmentExamples[1].label);
    let finish!:(value:Awaited<ReturnType<typeof previewService.submitPlanning>>)=>void,request!:Parameters<typeof previewService.submitPlanning>[0];
    vi.mocked(previewService.submitPlanning).mockImplementationOnce(value=>{request=value;return new Promise(resolve=>finish=resolve);});
    const pending=s.planning.submitAdjustment();expect(s.planning.busy).toBe(true);s.planning.clearForSession();finish(await s.raw.submitPlanning(request));await pending;await flush();
    expect(s.planning.workspace).toBeNull();expect(s.planning.adjustmentParent).toBeNull();expect(s.planning.adjustmentDraft).toBeNull();expect(s.planning.jobId).toBe('');expect(s.planning.busy).toBe(false);
  });
  it.each(['save','confirm'])('Mock 调整版本 %s 晚响应不回填已清理账号现场',async kind=>{
    const s=await mockEntry();await click(s.root,'调整设备参数与路由');await click(s.root,s.planning.adjustmentExamples[1].label);await s.planning.submitAdjustment();
    vi.setSystemTime(Date.now()+20000);await s.planning.query();
    let action:Promise<unknown>;
    if(kind==='save'){
      let finish!:(value:Awaited<ReturnType<typeof previewService.savePlanVersion>>)=>void,request!:Parameters<typeof previewService.savePlanVersion>[0];
      vi.mocked(previewService.savePlanVersion).mockImplementationOnce(value=>{request=value;return new Promise(resolve=>finish=resolve);});
      action=s.planning.save('调整版本','');s.planning.clearForSession();finish(await s.raw.savePlanVersion(request));
    }else{
      await s.planning.save('调整版本','');const plan=s.planning.selectedPlan!;
      let finish!:(value:Awaited<ReturnType<typeof previewService.confirmPlanVersion>>)=>void,request!:Parameters<typeof previewService.confirmPlanVersion>[0];
      vi.mocked(previewService.confirmPlanVersion).mockImplementationOnce(value=>{request=value;return new Promise(resolve=>finish=resolve);});
      action=s.planning.confirm(plan);s.planning.answer('save');await flush();expect(s.planning.busy).toBe(true);s.planning.clearForSession();finish(await s.raw.confirmPlanVersion(request));
    }
    await action;expect(s.planning.workspace).toBeNull();expect(s.planning.selectedPlanId).toBe('');expect(s.planning.adjustmentParent).toBeNull();expect(s.planning.busy).toBe(false);
  });
  it('主路径的多个中间节点保持有序，不能在首尾之外交换需求端点',async()=>{
    const s=await apiEntry(),parent=s.planning.selectedPlan!;
    parent.result.nodes.push({...apiPlan().result.nodes[0],id:'N3'},{...apiPlan().result.nodes[0],id:'N4'});await click(s.root,'调整设备参数与路由');
    const route=all(s.root,row=>row.props['data-demand']==='D1')[0];await click(route,'增加中间节点');await click(route,'增加中间节点');
    expect(s.planning.adjustmentDraft!.manualPaths[0].nodePath).toEqual(['N1','N3','N4','N2']);await click(route,'下移');
    expect(s.planning.adjustmentDraft!.manualPaths[0].nodePath).toEqual(['N1','N4','N3','N2']);expect(button(route,'上移').props.disabled).toBe(true);
  });
  it('HTTP 原结果未提供主路由时可显式填写，需求两端不冒充已有结果',async()=>{
    const s=await apiEntry();s.planning.selectedPlan!.result.configuration.routes=[];await click(s.root,'调整设备参数与路由');
    expect(textOf(s.root)).toContain('原路径：未提供');expect(s.planning.adjustmentDraft!.manualPaths).toEqual([]);
    await click(s.root,'设置两端主路径');expect(s.planning.adjustmentDraft!.manualPaths).toEqual([{demandId:'D1',nodePath:['N1','N2']}]);
    await click(s.root,'恢复原路径');expect(s.planning.adjustmentDraft!.manualPaths).toEqual([]);expect(textOf(s.root)).toContain('原路径：未提供');
  });
});
