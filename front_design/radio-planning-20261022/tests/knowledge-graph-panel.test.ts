import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, h, nextTick, ref, ssrContextKey, toRaw, type App, type ComponentPublicInstance } from 'vue';
import KnowledgeGraphPanel from '../src/components/KnowledgeGraphPanel.vue';
import { initialKnowledgeWorkspace, knowledgeRelationTypes, knowledgeTypes } from '../src/mocks/knowledge-presets';
import { queryKnowledgeSnapshot } from '../src/services/knowledge-query';
import type { KnowledgeCatalog, KnowledgeGraph } from '../src/types/knowledge';
import { clientTemplate, node, type HostNode } from './helpers/vue-client';

// 运行实际模板与组件生命周期，只替换绘制和尺寸观察，不依赖浏览器 canvas。
const probe=vi.hoisted(()=>({init:vi.fn()}));
vi.mock('echarts/core',()=>({init:probe.init,use:vi.fn()}));
let width=600,height=425;
interface SizedHost extends HostNode { clientWidth:number; clientHeight:number }
const sized=(tag:string,text=''):HostNode=>Object.assign(node(tag,text),{clientWidth:width,clientHeight:height});
function detach(child:HostNode) { if(child.parent) child.parent.children.splice(child.parent.children.indexOf(child),1);child.parent=null; }
const renderer=createRenderer<HostNode,HostNode>({
  insert(child,parent,anchor){ detach(child);child.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,child); },
  remove:detach,
  createElement:sized,createText:text=>sized('#text',text),createComment:text=>sized('#comment',text),
  setText(target,text){target.text=text;},setElementText(target,text){target.text=text;target.children=[];},
  parentNode:target=>target.parent,nextSibling:target=>target.parent?.children[target.parent.children.indexOf(target)+1]??null,
  patchProp(target,key,_before,value){target.props[key]=value;},
  insertStaticContent(text,parent,anchor){const child=sized('#static',text);child.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,child);return [child,child];},
});
type GraphClick=(event:{data:{id:string};dataType:'node'|'edge'})=>void;
const charts:{host:SizedHost;setOption:ReturnType<typeof vi.fn>;resize:ReturnType<typeof vi.fn>;on:ReturnType<typeof vi.fn<(name:string,handler:GraphClick)=>void>>;dispose:ReturnType<typeof vi.fn>}[]=[];
const observers:{notify:()=>void;disconnect:ReturnType<typeof vi.fn<()=>void>>}[]=[];
const apps:App[]=[];
const panel=ref<ComponentPublicInstance&{resetView:()=>void}>();
function graph():KnowledgeGraph {
  const w=initialKnowledgeWorkspace(),base=queryKnowledgeSnapshot(w,{versionId:w.currentVersionId,categories:['设备知识']});
  const entities=Array.from({length:100},(_,i)=>({...base.entities[0],id:`node-${i}`}));
  return {...base,entities,relations:[{...base.relations[0],id:'relation-1',head:'node-0',tail:'node-1'}],totalNodes:100,totalEdges:1};
}
const catalog:KnowledgeCatalog={types:knowledgeTypes,relationTypes:knowledgeRelationTypes,actors:[],models:[]};
async function mount(value=ref(graph()),selected=ref(''),entity=vi.fn(),relation=vi.fn()) {
  const root=sized('root'),app=renderer.createApp({render:()=>h(KnowledgeGraphPanel,{ref:panel,graph:value.value,selectedId:selected.value,catalog,onEntity:entity,onRelation:relation})});
  apps.push(app);app.provide(ssrContextKey,{});app.mount(root);await nextTick();return {root,value,selected,entity,relation};
}
beforeAll(()=>clientTemplate(KnowledgeGraphPanel,'src/components/KnowledgeGraphPanel.vue','knowledge-panel-render.ts'));
beforeEach(()=>{
  width=600;height=425;
  class TestDocument { activeElement=null; }
  vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class {});
  vi.stubGlobal('ResizeObserver',class {
    entry:typeof observers[number];
    constructor(notify:()=>void){this.entry={notify,disconnect:vi.fn<()=>void>()};observers.push(this.entry);}
    observe(){} disconnect(){this.entry.disconnect();}
  });
  probe.init.mockImplementation((host:SizedHost)=>{const chart={host,setOption:vi.fn(),resize:vi.fn(),on:vi.fn<(name:string,handler:GraphClick)=>void>(),dispose:vi.fn()};charts.push(chart);return chart;});
});
afterEach(()=>{apps.splice(0).forEach(app=>app.unmount());charts.splice(0);observers.splice(0);vi.clearAllMocks();vi.unstubAllGlobals();});

