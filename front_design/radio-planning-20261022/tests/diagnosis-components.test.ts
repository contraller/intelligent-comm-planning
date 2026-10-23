import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick, reactive, ssrContextKey, type App, type Component } from 'vue';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import DiagnosisFaultTypePicker from '../src/components/DiagnosisFaultTypePicker.vue';
import DiagnosisRootCausePanel from '../src/components/DiagnosisRootCausePanel.vue';
import DiagnosisResultPanel from '../src/components/DiagnosisResultPanel.vue';
import DiagnosisScenarioDrawer from '../src/components/DiagnosisScenarioDrawer.vue';
import DiagnosisNetworkPanel from '../src/components/DiagnosisNetworkPanel.vue';
import { diagnosisPresets, diagnosisSymptoms } from '../src/mocks/diagnosis-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import legacyPlans from '../src/mocks/planning.json';
import { diagnosisFaultTypes } from '../src/services/diagnosis-display';
import { validateDiagnosisDraft } from '../src/services/diagnosis-validation';
import { previewService } from '../src/services';
import { authorizeStore } from './helpers/auth';
import type { PlanVersion } from '../src/types/domain';
import type { FaultType, DiagnosisDraft } from '../src/types/diagnosis';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, all, textOf, type HostNode } from './helpers/vue-client';

vi.mock('../src/components/AppDrawer.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {default:defineComponent({props:['visible'],setup(props,{slots}) { return () => props.visible ? h('drawer-probe', [slots.default?.(),slots.footer?.()]) : null; }})};
});
vi.mock('../src/components/MapCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {default:defineComponent({inheritAttrs:false,props:['stations','links','diagnosisFaults','diagnosisDevices','selectedId','selectedLinkId'],
    setup(props){return () => h('map-probe',{...props});}})};
});
vi.mock('../src/components/ChartCanvas.vue', async () => {
  const { defineComponent, h } = await import('vue');
  return {default:defineComponent({inheritAttrs:false,props:['option'],emits:['select'],
    setup(props,{emit}){return () => h('chart-probe',{...props,select:(id:string)=>emit('select',id)});}})};
});
// 在内存宿主执行真实客户端模板；不把宿主事件验证当作浏览器视觉验收。
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function radio(root: HostNode, label: string) {
  const el = find(root, n => n.props['aria-label'] === label);
  expect(el, label).toBeDefined(); (el!.props.onChange as () => void)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }

await Promise.all([
  [DiagnosisFaultTypePicker,'DiagnosisFaultTypePicker'],[DiagnosisRootCausePanel,'DiagnosisRootCausePanel'],
  [DiagnosisResultPanel,'DiagnosisResultPanel'],[DiagnosisScenarioDrawer,'DiagnosisScenarioDrawer'],[DiagnosisNetworkPanel,'DiagnosisNetworkPanel'],
].map(([component,name]) => clientTemplate(component as Component, 'src/components/' + name + '.vue', 'diagnosis-render.ts')));
let app:App<HostNode>|undefined, pinia:ReturnType<typeof createPinia>|undefined;
afterEach(() => {app?.unmount();app=undefined;if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();});
function mount(render:()=>ReturnType<typeof h>) {
  vi.stubGlobal('document',{activeElement:null});pinia=createPinia();setActivePinia(pinia);const auth=authorizeStore();
  const root=node('root');app=renderer.createApp({render});app.use(pinia);app.provide(ssrContextKey,{});app.mount(root);
  return {root,auth};
}
const plan = () => ({...structuredClone(legacyPlans.plans[0]),inputSnapshot:structuredClone(planningPresets[0].baseline),links:structuredClone(planningPresets[0].result!.links)}) as unknown as PlanVersion;
const result = () => structuredClone(diagnosisPresets.find(row=>row.id==='balanced:multiple')!.result);

