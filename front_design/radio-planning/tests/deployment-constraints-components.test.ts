import { afterEach,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer,h,nextTick,reactive,ssrContextKey,toRaw,type App,type Component,type ComponentOptions } from 'vue';
import { parse,compileScript,compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import DeploymentConstraintsEditor from '../src/components/DeploymentConstraintsEditor.vue';
import DeploymentConstraintsSummary from '../src/components/DeploymentConstraintsSummary.vue';
import PlanningTaskForm from '../src/components/PlanningTaskForm.vue';
import TaskApiForm from '../src/components/TaskApiForm.vue';
import TaskDemandEditor from '../src/components/TaskDemandEditor.vue';
import { emptyDeploymentConstraints } from '../src/services/deployment-constraints';
import { deploymentPlanningPresets } from '../src/mocks/deployment-constraint-presets';
import { initialResources } from '../src/mocks/resource-presets';
import { authorizeStore } from './helpers/auth';
import { storeFixture } from './fixtures/planning-api';
import { usePlanningStore } from '../src/stores/planning';
import { previewService } from '../src/services';
import MapCanvas from '../src/components/MapCanvas.vue';
import VectorLayer from 'ol/layer/Vector';
const maps=vi.hoisted(()=>({values:[] as any[]}));
// 仅隔离 DOM 画布，真实图层和 View 保留。
vi.mock('ol/Map',()=>({default:class {
  layers:any[]=[];view:any;handlers=new Map<string,Function>();setLayers=vi.fn((layers:any[])=>this.layers=layers);dispose=vi.fn();
  constructor(options:any){this.view=options.view;vi.spyOn(this.view,'fit').mockImplementation(()=>{});maps.values.push(this);}
  getView(){return this.view;}getSize(){return[960,640];}updateSize(){}on(type:string,fn:Function){this.handlers.set(type,fn);}forEachFeatureAtPixel(){}
  addLayer(layer:any){this.layers.push(layer);}removeLayer(layer:any){this.layers=this.layers.filter(value=>value!==layer);}
}}));
vi.mock('ol/control',()=>({defaults:()=>({extend:()=>[]}),ScaleLine:class{}}));
vi.mock('../src/components/AppDrawer.vue',async()=>{const {h}=await import('vue');return{default:{inheritAttrs:false,props:['visible'],setup:(p:any,{slots}:any)=>()=>p.visible?h('drawer',{},[slots.default?.(),slots.footer?.()]):null}};});
// 使用实际 SFC 与 Store 事件，宿主只替代浏览器 DOM。
async function clientTemplate(component: Component, filename: string) {
  const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor;
  const bindings = compileScript(descriptor, { id: filename }).bindings;
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: filename, compilerOptions: { mode: 'function', bindingMetadata: bindings } });
  if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
  const { code } = await transformWithEsbuild(`function createRender(Vue) { ${result.code} }`, 'resource-ledger-render.ts', { loader: 'ts' });
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
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


