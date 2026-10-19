import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import GisValidationPanel from '../src/components/GisValidationPanel.vue';
import AppDrawer from '../src/components/AppDrawer.vue';
import ResourceEditDrawer from '../src/components/ResourceEditDrawer.vue';
import InterferenceSourceDrawer from '../src/components/InterferenceSourceDrawer.vue';
import PlanningTaskForm from '../src/components/PlanningTaskForm.vue';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { usePlanningStore } from '../src/stores/planning';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useAuthStore } from '../src/stores/auth';
import { createMockService } from '../src/services/mock';
import { previewService } from '../src/services';
import { planningPresets } from '../src/mocks/planning-presets';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { ApiError } from '../src/services/types';
import type { GisValidationIssue } from '../src/services/gis-validation';

// 只替换弹层外壳；实际 AppDrawer 负责转发 after-show，实际表单负责聚焦。
vi.mock('primevue/drawer',async()=>{
 const {defineComponent,h}=await import('vue');
 return {default:defineComponent({props:['visible'],emits:['update:visible','after-show'],
 setup:(props,{slots,emit})=>()=>props.visible?h('drawer-probe',{shown:()=>emit('after-show')},[slots.default?.(),slots.footer?.()]):null})};
});
let focused:HostNode|null=null,scrolled:HostNode|null=null;

import SituationView from '../src/views/SituationView.vue';
import TaskWorkspacePanel from '../src/components/TaskWorkspacePanel.vue';
import GisResourceTree from '../src/components/GisResourceTree.vue';
import GisDeviceLayerPanel from '../src/components/GisDeviceLayerPanel.vue';
import { createMemoryHistory,createRouter,RouterView } from 'vue-router';
import { bindMonitoring,settleMonitoring } from './helpers/monitoring';
const probes=vi.hoisted(()=>({locate:vi.fn()}));
vi.mock('../src/components/MapCanvas.vue',async()=>{
 const {defineComponent,h}=await import('vue');
 return {default:defineComponent({inheritAttrs:false,props:['stations','selectedId','selectedInterferenceId','gisDeviceFrame'],
 setup:(props,{expose})=>{expose({locate:()=>{},locateResource:probes.locate});return()=>h('map-probe',{...props});}})};
});
vi.mock('../src/components/ObjectInfoPanel.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/StatusBadge.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/InterferenceAnalysisPanel.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/SituationMonitoringDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/MonitoringObjectPanel.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/InterferenceHistoryDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/InterferenceMeasureDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/ResourceExportDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/TaskLibraryDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/TaskImportDrawer.vue',()=>({default:{render:()=>null}}));
// 实际组件模板在内存宿主运行，验证事件和文本，不模拟真实布局。
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'coverage-render.ts', { loader: 'ts' });
  (component as ComponentOptions).render = new Function('Vue', code + ';return createRender(Vue);')(Vue);
}

interface HostNode {
  tag: string; tagName: string; text: string; parent: HostNode | null; children: HostNode[]; options:HostNode[];
  props: Record<string, unknown>; style: Record<string, string>; value?: unknown;
  focus: () => void; scrollIntoView: () => void; getAttribute: (key:string) => unknown; matches:(selector:string)=>boolean; querySelectorAll:()=>HostNode[];
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
  get options(){return this.children.filter(n=>n.tag==='option');},
  focus(){focused=this;},scrollIntoView(){scrolled=this;},getAttribute(key){return this.props[key];},matches(){return !!this.props.disabled;},
  querySelectorAll(){const all:HostNode[]=[];const walk=(n:HostNode)=>{for(const c of n.children){if(c.props['data-validation-field'])all.push(c);walk(c);}};walk(this);return all;},
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
const textOf = (root: HostNode): string => root.text.replace(/<[^>]+>/g, '') + root.children.map(textOf).join('');
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}

await Promise.all([
 [GisValidationPanel,'src/components/GisValidationPanel.vue'],
 [SituationView,'src/views/SituationView.vue'],[TaskWorkspacePanel,'src/components/TaskWorkspacePanel.vue'],[GisResourceTree,'src/components/GisResourceTree.vue'],[GisDeviceLayerPanel,'src/components/GisDeviceLayerPanel.vue'],
 [AppDrawer,'src/components/AppDrawer.vue'],[ResourceEditDrawer,'src/components/ResourceEditDrawer.vue'],
 [InterferenceSourceDrawer,'src/components/InterferenceSourceDrawer.vue'],[PlanningTaskForm,'src/components/PlanningTaskForm.vue'],
].map(([c,p])=>clientTemplate(c as Component,p as string)));
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();focused=null;scrolled=null;});

