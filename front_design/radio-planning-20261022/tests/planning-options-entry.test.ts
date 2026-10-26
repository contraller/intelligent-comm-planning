import { afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import { h,nextTick,ref,ssrContextKey,type App,type Component } from 'vue';
import { disposePinia } from 'pinia';
import PlanningOptionsEditor from '../src/components/PlanningOptionsEditor.vue';
import PlanningOptionsSummary from '../src/components/PlanningOptionsSummary.vue';
import TaskApiForm from '../src/components/TaskApiForm.vue';
import { optionsPlanningPresets } from '../src/mocks/planning-options-presets';
import { planningFrequencyResources } from '../src/mocks/planning-frequency-resources';
import { usePlanningStore } from '../src/stores/planning';
import { storeFixture,readNode } from './fixtures/planning-api';
import resources from '../src/mocks/resources.json';
import type { PlanningInput } from '../src/types/planning';
import { previewService } from '../src/services';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, textOf, type HostNode } from './helpers/vue-client';
vi.mock('../src/components/AppDrawer.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/TaskDemandEditor.vue',()=>({default:{render:()=>null}}));
vi.mock('../src/components/DeploymentConstraintsEditor.vue',()=>({default:{render:()=>null}}));
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


const apps:App[]=[],sessions:Awaited<ReturnType<typeof storeFixture>>[]=[];
function mount(component:Component,props:()=>Record<string,unknown>){const root=node('root'),app=renderer.createApp({render:()=>h(component,props())});app.provide(ssrContextKey,{modules:new Set()});app.mount(root);apps.push(app);return root;}
const labelInput=(root:HostNode,label:string)=>find(find(root,n=>n.tag==='label'&&textOf(n).startsWith(label))!,n=>n.tag==='input')!;
const inputEvent=async(el:HostNode,value:string)=>{(el.props.onInput as (e:unknown)=>void)({target:{value}});await settle();};
beforeAll(async()=>{for(const [component,path] of [[PlanningOptionsEditor,'PlanningOptionsEditor'],[PlanningOptionsSummary,'PlanningOptionsSummary'],[TaskApiForm,'TaskApiForm']] as const)await clientTemplate(component,'src/components/'+path+'.vue', 'resource-ledger-render.ts');});
afterEach(()=>{apps.splice(0).forEach(app=>app.unmount());sessions.splice(0).forEach(s=>{s.task.clearForSession();usePlanningStore().clearForSession();disposePinia(s.pinia);});vi.restoreAllMocks();});
describe('真实频率部署输入控件',()=>{
  // 就近提示不补齐范围，不把合法 0 转为空值。
  it('规划范围和数量错误留在对应控件组，修正后就地消失',async()=>{
    const value=ref(structuredClone(optionsPlanningPresets.find(p=>p.id==='options-fixed')!.input));
    const root=mount(PlanningOptionsEditor,()=>({modelValue:value.value,owner:'inline',inlineIssues:true,'onUpdate:modelValue':(options:object)=>{value.value={...value.value,...options};}}));
    await inputEvent(labelInput(root,'最低频率 / kHz'),'bad-frequency');
    const range=find(root,n=>n.props['data-validation-field']==='frequencyConstraints.HF.rangeKhz')!;
    expect(textOf(range)).toContain('频率上下界需成组填写正数');expect(labelInput(root,'最低频率 / kHz').props.value).toBe('bad-frequency');
    await inputEvent(labelInput(root,'新增部署单元数'),'bad-count');
    expect(textOf(labelInput(root,'新增部署单元数').parent!)).toContain('指定数量须为非负整数');
    await inputEvent(labelInput(root,'新增部署单元数'),'0');
    expect(textOf(labelInput(root,'新增部署单元数').parent!)).not.toContain('指定数量须为非负整数');expect(value.value.deploymentSolve!.fixedCount).toBe(0);
  });
  // 从真实勾选和输入事件验证排除项，不用直接构造合法 DTO 绕过空范围问题。
  it.each(['HF','VUHF'] as const)('%s 仅填排除频点可提交，半填和非法范围仍被拦截',async(kind)=>{
    const value=ref<PlanningInput>({...structuredClone(optionsPlanningPresets[0].input),frequencyConstraints:null}),pending=ref(false);
    const root=mount(PlanningOptionsEditor,()=>({modelValue:value.value,owner:'exclude-only',frequencyResources:planningFrequencyResources,
      'onUpdate:modelValue':(options:object)=>{value.value={...value.value,...options};},onPending:(v:boolean)=>pending.value=v}));
    (labelInput(root,'设置 '+kind+' 条件').props.onChange as Function)({target:{checked:true}});await settle();
    expect(pending.value).toBe(true);
    await inputEvent(labelInput(root,'排除频点 ID'),'FQ-EXCLUDED');
    expect(value.value.frequencyConstraints!.filters[0]).toEqual({deviceClass:kind,rangeKhz:null,excludeFreqIds:['FQ-EXCLUDED']});
    expect(pending.value).toBe(false);
    await inputEvent(labelInput(root,'最低频率 / kHz'),'1500');expect(pending.value).toBe(true);
    await inputEvent(labelInput(root,'最高频率 / kHz'),'2000');expect(pending.value).toBe(false);
    await inputEvent(labelInput(root,'最低频率 / kHz'),'bad');expect(pending.value).toBe(true);
    await inputEvent(labelInput(root,'最高频率 / kHz'),'');expect(pending.value).toBe(true);
    expect(labelInput(root,'最低频率 / kHz').props.value).toBe('bad');
    await inputEvent(labelInput(root,'最低频率 / kHz'),'');expect(pending.value).toBe(false);
    expect(value.value.frequencyConstraints!.filters[0].rangeKhz).toBeNull();
  });
  it('未完成数值保留文本并阻止提交，0不被视为空',async()=>{const value=ref(structuredClone(optionsPlanningPresets.find(p=>p.id==='options-fixed')!.input)),pending=ref(false);const root=mount(PlanningOptionsEditor,()=>({modelValue:value.value,owner:'task-A',frequencyResources:planningFrequencyResources,'onUpdate:modelValue':(options:object)=>{value.value={...value.value,...options};},onPending:(v:boolean)=>pending.value=v}));await inputEvent(labelInput(root,'新增部署单元数'),'bad');expect(Number.isNaN(value.value.deploymentSolve!.fixedCount)).toBe(true);expect(labelInput(root,'新增部署单元数').props.value).toBe('bad');expect(pending.value).toBe(true);await inputEvent(labelInput(root,'新增部署单元数'),'0');expect(value.value.deploymentSolve!.fixedCount).toBe(0);expect(pending.value).toBe(false);});
  it('旧任务、失权后恢复以及卸载后的事件不能回写',async()=>{const value=ref(structuredClone(optionsPlanningPresets[0].input)),owner=ref('A'),disabled=ref(false),update=vi.fn();const root=mount(PlanningOptionsEditor,()=>({modelValue:value.value,owner:owner.value,disabled:disabled.value,'onUpdate:modelValue':update}));const old=labelInput(root,'期望备选数量').props.onInput as Function;owner.value='B';await settle();old({target:{value:'4'}});expect(update).not.toHaveBeenCalled();const after=labelInput(root,'期望备选数量').props.onInput as Function;disabled.value=true;await settle();disabled.value=false;await settle();after({target:{value:'5'}});expect(update).not.toHaveBeenCalled();apps.pop()!.unmount();old({target:{value:'6'}});expect(update).not.toHaveBeenCalled();});
  it('未知频点原样保留并给出提示，资源组不受影响',async()=>{const value=ref(structuredClone(optionsPlanningPresets[0].input));const root=mount(PlanningOptionsEditor,()=>({modelValue:value.value,owner:'A',frequencyResources:planningFrequencyResources,'onUpdate:modelValue':(options:object)=>{value.value={...value.value,...options};}}));await inputEvent(labelInput(root,'排除频点 ID'),'EXTERNAL-1;EXTERNAL-2');expect(value.value.frequencyId).toBe('hf-full');expect(value.value.frequencyConstraints!.filters[0].excludeFreqIds).toEqual(['EXTERNAL-1','EXTERNAL-2']);expect(textOf(root)).toContain('仍保留并提交');});
  it('HTTP任务表单保留无效输入和离开标记，旧预设清除新条件',async()=>{const s=await storeFixture();sessions.push(s);vi.spyOn(s.resources,'fetchNodes').mockResolvedValue({items:[readNode()],pageNum:1,pageSize:10,total:1} as any);Object.assign(s.task.draft!,{frequencyConstraints:structuredClone(optionsPlanningPresets[0].input.frequencyConstraints),deploymentSolve:{mode:'FIXED_COUNT',fixedCount:0,solutionCount:2}});const root=mount(TaskApiForm,()=>({}));await settle();await inputEvent(labelInput(root,'期望备选数量'),'');expect(Number.isNaN(s.task.draft!.deploymentSolve!.solutionCount)).toBe(true);expect(s.task.auxiliary.options).toBe(true);expect(await s.task.save()).toBe(false);s.task.applyPreset('P1');await settle();expect(s.task.draft).not.toHaveProperty('deploymentSolve');expect(s.task.draft).not.toHaveProperty('frequencyConstraints');expect(s.task.auxiliary.options).toBe(false);});
  // 两种数据模式共用任务表单，非法选项仍参与未应用输入保护。
  it('当前任务表单的扩展编辑参加pending保护',async()=>{const s=await storeFixture();sessions.push(s);vi.spyOn(previewService,'queryResourceNodes').mockResolvedValue({revision:'r1',items:[],pageNum:1,pageSize:10,total:0});s.task.updateInput(structuredClone(optionsPlanningPresets[0].input));s.task.catalog!.frequencyResources=structuredClone(planningFrequencyResources);const root=mount(TaskApiForm,()=>({}));await settle();await inputEvent(labelInput(root,'最低频率 / kHz'),'bad');expect(s.task.auxiliary.options).toBe(true);expect(Number.isNaN(s.task.draft!.frequencyConstraints!.filters[0].rangeKhz![0])).toBe(true);});
});