describe('知识画布视口与生命周期',()=>{
  it('100节点按实际视口缩小；尺寸更新不重置缩放/中心，显式重置才重设',async()=>{
    await mount();const chart=charts[0];
    const first=chart.setOption.mock.calls[0][0].series[0];
    expect(first.data).toHaveLength(100);expect(first.data[0].symbolSize).toBeLessThan(24);
    expect(first.links[0]).toMatchObject({id:'relation-1',source:'node-0',target:'node-1'});
    chart.host.clientWidth=326;observers[0].notify();
    const patch=chart.setOption.mock.lastCall![0].series[0];
    expect(patch.data[0].symbolSize).toBeLessThan(first.data[0].symbolSize);
    expect(patch).not.toHaveProperty('zoom');expect(patch).not.toHaveProperty('center');
    expect(chart.setOption.mock.lastCall).toHaveLength(1);expect(chart.resize).toHaveBeenCalledOnce();
    panel.value!.resetView();expect(chart.setOption.mock.lastCall![1]).toBe(true);
    expect(chart.setOption.mock.lastCall![0].series[0].zoom).toBe(1);
  });
  it.each(['width','height'])('零%s不初始化，显示后采用最新图，重复观察不新建实例',async dimension=>{
    if(dimension==='width') width=0;else height=0;
    const mounted=await mount();mounted.value.value={...mounted.value.value,totalNodes:120};await nextTick();
    expect(probe.init).not.toHaveBeenCalled();
    const find=(row:HostNode):SizedHost|undefined=>row.props.role==='img'?row as SizedHost:row.children.map(find).find(Boolean);
    const host=find(mounted.root)!;host.clientWidth=600;host.clientHeight=425;
    observers[0].notify();observers[0].notify();
    expect(probe.init).toHaveBeenCalledOnce();expect(charts[0].setOption.mock.calls[0][0].series[0].data).toHaveLength(100);
  });
  it('隐藏时不绘制，重开渲染最新选中；卸载后不响应迟到观察和属性变化',async()=>{
    const mounted=await mount(),chart=charts[0];chart.host.clientWidth=0;
    mounted.selected.value='node-1';await nextTick();observers[0].notify();
    expect(chart.setOption).toHaveBeenCalledOnce();expect(chart.resize).not.toHaveBeenCalled();
    chart.host.clientWidth=326;observers[0].notify();
    expect(chart.setOption.mock.lastCall![0].series[0].center).toEqual([450,300]);
    apps.pop()!.unmount();observers[0].notify();mounted.selected.value='node-2';await nextTick();
    expect(chart.setOption).toHaveBeenCalledTimes(2);expect(chart.dispose).toHaveBeenCalledOnce();expect(observers[0].disconnect).toHaveBeenCalledOnce();
  });
  it('实体/关系点击保留真实ID，图内容未变不重画',async()=>{
    const mounted=await mount(),chart=charts[0],click=chart.on.mock.calls[0][1];
    click({data:{id:'node-1'},dataType:'node'});click({data:{id:'relation-1'},dataType:'edge'});
    expect(mounted.entity).toHaveBeenCalledWith('node-1');expect(mounted.relation).toHaveBeenCalledWith('relation-1');
    mounted.value.value=structuredClone(toRaw(mounted.value.value));await nextTick();expect(chart.setOption).toHaveBeenCalledOnce();
  });
});
