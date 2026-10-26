import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ssrContextKey, type App, type VNodeChild } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import DiagnosisFeedbackDrawer from '../src/components/DiagnosisFeedbackDrawer.vue';
import { useAuthStore } from '../src/stores/auth';
import { all, clientTemplate, node, renderer, textOf, type HostNode } from './helpers/vue-client';
import type { DiagnosisResult } from '../src/types/diagnosis';

const hooks=vi.hoisted(()=>({guards:[] as (()=>Promise<boolean>|boolean)[],ask:vi.fn(),submit:vi.fn()}));
vi.mock('vue-router',()=>({onBeforeRouteLeave:(guard:()=>Promise<boolean>|boolean)=>hooks.guards.push(guard)}));
vi.mock('../src/services',()=>({previewService:{loadDiagnosisContext:vi.fn(async()=>({revision:'SR5-1'})),submitDiagnosisFeedback:(...args:unknown[])=>hooks.submit(...args)}}));
vi.mock('../src/stores/diagnosis',()=>({useDiagnosisStore:()=>({ask:hooks.ask,workspace:null})}));
vi.mock('../src/components/AppDrawer.vue',()=>({default:{props:['visible'],setup(props:{visible:boolean},{slots}:{slots:Record<string,()=>VNodeChild>}){return()=>props.visible?h('section',{},[slots.default?.(),slots.footer?.()]):null;}}}));
let app:App|undefined,pinia:ReturnType<typeof createPinia>,listener:EventListener|undefined;
beforeAll(()=>clientTemplate(DiagnosisFeedbackDrawer,'src/components/DiagnosisFeedbackDrawer.vue','diagnosis-feedback-render.ts'));
beforeEach(()=>{
  hooks.guards.length=0;hooks.ask.mockReset();hooks.submit.mockReset();listener=undefined;
  vi.stubGlobal('Document',class {});vi.stubGlobal('document',{activeElement:null});vi.stubGlobal('ShadowRoot',class {});
  vi.stubGlobal('window',{addEventListener:(name:string,callback:EventListener)=>{if(name==='beforeunload')listener=callback;},removeEventListener:(name:string)=>{if(name==='beforeunload')listener=undefined;}});
  pinia=createPinia();setActivePinia(pinia);useAuthStore().accept({id:'editor',sessionId:'session',username:'editor',name:'编辑者',roleId:'r',roleName:'r',epoch:'e',revision:'r',permissions:['diagnosis.view','knowledge.edit']});
});
afterEach(()=>{app?.unmount();app=undefined;disposePinia(pinia);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function settle(){for(let i=0;i<8;i++){await Promise.resolve();await nextTick();}}
async function fixture(){
  const result:DiagnosisResult={fusionMode:'TWO_WAY_DEGRADED',disabledReason:'构造资料非ML',conclusions:[{fault:{objectType:'DEVICE',objectId:'D1',faultType:'HW_FAILURE',symptomIds:['S1'],occurTime:null,interferenceId:null},label:'构造结论',faultType:'HW_FAILURE',confidence:0.5,rootCause:'构造根因',component:null,needManualReview:true,branches:[],candidates:[],chain:[]}],nodes:[],links:[],regions:[],summary:null,suggestions:[],notes:[]};
  const props=reactive({visible:false,runId:'FR-original',result}),root=node('root'),close=vi.fn();app=renderer.createApp({render:()=>h(DiagnosisFeedbackDrawer,{...props,onClose:close})});app.component('RouterLink',{render:()=>null});app.use(pinia);app.provide(ssrContextKey,{});app.mount(root);props.visible=true;await settle();return {root,props,close};
}
function unload(){const event={preventDefault:vi.fn(),returnValue:undefined};listener?.(event as unknown as Event);return event;}
async function edit(root:HostNode,name:string,value:string){const group=all(root,row=>row.tag==='label'&&textOf(row).startsWith(name))[0]!,input=all(group,row=>row.tag==='input'||row.tag==='textarea')[0]!;(input.props['onUpdate:modelValue'] as (value:string)=>void)(value);await settle();}
async function click(root:HostNode,name:string){const target=all(root,row=>row.tag==='button'&&textOf(row)===name)[0]!;await (target.props.onClick as ()=>unknown)();await settle();}

describe('诊断知识反馈刷新保护',()=>{
  it('仅未提交的可见输入阻止刷新，未编辑和隐藏抽屉不误拦',async()=>{
    const f=await fixture();expect(unload().preventDefault).not.toHaveBeenCalled();await edit(f.root,'处置方案','人工构造处置');expect(unload().preventDefault).toHaveBeenCalledOnce();f.props.visible=false;await settle();expect(unload().preventDefault).not.toHaveBeenCalled();
  });
  it('关闭和路由原保护保留，选择继续不丢输入',async()=>{
    const f=await fixture();await edit(f.root,'处置方案','未提交处置');hooks.ask.mockResolvedValue('cancel');await click(f.root,'关闭');expect(f.close).not.toHaveBeenCalled();expect(await hooks.guards[0]!()).toBe(false);expect(unload().preventDefault).toHaveBeenCalledOnce();
    hooks.ask.mockResolvedValue('save');await click(f.root,'关闭');expect(f.close).toHaveBeenCalledOnce();
  });
  it('提交在途/失败仍阻止刷新，原号重试获受理后解除保护',async()=>{
    const f=await fixture();await edit(f.root,'处置方案','构造处置');let reject!:(error:Error)=>void;hooks.submit.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
    const posting=click(f.root,'提交知识草稿');await settle();expect(unload().preventDefault).toHaveBeenCalledOnce();reject(new Error('网络中断'));await posting;expect(unload().preventDefault).toHaveBeenCalledOnce();
    const original=hooks.submit.mock.calls[0]![0];hooks.submit.mockResolvedValue({objectId:'FR-original',entityIds:['FR-original','CR-original'],revision:'SR5-2'});await click(f.root,'提交知识草稿');expect(hooks.submit.mock.calls[1]![0].requestId).toBe(original.requestId);expect(unload().preventDefault).not.toHaveBeenCalled();expect(textOf(f.root)).toContain('CR-original');
  });
  it('卸载移除beforeunload监听，不污染其他页面',async()=>{const f=await fixture();await edit(f.root,'根因','修改根因');app!.unmount();app=undefined;expect(listener).toBeUndefined();expect(unload().preventDefault).not.toHaveBeenCalled();});
});
