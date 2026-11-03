import { afterEach,expect,it,vi } from 'vitest';
import { h,type App } from 'vue';
import { node,renderer } from './helpers/vue-client';
import { useKnowledgeLeaveGuard } from '../src/composables/useKnowledgeLeaveGuard';

const probe=vi.hoisted(()=>({guard:null as null|(()=>Promise<boolean>),auth:{bypassLeave:false,blocked:false,check:vi.fn(async()=>true),registerLeave:vi.fn(()=>()=>{})},store:{dirty:true,locked:false,load:vi.fn(),allowLeave:vi.fn(async()=>true),stopQueries:vi.fn(),answer:vi.fn()}}));
vi.mock('vue-router',()=>({onBeforeRouteLeave:(guard:()=>Promise<boolean>)=>{probe.guard=guard;}}));
vi.mock('../src/stores/auth',()=>({useAuthStore:()=>probe.auth}));
vi.mock('../src/stores/knowledge',()=>({useKnowledgeStore:()=>probe.store}));
let app:App|undefined;
afterEach(()=>{app?.unmount();app=undefined;vi.restoreAllMocks();vi.clearAllMocks();vi.unstubAllGlobals();});
function mount(beforeLeave:()=>Promise<boolean>){vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()});app=renderer.createApp({setup(){useKnowledgeLeaveGuard(beforeLeave);return()=>h('div');}});app.mount(node('root'));}
it('先确认结构化输入，取消弹窗离开时不触发原草稿的保存或放弃',async()=>{
  const builder=vi.fn(async()=>false);mount(builder);expect(await probe.guard!()).toBe(false);expect(builder).toHaveBeenCalledOnce();expect(probe.store.allowLeave).not.toHaveBeenCalled();
});
it('弹窗同意离开后才处理原草稿，原草稿取消仍阻止导航',async()=>{
  const order:string[]=[];mount(async()=>{order.push('结构化输入');return true;});probe.store.allowLeave.mockImplementationOnce(async()=>{order.push('原草稿');return false;});
  expect(await probe.guard!()).toBe(false);expect(order).toEqual(['结构化输入','原草稿']);
});
