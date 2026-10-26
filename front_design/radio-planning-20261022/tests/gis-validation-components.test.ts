import { useResourceReadStore } from '../src/stores/resource-read';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, reactive, ssrContextKey, type App, type Component } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import GisValidationPanel from '../src/components/GisValidationPanel.vue';
import AppDrawer from '../src/components/AppDrawer.vue';
import ResourceEditDrawer from '../src/components/ResourceEditDrawer.vue';
import InterferenceSourceDrawer from '../src/components/InterferenceSourceDrawer.vue';
import TaskApiForm from '../src/components/TaskApiForm.vue';
import TaskApiPanel from '../src/components/TaskApiPanel.vue';
import TaskDemandEditor from '../src/components/TaskDemandEditor.vue';
import { useTaskInputStore } from '../src/stores/task-input';
import { usePreviewStore } from '../src/stores/preview';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { usePlanningApiStore } from '../src/stores/planning-api';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useAuthStore } from '../src/stores/auth';
import { createMockService } from '../src/services/mock';
import { previewService } from '../src/services';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { ApiError } from '../src/services/types';
import type { GisValidationIssue } from '../src/services/gis-validation';
import { useGisValidationNavigation } from '../src/composables/useGisValidationNavigation';
// 仅复用模板编译，原有特殊宿主和业务交互保持本地。
import { clientTemplate } from './helpers/vue-client';

// 只替换弹层外壳；实际 AppDrawer 负责转发 after-show，实际表单负责聚焦。
vi.mock('primevue/drawer',async()=>{
 const {defineComponent,h}=await import('vue');
 return {default:defineComponent({props:['visible'],emits:['update:visible','after-show'],
 setup:(props,{slots,emit})=>()=>props.visible?h('drawer-probe',{shown:()=>emit('after-show')},[slots.default?.(),slots.footer?.()]):null})};
});
let focused:HostNode|null=null,scrolled:HostNode|null=null;
// 实际组件模板在内存宿主运行，验证事件和文本，不模拟真实布局。

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
 [AppDrawer,'src/components/AppDrawer.vue'],[ResourceEditDrawer,'src/components/ResourceEditDrawer.vue'],
 [InterferenceSourceDrawer,'src/components/InterferenceSourceDrawer.vue'],[TaskApiForm,'src/components/TaskApiForm.vue'],
 [TaskApiPanel,'src/components/TaskApiPanel.vue'],[TaskDemandEditor,'src/components/TaskDemandEditor.vue'],
].map(([c,p])=>clientTemplate(c as Component,p as string, 'coverage-render.ts')));
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();focused=null;scrolled=null;});
async function context(){
 class TestDocument {activeElement=null;} vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());
 pinia=createPinia();setActivePinia(pinia);authorizeStore();
 const storage=new TestStorage(),raw=createMockService(()=>storage);
  // 公共分页与完整 GIS 资料绑定同一存储。
  for (const key of ['loadResourceReadContext','queryResourceDevices','queryResourceNodes','queryResourceInterferences','getResourceObject','queryResourceMap','loadGisResourceScene','loadGisResourceEditContext'] as const) vi.spyOn(previewService,key).mockImplementation(raw[key].bind(raw) as never);

 vi.spyOn(previewService,'loadPreview').mockImplementation(raw.loadPreview);
 const preview=usePreviewStore();await preview.load();
  const editor=useResourceEditStore(),planning=useTaskInputStore(),gis=useGisWorkspaceStore();
  // 保留首次真实初始化，由 taskContext 读取预设，不提前填入任务草稿。
  const read=useResourceReadStore();await read.activate('gis');editor.acceptGisContext(await raw.loadGisResourceEditContext({context:'gis',revision:read.workspace!.revision}));editor.begin();
 return {editor,planning,gis,preview,storage,raw};
}
function mount(component:Component,props:Record<string,unknown>={}){
 const root=node('root');app=renderer.createApp({render:()=>h(component,props)});app.use(pinia!);app.provide(ssrContextKey,{});app.mount(root);return root;
}
async function taskContext(){
 const s=await context();
 // 当前任务入口使用同一个 Mock 服务，避免查询落入另一个身份或存储。
 for(const [name,method]of Object.entries(s.raw))if(typeof method==='function')vi.spyOn(previewService as any,name).mockImplementation(method);
 const task=useTaskInputStore();await task.initialize('planning');return{...s,task};
}
const delayField=(root:HostNode)=>find(find(root,n=>n.tag==='label'&&textOf(n).includes('最大时延 / ms'))!,n=>n.tag==='input')!;

