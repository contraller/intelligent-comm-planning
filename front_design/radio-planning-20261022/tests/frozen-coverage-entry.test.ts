import { readFileSync } from 'node:fs';
import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { h,nextTick,ssrContextKey,type App } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import FrozenCoveragePanel from '../src/components/FrozenCoveragePanel.vue';
import FrozenCoverageBandwidthEditor from '../src/components/FrozenCoverageBandwidthEditor.vue';
import { useAuthStore } from '../src/stores/auth';
import { all,clientTemplate,node,renderer,textOf,type HostNode } from './helpers/vue-client';
import { bandwidthCase,coverageCase,coverageV4Case } from './helpers/frozen-coverage';
import type { FrozenCoverageClient } from '../src/types/frozen-coverage';
vi.mock('../src/services',()=>({previewService:{}}));
vi.mock('vue-router',()=>({onBeforeRouteLeave:vi.fn()}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{render:()=>null}}));
let app:App|undefined,pinia:ReturnType<typeof createPinia>;
beforeAll(async()=>{
  await clientTemplate(FrozenCoverageBandwidthEditor,'src/components/FrozenCoverageBandwidthEditor.vue','coverage-bandwidth-entry-render.ts');
  await clientTemplate(FrozenCoveragePanel,'src/components/FrozenCoveragePanel.vue','frozen-coverage-render.ts');
});
beforeEach(()=>{
  class TestDocument { activeElement=null; }
  vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class {});
  vi.stubGlobal('window',new EventTarget());
  pinia=createPinia();setActivePinia(pinia);useAuthStore().accept({id:'editor',sessionId:crypto.randomUUID(),username:'editor',name:'编辑者',roleId:'r',roleName:'r',epoch:'e',revision:'r',permissions:['planning.view','planning.execute','situation.view']});
});
afterEach(()=>{app?.unmount();app=undefined;disposePinia(pinia);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function settle(){for(let count=0;count<8;count++){await Promise.resolve();await nextTick();}}
async function fixture(context:'planning'|'gis'='planning',selected=false,v4?:ReturnType<typeof coverageV4Case>){
  const data=v4??(selected?bandwidthCase():coverageCase());data.query.context=context;
  // 实际组件默认采样参数与响应保持一致，不借测试桩抹掉参数差异。
  Object.assign(data.parameters,{hour:12,cell_m:5000,az_step_deg:10});
  const extra=v4??bandwidthCase(selected),query={...data.query};delete query.bandwidthSelection;
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
  it.each([{complete:226,unavailable:26,skipped:208},{complete:2,unavailable:1,skipped:3}])('V4按summary区分活动缺带宽与本次无活动链路，不硬编码数量 %j',async counts=>{
    const f=await fixture('planning',false,coverageV4Case(counts));await click(f.root,'读取覆盖缓存');
    expect(textOf(f.root)).toContain(`已计算 ${counts.complete} / ${counts.complete+counts.unavailable} 台活动设备`);
    expect(textOf(f.root)).toContain(`不可计算 ${counts.unavailable} 台（缺带宽 ${counts.unavailable} 台，待选带宽 0 台）`);
    expect(textOf(f.root)).toContain(`本次无活动链路 ${counts.skipped} 台`);
    expect(textOf(f.root)).not.toContain('历史结果');
  });
  it('零活动设备显示不适用，旧缓存保留历史分类',async()=>{
    const f=await fixture('planning',false,coverageV4Case({complete:0,unavailable:0,skipped:2}));await click(f.root,'读取覆盖缓存');
    expect(textOf(f.root)).toContain('本次无活动链路');expect(textOf(f.root)).toContain('已计算 0 / 0 台活动设备');expect(textOf(f.root)).not.toContain('完整预测');
    f.client.getCache.mockResolvedValueOnce(coverageCase().cache);await click(f.root,'读取覆盖缓存');
    expect(textOf(f.root)).toContain('历史结果');expect(textOf(f.root)).not.toContain('台活动设备');
  });
  it('实际缺带宽和已有选项尚未选择分别计数',async()=>{
    const v4=coverageV4Case({complete:1,unavailable:2,skipped:1}),unselected=v4.result.devices[2]!;
    unselected.reason_code='RX_BANDWIDTH_SELECTION_REQUIRED';unselected.rx_bandwidth={value_khz:null,source:'UNSELECTED'};
    unselected.frozen_model!.bandwidth_khz='0.5;2.4';
    const f=await fixture('planning',false,v4);await click(f.root,'读取覆盖缓存');
    expect(textOf(f.root)).toContain('不可计算 2 台（缺带宽 1 台，待选带宽 1 台）');expect(textOf(f.root)).toContain('本次无活动链路 1 台');
  });
  it('构造来源与原始资料均展示，不默认勾选、提交或计算',async()=>{
    const f=await fixture('planning',false,coverageV4Case({complete:1,unavailable:0,skipped:1},true));
    expect(textOf(f.root)).toContain('构造接收假设，非厂家实参');expect(textOf(f.root)).toContain('R5-HF-RX-3KHZ-V1');
    expect(all(f.root,row=>String(row.props['aria-label']??'').startsWith('勾选设备 ')).every(row=>row.props.checked===false)).toBe(true);
    expect(field(f.root,'批量带宽').props['onUpdate:modelValue']).toBeTypeOf('function');
    expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();expect(f.client.compute).not.toHaveBeenCalled();
    await click(f.root,'读取覆盖缓存');expect(textOf(f.root)).toContain('原冻结型号资料');expect(textOf(f.root)).toContain('6'.repeat(64));
    expect(field(f.root,'设备 D2 带宽').props.disabled).toBe(true);
  });
  it('批量仅包含活动设备，保存时保留旧选择中未参与设备的原值',async()=>{
    const v4=coverageV4Case({complete:1,unavailable:0,skipped:1},false,true);
    v4.options.devices[0]!.state='SELECTION_REQUIRED';v4.options.devices[0]!.reason_code='RX_BANDWIDTH_SELECTION_REQUIRED';v4.options.devices[0]!.options_khz=[0.5,2.4];
    v4.selection.choices.push({device_id:'D2',rx_bandwidth_khz:2.4});
    const f=await fixture('planning',true,v4),saved=structuredClone(v4.selection);
    saved.selection_id='FBS-'+'5'.repeat(32);saved.selection_hash='7'.repeat(64);saved.version_no=2;saved.choices[0]!.rx_bandwidth_khz=0.5;
    f.client.saveBandwidthSelection.mockResolvedValue(saved);f.client.getBandwidthOptions.mockResolvedValue({...v4.options,current_selection:saved});
    (field(f.root,'筛选带宽型号').props['onUpdate:modelValue'] as (value:string)=>void)('M1');await settle();
    await click(f.root,'勾选该型号（1）');
    expect(field(f.root,'勾选设备 D1').props.checked).toBe(true);expect(field(f.root,'勾选设备 D2').props.checked).toBe(false);
    (field(f.root,'批量带宽').props['onUpdate:modelValue'] as (value:string)=>void)('0.5');await settle();
    await click(f.root,'应用到勾选项（1）');await click(f.root,'预览选择');expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();
    await click(f.root,'确认并提交选择');expect(f.client.saveBandwidthSelection.mock.calls[0]![1]).toEqual(saved.choices);
    expect(f.client.compute).not.toHaveBeenCalled();
  });
});
