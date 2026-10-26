import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { h,nextTick,ssrContextKey,type App } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { createMemoryHistory,createRouter,RouterView } from 'vue-router';
import { authFixture } from './helpers/auth';
import { useAuthStore } from '../src/stores/auth';
import { useSystemStore } from '../src/stores/system';
import { previewService } from '../src/services';
import SystemView from '../src/views/SystemView.vue';
import RequestState from '../src/components/RequestState.vue';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
// 保留真实页面初始化和离页守卫，表格及抽屉只作宿主隔离。
vi.mock('../src/components/AppTable.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SystemAccountDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SystemRoleDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SystemParameterDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/AppDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }



let app:App|undefined,pinia:ReturnType<typeof createPinia>|undefined;
beforeAll(async()=>{await clientTemplate(SystemView,'src/views/SystemView.vue', 'resource-ledger-render.ts');await clientTemplate(RequestState,'src/components/RequestState.vue', 'resource-ledger-render.ts');});
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
 // 重入只保留入口权限，不保留上次筛选和页码。
 it('日志筛选不串入重入后的账号页',async()=>{
  const s=await setup();expect(s.store.tab).toBe('accounts');expect(previewService.queryAccountSummaries).toHaveBeenLastCalledWith(expect.objectContaining({pageNum:1,pageSize:20}));
  await click(s.root,'操作日志');s.store.query={pageNum:3,actorId:'actor',date:'2026-10-01'};await s.store.refresh();
  await s.router.push('/other');await s.router.push('/system');await settle();
  expect(s.store.tab).toBe('accounts');expect(s.store.query).toEqual({pageNum:1,pageSize:20});expect(previewService.queryAccountSummaries).toHaveBeenLastCalledWith(expect.objectContaining({pageNum:1,pageSize:20}));expect(s.store.loadError).toBe('');
 });
 it('只有日志权限时首入与重入均查询日志第一页',async()=>{
  const s=await setup(true);expect(s.store.tab).toBe('logs');s.store.query={pageNum:2};
  await s.router.push('/other');await s.router.push('/system');await settle();
  expect(s.store.tab).toBe('logs');expect(s.store.query).toEqual({pageNum:1,pageSize:20});expect(previewService.queryOperationSummaries).toHaveBeenLastCalledWith(expect.objectContaining({pageNum:1,pageSize:20}));expect(previewService.queryAccountSummaries).not.toHaveBeenCalled();
 });
 it('未保存系统表单仍由原离页守卫阻止，取消后不重置当前查询',async()=>{
  const s=await setup();await s.store.openAccount();s.store.accountForm!.name='保留输入';s.store.query={pageNum:2,search:'原筛选'};
  const pending=s.router.push('/other');await settle();expect(s.store.decision?.title).toContain('尚未保存');s.store.answer('cancel');await pending;
  expect(s.router.currentRoute.value.path).toBe('/system');expect(s.store.accountForm!.name).toBe('保留输入');expect(s.store.query).toEqual({pageNum:2,search:'原筛选'});
  const leaving=s.router.push('/other');await settle();s.store.answer('discard');await leaving;await s.router.push('/system');await settle();
  expect(s.store.accountForm).toBeNull();expect(s.store.query).toEqual({pageNum:1,pageSize:20});
 });
});

