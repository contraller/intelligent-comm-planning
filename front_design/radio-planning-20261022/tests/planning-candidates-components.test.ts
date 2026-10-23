import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import type View from 'ol/View';
import type Feature from 'ol/Feature';
import type Point from 'ol/geom/Point';
import type BaseLayer from 'ol/layer/Base';
import VectorLayer from 'ol/layer/Vector';
import MapCanvas from '../src/components/MapCanvas.vue';
import PlanningCandidatePanel from '../src/components/PlanningCandidatePanel.vue';
import AppTable from '../src/components/AppTable.vue';
import { usePlanningCandidates } from '../src/composables/usePlanningCandidates';
import { getPresetResultDetails } from '../src/services/planning-result-details-mock';
import { planningPresets } from '../src/mocks/planning-presets';
import { projectCoordinate } from '../src/maps/layers';
import type { CandidateMapFrame } from '../src/types/planning-candidates';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, all, textOf, type HostNode } from './helpers/vue-client';

// 地图外壳替身仅隔离DOM/画布，真实OpenLayers要素、投影与候选样式运行。
interface MapEvent { pixel: number[]; coordinate: number[]; originalEvent?: object }
interface Probe { view: View; layers: BaseLayer[]; picked?: Feature; handlers: Map<string, (e:MapEvent)=>void>; setLayers: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }
const probes=vi.hoisted(()=>({maps:[] as Probe[]}));
vi.mock('ol/Map',()=>({default:class implements Probe {
  view:View; layers:BaseLayer[]=[]; picked?:Feature; handlers=new Map<string,(e:MapEvent)=>void>();
  setLayers=vi.fn((layers:BaseLayer[])=>{this.layers=layers;});dispose=vi.fn();
  constructor(options:{view:View}) {this.view=options.view;vi.spyOn(this.view,'fit').mockImplementation(()=>{});vi.spyOn(this.view,'animate').mockImplementation(()=>{});probes.maps.push(this);}
  getView(){return this.view;} getSize(){return[960,640];} updateSize(){}
  on(type:string,fn:(e:MapEvent)=>void){this.handlers.set(type,fn);}
  forEachFeatureAtPixel(_pixel:number[],fn:(f:Feature)=>unknown){if(this.picked)return fn(this.picked);}
}}));
vi.mock('ol/control',()=>({defaults:()=>({extend:()=>[]}),ScaleLine:class{}}));
vi.mock('primevue/column',()=>({default:{inheritAttrs:false,props:['field','sortable'],setup:(p:any)=>()=>h('column-probe',{...p})}}));
vi.mock('primevue/datatable',async()=>{const {h}=await import('vue');return{default:{inheritAttrs:false,props:['value','selection','rows'],emits:['update:selection'],setup:(p:any,{emit,slots}:any)=>()=>h('table-probe',{...p,select:(row:unknown)=>emit('update:selection',row)},slots.default?.())}};});
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