for(const [c,f] of [[DeploymentConstraintsEditor,'DeploymentConstraintsEditor'],[DeploymentConstraintsSummary,'DeploymentConstraintsSummary'],[PlanningTaskForm,'PlanningTaskForm'],[TaskApiForm,'TaskApiForm'],[TaskDemandEditor,'TaskDemandEditor']] as const)await clientTemplate(c,'src/components/'+f+'.vue');
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
await clientTemplate(MapCanvas,'src/components/MapCanvas.vue');
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();});
function mount(component:Component,props:()=>any){vi.stubGlobal('document',Object.assign(new EventTarget(),{activeElement:null,hidden:false}));app=renderer.createApp({render:()=>h(component,props())});if(pinia)app.use(pinia);app.provide(ssrContextKey,{});const root=node('root');app.mount(root);return root;}
const scalar=(root:HostNode)=>find(root,n=>n.tag==='input'&&n.props['data-validation-field']==='deploymentConstraints.maxSlopeDeg')!;
async function inputAt(control:HostNode,value:string){(control.props.onInput as Function)({target:{value}});await nextTick();}
describe('部署编辑组件与四类表单入口',()=>{
 it.each([false,true])('resourceRead=%s 输入图层单独更新，查看范围不调用规划',async resourceRead=>{
  pinia=createPinia();setActivePinia(pinia);authorizeStore();
  vi.stubGlobal('window',Object.assign(new EventTarget(),{matchMedia:()=>Object.assign(new EventTarget(),{matches:true})}));vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  const state=reactive({stations:[],resourceRead,deploymentConstraints:{owner:'one',label:'任务草稿',constraints:{...emptyDeploymentConstraints(),forcedInclude:[{lon:114,lat:37}]}} as any});
  const root=mount(MapCanvas,()=>state);await nextTick();const map=maps.values.at(-1),paints=map.setLayers.mock.calls.length,fits=map.view.fit.mock.calls.length;
  const layer=()=>map.layers.find((value:any)=>value instanceof VectorLayer&&value.getSource()?.getFeatures().some((f:any)=>f.get('kind')==='deployment-constraint'));
  expect(layer()).toBeDefined();state.deploymentConstraints.constraints.forcedInclude[0].lon=115;await nextTick();expect(map.setLayers).toHaveBeenCalledTimes(paints);expect(map.view.fit).toHaveBeenCalledTimes(fits);
  await click(root,'查看部署约束');expect(map.view.fit).toHaveBeenCalledTimes(fits+1);state.deploymentConstraints=null;await nextTick();expect(layer()).toBeUndefined();expect(textOf(root)).not.toContain('输入约束');
 });
 it('非法输入保留文本和未完成标志；清空数值与0有区别',async()=>{
  const state=reactive({modelValue:emptyDeploymentConstraints(),owner:'one',disabled:false}),pending=vi.fn();
  const root=mount(DeploymentConstraintsEditor,()=>({...state,nodes:[],onPending:pending,'onUpdate:modelValue':(v:any)=>state.modelValue=v}));
  await inputAt(scalar(root),'abc');expect(Number.isNaN(state.modelValue.maxSlopeDeg)).toBe(true);expect(scalar(root).props.value).toBe('abc');expect(pending).toHaveBeenLastCalledWith(true);
  state.disabled=true;await nextTick();state.disabled=false;await nextTick();expect(scalar(root).props.value).toBe('abc');
  await inputAt(scalar(root),'0');expect(state.modelValue.maxSlopeDeg).toBe(0);expect(pending).toHaveBeenLastCalledWith(false);
  await inputAt(scalar(root),'');expect(state.modelValue.maxSlopeDeg).toBeNull();
 });
 it.each(['owner','permission','unmount'])('%s 往返后旧DOM事件不能写入',async kind=>{
  const state=reactive({modelValue:emptyDeploymentConstraints(),owner:'one',disabled:false}),write=vi.fn((v:any)=>state.modelValue=v);
  const root=mount(DeploymentConstraintsEditor,()=>({...state,nodes:[],'onUpdate:modelValue':write})),old=scalar(root).props.onInput as Function;
  if(kind==='owner'){state.owner='two';await nextTick();state.owner='one';await nextTick();}
  if(kind==='permission'){state.disabled=true;await nextTick();state.disabled=false;await nextTick();}
  if(kind==='unmount'){app!.unmount();app=undefined;}
  old({target:{value:'30'}});expect(write).not.toHaveBeenCalled();
 });
 it('强制点与禁区坐标列表可增减，空坐标仍错误而非自动取地图中心',async()=>{
  const state=reactive({modelValue:emptyDeploymentConstraints(),owner:'one'}),root=mount(DeploymentConstraintsEditor,()=>({...state,nodes:[],'onUpdate:modelValue':(v:any)=>state.modelValue=v}));
  await click(root,'增加强制点');expect(Number.isNaN(state.modelValue.forcedInclude[0].lon)).toBe(true);expect(textOf(root)).toContain('合法经纬度');await click(root,'移除点');expect(state.modelValue.forcedInclude).toEqual([]);
  await click(root,'增加禁区');await click(root,'增加坐标');expect(state.modelValue.forcedExcludePolygons[0].coordinates[0]).toHaveLength(1);await click(root,'增加内环');expect(state.modelValue.forcedExcludePolygons[0].coordinates).toHaveLength(2);await click(root,'移除内环');await click(root,'移除禁区');expect(state.modelValue.forcedExcludePolygons).toEqual([]);
 });
 it.each([false,true])('Mock gisValidation=%s 用共享草稿承接部署和通视节点',async gisValidation=>{
  pinia=createPinia();setActivePinia(pinia);authorizeStore();const planning=usePlanningStore();planning.taskId='T1';
  const resources=initialResources(),value=reactive({input:structuredClone(deploymentPlanningPresets[0].input)}),pending=vi.fn();
  resources.stations.push({...resources.stations[0],id:'LOS-ONLY',name:'独立通视节点'});
  const root=mount(PlanningTaskForm,()=>({modelValue:value.input,resources,presets:deploymentPlanningPresets,locked:false,issues:[],gisValidation,onPending:pending,'onUpdate:modelValue':(v:any)=>value.input=v}));
  await inputAt(scalar(root),'22');expect(value.input.deploymentConstraints!.maxSlopeDeg).toBe(22);
  const checkbox=find(root,n=>n.tag==='label'&&textOf(n).includes('独立通视节点')&&textOf(n).includes('LOS-ONLY'))!.children.find(n=>n.tag==='input')!;
  (checkbox.props.onChange as Function)({target:{checked:true}});await nextTick();expect(value.input.deploymentConstraints!.losRequiredNodeIds).toContain('LOS-ONLY');expect(value.input.stationIds).not.toContain('LOS-ONLY');
 });
 it.each(['planning','gis'] as const)('HTTP %s 的非法部署输入在编辑需求后仍保留',async context=>{
  const s=await storeFixture();pinia=s.pinia;s.task.context=context;s.task.draft!.deploymentConstraints=emptyDeploymentConstraints();
  vi.spyOn(previewService,'queryResourceNodes').mockResolvedValue({revision:'r1',items:[],page:1,pageSize:10,total:0} as never);
  const root=mount(TaskApiForm,()=>({}));await settle();await inputAt(scalar(root),'bad');
  expect(s.task.auxiliary.deployment).toBe(true);await click(root,'编辑');await click(root,'应用到任务草稿');
  expect(Number.isNaN(s.task.draft!.deploymentConstraints!.maxSlopeDeg)).toBe(true);expect(s.task.auxiliary.deployment).toBe(true);expect(await s.task.save()).toBe(false);
 });
 it('只读摘要保留0和未知地物，缺项显示未设置',async()=>{
  const state=reactive({value:{...emptyDeploymentConstraints(),maxSlopeDeg:0,allowedLandcover:['特殊地表']}}),root=mount(DeploymentConstraintsSummary,()=>state);
  expect(textOf(root)).toContain('特殊地表');expect(textOf(root)).toContain('0');state.value=null as never;await nextTick();expect(textOf(root)).toContain('未设置');
 });
});

