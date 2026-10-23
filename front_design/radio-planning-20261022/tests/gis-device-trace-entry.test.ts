import { readFileSync } from 'node:fs';
import { afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { h,nextTick,ssrContextKey,type App } from 'vue';
import { createPinia,disposePinia,setActivePinia } from 'pinia';
import GisObjectInfoPanel from '../src/components/GisObjectInfoPanel.vue';
import ObjectInfoPanel from '../src/components/ObjectInfoPanel.vue';
import { useAuthStore } from '../src/stores/auth';
import { initialResources } from '../src/mocks/resource-presets';
import type { Permission } from '../src/config/permissions';
import type { ResourceObjectDetail,ReadNode } from '../src/types/resource-read';
import { all,clientTemplate,node,renderer,textOf } from './helpers/vue-client';

const probe=vi.hoisted(()=>({mode:'http',children:[] as Record<string,unknown>[],candidate:{device_id:'D1'}}));
vi.mock('../src/config/env',async load=>{const actual=await load<typeof import('../src/config/env')>();return {...actual,env:{...actual.env,get mode(){return probe.mode;}}};});
vi.mock('../src/services',()=>({previewService:{getResourceObject:vi.fn(()=>new Promise(()=>{}))}}));
// 子设备详情由P06单测覆盖；这里检查实际两层包装的服务和事件透传。
vi.mock('../src/components/DeviceInfoPanel.vue',async()=>{
  const {defineComponent,h}=await import('vue');
  return {default:defineComponent({props:['device','traceServices','maintenanceBinding'],emits:['restore-candidate'],setup(props,{emit,slots}){probe.children.push(props);return()=>h('div',[h('button',{'aria-label':'提交追溯候选',onClick:()=>emit('restore-candidate',probe.candidate)},'候选'),slots.actions?.()]);}})};
});
vi.mock('../src/components/StatusBadge.vue',()=>({default:{render:()=>null}}));
let pinia:ReturnType<typeof createPinia>,app:App|undefined;
beforeAll(async()=>{
  await clientTemplate(ObjectInfoPanel,'src/components/ObjectInfoPanel.vue','object-info-render.ts');
  await clientTemplate(GisObjectInfoPanel,'src/components/GisObjectInfoPanel.vue','gis-object-info-render.ts');
});
beforeEach(()=>{
  class TestDocument { activeElement=null; }
  vi.stubGlobal('Document',TestDocument);vi.stubGlobal('document',new TestDocument());vi.stubGlobal('ShadowRoot',class {});
  pinia=createPinia();setActivePinia(pinia);probe.mode='http';probe.children=[];
});
afterEach(()=>{app?.unmount();app=undefined;disposePinia(pinia);vi.restoreAllMocks();vi.unstubAllGlobals();});
const specific:Permission[]=['situation.view','resources.view','resources.workspace.edit','resources.create','resources.device.edit'];
async function mount(paged=false,withNode=false,permissions=specific) {
  const auth=useAuthStore();auth.accept({id:'editor',sessionId:'session',username:'editor',name:'编辑者',roleId:'editor',roleName:'编辑者',epoch:'e1',revision:'r1',permissions});
  const resources=initialResources(),device=resources.devices[0],station=resources.stations.find(row=>row.id===device.stationId)!;
  const readNode:ReadNode={...station,kind:'node',childCount:0,deviceCount:1};
  const detail:ResourceObjectDetail={revision:'resource-current',object:{...device,kind:'device',stationName:station.name,stationCoordinate:station.coordinate,modelName:'型号',deviceClass:'HF',antennaName:'天线'},model:resources.models.find(row=>row.id===device.modelId)!,antenna:null,node:withNode?readNode:null};
  const client={queryHistory:vi.fn(),getOperation:vi.fn(),previewRestore:vi.fn()},restore=vi.fn(),root=node('root');
  app=renderer.createApp({render:()=>h(GisObjectInfoPanel,{paged,station,resources,references:resources,detail:paged?detail:undefined,selectedDeviceId:device.id,editable:true,traceServices:client,maintenanceBinding:{context:'gis',revision:'resource-current',editable:true},'onRestore-candidate':restore})});
  app.use(pinia);app.provide(ssrContextKey,{});app.mount(root);await nextTick();return {root,client,restore,auth};
}
describe('GIS设备追溯与专项操作',()=>{
  it.each([[false,false],[true,false],[true,true]])('paged=%s node=%s传同一追溯客户端并透传原候选',async(paged,withNode)=>{
    const f=await mount(paged,withNode),child=probe.children.at(-1)!;
    expect(child.traceServices).toBe(f.client);expect(child.maintenanceBinding).toMatchObject({context:'gis',revision:'resource-current'});
    const button=all(f.root,row=>row.props['aria-label']==='提交追溯候选')[0];
    (button.props.onClick as ()=>void)();expect(f.restore).toHaveBeenCalledWith(probe.candidate);
    expect(f.client.previewRestore).not.toHaveBeenCalled();
  });
  it('没有宽resources.edit时仍按专项权限展示已授权操作，撤销后隐藏',async()=>{
    const f=await mount();expect(specific).not.toContain('resources.edit');
    expect(textOf(f.root)).toContain('编辑节点');expect(textOf(f.root)).toContain('添加设备');expect(textOf(f.root)).toContain('编辑设备参数');
    f.auth.accept({...f.auth.identity!,permissions:['situation.view','resources.view','resources.workspace.edit']});await nextTick();
    expect(textOf(f.root)).toContain('编辑节点');expect(textOf(f.root)).not.toContain('添加设备');expect(textOf(f.root)).not.toContain('编辑设备参数');
    f.auth.accept({...f.auth.identity!,permissions:['situation.view','resources.view','resources.edit']});await nextTick();
    expect(textOf(f.root)).not.toContain('编辑节点');expect(textOf(f.root)).not.toContain('编辑设备参数');
  });
  it('Mock保留原宽权限，不为HTTP专项授权扩大Mock能力',async()=>{
    probe.mode='mock';const f=await mount(false,false,['situation.view','resources.view','resources.edit']);
    expect(textOf(f.root)).toContain('编辑节点');expect(textOf(f.root)).toContain('添加设备');expect(textOf(f.root)).toContain('编辑设备参数');
  });
  it('Situation宿主只接唯一客户端和受保护候选，不把候选当保存成功',()=>{
    const source=readFileSync(new URL('../src/views/SituationView.vue',import.meta.url),'utf8');
    expect(source).toContain(':trace-services="httpMode ? collaborationHttp.deviceTraces : undefined"');
    expect(source).toContain('@restore-candidate="restoreCandidateAction"');
    expect(source).toContain('loadGisRestoreCandidate(value');expect(source).toContain('请核对后应用草稿并保存资源');
    const action=source.slice(source.indexOf('const restoreCandidateAction='),source.indexOf('async function openConfiguration'));
    expect(action).toContain("auth.can('resources.device.edit')");expect(action).toContain('session===auth.generation');
    expect(action).not.toContain('applyForm(');expect(action).not.toContain('commitResources');expect(action).not.toContain('.save(');
  });
});
