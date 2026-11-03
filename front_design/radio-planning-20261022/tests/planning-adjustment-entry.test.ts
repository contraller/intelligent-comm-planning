import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import PlanningApiView from '../src/views/PlanningApiView.vue';
import PlanningApiVersionsPanel from '../src/components/PlanningApiVersionsPanel.vue';
import PlanningAdjustmentDrawer from '../src/components/PlanningAdjustmentDrawer.vue';
import PlanningAdjustmentPreview from '../src/components/PlanningAdjustmentPreview.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { ApiError } from '../src/services/types';
import { usePreviewStore } from '../src/stores/preview';
import { useTaskInputStore } from '../src/stores/task-input';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useResourceReadStore } from '../src/stores/resource-read';
import { planningPresets } from '../src/mocks/planning-presets';
import { authorizeStore } from './helpers/auth';
import { savedRequest } from './helpers/tasks';
import { TestStorage } from './helpers/storage';
import { apiJob, apiPlan, storeFixture } from './fixtures/planning-api';
// 仅复用模板编译，原有宿主、替身和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';

// 只替换画布和浮层宿主；真实页面、调整输入和预览组件均运行编译模板。
vi.mock('../src/components/MapCanvas.vue',async()=>{const {defineComponent,h}=await import('vue');return{default:defineComponent({inheritAttrs:false,props:['stations','links','mockCoverage','planningOverlay'],setup:props=>()=>h('map-probe',{...props})})};});
vi.mock('../src/components/AppDrawer.vue',async()=>{const {defineComponent,h}=await import('vue');return{default:defineComponent({inheritAttrs:false,props:['visible','title'],render(){return this.visible?h('drawer-probe',{title:this.title},[this.$slots.default?.(),this.$slots.footer?.()]):null;}})};});
vi.mock('../src/components/AppTable.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/FrozenCoveragePanel.vue',()=>({default:Vue.defineComponent({inheritAttrs:false,setup(_p,{expose}){expose({requestLeave:async()=>true,hasProtectedSelection:()=>false,readCache:async()=>{}});return()=>null;}})}));
vi.mock('../src/components/TaskApiPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/ResourceReadStatus.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanningApiProgressPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
// 此文件验证第三步入口接线；配置抽屉内容与关闭保护由结果组件测试覆盖。
vi.mock('../src/components/PlanningApiResultPanel.vue',async()=>{const {defineComponent,h}=await import('vue');return{default:defineComponent({inheritAttrs:false,props:['result','ownerKey','active'],setup(props,{expose}){const openConfiguration=vi.fn();expose({openConfiguration});return()=>h('result-probe',{...props,openConfiguration});}})};});
vi.mock('../src/components/PlanningApiFeedback.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanComparisonPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/PlanExportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
for(const [component,filename] of [[PlanningApiView,'src/views/PlanningApiView.vue'],[PlanningApiVersionsPanel,'src/components/PlanningApiVersionsPanel.vue'],[PlanningAdjustmentDrawer,'src/components/PlanningAdjustmentDrawer.vue'],[PlanningAdjustmentPreview,'src/components/PlanningAdjustmentPreview.vue']] as const){
  await clientTemplate(component, filename, 'adjustment-entry-render.ts');
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
async function mount(component:typeof PlanningApiView,path='/planning'){
  vi.stubGlobal('Document',class {});vi.stubGlobal('ShadowRoot',class {});
  vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',new EventTarget());
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/planning',component},{path:'/situation',component:{render:()=>null}}]});
  app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia!);app.use(router);app.provide(ssrContextKey,{});
  await router.push(path);await router.isReady();const root=node('root');app.mount(root);await flush();return{root,router};
}
async function mockEntry(){
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));pinia=createPinia();setActivePinia(pinia);
  const storage=new TestStorage(),raw=createMockService(()=>storage),target=previewService as unknown as Record<string,(...args:any[])=>Promise<any>>;
  for(const[name,method]of Object.entries(raw))if(typeof method==='function')vi.spyOn(target,name).mockImplementation(method);
  const auth=authorizeStore();
  const request=await savedRequest(storage,{baseRevision:'initial',requestId:'parent-job',taskId:null,parentPlanVersionId:null,input:structuredClone(planningPresets[0].input)});
  const submitted=await raw.submitPlanning(request);vi.setSystemTime(Date.now()+20000);
  const saved=await raw.savePlanVersion({baseRevision:submitted.workspace.revision,jobId:submitted.view.job.id,requestId:'parent-save',name:'父方案',note:''});
  // Mock 数据也通过当前任务和规划服务进入真实页面。
  await usePreviewStore().load();await useResourceReadStore().activate('planning');
  const task=useTaskInputStore();await task.initialize('planning');await task.open(saved.plan.taskId,false);
  vi.spyOn(useResourceReadStore(),'activate').mockResolvedValue(true);vi.spyOn(task,'initialize').mockResolvedValue();
  const planning=usePlanningApiStore();vi.spyOn(planning,'start').mockImplementation(()=>{});await nextTick();
  // 正常页面start会核实父作业；此fixture屏蔽轮询后需显式核实其成功终态。
  await planning.refreshJob(submitted.view.job.id);expect(planning.running).toBe(false);expect(planning.unverifiedActiveJobId).toBeNull();
  const parent=await raw.getPlanningPlan({context:'planning',taskId:saved.plan.taskId,planId:saved.plan.id});
  const path=`/planning?taskId=${encodeURIComponent(saved.plan.taskId)}&planId=${encodeURIComponent(saved.plan.id)}`;
  const page=await mount(PlanningApiView,path);
  // 等真实路由恢复完成，再通过可见步骤按钮进入方案管理，避免onMounted覆盖fixture状态。
  await vi.waitFor(()=>{expect(planning.selectedPlan?.id).toBe(parent.id);expect(planning.step).toBe(2);expect(planning.loading).toBe(false);});
  await click(page.root,'3 · 方案调整与对比');
  await vi.waitFor(()=>expect(planning.step).toBe(3));
  await click(page.root,'保存方案');
  return{...page,planning,task,storage,raw,auth,parent};
}
async function apiEntry(){
  const fixture=await storeFixture();pinia=fixture.pinia;vi.spyOn(useResourceReadStore(),'activate').mockResolvedValue(true);vi.spyOn(fixture.task,'initialize').mockResolvedValue();
  const planning=usePlanningApiStore();await nextTick();planning.selectedPlan=apiPlan();planning.step=3;
  const page=await mount(PlanningApiView);await click(page.root,'保存方案');
  return{...fixture,planning,...page};
}

