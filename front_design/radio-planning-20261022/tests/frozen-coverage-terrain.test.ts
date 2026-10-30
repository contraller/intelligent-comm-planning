import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { computed,effectScope,h,nextTick,ref,ssrContextKey,type App } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import { readFrozenBandwidthOptions,readFrozenCoverageCache,readFrozenCoverageJob,validateCoverageQuery } from '../src/services/frozen-coverage-decode';
import { createFrozenCoverageHttp } from '../src/services/frozen-coverage-http';
import { frozenCoverageLayer } from '../src/maps/frozen-coverage-layers';
import { useFrozenCoverage } from '../src/composables/useFrozenCoverage';
import FrozenCoveragePanel from '../src/components/FrozenCoveragePanel.vue';
import FrozenCoverageBandwidthEditor from '../src/components/FrozenCoverageBandwidthEditor.vue';
import { useAuthStore } from '../src/stores/auth';
import type { FrozenCoverageClient,FrozenCoverageOverlay,FrozenCoverageQuery } from '../src/types/frozen-coverage';
import { coverageV5Case } from './helpers/frozen-coverage';
import { all,clientTemplate,node,renderer,textOf,type HostNode } from './helpers/vue-client';

vi.mock('../src/services',()=>({previewService:{}}));
vi.mock('vue-router',()=>({onBeforeRouteLeave:vi.fn()}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{render:()=>null}}));

// 构造协议、状态和几何数据；不作为真实DEM或实测场强证据。
function terrainCase(band:'HF'|'VUHF'='HF',selected=false){
  const f=coverageV5Case(),device=f.result.devices[0]!,part=device.computations[0]!;
  f.query.engineVersion='V01-6';f.anchor.engine_version='V01-6';f.result.provenance.engine_version='V01-6';
  f.result.provenance.field_strength!.hf_geometry='P368_P533_LOCAL_TERRAIN_GRID';
  device.band=band;device.frozen_model!.device_class=band;device.planned_parameters!.band=band;f.options.devices[0]!.band=band;
  part.freq_khz=band==='HF'?7000:30000;part.skip_distance_m=200000;part.max_distance_m=900000;
  const offset=20*Math.log10(part.freq_khz/1000)+77.21;
  for(const feature of part.geojson.features){const p=feature.properties;
    p.freq_khz=part.freq_khz;p.field_strength_dbuvm=p.rx_power_dbm!+offset;p.required_field_dbuvm=-100+offset;
    p.terrain_loss_db=2;p.propagation_mode=band==='HF'?'GROUND':'P1812';
  }
  if(selected){
    f.query.bandwidthSelection={selectionId:f.selection.selection_id,selectionHash:f.selection.selection_hash};
    const binding={bandwidth_selection_id:f.selection.selection_id,bandwidth_selection_hash:f.selection.selection_hash};
    Object.assign(f.cache,binding);Object.assign(f.job,binding);Object.assign(f.result.provenance,binding,{bandwidth_choices:f.selection.choices});
    f.options.current_selection=f.selection;device.rx_bandwidth!.source='EXPLICIT_COMPUTE_PARAMETER';
  }
  return f;
}
function mockClient(f:ReturnType<typeof terrainCase>){
  return {getLatestCache:vi.fn<NonNullable<FrozenCoverageClient['getLatestCache']>>().mockResolvedValue(f.cache),
    getBandwidthOptions:vi.fn<FrozenCoverageClient['getBandwidthOptions']>().mockResolvedValue(f.options),
    saveBandwidthSelection:vi.fn<FrozenCoverageClient['saveBandwidthSelection']>().mockResolvedValue(f.selection),
    getBandwidthSelection:vi.fn<FrozenCoverageClient['getBandwidthSelection']>().mockResolvedValue(f.selection),
    getCache:vi.fn<FrozenCoverageClient['getCache']>().mockResolvedValue(f.cache),
    compute:vi.fn<FrozenCoverageClient['compute']>().mockResolvedValue(f.job),
    getJob:vi.fn<FrozenCoverageClient['getJob']>().mockResolvedValue(f.job),
    cancel:vi.fn<FrozenCoverageClient['cancel']>().mockResolvedValue({...f.job,state:'CANCELLED'})};
}
const scopes:ReturnType<typeof effectScope>[]=[];
let app:App|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;scopes.splice(0).forEach(scope=>scope.stop());vi.restoreAllMocks();vi.unstubAllGlobals();});
async function stateFixture(selected=false){
  const f=terrainCase('HF',selected),client=mockClient(f),query=ref<FrozenCoverageQuery|null>({...f.query}),owner=ref('terrain-editor');
  const scope=effectScope();scopes.push(scope);
  const state=scope.run(()=>useFrozenCoverage({query:()=>query.value,parameters:()=>f.parameters,owner:()=>owner.value,client:()=>client,canWrite:()=>true,requestId:()=> 'terrain-request',storage:()=>undefined}))!;
  await state.loadBandwidthOptions();return {f,client,query,owner,state};
}
function layerFor(f:ReturnType<typeof terrainCase>,display:FrozenCoverageOverlay['display']='strength'){
  return frozenCoverageLayer({anchor:f.anchor,result:f.result,deviceId:'D1',display,...f.query.bandwidthSelection?{bandwidthSelection:f.query.bandwidthSelection}:{}},f.query.snapshotId,f.query.planId);
}
function color(layer:ReturnType<typeof layerFor>,index=0){
  const style=layer.getStyleFunction()!(layer.getSource()!.getFeatures()[index]!,1);
  if(!style||Array.isArray(style))throw new Error('缺少格面样式');return style.getFill()?.getColor();
}