describe('故障类型选择及场景配置', () => {
  it('四类图标选择、独立 radio 组及禁用守卫', async () => {
    const props=reactive({modelValue:'HW_FAILURE' as FaultType,disabled:false}),changed=vi.fn();
    const s=mount(()=>h('section',[h(DiagnosisFaultTypePicker,{...props,'onUpdate:modelValue':changed}),h(DiagnosisFaultTypePicker,{modelValue:'EMI',label:'另一组'})]));
    expect(new Set(all(s.root,n=>n.tag==='input').map(n=>n.props.name)).size).toBe(2);
    for(const item of diagnosisFaultTypes) {await radio(s.root,'故障类型：'+item.label);expect(changed).toHaveBeenLastCalledWith(item.type);}
    expect(props.modelValue).toBe('HW_FAILURE');
    props.disabled=true;await nextTick();await radio(s.root,'故障类型：电磁干扰');expect(changed).toHaveBeenCalledTimes(4);
    expect(find(s.root,n=>n.props['aria-label']==='故障类型：电磁干扰')!.props.disabled).toBe(true);
    expect(textOf(s.root)).toContain('场景注入类型，不改变设备运行状态');
  });
  it('单条类型选择沿用对象适配校验，不兼容时不应用', async () => {
    const network=plan(),draft:DiagnosisDraft={name:'单条类型',description:'',planId:network.id,faults:structuredClone(diagnosisPresets[0].faults)};
    const validate=vi.spyOn(previewService,'validateDiagnosisScenario').mockImplementation(async value=>validateDiagnosisDraft(value,network)),apply=vi.fn(),before=JSON.stringify(draft);
    const s=mount(()=>h(DiagnosisScenarioDrawer,{visible:true,draft,network,symptoms:diagnosisSymptoms,interferenceIds:[],selected:[],onApply:apply}));
    await radio(s.root,'故障 1 类型：链路中断');await click(s.root,'应用到场景草稿');
    expect(validate).toHaveBeenCalledOnce();expect(apply).not.toHaveBeenCalled();expect(textOf(s.root)).toContain('故障类型不适用于该对象');
    await radio(s.root,'故障 1 类型：软件配置异常');await click(s.root,'应用到场景草稿');
    expect(apply.mock.calls[0][0].faults[0].faultType).toBe('SW_CONFIG');expect(JSON.stringify(draft)).toBe(before);
  });
  it('批量类型整体校验，失败不部分应用，成功仍需应用到草稿', async () => {
    const network=plan(),faults=structuredClone(diagnosisPresets.find(row=>row.id==='balanced:multiple')!.faults);
    const draft:DiagnosisDraft={name:'批量类型',description:'',planId:network.id,faults},apply=vi.fn();
    vi.spyOn(previewService,'validateDiagnosisScenario').mockImplementation(async value=>validateDiagnosisDraft(value,network));
    const props=reactive({visible:true,selected:faults.map(({objectType,objectId})=>({objectType,objectId}))});
    const s=mount(()=>h(DiagnosisScenarioDrawer,{...props,draft,network,symptoms:diagnosisSymptoms,interferenceIds:['IF-DG-01'],onApply:apply}));
    await radio(s.root,'批量故障类型：链路中断');await click(s.root,'校验并批量应用');
    expect(textOf(s.root)).toContain('故障类型不适用于该对象');expect(apply).not.toHaveBeenCalled();
    expect(find(s.root,n=>n.props['aria-label']==='故障 1 类型：硬件故障')!.props.checked).toBe(true);
    props.visible=false;await nextTick();props.selected=[props.selected[0]];props.visible=true;await nextTick();
    await radio(s.root,'批量故障类型：软件配置异常');await click(s.root,'校验并批量应用');expect(apply).not.toHaveBeenCalled();
    await click(s.root,'应用到场景草稿');expect(apply.mock.calls[0][0].faults.map((f:{faultType:string})=>f.faultType)).toEqual(['SW_CONFIG','EMI']);
  });
  it('权限撤销后新类型控件与原应用入口均不能更改草稿', async () => {
    const network=plan(),draft:DiagnosisDraft={name:'权限',description:'',planId:network.id,faults:structuredClone(diagnosisPresets[0].faults)},apply=vi.fn();
    const validate=vi.spyOn(previewService,'validateDiagnosisScenario').mockResolvedValue([]);
    const s=mount(()=>h(DiagnosisScenarioDrawer,{visible:true,draft,network,symptoms:diagnosisSymptoms,interferenceIds:[],selected:[],onApply:apply}));
    s.auth.identity!.permissions=s.auth.identity!.permissions.filter(p=>p!=='diagnosis.scenario');await nextTick();
    await radio(s.root,'故障 1 类型：软件配置异常');await click(s.root,'应用到场景草稿');
    expect(find(s.root,n=>n.props['aria-label']==='故障 1 类型：硬件故障')!.props.checked).toBe(true);
    expect(validate).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
  });
});

