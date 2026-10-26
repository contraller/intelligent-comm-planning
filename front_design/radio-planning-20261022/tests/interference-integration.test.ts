import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { createPinia, setActivePinia, disposePinia } from 'pinia';
import { vi } from 'vitest';
import InterferenceAnalysisPanel from '../src/components/InterferenceAnalysisPanel.vue';
import InterferenceMeasureDrawer from '../src/components/InterferenceMeasureDrawer.vue';
import { authorizeStore } from './helpers/auth';
import { describe, expect, it } from 'vitest';
import { interferenceFixture } from './helpers/interference';
import { interferenceVariants } from '../src/mocks/interference-presets';
import { allDiagnosisPresets, networkDiagnosisPresets } from '../src/services/diagnosis-catalog';
import { matchDiagnosisPreset } from '../src/services/diagnosis-validation';
import { DIAGNOSIS_STORAGE_KEY, PLANNING_STORAGE_KEY } from '../src/config/demo';
import { createWorkbenchFixture, enterWorkbenchStore, measureTitles } from './helpers/interference-workbench';

// 只替换抽屉容器，真实措施模板与所有插槽继续执行。
vi.mock('../src/components/AppDrawer.vue',async()=>{
  const {defineComponent,h}=await import('vue');
  return {default:defineComponent({setup:(_props,{slots})=>()=>h('section',[slots.default?.(),slots.footer?.()])})};
});

// 旧预生成诊断仅验证教学 storage 兼容；不代表真实重算或 SR5 HTTP 结果。
describe('教学采纳网络跨模块存储兼容', () => {
  it.each(interferenceVariants.map(row=>[row.id,row] as const))('%s 确认后四单故障及复合故障均使用专用预设', async (_id,variant) => {
    const s=await interferenceFixture(variant.networkPresetId),run=await s.submit();s.advance();
    const adopted=await s.adopt(run.view.run.analysisId,variant.type);
    expect((await s.diagnosis.loadDiagnosisSources()).plans.map(row=>row.id)).not.toContain(adopted.plan.id);
    const confirmed=(await s.confirm(adopted.plan.id)).plan, presets=networkDiagnosisPresets(confirmed);
    expect(presets).toHaveLength(5);
    for(const preset of presets){
      const loaded=await s.diagnosis.loadDiagnosisWorkspace();
      const draft={name:preset.label,description:'抗干扰网络诊断',planId:confirmed.id,faults:structuredClone(preset.faults)};
      const saved=await s.diagnosis.saveDiagnosisScenario({baseRevision:loaded.workspace!.revision,requestId:crypto.randomUUID(),scenarioId:null,draft});
      const task=await s.diagnosis.submitDiagnosis({baseRevision:saved.revision,requestId:crypto.randomUUID(),scenarioVersionId:saved.scenarios.at(-1)!.versions[0].id,demo:'normal'});
      expect(task.view.run.presetId).toBe(preset.id);s.advance();
      const report=await s.diagnosis.getDiagnosisReport(task.view.run.id);
      // 新运行追加 v2 传播字段，原 v1 结论、指标与建议仍逐项保持。
      const {propagationPaths,...originalFields}=report.result;
      expect(report.network).toEqual(confirmed);expect(originalFields).toEqual(preset.result);
      expect(task.view.run.presetVersion).toBe('diagnosis-demo-2');expect(propagationPaths).toHaveLength(preset.faults.length);
      for(const [index,path] of propagationPaths!.entries()) {
        expect(path.faultKey).toBe(`${preset.faults[index].objectType}:${preset.faults[index].objectId}`);
        expect(path.steps[0]).toMatchObject({objectType:preset.faults[index].objectType,objectId:preset.faults[index].objectId});
      }
      expect(report.result.notes.join(' ')).toContain(variant.id);
    }
    const historical=s.storage.getItem(DIAGNOSIS_STORAGE_KEY);
    await s.planning.resetPlanningWorkspace(JSON.parse(s.storage.getItem(PLANNING_STORAGE_KEY)!).revision);
    expect(s.storage.getItem(DIAGNOSIS_STORAGE_KEY)).toBe(historical);
    const loaded=await s.diagnosis.loadDiagnosisWorkspace();expect(loaded.error).toBeNull();
    expect((await s.diagnosis.getDiagnosisReport(loaded.workspace!.runs[0].id)).source.state).toBe('HISTORICAL');
  },20000);
  it('改动完整配置或使用旧 EMI 源不能回落到旧网络诊断', async () => {
    const s=await interferenceFixture(),run=await s.submit();s.advance();const adopted=await s.adopt(run.view.run.analysisId);
    const plan=(await s.confirm(adopted.plan.id)).plan, preset=networkDiagnosisPresets(plan).find(row=>row.id.endsWith(':emi'))!;
    const draft={name:'EMI',description:'',planId:plan.id,faults:structuredClone(preset.faults)};
    const tampered=structuredClone(plan);tampered.workflow!.configuration.devices[0].frequencyKhz=9999;
    expect(()=>matchDiagnosisPreset(draft,tampered,allDiagnosisPresets)).toThrow();
    draft.faults[0].interferenceId='IF-DG-01';expect(()=>matchDiagnosisPreset(draft,plan,allDiagnosisPresets)).toThrow();
    draft.faults[0].interferenceId='IF-0008';draft.faults[0].symptomIds=[];
    expect(()=>matchDiagnosisPreset(draft,plan,allDiagnosisPresets)).toThrow('暂无预生成结果');
  });
});