for(const [component,file] of [[MapCanvas,'MapCanvas'],[PlanningCandidatePanel,'PlanningCandidatePanel'],[AppTable,'AppTable']] as const)await clientTemplate(component,'src/components/'+file+'.vue', 'candidate-render.ts');
let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;probes.maps.length=0;vi.restoreAllMocks();vi.unstubAllGlobals();});
const sample=()=>getPresetResultDetails('balanced',planningPresets[0].input)!.candidateScreening!;
function environment(){
  vi.stubGlobal('window',Object.assign(new EventTarget(),{matchMedia:()=>Object.assign(new EventTarget(),{matches:true})}));
  vi.stubGlobal('document',Object.assign(new EventTarget(),{hidden:false,activeElement:null}));
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  pinia=createPinia();setActivePinia(pinia);
}
async function mountMap(resourceRead=false,integrated=true){
  environment();const props=reactive({stations:[],resourceRead,planningCandidates:integrated?{owner:'one',epoch:1,visible:true,points:sample().candidates!,selectedId:''} as CandidateMapFrame:undefined});
  const events=vi.fn();app=renderer.createApp({render:()=>h(MapCanvas,{...props,onSelectPlanningCandidate:events})});app.use(pinia!);app.provide(ssrContextKey,{});const root=node('root');app.mount(root);await nextTick();
  const probe=probes.maps[0];
  const layer=()=>probe.layers.find(l=>l instanceof VectorLayer&&l.getSource()?.getFeatures().some((f:Feature)=>f.get('kind')==='planning-candidate-point')) as VectorLayer<any>;
  const clickEvent=()=>{(find(root,n=>n.props.onPointerdownCapture!==undefined)!.props.onPointerdownCapture as ()=>void)();const event={pixel:[0,0],coordinate:[0,0],originalEvent:{}};probe.handlers.get('click')!(event);return event;};
  return {props,root,probe,layer,events,clickEvent};
}
describe('候选真实组件及地图',()=>{
  it.each([false,true])('resourceRead=%s 只绘制返回坐标，样式/显隐/选择不重建正式业务层',async resourceRead=>{
    const s=await mountMap(resourceRead),features=s.layer().getSource()!.getFeatures() as Feature<Point>[];
    expect(features).toHaveLength(3);expect(features[0].getGeometry()!.getCoordinates()).toEqual(projectCoordinate([114.88,37.21]));
    expect((features[2].getStyle() as any).getText().getText()).toBe('×');expect(textOf(s.root)).toContain('候选筛选结论');
    s.probe.picked=features[0];const event=s.clickEvent();s.probe.handlers.get('singleclick')!(event);expect(s.events).toHaveBeenCalledWith({owner:'one',epoch:1,siteId:'CS-DEMO-01'});
    const paints=s.probe.setLayers.mock.calls.length,animations=(s.probe.view.animate as any).mock.calls.length;
    s.props.planningCandidates!.selectedId='CS-DEMO-01';await nextTick();expect(s.probe.setLayers).toHaveBeenCalledTimes(paints);
    s.props.planningCandidates!.visible=false;await nextTick();expect(s.layer().getVisible()).toBe(false);expect(textOf(s.root)).not.toContain('候选筛选结论');
    s.probe.handlers.get('singleclick')!(event);expect(s.events).toHaveBeenCalledTimes(1);expect(s.probe.view.animate).toHaveBeenCalledTimes(animations);
  });
  it('旧要素、延迟点击、换结果及卸载均不得选中新点',async()=>{
    const s=await mountMap(),oldFeature=s.layer().getSource()!.getFeatures()[0];s.probe.picked=oldFeature;
    const old=s.clickEvent();s.props.planningCandidates={...s.props.planningCandidates!,owner:'two',epoch:2};await nextTick();
    s.probe.handlers.get('singleclick')!(old);expect(s.events).not.toHaveBeenCalled();
    s.probe.picked=s.layer().getSource()!.getFeatures()[0];s.probe.handlers.get('singleclick')!(old);expect(s.events).not.toHaveBeenCalled();
    const current=s.clickEvent();s.probe.handlers.get('singleclick')!(current);expect(s.events).toHaveBeenCalledTimes(1);
    app!.unmount();app=undefined;s.probe.handlers.get('singleclick')!(current);expect(s.events).toHaveBeenCalledTimes(1);
  });
  it('未显式接入的地图保持原层和图例',async()=>{
    const s=await mountMap(false,false);expect(s.layer()).toBeUndefined();expect(textOf(s.root)).not.toContain('候选筛选结论');
  });
  it('真实面板区分服务统计与当前明细，保留未知与空数据语义',async()=>{
    environment();const data=reactive({screening:sample()});data.screening.candidateCount=1137;data.screening.deployableCount=1117;
    let controller!:ReturnType<typeof usePlanningCandidates>;
    app=renderer.createApp({setup(){controller=usePlanningCandidates({screening:()=>data.screening,owner:()=> 'panel',active:()=>true,readable:()=>true,generation:()=>1,locate:()=>{}});return()=>h(PlanningCandidatePanel,{view:controller.view.value});}});
    app.use(pinia!);app.provide(ssrContextKey,{});const root=node('root');app.mount(root);await nextTick();
    expect(textOf(root)).toContain('服务候选统计：1137');expect(textOf(root)).toContain('已返回明细条数：4');expect(find(root,n=>n.tag==='table-probe')!.props.rows).toBe(5);
    // 摘要减少列数，但候选身份与明细仍由同一控制器维护。
    const columns=all(root,n=>n.tag==='column-probe'&&!!n.props.field);
    expect(columns.map(n=>n.props.field)).toEqual(['siteId','isDeployable','score']);expect(columns.every(n=>n.props.sortable===false)).toBe(true);
    controller.view.value.actions.select(controller.view.value.rows[3]);await nextTick();expect(textOf(root)).toContain('未提供坐标，无法定位');expect(textOf(root)).toContain('未提供结论');
    data.screening.candidates=[];data.screening.rejectedStats={};await nextTick();expect(textOf(root)).toContain('本次未返回候选明细');expect(textOf(root)).toContain('未列出筛除统计项目');
    data.screening.candidates=null;data.screening.rejectedStats=null;await nextTick();expect(textOf(root)).toContain('候选明细：未提供');expect(textOf(root)).toContain('筛除统计：未提供');
  });
});

