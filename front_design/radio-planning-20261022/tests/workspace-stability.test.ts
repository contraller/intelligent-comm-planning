import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, ssrContextKey, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { clientTemplate, renderer, node, find } from './helpers/vue-client';
import ChartCanvas from '../src/components/ChartCanvas.vue';
import MapCanvas from '../src/components/MapCanvas.vue';

const probes=vi.hoisted(()=>({charts:[] as {resize:ReturnType<typeof vi.fn>;dispose:ReturnType<typeof vi.fn>}[],maps:[] as {updateSize:ReturnType<typeof vi.fn>}[]}));
vi.mock('echarts/core',()=>({use:()=>{},init:()=>{const chart={resize:vi.fn(),dispose:vi.fn(),setOption:vi.fn(),on:vi.fn()};probes.charts.push(chart);return chart;}}));
vi.mock('echarts/charts',()=>({GraphChart:{},BarChart:{},LineChart:{},PieChart:{}}));
vi.mock('echarts/components',()=>({TooltipComponent:{},GridComponent:{},LegendComponent:{},MarkAreaComponent:{}}));
vi.mock('echarts/renderers',()=>({CanvasRenderer:{}}));
vi.mock('ol/Map',()=>({default:class{
  view:any;updateSize=vi.fn();
  constructor(options:any){this.view=options.view;vi.spyOn(this.view,'fit').mockImplementation(()=>{});probes.maps.push(this);}
  getView(){return this.view;}getSize(){return[960,640];}setLayers(){}on(){}dispose(){}forEachFeatureAtPixel(){}
}}));
vi.mock('ol/control',()=>({defaults:()=>({extend:()=>[]}),ScaleLine:class{}}));
await clientTemplate(ChartCanvas,'src/components/ChartCanvas.vue','stable-chart.ts');
await clientTemplate(MapCanvas,'src/components/MapCanvas.vue','stable-map.ts');
let app:App|undefined,pinia:ReturnType<typeof createPinia>|undefined;
let observers:(()=>void)[]=[],frames=new Map<number,FrameRequestCallback>(),serial=0;
function prepare(){
  vi.stubGlobal('window',Object.assign(new EventTarget(),{matchMedia:()=>Object.assign(new EventTarget(),{matches:true})}));
  vi.stubGlobal('document',Object.assign(new EventTarget(),{hidden:false}));
  vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){observers.push(callback);}observe(){}disconnect(){}});
  vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.set(++serial,callback);return serial;});
  vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id));
  vi.stubGlobal('Image',class{addEventListener(){}removeEventListener(){}});
  pinia=createPinia();setActivePinia(pinia);
}
function flush(){const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn(0));}
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;observers=[];frames.clear();probes.charts=[];probes.maps=[];vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('尺寸回调稳定性（内存宿主，非浏览器布局验收）',()=>{
  it.each(['chart','map'])('%s 的同尺寸通知不反复写入，变更合并一帧且卸载取消',async kind=>{
    prepare();app=renderer.createApp({render:()=>kind==='chart'?h(ChartCanvas,{option:{}}):h(MapCanvas,{stations:[],showRoads:false})});
    app.use(pinia!);app.provide(ssrContextKey,{});const root=node('root');app.mount(root);await nextTick();
    const host=find(root,n=>typeof n.props.class==='string'&&(n.props.class==='chart-canvas'||n.props.class==='map-host'))!;
    let width=960,height=640;Object.defineProperties(host,{clientWidth:{get:()=>width},clientHeight:{get:()=>height}});
    const resize=kind==='chart'?probes.charts[0].resize:probes.maps[0].updateSize;
    const notify=observers[0];notify();notify();expect(frames.size).toBe(1);flush();expect(resize).toHaveBeenCalledTimes(1);
    notify();flush();expect(resize).toHaveBeenCalledTimes(1);
    width=800;notify();height=500;notify();expect(frames.size).toBe(1);flush();expect(resize).toHaveBeenCalledTimes(2);
    width=700;notify();app.unmount();app=undefined;expect(frames.size).toBe(0);flush();expect(resize).toHaveBeenCalledTimes(2);
  });
  it('公共滚动锚点与画布高度边界在源码中保持隔离',()=>{
    const shell=readFileSync('src/layouts/AppShell.vue','utf8'),network=readFileSync('src/components/DiagnosisNetworkPanel.vue','utf8'),planning=readFileSync('src/views/PlanningApiView.vue','utf8');
    expect(shell).toContain('overflow-anchor: none');expect(shell).toContain('scrollbar-gutter: stable');
    expect(network).toContain('flex: 1 1 0');expect(network).toContain('position: absolute');expect(planning).toContain('.map-panel > :deep(.map-wrap)');
  });
});
