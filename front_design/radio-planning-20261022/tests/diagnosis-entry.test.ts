import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App, type Component } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import DiagnosisView from '../src/views/DiagnosisView.vue';
import DiagnosisResultPanel from '../src/components/DiagnosisResultPanel.vue';
import DiagnosisRootCausePanel from '../src/components/DiagnosisRootCausePanel.vue';
import DiagnosisNetworkPanel from '../src/components/DiagnosisNetworkPanel.vue';
import DiagnosisScenarioDrawer from '../src/components/DiagnosisScenarioDrawer.vue';
import DiagnosisFaultTypePicker from '../src/components/DiagnosisFaultTypePicker.vue';
import DiagnosisProgressPanel from '../src/components/DiagnosisProgressPanel.vue';
import DiagnosisSourceDrawer from '../src/components/DiagnosisSourceDrawer.vue';
import DiagnosisImportDrawer from '../src/components/DiagnosisImportDrawer.vue';
import DiagnosisFeedbackDrawer from '../src/components/DiagnosisFeedbackDrawer.vue';
import DecisionDialog from '../src/components/DecisionDialog.vue';
import { useDiagnosisStore } from '../src/stores/diagnosis';
import { usePreviewStore } from '../src/stores/preview';
import { usePlanningStore } from '../src/stores/planning';
import { previewService } from '../src/services';
import { env } from '../src/config/env';
import { createMockService } from '../src/services/mock';
import { createPlanningMock } from '../src/services/planning-mock';
import { createDiagnosisMock } from '../src/services/diagnosis-mock';
import { initialMeta } from '../src/services/resource-storage';
import { planningPresets } from '../src/mocks/planning-presets';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import resources from '../src/mocks/resources.json';
import type { ResourcesData } from '../src/types/domain';
import type { DiagnosisDemo } from '../src/types/diagnosis';
import { savedRequest, taskMeta } from './helpers/tasks';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import * as diagnosisExport from '../src/reports/diagnosis-export';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';

const probes=vi.hoisted(()=>({locate:vi.fn()}));
vi.mock('../src/components/MapCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {default:defineComponent({inheritAttrs:false,props:['stations','links','diagnosisFaults','diagnosisDevices','selectedId','selectedLinkId'],
    emits:['select','selectFault'],setup(props,{emit,expose}){expose({locate:probes.locate});return () => h('map-probe',{...props,selectFault:(type:string,id:string)=>emit('selectFault',type,id)});}})};
});
vi.mock('../src/components/ChartCanvas.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/AppDrawer.vue',async()=>{
  const {defineComponent,h}=await import('vue');
  return {default:defineComponent({props:['visible','title'],setup(props,{slots}){return()=>props.visible?h('drawer-probe',{title:props.title},[slots.default?.(),slots.footer?.()]):null;}})};
});
vi.mock('primevue/dialog',async()=>{
  const {defineComponent,h}=await import('vue');
  return {default:defineComponent({props:['visible','header'],setup(props,{slots}){return()=>props.visible?h('dialog-probe',{header:props.header},[slots.default?.(),slots.footer?.()]):null;}})};
});
// 报告内容已有独立验证，此处只核对页面传递的可见性、错误和下载事件。
vi.mock('../src/components/DiagnosisReportDrawer.vue',async()=>{
  const {defineComponent,h}=await import('vue');
  return {default:defineComponent({props:['visible','error','exporting'],emits:['download','close'],setup(props,{emit}){return()=>props.visible?h('report-probe',{error:props.error},[
    props.error,h('button',{disabled:props.exporting,onClick:()=>emit('download','json')},'下载 JSON'),h('button',{onClick:()=>emit('close')},'关闭报告'),
  ]):null;}})};
});
// 在内存宿主执行真实客户端模板；不把宿主事件验证当作浏览器视觉验收。
let stageNumber = 0;
const beginStage = () => {
  if (process.env.R6_DIAGNOSIS_STAGE !== '1') return (_label: string) => {};
  const trace = ++stageNumber, started = performance.now();
  let previous = started;
  return (label: string) => {
    const now = performance.now();
    console.info(`[R6-DIAGNOSIS] trace=${trace} ${label} delta_ms=${(now - previous).toFixed(3)} elapsed_ms=${(now - started).toFixed(3)}`);
    previous = now;
  };
};
let stage = (_label: string) => {};
const clickRejections: { label: string; error: unknown }[] = [];
async function click(root: HostNode, label: string) {
  const mark = stage;
  mark(`click:${label}:start`);
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined();
  // DOM事件派发不等待异步处理器；待决操作由用例随后明确完成。
  const result = (el!.props.onClick as () => unknown)();
  mark(`click:${label}:dispatched`);
  void Promise.resolve(result).catch(error => { clickRejections.push({ label, error }); });
  await nextTick();
  mark(`click:${label}:tick`);
}
async function radio(root: HostNode, label: string) {
  const mark = stage;
  mark(`radio:${label}:start`);
  const el = find(root, n => n.props['aria-label'] === label);
  expect(el, label).toBeDefined(); (el!.props.onChange as () => void)();
  mark(`radio:${label}:dispatched`);await nextTick();mark(`radio:${label}:tick`);
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }

