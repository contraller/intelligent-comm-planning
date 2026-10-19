import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { createRenderer, h, nextTick, ssrContextKey, type App } from 'vue';
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc';
import { transformWithEsbuild } from 'vite';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import SituationView from '../src/views/SituationView.vue';
import GisResourceTree from '../src/components/GisResourceTree.vue';
import CandidateLinkPanel from '../src/components/CandidateLinkPanel.vue';
import ResourceEditDrawer from '../src/components/ResourceEditDrawer.vue';
import ResourceImportDrawer from '../src/components/ResourceImportDrawer.vue';
import ResourceExportDrawer from '../src/components/ResourceExportDrawer.vue';
import { previewService } from '../src/services';
import { createMockService } from '../src/services/mock';
import { usePreviewStore } from '../src/stores/preview';
import { useGisWorkspaceStore } from '../src/stores/gis-workspace';
import { useResourceEditStore } from '../src/stores/resource-edit';
import { useMonitoringStore } from '../src/stores/monitoring';
import type { CandidateLink } from '../src/types/candidate-link';
import type { NetworkLink } from '../src/types/domain';
import { authorizeStore } from './helpers/auth';
import { settleMonitoring } from './helpers/monitoring';
import { TestStorage } from './helpers/storage';

// 替换浏览器画布、浮层容器及无关业务组件，候选页面、表单与文件入口执行真实组件。
const mapCalls=vi.hoisted(()=>({locateCandidate:vi.fn()}));
vi.mock('../src/components/MapCanvas.vue',async()=>{
  const {defineComponent,h}=await import('vue');
  return {default:defineComponent({inheritAttrs:false,
    props:['stations','links','candidateLinks','candidateWorkset','candidateStations','selectedCandidateLinkId','showCandidates','showLinks','topologyOpacity','regions','onSelectCandidateLink'],
    setup(props,{expose}){expose({locate:()=>{},locateCandidate:mapCalls.locateCandidate});return()=>h('map-probe',{...props});},
  })};
});
vi.mock('../src/components/AppDrawer.vue',async()=>{
  const {defineComponent,h}=await import('vue');
  return {default:defineComponent({inheritAttrs:false,props:['visible','title','subtitle'],
    render(){return this.visible?h('drawer-probe',{title:this.title},[h('h3',this.title),this.$slots.default?.(),this.$slots.footer?.()]):null;},
  })};
});
vi.mock('../src/components/ObjectInfoPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceAnalysisPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/SituationMonitoringDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/MonitoringObjectPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/TaskWorkspacePanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceHistoryDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceMeasureDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/InterferenceSourceDrawer.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DecisionDialog.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/StatusBadge.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisDeviceLayerPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/GisResultLayerPanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));
vi.mock('../src/components/DeviceCoveragePanel.vue',()=>({default:{inheritAttrs:false,render:()=>null}}));

for(const [component,filename] of [[SituationView,'src/views/SituationView.vue'],[GisResourceTree,'src/components/GisResourceTree.vue'],
  [CandidateLinkPanel,'src/components/CandidateLinkPanel.vue'],[ResourceEditDrawer,'src/components/ResourceEditDrawer.vue'],
  [ResourceImportDrawer,'src/components/ResourceImportDrawer.vue'],[ResourceExportDrawer,'src/components/ResourceExportDrawer.vue']] as const){
  const descriptor=parse(readFileSync(filename,'utf8'),{filename}).descriptor,bindings=compileScript(descriptor,{id:filename}).bindings;
  const compiled=compileTemplate({source:descriptor.template!.content,filename,id:filename,compilerOptions:{mode:'function',bindingMetadata:bindings}});
  if(compiled.errors.length)throw new Error(compiled.errors.map(String).join('\n'));
  const rendered=await transformWithEsbuild(`function createRender(Vue) { ${compiled.code} }`,'candidate-entry-render.ts',{loader:'ts'});
  (component as Vue.ComponentOptions).render=new Function('Vue',rendered.code+';return createRender(Vue);')(Vue);
}

interface HostNode {
  tag:string;tagName:string;text:string;parent:HostNode|null;children:HostNode[];props:Record<string,unknown>;style:Record<string,string>;
  value?:unknown;selected?:boolean;selectedIndex?:number;multiple?:boolean;options:HostNode[];listeners:Record<string,Function>;
  addEventListener:(event:string,handler:Function)=>void;removeEventListener:()=>void;getRootNode:()=>Document;
}
function node(tag:string,text=''):HostNode {
  const entry:HostNode={tag,tagName:tag.toUpperCase(),text,parent:null,children:[],props:{},style:{},listeners:{},
    get options(){return this.children.filter(child=>child.tag==='option');},
    addEventListener(event,handler){this.listeners[event]=handler;},removeEventListener:()=>{},getRootNode:()=>document};
  return entry;
}
function remove(child:HostNode){if(child.parent)child.parent.children.splice(child.parent.children.indexOf(child),1);child.parent=null;}
function insert(child:HostNode,parent:HostNode,anchor?:HostNode|null){remove(child);child.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;parent.children.splice(index<0?parent.children.length:index,0,child);}
const renderer=createRenderer<HostNode,HostNode>({insert,remove,createElement:tag=>node(tag),createText:text=>node('#text',text),createComment:text=>node('#comment',text),
  setText:(el,text)=>{el.text=text;},setElementText:(el,text)=>{el.text=text;el.children=[];},parentNode:el=>el.parent,
  nextSibling:el=>el.parent?.children[el.parent.children.indexOf(el)+1]??null,
  patchProp:(el,key,_old,value)=>{el.props[key]=value;if(key==='value')el.value=value;},
  insertStaticContent:(text,parent,anchor)=>{const el=node('#static',text);insert(el,parent,anchor);return[el,el];},
});
const textOf=(root:HostNode):string=>root.text+root.children.map(textOf).join('');
function find(root:HostNode,predicate:(entry:HostNode)=>boolean):HostNode|undefined{if(predicate(root))return root;for(const child of root.children){const match=find(child,predicate);if(match)return match;}}
function all(root:HostNode,predicate:(entry:HostNode)=>boolean):HostNode[]{return[...(predicate(root)?[root]:[]),...root.children.flatMap(child=>all(child,predicate))];}
const control=(root:HostNode,label:string)=>find(root,row=>row.props['aria-label']===label)!;
const button=(root:HostNode,label:string)=>find(root,row=>row.tag==='button'&&textOf(row).trim()===label)!;
async function click(root:HostNode,label:string){const entry=button(root,label);expect(entry,`按钮 ${label}`).toBeDefined();await(entry.props.onClick as Function)();await settleMonitoring();}
async function selectCandidate(root:HostNode,id:string){await(control(root,'选择候选链路 '+id).props.onClick as Function)();await settleMonitoring();}
async function search(root:HostNode,value:string){(control(root,'搜索资源').props.onInput as Function)({target:{value}});await nextTick();}
async function model(entry:HostNode,value:string){expect(entry).toBeDefined();(entry.props['onUpdate:modelValue'] as Function)(value);await nextTick();}
const selectByLabel=(root:HostNode,label:string)=>find(root,row=>row.tag==='select'&&textOf(row.parent!).startsWith(label))!;
const candidateSwitch=(root:HostNode)=>find(root,row=>row.tag==='input'&&textOf(row.parent!).includes('候选链路（独立数据）'))!;

let app:App<HostNode>|undefined,pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();mapCalls.locateCandidate.mockClear();});
async function mountEntry(url='/situation?stationId=ND-0001'){
  vi.useFakeTimers();vi.stubGlobal('window',new EventTarget());
  class TestDocument extends EventTarget{hidden=false;activeElement=null;createElement(){return {click:()=>{}};}}
  vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());
  pinia=createPinia();setActivePinia(pinia);
  const storage=new TestStorage(),raw=createMockService(()=>storage),target=previewService as unknown as Record<string,(...args:any[])=>Promise<any>>;
  for(const [name,method]of Object.entries(raw))if(typeof method==='function')vi.spyOn(target,name).mockImplementation(method);
  const auth=authorizeStore();await usePreviewStore().load();
  const gis=useGisWorkspaceStore(),editor=useResourceEditStore(),router=createRouter({history:createMemoryHistory(),routes:[
    {path:'/situation',component:SituationView},{path:'/planning',component:{render:()=>null}},
  ]});
  app=renderer.createApp({render:()=>h('entry-root',[h(RouterView),h(ResourceEditDrawer),h(ResourceImportDrawer)])});app.use(pinia);app.use(router);app.provide(ssrContextKey,{});
  await router.push(url);await router.isReady();const root=node('root');app.mount(root);await settleMonitoring();
  return{root,auth,editor,gis,router,raw,storage,monitor:useMonitoringStore(),map:()=>find(root,row=>row.tag==='map-probe')!.props};
}

