import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
import DiagnosisView from '../src/views/DiagnosisView.vue';
import DiagnosisResultPanel from '../src/components/DiagnosisResultPanel.vue';
import DiagnosisRootCausePanel from '../src/components/DiagnosisRootCausePanel.vue';
import DiagnosisNetworkPanel from '../src/components/DiagnosisNetworkPanel.vue';
import DiagnosisScenarioDrawer from '../src/components/DiagnosisScenarioDrawer.vue';
import DiagnosisFaultTypePicker from '../src/components/DiagnosisFaultTypePicker.vue';
import DiagnosisProgressPanel from '../src/components/DiagnosisProgressPanel.vue';
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
vi.mock('../src/components/DiagnosisImportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DiagnosisReportDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
// 在内存宿主执行真实客户端模板；不把宿主事件验证当作浏览器视觉验收。
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'diagnosis-render.ts', { loader: 'ts' });
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
async function radio(root: HostNode, label: string) {
  const el = find(root, n => n.props['aria-label'] === label);
  expect(el, label).toBeDefined(); (el!.props.onChange as () => void)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }

await Promise.all([
  [DiagnosisView,'src/views/DiagnosisView.vue'],[DiagnosisResultPanel,'src/components/DiagnosisResultPanel.vue'],
  [DiagnosisRootCausePanel,'src/components/DiagnosisRootCausePanel.vue'],[DiagnosisNetworkPanel,'src/components/DiagnosisNetworkPanel.vue'],
  [DiagnosisScenarioDrawer,'src/components/DiagnosisScenarioDrawer.vue'],[DiagnosisFaultTypePicker,'src/components/DiagnosisFaultTypePicker.vue'],
  [DiagnosisProgressPanel,'src/components/DiagnosisProgressPanel.vue'],[DecisionDialog,'src/components/DecisionDialog.vue'],
].map(([component,path])=>clientTemplate(component as Component,path as string)));
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
const initialMode=env.mode;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();probes.locate.mockClear();(env as {mode:string}).mode=initialMode;});
const map=(root:HostNode)=>find(root,n=>n.tag==='map-probe')!;
async function mountPage(demo:DiagnosisDemo='normal') {
  vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',{activeElement:null});
  pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore(),storage=new TestStorage();
  let time=Date.parse('2026-10-07T00:00:00Z');
  const current={resources:structuredClone(resources) as ResourcesData,meta:initialMeta()};
  const resourceSource=()=>({...current,meta:{...current.meta,taskWorkspace:taskMeta(storage)}});
  const planningService=createPlanningMock(()=>storage,resourceSource,()=>time);
  const job=await planningService.submitPlanning(await savedRequest(storage,{baseRevision:'initial',requestId:'submit',taskId:null,parentPlanVersionId:null,input:structuredClone(planningPresets[0].input)}));
  time+=10000;
  const saved=await planningService.savePlanVersion({baseRevision:job.workspace.revision,requestId:'save',jobId:job.view.job.id,name:'诊断页面测试网络',note:''});
  const confirmed=await planningService.confirmPlanVersion({baseRevision:saved.workspace.revision,requestId:'confirm',planId:saved.plan.id});
  const service=createDiagnosisMock(()=>storage,resourceSource,()=>time);
  const mutation=async()=>({baseRevision:(await service.loadDiagnosisWorkspace()).workspace!.revision,requestId:crypto.randomUUID()});
  const runIds:string[]=[];
  for(const id of ['balanced:hardware','balanced:multiple']) {
    const preset=diagnosisPresets.find(p=>p.id===id)!;
    const workspace=await service.saveDiagnosisScenario({...await mutation(),scenarioId:null,draft:{name:preset.label,description:'',planId:confirmed.plan.id,faults:structuredClone(preset.faults)}});
    const submitted=await service.submitDiagnosis({...await mutation(),scenarioVersionId:workspace.scenarios.at(-1)!.versions.at(-1)!.id,demo});
    runIds.push(submitted.view.run.id);time+=12000;
  }
  // 只替换传输边界，页面、store、校验和 Mock 服务全部实际运行。
  const target=previewService as unknown as Record<string,(...args:any[])=>Promise<any>>;
  for(const [key,method]of Object.entries(service))vi.spyOn(target,key).mockImplementation(method);
  const preview=usePreviewStore();preview.data=await createMockService(()=>storage).loadPreview();
  const planning=usePlanningStore();planning.workspace=confirmed.workspace;
  // 注册页面已有的规划链接，避免宿主缺路由产生无关警告。
  const diagnosis=useDiagnosisStore(),router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:DiagnosisView},{path:'/planning',component:{render:()=>null}},{path:'/situation',component:{render:()=>null}}]});
  await router.push('/');await router.isReady();
  const root=node('root');app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia);app.use(router);app.provide(ssrContextKey,{});app.mount(root);await settle();
  return {root,auth,storage,diagnosis,preview,planning,service,runIds,current,router,writes:storage.writes,advance:(ms=12000)=>{time+=ms;}};
}
describe('实际诊断页面的类型与根因展示',()=>{
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
  it('类型选择未应用时取消切换保留表单，确认放弃后原历史记录可查看',async()=>{
    const s=await mountPage();
    await s.diagnosis.selectVersion(s.diagnosis.workspace!.scenarios[0].versions[0]);await settle();await click(s.root,'编辑场景');
    await radio(s.root,'故障 1 类型：软件配置异常');expect(s.diagnosis.formDirty).toBe(true);
    const pending=s.diagnosis.selectRun(s.runIds[1]);await nextTick();await click(s.root,'继续编辑');await pending;
    expect(s.diagnosis.draft).not.toBeNull();expect(find(s.root,n=>n.props['aria-label']==='故障 1 类型：软件配置异常')!.props.checked).toBe(true);
    const accepted=s.diagnosis.selectRun(s.runIds[1]);await nextTick();await click(s.root,'放弃并继续');await accepted;await settle();
    expect(s.diagnosis.runId).toBe(s.runIds[1]);expect(s.diagnosis.formDirty).toBe(false);expect(find(s.root,n=>n.props['aria-label']==='故障 1 类型：软件配置异常')).toBeUndefined();
    expect(s.storage.writes).toBe(s.writes);
  });
  it('应用类型仍只进入场景草稿，可撤销恢复，不偷偷提交诊断',async()=>{
    const s=await mountPage();await s.diagnosis.selectVersion(s.diagnosis.workspace!.scenarios[0].versions[0]);await settle();await click(s.root,'编辑场景');
    await radio(s.root,'故障 1 类型：软件配置异常');await click(s.root,'应用到场景草稿');
    expect(s.diagnosis.draft!.faults[0].faultType).toBe('SW_CONFIG');expect(s.diagnosis.formDirty).toBe(false);
    expect((map(s.root).props.diagnosisFaults as {faultType:string}[])[0].faultType).toBe('SW_CONFIG');
    await click(s.root,'撤销');expect(s.diagnosis.draft!.faults[0].faultType).toBe('HW_FAILURE');
    expect(s.diagnosis.record).toBeNull();expect(s.storage.writes).toBe(s.writes);
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
  it('HTTP 模式不提供尚未实现的诊断 GIS 入口',async()=>{
    (env as {mode:string}).mode='http';const s=await mountPage();expect(s.diagnosis.record).not.toBeNull();expect(entry(s.root)).toBeUndefined();
  });
  it('离页确认取消后保留报告与未应用输入',async()=>{
    const s=await mountPage(),id=s.diagnosis.record!.id;s.diagnosis.formDirty=true;
    await click(s.root,'在 GIS 查看');await settle();expect(s.diagnosis.decision).not.toBeNull();
    await click(s.root,'继续编辑');await settle();
    expect(s.router.currentRoute.value.path).toBe('/');expect(s.diagnosis.record!.id).toBe(id);expect(s.diagnosis.formDirty).toBe(true);expect(s.storage.writes).toBe(s.writes);
  });
});