describe('具体方案调整真实页面入口',()=>{
  it('转正配置入口只打开服务已返回的产物，旧响应不拿规划配置替代', async () => {
    const s = await apiEntry(), plan = s.planning.selectedPlan!;
    plan.state = 'CONFIRMED';plan.current = true;plan.confirmedAt = '2026-10-05T01:00:00Z';await flush();
    expect(button(s.root, '查看转正配置').props.disabled).toBe(true);
    plan.confirmedConfiguration = { sourcePlanId: plan.id, sourcePlanVersion: plan.version, sourceSnapshotId: plan.result.snapshotId, confirmedAt: plan.confirmedAt, configuration: structuredClone(Vue.toRaw(plan.result.configuration)) };await flush();
    const result = all(s.root, row => row.tag === 'result-probe')[0];await click(s.root, '查看转正配置');
    expect(result.props.openConfiguration).toHaveBeenCalledWith(result.props.ownerKey, 'confirmed');
    expect(s.task.decision).toBeNull();expect(s.planning.selectedPlan!.current).toBe(true);
  });
  it('第三步查看保存配置只转交当前对象，不保存、不确认，调整期间隐藏父方案查看入口',async()=>{
    const s=await apiEntry(),plan=s.planning.selectedPlan!,before=JSON.stringify(s.task.draft);
    const result=all(s.root,row=>row.tag==='result-probe')[0];
    await click(s.root,'查看完整配置');
    expect(result.props.openConfiguration).toHaveBeenCalledWith(result.props.ownerKey);
    expect(s.planning.step).toBe(3);expect(s.planning.selectedPlan?.id).toBe(plan.id);expect(s.planning.selectedPlan?.state).toBe('SAVED');expect(s.task.decision).toBeNull();
    expect(JSON.stringify(s.task.draft)).toBe(before);
    s.planning.selectedPlan!.state='REFERENCE';s.planning.selectedPlan!.sourceChanged=true;await flush();
    expect(button(s.root,'查看完整配置').props.disabled).toBe(false);await click(s.root,'查看完整配置');
    s.planning.selectedPlan!.state='SAVED';s.planning.selectedPlan!.sourceChanged=false;await flush();
    await click(s.root,'调整此方案');expect(button(s.root,'查看完整配置')).toBeUndefined();
  });
  it('按对象编辑保留非法原文，调整期间不提供父方案确认入口',async()=>{
    const s=await apiEntry();s.planning.selectedPlan!.result.configuration.devices.push({...s.planning.selectedPlan!.result.configuration.devices[0],deviceId:'E2'});
    await click(s.root,'调整此方案');expect(button(s.root,'转正并设为当前方案')).toBeUndefined();
    await input(s.root,'E1 发射功率','invalid');const selector=control(s.root,'选择调整设备');selector.props['onUpdate:modelValue']('E2');await flush();
    expect(control(s.root,'E1 发射功率').value).toBe('invalid');selector.props['onUpdate:modelValue']('E1');await flush();
    expect(control(s.root,'E1 发射功率').value).toBe('invalid');expect(Number.isNaN(s.planning.adjustmentDraft!.manualOverrides[0].txPowerDbm)).toBe(true);
    expect(button(s.root,'保存调整为新版本').props.disabled).toBe(true);
  });
  it('调整页签支持键盘与点击切换，保留输入并正确关联面板',async()=>{
    const s=await apiEntry();await click(s.root,'调整此方案');
    await input(s.root,'E1 发射功率','invalid');
    const tabs=control(s.root,'调整类型'),devices=button(tabs,'设备参数'),routes=button(tabs,'主路由');
    const panels=all(s.root,row=>row.props.role==='tabpanel');
    expect(devices.props.role).toBe('tab');expect(devices.props['aria-selected']).toBe(true);expect(routes.props.tabindex).toBe(-1);
    expect(panels.find(row=>row.props.id===devices.props['aria-controls'])?.props['aria-labelledby']).toBe(devices.props.id);
    // 模拟键盘焦点宿主，验证焦点跟随选中页签，输入面板仍使用原节点。
    const focus=vi.fn(),preventDefault=vi.fn();
    const key=async(value:string)=>{tabs.props.onKeydown({key:value,preventDefault,currentTarget:{querySelector:()=>({focus})}});await flush();};
    await key('ArrowRight');expect(routes.props['aria-selected']).toBe(true);expect(routes.props.tabindex).toBe(0);expect(panels[0].style.display).toBe('none');
    await key('Home');expect(devices.props['aria-selected']).toBe(true);
    await key('End');expect(routes.props['aria-selected']).toBe(true);
    await key('ArrowLeft');expect(devices.props['aria-selected']).toBe(true);expect(focus).toHaveBeenCalledTimes(4);expect(preventDefault).toHaveBeenCalledTimes(4);
    await click(tabs,'主路由');await click(tabs,'设备参数');
    expect(control(s.root,'E1 发射功率').value).toBe('invalid');expect(panels[0].style.display).not.toBe('none');
    expect(all(s.root,row=>row.tag==='h3').map(textOf)).toEqual(expect.arrayContaining(['修改参数','本次调整变化','保存调整为新版本']));
  });
  it('无修改退出调整回到保存版本，不保留空预览或继续编辑入口',async()=>{
    const s=await apiEntry(),coverage=s.planning.selectedPlan!.result.coverage;await click(s.root,'调整此方案');await click(s.root,'收起调整');
    expect(s.planning.adjustmentOpen).toBe(false);expect(button(s.root,'继续编辑调整')).toBeUndefined();expect(button(s.root,'转正并设为当前方案')).toBeDefined();
    expect(all(s.root,row=>row.props['aria-label']==='方案调整前后预览')).toHaveLength(0);expect(all(s.root,row=>row.tag==='map-probe')[0].props.planningOverlay.coverage).toEqual(coverage);
  });
  it('调整预览另存后收起编辑并只针对新版本提供确认',async()=>{
    const s=await mockEntry();await click(s.root,'调整此方案');await click(s.root,s.task.adjustmentExamples.find(row=>row.id==='economical')!.label);await click(s.root,'重试预览');
    vi.setSystemTime(Date.now()+20000);await s.planning.refreshJob();await flush();await click(s.root,'对比与保存调整结果');await click(s.root,'保存调整为新版本');
    expect(s.planning.selectedPlan!.id).not.toBe(s.parent.id);expect(s.planning.selectedPlan!.parentPlanId).toBe(s.parent.id);expect(s.planning.adjustmentOpen).toBe(false);
    expect(button(s.root,'转正并设为当前方案').props.disabled).toBe(false);const selected=s.planning.selectedPlan!.id;
    const pending=button(s.root,'转正并设为当前方案').props.onClick();await flush();s.task.answer('save');await pending;await flush();
    expect(s.planning.selectedPlan!.id).toBe(selected);expect(s.planning.selectedPlan!.current).toBe(true);expect(s.parent.current).not.toBe(true);
  });
  it('Mock 从保存父方案打开逐设备输入，示例只填草稿，成功后覆盖与三指标来自新结果',async()=>{
    const s=await mockEntry(),before=JSON.stringify(s.task.draft),parent=JSON.stringify(s.parent);await click(s.root,'调整此方案');
    expect(control(s.root,'DV-0001 发射功率')).toBeDefined();expect(textOf(s.root)).toContain('原备份路径（只读）');
    await click(s.root,s.task.adjustmentExamples.find(row=>row.id==='economical')!.label);
    expect(s.planning.adjustmentDraft!.manualOverrides).toHaveLength(6);expect(s.planning.adjustmentDraft!.manualOverrides.every(row=>row.txPowerDbm===40)).toBe(true);expect(s.planning.adjustmentResult).toBeNull();expect(JSON.stringify(s.task.draft)).toBe(before);
    await click(s.root,'重试预览');expect(s.planning.job!.state).toBe('PENDING');expect(s.planning.adjustmentOpen).toBe(true);expect(textOf(s.root)).toContain('当前输入尚无成功结果');expect(all(s.root,row=>row.tag==='map-probe')[0].props.planningOverlay.coverage).toEqual(s.parent.result.coverage);
    vi.setSystemTime(Date.now()+20000);await s.planning.refreshJob();await flush();expect(s.planning.adjustmentResult?.metrics.totalRadiatedPowerW).toBe(60);
    expect(textOf(s.root)).toContain('190 W');expect(textOf(s.root)).toContain('60 W');expect(textOf(s.root)).toContain('-130 W');
    const preview=all(s.root,row=>String(row.props.class).includes('adjustment-preview'))[0];
    expect(all(preview,row=>row.tag==='map-probe')).toHaveLength(0);const maps=all(s.root,row=>row.tag==='map-probe');expect(maps).toHaveLength(1);expect(maps[0].props.planningOverlay.coverage).toEqual(s.planning.adjustmentResult!.coverage);expect(maps[0].props.planningOverlay.coverage.rasterPng.url).not.toBe(s.parent.result.coverage.rasterPng!.url);
    expect(JSON.stringify(s.task.draft)).toBe(before);expect(JSON.stringify(s.parent)).toBe(parent);
    // 模拟页面释放后的按作业 ID 恢复，避免旧页面路由同步参与新现场读取。
    const jobId=s.planning.job!.id;app?.unmount();app=undefined;s.planning.clearForSession();await s.planning.refreshJob(jobId);await flush();
    expect(s.planning.job?.id).toBe(jobId);expect(s.planning.adjustmentParent?.id).toBe(s.parent.id);expect(s.planning.adjustmentResult?.metrics.totalRadiatedPowerW).toBe(60);expect(s.planning.adjustmentDirty).toBe(false);expect(s.planning.step).toBe(3);
  });
  it('0 与空白不同，非法数值阻止提交，路径可增删排序且备份路径不被改写',async()=>{
    const s=await mockEntry();await click(s.root,'调整此方案');
    await input(s.root,'DV-0001 发射功率','0');expect(s.planning.adjustmentDraft!.manualOverrides[0].txPowerDbm).toBe(0);
    await input(s.root,'DV-0001 天线高度','-1');expect(button(s.root,'重试预览').props.disabled).toBe(true);
    await input(s.root,'DV-0001 天线高度','');await input(s.root,'DV-0001 发射功率','not-a-number');expect(button(s.root,'重试预览').props.disabled).toBe(true);
    await click(s.root,'恢复原值');expect(s.planning.adjustmentDraft!.manualOverrides).toEqual([]);
    await click(s.root,'主路由');const route=all(s.root,row=>row.props['data-demand'])[0],demand=route.props['data-demand'],original=s.parent.result.configuration.routes.filter(row=>row.backup);
    await click(route,'增加中间节点');const nodes=[...s.planning.adjustmentDraft!.manualPaths[0].nodePath];
    await click(route,'移除');expect(s.planning.adjustmentDraft!.manualPaths[0].nodePath).toHaveLength(nodes.length-1);
    await click(route,'恢复原路径');expect(s.planning.adjustmentDraft!.manualPaths.some(row=>row.demandId===demand)).toBe(false);expect(s.parent.result.configuration.routes.filter(row=>row.backup)).toEqual(original);
  });
  it('无匹配结果保留输入与父预览，关闭和离开 GIS 路由都有草稿保护',async()=>{
    const s=await mockEntry();await click(s.root,'调整此方案');await input(s.root,'DV-0001 发射功率','33');await click(s.root,'重试预览');
    expect(s.planning.error).toContain('暂无');expect(s.planning.adjustmentDraft!.manualOverrides[0].txPowerDbm).toBe(33);expect(s.planning.adjustmentResult).toBeNull();
    await click(s.root,'收起调整');expect(s.planning.adjustmentOpen).toBe(false);expect(s.planning.adjustmentDirty).toBe(true);expect(s.planning.adjustmentDraft!.manualOverrides[0].txPowerDbm).toBe(33);
    const leave=s.router.push('/situation');await flush();expect(s.task.decision).not.toBeNull();s.task.answer('cancel');await leave;expect(s.router.currentRoute.value.path).toBe('/planning');
    const discard=button(s.root,'放弃本次调整').props.onClick();await flush();expect(s.task.decision?.title).toBe('放弃方案调整');s.task.answer('discard');await discard;expect(s.planning.adjustmentDraft).toBeNull();expect(s.planning.adjustmentDirty).toBe(false);expect(s.planning.selectedPlan?.id).toBe(s.parent.id);
  });
  it('Mock 写入回包不确定时先读原请求记录，禁止改输入或重复作业',async()=>{
    const s=await mockEntry();await click(s.root,'调整此方案');await click(s.root,s.task.adjustmentExamples[1].label);
    vi.mocked(previewService.submitPlanningReceipt).mockImplementationOnce(async request=>{await s.raw.submitPlanningReceipt(request);throw new ApiError('回包丢失','NETWORK_ERROR');});
    await click(s.root,'重试预览');expect(s.planning.pending).not.toBeNull();expect(control(s.root,'DV-0001 发射功率').props.disabled).toBe(true);
    await click(s.root,'核实原调整请求');expect(s.planning.pending).toBeNull();expect(s.planning.adjustmentDirty).toBe(false);expect((await s.raw.loadPlanningWorkspace()).workspace.jobs).toHaveLength(2);
  });
  it('HTTP 页面同样打开具体调整且没有目录示例时不渲染演示按钮',async()=>{
    const s=await apiEntry();await click(s.root,'调整此方案');expect(control(s.root,'E1 发射功率')).toBeDefined();expect(textOf(s.root)).not.toContain('填入演示调整');
    await input(s.root,'E1 发射功率','0');const submitted=vi.spyOn(previewService,'submitPlanningTask').mockImplementation(async request=>({...apiJob(),parentPlanId:'P-1',adjustment:request.adjustment}));
    await click(s.root,'重试预览');expect(submitted).toHaveBeenCalledWith(expect.objectContaining({adjustment:expect.objectContaining({manualOverrides:[{deviceId:'E1',txPowerDbm:0}]})}));expect(textOf(s.root)).toContain('预览已就绪');expect(s.task.saved!.input.demands).toEqual(apiPlan().input.demands);
  });
  it('HTTP 前后预览保留未提供的指标，不补 0；来源失效时入口说明原因',async()=>{
    const s=await apiEntry();s.planning.selectedPlan!.result.metrics.totalRadiatedPowerW=null;await click(s.root,'调整此方案');
    vi.spyOn(previewService,'submitPlanningTask').mockImplementation(async request=>({...apiJob(),parentPlanId:'P-1',adjustment:request.adjustment}));await click(s.root,'重试预览');
    const power=all(s.root,row=>row.props['data-metric']==='power')[0], change=power.children.filter(row=>row.tag==='td')[2];
    expect(textOf(change)).toContain('未提供');expect(textOf(change)).not.toContain('2');
    s.planning.selectedPlan={...apiPlan(),sourceChanged:true};await flush();expect(button(s.root,'调整此方案')).toBeUndefined();expect(textOf(s.root)).toContain('来源已变化');
  });
  it('HTTP 独立调整跨 GIS 页面仍询问，失权保留原输入但拒绝迟到编辑',async()=>{
    const s=await apiEntry();await click(s.root,'调整此方案');await input(s.root,'E1 发射功率','22');
    const leave=s.router.push('/situation');await flush();expect(s.task.decision?.title).toBe('未提交的方案调整');s.task.answer('cancel');await leave;expect(s.router.currentRoute.value.path).toBe('/planning');
    const stale=control(s.root,'E1 发射功率').props.onInput,identity={...s.auth.identity!};s.auth.accept({...identity,permissions:identity.permissions.filter(p=>p!=='planning.execute')});await flush();
    stale({target:{value:'10'}});await flush();expect(s.planning.adjustmentDraft!.manualOverrides[0].txPowerDbm).toBe(22);expect(control(s.root,'E1 发射功率').props.disabled).toBe(true);
    s.planning.clearForSession();await flush();expect(s.planning.adjustmentDraft).toBeNull();expect(all(s.root,row=>row.tag==='drawer-probe')).toHaveLength(0);
  });
  it('Mock 会话清理后迟到提交不恢复旧父方案或调整草稿',async()=>{
    const s=await mockEntry();await click(s.root,'调整此方案');await click(s.root,s.task.adjustmentExamples[1].label);
    let finish!:(value:Awaited<ReturnType<typeof previewService.submitPlanningReceipt>>)=>void,request!:Parameters<typeof previewService.submitPlanningReceipt>[0];
    vi.mocked(previewService.submitPlanningReceipt).mockImplementationOnce(value=>{request=value;return new Promise(resolve=>finish=resolve);});
    const pending=s.planning.submitAdjustment();expect(s.planning.busy).toBe(true);s.planning.clearForSession();finish(await s.raw.submitPlanningReceipt(request));await pending;await flush();
    expect(s.planning.job).toBeNull();expect(s.planning.adjustmentParent).toBeNull();expect(s.planning.adjustmentDraft).toBeNull();expect(s.planning.job).toBeNull();expect(s.planning.busy).toBe(false);
  });
  it.each(['save','confirm'])('Mock 调整版本 %s 晚响应不回填已清理账号现场',async kind=>{
    const s=await mockEntry();await click(s.root,'调整此方案');await click(s.root,s.task.adjustmentExamples[1].label);await s.planning.submitAdjustment();
    vi.setSystemTime(Date.now()+20000);await s.planning.refreshJob();
    let action:Promise<unknown>;
    if(kind==='save'){
      let finish!:(value:Awaited<ReturnType<typeof previewService.savePlanningReceipt>>)=>void,request!:Parameters<typeof previewService.savePlanningReceipt>[0];
      vi.mocked(previewService.savePlanningReceipt).mockImplementationOnce(value=>{request=value;return new Promise(resolve=>finish=resolve);});
      action=s.planning.savePlan('调整版本','');s.planning.clearForSession();finish(await s.raw.savePlanningReceipt(request));
    }else{
      await s.planning.savePlan('调整版本','');
      let finish!:(value:Awaited<ReturnType<typeof previewService.confirmPlanningReceipt>>)=>void,request!:Parameters<typeof previewService.confirmPlanningReceipt>[0];
      vi.mocked(previewService.confirmPlanningReceipt).mockImplementationOnce(value=>{request=value;return new Promise(resolve=>finish=resolve);});
      action=s.planning.confirm();s.task.answer('save');await flush();expect(s.planning.busy).toBe(true);s.planning.clearForSession();finish(await s.raw.confirmPlanningReceipt(request));
    }
    await action;expect(s.planning.job).toBeNull();expect(s.planning.selectedPlan).toBeNull();expect(s.planning.adjustmentParent).toBeNull();expect(s.planning.busy).toBe(false);
  });
  it('主路径的多个中间节点保持有序，不能在首尾之外交换需求端点',async()=>{
    const s=await apiEntry(),parent=s.planning.selectedPlan!;
    parent.result.nodes.push({...apiPlan().result.nodes[0],id:'N3'},{...apiPlan().result.nodes[0],id:'N4'});await click(s.root,'调整此方案');
    const route=all(s.root,row=>row.props['data-demand']==='D1')[0];await click(route,'增加中间节点');await click(route,'增加中间节点');
    expect(s.planning.adjustmentDraft!.manualPaths[0].nodePath).toEqual(['N1','N3','N4','N2']);await click(route,'下移');
    expect(s.planning.adjustmentDraft!.manualPaths[0].nodePath).toEqual(['N1','N4','N3','N2']);expect(button(route,'上移').props.disabled).toBe(true);
  });
  it('HTTP 原结果未提供主路由时可显式填写，需求两端不冒充已有结果',async()=>{
    const s=await apiEntry();s.planning.selectedPlan!.result.configuration.routes=[];await click(s.root,'调整此方案');
    expect(textOf(s.root)).toContain('原路径：未提供');expect(s.planning.adjustmentDraft!.manualPaths).toEqual([]);
    await click(s.root,'设置两端主路径');expect(s.planning.adjustmentDraft!.manualPaths).toEqual([{demandId:'D1',nodePath:['N1','N2']}]);
    await click(s.root,'恢复原路径');expect(s.planning.adjustmentDraft!.manualPaths).toEqual([]);expect(textOf(s.root)).toContain('原路径：未提供');
  });
});

describe('父方案转正旧回调保护',()=>{
  it('正在编辑或隐藏保留的dirty草稿均拒绝旧父方案确认，不发业务写',async()=>{
    const s=await apiEntry();expect(s.planning.canConfirm).toBe(true);
    const parentId=s.planning.selectedPlan!.id, stale=button(s.root,'转正并设为当前方案').props.onClick;
    await click(s.root,'调整此方案');expect(s.planning.canConfirm).toBe(false);
    let action=Promise.resolve(stale());await flush();expect(s.task.decision).toBeNull();await action;
    expect(previewService.confirmPlanningReceipt).not.toHaveBeenCalled();
    await input(s.root,'E1 发射功率','22');await click(s.root,'收起调整');
    expect(s.planning.adjustmentOpen).toBe(false);expect(s.planning.adjustmentDirty).toBe(true);expect(s.planning.canConfirm).toBe(false);
    action=Promise.resolve(stale());await flush();expect(s.task.decision).toBeNull();await action;
    expect(previewService.confirmPlanningReceipt).not.toHaveBeenCalled();expect(s.planning.selectedPlan?.id).toBe(parentId);expect(s.planning.selectedPlan?.current).toBe(false);
  });
});
