import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ref, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import FrozenCoveragePanel from '../src/components/FrozenCoveragePanel.vue';
import FrozenCoverageBandwidthEditor from '../src/components/FrozenCoverageBandwidthEditor.vue';
import { useAuthStore } from '../src/stores/auth';
import { previewService, switchIntegrationIdentity } from '../src/services';
import { ApiError } from '../src/services/types';
import { all, clientTemplate, node, renderer, textOf, type HostNode } from './helpers/vue-client';
import { bandwidthCase } from './helpers/frozen-coverage';
import type { FrozenCoverageClient } from '../src/types/frozen-coverage';
import type { Router } from 'vue-router';

type Route={fullPath:string};
const routing=vi.hoisted(()=>({guards:[] as (()=>boolean|Promise<boolean>)[],after:new Set<(to:Route,from:Route,failure?:unknown)=>void>(),to:{fullPath:'/resources'},from:{fullPath:'/planning'}}));
vi.mock('vue-router',()=>({onBeforeRouteLeave:(guard:(to:Route,from:Route)=>boolean|Promise<boolean>)=>routing.guards.push(()=>guard(routing.to,routing.from))}));
vi.mock('../src/config/env',()=>({env:{mode:'http'}}));
vi.mock('../src/services',()=>({previewService:{logout:vi.fn(),getSession:vi.fn()},releasePageSessionBinding:vi.fn(),switchIntegrationIdentity:vi.fn()}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{props:['request'],emits:['answer'],
  setup(props:{request:{title:string;discardLabel:string;cancelLabel:string}|null},{emit}:{emit:(name:string,value:string)=>void}){
    return()=>props.request?h('section',{'aria-label':props.request.title},[
      h('button',{onClick:()=>emit('answer','cancel')},props.request.cancelLabel),
      h('button',{onClick:()=>emit('answer','discard')},props.request.discardLabel),
    ]):null;
  }}}));