describe('GIS 候选维护真实页面入口',()=>{
  it('500 条候选默认隐藏，目录选择仍展示来源及定位端点，检索与地图范围一致',async()=>{
    const s=await mountEntry();expect(s.map().candidateWorkset).toHaveLength(500);expect(s.map().showCandidates).toBe(false);
    expect(s.map().links).toHaveLength(7);expect(all(s.root,row=>String(row.props['aria-label']).startsWith('选择候选链路 '))).toHaveLength(500);
    await search(s.root,'LK-0001');expect((s.map().candidateWorkset as CandidateLink[]).map(row=>row.id)).toEqual(['LK-0001']);
    await selectCandidate(s.root,'LK-0001');expect(s.map().selectedCandidateLinkId).toBe('LK-0001');expect(s.map().showCandidates).toBe(false);
    expect(control(s.root,'GIS 候选链路详情')).toBeDefined();expect(textOf(s.root)).toContain('来源样例／非当前评估');expect(textOf(s.root)).toContain('当前候选因筛选或图层关闭而不可见');
    expect(mapCalls.locateCandidate).toHaveBeenCalledWith(expect.objectContaining({id:'LK-0001',nodeAId:expect.any(String),nodeBId:expect.any(String)}));
    expect(s.storage.writes).toBe(0);
  });

  it('候选配置应用和撤销不隐藏正式网络，表单没有业务评估输入或地图取点',async()=>{
    const s=await mountEntry();await selectCandidate(s.root,'LK-0001');await click(s.root,'编辑');await click(s.root,'编辑候选链路');
    expect(s.editor.form?.kind).toBe('candidate');expect(Object.keys(s.editor.form!.fields)).toEqual(['nodeAId','nodeBId','deviceAId','deviceBId','deviceClass','freqKhz','bandwidthKhz','isBackup']);
    expect(button(s.root,'在地图上重新取点')).toBeUndefined();expect(find(s.root,row=>row.props.id==='resource-distanceM')).toBeUndefined();
    await model(find(s.root,row=>row.props.id==='resource-bandwidthKhz')!,'1');
    const form=find(s.root,row=>row.tag==='form'&&row.props.class==='edit-fields')!;
    await(form.props.onSubmit as Function)({preventDefault(){}});await settleMonitoring();
    expect(s.editor.draftDirty).toBe(true);expect(s.map().links).toHaveLength(7);expect(textOf(s.root)).not.toContain('旧链路和区域图层已隐藏');
    expect(s.editor.resources.candidateLinks![0].assessmentState).toBe('REFERENCE');expect(textOf(s.root)).toContain('尚未保存，结果以服务返回为准');
    await click(s.root,'撤销');expect(s.editor.draftDirty).toBe(false);expect(s.map().links).toHaveLength(7);expect(s.storage.writes).toBe(0);
    await click(s.root,'新建候选链路');expect(s.editor.form).toMatchObject({kind:'candidate',creating:true});expect(s.editor.picking).toBe(false);
  });

  it('正式透明度与候选开关独立，隐藏地图回调不选择，切换快照后旧回调无效',async()=>{
    const s=await mountEntry();await click(s.root,'图层管理');
    (candidateSwitch(s.root).props.onChange as Function)({target:{checked:true}});await nextTick();
    (control(s.root,'拓扑透明度').props.onInput as Function)({target:{value:'0'}});await nextTick();
    expect(s.map()).toMatchObject({showCandidates:true,topologyOpacity:0});expect(s.map().candidateWorkset).toHaveLength(500);
    const stale=s.map().onSelectCandidateLink as Function;await stale('LK-0001');await settleMonitoring();expect(s.map().selectedCandidateLinkId).toBe('LK-0001');
    (candidateSwitch(s.root).props.onChange as Function)({target:{checked:false}});await nextTick();
    await(s.map().onSelectCandidateLink as Function)('LK-0002');expect(s.map().selectedCandidateLinkId).toBe('LK-0001');
    s.monitor.showNetwork();await settleMonitoring();expect(s.gis.mapMode).toBe('monitoring');expect(s.map().candidateWorkset).toEqual([]);
    await stale('LK-0002');await settleMonitoring();expect(s.gis.mapMode).toBe('monitoring');expect(s.map().selectedCandidateLinkId).toBe('');
    await click(s.root,'资源视图');expect(s.map().selectedCandidateLinkId).toBe('LK-0001');expect(s.map().showCandidates).toBe(false);expect(s.storage.writes).toBe(0);
  });

  it('候选旧点击失权后不能打开表单或改变选中对象',async()=>{
    const s=await mountEntry();await click(s.root,'编辑');await selectCandidate(s.root,'LK-0001');
    await click(s.root,'图层管理');(candidateSwitch(s.root).props.onChange as Function)({target:{checked:true}});await nextTick();
    const stale=s.map().onSelectCandidateLink as Function,create=button(s.root,'新建候选链路').props.onClick as Function;
    const identity={...s.auth.identity!};s.auth.accept({...identity,permissions:identity.permissions.filter(p=>p!=='situation.view')});await settleMonitoring();
    await stale('LK-0002');await create();await settleMonitoring();expect(s.editor.form).toBeNull();expect(s.map().selectedCandidateLinkId).toBe('LK-0001');expect(s.map().candidateWorkset).toEqual([]);expect(s.storage.writes).toBe(0);
    s.auth.accept(identity);await settleMonitoring();await stale('LK-0002');await create();await settleMonitoring();
    expect(s.editor.form).toBeNull();expect(s.map().selectedCandidateLinkId).toBe('LK-0001');
  });

  it('新建等待草稿确认期间切到快照，不在新视图打开候选表单',async()=>{
    const s=await mountEntry();await click(s.root,'编辑');await selectCandidate(s.root,'LK-0001');await click(s.root,'编辑候选链路');
    await model(find(s.root,row=>row.props.id==='resource-bandwidthKhz')!,'1');
    const pending=(button(s.root,'新建候选链路').props.onClick as Function)();await settleMonitoring();expect(s.editor.decision).not.toBeNull();
    s.monitor.showNetwork();await settleMonitoring();s.editor.answer('discard');await pending;await settleMonitoring();
    expect(s.gis.mapMode).toBe('monitoring');expect(s.editor.form).toMatchObject({kind:'candidate',id:'LK-0001'});expect(s.editor.form?.creating).not.toBe(true);expect(s.editor.picking).toBe(false);expect(s.storage.writes).toBe(0);
  });

  it('候选选中导出自动使用专用文件和独立范围，原三表仍可切回',async()=>{
    const s=await mountEntry();await selectCandidate(s.root,'LK-0001');await click(s.root,'导出已保存资源');
    const content=selectByLabel(s.root,'导出内容');expect(content.options[content.selectedIndex??-1]?.value).toBe('candidates');
    expect(textOf(s.root)).toContain('候选链路：1 条');expect(textOf(s.root)).toContain('待评估字段留空');
    // 文件字节由文件往返测试验证；此处只观察真实控件形成的服务请求及下载入口。
    const exportSpy=vi.mocked(previewService.exportResources).mockResolvedValue({name:'candidate.xlsx',mime:'application/octet-stream',bytes:new Uint8Array([1])});vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:test-candidate');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
    await click(s.root,'下载文件');expect(exportSpy).toHaveBeenLastCalledWith({format:'xlsx',kinds:['topology_links'],context:'gis',ids:{topology_links:['LK-0001']}});
    await model(selectByLabel(s.root,'导出内容'),'resources');await click(s.root,'下载文件');
    expect(exportSpy).toHaveBeenLastCalledWith({format:'xlsx',kinds:['nodes','devices','interference_sources'],context:'gis'});
    expect(s.storage.writes).toBe(0);
  });

  it('真实导入抽屉显示候选模板、非阻断提示和应用草稿语义，台账不提供候选选项',async()=>{
    const s=await mountEntry();await click(s.root,'编辑');await click(s.root,'导入资源');
    expect(find(s.root,row=>row.tag==='option'&&row.props.value==='topology_links')).toBeDefined();
    await model(selectByLabel(s.root,'导入资源类型'),'topology_links');expect(button(s.root,'XLSX 候选模板')).toBeDefined();expect(textOf(s.root)).toContain('结果来自文件，页面不计算');
    const file=await s.raw.exportResources({format:'csv',kinds:['topology_links'],context:'gis',ids:{topology_links:['LK-0001']}});
    await s.editor.previewImport(file);await nextTick();expect(s.editor.importPreview?.issues).toEqual([]);expect(textOf(s.root)).toContain('来源提示');
    await click(s.root,'确认应用到草稿');expect(s.editor.draftDirty).toBe(true);expect(s.storage.writes).toBe(0);expect((s.map().links as NetworkLink[])).toHaveLength(7);
    s.editor.clearSession();await s.editor.openImport('ledger');await nextTick();
    expect(find(s.root,row=>row.tag==='option'&&row.props.value==='topology_links')).toBeUndefined();expect(button(s.root,'XLSX 三表模板')).toBeDefined();
  });
});