async function mountEntry(){
 vi.useFakeTimers();vi.stubGlobal('window',new EventTarget());
 class TestDocument extends EventTarget {hidden=false;activeElement=null;}
 vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());
 pinia=createPinia();setActivePinia(pinia);authorizeStore();probes.locate.mockClear();
 const storage=new TestStorage(),raw=createMockService(()=>storage);
 vi.spyOn(previewService,'loadPreview').mockImplementation(raw.loadPreview);
 vi.spyOn(previewService,'loadInterferenceWorkspace').mockImplementation(raw.loadInterferenceWorkspace);
 vi.spyOn(previewService,'loadPlanningWorkspace').mockImplementation(raw.loadPlanningWorkspace);
 vi.spyOn(previewService,'loadTaskWorkspace').mockImplementation(raw.loadTaskWorkspace);
 vi.spyOn(previewService,'commitGisWorkspace').mockImplementation(raw.commitGisWorkspace);
 bindMonitoring(raw);
 const preview=usePreviewStore(),planning=usePlanningStore(),editor=useResourceEditStore(),gis=useGisWorkspaceStore();
 await preview.load();await planning.load();gis.begin();
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/situation',component:SituationView},{path:'/planning',component:{render:()=>null}}]});
 app=renderer.createApp({render:()=>h(Vue.Fragment,[h(RouterView),h(ResourceEditDrawer)])});app.use(pinia);app.use(router);app.provide(ssrContextKey,{});
 await router.push('/situation');await router.isReady();const root=node('root');app.mount(root);await settleMonitoring();await nextTick();
 return {root,editor,gis,planning,storage,preview,router};
}
function issueButton(root:HostNode,id:string,field:string){
 const row=find(root,n=>n.tag==='li'&&textOf(n).includes(id+' / '+field));
 expect(row,id+'/'+field).toBeDefined();
 return find(row!,n=>n.tag==='button'&&textOf(n)==='定位问题')!;
}
async function locate(s:Awaited<ReturnType<typeof mountEntry>>,id:string,field:string){
 const button=issueButton(s.root,id,field);await (button.props.onClick as ()=>unknown)();await settleNavigation();
}
// Vue emit 不返回父级异步处理 Promise，冲刷确认、表单和地图接线的微任务。
async function settleNavigation(){for(let i=0;i<10;i++)await nextTick();}
function resourceError(s:Awaited<ReturnType<typeof mountEntry>>,id:string,field:string){
 s.editor.report(new ApiError('资源校验失败','VALIDATION_ERROR',{issues:[{objectId:id,field,message:'请修正'}]}));
}