await Promise.all([
  [DiagnosisView,'src/views/DiagnosisView.vue'],[DiagnosisResultPanel,'src/components/DiagnosisResultPanel.vue'],
  [DiagnosisRootCausePanel,'src/components/DiagnosisRootCausePanel.vue'],[DiagnosisNetworkPanel,'src/components/DiagnosisNetworkPanel.vue'],
  [DiagnosisScenarioDrawer,'src/components/DiagnosisScenarioDrawer.vue'],[DiagnosisFaultTypePicker,'src/components/DiagnosisFaultTypePicker.vue'],
  [DiagnosisProgressPanel,'src/components/DiagnosisProgressPanel.vue'],[DecisionDialog,'src/components/DecisionDialog.vue'],
  [DiagnosisSourceDrawer,'src/components/DiagnosisSourceDrawer.vue'],[DiagnosisImportDrawer,'src/components/DiagnosisImportDrawer.vue'],
  [DiagnosisFeedbackDrawer,'src/components/DiagnosisFeedbackDrawer.vue'],
].map(([component,path])=>clientTemplate(component as Component,path as string, 'diagnosis-render.ts')));
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
const initialMode=env.mode;
afterEach(async()=>{
  const mark = stage;
  mark('afterEach:start');
  app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();probes.locate.mockClear();(env as {mode:string}).mode=initialMode;
  mark('afterEach:cleanup');
  await nextTick();
  expect(clickRejections.splice(0),'Unexpected asynchronous click handler rejection').toEqual([]);
  mark('afterEach:done');
});
const map=(root:HostNode)=>find(root,n=>n.tag==='map-probe')!;
function freezeSeed<T>(value:T):T {
  if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freezeSeed(child);
    Object.freeze(value);
  }
  return value;
}
async function buildSeed(demo:DiagnosisDemo) {
  const mark=beginStage(),storage=new TestStorage();
  mark(`seed:build:${demo}:start`);
  let time=Date.parse('2026-10-07T00:00:00Z');
  const current={resources:structuredClone(resources) as ResourcesData,meta:initialMeta()};
  mark('seed:resources:cloned');
  const resourceSource=()=>({...current,meta:{...current.meta,taskWorkspace:taskMeta(storage)}});
  const planningService=createPlanningMock(()=>storage,resourceSource,()=>time);
  mark('seed:planning:start');
  const request=await savedRequest(storage,{baseRevision:'initial',requestId:'submit',taskId:null,parentPlanVersionId:null,input:structuredClone(planningPresets[0].input)});
  mark('seed:planning:task-saved');
  const job=await planningService.submitPlanning(request);
  mark('seed:planning:submitted');
  time+=10000;
  const saved=await planningService.savePlanVersion({baseRevision:job.workspace.revision,requestId:'save',jobId:job.view.job.id,name:'诊断页面测试网络',note:''});
  mark('seed:planning:saved');
  const confirmed=await planningService.confirmPlanVersion({baseRevision:saved.workspace.revision,requestId:'confirm',planId:saved.plan.id});
  mark('seed:planning:confirmed');
  const service=createDiagnosisMock(()=>storage,resourceSource,()=>time);
  const mutation=async()=>{
    mark('seed:mutation:workspace:start');
    const loaded=await service.loadDiagnosisWorkspace();
    mark('seed:mutation:workspace:loaded');
    return {baseRevision:loaded.workspace!.revision,requestId:crypto.randomUUID()};
  };
  const runIds:string[]=[];
  mark('seed:diagnosis:start');
  for(const [index,id] of ['balanced:hardware','balanced:multiple'].entries()) {
    const preset=diagnosisPresets.find(p=>p.id===id)!;
    const saving=await mutation();mark(`seed:diagnosis:${index}:save:start`);
    const workspace=await service.saveDiagnosisScenario({...saving,scenarioId:null,draft:{name:preset.label,description:'',planId:confirmed.plan.id,faults:structuredClone(preset.faults)}});
    mark(`seed:diagnosis:${index}:saved`);
    const submitting=await mutation();mark(`seed:diagnosis:${index}:submit:start`);
    const submitted=await service.submitDiagnosis({...submitting,scenarioVersionId:workspace.scenarios.at(-1)!.versions.at(-1)!.id,demo});
    mark(`seed:diagnosis:${index}:submitted`);
    runIds.push(submitted.view.run.id);time+=12000;
  }
  mark('seed:diagnosis:done');
  const seed=freezeSeed(structuredClone({
    entries:[...storage.entries].map(([key,value])=>[key,value] as const),
    writes:storage.writes,readHistory:[...storage.readHistory],writeHistory:[...storage.writeHistory],
    current,confirmedWorkspace:confirmed.workspace,runIds,time,
  }));
  mark('seed:immutable:ready');
  return seed;
}
// 顶层依次真实建库，不占用页面动作的5秒预算，也不共享可变服务或存储。
const pageSeeds=Object.freeze({
  normal:await buildSeed('normal'),
  'diagnosis-failed':await buildSeed('diagnosis-failed'),
  'impact-failed':await buildSeed('impact-failed'),
});

