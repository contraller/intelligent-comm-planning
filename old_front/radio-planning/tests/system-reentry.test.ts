import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer,h,nextTick,ssrContextKey,type App,type Component,type ComponentOptions } from 'vue';
import { parse,compileScript,compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { createMemoryHistory,createRouter,RouterView } from 'vue-router';
import { authFixture } from './helpers/auth';
import { useAuthStore } from '../src/stores/auth';
import { useSystemStore } from '../src/stores/system';
import { previewService } from '../src/services';
import SystemView from '../src/views/SystemView.vue';
import RequestState from '../src/components/RequestState.vue';
// 保留真实页面初始化和离页守卫，表格及抽屉只作宿主隔离。
vi.mock('../src/components/AppTable.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SystemAccountDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SystemRoleDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SystemParameterDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/AppDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
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



let app:App|undefined,pinia:ReturnType<typeof createPinia>|undefined;
beforeAll(async()=>{await clientTemplate(SystemView,'src/views/SystemView.vue');await clientTemplate(RequestState,'src/components/RequestState.vue');});
beforeEach(()=>{vi.stubGlobal('window',new EventTarget());class TestDocument extends EventTarget{activeElement=null;}vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class{});});
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();});
async function setup(limited=false){
 const f=authFixture();await f.login();
 // 部分权限来自真实角色和会话，不能仅改页面身份后被服务刷新成管理员。
 if(limited){
  await f.service.saveSystemRole({...f.mutation(),role:{id:null,name:'仅日志查看',description:'入口权限检查',permissions:['system.view','system.logs']}});
  const role=(await f.service.loadSystemCatalog()).roles.find(r=>r.name==='仅日志查看')!;
  await f.service.saveSystemAccount({...f.mutation(),account:{id:null,username:'log_reader',name:'日志查看员',department:'自检',roleId:role.id}});await f.service.logout();await f.login('log_reader');
 }
 pinia=createPinia();setActivePinia(pinia);const auth=useAuthStore();auth.accept(await f.service.getSession());f.bind();
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/system',component:SystemView},{path:'/other',component:{render:()=>null}}]});
 app=renderer.createApp({render:()=>h(RouterView)});app.use(pinia);app.use(router);app.provide(ssrContextKey,{modules:new Set()});
 await router.push('/system');await router.isReady();const root=node('root');app.mount(root);await settle();
 return{root,router,store:useSystemStore()};
}
describe('系统页面重新进入',()=>{
 it('日志时间排序及筛选不串入重入后的账号页',async()=>{
  const s=await setup();expect(s.store.tab).toBe('accounts');expect(previewService.querySystemAccounts).toHaveBeenLastCalledWith({page:1});
  await click(s.root,'操作日志');s.store.query={page:3,sort:'time',descending:true,actorId:'actor',from:'2026-10-01T00:00:00Z'};await s.store.refresh();
  await s.router.push('/other');await s.router.push('/system');await settle();
  expect(s.store.tab).toBe('accounts');expect(s.store.query).toEqual({page:1});expect(previewService.querySystemAccounts).toHaveBeenLastCalledWith({page:1});expect(s.store.loadError).toBe('');
 });
 it('只有日志权限时首入与重入均查询日志第一页',async()=>{
  const s=await setup(true);expect(s.store.tab).toBe('logs');s.store.query={page:2,sort:'time',descending:true};
  await s.router.push('/other');await s.router.push('/system');await settle();
  expect(s.store.tab).toBe('logs');expect(s.store.query).toEqual({page:1});expect(previewService.queryOperationLogs).toHaveBeenLastCalledWith({page:1});expect(previewService.querySystemAccounts).not.toHaveBeenCalled();
 });
 it('未保存系统表单仍由原离页守卫阻止，取消后不重置当前查询',async()=>{
  const s=await setup();await s.store.openAccount();s.store.accountForm!.name='保留输入';s.store.query={page:2,query:'原筛选'};
  const pending=s.router.push('/other');await settle();expect(s.store.decision?.title).toContain('尚未保存');s.store.answer('cancel');await pending;
  expect(s.router.currentRoute.value.path).toBe('/system');expect(s.store.accountForm!.name).toBe('保留输入');expect(s.store.query).toEqual({page:2,query:'原筛选'});
  const leaving=s.router.push('/other');await settle();s.store.answer('discard');await leaving;await s.router.push('/system');await settle();
  expect(s.store.accountForm).toBeNull();expect(s.store.query).toEqual({page:1});
 });
});

