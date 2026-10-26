import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { defineComponent, h, nextTick, type App } from 'vue';
import { authorizeStore } from './helpers/auth';
import { node, renderer } from './helpers/vue-client';
import { useInterferenceStore } from '../src/stores/interference';
import { useInterferenceTargetNavigation } from '../src/composables/useInterferenceTargetNavigation';
import type { RunDetail } from '../src/types/interference-workbench';

// 仅测专用导航与冻结目标；SituationView/MapCanvas整页接线由P02单点验收。
const hash = 'a'.repeat(64);
function frozen(): RunDetail {
  const stamp = '2026-10-23T08:00:00Z';
  return { run_id: 'RUN1', task_id: 'T1', plan_id: 'P1', scene_id: 'SC1', scene_version_id: 'SV1', source_hash: hash, state: 'SUCCESS', adoptions: [],
    plan_version: 'V1', resource_revision: 'RES1', run_version: 1, progress: 100, phase: '分析完成', cancel_requested: false, error: null,
    source_state: { state: 'CURRENT', reasons: [] }, data_origin: 'SYNTHETIC_INTEGRATION', started_at: stamp, updated_at: stamp, result_hash: hash,
    adoption_capabilities: { FREQ_ADJUST: { enabled: false, reasons: [] }, CHANNEL_SWITCH: { enabled: false, reasons: [] }, POWER_OPT: { enabled: false, reasons: [] },
      ROUTE_REBUILD: { enabled: false, reasons: [] }, NODE_REDEPLOY: { enabled: false, reasons: [] } },
    source: { sceneId: 'SC1', taskId: 'T1', versionId: 'SV1', name: '场景', note: '', versionNo: 1, planId: 'P1', planVersion: 'V1', schemaVersion: 1,
      resourceRevision: 'RES1', sourceCount: 0, snapshotHash: hash, dataOrigin: 'SYNTHETIC_INTEGRATION', savedAt: stamp, previousVersionId: null,
      savedBy: 'u1', resourceContentHash: hash, source: 'SR4', interferenceIds: [], interferenceSources: [],
      planSnapshot: { taskId: 'T1', planId: 'P1', planVersion: 'V1', inputVersion: 'I1', conditionVersion: 'C1', resourceRevision: 'RES1', source: 'SR4', inputSnapshot: {}, rawSnapshot: { detail: {
      nodes: [{ node_id: 'N1', lon: '114', lat: '38' }, { node_id: 'N2', lon: '114.01', lat: '38' }],
      links: [{ link_id: 'L1', node_a_id: 'N1', node_b_id: 'N2' }],
    } } } },
    result: { analysis_id: 'RUN1', affected_nodes: [], affected_links: [], affected_area: {}, summary: { links: 1, jammers: 0, affected_nodes: 0, affected_links: 0, by_level: { SEVERE: 0, MODERATE: 0, MINOR: 0 } },
      notes: [], unresolved: [], measure_review: [], parameter_substitutions: [],
      measures: [{ measure_id: 'CM1', type: 'NODE_REDEPLOY', target_node_id: 'N1', target_link_id: 'L1',
        priority: 1, title: '迁移', detail: '', risk: '预测', available: true, unavailable_reasons: [], preview_hash: hash, pre_eval: null, restores: false,
        change_set: { type: 'NODE_REDEPLOY', target: { node_id: 'N1' }, detail: { to_lon: 114.02, to_lat: 38.01 } } }] },
  };
}
let pinia: ReturnType<typeof createPinia>, app: App | undefined;
beforeEach(() => { vi.stubGlobal('window', { confirm: vi.fn(() => false) }); pinia = createPinia(); setActivePinia(pinia); authorizeStore(); });
afterEach(() => { app?.unmount(); app = undefined; disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  const store = useInterferenceStore(); store.selected = frozen();
  const show = vi.fn(), locate = vi.fn(); let navigation!: ReturnType<typeof useInterferenceTargetNavigation>;
  app = renderer.createApp(defineComponent({ setup() {
    navigation = useInterferenceTargetNavigation({ blockedReason: () => '', show, locate, hidden: () => true });
    return () => h('div');
  } })); app.use(pinia); app.mount(node('root')); return { store, navigation, show, locate };
}

describe('数据库冻结目标导航', () => {
  it('定位只读冻结对象，不调用分析/保存/采纳，支持重复点击', async () => {
    const { store, navigation, show, locate } = setup(), before = JSON.stringify(store.selected);
    await navigation.list.value[0]!.targets[0]!.locate(); await nextTick();
    await navigation.list.value[0]!.targets[0]!.locate();
    expect(show).toHaveBeenCalledWith('node', 'N1'); expect(locate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(store.selected)).toBe(before); expect(store.pendingWrites).toEqual([]);
  });
  it('A→B→A的旧按钮在回到同名目标后仍失效', async () => {
    const { store, navigation, locate } = setup(), old = navigation.list.value[0]!.targets[0]!;
    store.selected = { ...frozen(), run_id: 'RUN2' }; store.selected = frozen();
    await old.locate(); expect(locate).not.toHaveBeenCalled();
    await navigation.list.value[0]!.targets[0]!.locate(); expect(locate).toHaveBeenCalledTimes(1);
  });
  it('缺冻结坐标或链路端点不能回查当前台账补齐', async () => {
    const { store, navigation, locate } = setup();
    const value = frozen(); value.source.planSnapshot.rawSnapshot.detail = { nodes: [{ node_id: 'N1', lon: null, lat: '38' }], links: [{ link_id: 'L1', node_a_id: 'N1', node_b_id: 'N2' }] };
    store.selected = value;
    expect(navigation.list.value[0]!.targets.every(target => !!target.reason)).toBe(true);
    await navigation.list.value[0]!.targets[1]!.locate(); expect(locate).not.toHaveBeenCalled();
  });
  it('措施后的定位和地图投影使用同一迁移坐标，不改原方案', async () => {
    const { store, navigation, locate } = setup(); store.measureId = 'CM1'; store.measureOpen = true;
    store.preview = { run_id: 'RUN1', measure_id: 'CM1', run_version: 1, source_hash: hash, preview_hash: hash,
      available: true, unavailable_reasons: [], before_configuration: {}, proposed_changes: {},
      impact_after: { affected_nodes: [], affected_links: [], affected_area: {}, summary: { links: 1, jammers: 0, affected_nodes: 0, affected_links: 0, by_level: { SEVERE: 0, MODERATE: 0, MINOR: 0 } } }, metrics: null };
    store.after = true;
    expect(store.mapProjection?.nodes.find(row => row.node_id === 'N1')?.lon).toBe(114.02);
    expect(navigation.drawer.value?.stateLabel).toBe('措施后预测');
    await navigation.drawer.value!.targets[0]!.locate(); expect(locate).toHaveBeenCalledTimes(1);
    const raw = store.selected!.source.planSnapshot.rawSnapshot.detail as { nodes: { lon: string }[] };
    expect(raw.nodes[0]!.lon).toBe('114');
  });
  it('卸载后旧点击不再改变GIS选择', async () => {
    const { navigation, show } = setup(), old = navigation.list.value[0]!.targets[0]!;
    app?.unmount(); await old.locate(); expect(show).not.toHaveBeenCalled();
  });
});

