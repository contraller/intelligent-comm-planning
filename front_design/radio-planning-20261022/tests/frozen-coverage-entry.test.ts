import { readFileSync } from 'node:fs';
import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { h,nextTick,ssrContextKey,type App } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import FrozenCoveragePanel from '../src/components/FrozenCoveragePanel.vue';
import FrozenCoverageBandwidthEditor from '../src/components/FrozenCoverageBandwidthEditor.vue';
import { useAuthStore } from '../src/stores/auth';
import { all,clientTemplate,node,renderer,textOf,type HostNode } from './helpers/vue-client';
import { bandwidthCase,coverageCase } from './helpers/frozen-coverage';
import type { FrozenCoverageClient } from '../src/types/frozen-coverage';
vi.mock('../src/services',()=>({previewService:{}}));
let app:App|undefined,pinia:ReturnType<typeof createPinia>;
beforeAll(async()=>{
  await clientTemplate(FrozenCoverageBandwidthEditor,'src/components/FrozenCoverageBandwidthEditor.vue','coverage-bandwidth-entry-render.ts');
  await clientTemplate(FrozenCoveragePanel,'src/components/FrozenCoveragePanel.vue','frozen-coverage-render.ts');
});
beforeEach(()=>{
  class TestDocument { activeElement=null; }
  vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class {});
  pinia=createPinia();setActivePinia(pinia);useAuthStore().accept({id:'editor',sessionId:crypto.randomUUID(),username:'editor',name:'编辑者',roleId:'r',roleName:'r',epoch:'e',revision:'r',permissions:['planning.view','planning.execute','situation.view']});
});
afterEach(()=>{app?.unmount();app=undefined;disposePinia(pinia);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function settle(){for(let count=0;count<8;count++){await Promise.resolve();await nextTick();}}
async function fixture(context:'planning'|'gis'='planning',selected=false){
  const data=selected?bandwidthCase():coverageCase();data.query.context=context;
  // 实际组件默认采样参数与响应保持一致，不借测试桩抹掉参数差异。
  Object.assign(data.parameters,{hour:12,cell_m:5000,az_step_deg:10});
  const extra=bandwidthCase(selected),query={...data.query};delete query.bandwidthSelection;
  const client={getBandwidthOptions:vi.fn<FrozenCoverageClient['getBandwidthOptions']>().mockResolvedValue(extra.options),saveBandwidthSelection:vi.fn<FrozenCoverageClient['saveBandwidthSelection']>().mockResolvedValue(extra.selection),getBandwidthSelection:vi.fn<FrozenCoverageClient['getBandwidthSelection']>().mockResolvedValue(extra.selection),getCache:vi.fn<FrozenCoverageClient['getCache']>().mockResolvedValue(data.cache),compute:vi.fn<FrozenCoverageClient['compute']>().mockResolvedValue(data.job),getJob:vi.fn<FrozenCoverageClient['getJob']>().mockResolvedValue(data.job),cancel:vi.fn<FrozenCoverageClient['cancel']>().mockResolvedValue(data.job)};
  const root=node('root'),overlay=vi.fn();app=renderer.createApp({render:()=>h(FrozenCoveragePanel,{query,services:client,onOverlay:overlay})});app.use(pinia);app.provide(ssrContextKey,{});app.mount(root);await settle();return {data,client,root,overlay,extra};
}
async function click(root:HostNode,label:string){const button=all(root,row=>row.tag==='button'&&textOf(row)===label)[0];expect(button).toBeDefined();await (button.props.onClick as ()=>Promise<void>)();await settle();}
function field(root:HostNode,label:string){const control=all(root,row=>row.props['aria-label']===label)[0];expect(control).toBeDefined();return control;}
async function choose(root:HostNode,id:string,value:string){(field(root,`设备 ${id} 带宽`).props.onChange as (event:unknown)=>void)({target:{value}});await settle();}
describe('冻结覆盖正式入口',()=>{
  it('GIS只读缓存且输出真实设备图层，不出现计算命令',async()=>{
    const f=await fixture('gis');expect(f.client.getCache).not.toHaveBeenCalled();expect(textOf(f.root)).not.toContain('计算冻结覆盖');
    await click(f.root,'读取覆盖缓存');expect(f.client.getCache.mock.calls[0][0].context).toBe('gis');expect(f.overlay.mock.lastCall![0].deviceId).toBe('D1');
    expect(textOf(f.root)).toContain('余量单位 dB');expect(f.client.compute).not.toHaveBeenCalled();
  });
  it('规划明确提交、成功后读取缓存；撤销专项写权限不再展示计算按钮',async()=>{
    const f=await fixture();await click(f.root,'计算冻结覆盖');expect(f.client.compute).toHaveBeenCalledOnce();expect(f.client.getCache).toHaveBeenCalledOnce();expect(textOf(f.root)).toContain('完整预测');
    const auth=useAuthStore();auth.accept({...auth.identity!,permissions:['planning.view']});await nextTick();expect(textOf(f.root)).not.toContain('计算冻结覆盖');
  });
  it('坏成功与未知提交显示错误和原号，不给出假覆盖',async()=>{
    const f=await fixture();f.client.compute.mockRejectedValueOnce(new Error('网络中断'));await click(f.root,'计算冻结覆盖');
    expect(textOf(f.root)).toContain('原号');expect(textOf(f.root)).toContain('网络中断');expect(textOf(f.root)).toContain('核实原请求');expect(f.overlay.mock.lastCall![0]).toBeNull();
  });
  it('服务端回读已保存选择；编辑和预览均不改旧图、不发写请求',async()=>{
    const f=await fixture('planning',true);
    expect(f.client.getBandwidthOptions).toHaveBeenCalledOnce();expect(field(f.root,'设备 D1 带宽').props.value).toBe('2.4');
    expect(textOf(f.root)).toContain('人工冻结 v1');expect(f.client.compute).not.toHaveBeenCalled();
    await click(f.root,'读取覆盖缓存');const overlay=f.overlay.mock.lastCall![0];
    await choose(f.root,'D1','0.5');await click(f.root,'预览选择');
    expect(f.overlay.mock.lastCall![0]).toBe(overlay);expect(f.client.getCache).toHaveBeenCalledOnce();
    expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();expect(f.client.compute).not.toHaveBeenCalled();
    const button=all(f.root,row=>row.tag==='button'&&textOf(row)==='计算冻结覆盖')[0]!;expect(button.props.disabled).toBe(true);
  });
  it('人工确认后保存独立版本并回读，新图必须再次显式计算',async()=>{
    const f=await fixture('planning',true),saved=structuredClone(f.extra.selection);
    saved.selection_id='FBS-'+'3'.repeat(32);saved.selection_hash='8'.repeat(64);saved.version_no=2;saved.choices[0]!.rx_bandwidth_khz=0.5;
    f.client.saveBandwidthSelection.mockResolvedValue(saved);f.client.getBandwidthOptions.mockResolvedValue({...f.extra.options,current_selection:saved});
    await choose(f.root,'D1','0.5');await click(f.root,'预览选择');await click(f.root,'确认并提交选择');
    expect(f.client.saveBandwidthSelection.mock.calls[0]![1]).toEqual([{device_id:'D1',rx_bandwidth_khz:0.5}]);
    expect(f.client.getBandwidthOptions).toHaveBeenCalledTimes(2);expect(textOf(f.root)).toContain('人工冻结 v2');
    expect(field(f.root,'设备 D1 带宽').props.value).toBe('0.5');expect(textOf(f.root)).toContain('待确认 0 台');
    expect(f.client.compute).not.toHaveBeenCalled();expect(f.client.getCache).not.toHaveBeenCalled();
  });
  it('仅改单台时保留当前版本内其他已冻结设备选择，不发局部patch',async()=>{
    const f=await fixture('planning',true),catalog=structuredClone(f.extra.options),saved=structuredClone(f.extra.selection);
    catalog.devices.push({...catalog.devices[0]!,device_id:'D2'});catalog.current_selection!.choices.push({device_id:'D2',rx_bandwidth_khz:2.4});
    f.client.getBandwidthOptions.mockResolvedValueOnce(catalog);await click(f.root,'刷新带宽选项与选择');
    saved.selection_id='FBS-'+'4'.repeat(32);saved.selection_hash='7'.repeat(64);saved.version_no=2;
    saved.choices=[{device_id:'D1',rx_bandwidth_khz:0.5},{device_id:'D2',rx_bandwidth_khz:2.4}];
    f.client.saveBandwidthSelection.mockResolvedValue(saved);f.client.getBandwidthOptions.mockResolvedValue({...catalog,current_selection:saved});
    await choose(f.root,'D1','0.5');await click(f.root,'预览选择');await click(f.root,'确认并提交选择');
    expect(f.client.saveBandwidthSelection.mock.calls[0]![1]).toEqual(saved.choices);
  });
  it('GIS恢复选择只读，不出现确认写入且直接旧回调也不能POST',async()=>{
    const f=await fixture('gis',true);expect(field(f.root,'设备 D1 带宽').props.disabled).toBe(true);
    await choose(f.root,'D1','0.5');await click(f.root,'预览选择');await click(f.root,'确认并提交选择');
    expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();expect(f.client.compute).not.toHaveBeenCalled();
    await click(f.root,'读取覆盖缓存');expect(f.client.getCache.mock.calls[0]![0].bandwidthSelection).toEqual(f.data.query.bandwidthSelection);
  });
  it('两个正式宿主接同一共享客户端，地图仅绘制显式冻结覆盖',()=>{
    const read=(path:string)=>readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
    const planning=read('views/PlanningApiView.vue'),gis=read('views/SituationView.vue'),frozen=read('components/GisFrozenPlanPanel.vue'),map=read('components/MapCanvas.vue');
    expect(planning).toContain(':services="collaborationHttp.frozenCoverage"');expect(gis).toContain(':coverage-services="collaborationHttp.frozenCoverage"');
    expect(frozen).toContain('FrozenCoveragePanel');expect(frozen).toMatch(/context:\s*'gis'/);expect(map).toContain('frozenCoverageLayer(');
    expect(map).toContain('props.frozenNetwork?.identity.plan_id');expect(map).toContain('watch(()=>props.frozenCoverage,paint)');
    expect(map).toContain('if(frozenLayer) layers.push(frozenLayer)');
    expect(planning).not.toContain('createFrozenCoverageHttp(');expect(gis).not.toContain('createFrozenCoverageHttp(');
  });
});
