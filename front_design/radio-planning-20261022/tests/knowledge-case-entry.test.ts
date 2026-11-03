import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { h, nextTick, reactive, ssrContextKey, type App, type VNodeChild } from 'vue';
import KnowledgeCaseBuilderDialog from '../src/components/KnowledgeCaseBuilderDialog.vue';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { initialKnowledgeWorkspace, knowledgeCatalog } from '../src/mocks/knowledge-presets';
import { knowledgeCaseTemplate } from '../src/services/knowledge-case-files';
import type { KnowledgeCaseContext } from '../src/types/knowledge-case';
import type { KnowledgeDraft } from '../src/types/knowledge';
import { authorizeStore } from './helpers/auth';
import { all, clientTemplate, node, renderer, textOf, type HostNode } from './helpers/vue-client';

const routing=vi.hoisted(()=>({guards:[] as (()=>Promise<boolean>)[]}));
vi.mock('vue-router',()=>({onBeforeRouteLeave:(guard:()=>Promise<boolean>)=>routing.guards.push(guard)}));
vi.mock('../src/reports/diagnosis-export',()=>({downloadDiagnosisFile:vi.fn()}));
vi.mock('primevue/dialog',()=>({default:{props:['visible'],setup(props:{visible:boolean},{slots}:{slots:Record<string,()=>VNodeChild>}){return()=>props.visible?h('section',{},[slots.default?.(),slots.footer?.()]):null;}}}));

let app:App|undefined,pinia:ReturnType<typeof createPinia>;
beforeAll(()=>clientTemplate(KnowledgeCaseBuilderDialog,'src/components/KnowledgeCaseBuilderDialog.vue','knowledge-case-entry-render.ts'));
beforeEach(()=>{
  routing.guards.length=0;vi.stubGlobal('Document',class {});vi.stubGlobal('document',{activeElement:null});vi.stubGlobal('ShadowRoot',class {});
  pinia=createPinia();setActivePinia(pinia);authorizeStore('kg_editor');
});
afterEach(()=>{app?.unmount();app=undefined;disposePinia(pinia);vi.restoreAllMocks();vi.unstubAllGlobals();});
async function settle(){for(let i=0;i<8;i++){await Promise.resolve();await nextTick();}}
function context(number:number):KnowledgeCaseContext{
  const base=structuredClone(initialKnowledgeWorkspace().versions.at(-1)!);base.id='KGV-'+number;base.number=number;
  const {entities,relations,...current}=base;
  return {base,catalog:knowledgeCatalog(),metadata:{revision:'KG-'+number,currentVersionId:base.id,current,counts:{设备知识:entities.filter(e=>e.category==='设备知识').length,网络态势知识:entities.filter(e=>e.category==='网络态势知识').length,故障运维知识:entities.filter(e=>e.category==='故障运维知识').length},identitySnapshots:[]}};
}
function control(root:HostNode,name:string){const value=all(root,row=>row.tag==='button'&&textOf(row)===name)[0];expect(value).toBeDefined();return value!;}
async function click(root:HostNode,name:string){await (control(root,name).props.onClick as ()=>unknown)();await settle();}
function field(root:HostNode,name:string){const group=all(root,row=>row.tag==='label'&&textOf(row).startsWith(name))[0]!;return all(group,row=>['input','textarea','select'].includes(row.tag))[0]!;}
async function edit(root:HostNode,name:string,value:string){(field(root,name).props['onUpdate:modelValue'] as (value:string)=>void)(value);await settle();}
async function fixture(){
  const store=useKnowledgeStore(),live={value:context(1)},applied:KnowledgeDraft[]=[];store.catalog=live.value.catalog;
  const read=vi.spyOn(store,'readCaseBase').mockImplementation(async()=>live.value);
  const apply=vi.spyOn(store,'applyCaseDraft').mockImplementation(async content=>{if(content.baseVersionId!==live.value.base.id)throw new Error('知识版本已变化，请保留输入并重新预检');applied.push(content);});
  const props=reactive({visible:false}),root=node('root');app=renderer.createApp({render:()=>h(KnowledgeCaseBuilderDialog,{...props,onClose:()=>{props.visible=false;}})});app.use(pinia);app.provide(ssrContextKey,{});app.mount(root);props.visible=true;await settle();return {store,live,applied,read,apply,props,root};
}
async function fill(root:HostNode){for(const [label,value] of [['案例编号','FC-ENTRY-01'],['故障类型','HW_FAILURE'],['适用对象','DEVICE'],['故障原因','有来源的测试原因'],['故障现象','构造测试现象'],['排故步骤','检查供电\n复核运行状态'],['解决方案','有来源的测试方案'],['知识来源','组件验收构造资料，非现场']])await edit(root,label,value);}

describe('结构化构建保留输入并恢复预检',()=>{
  it('过期后重读能继续，等待期间不重入、不应用旧预览',async()=>{
    const f=await fixture();await fill(f.root);await click(f.root,'重读基线并预检');expect(textOf(f.root)).toContain('基线 KGV-1');
    f.live.value=context(2);await click(f.root,'生成草稿并编辑');expect(textOf(f.root)).toContain('知识版本已变化');expect(field(f.root,'故障原因').value).toBe('有来源的测试原因');expect(control(f.root,'生成草稿并编辑').props.disabled).toBe(true);
    let finish!:(value:KnowledgeCaseContext)=>void;f.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const count=f.read.mock.calls.length;
    const reading=click(f.root,'重读基线并预检');await settle();expect(all(f.root,row=>row.tag==='fieldset')[0]!.props.disabled).toBe(true);
    await click(f.root,'正在处理…');await click(f.root,'生成草稿并编辑');expect(f.read).toHaveBeenCalledTimes(count+1);expect(f.apply).toHaveBeenCalledTimes(1);
    finish(f.live.value);await reading;expect(textOf(f.root)).toContain('基线 KGV-2');await click(f.root,'生成草稿并编辑');
    expect(f.applied).toHaveLength(1);expect(f.applied[0]!.baseVersionId).toBe('KGV-2');expect(f.applied[0]!.entities.find(e=>e.type==='Cause')!.name).toBe('有来源的测试原因');expect(f.props.visible).toBe(false);
  });
  it('Excel读取后的网络失败保留文件内容，取消离开再预检仍生成一张草稿',async()=>{
    const f=await fixture(),file=await knowledgeCaseTemplate();await click(f.root,'Excel 批量导入');
    const input=all(f.root,row=>row.tag==='input'&&row.props.type==='file')[0]!;
    await (input.props.onChange as (event:Event)=>Promise<void>)({target:{files:[{name:file.name,size:file.bytes.length,arrayBuffer:async()=>file.bytes.slice().buffer}]}} as unknown as Event);await settle();
    f.read.mockRejectedValueOnce(new Error('基线暂不可读'));await click(f.root,'重读基线并预检');expect(textOf(f.root)).toContain('基线暂不可读');expect(textOf(f.root)).toContain(file.name);expect(f.apply).not.toHaveBeenCalled();
    vi.spyOn(f.store,'ask').mockResolvedValue('cancel');expect(await routing.guards[0]!()).toBe(false);expect(textOf(f.root)).toContain(file.name);
    f.live.value=context(2);await click(f.root,'重读基线并预检');expect(textOf(f.root)).toContain('1 条案例');await click(f.root,'生成草稿并编辑');
    expect(f.applied).toHaveLength(1);expect(f.applied[0]!.baseVersionId).toBe('KGV-2');expect(f.applied[0]!.entities.filter(e=>e.type==='Fault')).toHaveLength(1);
  });
});
