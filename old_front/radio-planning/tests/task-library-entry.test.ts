import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App, type Component, type ComponentOptions } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { createMockService } from '../src/services/mock';
import { TestStorage } from './helpers/storage';
import { previewService } from '../src/services';

import AppTable from '../src/components/AppTable.vue';
import TaskApiLibraryDrawer from '../src/components/TaskApiLibraryDrawer.vue';
import { useTaskInputStore } from '../src/stores/task-input';
const probes=vi.hoisted(()=>({table:null as any}));
vi.mock('primevue/datatable',()=>({default:Vue.defineComponent({props:['value','paginator','rows'],setup:(p,{slots})=>{Vue.provide('task-table',p);return()=>{probes.table={...p};return Vue.h('div',slots.default?.());};}})}));
vi.mock('primevue/column',()=>({default:Vue.defineComponent({props:['field','header','sortable'],setup:(p,{slots})=>{const table=Vue.inject<any>('task-table');return()=>Vue.h('section',{'data-field':p.field,'data-sortable':p.sortable},table.value.map((row:any)=>Vue.h('div',slots.body?.({data:row}))));}})}));
vi.mock('../src/components/AppDrawer.vue',()=>({default:Vue.defineComponent({props:['visible'],setup:(p,{slots})=>()=>p.visible?Vue.h('aside',slots.default?.()):null})}));
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


let app:App|undefined,pinia:ReturnType<typeof createPinia>;
// v-model 的更新钩子需要最小 Document 宿主。
beforeEach(()=>{class TestDocument extends EventTarget{activeElement=null;}vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class{});});
beforeAll(async()=>{await clientTemplate(AppTable,'src/components/AppTable.vue');await clientTemplate(TaskApiLibraryDrawer,'src/components/TaskApiLibraryDrawer.vue');});
afterEach(()=>{app?.unmount();if(pinia)disposePinia(pinia);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function setup(){pinia=createPinia();setActivePinia(pinia);authorizeStore();const storage=new TestStorage(),raw=createMockService(()=>storage),catalog=await raw.loadPlanningCatalog({context:'planning'});for(let i=0;i<13;i++)await raw.saveTaskInput({context:'planning',taskId:'library-'+i,revision:null,resourceRevision:'initial',requestId:'save-'+i,input:{...catalog.presets[0]!.defaults,name:'分页样本'+i}});
 vi.spyOn(previewService,'queryTaskInputs').mockImplementation(raw.queryTaskInputs);vi.spyOn(previewService,'getTaskInput').mockImplementation(raw.getTaskInput);
 const store=useTaskInputStore(),visible=Vue.ref(false),root=node('root');app=renderer.createApp({render:()=>h(TaskApiLibraryDrawer,{visible:visible.value,'onUpdate:visible':(v:boolean)=>{visible.value=v;}})});app.provide(ssrContextKey,{modules:new Set()});app.mount(root);visible.value=true;await settle();await store.queryLibrary(1);await settle();return{root,store,raw,visible};}
describe('已保存任务实际列表',()=>{
 it('真实服务超过一页，只有外部分页，三列及操作列均不做页内排序',async()=>{const s=await setup();s.store.libraryQuery.search='分页样本';await click(s.root,'查询');await settle();expect(s.store.library!.total).toBe(13);expect(probes.table.value).toHaveLength(10);expect(probes.table.paginator).toBe(false);expect(all(s.root,n=>n.tag==='section'&&typeof n.props['data-field']==='string').every(n=>n.props['data-sortable']===false)).toBe(true);expect(all(s.root,n=>n.tag==='button'&&textOf(n).trim()==='下页')).toHaveLength(1);const expected=await s.raw.queryTaskInputs({context:'planning',page:2,pageSize:10,search:'分页样本'});await click(s.root,'下页');await settle();expect(probes.table.value.map((r:any)=>r.taskId)).toEqual(expected.items.map(r=>r.taskId));expect(probes.table.value).toHaveLength(3);await click(s.root,'查询');await settle();expect(s.store.library!.page).toBe(1);});
 it('打开任务先处理原输入；取消不关闭任务库，确认放弃才打开',async()=>{const s=await setup();const seed=s.store.library!.items[0]!;await s.store.open(seed.taskId,false);s.store.draft={...seed.input,name:'未保存修改'};const action=click(s.root,'打开');await settle();expect(s.store.decision).not.toBeNull();s.store.answer('cancel');await action;expect(s.visible.value).toBe(true);expect(s.store.draft!.name).toBe('未保存修改');const retry=click(s.root,'打开');await settle();s.store.answer('discard');await retry;await settle();expect(s.visible.value).toBe(false);expect(s.store.taskId).toBe(seed.taskId);});
});