async function mountPage(demo:DiagnosisDemo='normal') {
  const mark=beginStage();stage=mark;
  mark('mount:enter');
  if(demo!=='normal'&&demo!=='diagnosis-failed'&&demo!=='impact-failed')throw new Error('该演示分支尚未建立独立页面夹具');
  const seed=pageSeeds[demo];
  vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',{activeElement:null});
  pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore(),storage=new TestStorage();
  mark('mount:identity:ready');
  // 字符串可复用，Map、计数、历史数组、资源对象及模拟时钟均属于本用例。
  storage.entries=new Map(seed.entries);storage.writes=seed.writes;
  storage.readHistory=[...seed.readHistory];storage.writeHistory=[...seed.writeHistory];
  const current=structuredClone(seed.current),runIds=[...seed.runIds];
  let time=seed.time;
  const resourceSource=()=>({...current,meta:{...current.meta,taskWorkspace:taskMeta(storage)}});
  const service=createDiagnosisMock(()=>storage,resourceSource,()=>time);
  mark('mount:seed:restored');
  // 只替换传输边界，页面、store、校验和 Mock 服务全部实际运行。
  const target=previewService as unknown as Record<string,(...args:any[])=>Promise<any>>;
  for(const [key,method]of Object.entries(service))vi.spyOn(target,key).mockImplementation(method);
  mark('mount:services:bound');
  const preview=usePreviewStore();preview.data=await createMockService(()=>storage).loadPreview();
  mark('mount:preview:loaded');
  const planning=usePlanningStore();planning.workspace=structuredClone(seed.confirmedWorkspace);
  // 注册页面已有的规划链接，避免宿主缺路由产生无关警告。
  const diagnosis=useDiagnosisStore(),router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:DiagnosisView},{path:'/diagnosis',component:DiagnosisView},{path:'/planning',component:{render:()=>null}},{path:'/situation',component:{render:()=>null}}]});
  mark('mount:stores:created');
  mark('mount:router:push');await router.push('/');mark('mount:router:pushed');await router.isReady();mark('mount:router:ready');
  const root=node('root');app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia);app.use(router);app.provide(ssrContextKey,{});mark('mount:render:start');app.mount(root);mark('mount:render:done');await settle();mark('mount:settle:done');
  return {root,auth,storage,diagnosis,preview,planning,service,runIds,current,router,writes:storage.writes,advance:(ms=12000)=>{time+=ms;}};
}
describe('实际诊断页面的类型与根因展示',()=>{
  it('空证据诊断先确认，返回补填不保存、不提交也不改变历史',async()=>{
    const s=await mountPage(),history=JSON.stringify(s.diagnosis.record);
    await s.diagnosis.selectVersion(s.diagnosis.workspace!.scenarios[0].versions[0]);
    const value=JSON.parse(JSON.stringify(s.diagnosis.draft!));for(const fault of value.faults)fault.symptomIds=[];
    s.diagnosis.updateDraft(value);await settle();const before=s.storage.writes;
    const submit=vi.mocked(previewService.submitDiagnosisReceipt);submit.mockClear();
    const pending=s.diagnosis.submit();await settle();
    expect(s.diagnosis.decision).toMatchObject({title:'故障现象不足',saveLabel:'继续分析影响',cancelLabel:'返回补填现象'});
    expect(textOf(s.root)).toContain('未选择观察现象');expect(submit).not.toHaveBeenCalled();
    s.diagnosis.answer('cancel');await pending;expect(submit).not.toHaveBeenCalled();expect(s.storage.writes).toBe(before);
    await click(s.root,'配置故障与现象');await settle();
    expect(find(s.root,n=>n.tag==='drawer-probe'&&n.props.title==='故障场景配置')).toBeDefined();
    expect(textOf(s.root)).toContain('上方类型只是注入假设');
    expect(history).toContain('conclusions');
  });
  it('空证据确认期间修改草稿，旧确认不会保存或提交新输入',async()=>{
    const s=await mountPage();await s.diagnosis.selectVersion(s.diagnosis.workspace!.scenarios[0].versions[0]);
    const value=JSON.parse(JSON.stringify(s.diagnosis.draft!));for(const fault of value.faults)fault.symptomIds=[];
    s.diagnosis.updateDraft(value);const before=s.storage.writes,submit=vi.mocked(previewService.submitDiagnosisReceipt);submit.mockClear();
    const pending=s.diagnosis.submit();await settle();expect(s.diagnosis.decision?.title).toBe('故障现象不足');
    s.diagnosis.updateDraft({...value,name:'确认期间的新草稿'});s.diagnosis.answer('save');await pending;
    expect(submit).not.toHaveBeenCalled();expect(s.storage.writes).toBe(before);expect(s.diagnosis.draft?.name).toBe('确认期间的新草稿');
  });
  it('有观察现象时沿原接口提交，不额外要求空证据确认',async()=>{
    const s=await mountPage();await s.diagnosis.selectVersion(s.diagnosis.workspace!.scenarios[0].versions[0]);
    const submit=vi.mocked(previewService.submitDiagnosisReceipt);submit.mockClear();submit.mockRejectedValueOnce(new Error('本测试停止于受理边界'));
    await s.diagnosis.submit();expect(s.diagnosis.decision).toBeNull();expect(submit).toHaveBeenCalledOnce();
    expect(s.diagnosis.error).toBe('本测试停止于受理边界');
  });
  it.each([['xlsx','影响清单 XLSX'],['png','示意图 PNG']] as const)('%s 导出失败就地显示，重新生成期间锁定按钮，成功后清除本入口错误',async(format,label)=>{
    const s=await mountPage(),id=s.diagnosis.record!.id,frozen=JSON.stringify(s.diagnosis.record);
    const download=vi.spyOn(diagnosisExport,'downloadDiagnosisFile').mockImplementation(()=>{}),impact=vi.mocked(previewService.exportDiagnosisImpact);
    await click(s.root,'影响');impact.mockRejectedValueOnce(new Error('影响文件暂时无法生成'));await click(s.root,label);
    await vi.waitFor(()=>expect(s.diagnosis.impactExportError).toBe('影响文件暂时无法生成'));await settle();
    const body=()=>find(s.root,n=>n.props.class==='result-body')!;
    expect(textOf(body())).toContain('影响文件导出失败：影响文件暂时无法生成');expect(find(s.root,n=>n.tag==='report-probe')).toBeUndefined();
    vi.mocked(previewService.exportDiagnosisReport).mockRejectedValueOnce(new Error('报告文件暂时无法生成'));
    await click(s.root,'预览与下载完整报告');await click(s.root,'下载 JSON');await vi.waitFor(()=>expect(s.diagnosis.exportError).toBe('报告文件暂时无法生成'));await settle();
    expect(find(s.root,n=>n.tag==='report-probe')!.props.error).toBe('报告文件暂时无法生成');expect(textOf(body())).not.toContain('报告文件暂时无法生成');
    await click(s.root,'关闭报告');
    let resolve!: (file:Awaited<ReturnType<typeof previewService.exportDiagnosisImpact>>)=>void;
    impact.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await click(s.root,label);await settle();
    expect(textOf(body())).toContain('正在生成影响文件');expect(textOf(body())).not.toContain('影响文件暂时无法生成');
    for(const name of ['影响清单 XLSX','示意图 PNG'])expect(find(body(),n=>n.tag==='button'&&textOf(n)===name)!.props.disabled).toBe(true);
    const file={name:`影响.${format}`,mime:'application/octet-stream',bytes:new Uint8Array([1,2,3])};resolve(file);
    await vi.waitFor(()=>expect(s.diagnosis.exporting).toBe(false));await settle();
    expect(impact).toHaveBeenLastCalledWith(id,format,expect.any(String));expect(download).toHaveBeenCalledExactlyOnceWith(file);
    expect(textOf(body())).not.toContain('影响文件导出失败');expect(textOf(body())).not.toContain('正在生成影响文件');expect(s.diagnosis.exportError).toBe('报告文件暂时无法生成');
    expect(find(body(),n=>n.tag==='button'&&textOf(n)===label)!.props.disabled).toBe(false);expect(JSON.stringify(s.diagnosis.record)).toBe(frozen);expect(s.storage.writes).toBe(s.writes);
  });
  it('取消后状态读取失败显示待刷新和重试，重查失败仍保留入口，成功不重复取消',async()=>{
    const s=await mountPage();s.advance(-10400);await s.diagnosis.selectRun(s.runIds[1]);await settle();expect(s.diagnosis.view!.state).toBe('RUNNING');
    vi.mocked(previewService.getDiagnosisDetail).mockRejectedValueOnce(new Error('取消后的状态读取中断'));
    await click(s.root,'取消任务');await settle();await click(s.root,'确认取消');
    await vi.waitFor(()=>expect(s.diagnosis.queryError).toContain('取消后的状态读取中断'));await settle();
    const panel=()=>find(s.root,n=>n.props.class==='progress-panel')!;
    expect(textOf(find(panel(),n=>n.tag==='strong')!)).toBe('取消已完成，状态待刷新');expect(find(panel(),n=>n.tag==='button'&&textOf(n)==='取消任务')).toBeUndefined();
    expect(textOf(panel())).toContain('当前进度为上次读取值');const writes=s.storage.writes;
    vi.mocked(previewService.getDiagnosisProgress).mockRejectedValueOnce(new Error('重查仍然中断'));await click(panel(),'重试查询');
    await vi.waitFor(()=>expect(s.diagnosis.queryError).toContain('重查仍然中断'));await settle();expect(textOf(panel())).toContain('取消已完成，状态待刷新');
    await click(panel(),'重试查询');await vi.waitFor(()=>expect(s.diagnosis.view!.state).toBe('CANCELLED'));await settle();
    expect(textOf(find(panel(),n=>n.tag==='strong')!)).toContain('已取消');expect(textOf(panel())).not.toContain('状态待刷新');expect(find(panel(),n=>n.tag==='button'&&textOf(n)==='重试查询')).toBeUndefined();
    expect(previewService.cancelDiagnosisReceipt).toHaveBeenCalledTimes(1);expect(s.storage.writes).toBe(writes);
  });
  it('两个目录显示各自失败和重试，恢复后保留其他目录及场景操作错误',async()=>{
    const s=await mountPage(),frozen=JSON.stringify(s.diagnosis.record);s.diagnosis.error='独立场景操作错误';
    const scenarios=vi.mocked(previewService.queryDiagnosisScenarios),history=vi.mocked(previewService.queryDiagnosisHistory);
    scenarios.mockRejectedValueOnce(new Error('场景目录连接中断'));history.mockRejectedValueOnce(new Error('运行目录连接中断'));
    await s.diagnosis.queryScenarios(2,true);await s.diagnosis.queryHistory(3);await settle();
    const list=()=>find(s.root,n=>n.props.class==='scenario-list')!;
    expect(textOf(list())).toContain('场景目录读取失败：场景目录连接中断');expect(textOf(list())).toContain('运行目录读取失败：运行目录连接中断');
    await click(list(),'重试场景目录');await settle();expect(scenarios).toHaveBeenLastCalledWith(expect.objectContaining({pageNum:2,archived:true}));
    expect(textOf(list())).not.toContain('场景目录连接中断');expect(textOf(list())).toContain('运行目录连接中断');expect(textOf(s.root)).toContain('独立场景操作错误');
    await click(list(),'重试运行目录');await settle();expect(history).toHaveBeenLastCalledWith(expect.objectContaining({pageNum:3}));
    expect(textOf(list())).not.toContain('运行目录连接中断');expect(s.diagnosis.error).toBe('独立场景操作错误');expect(JSON.stringify(s.diagnosis.record)).toBe(frozen);expect(s.storage.writes).toBe(s.writes);
  });
  it('诊断前汇总精确对象及现象，折叠标题标明非默认分支，历史不混入当前配置',async()=>{
    const s=await mountPage();await s.diagnosis.selectVersion(s.diagnosis.workspace!.scenarios[0].versions[0]);await settle();
    const summary=()=>find(s.root,n=>n.props['aria-label']==='当前故障输入')!;
    expect(textOf(summary())).toContain('故障输入 · 2 个对象');expect(textOf(summary())).toContain('设备 DV-0027');expect(textOf(summary())).toContain('链路 LINK-B');
    expect(textOf(summary())).toContain('硬件故障');expect(textOf(summary())).toContain('电磁干扰');expect(textOf(summary())).toContain('发射时驻波比告警');expect(textOf(summary())).toContain('SY-0001');
    const input=JSON.parse(JSON.stringify(s.diagnosis.draft!));input.faults[0].symptomIds=['UNMAPPED'];s.diagnosis.updateDraft(input);await settle();
    expect(textOf(summary())).toContain('名称未提供（UNMAPPED）');
    const branchLabel=find(s.root,n=>n.tag==='label'&&textOf(n).trim().startsWith('演示分支'))!;
    const selector=find(branchLabel,n=>n.tag==='select')!;
    (selector.props['onUpdate:modelValue'] as (value:string)=>void)('impact-failed');await settle();
    const setting=()=>find(s.root,n=>n.tag==='summary'&&textOf(n).startsWith('演示设置'))!;
    expect(textOf(setting())).toContain('当前：影响失败（非默认）');expect(find(setting(),n=>String(n.props.class).includes('demo-non-default'))).toBeDefined();
    s.diagnosis.discardDraft();await s.diagnosis.selectRun(s.runIds[1]);await settle();
    expect(textOf(setting())).not.toContain('当前：');expect(textOf(setting())).not.toContain('非默认');expect(summary()).toBeUndefined();expect(s.storage.writes).toBe(s.writes);
  });
  it('导入重新预检时旧预览不可提交，失败后可重选同一文件，取消选择保留原预览',async()=>{
    const s=await mountPage();await click(s.root,'导入场景');await settle();
    const drawer=()=>find(s.root,n=>n.tag==='drawer-probe'&&n.props.title==='导入故障场景')!;
    const upload=find(drawer(),n=>n.tag==='input'&&n.props.type==='file')!,choose=upload.props.onChange as (event:unknown)=>Promise<void>;
    const template=await s.service.getDiagnosisTemplate('csv',s.diagnosis.sources.plans[0].id);
    const file=(name:string)=>new File([new Uint8Array(template.bytes).buffer],name,{type:template.mime});
    const oldInput={files:[file('旧文件.csv')],value:'旧文件.csv'};await choose({target:oldInput});await settle();expect(oldInput.value).toBe('');
    const previous=s.diagnosis.importPreview;await choose({target:{files:[],value:''}});expect(s.diagnosis.importPreview).toBe(previous);
    let reject!:(reason:Error)=>void;vi.mocked(previewService.previewDiagnosisImport).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const newInput={files:[file('当前文件.csv')],value:'当前文件.csv'},pending=choose({target:newInput});
    await vi.waitFor(()=>expect(reject).toBeTypeOf('function'));await settle();
    const commit=()=>find(drawer(),n=>n.tag==='button'&&textOf(n)==='整批导入')!;
    expect(s.diagnosis.importPreview).toBeNull();expect(commit().props.disabled).toBe(true);expect(textOf(drawer())).not.toContain('预检通过');
    reject(new Error('当前文件预检失败'));await pending;await settle();expect(newInput.value).toBe('');expect(commit().props.disabled).toBe(true);
    await click(drawer(),'整批导入');expect(previewService.importDiagnosisReceipt).not.toHaveBeenCalled();expect(s.storage.writes).toBe(s.writes);
    await choose({target:newInput});await settle();expect(s.diagnosis.importPreview!.fileName).toBe('当前文件.csv');expect(commit().props.disabled).toBe(false);
    await click(drawer(),'整批导入');await settle();expect(previewService.importDiagnosisReceipt).toHaveBeenCalledTimes(1);expect(drawer()).toBeUndefined();
  });
  it('模板可选且无模板仍可标绘，演示设置默认折叠并按服务能力撤除',async()=>{
    const s=await mountPage();await s.diagnosis.selectVersion(s.diagnosis.workspace!.scenarios[0].versions[0]);await settle();
    expect(textOf(s.root)).toContain('场景模板');expect(textOf(s.root)).toContain('请选择场景模板（可选）');
    expect(textOf(s.root)).not.toContain('教学模板');
    const settings=find(s.root,n=>n.tag==='details'&&textOf(n).includes('演示设置'))!;expect(settings).toBeDefined();expect(settings.props.open).toBeFalsy();
    s.diagnosis.presets=[];await settle();expect(textOf(s.root)).toContain('暂无可用场景模板');expect(textOf(s.root)).toContain('在 GIS 标绘');
    const context=await s.service.loadDiagnosisContext();vi.mocked(previewService.loadDiagnosisContext).mockResolvedValue({...context,capabilities:{demoControls:false},dataOrigin:'BUSINESS',presets:[]});
    s.diagnosis.demo='diagnosis-failed';await s.diagnosis.reload();await settle();
    expect(s.diagnosis.demo).toBe('normal');expect(find(s.root,n=>n.tag==='details'&&textOf(n).includes('演示设置'))).toBeUndefined();
    expect(textOf(s.root)).not.toContain('重置诊断演示数据');
    // 工作区为业务来源时，已选中的旧示例报告仍保留自身来源。
    expect(textOf(s.root)).toContain('数据来源：示例数据');
    await s.diagnosis.selectVersion(s.diagnosis.workspace!.scenarios[0].versions[0]);await settle();
    expect(textOf(s.root)).toContain('数据来源：业务数据');expect(textOf(s.root)).toContain('在 GIS 标绘');expect(textOf(s.root)).toContain('导入场景');
  });
  it('首次无运行显示创建引导，明确选择网络才建立草稿，历史手动打开',async()=>{
    const s=await mountPage();await s.service.resetDiagnosisWorkspace(s.diagnosis.workspace!.revision);await s.diagnosis.reload();await settle();
    expect(s.diagnosis.record).toBeNull();expect(textOf(s.root)).toContain('创建故障诊断场景');expect(map(s.root)).toBeUndefined();
    await click(s.root,'新建场景');await vi.waitFor(()=>expect(find(s.root,n=>n.tag==='drawer-probe'&&n.props.title==='新建故障场景')).toBeDefined());
    const select=find(s.root,n=>n.props['aria-label']==='新场景绑定网络')!;
    expect(find(s.root,n=>n.tag==='button'&&textOf(n)==='创建场景草稿')!.props.disabled).toBe(true);
    (select.props['onUpdate:modelValue'] as (id:string)=>void)(s.diagnosis.sources.plans[0].id);await settle();await click(s.root,'创建场景草稿');await settle();
    await vi.waitFor(()=>expect(find(s.root,n=>n.tag==='drawer-probe'&&n.props.title==='新建故障场景')).toBeUndefined());
    expect(s.diagnosis.draft!.planId).toBe(s.diagnosis.sources.plans[0].id);expect(s.diagnosis.record).toBeNull();
    expect(textOf(s.root)).toContain('故障输入 · 0 个对象');expect(textOf(s.root)).toContain('尚未设置故障对象');
    expect(find(s.root,n=>n.tag==='button'&&textOf(n)==='保存并开始诊断')!.props.disabled).toBe(true);
    // 放弃新草稿后主动打开历史，已有遥测证据无需进入报告末尾寻找。
    const opening=s.diagnosis.selectLegacy('DG-HW');await vi.waitFor(()=>expect(s.diagnosis.decision).not.toBeNull());s.diagnosis.answer('save');await opening;await settle();
    expect(textOf(s.root)).toContain('88 °C');expect(textOf(s.root)).toContain('低于设定值 12 dB');expect(textOf(s.root)).toContain('预览历史诊断报告');
  });
  it('复制在多网络中优先原网络，取消不改快照',async()=>{
    const s=await mountPage(),record=s.diagnosis.record!,before=JSON.stringify(record);
    const drawer=()=>find(s.root,n=>n.tag==='drawer-probe'&&n.props.title==='复制为新场景');
    // 把其他网络放在首位，防止复制入口隐式绑定列表第一项。
    const options=s.diagnosis.sources.plans.map(plan=>({...plan,canCreate:true,unavailableReason:null}));
    const other={...options[0],id:'another-network'};
    vi.mocked(previewService.loadDiagnosisSourceOptions).mockResolvedValue({plans:[other,...options],error:null});
    await click(s.root,'复制为新场景');await vi.waitFor(()=>expect(drawer()).toBeDefined());
    await click(s.root,'取消');await vi.waitFor(()=>expect(drawer()).toBeUndefined());expect(JSON.stringify(s.diagnosis.record)).toBe(before);
    await click(s.root,'复制为新场景');await vi.waitFor(()=>expect(drawer()).toBeDefined());await click(s.root,'创建场景草稿');await vi.waitFor(()=>expect(drawer()).toBeUndefined());
    expect(s.diagnosis.draft!.planId).toBe(record.network.id);expect(s.diagnosis.network!.id).toBe(record.network.id);
    expect(JSON.stringify(record)).toBe(before);expect(s.storage.writes).toBe(s.writes);
  });
  // 原复合用例的失效原网分支独立挂载，保留同样的重选、只读及写数断言。
  it('复制时原网络不可用必须重新选择，原快照不变',async()=>{
    const s=await mountPage(),record=s.diagnosis.record!,before=JSON.stringify(record);
    const options=s.diagnosis.sources.plans.map(plan=>({...plan,canCreate:true,unavailableReason:null}));
    const other={...options[0],id:'another-network'};
    vi.mocked(previewService.loadDiagnosisSourceOptions).mockResolvedValue({plans:[other],error:null});
    await click(s.root,'复制为新场景');await vi.waitFor(()=>expect(find(s.root,n=>n.tag==='drawer-probe'&&n.props.title==='复制为新场景')).toBeDefined());
    expect(textOf(s.root)).toContain('原网络当前不可用，请明确选择替代网络');
    expect(find(s.root,n=>n.tag==='button'&&textOf(n)==='创建场景草稿')!.props.disabled).toBe(true);
    expect(JSON.stringify(s.diagnosis.record)).toBe(before);expect(s.storage.writes).toBe(s.writes);
  });
  it('实际导入抽屉按当前选中网络请求模板，失败仅反馈到导入操作',async()=>{
    const s=await mountPage();await click(s.root,'导入场景');
    s.diagnosis.sources.plans.push({...s.diagnosis.sources.plans[0],id:'second-network'});
    await settle();const drawer=find(s.root,n=>n.tag==='drawer-probe'&&n.props.title==='导入故障场景')!,select=find(drawer,n=>n.tag==='select')!;
    (select.props['onUpdate:modelValue'] as (id:string)=>void)('second-network');await settle();
    const template=vi.spyOn(previewService,'getDiagnosisTemplate').mockRejectedValue(new Error('模板读取失败'));
    await click(drawer,'CSV 模板');expect(template).toHaveBeenCalledWith('csv','second-network');expect(s.diagnosis.importError).toBe('模板读取失败');expect(s.diagnosis.error).toBe('');expect(s.diagnosis.exportError).toBe('');
  });
  it('最新冻结运行显示字典现象、部件及分路，定位保留精确设备身份',async()=>{
    const s=await mountPage(),snapshot=JSON.stringify(s.diagnosis.record!.network);
    await click(s.root,'根因');
    expect(textOf(s.root)).toContain('发射时驻波比告警');expect(textOf(s.root)).toContain('功放模块 / 链路 B');
    expect(textOf(s.root)).toContain('本批没有机器学习分支结果');
    expect(map(s.root).props.diagnosisFaults).toEqual(s.diagnosis.record!.faults);
    await click(s.root,'定位故障对象 DV-0027');await settle();
    expect(map(s.root).props.selectedId).toBe('ND-0003');expect(probes.locate).toHaveBeenCalled();
    expect(textOf(s.root)).toContain('设备 DV-0027');expect(JSON.stringify(s.diagnosis.record!.network)).toBe(snapshot);expect(s.storage.writes).toBe(s.writes);
  });
  it('切换运行及内置历史不混用现象、部件或故障标记',async()=>{
    const s=await mountPage();await click(s.root,'根因');
    const selector=find(s.root,n=>n.props['aria-label']==='选择诊断结论')!;
    (selector.props['onUpdate:modelValue'] as (v:number)=>void)(1);await nextTick();expect(textOf(s.root)).toContain('收信底噪明显抬升');
    await s.diagnosis.selectRun(s.runIds[0]);await settle();await click(s.root,'根因');
    expect(textOf(s.root)).toContain('功率放大模块');expect(textOf(s.root)).not.toContain('收信底噪明显抬升');
    await s.diagnosis.selectLegacy(s.diagnosis.legacy[0].id);await settle();await click(s.root,'根因');
    const root=find(s.root,n=>n.props['aria-label']==='根因定位链')!;
    expect(textOf(root)).toContain('未提供结构化现象');expect(textOf(root)).toContain('未提供');
    expect(map(s.root).props.diagnosisFaults).toEqual([]);expect(s.storage.writes).toBe(s.writes);
  });
  it('已提交结果在资源变化后继续显示原冻结字段和坐标',async()=>{
    const s=await mountPage(),before=JSON.stringify(s.diagnosis.record!.result),stations=JSON.stringify(map(s.root).props.stations);
    s.current.meta.stationVersions['ND-0003']='changed';s.current.resources.stations.find(n=>n.id==='ND-0003')!.coordinate=[120,30];
    await s.diagnosis.refreshSources();await settle();await click(s.root,'根因');
    expect(s.diagnosis.record!.source.state).toBe('HISTORICAL');expect(JSON.stringify(s.diagnosis.record!.result)).toBe(before);
    expect(JSON.stringify(map(s.root).props.stations)).toBe(stations);expect(textOf(s.root)).toContain('功放模块 / 链路 B');
    expect(s.storage.writes).toBe(s.writes);
  });
  it('场景草稿与撤销历史交给 GIS，诊断页不再提供第二个标绘编辑器',async()=>{
    const s=await mountPage();
    const version=s.diagnosis.workspace!.scenarios[0].versions[0];
    await s.diagnosis.selectVersion(version);await settle();
    const input=JSON.parse(JSON.stringify(s.diagnosis.draft!));input.faults[0].faultType='SW_CONFIG';s.diagnosis.updateDraft(input);
    const before=JSON.stringify(s.diagnosis.draft),history=JSON.stringify(s.diagnosis.undoStack);
    expect(textOf(s.root)).not.toContain('连续标绘');expect(textOf(s.root)).not.toContain('编辑场景');
    await click(s.root,'在 GIS 标绘');
    await vi.waitFor(()=>expect(s.router.currentRoute.value.path).toBe('/situation'));
    expect(s.router.currentRoute.value.query).toEqual({faultEdit:'1',scenarioId:version.scenarioId,versionId:version.id});
    expect(s.router.currentRoute.value.path).toBe('/situation');expect(JSON.stringify(s.diagnosis.draft)).toBe(before);
    expect(JSON.stringify(s.diagnosis.undoStack)).toBe(history);expect(s.diagnosis.dirty).toBe(true);
    expect(s.storage.writes).toBe(s.writes);
  });
  it('非标绘交接的导航仍先处理未保存场景，取消不丢输入',async()=>{
    const s=await mountPage();await s.diagnosis.selectVersion(s.diagnosis.workspace!.scenarios[0].versions[0]);await settle();
    const input=JSON.parse(JSON.stringify(s.diagnosis.draft!));input.description='未保存场景';s.diagnosis.updateDraft(input);
    const pending=s.router.push('/planning');await settle();await click(s.root,'继续编辑');await pending;
    expect(s.router.currentRoute.value.path).toBe('/');expect(s.diagnosis.draft!.description).toBe('未保存场景');
    const accepted=s.router.push('/planning');await settle();await click(s.root,'放弃并继续');await accepted;
    expect(s.router.currentRoute.value.path).toBe('/planning');expect(s.diagnosis.dirty).toBe(false);expect(s.storage.writes).toBe(s.writes);
  });
  it('GIS 保存后的版本返回只定位一次，后续保存不会跳回旧版本或自动运行',async()=>{
    const s=await mountPage(),version=s.diagnosis.workspace!.scenarios[0].versions[0];
    await s.router.push('/situation');await settle();
    await s.router.push({path:'/diagnosis',query:{scenarioId:version.scenarioId,versionId:version.id}});await settle();
    expect(s.diagnosis.versionId).toBe(version.id);expect(s.diagnosis.view).toBeNull();
    const input=JSON.parse(JSON.stringify(s.diagnosis.draft!));input.description='返回后的修改';s.diagnosis.updateDraft(input);
    expect(await s.diagnosis.save()).toBe(true);await settle();
    expect(s.diagnosis.versionId).not.toBe(version.id);expect(s.diagnosis.draft!.description).toBe('返回后的修改');expect(s.diagnosis.view).toBeNull();
  });
  it('影响失败时已完成根因仍可查看，影响和完整报告不伪装就绪',async()=>{
    const s=await mountPage('impact-failed');await click(s.root,'根因');
    expect(textOf(s.root)).toContain('功放模块 / 链路 B');expect(s.diagnosis.impactReady).toBe(false);expect(s.diagnosis.record).toBeNull();
    await click(s.root,'影响');expect(textOf(s.root)).toContain('影响分析尚未完成');
    const report=find(s.root,n=>n.tag==='button'&&textOf(n)==='预览与下载完整报告')!;
    expect(report.props.disabled).toBe(true);expect(s.storage.writes).toBe(s.writes);
  });
});