describe('GIS 校验错误真实页面入口',()=>{
 it('整体保存任务错误可从顶部进入字段，成功后清理失败清单',async()=>{
  const s=await mountEntry();s.planning.updateDraft({...JSON.parse(JSON.stringify(s.planning.draft)),name:''});
  expect(await s.gis.save()).toBe(false);await nextTick();
  expect(textOf(s.root)).toContain('任务名称需为');await locate(s,'TASK','name');
  expect(focused?.props['data-validation-field']).toBe('name');expect(probes.locate).not.toHaveBeenCalled();
  s.planning.updateDraft({...JSON.parse(JSON.stringify(s.planning.draft)),name:'修正名称'});
  expect(await s.gis.save()).toBe(true);await nextTick();expect(s.gis.validationIssues).toEqual([]);expect(s.editor.error).toBe('');
 });
 it('当前无效资源输入直接定位，不触发确认或丢失值，重复点击仍定位',async()=>{
  const s=await mountEntry();await s.editor.openForm('device','DV-0001','gis');s.editor.form!.fields.txPowerDbm='bad';
  expect(await s.gis.save()).toBe(false);await nextTick();
  await locate(s,'DV-0001','txPowerDbm');expect(focused?.props['data-validation-field']).toBe('txPowerDbm');
  expect(s.editor.form!.fields.txPowerDbm).toBe('bad');expect(s.editor.decision).toBeNull();expect(probes.locate).toHaveBeenCalledTimes(1);
  await locate(s,'DV-0001','txPowerDbm');expect(probes.locate).toHaveBeenCalledTimes(2);
 });
 it('未知对象不可点击；无有效坐标只聚焦当前字段，不移动地图',async()=>{
  const s=await mountEntry();resourceError(s,'MISSING','name');await nextTick();
  expect(issueButton(s.root,'MISSING','name').props.disabled).toBe(true);await locate(s,'MISSING','name');expect(s.editor.form).toBeNull();
  await s.editor.openForm('station','ND-0001','gis');s.editor.form!.fields.longitude='bad';
  expect(s.editor.applyForm()).toBe(false);await nextTick();await locate(s,'ND-0001','coordinate');
  expect(focused?.props['data-validation-field']).toBe('longitude');expect(probes.locate).not.toHaveBeenCalled();
 });
 it('资源筛选挡住目标时恢复必要显示，取消切换则保留筛选与原输入',async()=>{
  const s=await mountEntry();await s.editor.openForm('device','DV-0001','gis');s.editor.form!.fields.antennaHeightM='18';
  const input=find(s.root,n=>n.props['aria-label']==='搜索资源')!;
  (input.props.onInput as (e:unknown)=>void)({target:{value:'不存在'}});resourceError(s,'DV-0002','antennaHeightM');await nextTick();
  const pending=(issueButton(s.root,'DV-0002','antennaHeightM').props.onClick as ()=>Promise<unknown>)();
  expect(s.editor.decision).not.toBeNull();s.editor.answer('cancel');await pending;await nextTick();
  expect(s.editor.form!.id).toBe('DV-0001');expect(s.editor.form!.fields.antennaHeightM).toBe('18');
  expect(find(s.root,n=>n.props['aria-label']==='搜索资源')!.props.value).toBe('不存在');
  const accepted=(issueButton(s.root,'DV-0002','antennaHeightM').props.onClick as ()=>Promise<unknown>)();s.editor.answer('discard');await accepted;await settleNavigation();
  expect(s.editor.form!.id).toBe('DV-0002');expect(find(s.root,n=>n.props['aria-label']==='搜索资源')!.props.value).toBe('');
  expect(probes.locate).toHaveBeenCalledOnce();
 });
 it.each(['identity','revision','mode','permission'] as const)('确认期间 %s 变化使旧定位失效，不打开目标或解除筛选',async(change)=>{
  const s=await mountEntry();await s.editor.openForm('device','DV-0001','gis');s.editor.form!.fields.antennaHeightM='18';
  resourceError(s,'DV-0002','txPowerDbm');await nextTick();
  const pending=(issueButton(s.root,'DV-0002','txPowerDbm').props.onClick as ()=>Promise<unknown>)();
  if(change==='identity')useAuthStore().generation++;
  if(change==='revision')s.preview.data!.resourceMeta.revision='external';
  if(change==='mode'){s.gis.mapMode='monitoring';s.gis.mapMode='resource';}
  if(change==='permission')useAuthStore().identity!.permissions=[];
  s.editor.answer('discard');await pending;await settleNavigation();
  expect(s.editor.form!.id).toBe('DV-0001');expect(probes.locate).not.toHaveBeenCalled();expect(s.editor.issueFocus).toBeNull();
 });
 it('顶部需求定位进入真实需求抽屉，其他未应用需求不会被覆盖',async()=>{
  const s=await mountEntry(),[first,second]=s.planning.draft!.demands;
  s.gis.taskIssues=[{source:'task',objectId:first!.id,field:'maxDelayMs',message:'错误'},{source:'task',objectId:second!.id,field:'maxDelayMs',message:'错误'}];
  await nextTick();await locate(s,first!.id,'maxDelayMs');expect(focused?.props['data-validation-field']).toBe('maxDelayMs');
  const field=find(s.root,n=>n.props['data-validation-field']==='maxDelayMs')!;
  (field.props['onUpdate:modelValue'] as (v:string)=>void)('BAD');await nextTick();
  await locate(s,second!.id,'maxDelayMs');expect(textOf(s.root)).toContain('当前通联需求有未应用输入');
  expect(find(s.root,n=>n.props['data-validation-field']==='maxDelayMs')!.value).toBe('BAD');
 });
 it('新建站点尚未应用仍可返回表单修正，定位不新增资源或写入业务存储',async()=>{
  const s=await mountEntry(),count=s.editor.resources.stations.length,before=[...s.storage.entries];
  await s.editor.newForm('station','gis');s.editor.pick([114.65,37.5]);s.editor.form!.fields.name='';
  expect(s.editor.applyForm()).toBe(false);const id=s.editor.form!.id;await nextTick();await locate(s,id,'name');
  expect(s.editor.form!.id).toBe(id);expect(focused?.props['data-validation-field']).toBe('name');
  expect(s.editor.resources.stations).toHaveLength(count);expect([...s.storage.entries]).toEqual(before);
 });
});