describe('V6局地地形与V5历史严格隔离',()=>{
  it.each(['HF','VUHF'] as const)('%s接受schema2预算格面和全部V5场强元数据',band=>{
    const f=terrainCase(band);expect(()=>validateCoverageQuery(f.query)).not.toThrow();
    expect(readFrozenCoverageCache(f.cache,f.query,f.parameters)).toEqual(f.cache);
    expect(readFrozenBandwidthOptions(f.options,f.query)).toEqual(f.options);
    expect(readFrozenCoverageJob(f.job,f.query,f.parameters)).toEqual(f.job);
    expect(f.result.devices[0]!.computations[0]!.geojson.features[0]!.properties.terrain_loss_db).toBe(2);
  });
  it('可选地形说明字段缺省仍接受，径向预算上限不变成显示半径',()=>{
    const f=terrainCase();for(const feature of f.result.devices[0]!.computations[0]!.geojson.features){delete feature.properties.terrain_loss_db;delete feature.properties.propagation_mode;}
    expect(readFrozenCoverageCache(f.cache,f.query,f.parameters).result?.devices[0]!.computations[0]!.max_distance_m).toBe(900000);
    expect(layerFor(f).getSource()!.getFeatures()).toHaveLength(3);
  });
  it.each(['schema','old-metadata','rings','ground','point','null','dem-outside','dem-crossing','radius','hf-range','field','power','margin','grade','units','conversion','gain','medium','strong','terrain-negative','terrain-nan','mode','selection-id','selection-hash','engine'])(
    '拒绝错误V6响应：%s',change=>{
      const f=terrainCase('HF',true),part=f.result.devices[0]!.computations[0]!,feature=part.geojson.features[0]!,p=feature.properties;
      if(change==='schema')f.result.schema_version=1;
      if(change==='old-metadata')f.result.provenance.field_strength!.hf_geometry='P368_P533_RADIAL_BUDGET';
      if(change==='rings')part.shape='RINGS';if(change==='ground')p.surface_kind='GROUND';
      if(change==='point')feature.geometry={type:'Point',coordinates:[114,37.5]};if(change==='null')feature.geometry=null;
      if(change==='dem-outside'&&feature.geometry?.type==='Polygon')for(const ring of feature.geometry.coordinates)for(const point of ring)point[0]+=2;
      if(change==='dem-crossing')f.result.provenance.dem_bbox[2]=114.005;
      if(change==='radius'&&feature.geometry?.type==='Polygon')for(const ring of feature.geometry.coordinates)for(const point of ring)point[0]+=.8;
      if(change==='hf-range')f.parameters.hf_max_km=1;
      if(change==='field')p.field_strength_dbuvm!+=1;if(change==='power')p.rx_power_dbm!+=1;if(change==='margin')p.margin_db!+=1;
      if(change==='grade')p.strength_class='STRONG';if(change==='units')delete f.result.provenance.units.field_strength;
      if(change==='conversion')f.result.provenance.field_strength!.conversion='margin';
      if(change==='gain')Object.assign(f.result.provenance.field_strength!,{receiver_gain_dbi:1});
      if(change==='medium')Object.assign(f.result.provenance.field_strength!,{medium_margin_db:9});
      if(change==='strong')Object.assign(f.result.provenance.field_strength!,{strong_margin_db:19});
      if(change==='terrain-negative')p.terrain_loss_db=-1;if(change==='terrain-nan')p.terrain_loss_db=NaN;if(change==='mode')p.propagation_mode='';
      if(change==='selection-id')f.query.bandwidthSelection!.selectionId='FBS-'+'a'.repeat(32);
      if(change==='selection-hash')f.query.bandwidthSelection!.selectionHash='0'.repeat(64);
      if(change==='engine')f.query.engineVersion='V01-5';
      expect(()=>readFrozenCoverageCache(f.cache,f.query,f.parameters)).toThrow();
    });
  it('V5 HF不能借新增V6分支接受TERRAIN_CELL，V5 VUHF仍保持兼容',()=>{
    const f=terrainCase();f.query.engineVersion='V01-5';f.anchor.engine_version='V01-5';f.result.provenance.engine_version='V01-5';
    f.result.provenance.field_strength!.hf_geometry='P368_P533_RADIAL_BUDGET';
    expect(()=>readFrozenCoverageCache(f.cache,f.query,f.parameters)).toThrow();
    for(const feature of f.result.devices[0]!.computations[0]!.geojson.features)feature.properties.surface_kind='GROUND';
    expect(()=>readFrozenCoverageCache(f.cache,f.query,f.parameters)).toThrow();
    f.result.devices[0]!.computations[0]!.shape='RINGS';
    expect(readFrozenCoverageCache(f.cache,f.query,f.parameters)).toEqual(f.cache);
    const old=coverageV5Case();expect(readFrozenCoverageCache(old.cache,old.query,old.parameters)).toEqual(old.cache);
  });
  it('V6作业不接受其他引擎或其他带宽身份',()=>{
    const f=terrainCase('HF',true);f.job.anchor={...f.anchor,engine_version:'V01-5'};
    expect(()=>readFrozenCoverageJob(f.job,f.query)).toThrow();
    f.job.anchor=f.anchor;f.job.bandwidth_selection_hash='0'.repeat(64);expect(()=>readFrozenCoverageJob(f.job,f.query)).toThrow();
  });
  it('HTTP计算沿原契约默认V6，缓存查询显式版本且保留带宽绑定',async()=>{
    const f=terrainCase('HF',true),request=vi.fn().mockResolvedValueOnce(f.job).mockResolvedValueOnce(f.cache),client=createFrozenCoverageHttp(request);
    await client.compute(f.query,f.parameters,f.job.request_id);await client.getCache(f.query,f.parameters);
    const body=JSON.parse(request.mock.calls[0]![1].body);
    expect(body.bandwidth_selection_id).toBe(f.selection.selection_id);expect(body.parameters.hf_max_km).toBe(900);
    expect(body).not.toHaveProperty('display');expect(body).not.toHaveProperty('engine_version');
    expect(request.mock.calls[1]![0]).toContain('engine_version=V01-6');
  });
});