describe('GIS 资源校验与规划输入隔离',()=>{
 it('清单保留上次校验说明、区分来源并提交明确定位意图',async()=>{
  await context();const resource:GisValidationIssue={source:'resource',objectId:'DV-0001',field:'txPowerDbm',message:'功率非法'};
  const props=reactive({issues:[resource],message:'保存失败',notice:'',disabled:false,reason:()=>''}),locate=vi.fn();
  const root=mount(GisValidationPanel,{...props,onLocate:locate});
  expect(textOf(root)).toContain('上次校验结果');expect(textOf(root)).toContain('资源 · DV-0001');
  await click(root,'定位问题');expect(locate).toHaveBeenCalledWith(resource);
 });
 it('清单即使收到直接点击也拒绝禁用事件',async()=>{
   await context();const locate=vi.fn(),root=mount(GisValidationPanel,{issues:[{source:'resource',objectId:'DV-0001',field:'name',message:'未填'}],message:'失败',notice:'',disabled:true,reason:()=>'',onLocate:locate});
   await click(root,'定位问题');expect(locate).not.toHaveBeenCalled();expect(textOf(root)).toContain('资源 · DV-0001');
 });
 it('AppDrawer 透传动画完成事件',async()=>{
  await context();const shown=vi.fn(),root=mount(AppDrawer,{visible:true,title:'检查',onAfterShow:shown});
  (find(root,n=>n.tag==='drawer-probe')!.props.shown as ()=>void)();expect(shown).toHaveBeenCalledOnce();
 });
 it('当前资源输入不重建，动画完成后焦点仍在指定字段',async()=>{
  const {editor}=await context();await editor.openForm('device','DV-0001');editor.form!.fields.antennaHeightM='bad';
  const root=mount(ResourceEditDrawer);await editor.focusGisIssue('device','DV-0001','antennaHeightM');await nextTick();
  expect(focused?.props['data-validation-field']).toBe('antennaHeightM');expect(scrolled).toBe(focused);
  focused=null;(find(root,n=>n.tag==='drawer-probe')!.props.shown as ()=>void)();await nextTick();
  expect((focused as HostNode|null)?.props['data-validation-field']).toBe('antennaHeightM');expect(editor.form!.fields.antennaHeightM).toBe('bad');
 });
 it('干扰源坐标字段可聚焦，关闭后旧请求不能重新聚焦',async()=>{
  const {editor,preview}=await context();const id=preview.data!.resources.interferences![0]!.id;
  await editor.openForm('interference',id);const root=mount(InterferenceSourceDrawer);
  await editor.focusGisIssue('interference',id,'longitude');await nextTick();expect(focused?.props['data-validation-field']).toBe('longitude');
  const shown=find(root,n=>n.tag==='drawer-probe')!.props.shown as ()=>void;await editor.closeForm();focused=null;shown();await nextTick();expect(focused).toBeNull();
 });
 // 规划输入错误只在规划表单展示，GIS 不再提供任务字段定位。
 it('规划表单展示错误且没有GIS任务定位入口',async()=>{
  const s=await taskContext();s.task.issues=[{objectId:'TASK',field:'name',message:'任务名未填'}];const root=mount(TaskApiPanel);
  expect(textOf(root)).toContain('任务名未填');expect(find(root,n=>n.tag==='button'&&textOf(n).trim()==='定位问题')).toBeUndefined();
 });
 it('无效的未应用需求阻止任务准备并保留原输入',async()=>{
  const s=await taskContext(),before=structuredClone(Vue.toRaw(s.task.draft)),root=mount(TaskApiForm);
  await click(root,'编辑');const field=delayField(root);
  (field.props['onUpdate:modelValue'] as (v:string)=>void)('BAD');await nextTick();
  expect(s.task.auxiliary.demand).toBe(true);expect(await s.task.save()).toBe(false);expect(field.value).toBe('BAD');expect(s.task.draft).toEqual(before);
 });
 it('任务权限撤销后旧应用事件不能覆盖输入',async()=>{
  const s=await taskContext(),updated=vi.spyOn(s.task,'updateInput'),root=mount(TaskApiForm);
  await click(root,'编辑');const field=delayField(root);
  (field.props['onUpdate:modelValue'] as (v:string)=>void)('25');await nextTick();useAuthStore().identity!.permissions=[];await nextTick();
  await click(root,'应用到任务草稿');expect(updated).not.toHaveBeenCalled();expect(field.value).toBe('25');
 });
  it('GIS导航不接管任务错误，规划忙碌不禁用资源问题定位',async()=>{
   const s=await context(),showResource=vi.fn();let navigation!:ReturnType<typeof useGisValidationNavigation>;
   mount({setup(){navigation=useGisValidationNavigation({showResource});return()=>h('navigation-probe');}});
    usePlanningApiStore().busy=true;const task:GisValidationIssue={source:'task',objectId:'TASK',field:'name',message:'未填'};s.planning.issues=[task];
   expect(s.gis.validationIssues).toEqual([]);expect(navigation.disabled.value).toBe(false);expect(navigation.reason(task)).toContain('网络规划');await navigation.locate(task);expect(showResource).not.toHaveBeenCalled();
  });
});