describe('根因与三路摘要实际模板', () => {
  it('现象名称及 ID、独立原因和部件、自由链条都可读取', () => {
    const c=result().conclusions[0];c.chain=['先检查','自由链条第二段','保留原文'];
    const s=mount(()=>h(DiagnosisRootCausePanel,{conclusion:c,symptoms:diagnosisSymptoms}));
    for(const label of ['发射时驻波比告警','SY-0001','原因','部件',c.rootCause,c.component!,'原始根因链（3 段）','保留原文'])expect(textOf(s.root)).toContain(label);
  });
  it('历史没有结构化现象和部件时显示缺失，未知现象保留编号', async () => {
    const c=reactive(result().conclusions[0]);c.fault=null;c.component=null;
    const s=mount(()=>h(DiagnosisRootCausePanel,{conclusion:c,symptoms:diagnosisSymptoms}));
    expect(textOf(s.root)).toContain('未提供结构化现象');expect(textOf(s.root)).toContain('未提供');
    c.fault=structuredClone(diagnosisPresets[0].faults[0]);c.fault.symptomIds=['UNKNOWN-SYMPTOM'];c.chain=[];await nextTick();
    expect(textOf(s.root)).toContain('名称未提供');expect(textOf(s.root)).toContain('UNKNOWN-SYMPTOM');expect(textOf(s.root)).toContain('未提供原始根因链');
  });
  it('多结论切换同步根因与三路摘要，缺 ML 不补值，定位仅由原按钮触发', async () => {
    const props=reactive({result:result(),impactReady:false,reportReady:false,exporting:false,symptoms:diagnosisSymptoms,contextKey:'run-1'}),locate=vi.fn();
    props.result.conclusions[1].rootCause='第二条原因';props.result.conclusions[1].component='第二条部件';props.result.conclusions[1].branches[0].confidence=0.61;
    const s=mount(()=>h(DiagnosisResultPanel,{...props,onLocate:locate}));
    const summary=()=>find(s.root,n=>n.props['aria-label']==='三路推理摘要')!;
    expect(all(summary(),n=>n.props.class==='branch-row')).toHaveLength(3);expect(textOf(summary())).toContain('权重 0 · 贡献 未提供');
    await click(s.root,'根因');expect(textOf(s.root)).toContain('发射时驻波比告警');
    (find(s.root,n=>n.props['aria-label']==='选择诊断结论')!.props['onUpdate:modelValue'] as (v:number)=>void)(1);await nextTick();
    expect(textOf(s.root)).toContain('第二条部件');expect(textOf(summary())).toContain('61.0%');expect(textOf(s.root)).toContain('收信底噪明显抬升');
    expect(locate).not.toHaveBeenCalled();await click(s.root,'定位故障对象 LINK-B');expect(locate).toHaveBeenCalledWith('LINK','LINK-B');
    props.contextKey='run-2';await nextTick();expect(textOf(s.root)).toContain('发射时驻波比告警');expect(textOf(s.root)).not.toContain('第二条部件');
  });
});

describe('拓扑的类型标识与原状态', () => {
  it('类型轮廓和影响样式保留，拓扑点选只读取冻结详情', async () => {
    const network=plan(),preset=diagnosisPresets.find(row=>row.id==='balanced:multiple')!;
    const props=reactive({network,faults:structuredClone(preset.faults),result:structuredClone(preset.result),impactReady:true,focus:null}),before=JSON.stringify(network);
    const s=mount(()=>h(DiagnosisNetworkPanel,props));
    await click(s.root,'网络拓扑');
    const probe=find(s.root,n=>n.tag==='chart-probe')!,series=(probe.props.option as {series:any[]}).series[0];
    const device=series.data.find((n:any)=>n.id==='DEVICE:DV-0027'),link=series.links.find((n:any)=>n.id==='LINK:LINK-B');
    expect(device.itemStyle.color).toBe('#e47589');expect(device.symbol).toBe('diamond');expect(device.label.formatter()).toContain('场景注入 · ◆ 硬件故障');
    expect(link.lineStyle.color).toBe('#eb8392');expect(link.label.formatter()).toContain('电磁干扰');expect(link.source).toBe('DEVICE:'+network.links.find(l=>l.id==='LINK-B')!.deviceA);
    (probe.props.select as (id:string)=>void)('LINK:LINK-B');await nextTick();
    expect(find(s.root,n=>n.tag==='drawer-probe')).toBeUndefined();await click(s.root,'查看详情');expect(find(s.root,n=>n.tag==='drawer-probe')).toBeDefined();expect(textOf(s.root)).toContain('LINK-B');expect(textOf(s.root)).not.toContain('配置已选对象');
    expect(textOf(s.root)).toContain('场景注入标识');expect(JSON.stringify(network)).toBe(before);
  });
});