describe('V6地形格面显示',()=>{
  it('真实返回格面采用绿黄橙分级，不生成圆或远域预算面',()=>{
    const f=terrainCase(),layer=layerFor(f),features=layer.getSource()!.getFeatures();
    expect(features).toHaveLength(3);expect(features.every(feature=>feature.getGeometry()?.getType()==='Polygon')).toBe(true);
    expect([color(layer,2),color(layer,1),color(layer,0)]).toEqual(['#22a05a99','#f0c54199','#ee873599']);
    expect(features.map(feature=>feature.get('surface_kind'))).toEqual(['TERRAIN_CELL','TERRAIN_CELL','TERRAIN_CELL']);
  });
  it.each(['rings','non-cell','dem','radius','uncovered'] as const)('直接图层输入也不绘制%s',change=>{
    const f=terrainCase(),part=f.result.devices[0]!.computations[0]!;part.geojson.features=part.geojson.features.slice(0,1);
    const feature=part.geojson.features[0]!;
    if(change==='rings')part.shape='RINGS';if(change==='non-cell')feature.properties.surface_kind='SKYWAVE';
    if(change==='dem')f.result.provenance.dem_bbox[2]=114.005;
    if(change==='radius'&&feature.geometry?.type==='Polygon')for(const ring of feature.geometry.coordinates)for(const point of ring)point[0]+=.8;
    if(change==='uncovered')feature.properties.is_coverage=false;
    expect(layerFor(f).getSource()!.getFeatures()).toHaveLength(0);
  });
  it('V6图层保留来源与选择ID/hash核对',()=>{
    const f=terrainCase('HF',true),overlay:FrozenCoverageOverlay={anchor:f.anchor,result:f.result,deviceId:'D1'};
    expect(frozenCoverageLayer(overlay,f.query.snapshotId,f.query.planId).getSource()!.getFeatures()).toHaveLength(0);
    overlay.bandwidthSelection=f.query.bandwidthSelection;
    expect(frozenCoverageLayer(overlay,f.query.snapshotId,f.query.planId).getSource()!.getFeatures()).toHaveLength(3);
    overlay.bandwidthSelection={...f.query.bandwidthSelection!,selectionHash:'0'.repeat(64)};
    expect(frozenCoverageLayer(overlay,f.query.snapshotId,f.query.planId).getSource()!.getFeatures()).toHaveLength(0);
  });
  it('热力图对应绝对场强且边界无填色，不改变原始预算',()=>{
    const f=terrainCase(),part=f.result.devices[0]!.computations[0]!;part.geojson.features=part.geojson.features.slice(0,1);
    const next=structuredClone(part);next.freq_khz=14000;
    const p=next.geojson.features[0]!.properties;p.freq_khz=14000;p.field_strength_dbuvm!+=20*Math.log10(2);p.required_field_dbuvm!+=20*Math.log10(2);
    f.result.devices[0]!.computations.push(next);const before=JSON.stringify(f.result),heat=layerFor(f,'field');
    expect(color(heat,0)).not.toBe(color(heat,1));expect(color(layerFor(f,'boundary'))).toBeUndefined();expect(JSON.stringify(f.result)).toBe(before);
  });
});

