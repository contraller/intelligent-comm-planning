import { afterEach,beforeEach,beforeAll,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer,h,nextTick,ref,ssrContextKey,type App,type Component,type ComponentOptions } from 'vue';
import { parse,compileScript,compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia,setActivePinia,disposePinia } from 'pinia';
import { authFixture } from './helpers/auth';
import { useAuthStore } from '../src/stores/auth';
import { useSystemStore } from '../src/stores/system';
import { previewService } from '../src/services';
import AppTable from '../src/components/AppTable.vue';
import SystemView from '../src/views/SystemView.vue';
const probes=vi.hoisted(()=>({table:null as any}));
// 保留实际 AppTable 模板，只替换第三方 DOM 表格，检查传给它的分页与排序参数。
vi.mock('primevue/datatable',()=>({default:Vue.defineComponent({props:['value','paginator','rows','lazy'],emits:['update:selection'],setup:(p,{slots,emit})=>{Vue.provide('table-state',p);return()=>{probes.table={...p};return Vue.h('div',[slots.default?.(),Vue.h('button',{onClick:()=>emit('update:selection',p.value[0])},'选择第一条记录')]);};}})}));
vi.mock('primevue/column',()=>({default:Vue.defineComponent({props:['field','header','sortable'],setup:(p,{slots})=>{const table=Vue.inject<any>('table-state');return()=>Vue.h('section',{'data-field':p.field,'data-sortable':p.sortable},table.value.map((row:any)=>Vue.h('div',slots.body?.({data:row}))));}})}));
vi.mock('../src/composables/useSystemLeaveGuard',()=>({useSystemLeaveGuard:()=>{}}));
vi.mock('../src/components/AppDrawer.vue',()=>({default:Vue.defineComponent({props:['visible'],setup:(p,{slots})=>()=>p.visible?Vue.h('aside',[slots.default?.(),slots.footer?.()]):null})}));
vi.mock('../src/components/SystemAccountDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/SystemRoleDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/SystemParameterDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{render:()=>null}}));
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


const apps:App[]=[],sessions:ReturnType<typeof createPinia>[]=[];
function mount(component:Component,props:Record<string,unknown>={}){const root=node('root'),app=renderer.createApp({render:()=>h(component,props)});app.provide(ssrContextKey,{modules:new Set()});app.mount(root);apps.push(app);return root;}
async function setup(many=false){const s=authFixture();await s.login();
 if(many)for(let i=22;i>=0;i--)await s.service.saveSystemAccount({...s.mutation(),account:{id:null,username:'routing_user'+String(i).padStart(2,'0'),name:'样本'+String(i).padStart(2,'0'),department:'测试',roleId:'ROLE-VIEWER'}});
 const pinia=createPinia();setActivePinia(pinia);sessions.push(pinia);useAuthStore().accept(await s.service.getSession());s.bind();
 const store=useSystemStore(),root=mount(SystemView);await settle();await store.load();await settle();return{...s,store,root};}
beforeAll(async()=>{await clientTemplate(AppTable,'src/components/AppTable.vue');await clientTemplate(SystemView,'src/views/SystemView.vue');});
beforeEach(()=>{class TestDocument extends EventTarget {activeElement=null;}vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class{});});
afterEach(()=>{apps.splice(0).forEach(app=>app.unmount());sessions.splice(0).forEach(p=>{useSystemStore(p).clearForSession();disposePinia(p);});vi.restoreAllMocks();vi.unstubAllGlobals();probes.table=null;});
describe('系统实际列表分页及日志显示',()=>{
 it('共同表格默认仍有分页，显式关闭时透传到第三方表格',()=>{mount(AppTable,{rows:[{id:'one'}],columns:[{field:'id',header:'编号'}]});expect(probes.table.paginator).toBe(true);expect(probes.table.rows).toBe(10);mount(AppTable,{rows:[],columns:[],paginator:false,pageSize:20});expect(probes.table.paginator).toBe(false);expect(probes.table.rows).toBe(20);});
 it('四个系统页签只有外层分页，各列含操作列都不做页内排序',async()=>{const s=await setup();for(const label of ['账号管理','角色权限','参数配置','操作日志']){await click(s.root,label);await settle();expect(probes.table.paginator).toBe(false);expect(probes.table.rows).toBe(20);const columns=all(s.root,n=>n.tag==='section'&&typeof n.props['data-field']==='string');expect(columns.length).toBeGreaterThan(0);expect(columns.every(c=>c.props['data-sortable']===false)).toBe(true);expect(all(s.root,n=>n.tag==='button'&&textOf(n).trim()==='下一页')).toHaveLength(1);}expect(s.store.loadError).toBe('');});
 it('23条记录先全量排序再分页，翻页和降序沿服务查询',async()=>{const s=await setup(true);s.store.query={query:'样本',page:1,sort:'name',descending:false};await click(s.root,'查询');await settle();expect(s.store.page!.total).toBe(23);expect(probes.table.value.map((r:any)=>r.name)).toEqual(Array.from({length:20},(_,i)=>'样本'+String(i).padStart(2,'0')));expect(textOf(s.root)).toContain('共 23 条，每页 20 条');await click(s.root,'下一页');await settle();expect(probes.table.value.map((r:any)=>r.name)).toEqual(['样本20','样本21','样本22']);expect(textOf(s.root)).toContain('第 2 页');s.store.query.descending=true;await click(s.root,'查询');await settle();expect(s.store.page!.page).toBe(1);expect(probes.table.value[0].name).toBe('样本22');expect(probes.table.value.at(-1).name).toBe('样本03');await click(s.root,'下一页');await settle();expect(probes.table.value.map((r:any)=>r.name)).toEqual(['样本02','样本01','样本00']);});
 it('日志筛选、单元格及详情用中文，查询仍发原枚举，未知值不冒充成功',async()=>{const s=await setup();await click(s.root,'操作日志');await settle();const page=s.store.logs!,seed=page.items[0];expect(seed).toBeDefined();const outcomes=['SUCCESS','FAILED','DENIED','UNCHANGED','EXTERNAL'];
 const rows=outcomes.map((outcome,i)=>({...seed,id:'log-'+i,outcome}));s.store.logs={...page,items:rows as any,total:5};await settle();
 const column=find(s.root,n=>n.props['data-field']==='outcome')!;expect(textOf(column)).toBe('成功失败无权限未变化未知结果（EXTERNAL）');
 const select=find(s.root,n=>n.tag==='select'&&n.props['aria-label']==='操作结果')!;
 expect(all(select,n=>n.tag==='option').map(n=>[n.props.value,textOf(n)])).toEqual([[undefined,'全部结果'],['SUCCESS','成功'],['FAILED','失败'],['DENIED','无权限'],['UNCHANGED','未变化']]);
 await click(s.root,'选择第一条记录');expect(textOf(find(s.root,n=>n.tag==='aside'&&!n.props.class)!)).toContain('成功 / 无');
 vi.mocked(previewService.queryOperationLogs).mockResolvedValue({...page,items:[rows[1] as any],total:1});
 (select.props['onUpdate:modelValue'] as Function)('FAILED');await click(s.root,'查询');await settle();
 expect(previewService.queryOperationLogs).toHaveBeenLastCalledWith(expect.objectContaining({outcome:'FAILED',page:1}));
 expect(rows[0].outcome).toBe('SUCCESS');
 });
});

