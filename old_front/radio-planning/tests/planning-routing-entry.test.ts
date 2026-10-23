import { afterEach,beforeEach,beforeAll,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer,h,nextTick,ref,ssrContextKey,type App,type Component,type ComponentOptions } from 'vue';
import { parse,compileScript,compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { disposePinia } from 'pinia';
import PlanningRoutingEditor from '../src/components/PlanningRoutingEditor.vue';
import PlanningOptionsSummary from '../src/components/PlanningOptionsSummary.vue';
import PlanningTaskForm from '../src/components/PlanningTaskForm.vue';
import TaskDemandEditor from '../src/components/TaskDemandEditor.vue';
import TaskApiForm from '../src/components/TaskApiForm.vue';
import { usePlanningStore } from '../src/stores/planning';
import { storeFixture,readNode } from './fixtures/planning-api';
import { routingPlanningPresets } from '../src/mocks/planning-routing-presets';
import type { RoutingInput } from '../src/services/planning-routing';
import resources from '../src/mocks/resources.json';
import { previewService } from '../src/services';
vi.mock('../src/components/AppDrawer.vue',()=>({default:Vue.defineComponent({props:['visible'],setup:(p,{slots})=>()=>p.visible?Vue.h('aside',[slots.default?.(),slots.footer?.()]):null})}));
vi.mock('../src/components/PlanningOptionsEditor.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/DeploymentConstraintsEditor.vue',()=>({default:{render:()=>null}}));
// 用实际模板执行选择、应用和错误定位，宿主只提供 DOM 事件及焦点能力。
let focused:HostNode|null=null;
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
  focus: () => void; scrollIntoView: () => void; getAttribute: (key:string) => unknown; matches:()=>boolean; querySelectorAll:()=>HostNode[];
  addEventListener: () => void; removeEventListener: () => void; getRootNode: () => Document;
}
const node = (tag: string, text = ''): HostNode => ({ tag, tagName: tag.toUpperCase(), text, parent: null, children: [], props: {}, style: {},
  get options() { return this.children.filter(child => child.tag === 'option'); },
  focus(){focused=this;},scrollIntoView(){},getAttribute(key){return this.props[key];},matches(){return !!this.props.disabled;},
  querySelectorAll(){return all(this,n=>n!==this&&!!n.props['data-validation-field']);},
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


const apps:App[]=[],sessions:Awaited<ReturnType<typeof storeFixture>>[]=[];
function mount(component:Component,props:()=>Record<string,unknown>){const root=node('root'),vm=ref<any>(),app=renderer.createApp({render:()=>h(component,{...props(),ref:vm})});app.provide(ssrContextKey,{modules:new Set()});app.mount(root);apps.push(app);return{root,vm};}
const select=(root:HostNode,key:string)=>find(root,n=>n.tag==='select'&&n.props['data-validation-field']===key)!;
async function change(root:HostNode,key:string,value:string){await (select(root,key).props.onChange as Function)({target:{value}});await settle();}
async function session(){const s=await storeFixture();sessions.push(s);vi.spyOn(s.resources,'fetchDevices').mockResolvedValue({items:[],page:1,pageSize:10,total:0} as any);vi.spyOn(s.resources,'fetchNodes').mockResolvedValue({items:[readNode()],page:1,pageSize:10,total:1} as any);return s;}
async function mockForm(gisValidation=false){const s=await session(),planning=usePlanningStore(),value=ref(structuredClone(routingPlanningPresets[0].input)),pending=ref(false);planning.taskId='routing-A';const view=mount(PlanningTaskForm,()=>({modelValue:value.value,resources,presets:routingPlanningPresets,locked:false,issues:[],gisValidation,selectedDemandId:value.value.demands[0].id,'onUpdate:modelValue':(v:any)=>value.value=v,onPending:(v:boolean)=>pending.value=v}));await settle();return{...s,...view,planning,value,pending};}
beforeAll(async()=>{for(const [component,name]of [[PlanningRoutingEditor,'PlanningRoutingEditor'],[PlanningOptionsSummary,'PlanningOptionsSummary'],[PlanningTaskForm,'PlanningTaskForm'],[TaskDemandEditor,'TaskDemandEditor'],[TaskApiForm,'TaskApiForm']] as const)await clientTemplate(component,'src/components/'+name+'.vue');});
beforeEach(()=>{class TestDocument extends EventTarget {activeElement=null;}vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class{});});
afterEach(()=>{apps.splice(0).forEach(app=>app.unmount());sessions.splice(0).forEach(s=>{s.task.clearForSession();usePlanningStore(s.pinia).clearForSession();disposePinia(s.pinia);});vi.restoreAllMocks();vi.unstubAllGlobals();focused=null;});
describe('路由条件页面入口',()=>{
 it('设备目录读取失去身份时保留HTTP需求输入，但应用被禁用且旧事件无效',async()=>{const s=await storeFixture();sessions.push(s);vi.spyOn(s.resources,'fetchNodes').mockResolvedValue({items:[readNode()],page:1,pageSize:10,total:1} as any);const devices=vi.spyOn(previewService,'queryResourceDevices'),{root}=mount(TaskApiForm,()=>({}));await settle();await click(root,'编辑');await settle();expect(devices).toHaveBeenCalled();expect(s.auth.identity).toBeNull();const apply=find(root,n=>n.tag==='button'&&textOf(n).trim()==='应用到任务草稿')!;expect(apply.props.disabled).toBe(true);const before=JSON.stringify(s.task.draft);await (apply.props.onClick as Function)();expect(JSON.stringify(s.task.draft)).toBe(before);expect(select(root,'needBackup')).toBeDefined();});
 it('HTTP非法数字备份保持错误，不能经复制变成未指定后应用',async()=>{const s=await session(),demand={...s.task.draft!.demands[0],needBackup:NaN} as any,closed=vi.fn(),{root}=mount(TaskDemandEditor,()=>({visible:true,demand,'onUpdate:visible':closed}));await click(root,'应用到任务草稿');expect(closed).not.toHaveBeenCalled();expect(textOf(root)).toContain('备份请求须为 true、false 或未指定');expect(s.task.draft!.demands[0]).not.toHaveProperty('needBackup');});
 it('三个策略、备份false及清空均按原值发出，不互相覆盖',async()=>{const value=ref<RoutingInput>({}),{root}=mount(PlanningRoutingEditor,()=>({modelValue:value.value,owner:'A','onUpdate:modelValue':(v:RoutingInput)=>value.value=v}));for(const strategy of ['SHORTEST_PATH','MIN_DELAY','MAX_RELIABILITY']){await change(root,'routeStrategy',strategy);expect(value.value.routeStrategy).toBe(strategy);}await change(root,'needBackup','false');expect(value.value).toEqual({routeStrategy:'MAX_RELIABILITY',needBackup:false});await change(root,'routeStrategy','');expect(value.value).toEqual({routeStrategy:null,needBackup:false});await change(root,'needBackup','');expect(value.value.needBackup).toBeNull();});
 it('非法服务输入可见且可逐项修正，伪造选项不能覆盖',async()=>{const value=ref<RoutingInput>({routeStrategy:'BAD',needBackup:'false'} as any),{root}=mount(PlanningRoutingEditor,()=>({modelValue:value.value,owner:'A','onUpdate:modelValue':(v:RoutingInput)=>value.value=v}));expect(textOf(root)).toContain('无效策略（BAD）');await change(root,'routeStrategy','fake');expect(value.value.routeStrategy).toBe('BAD');await change(root,'routeStrategy','MIN_DELAY');expect(value.value.needBackup).toBe('false');await change(root,'needBackup','false');expect(value.value).toEqual({routeStrategy:'MIN_DELAY',needBackup:false});});
 it.each(['owner','input','permission','unmount'])('旧控件事件失效：%s',async(kind)=>{const value=ref<RoutingInput>({}),owner=ref('A'),disabled=ref(false),update=vi.fn(),{root}=mount(PlanningRoutingEditor,()=>({modelValue:value.value,owner:owner.value,disabled:disabled.value,'onUpdate:modelValue':update}));const stale=select(root,'needBackup').props.onChange as Function;if(kind==='owner')owner.value='B';if(kind==='input')value.value={needBackup:true};if(kind==='permission'){disabled.value=true;await settle();disabled.value=false;}if(kind==='unmount')apps.pop()!.unmount();await settle();stale({target:{value:'false'}});expect(update).not.toHaveBeenCalled();});
 it('Mock/GIS需求抽屉应用、清单摘要和未保存标记保持一致',async()=>{const s=await mockForm(true);await change(s.root,'needBackup','false');expect(s.pending.value).toBe(true);await click(s.root,'应用到输入');expect(s.value.value.demands[0].needBackup).toBe(false);expect(textOf(s.root)).toContain('备份：不请求备份');expect(s.pending.value).toBe(false);});
 it('GIS错误按需求ID定位新字段，不切到别的需求',async()=>{const s=await mockForm(true);const issue={objectId:s.value.value.demands[0].id,field:'needBackup',message:'错误'};expect(await s.vm.value.focusValidationIssue(issue)).toBe(true);expect(focused?.props['data-validation-field']).toBe('needBackup');});
 it.each(['task','input','permission'])('Mock旧抽屉应用不能覆盖新上下文：%s',async(kind)=>{const s=await mockForm();await change(s.root,'needBackup','false');const stale=find(s.root,n=>n.tag==='button'&&textOf(n).trim()==='应用到输入')!.props.onClick as Function;if(kind==='task')s.planning.taskId='routing-B';if(kind==='input')s.value.value={...s.value.value,name:'替换输入'};if(kind==='permission')s.auth.accept({...s.auth.identity!,permissions:[]});await settle();stale();await settle();expect(s.value.value.demands[0].needBackup).toBe(true);});
 it('HTTP需求抽屉保留false，并在清单及冻结摘要分别读取各自输入',async()=>{const s=await session(),visible=ref(true),demand=s.task.draft!.demands[0],{root}=mount(TaskDemandEditor,()=>({visible:visible.value,demand,'onUpdate:visible':(v:boolean)=>visible.value=v}));await change(root,'routeStrategy','MIN_DELAY');await change(root,'needBackup','false');await click(root,'应用到任务草稿');expect(s.task.draft!.demands[0]).toMatchObject({routeStrategy:'MIN_DELAY',needBackup:false});expect(visible.value).toBe(false);const frozen=JSON.parse(JSON.stringify(s.task.draft));const list=mount(TaskApiForm,()=>({})),summary=mount(PlanningOptionsSummary,()=>({input:frozen}));await settle();expect(textOf(list.root)).toContain('备份：不请求备份');s.task.draft!.demands[0].needBackup=true;await settle();expect(textOf(summary.root)).toContain('备份：不请求备份');expect(textOf(list.root)).toContain('备份：请求备份');});
 it.each(['task','input','permission'])('HTTP旧需求应用在上下文改变后失效：%s',async(kind)=>{const s=await session(),visible=ref(true),demand=s.task.draft!.demands[0],{root}=mount(TaskDemandEditor,()=>({visible:visible.value,demand}));await change(root,'needBackup','false');const stale=find(root,n=>n.tag==='button'&&textOf(n).trim()==='应用到任务草稿')!.props.onClick as Function;if(kind==='task')s.task.taskId='T2';if(kind==='input')s.task.draft={...s.task.draft!,name:'新输入'};if(kind==='permission')s.auth.accept({...s.auth.identity!,permissions:[]});await settle();stale();expect(s.task.draft!.demands[0]).not.toHaveProperty('needBackup');});
});