describe('V6只读地图开关与原请求保护',()=>{
  it('显隐、模式与设备选择只使用缓存，不读取服务或触发计算',async()=>{
    const f=await stateFixture(true);await f.state.read();expect(f.state.overlay.value?.bandwidthSelection).toEqual(f.f.query.bandwidthSelection);
    f.state.visible.value=false;expect(f.state.overlay.value).toBeNull();f.state.display.value='field';f.state.visible.value=true;
    expect(f.state.overlay.value?.display).toBe('field');f.state.display.value='boundary';expect(f.state.overlay.value?.display).toBe('boundary');
    f.state.selectedDeviceId.value='D1';expect(f.client.getCache).toHaveBeenCalledOnce();expect(f.client.getBandwidthOptions).toHaveBeenCalledOnce();
    expect(f.client.compute).not.toHaveBeenCalled();expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();
  });
  it.each(['V01-4','V01-5'] as const)('%s即便外层误授写权限也只读',async version=>{
    const f=await stateFixture();f.query.value={...f.f.query,engineVersion:version};await f.state.loadBandwidthOptions();
    await f.state.read();await f.state.compute();await f.state.saveBandwidthSelection(f.f.selection.choices);
    expect(f.client.getCache).toHaveBeenCalledOnce();expect(f.client.compute).not.toHaveBeenCalled();expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();
  });
  it('取消沿原作业号和V6来源请求，不启动新计算',async()=>{
    const f=await stateFixture(true);f.state.job.value={...f.f.job,state:'RUNNING'};await f.state.cancel();
    expect(f.client.cancel.mock.lastCall?.slice(0,3)).toEqual([f.f.query,f.f.job.job_id,'terrain-request']);
    expect(f.state.job.value?.state).toBe('CANCELLED');expect(f.client.compute).not.toHaveBeenCalled();
  });
  it.each(['identity','source','selection','version'] as const)('%s变化中止旧读取且拒绝迟到缓存',async change=>{
    const f=await stateFixture(true);let finish!:(value:typeof f.f.cache)=>void;
    f.client.getCache.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const reading=f.state.read(),signal=f.client.getCache.mock.lastCall![2];
    if(change==='identity')f.owner.value='another-editor';
    if(change==='source')f.query.value={...f.f.query,planId:'PLAN-other'};
    if(change==='selection')f.query.value={...f.f.query,bandwidthSelection:{...f.f.query.bandwidthSelection!,selectionHash:'0'.repeat(64)}};
    if(change==='version')f.query.value={...f.f.query,engineVersion:'V01-5'};
    finish(f.f.cache);await reading;expect(signal?.aborted).toBe(true);expect(f.state.overlay.value).toBeNull();
  });
});