let app:App|undefined,pinia:ReturnType<typeof createPinia>,listeners:Map<string,EventListener>,entries:Map<string,string>;
beforeAll(async()=>{
  await clientTemplate(FrozenCoverageBandwidthEditor,'src/components/FrozenCoverageBandwidthEditor.vue','coverage-guard-editor-render.ts');
  await clientTemplate(FrozenCoveragePanel,'src/components/FrozenCoveragePanel.vue','coverage-guard-panel-render.ts');
});
beforeEach(()=>{
  routing.guards.length=0;routing.after.clear();listeners=new Map();entries=new Map();
  vi.stubGlobal('Document',class {});vi.stubGlobal('document',{activeElement:null});vi.stubGlobal('ShadowRoot',class {});
  vi.stubGlobal('window',{addEventListener:(name:string,listener:EventListener)=>listeners.set(name,listener),removeEventListener:(name:string)=>listeners.delete(name)});
  vi.stubGlobal('sessionStorage',{getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>entries.set(key,value),removeItem:(key:string)=>entries.delete(key)});
  pinia=createPinia();setActivePinia(pinia);
  const auth=useAuthStore();auth.accept({id:'editor',sessionId:crypto.randomUUID(),username:'editor',name:'编辑者',roleId:'r',roleName:'r',epoch:'e',revision:'r',integrationMode:true,permissions:['planning.view','planning.execute','situation.view']});auth.currentPath='/planning';
  vi.mocked(previewService.logout).mockResolvedValue(undefined);
});
afterEach(()=>{app?.unmount();app=undefined;disposePinia(pinia);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function settle(){for(let i=0;i<10;i++){await Promise.resolve();await nextTick();}}
async function fixture(){
  const data=bandwidthCase(),query={...data.query};delete query.bandwidthSelection;
  const client={getBandwidthOptions:vi.fn<FrozenCoverageClient['getBandwidthOptions']>().mockResolvedValue(data.options),saveBandwidthSelection:vi.fn<FrozenCoverageClient['saveBandwidthSelection']>().mockResolvedValue(data.selection),getBandwidthSelection:vi.fn<FrozenCoverageClient['getBandwidthSelection']>().mockResolvedValue(data.selection),getCache:vi.fn<FrozenCoverageClient['getCache']>(),compute:vi.fn<FrozenCoverageClient['compute']>(),getJob:vi.fn<FrozenCoverageClient['getJob']>(),cancel:vi.fn<FrozenCoverageClient['cancel']>()};
  const root=node('root'),panel=ref<{requestLeave:(defer?:boolean)=>Promise<boolean>}>(),input=reactive({query,active:true});
  app=renderer.createApp({render:()=>h(FrozenCoveragePanel,{ref:panel,...input,services:client})});
  // 本宿主仅实现覆盖面板使用的 afterEach；导航对象只提供该面板读取的 fullPath。
  app.config.globalProperties.$router={afterEach:(hook:(to:Route,from:Route,failure?:unknown)=>void)=>{routing.after.add(hook);return()=>{routing.after.delete(hook);};}} as unknown as Router;
  app.use(pinia);app.provide(ssrContextKey,{});app.mount(root);await settle();
  return {data,client,root,panel,input};
}
function control(root:HostNode,name:string){const value=all(root,row=>row.props['aria-label']===name)[0];expect(value).toBeDefined();return value!;}
function value(root:HostNode){return control(root,'设备 D1 带宽').props.value;}
async function choose(root:HostNode,raw='0.5'){(control(root,'设备 D1 带宽').props.onChange as (event:unknown)=>void)({target:{value:raw}});await settle();}
async function click(root:HostNode,name:string){const target=all(root,row=>row.tag==='button'&&textOf(row)===name)[0];expect(target).toBeDefined();await (target!.props.onClick as ()=>unknown)();await settle();}
function unload(){const event={preventDefault:vi.fn(),returnValue:undefined};listeners.get('beforeunload')?.(event as unknown as Event);return event;}
function finishNavigation(failure?:unknown){for(const hook of routing.after)hook(routing.to,routing.from,failure);}
async function submit(root:HostNode){await click(root,'预览选择');await click(root,'确认并提交选择');}
function saved(f:Awaited<ReturnType<typeof fixture>>){const result=structuredClone(f.data.selection);result.selection_id='FBS-'+'3'.repeat(32);result.selection_hash='8'.repeat(64);result.version_no=2;result.choices[0]!.rx_bandwidth_khz=0.5;return result;}

describe('覆盖选择独立离开保护',()=>{
  it('无任务脏态也登记未保存；继续保留输入，明确放弃才清除',async()=>{
    const f=await fixture(),auth=useAuthStore();expect(auth.hasUnsaved()).toBe(false);expect(unload().preventDefault).not.toHaveBeenCalled();
    await choose(f.root);expect(auth.hasUnsaved()).toBe(true);expect(unload().preventDefault).toHaveBeenCalledOnce();
    let leave=f.panel.value!.requestLeave();await settle();await click(f.root,'继续选择');expect(await leave).toBe(false);expect(value(f.root)).toBe('0.5');
    leave=f.panel.value!.requestLeave();await settle();await click(f.root,'放弃未确认选择');expect(await leave).toBe(true);expect(value(f.root)).toBe('2.4');expect(auth.hasUnsaved()).toBe(false);
    expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();
  });
  it('路由守卫延迟放弃，其他守卫或退出写入失败仍保留输入',async()=>{
    const f=await fixture();await choose(f.root);
    const route=routing.guards[0]!();await settle();await click(f.root,'放弃未确认选择');expect(await route).toBe(true);expect(value(f.root)).toBe('0.5');
    vi.mocked(previewService.logout).mockRejectedValueOnce(new Error('退出失败'));
    const logout=useAuthStore().leaveSession();await settle();await click(f.root,'放弃未确认选择');expect(await logout).toBe(false);expect(value(f.root)).toBe('0.5');
    const retry=useAuthStore().leaveSession();await settle();await click(f.root,'放弃未确认选择');expect(await retry).toBe(true);expect(value(f.root)).toBe('2.4');
  });
  it('取消身份切换不换人；成功切换前明确放弃且不移交旧选择',async()=>{
    const f=await fixture(),auth=useAuthStore();await choose(f.root);vi.mocked(switchIntegrationIdentity).mockResolvedValue({...auth.identity!,id:'reviewer',sessionId:'other',permissions:['planning.view'],integrationMode:true});
    let change=auth.switchIntegrationIdentity('reviewer');await settle();await click(f.root,'继续选择');expect(await change).toBe(false);expect(auth.identity!.id).toBe('editor');expect(value(f.root)).toBe('0.5');
    change=auth.switchIntegrationIdentity('reviewer');await settle();await click(f.root,'放弃未确认选择');expect(await change).toBe(true);await settle();expect(auth.identity!.id).toBe('reviewer');expect(value(f.root)).not.toBe('0.5');expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();
  });
  it('失权冻结原输入，不能通过身份变化自动清理本地选择',async()=>{
    const f=await fixture(),auth=useAuthStore();await choose(f.root);auth.accept(null,'身份失效','AUTH_EXPIRED');await settle();
    expect(value(f.root)).toBe('0.5');expect(control(f.root,'设备 D1 带宽').props.disabled).toBe(true);expect(auth.hasUnsaved()).toBe(true);expect(unload().preventDefault).toHaveBeenCalledOnce();
  });
  it('方案引用暂空或换源只读保留原输入，旧读取回调不向新身份发请求',async()=>{
    const f=await fixture();await choose(f.root);const reads=f.client.getBandwidthOptions.mock.calls.length;f.input.active=false;await settle();expect(value(f.root)).toBe('0.5');expect(control(f.root,'设备 D1 带宽').props.disabled).toBe(true);expect(textOf(f.root)).toContain('原输入只读保留');expect(unload().preventDefault).toHaveBeenCalledOnce();
    await click(f.root,'刷新带宽选项与选择');expect(f.client.getBandwidthOptions).toHaveBeenCalledTimes(reads);f.input.active=true;f.input.query={...f.input.query,planId:'PLAN-other'};await settle();expect(value(f.root)).toBe('0.5');expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();
  });
  it('未核实写入阻止离开和旧放弃回调，刷新重挂后仍以原号核实',async()=>{
    const f=await fixture();f.client.saveBandwidthSelection.mockRejectedValueOnce(new Error('网络中断'));await choose(f.root);await submit(f.root);
    const requestId=f.client.saveBandwidthSelection.mock.calls[0]![2];expect(textOf(f.root)).toContain(requestId);expect(await f.panel.value!.requestLeave()).toBe(false);
    await click(f.root,'放弃本次选择');expect(value(f.root)).toBe('0.5');expect(unload().preventDefault).toHaveBeenCalledOnce();expect(entries.size).toBe(1);
    app!.unmount();app=undefined;useAuthStore().generation++;await settle();
    const reloaded=await fixture(),receipt=saved(reloaded);expect(textOf(reloaded.root)).toContain(requestId);expect(reloaded.client.getBandwidthOptions).not.toHaveBeenCalled();
    reloaded.client.saveBandwidthSelection.mockResolvedValue(receipt);reloaded.client.getBandwidthOptions.mockResolvedValue({...reloaded.data.options,current_selection:receipt});
    await click(reloaded.root,'核实带宽选择原请求');expect(reloaded.client.saveBandwidthSelection.mock.calls[0]![2]).toBe(requestId);expect(entries.size).toBe(0);expect(await reloaded.panel.value!.requestLeave()).toBe(true);
  });
  it('同会话重挂的内存原号也进入清理监听，成功回读后不残留旧请求',async()=>{
    const f=await fixture();f.client.saveBandwidthSelection.mockRejectedValueOnce(new Error('网络中断'));await choose(f.root);await submit(f.root);const original=f.client.saveBandwidthSelection.mock.calls[0]![2];app!.unmount();app=undefined;
    const next=await fixture(),receipt=saved(next);expect(textOf(next.root)).toContain(original);next.client.saveBandwidthSelection.mockResolvedValue(receipt);next.client.getBandwidthOptions.mockResolvedValue({...next.data.options,current_selection:receipt});await click(next.root,'核实带宽选择原请求');expect(next.client.saveBandwidthSelection.mock.calls[0]![2]).toBe(original);expect(entries.size).toBe(0);expect(useAuthStore().hasUnsaved()).toBe(false);
  });
  it('已明确拒绝的提交保留原号和草稿，需显式放弃才清理',async()=>{
    const f=await fixture();f.client.saveBandwidthSelection.mockRejectedValueOnce(new ApiError('选择冲突','CONFLICT',null,undefined,409));await choose(f.root);await submit(f.root);
    const requestId=f.client.saveBandwidthSelection.mock.calls[0]![2];expect(textOf(f.root)).toContain(requestId);expect(value(f.root)).toBe('0.5');
    const leave=f.panel.value!.requestLeave();await settle();await click(f.root,'放弃未确认选择');expect(await leave).toBe(true);expect(entries.size).toBe(0);
  });
  it('明确失败原号仅在本次路由成功且卸载后清理，回到原来源不恢复',async()=>{
    const f=await fixture();f.client.saveBandwidthSelection.mockRejectedValueOnce(new ApiError('选择冲突','CONFLICT',null,undefined,409));await choose(f.root);await submit(f.root);const original=f.client.saveBandwidthSelection.mock.calls[0]![2];
    entries.set('other-source','keep');const route=routing.guards[0]!();await settle();await click(f.root,'放弃未确认选择');expect(await route).toBe(true);expect(entries.size).toBe(2);expect(value(f.root)).toBe('0.5');
    finishNavigation();expect(entries.size).toBe(2);app!.unmount();app=undefined;expect([...entries]).toEqual([['other-source','keep']]);expect(routing.after.size).toBe(0);
    const next=await fixture();expect(textOf(next.root)).not.toContain(original);expect(value(next.root)).toBe('2.4');expect(useAuthStore().hasUnsaved()).toBe(false);expect(next.client.saveBandwidthSelection).not.toHaveBeenCalled();
  });
  it.each([['其他守卫取消',{type:4}],['导航失败',new Error('导航加载失败')]])('%s不提交延迟放弃；随后重挂仍保留失败原号和原值',async(_label,failure)=>{
    const f=await fixture();f.client.saveBandwidthSelection.mockRejectedValueOnce(new ApiError('选择冲突','CONFLICT',null,undefined,409));await choose(f.root);await submit(f.root);const original=f.client.saveBandwidthSelection.mock.calls[0]![2];
    const route=routing.guards[0]!();await settle();await click(f.root,'放弃未确认选择');expect(await route).toBe(true);finishNavigation(failure);expect(entries.size).toBe(1);expect(value(f.root)).toBe('0.5');expect(useAuthStore().hasUnsaved()).toBe(true);
    app!.unmount();app=undefined;expect(entries.size).toBe(1);const next=await fixture();expect(textOf(next.root)).toContain(original);expect(textOf(next.root)).toContain('D1：0.5 kHz');expect(useAuthStore().hasUnsaved()).toBe(true);expect(next.client.saveBandwidthSelection).not.toHaveBeenCalled();
  });
  it('退出HTTP失败不清已明确拒绝的原号，卸载重挂后仍可按原号处理',async()=>{
    const f=await fixture();f.client.saveBandwidthSelection.mockRejectedValueOnce(new ApiError('选择冲突','CONFLICT',null,undefined,409));await choose(f.root);await submit(f.root);const original=f.client.saveBandwidthSelection.mock.calls[0]![2];vi.mocked(previewService.logout).mockRejectedValueOnce(new Error('退出失败'));
    const logout=useAuthStore().leaveSession();await settle();await click(f.root,'放弃未确认选择');expect(await logout).toBe(false);expect(entries.size).toBe(1);expect(value(f.root)).toBe('0.5');app!.unmount();app=undefined;
    const next=await fixture();expect(textOf(next.root)).toContain(original);expect(textOf(next.root)).toContain('D1：0.5 kHz');expect(useAuthStore().hasUnsaved()).toBe(true);
  });
  it('明确失败不能用旧确认入口换新号；核实始终重试同一原号',async()=>{
    const f=await fixture();f.client.saveBandwidthSelection.mockRejectedValueOnce(new ApiError('选择冲突','CONFLICT',null,undefined,409));await choose(f.root);await submit(f.root);
    const original=f.client.saveBandwidthSelection.mock.calls[0]![2];expect(control(f.root,'设备 D1 带宽').props.disabled).toBe(true);await submit(f.root);expect(f.client.saveBandwidthSelection).toHaveBeenCalledOnce();
    const receipt=saved(f);f.client.saveBandwidthSelection.mockResolvedValue(receipt);f.client.getBandwidthOptions.mockResolvedValue({...f.data.options,current_selection:receipt});await click(f.root,'核实带宽选择原请求');
    expect(f.client.saveBandwidthSelection.mock.calls[1]![2]).toBe(original);expect(entries.size).toBe(0);expect(useAuthStore().hasUnsaved()).toBe(false);
  });
  it('前次成功的旧回执不能误清后次失败的原号',async()=>{
    const f=await fixture(),receipt=saved(f);f.client.saveBandwidthSelection.mockResolvedValueOnce(receipt);f.client.getBandwidthOptions.mockResolvedValue({...f.data.options,current_selection:receipt});await choose(f.root);await submit(f.root);expect(entries.size).toBe(0);
    f.client.saveBandwidthSelection.mockRejectedValueOnce(new ApiError('新选择冲突','CONFLICT',null,undefined,409));await choose(f.root,'2.4');await submit(f.root);
    const original=f.client.saveBandwidthSelection.mock.calls[1]![2];expect(textOf(f.root)).toContain(original);expect(entries.size).toBe(1);expect([...entries.values()][0]).toContain(original);expect(unload().preventDefault).toHaveBeenCalledOnce();
    await click(f.root,'放弃本次选择');expect(value(f.root)).toBe('0.5');expect(entries.size).toBe(0);expect(useAuthStore().hasUnsaved()).toBe(false);
  });
  it('明确拒绝后重挂保留原值和原号，但仍允许明确放弃',async()=>{
    const f=await fixture();f.client.saveBandwidthSelection.mockRejectedValueOnce(new ApiError('选择冲突','CONFLICT',null,undefined,409));await choose(f.root);await submit(f.root);const original=f.client.saveBandwidthSelection.mock.calls[0]![2];app!.unmount();app=undefined;useAuthStore().generation++;
    const next=await fixture();expect(textOf(next.root)).toContain(original);expect(textOf(next.root)).toContain('D1：0.5 kHz');const leave=click(next.root,'放弃失败选择');await settle();await click(next.root,'放弃未确认选择');await leave;expect(entries.size).toBe(0);expect(useAuthStore().hasUnsaved()).toBe(false);
  });
  it('提交在途及已保存但回读失败都保护输入，回读成功后不再误报脏态',async()=>{
    const f=await fixture(),receipt=saved(f);let resolve!:(value:typeof receipt)=>void;
    f.client.saveBandwidthSelection.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));await choose(f.root);await click(f.root,'预览选择');
    const posting=click(f.root,'确认并提交选择');await settle();expect(await f.panel.value!.requestLeave()).toBe(false);expect(unload().preventDefault).toHaveBeenCalledOnce();
    f.client.getBandwidthOptions.mockRejectedValueOnce(new Error('回读失败'));resolve(receipt);await posting;expect(await f.panel.value!.requestLeave()).toBe(false);expect(value(f.root)).toBe('0.5');expect(entries.size).toBe(1);
    f.client.getBandwidthOptions.mockResolvedValue({...f.data.options,current_selection:receipt});await click(f.root,'刷新带宽选项与选择');expect(await f.panel.value!.requestLeave()).toBe(true);expect(useAuthStore().hasUnsaved()).toBe(false);expect(unload().preventDefault).not.toHaveBeenCalled();
  });
  it('已受理但回读失败时刷新重挂，仍保留原号核实而非另造请求',async()=>{
    const f=await fixture(),receipt=saved(f);f.client.saveBandwidthSelection.mockResolvedValueOnce(receipt);f.client.getBandwidthOptions.mockRejectedValueOnce(new Error('回读失败'));await choose(f.root);await submit(f.root);const original=f.client.saveBandwidthSelection.mock.calls[0]![2];app!.unmount();app=undefined;useAuthStore().generation++;
    const next=await fixture();expect(textOf(next.root)).toContain(original);expect(next.client.getBandwidthOptions).not.toHaveBeenCalled();next.client.saveBandwidthSelection.mockResolvedValue(receipt);next.client.getBandwidthOptions.mockResolvedValue({...next.data.options,current_selection:receipt});await click(next.root,'核实带宽选择原请求');expect(next.client.saveBandwidthSelection.mock.calls[0]![2]).toBe(original);expect(entries.size).toBe(0);expect(useAuthStore().hasUnsaved()).toBe(false);
  });
  it('页面步骤入口调用独立确认且不再按步骤卸载面板；监听卸载后清理',async()=>{
    const source=readFileSync(new URL('../src/views/PlanningApiView.vue',import.meta.url),'utf8');expect(source).toContain('@click="changePlanningStep(i + 1)"');expect(source).toContain('await coveragePanel.value.requestLeave()');expect(source).toContain('FrozenCoveragePanel v-if="lastCoverageQuery"');expect(source).toContain('coveragePanel?.hasProtectedSelection()');expect(source).not.toContain('FrozenCoveragePanel v-if="planning.step !== 1');
    const f=await fixture();await choose(f.root);app!.unmount();app=undefined;expect(listeners.has('beforeunload')).toBe(false);expect(useAuthStore().hasUnsaved()).toBe(false);
  });
});