// 无浏览器环境下补做组件模板渲染；不将此检查冒充真实点击或视觉验收。
it('统一干扰面板可渲染响应式冻结结果、三级筛选和五项措施',async()=>{
  const pinia=createPinia();setActivePinia(pinia);
  try{
    authorizeStore();const f=await createWorkbenchFixture();await enterWorkbenchStore(f);
    const app=createSSRApp(InterferenceAnalysisPanel,{sourceEditable:false,selectedNodeId:'UNIT-N1',selectedLinkId:''});
    app.use(pinia);const html=await renderToString(app);
    for(const text of ['提交干扰分析','分析完成',...measureTitles,'严重','中等','轻微'])expect(html).toContain(text);
    expect(html).toContain('18.2 → SINR 3.1');
    expect(f.workbench.getRun).toHaveBeenCalledWith({task_id:f.target.taskId,run_id:f.run.run_id},expect.any(AbortSignal));f.assertNoWrites();
  }finally{vi.restoreAllMocks();disposePinia(pinia);}
});

it('措施抽屉使用独立服务预览；服务明确不可采纳时禁用新写入但仍能查看已生成方案',async()=>{
  const pinia=createPinia();setActivePinia(pinia);
  try{
    authorizeStore();const f=await createWorkbenchFixture(),store=await enterWorkbenchStore(f);
    await store.loadMeasurePreview('UNIT-CM1');
    const render=async(component:typeof InterferenceMeasureDrawer|typeof InterferenceAnalysisPanel)=>{
      const app=createSSRApp(component,{sourceEditable:false,selectedNodeId:'',selectedLinkId:''});app.use(pinia);return renderToString(app);
    };
    let html=await render(InterferenceMeasureDrawer);
    expect(html).toContain('83.21');expect(html).toContain('54321');
    expect(f.workbench.getPreview).toHaveBeenCalledWith({task_id:f.target.taskId,run_id:f.run.run_id,measure_id:'UNIT-CM1',expected_run_version:1},expect.any(AbortSignal));
    store.after=true;expect(store.effectiveAfter).toBe(true);
    f.workbench.getPreview.mockRejectedValueOnce(new Error('冻结措施预览未提供'));
    await store.loadMeasurePreview('UNIT-CM1');
    f.run.adoption_capabilities.FREQ_ADJUST={enabled:false,reasons:['冻结预览未核实，不能采纳']};
    await store.selectRun(f.run.run_id);f.workbench.getPreview.mockRejectedValueOnce(new Error('冻结措施预览未提供'));await store.loadMeasurePreview('UNIT-CM1');
    html=await render(InterferenceMeasureDrawer);
    expect(html).toContain('尚未取得此措施的冻结预览');expect(html).not.toContain('83.21');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>措施后预测<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>采纳措施并提交规划重算<\/button>/);
    expect(store.effectiveAfter).toBe(false);
    const panel=await render(InterferenceAnalysisPanel);
    expect(panel).toContain('预测受扰节点 '+f.run.result!.summary.affected_nodes);
    expect(panel).toMatch(/<button[^>]*disabled[^>]*>措施后预测<\/button>/);
    f.run.adoptions=[f.adopted];await store.selectRun(f.run.run_id);f.workbench.getPreview.mockRejectedValueOnce(new Error('冻结措施预览未提供'));await store.loadMeasurePreview('UNIT-CM1');
    html=await render(InterferenceMeasureDrawer);
    expect(html).toMatch(/<button(?:(?!disabled)[^>])*>打开重算方案<\/button>/);
    expect(html).toContain('采纳未改变原确认方案');expect(f.adopted.result_plan_state).toBe('SAVED');f.assertNoWrites();
  }finally{vi.restoreAllMocks();disposePinia(pinia);}
});
