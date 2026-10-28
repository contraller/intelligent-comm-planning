import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { defineComponent, h, nextTick, ssrContextKey, type App } from 'vue';
import { authorizeStore } from './helpers/auth';
import { clientTemplate, find, node, renderer, textOf } from './helpers/vue-client';
import { useInterferenceStore } from '../src/stores/interference';
import Panel from '../src/components/InterferenceAnalysisPanel.vue';
import SceneDrawer from '../src/components/InterferenceSceneDrawer.vue';
import MeasureDrawer from '../src/components/InterferenceMeasureDrawer.vue';
import HistoryDrawer from '../src/components/InterferenceHistoryDrawer.vue';
import type { RunDetail, AdoptionDetail } from '../src/types/interference-workbench';

vi.mock('../src/components/AppDrawer.vue', () => ({ default: defineComponent({ props: ['visible'], setup: (props, { slots }) => () => props.visible ? h('aside', [slots.default?.(), slots.footer?.()]) : null }) }));
let pinia: ReturnType<typeof createPinia>, app: App | undefined;
beforeAll(async () => { for (const [component, name] of [[Panel, 'InterferenceAnalysisPanel'], [SceneDrawer, 'InterferenceSceneDrawer'], [MeasureDrawer, 'InterferenceMeasureDrawer'], [HistoryDrawer, 'InterferenceHistoryDrawer']] as const) await clientTemplate(component, 'src/components/' + name + '.vue', 'interference-r2-render.ts'); });
class FixtureDocument { activeElement = null; }
class FixtureShadowRoot {}
beforeEach(() => { vi.stubGlobal('window', { confirm: vi.fn(() => false) }); vi.stubGlobal('Document', FixtureDocument); vi.stubGlobal('ShadowRoot', FixtureShadowRoot); vi.stubGlobal('document', new FixtureDocument()); pinia = createPinia(); setActivePinia(pinia); authorizeStore(); });
afterEach(() => { app?.unmount(); app = undefined; disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function mount(component: Parameters<typeof h>[0], props = {}) { app = renderer.createApp({ render: () => h(component, props) }); app.use(pinia); app.provide(ssrContextKey, { modules: new Set() }); const root = node('root'); app.mount(root); return root; }
function successful(): RunDetail {
  const hash = 'a'.repeat(64), stamp = '2026-10-23T08:00:00Z';
  return { run_id: 'RUN1', task_id: 'T1', scene_id: 'SC1', scene_version_id: 'SV1', resource_revision: 'RES1',
    run_version: 1, phase: '分析完成', cancel_requested: false, error: null, result_hash: hash, started_at: stamp, updated_at: stamp,
    state: 'SUCCESS', progress: 100, source_hash: hash, source_state: { state: 'CURRENT', reasons: [] }, plan_id: 'P1', plan_version: 'V1', data_origin: 'SYNTHETIC_INTEGRATION', adoptions: [],
    source: { sceneId: 'SC1', taskId: 'T1', versionId: 'SV1', name: '场景', note: '', versionNo: 1, planId: 'P1', planVersion: 'V1',
      schemaVersion: 1, resourceRevision: 'RES1', sourceCount: 0, snapshotHash: hash, dataOrigin: 'SYNTHETIC_INTEGRATION', savedAt: stamp,
      previousVersionId: null, savedBy: 'u1', resourceContentHash: hash, source: 'SR4', interferenceIds: [], interferenceSources: [],
      planSnapshot: { taskId: 'T1', planId: 'P1', planVersion: 'V1', inputVersion: 'I1', conditionVersion: 'C1', resourceRevision: 'RES1', source: 'SR4', inputSnapshot: {}, rawSnapshot: { detail: { nodes: [], links: [] } } } },
    result: { analysis_id: 'RUN1', measures: [{ measure_id: 'CM1', type: 'POWER_OPT', target_node_id: null, target_link_id: 'L1', priority: 1,
      change_set: {}, preview_hash: hash, pre_eval: null, restores: false, title: '功率措施', detail: '拟调整设备', risk: '预测', available: true, unavailable_reasons: [] }],
      affected_nodes: [], affected_links: [], affected_area: {}, notes: [], unresolved: [], measure_review: [], parameter_substitutions: [],
      summary: { links: 0, jammers: 0, affected_nodes: 0, affected_links: 0, by_level: { SEVERE: 0, MODERATE: 0, MINOR: 0 } } },
    adoption_capabilities: { FREQ_ADJUST: { enabled: false, reasons: [] }, CHANNEL_SWITCH: { enabled: false, reasons: [] },
      POWER_OPT: { enabled: false, reasons: ['共享冻结重算桥未接'] }, ROUTE_REBUILD: { enabled: false, reasons: [] }, NODE_REDEPLOY: { enabled: false, reasons: [] } } };
}
function sourceContext(rows: Record<string, string>[]) {
  useInterferenceStore().context = { task_id: 'T1', resource_revision: 'RES1', source_options: [], scene_count: 0,
    run_count: 0, active_run_ids: [], data_origin: 'SYNTHETIC_INTEGRATION', interference_sources: rows,
    capabilities: { scene_save: { enabled: false, reasons: [] }, analyze: { enabled: false, reasons: [] },
      cancel: { enabled: false, reasons: [] }, preview: { enabled: false, reasons: [] }, adopt_replan: { enabled: false, reasons: [] } } };
}

describe('专用干扰组件，不替代GIS宿主页验收', () => {
  it('首屏没有预设成功、默认源或可用分析按钮', () => {
    const root = mount(Panel, { sourceEditable: false, selectedNodeId: '', selectedLinkId: '' });
    expect(textOf(root)).toContain('尚未接入真实服务'); expect(textOf(root)).not.toContain('预生成');
    const button = find(root, row => row.tag === 'button' && textOf(row).includes('提交干扰分析'));
    expect(button?.props.disabled).toBe(true); expect(useInterferenceStore().draft.interferenceIds).toEqual([]);
  });
  it('预览只有未知全网指标时不显示打开方案或假百分比', () => {
    const store = useInterferenceStore(); store.selected = successful(); store.measureId = 'CM1'; store.measureOpen = true;
    store.preview = { run_id: 'RUN1', measure_id: 'CM1', run_version: 1, source_hash: 'a'.repeat(64), preview_hash: 'a'.repeat(64), before_configuration: {}, proposed_changes: { type: 'POWER_OPT' }, impact_after: null, metrics: null, available: true, unavailable_reasons: [] };
    const root = mount(MeasureDrawer); expect(textOf(root)).toContain('尚未重算'); expect(textOf(root)).toContain('共享冻结重算桥未接'); expect(textOf(root)).not.toContain('打开重算方案');
  });
  it('取消请求和真实参考方案分开显示，只有保存后才发openPlan', async () => {
    const store = useInterferenceStore(); store.selected = successful(); store.measureId = 'CM1'; store.measureOpen = true;
    const adoption: AdoptionDetail = { adoption_id: 'AD1', task_id: 'T1', run_id: 'RUN1', measure_id: 'CM1', adoption_version: 1,
      source_hash: 'a'.repeat(64), source_state: { state: 'CURRENT', reasons: [] }, planning_request_id: 'child-key', result_plan_state: null,
      created_at: '2026-10-23T08:00:00Z', updated_at: '2026-10-23T08:00:00Z', data_origin: 'SYNTHETIC_INTEGRATION',
      state: 'CANCEL_REQUESTED', planning_job_id: 'JOB1', planning_state: 'RUNNING', planning_progress: 40, result_plan_id: null, error: null };
    store.adoptions = [adoption];
    const opened = vi.fn(), root = mount(MeasureDrawer, { onOpenPlan: opened }); expect(textOf(root)).toContain('尚未确认停止'); expect(textOf(root)).not.toContain('打开重算方案');
    store.adoptions[0] = { ...store.adoptions[0]!, state: 'SUCCESS', result_plan_id: 'P2', result_plan_state: 'REFERENCE', planning_state: 'SUCCESS' }; await nextTick();
    expect(textOf(root)).toContain('未达标参考方案'); const button = find(root, row => row.tag === 'button' && textOf(row) === '打开重算方案'); (button!.props.onClick as () => void)(); expect(opened).toHaveBeenCalledWith('P2');
  });
  it('场景保存权限不足时禁用，历史不宣称被规划重置清除', () => {
    const store = useInterferenceStore(); store.taskContext = { taskId: 'T1', planId: 'P1', planVersion: 'V1' };
    const root = mount(SceneDrawer, { visible: true, taskContext: store.taskContext }); const save = find(root, row => row.tag === 'button' && textOf(row).includes('保存版本')); expect(save?.props.disabled).toBe(true);
    app?.unmount(); store.historyOpen = true; const history = mount(HistoryDrawer); expect(textOf(history)).toContain('规划重置不清除');
  });
  it('inactive和未知源不能新选，历史已选inactive允许取消但不能再加入', async () => {
    const store = useInterferenceStore(); store.taskContext = { taskId: 'T1', planId: 'P1', planVersion: 'V1' };
    sourceContext([{ interference_id: 'IF-OFF', name: '未生效', active: 'false' },
      { interference_id: 'IF-ON', name: '生效', active: 'true' }, { interference_id: 'IF-UNKNOWN', name: '未知', active: '' }]);
    const root = mount(SceneDrawer, { visible: true, taskContext: store.taskContext });
    const control = (id: string) => find(root, row => row.tag === 'input' && row.props.type === 'checkbox' && row.props.value === id)!;
    expect(control('IF-OFF').props.disabled).toBe(true); expect(control('IF-UNKNOWN').props.disabled).toBe(true);
    expect(control('IF-ON').props.disabled).toBe(false);
    store.draft.interferenceIds = ['IF-OFF']; await nextTick(); expect(control('IF-OFF').props.disabled).toBe(false);
    store.draft.interferenceIds = []; await nextTick(); expect(control('IF-OFF').props.disabled).toBe(true);
  });
  it('定位发出冻结干扰源ID，不用当前目录补历史空选源或缺失坐标', async () => {
    const store = useInterferenceStore(), view = successful(), selected = vi.fn();
    sourceContext([{ interference_id: 'IF-LIVE', name: '当前资源', active: 'true', lon: '114', lat: '38' }]);
    view.source.sourceCount = 1; view.source.interferenceIds = ['IF-FROZEN'];
    view.source.interferenceSources = [{ interferenceId: 'IF-FROZEN', sourceRow: { interference_id: 'IF-FROZEN', name: '冻结源', active: 'false', lon: '114', lat: '38' } }];
    store.selected = view;
    const root = mount(Panel, { sourceEditable: false, selectedNodeId: '', selectedLinkId: '', onSelectSource: selected });
    const button = find(root, row => row.props['aria-label'] === '定位干扰源 IF-FROZEN')!;
    expect(button.props.disabled).toBe(false); (button.props.onClick as () => void)(); expect(selected).toHaveBeenCalledWith('IF-FROZEN');
    expect(find(root, row => row.props['aria-label'] === '定位干扰源 IF-LIVE')).toBeUndefined();
    const invalid = successful(); invalid.source.interferenceSources = [{ interferenceId: 'IF-FROZEN', sourceRow: { interference_id: 'IF-FROZEN', lon: '', lat: '38', active: 'false' } }];
    store.selected = invalid; await nextTick(); expect(find(root, row => row.props['aria-label'] === '定位干扰源 IF-FROZEN')?.props.disabled).toBe(true);
    store.selected = successful(); await nextTick(); expect(find(root, row => row.props['aria-label'] === '定位干扰源 IF-LIVE')).toBeUndefined();
  });
  it('已保存场景一次列出多源多字段问题，展示中文名称和ID而非只报首项', () => {
    const store = useInterferenceStore(), view = successful();
    view.source.interferenceSources = [{ interferenceId: 'BAD-1', sourceRow: { interference_id: 'BAD-1', name: '我的干扰源', active: 'true',
      lon: '114', lat: '37', elevation_m: '', antenna_height_m: '20', center_freq_khz: '400', bandwidth_khz: '0',
      tx_power_dbm: '60', antenna_gain_dbi: '', interference_type: 'NOISE', pattern_type: 'OMNI', azimuth_deg: '', duty_cycle: '' } }];
    store.scene = { version: view.source, sourceState: { state: 'CURRENT', reasons: [] } };
    const root = mount(Panel, { sourceEditable: false, selectedNodeId: '', selectedLinkId: '' });
    const content = textOf(root);
    expect(content).toContain('我的干扰源'); expect(content).toContain('天线增益缺失'); expect(content).toContain('带宽超出允许范围');
    expect(content).toContain('BAD-1'); expect(content).toContain('antenna_gain_dbi');
    expect(find(root, row => row.tag === 'button' && textOf(row).includes('提交干扰分析'))?.props.disabled).toBe(true);
  });
  it('任务受理后即可看到实际参数及默认来源，历史运行保留原状态', () => {
    const store = useInterferenceStore(), view = successful();
    view.state = 'PENDING'; view.progress = 0; view.result = null; view.result_hash = null;
    view.analysis_parameters = [{ interference_id: 'IF-PARAM', name: '冻结参数源',
      parameters: { antenna_gain_dbi: -2, pattern_type: 'OMNI', duty_cycle: 1, azimuth_deg: null },
      sources: { antenna_gain_dbi: '冻结场景原始参数', pattern_type: '既有Jammer模型缺省全向OMNI',
        duty_cycle: '既有Jammer模型缺省连续发射，占空比1', azimuth_deg: '全向方向图不使用方位角' } }];
    store.selected = view;
    const root = mount(Panel, { sourceEditable: false, selectedNodeId: '', selectedLinkId: '' });
    expect(textOf(root)).toContain('分析有效参数及来源'); expect(textOf(root)).toContain('冻结参数源');
    expect(textOf(root)).toContain('天线增益'); expect(textOf(root)).toContain('-2');
    expect(textOf(root)).toContain('缺省连续发射'); expect(textOf(root)).not.toContain('历史运行未记录');
  });
});
