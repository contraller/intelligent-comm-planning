import { afterEach,beforeEach,beforeAll,describe,expect,it,vi } from 'vitest';
import * as Vue from 'vue';
import { h,nextTick,ref,ssrContextKey,type App,type Component } from 'vue';
import { createPinia,setActivePinia,disposePinia } from 'pinia';
import { authFixture } from './helpers/auth';
import { useAuthStore } from '../src/stores/auth';
import { useSystemStore } from '../src/stores/system';
import { previewService } from '../src/services';
import { mockService } from '../src/services/mock';
import { httpService } from '../src/services/http';
import AppTable from '../src/components/AppTable.vue';
import SystemView from '../src/views/SystemView.vue';
import RequestState from '../src/components/RequestState.vue';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, all, textOf, type HostNode } from './helpers/vue-client';
const probes=vi.hoisted(()=>({table:null as any,mode:'mock'}));
// 切换实际服务分派；HTTP 只替换适配响应，不另建页面或交互代码。
vi.mock('../src/config/env',async getOriginal=>{
 const original=await getOriginal<typeof import('../src/config/env')>();
 return {...original,env:{...original.env,get mode(){return probes.mode;}}};
});
// 保留实际 AppTable 模板，只替换第三方 DOM 表格，检查传给它的分页与排序参数。
vi.mock('primevue/datatable',()=>({default:Vue.defineComponent({props:['value','paginator','rows','lazy','tableStyle'],emits:['update:selection'],setup:(p,{slots,emit})=>{Vue.provide('table-state',p);return()=>{probes.table={...p};return Vue.h('div',[slots.default?.(),Vue.h('button',{onClick:()=>emit('update:selection',p.value[0])},'选择第一条记录')]);};}})}));
vi.mock('primevue/column',()=>({default:Vue.defineComponent({props:['field','header','sortable','style'],setup:(p,{slots})=>{const table=Vue.inject<any>('table-state');return()=>Vue.h('section',{'data-field':p.field,'data-sortable':p.sortable,'data-min-width':p.style?.minWidth},table.value.map((row:any)=>Vue.h('div',slots.body?.({data:row}))));}})}));
vi.mock('../src/composables/useSystemLeaveGuard',()=>({useSystemLeaveGuard:()=>{}}));
vi.mock('../src/components/AppDrawer.vue',()=>({default:Vue.defineComponent({props:['visible'],setup:(p,{slots})=>()=>p.visible?Vue.h('aside',[slots.default?.(),slots.footer?.()]):null})}));
vi.mock('../src/components/SystemAccountDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/SystemRoleDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/SystemParameterDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{render:()=>null}}));
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
beforeAll(async()=>{await clientTemplate(AppTable,'src/components/AppTable.vue', 'resource-ledger-render.ts');await clientTemplate(SystemView,'src/views/SystemView.vue', 'resource-ledger-render.ts');await clientTemplate(RequestState,'src/components/RequestState.vue', 'resource-ledger-render.ts');});
beforeEach(()=>{class TestDocument extends EventTarget {activeElement=null;}vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class{});});
afterEach(()=>{apps.splice(0).forEach(app=>app.unmount());sessions.splice(0).forEach(p=>{useSystemStore(p).clearForSession();disposePinia(p);});vi.restoreAllMocks();vi.unstubAllGlobals();probes.table=null;probes.mode='mock';});
describe('系统实际列表分页及日志显示',()=>{
 // 同一组件通过真实 dispatch 和访问包装调用两类适配器；这不是 HTTP 联调。
 it.each(['mock','http'])('%s 模式共用查询、编辑保存和错误交互',async mode=>{
  const s=authFixture();await s.login();probes.mode=mode;
  const adapter=(mode==='mock'?mockService:httpService) as unknown as Record<string,(...args:any[])=>Promise<any>>;
  for(const [key,method]of Object.entries(s.raw))vi.spyOn(adapter,key).mockImplementation(method);
  const pinia=createPinia();setActivePinia(pinia);sessions.push(pinia);useAuthStore().accept(await s.service.getSession());
  const store=useSystemStore(),root=mount(SystemView);await settle();await store.load();await settle();
  expect(find(root,n=>n.tag==='button'&&textOf(n).trim()==='新增账号')?.props.disabled).toBe(false);
  expect(textOf(root)).not.toContain('Mock 账号与权限');
  store.query.search='admin';await click(root,'查询');await settle();expect(store.page?.total).toBe(1);
  const query=vi.mocked(adapter.queryAccountSummaries).mock.calls.at(-1)![0];
  expect(query).toMatchObject({search:'admin',pageNum:1,pageSize:20});expect(query).not.toHaveProperty('sort');expect(query).not.toHaveProperty('order');
  await click(root,'编辑');await settle();store.accountForm!.name='共同保存';expect(await store.save()).toBe(true);await settle();
  expect(adapter.saveSystemAccount).toHaveBeenCalledTimes(1);expect(store.decision).toBeNull();expect(textOf(root)).toContain('共同保存');
  vi.mocked(adapter.queryAccountSummaries).mockRejectedValueOnce(new Error('查询暂不可用'));
  await click(root,'查询');await settle();expect(textOf(root)).toContain('查询暂不可用');expect(store.notice).toBe('');
  await click(root,'查询');await settle();expect(store.loadError).toBe('');expect(store.page?.total).toBe(1);
  await click(root,'操作日志');await settle();
  const date=find(root,n=>n.tag==='input'&&n.props.type==='date')!;
  expect(date).toBeDefined();expect(all(root,n=>n.tag==='input'&&n.props.type==='datetime-local')).toHaveLength(0);
  // 精简筛选栏，两种适配仍保留模块/操作列和可访问的单日期输入。
  expect(find(root,n=>n.tag==='input'&&n.props['aria-label']==='日志模块')).toBeUndefined();
  expect(find(root,n=>n.tag==='input'&&n.props['aria-label']==='日志操作')).toBeUndefined();
  expect(textOf(root)).not.toContain('日期（北京时间）');
  expect(date.props['aria-label']).toBe('日志日期（北京时间）');
  expect(find(root,n=>n.props['data-field']==='module')).toBeDefined();
  expect(find(root,n=>n.props['data-field']==='action')).toBeDefined();
  (date.props['onUpdate:modelValue'] as Function)('2026-10-21');await click(root,'查询');await settle();
  const logQuery=vi.mocked(adapter.queryOperationSummaries).mock.calls.at(-1)![0];
  expect(logQuery).toMatchObject({date:'2026-10-21',pageNum:1});expect(logQuery).not.toHaveProperty('from');expect(logQuery).not.toHaveProperty('to');
 });
 it('HTTP 未接入时沿共同页面报错，不回退 Mock',async()=>{
  const s=authFixture();await s.login();probes.mode='http';
  vi.spyOn(httpService,'getSession').mockImplementation(s.raw.getSession);
  const fallback=vi.spyOn(mockService,'loadSystemOptions');
  const pinia=createPinia();setActivePinia(pinia);sessions.push(pinia);useAuthStore().accept(await s.service.getSession());
  const store=useSystemStore(),root=mount(SystemView);await settle();await store.load();await settle();
  expect(store.loadError).toContain('尚未接入');expect(textOf(root)).toContain('尚未接入');expect(fallback).not.toHaveBeenCalled();
 });
 it('共同表格默认仍有分页，显式关闭时透传到第三方表格',()=>{mount(AppTable,{rows:[{id:'one'}],columns:[{field:'id',header:'编号'}]});expect(probes.table.paginator).toBe(true);expect(probes.table.rows).toBe(10);mount(AppTable,{rows:[],columns:[],paginator:false,pageSize:20});expect(probes.table.paginator).toBe(false);expect(probes.table.rows).toBe(20);});
 it('四个页签均无排序控件或表头排序，只保留外层分页',async()=>{const s=await setup();for(const label of ['账号管理','角色权限','参数配置','操作日志']){await click(s.root,label);await settle();expect(probes.table.paginator).toBe(false);expect(probes.table.rows).toBe(20);const columns=all(s.root,n=>n.tag==='section'&&typeof n.props['data-field']==='string');expect(columns.length).toBeGreaterThan(0);expect(columns.every(c=>c.props['data-sortable']===false)).toBe(true);expect(all(s.root,n=>n.props['aria-label']==='排序字段')).toHaveLength(0);expect(textOf(s.root)).not.toContain('降序');expect(all(s.root,n=>n.tag==='button'&&textOf(n).trim()==='下一页')).toHaveLength(1);}expect(s.store.loadError).toBe('');});
 // 反序插入的样本暴露任何隐藏排序；修改输入后翻页仍沿用上次查询。
 it('按服务原顺序分页，翻页不提交尚未查询的筛选',async()=>{
  const s=await setup(true);s.store.query={search:'样本',pageNum:1};await click(s.root,'查询');await settle();
  expect(s.store.page!.total).toBe(23);expect(probes.table.value.map((r:any)=>r.name)).toEqual(Array.from({length:20},(_,i)=>'样本'+String(22-i).padStart(2,'0')));
  expect(textOf(s.root)).toContain('共 23 条，每页 20 条');await click(s.root,'下一页');await settle();
  expect(probes.table.value.map((r:any)=>r.name)).toEqual(['样本02','样本01','样本00']);expect(textOf(s.root)).toContain('第 2 页');
  s.store.query.search='没有匹配的账号';await click(s.root,'上一页');await settle();
  expect(previewService.queryAccountSummaries).toHaveBeenLastCalledWith(expect.objectContaining({search:'样本',pageNum:1}));
  expect(s.store.query.search).toBe('没有匹配的账号');expect(s.store.page!.total).toBe(23);
  await click(s.root,'查询');await settle();expect(s.store.page).toMatchObject({pageNum:1,total:0,items:[]});
  for(const [query]of vi.mocked(previewService.queryAccountSummaries).mock.calls){expect(query).not.toHaveProperty('sort');expect(query).not.toHaveProperty('order');}
 });
 it('日志筛选、单元格及详情用中文，查询仍发原枚举，未知值不冒充成功',async()=>{const s=await setup();await click(s.root,'操作日志');await settle();const page=s.store.logs!,seed=page.items[0];expect(seed).toBeDefined();const outcomes=['SUCCESS','FAILED','DENIED','UNCHANGED','EXTERNAL'];
 const rows=outcomes.map((outcome,i)=>({...seed,id:'log-'+i,outcome,time:'2026-10-20T16:01:02.000Z'}));s.store.logs={...page,items:rows as any,total:5};await settle();
 // 取消过宽的内联表格下限，列宽局部收紧；时间口径保持不变。
 expect(probes.table.tableStyle).toBeUndefined();
 expect(find(s.root,n=>n.props['data-field']==='actor')?.props['data-min-width']).toBe('170px');
 expect(find(s.root,n=>n.props['data-field']==='outcome')?.props['data-min-width']).toBe('112px');
 expect(textOf(find(s.root,n=>n.props['data-field']==='time')!)).toContain('2026/10/21 00:01:02');
 const column=find(s.root,n=>n.props['data-field']==='outcome')!;expect(textOf(column)).toBe('成功失败无权限未变化未知结果（EXTERNAL）');
 const select=find(s.root,n=>n.tag==='select'&&n.props['aria-label']==='操作结果')!;
 expect(all(select,n=>n.tag==='option').map(n=>[n.props.value,textOf(n)])).toEqual([[undefined,'全部结果'],['SUCCESS','成功'],['FAILED','失败'],['DENIED','无权限'],['UNCHANGED','未变化']]);
 vi.spyOn(previewService,'getOperationEvent').mockResolvedValue({...rows[0],epoch:'fixture',requestId:null,dedupeKey:'fixture'} as any);
 await click(s.root,'选择第一条记录');await settle();const detail=textOf(find(s.root,n=>n.tag==='aside'&&!n.props.class)!);expect(detail).toContain('成功 / 无');expect(detail).toContain('2026/10/21 00:01:02');
 // 失败后的同一入口重试会清理旧提示，不残留错误。
 vi.mocked(previewService.getOperationEvent).mockRejectedValueOnce(new Error('日志暂不可读'));
 s.store.notice='上一次保存成功';await click(s.root,'选择第一条记录');await settle();expect(s.store.error).toBe('日志暂不可读');expect(s.store.notice).toBe('');
 await click(s.root,'选择第一条记录');await settle();expect(s.store.error).toBe('');
 vi.mocked(previewService.queryOperationSummaries).mockResolvedValue({...page,items:[rows[1] as any],total:1});
 (select.props['onUpdate:modelValue'] as Function)('FAILED');await click(s.root,'查询');await settle();
 expect(previewService.queryOperationSummaries).toHaveBeenLastCalledWith(expect.objectContaining({outcome:'FAILED',pageNum:1}));
 expect(rows[0].outcome).toBe('SUCCESS');
 });
});

