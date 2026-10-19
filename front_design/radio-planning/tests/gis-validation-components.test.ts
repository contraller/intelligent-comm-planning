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
 [AppDrawer,'src/components/AppDrawer.vue'],[ResourceEditDrawer,'src/components/ResourceEditDrawer.vue'],
 [InterferenceSourceDrawer,'src/components/InterferenceSourceDrawer.vue'],[PlanningTaskForm,'src/components/PlanningTaskForm.vue'],
].map(([c,p])=>clientTemplate(c as Component,p as string)));
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();focused=null;scrolled=null;});
async function context(){
 class TestDocument {activeElement=null;} vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());
 pinia=createPinia();setActivePinia(pinia);authorizeStore();
 const storage=new TestStorage(),raw=createMockService(()=>storage);
 vi.spyOn(previewService,'loadPreview').mockImplementation(raw.loadPreview);
 const preview=usePreviewStore();await preview.load();
 const editor=useResourceEditStore(),planning=usePlanningStore(),gis=useGisWorkspaceStore();
 editor.begin('gis');planning.draft=structuredClone(planningPresets[0]!.input);planning.presets=structuredClone(planningPresets);
 return {editor,planning,gis,preview,storage,raw};
}
function mount(component:Component,props:Record<string,unknown>={}){
 const root=node('root');app=renderer.createApp({render:()=>h(component,props)});app.use(pinia!);app.provide(ssrContextKey,{});app.mount(root);return root;
}

describe('GIS 校验组件与真实字段定位',()=>{
 it('清单保留上次校验说明、区分来源并提交明确定位意图',async()=>{
  await context();const resource:GisValidationIssue={source:'resource',objectId:'DV-0001',field:'txPowerDbm',message:'功率非法'};
  const props=reactive({issues:[resource],message:'保存失败',notice:'',disabled:false,reason:()=>''}),locate=vi.fn();
  const root=mount(GisValidationPanel,{...props,onLocate:locate});
  expect(textOf(root)).toContain('上次校验结果');expect(textOf(root)).toContain('资源 · DV-0001');
  await click(root,'定位问题');expect(locate).toHaveBeenCalledWith(resource);
 });
 it('清单即使收到直接点击也拒绝禁用事件',async()=>{
  await context();const locate=vi.fn(),root=mount(GisValidationPanel,{issues:[{source:'task',objectId:'TASK',field:'name',message:'未填'}],message:'失败',notice:'',disabled:true,reason:()=>'',onLocate:locate});
  await click(root,'定位问题');expect(locate).not.toHaveBeenCalled();expect(textOf(root)).toContain('任务 · TASK');
 });
 it('AppDrawer 透传动画完成事件',async()=>{
  await context();const shown=vi.fn(),root=mount(AppDrawer,{visible:true,title:'检查',onAfterShow:shown});
  (find(root,n=>n.tag==='drawer-probe')!.props.shown as ()=>void)();expect(shown).toHaveBeenCalledOnce();
 });
 it('当前资源输入不重建，动画完成后焦点仍在指定字段',async()=>{
  const {editor}=await context();await editor.openForm('device','DV-0001','gis');editor.form!.fields.antennaHeightM='bad';
  const root=mount(ResourceEditDrawer);await editor.focusGisIssue('device','DV-0001','antennaHeightM');await nextTick();
  expect(focused?.props['data-validation-field']).toBe('antennaHeightM');expect(scrolled).toBe(focused);
  focused=null;(find(root,n=>n.tag==='drawer-probe')!.props.shown as ()=>void)();await nextTick();
  expect((focused as HostNode|null)?.props['data-validation-field']).toBe('antennaHeightM');expect(editor.form!.fields.antennaHeightM).toBe('bad');
 });
 it('干扰源坐标字段可聚焦，关闭后旧请求不能重新聚焦',async()=>{
  const {editor,preview}=await context();const id=preview.data!.resources.interferences![0]!.id;
  await editor.openForm('interference',id,'gis');const root=mount(InterferenceSourceDrawer);
  await editor.focusGisIssue('interference',id,'longitude');await nextTick();expect(focused?.props['data-validation-field']).toBe('longitude');
  const shown=find(root,n=>n.tag==='drawer-probe')!.props.shown as ()=>void;await editor.closeForm();focused=null;shown();await nextTick();expect(focused).toBeNull();
 });
 it('任务错误定位基本字段，未知字段落到分组并保留说明',async()=>{
  const s=await context();let form:InstanceType<typeof PlanningTaskForm>|null=null;
  const root=mount(PlanningTaskForm,{ref:(v:unknown)=>{form=v as typeof form;},modelValue:s.planning.draft,resources:s.preview.data!.resources,presets:s.planning.presets,issues:[],locked:false,gisValidation:true});
  await form!.focusValidationIssue({objectId:'TASK',field:'name',message:'未填'});expect(focused?.props['data-validation-field']).toBe('name');
  await form!.focusValidationIssue({objectId:'TASK',field:'unknown',message:'未知'});expect(textOf(root)).toContain('没有可编辑控件');
 });
 it('当前需求聚焦保留输入；另一需求或任务字段不能覆盖未应用值',async()=>{
  const s=await context();let form:InstanceType<typeof PlanningTaskForm>|null=null;
  const input=s.planning.draft!,first=input.demands[0]!,second={...first,id:'SECOND'};input.demands.push(second);
  const root=mount(PlanningTaskForm,{ref:(v:unknown)=>{form=v as typeof form;},modelValue:input,resources:s.preview.data!.resources,presets:s.planning.presets,issues:[],locked:false,gisValidation:true});
  const issue={objectId:first.id,field:'maxDelayMs',message:'错误'};await form!.focusValidationIssue(issue);
  const field=find(root,n=>n.props['data-validation-field']==='maxDelayMs')!;
  (field.props['onUpdate:modelValue'] as (v:string)=>void)('BAD');await nextTick();
  expect(await form!.focusValidationIssue({...issue,objectId:second.id})).toBe(false);expect(textOf(root)).toContain('未应用输入');
  expect(await form!.focusValidationIssue({objectId:'TASK',field:'name',message:'错误'})).toBe(false);
  expect(await form!.focusValidationIssue(issue)).toBe(true);expect(find(root,n=>n.props['data-validation-field']==='maxDelayMs')!.value).toBe('BAD');
 });
 it('独立规划页面不启用错误导航',async()=>{
  const s=await context();let form:InstanceType<typeof PlanningTaskForm>|null=null;
  mount(PlanningTaskForm,{ref:(v:unknown)=>{form=v as typeof form;},modelValue:s.planning.draft,resources:s.preview.data!.resources,presets:s.planning.presets,issues:[],locked:false});
  expect(await form!.focusValidationIssue({objectId:'TASK',field:'name',message:'未填'})).toBe(false);expect(focused).toBeNull();
 });
 it('任务权限撤销后不能聚焦字段',async()=>{
  const s=await context();let form:InstanceType<typeof PlanningTaskForm>|null=null;
  mount(PlanningTaskForm,{ref:(v:unknown)=>{form=v as typeof form;},modelValue:s.planning.draft,resources:s.preview.data!.resources,presets:s.planning.presets,issues:[],locked:false,gisValidation:true});
  useAuthStore().identity!.permissions=[];
  expect(await form!.focusValidationIssue({objectId:'TASK',field:'name',message:'未填'})).toBe(false);expect(focused).toBeNull();
 });
});
