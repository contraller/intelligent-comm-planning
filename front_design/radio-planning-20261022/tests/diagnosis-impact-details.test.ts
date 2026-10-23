import { afterEach,beforeAll,describe,expect,it,vi } from 'vitest';
import { h,nextTick,ref,ssrContextKey,type App } from 'vue';
import { createPinia,setActivePinia,disposePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import DiagnosisResultPanel from '../src/components/DiagnosisResultPanel.vue';
import { diagnosisPresets } from '../src/mocks/diagnosis-presets';
import { diagnosisPresetResult } from '../src/mocks/diagnosis-result-presets';
// 同型编译与基础宿主复用公共工具，业务夹具和生命周期保持本地。
import { clientTemplate, node, renderer, find, all, textOf, type HostNode } from './helpers/vue-client';
vi.mock('../src/components/DiagnosisRootCausePanel.vue',()=>({default:{render:()=>null}}));
// 编译实际模板并执行事件；渲染宿主不模拟业务判断。
async function click(root: HostNode, label: string) {
  const el = find(root, n => n.tag === 'button' && textOf(n).trim() === label);
  expect(el, label).toBeDefined(); await (el!.props.onClick as () => unknown)(); await nextTick();
}
async function settle() { for (let i = 0; i < 12; i++) await nextTick(); }


const apps:App[]=[],sessions:ReturnType<typeof createPinia>[]=[];
function mount(ready=true){const pinia=createPinia();setActivePinia(pinia);sessions.push(pinia);authorizeStore();
 const result=ref(structuredClone(diagnosisPresets[0].result)),impactReady=ref(ready),locate=vi.fn(),root=node('root');
 const app=renderer.createApp({render:()=>h(DiagnosisResultPanel,{result:result.value,impactReady:impactReady.value,reportReady:true,exporting:false,onLocate:locate})});
 app.provide(ssrContextKey,{modules:new Set()});app.mount(root);apps.push(app);return{result,impactReady,locate,root};
}
beforeAll(()=>clientTemplate(DiagnosisResultPanel,'src/components/DiagnosisResultPanel.vue', 'resource-ledger-render.ts'));
afterEach(()=>{apps.splice(0).forEach(app=>app.unmount());sessions.splice(0).forEach(disposePinia);vi.restoreAllMocks();});
describe('诊断影响页实际展示',()=>{
 it('多故障结论切换不裁剪全场景传播、统计和建议，步骤可按精确身份定位',async()=>{
  const s=mount();s.result.value=diagnosisPresetResult(diagnosisPresets.find(p=>p.id==='balanced:multiple')!,'diagnosis-demo-2','normal');await settle();await click(s.root,'影响');
  const body=()=>find(s.root,n=>n.props.class==='result-body')!,before=textOf(body()),selector=find(s.root,n=>n.props['aria-label']==='选择诊断结论')!;
  (selector.props['onUpdate:modelValue'] as (index:number)=>void)(1);await settle();expect(textOf(body())).toBe(before);expect(before).toContain('全场景');
  const step=find(s.root,n=>n.tag==='button'&&textOf(n)==='设备 DV-0027')!;await (step.props.onClick as ()=>unknown)();expect(s.locate).toHaveBeenCalledWith('DEVICE','DV-0027');
  await click(s.root,'建议');expect(textOf(s.root)).toContain('适用条件');expect(textOf(s.root)).toContain('功放故障与链路 B 干扰并存');
 });
 it('直接显示服务统计，节点数组长度不替代返回值',async()=>{const s=mount();s.result.value.summary!.interruptedNodeCount=99;s.result.value.summary!.degradedNodeCount=47;s.result.value.summary!.affectedDemandIds=['REQ-A','REQ-B'];await click(s.root,'影响');expect(textOf(s.root)).toContain('中断节点 99 / 性能降级节点 47');expect(textOf(s.root)).toContain('受影响必要通联需求：REQ-A、REQ-B');});
 it('0、空需求、false和缺失主干属性分别显示',async()=>{const s=mount();Object.assign(s.result.value.summary!,{interruptedNodeCount:0,degradedNodeCount:0,affectedDemandIds:[]});s.result.value.links[0].isBackbone=false;await click(s.root,'影响');expect(textOf(s.root)).toContain('中断节点 0 / 性能降级节点 0');expect(textOf(s.root)).toContain('受影响必要通联需求：无');expect(textOf(s.root)).toContain('非主干链路');s.result.value.links[0].isBackbone=null;await settle();expect(textOf(s.root)).toContain('主干属性未提供');s.result.value.links[0].isBackbone=true;await settle();expect(textOf(s.root)).toContain('主干链路');expect(textOf(s.root)).not.toContain('主干属性未提供');});
 it('未就绪隐藏统计和影响对象，就绪后可见，失败再次隐藏',async()=>{const s=mount(false);await click(s.root,'影响');expect(textOf(s.root)).toContain('影响分析尚未完成');expect(textOf(s.root)).not.toContain('中断节点');expect(all(s.root,n=>n.props.class==='impact-row')).toHaveLength(0);s.impactReady.value=true;await settle();expect(textOf(s.root)).toContain('中断节点');s.impactReady.value=false;await settle();expect(textOf(s.root)).not.toContain('中断节点');});
 it('历史统计缺失不自行汇总，原节点与链路定位仍按原ID发出',async()=>{const s=mount();s.result.value.summary=null;await click(s.root,'影响');expect(textOf(s.root)).toContain('历史资料未提供结构化统计');expect(textOf(s.root)).not.toContain('性能降级节点');const rows=all(s.root,n=>n.tag==='button'&&n.props.class==='impact-row');await (rows[0].props.onClick as Function)();await (rows[s.result.value.nodes.length].props.onClick as Function)();expect(s.locate.mock.calls).toEqual([['NODE',s.result.value.nodes[0].nodeId],['LINK',s.result.value.links[0].linkId]]);});
});