describe('完整诊断报告的 GIS 入口',()=>{
  const entry=(root:HostNode)=>find(root,n=>n.tag==='button'&&textOf(n).trim()==='在 GIS 查看');
  it.each([false,true])('完整报告精准跳转，内置历史=%s',async legacy=>{
    const s=await mountPage();
    if(legacy){await s.diagnosis.selectLegacy(s.diagnosis.legacy[0].id);await settle();expect(s.diagnosis.record!.completedAt).toBeNull();}
    const id=s.diagnosis.record!.id;
    await click(s.root,'在 GIS 查看');await vi.waitFor(()=>expect(s.router.currentRoute.value.path).toBe('/situation'));
    expect(s.router.currentRoute.value.path).toBe('/situation');expect(s.router.currentRoute.value.query).toEqual({diagnosisId:id});
    expect(s.storage.writes).toBe(s.writes);
  });
  it.each(['diagnosis-failed','impact-failed'] as const)('%s 不提供完整报告入口',async demo=>{
    const s=await mountPage(demo);expect(s.diagnosis.record).toBeNull();expect(entry(s.root)).toBeUndefined();
  });
  it('运行中及已取消任务不借预藏结果进入 GIS',async()=>{
    const s=await mountPage();s.advance(-11900);await s.diagnosis.selectRun(s.runIds[1]);await settle();
    expect(s.diagnosis.view?.state).not.toBe('SUCCESS');expect(s.diagnosis.record).toBeNull();expect(entry(s.root)).toBeUndefined();
    const loaded=await s.service.loadDiagnosisWorkspace();
    await s.service.cancelDiagnosisRun({baseRevision:loaded.workspace!.revision,requestId:'cancel-gis-entry',runId:s.runIds[1]});
    await s.diagnosis.selectRun(s.runIds[1]);await settle();expect(s.diagnosis.view?.state).toBe('CANCELLED');expect(entry(s.root)).toBeUndefined();
  });
  it.each(['diagnosis.view','situation.view'] as const)('缺少 %s 时无入口，旧按钮事件也不能导航',async permission=>{
    const s=await mountPage(),callback=entry(s.root)!.props.onClick as ()=>unknown;
    s.auth.identity!.permissions=s.auth.identity!.permissions.filter(value=>value!==permission);await settle();
    expect(entry(s.root)).toBeUndefined();await callback();await settle();expect(s.router.currentRoute.value.path).toBe('/');
  });
  it('两种来源均保留诊断 GIS 入口',async()=>{
    (env as {mode:string}).mode='http';const s=await mountPage();expect(s.diagnosis.record).not.toBeNull();expect(entry(s.root)).toBeDefined();
    await click(s.root,'在 GIS 查看');await vi.waitFor(()=>expect(s.router.currentRoute.value.path).toBe('/situation'));expect(s.router.currentRoute.value.query.diagnosisId).toBe(s.diagnosis.record!.id);
  });
  it('离页确认取消后保留报告与未应用输入',async()=>{
    const s=await mountPage(),id=s.diagnosis.record!.id;s.diagnosis.formDirty=true;
    await click(s.root,'在 GIS 查看');await settle();expect(s.diagnosis.decision).not.toBeNull();
    await click(s.root,'继续编辑');await settle();
    expect(s.router.currentRoute.value.path).toBe('/');expect(s.diagnosis.record!.id).toBe(id);expect(s.diagnosis.formDirty).toBe(true);expect(s.storage.writes).toBe(s.writes);
  });
});