describe('V6实际组件入口',()=>{
  beforeAll(async()=>{
    await clientTemplate(FrozenCoverageBandwidthEditor,'src/components/FrozenCoverageBandwidthEditor.vue','terrain-bandwidth-render.ts');
    await clientTemplate(FrozenCoveragePanel,'src/components/FrozenCoveragePanel.vue','terrain-panel-render.ts');
  });
  beforeEach(()=>{
    class TestDocument { activeElement=null; }
    vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class {});vi.stubGlobal('window',new EventTarget());
    pinia=createPinia();setActivePinia(pinia);useAuthStore().accept({id:'terrain-editor',sessionId:crypto.randomUUID(),username:'editor',name:'编辑者',roleId:'r',roleName:'r',epoch:'e',revision:'r',permissions:['planning.view','planning.execute','situation.view']});
  });
  async function settle(){for(let count=0;count<8;count++){await Promise.resolve();await nextTick();}}
  async function mount(readonly=false){
    const f=terrainCase(),client=mockClient(f),root=node('root'),overlay=vi.fn(),query=computed(()=>f.query);
    app=renderer.createApp({render:()=>h(FrozenCoveragePanel,{query:query.value,services:client,readonly,onOverlay:overlay})});app.use(pinia!);app.provide(ssrContextKey,{});app.mount(root);await settle();return {f,client,root,overlay};
  }
  async function click(root:HostNode,label:string){
    const button=all(root,row=>row.tag==='button'&&textOf(row)===label)[0]!;expect(button).toBeDefined();await (button.props.onClick as ()=>Promise<void>)();await settle();
  }
  it('默认新计算明确V6，展示局地近似、DEM边界及900km解释预算',async()=>{
    const f=await mount();await click(f.root,'计算冻结覆盖');expect(f.client.compute.mock.lastCall![0].engineVersion).toBe('V01-6');
    const text=textOf(f.root);expect(text).toContain('局地近似');expect(text).toContain('DEM外不推算');expect(text).toContain('原径向预算上限 900 km');expect(text).toContain('HF / VUHF格面分辨率 5000 m');
    expect(text).not.toContain('无静区时可呈连续覆盖圆盘');expect(f.overlay.mock.lastCall![0].display).toBe('strength');
    const display=all(f.root,row=>row.props['aria-label']==='预测覆盖显示方式')[0]!;
    (display.props['onUpdate:modelValue'] as (value:string)=>void)('field');await settle();
    expect(f.overlay.mock.lastCall![0].display).toBe('field');expect(f.client.compute).toHaveBeenCalledOnce();expect(f.client.getCache).toHaveBeenCalledOnce();
  });
  it.each(['V01-5','V01-4'] as const)('历史%s不显示写入口并按指定版本回读',async version=>{
    const f=await mount(),control=all(f.root,row=>row.props['aria-label']==='覆盖结果版本')[0]!;
    expect(all(control,row=>row.tag==='option').map(textOf).join(' ')).toContain('V5，只读');
    (control.props['onUpdate:modelValue'] as (value:string)=>void)(version);await settle();
    expect(textOf(f.root)).not.toContain('计算冻结覆盖');expect(textOf(f.root)).toContain('历史版本仅回读');
    await click(f.root,'读取覆盖缓存');expect(f.client.getCache.mock.lastCall![0].engineVersion).toBe(version);
    expect(f.client.compute).not.toHaveBeenCalled();expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();
  });
  it('只读入口从指定V6最新缓存恢复参数，无任何计算或带宽写入',async()=>{
    const f=await mount(true);await click(f.root,'读取覆盖缓存');
    expect(f.client.getLatestCache.mock.lastCall![0].engineVersion).toBe('V01-6');expect(textOf(f.root)).not.toContain('计算冻结覆盖');
    expect(f.overlay.mock.lastCall![0].anchor.engine_version).toBe('V01-6');expect(f.client.compute).not.toHaveBeenCalled();expect(f.client.saveBandwidthSelection).not.toHaveBeenCalled();
  });
});
