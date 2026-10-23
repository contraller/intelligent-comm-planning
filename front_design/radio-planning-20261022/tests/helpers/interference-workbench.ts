import { expect, vi } from 'vitest';
import { nextTick, type App, type Component } from 'vue';
import GisFrozenPlanPanel from '../../src/components/GisFrozenPlanPanel.vue';
import GisPlanOperations from '../../src/components/GisPlanOperations.vue';
import InterferenceAnalysisPanel from '../../src/components/InterferenceAnalysisPanel.vue';
import InterferenceSceneDrawer from '../../src/components/InterferenceSceneDrawer.vue';
import InterferenceHistoryDrawer from '../../src/components/InterferenceHistoryDrawer.vue';
import InterferenceMeasureDrawer from '../../src/components/InterferenceMeasureDrawer.vue';
import ResourceReadStatus from '../../src/components/ResourceReadStatus.vue';
import DevicePortsPanel from '../../src/components/DevicePortsPanel.vue';
import LinkAssessmentPanel from '../../src/components/LinkAssessmentPanel.vue';
import GisDiagnosisPanel from '../../src/components/GisDiagnosisPanel.vue';
import LinkDetailPanel from '../../src/components/LinkDetailPanel.vue';
import DeviceMonitoringPanel from '../../src/components/DeviceMonitoringPanel.vue';
import LinkMonitoringPanel from '../../src/components/LinkMonitoringPanel.vue';
import { collaborationHttp } from '../../src/services/http';
import { previewService } from '../../src/services';
import { useInterferenceStore } from '../../src/stores/interference';
import type { ApiPlan } from '../../src/types/planning-api';
import type { GisNetwork } from '../../src/types/gis-plan';
import type { InterferenceSceneServices, InterferenceSceneVersion, SceneJsonObject } from '../../src/types/interference-scene';
import type { AdoptionDetail, AnalysisResult, InterferenceWorkbenchServices, MeasurePreview, RunDetail, TaskContext, WorkbenchContext } from '../../src/types/interference-workbench';
import { clientTemplate } from './vue-client';

const hash = 'a'.repeat(64), timestamp = '2026-10-23T08:00:00Z';
// fakeTimers会替换process.hrtime，模块加载时保留真实单调时钟。
const hostNow = process.hrtime.bigint.bind(process.hrtime);
export const measureTitles = ['频率调整', '信道切换', '功率优化', '路由重构', '节点重部署'];
const types = ['FREQ_ADJUST', 'CHANNEL_SWITCH', 'POWER_OPT', 'ROUTE_REBUILD', 'NODE_REDEPLOY'] as const;

export async function compileWorkbenchTemplates() {
  const templates: [Component, string][] = [[GisFrozenPlanPanel, 'GisFrozenPlanPanel'], [GisPlanOperations, 'GisPlanOperations'],
    [InterferenceAnalysisPanel, 'InterferenceAnalysisPanel'], [InterferenceSceneDrawer, 'InterferenceSceneDrawer'],
    [InterferenceHistoryDrawer, 'InterferenceHistoryDrawer'], [InterferenceMeasureDrawer, 'InterferenceMeasureDrawer'],
    [ResourceReadStatus, 'ResourceReadStatus'], [DevicePortsPanel, 'DevicePortsPanel'], [LinkAssessmentPanel, 'LinkAssessmentPanel'],
    [GisDiagnosisPanel, 'GisDiagnosisPanel'], [LinkDetailPanel, 'LinkDetailPanel'],
    [DeviceMonitoringPanel, 'DeviceMonitoringPanel'], [LinkMonitoringPanel, 'LinkMonitoringPanel']];
  for (const [component, name] of templates) {
    // 调用方显式提供的render替身不替换为缺少setup的真实模板。
    if (typeof component === 'object' && 'render' in component && typeof component.render === 'function' && !('__file' in component)) continue;
    await clientTemplate(component, `src/components/${name}.vue`, 'workbench-host-render.ts');
  }
}

export function reportHostFailure(task: { name: string; result?: { state: string } }, stage: string, snapshot: () => unknown) {
  if (task.result?.state !== 'fail') return;
  try { console.error('[P04_HOST_WAIT]', JSON.stringify({ test: task.name, stage, state: snapshot() })); }
  catch (reason) { console.error('[P04_HOST_WAIT]', task.name, stage, String(reason)); }
}

export function traceHostErrors(app: App) {
  app.config.errorHandler = (reason, _instance, info) => {
    console.error('[P04_VUE_HOST_ERROR]', info, reason instanceof Error ? reason.stack : String(reason));
    throw reason;
  };
}

export async function hostStep<T>(stage: string, action: () => T | Promise<T>): Promise<T> {
  const started = hostNow();
  try { return await action(); }
  finally {
    if (process.env.P04_HOST_TIMINGS === '1') console.info('[P04_HOST_TIMING]', JSON.stringify({
      test: expect.getState().currentTestName ?? null, stage,
      elapsedMs: Number(hostNow() - started) / 1e6,
    }));
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export async function settleWorkbench() {
  for (let i = 0; i < 60; i++) { await Promise.resolve(); await nextTick(); }
}

// 所有默认值均为显式 UNIT_TEST DTO；不复用旧干扰 storage，也不模拟算法结论。
// 这是组件/服务契约测试夹具，不是真实 HTTP、算法或浏览器验收证据。
export async function createWorkbenchFixture(supplied?: ApiPlan) {
  const plan: ApiPlan = supplied ?? {
    id: 'UNIT-PLAN', taskId: 'UNIT-TASK', jobId: 'UNIT-JOB', revision: 'UNIT-PLAN-REV', version: 'V3', name: '构造确认方案',
    note: 'UNIT_TEST 服务契约载荷，非算法结果', inputVersion: 'UNIT-INPUT', conditionVersion: 'UNIT-CONDITION', resourceRevision: 'UNIT-RESOURCE',
    input: { name: '构造输入', description: 'UNIT_TEST', bbox: [112, 36, 114, 38], stationIds: ['UNIT-N1', 'UNIT-N2', 'UNIT-N3'],
      demands: [], presetId: 'UNIT-PRESET', frequencyId: 'UNIT-FREQUENCY', constraints: { connectivityPercent: 80, maxRelayHops: 3, survivabilityPercent: 70 } },
    parentPlanId: null, state: 'CONFIRMED', sourceChanged: false, current: true, savedAt: timestamp, confirmedAt: timestamp, source: 'SR4',
    result: { snapshotId: 'UNIT-SNAPSHOT', nodes: [], devices: [], links: [], coverage: { contour: null, rasterPng: null },
      configuration: { deployment: [], devices: [], routes: [], frequencies: [] },
      metrics: { connectivityPercent: null, totalRadiatedPowerW: null, survivabilityPercent: null, coveragePercent: null, delayMs: null },
      deploymentCost: null, costUnit: '', checks: [], notes: ['UNIT_TEST，非算法验收'] },
    outcome: { code: 0, message: 'UNIT_TEST 显式构造响应', suggestions: [], gap: [] },
  };
  const target: TaskContext = { taskId: plan.taskId, planId: plan.id, planVersion: plan.version };
  const revision = plan.resourceRevision ?? 'UNIT-RESOURCE';
  const source = {
    task_id: plan.taskId, plan_id: plan.id, plan_version: plan.version, input_version: plan.inputVersion ?? 'UNIT-INPUT',
    condition_version: plan.conditionVersion, resource_revision: revision, source: 'SR4', data_origin: 'SYNTHETIC_INTEGRATION',
    name: plan.name, plan_snapshot_id: plan.result.snapshotId, current: true, eligible: true, unavailable_reasons: [] as string[],
  };
  const network: GisNetwork = {
    identity: { plan_id: plan.id, task_id: plan.taskId, snapshot_id: plan.result.snapshotId,
      input_version: source.input_version, condition_version: source.condition_version, resource_revision: revision,
      state: 'CONFIRMED', source_changed: false, source: 'SR4', data_origin: 'SYNTHETIC_INTEGRATION' },
    nodes: [
      { id: 'UNIT-N1', name: '构造节点甲', coordinate: [113, 37], status: null, alert: null },
      { id: 'UNIT-N2', name: '构造节点乙', coordinate: [113.1, 37.1], status: null, alert: null },
      { id: 'UNIT-N3', name: '构造节点丙', coordinate: [113.2, 37.2], status: null, alert: null },
    ],
    devices: [
      { id: 'UNIT-D1', station_id: 'UNIT-N1', model_id: 'UNIT-M', device_class: 'HF', frequency_khz: 0, tx_power_dbm: 0, antenna_height_m: null },
      { id: 'UNIT-D2', station_id: 'UNIT-N2', model_id: 'UNIT-M', device_class: 'HF', frequency_khz: null, tx_power_dbm: null, antenna_height_m: null },
      { id: 'UNIT-D3', station_id: 'UNIT-N3', model_id: 'UNIT-M', device_class: 'HF', frequency_khz: null, tx_power_dbm: null, antenna_height_m: null },
    ],
    links: ['UNIT-L1', 'UNIT-L2'].map((id, index) => ({ id, a: 'UNIT-N1', b: index ? 'UNIT-N3' : 'UNIT-N2',
      device_a: 'UNIT-D1', device_b: index ? 'UNIT-D3' : 'UNIT-D2', device_class: 'HF' as const, frequency_khz: null, backup: false, planned_state: 'WARNING' as const })),
    demands: [], routes: [], paths_state: 'missing', paths_message: 'UNIT_TEST 未构造通联路由',
  };
  const context: WorkbenchContext = {
    task_id: plan.taskId, resource_revision: revision, source_options: [source], scene_count: 1, run_count: 1, active_run_ids: [],
    data_origin: 'SYNTHETIC_INTEGRATION',
    interference_sources: [
      { interference_id: 'UNIT-IF1', name: '构造干扰源甲', active: 'true', lon: '113', lat: '37' },
      { interference_id: 'UNIT-IF2', name: '构造干扰源乙', active: 'true', lon: '113.1', lat: '37.1' },
      { interference_id: 'UNIT-IF3', name: '构造未生效源', active: 'false', lon: '113.2', lat: '37.2' },
    ],
    capabilities: { scene_save: { enabled: true, reasons: [] }, analyze: { enabled: true, reasons: [] },
      cancel: { enabled: true, reasons: [] }, preview: { enabled: true, reasons: [] }, adopt_replan: { enabled: true, reasons: [] } },
  };
  const scene: InterferenceSceneVersion = {
    sceneId: 'UNIT-SCENE', taskId: plan.taskId, versionId: 'UNIT-SCENE-V1', versionNo: 1, name: '构造冻结场景',
    planId: plan.id, planVersion: plan.version, resourceRevision: revision, sourceCount: 1, snapshotHash: hash,
    dataOrigin: 'SYNTHETIC_INTEGRATION', savedAt: timestamp, schemaVersion: 1, note: 'UNIT_TEST，非实测',
    previousVersionId: null, savedBy: 'UNIT-ACTOR', resourceContentHash: hash, source: 'SR4',
    interferenceIds: ['UNIT-IF1'], interferenceSources: [{ interferenceId: 'UNIT-IF1', sourceRow: context.interference_sources[0]! }],
    planSnapshot: { ...target, inputVersion: source.input_version, conditionVersion: source.condition_version, resourceRevision: revision,
      source: 'SR4', inputSnapshot: {}, rawSnapshot: { detail: {
        nodes: network.nodes.map(row => ({ node_id: row.id, name: row.name, lon: row.coordinate[0], lat: row.coordinate[1] })),
        links: network.links.map(row => ({ link_id: row.id, node_a_id: row.a, node_b_id: row.b })),
      } } },
  };
  const result: AnalysisResult = {
    analysis_id: 'UNIT-RUN', affected_nodes: [{ node_id: 'UNIT-N1', level: 'SEVERE', snr_before_db: 18.2, sinr_after_db: 3.1 }],
    affected_links: [{ link_id: 'UNIT-L1', level: 'SEVERE', snr_before_db: 18.2, sinr_after_db: 3.1 },
      { link_id: 'UNIT-L2', level: 'MINOR', snr_before_db: 19, sinr_after_db: 15 }],
    affected_area: { type: 'FeatureCollection', features: [] },
    summary: { links: 2, jammers: 1, affected_nodes: 1, affected_links: 2, by_level: { SEVERE: 1, MODERATE: 0, MINOR: 1 } },
    measures: types.map((type, index) => {
      const detail: SceneJsonObject = type === 'NODE_REDEPLOY' ? { to_lon: 116.2, to_lat: 38.8 } : { frequency_khz: 54321 };
      return { measure_id: `UNIT-CM${index + 1}`, type, title: measureTitles[index]!,
      target_node_id: 'UNIT-N1', target_link_id: 'UNIT-L1', priority: index + 1, detail: 'UNIT_TEST 服务载荷', risk: '构造预测，非实测',
      available: true, unavailable_reasons: [], preview_hash: hash, pre_eval: null, restores: false,
      change_set: { type, target: { node_id: 'UNIT-N1' }, detail } };
    }),
    unresolved: [], measure_review: [], parameter_substitutions: [], notes: ['UNIT_TEST 构造影响，不是算法验收'],
  };
  const run: RunDetail = {
    run_id: 'UNIT-RUN', task_id: plan.taskId, scene_id: scene.sceneId, scene_version_id: scene.versionId,
    plan_id: plan.id, plan_version: plan.version, resource_revision: revision, run_version: 1, state: 'SUCCESS', progress: 100,
    phase: '构造服务响应', cancel_requested: false, error: null, source_hash: hash,
    source_state: { state: 'CURRENT', reasons: [] }, data_origin: 'SYNTHETIC_INTEGRATION', started_at: timestamp, updated_at: timestamp,
    source: scene, result, result_hash: hash, adoptions: [],
    adoption_capabilities: { FREQ_ADJUST: { enabled: true, reasons: [] }, CHANNEL_SWITCH: { enabled: true, reasons: [] },
      POWER_OPT: { enabled: true, reasons: [] }, ROUTE_REBUILD: { enabled: true, reasons: [] }, NODE_REDEPLOY: { enabled: true, reasons: [] } },
  };
  const preview: MeasurePreview = { run_id: run.run_id, measure_id: 'UNIT-CM1', run_version: 1, source_hash: hash, preview_hash: hash,
    before_configuration: { frequency_khz: null }, proposed_changes: { frequency_khz: 54321 }, impact_after: result,
    metrics: { connectivityPercent: 83.21 }, available: true, unavailable_reasons: [] };
  async function unexpected(): Promise<never> { throw new Error('只读入口意外调用业务写入或未设置的服务'); }
  const workbench = {
    getContext: vi.fn<InterferenceWorkbenchServices['getContext']>(async input => ({ ...structuredClone(context), task_id: input.task_id ?? null,
      source_options: context.source_options.filter(row => !input.task_id || row.task_id === input.task_id).map(row => structuredClone(row)) })),
    listSources: vi.fn<InterferenceWorkbenchServices['listSources']>(async input => ({ items: structuredClone(context.source_options), total: context.source_options.length, page: input.page ?? 1, page_size: input.page_size ?? 20 })),
    getRun: vi.fn<InterferenceWorkbenchServices['getRun']>(async input => {
      if (input.task_id !== run.task_id || input.run_id !== run.run_id) throw new Error('指定运行不存在');
      return structuredClone(run);
    }),
    getProgress: vi.fn<InterferenceWorkbenchServices['getProgress']>(async input => {
      if (input.task_id !== run.task_id || input.run_id !== run.run_id) throw new Error('指定运行不存在');
      return structuredClone(run);
    }),
    listRuns: vi.fn<InterferenceWorkbenchServices['listRuns']>(async input => ({ items: [{ ...structuredClone(run), adoption_count: run.adoptions.length }], total: 1, page: input.page ?? 1, page_size: input.page_size ?? 20 })),
    getPreview: vi.fn<InterferenceWorkbenchServices['getPreview']>(async input => {
      if (input.task_id !== run.task_id || input.run_id !== run.run_id || input.expected_run_version !== run.run_version
        || !run.result?.measures.some(row => row.measure_id === input.measure_id)) throw new Error('指定措施或运行版本不存在');
      return { ...structuredClone(preview), measure_id: input.measure_id };
    }),
    submitRun: vi.fn<InterferenceWorkbenchServices['submitRun']>(unexpected), cancelRun: vi.fn<InterferenceWorkbenchServices['cancelRun']>(unexpected),
    adoptMeasure: vi.fn<InterferenceWorkbenchServices['adoptMeasure']>(unexpected), cancelAdoption: vi.fn<InterferenceWorkbenchServices['cancelAdoption']>(unexpected),
    getAdoption: vi.fn<InterferenceWorkbenchServices['getAdoption']>(unexpected), getOperation: vi.fn<InterferenceWorkbenchServices['getOperation']>(unexpected),
  } satisfies InterferenceWorkbenchServices;
  const scenes = {
    listScenes: vi.fn<InterferenceSceneServices['listScenes']>(async input => ({ items: [structuredClone(scene)], total: 1, page: input.page ?? 1, pageSize: input.pageSize ?? 20 })),
    getScene: vi.fn<InterferenceSceneServices['getScene']>(async () => ({ version: structuredClone(scene), sourceState: { state: 'CURRENT', reasons: [] } })),
    listSceneVersions: vi.fn<InterferenceSceneServices['listSceneVersions']>(async () => ({ items: [structuredClone(scene)], total: 1, page: 1, pageSize: 20 })),
    saveScene: vi.fn<InterferenceSceneServices['saveScene']>(unexpected), getSceneReceipt: vi.fn<InterferenceSceneServices['getSceneReceipt']>(unexpected),
  } satisfies InterferenceSceneServices;
  const commands = [workbench.submitRun, workbench.cancelRun, workbench.adoptMeasure, workbench.cancelAdoption,
    workbench.getAdoption, workbench.getOperation, scenes.saveScene, scenes.getSceneReceipt];
  expect(new Set(commands).size, '每个服务命令必须有独立调用计数').toBe(commands.length);
  function bind() {
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'getContext').mockImplementation(workbench.getContext);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'listSources').mockImplementation(workbench.listSources);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'getRun').mockImplementation(workbench.getRun);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'getProgress').mockImplementation(workbench.getProgress);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'listRuns').mockImplementation(workbench.listRuns);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'getPreview').mockImplementation(workbench.getPreview);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'submitRun').mockImplementation(workbench.submitRun);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'cancelRun').mockImplementation(workbench.cancelRun);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'adoptMeasure').mockImplementation(workbench.adoptMeasure);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'cancelAdoption').mockImplementation(workbench.cancelAdoption);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'getAdoption').mockImplementation(workbench.getAdoption);
    vi.spyOn(collaborationHttp.interferenceWorkbench, 'getOperation').mockImplementation(workbench.getOperation);
    vi.spyOn(collaborationHttp.interferenceScenes, 'listScenes').mockImplementation(scenes.listScenes);
    vi.spyOn(collaborationHttp.interferenceScenes, 'getScene').mockImplementation(scenes.getScene);
    vi.spyOn(collaborationHttp.interferenceScenes, 'listSceneVersions').mockImplementation(scenes.listSceneVersions);
    vi.spyOn(collaborationHttp.interferenceScenes, 'saveScene').mockImplementation(scenes.saveScene);
    vi.spyOn(collaborationHttp.interferenceScenes, 'getSceneReceipt').mockImplementation(scenes.getSceneReceipt);
    vi.spyOn(collaborationHttp.gisPlans, 'getNetwork').mockImplementation(async input => {
      if (input.taskId !== target.taskId || input.planId !== target.planId) throw new Error('指定冻结网络不存在');
      return structuredClone(network);
    });
    vi.spyOn(collaborationHttp.gisPlans, 'getSurface').mockResolvedValue({ identity: network.identity, terrain: null,
      terrain_notice: 'UNIT_TEST 未提供地形', coverage: null, coverage_notice: 'UNIT_TEST 未提供覆盖' });
    const original = vi.isMockFunction(previewService.getPlanningPlan)
      ? vi.mocked(previewService.getPlanningPlan).getMockImplementation()
      : previewService.getPlanningPlan.bind(previewService);
    if (!original) throw new Error('规划读取服务没有可保留的实现');
    vi.spyOn(previewService, 'getPlanningPlan').mockImplementation(input => input.context === 'gis'
      ? input.taskId === plan.taskId && input.planId === plan.id ? Promise.resolve(structuredClone(plan)) : Promise.reject(new Error('目标方案不存在或不属于指定任务'))
      : original(input));
    vi.spyOn(previewService, 'querySavedPlanningPlans').mockImplementation(async input => ({ items: [structuredClone(plan)], total: 1, pageNum: input.pageNum, pageSize: input.pageSize }));
  }
  function assertNoWrites() {
    for (const method of [workbench.submitRun, workbench.cancelRun, workbench.adoptMeasure, workbench.cancelAdoption, scenes.saveScene]) expect(method).not.toHaveBeenCalled();
  }
  const adopted: AdoptionDetail = { adoption_id: 'UNIT-ADOPTION', task_id: target.taskId, run_id: run.run_id, measure_id: preview.measure_id,
    adoption_version: 1, state: 'SUCCESS', source_hash: hash, source_state: { state: 'CURRENT', reasons: [] },
    planning_request_id: 'UNIT-REPLAN-REQUEST', planning_job_id: 'UNIT-REPLAN-JOB', planning_state: 'SUCCESS', planning_progress: 100,
    result_plan_id: 'UNIT-REPLAN', result_plan_state: 'SAVED', error: null, data_origin: 'SYNTHETIC_INTEGRATION', created_at: timestamp, updated_at: timestamp };
  return { plan, target, source, network, context, scene, run, preview, adopted, workbench, scenes, bind, assertNoWrites };
}
export type WorkbenchFixture = Awaited<ReturnType<typeof createWorkbenchFixture>>;

export async function enterWorkbenchStore(fixture: WorkbenchFixture) {
  const store = useInterferenceStore(); store.bindServices(fixture);
  expect(await store.enterPlan(fixture.target)).toBe(true);
  await store.selectScene({ sceneId: fixture.scene.sceneId, versionId: fixture.scene.versionId });
  await store.selectRun(fixture.run.run_id);
  return store;
}

interface HostTree { tag: string; text: string; props: Record<string, unknown>; children: HostTree[] }
export function workbenchText(root: HostTree): string {
  return (root.tag === '#comment' ? '' : root.text.replace(/<[^>]+>/g, '')) + root.children.map(workbenchText).join('');
}
export function workbenchNode(root: HostTree, predicate: (row: HostTree) => boolean): HostTree | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const found = workbenchNode(child, predicate); if (found) return found; }
}
export async function clickWorkbench(root: HostTree, label: string | ((row: HostTree) => boolean)) {
  const found = workbenchNode(root, row => row.tag === 'button' && (typeof label === 'string' ? workbenchText(row).trim() === label : label(row)));
  expect(found, typeof label === 'string' ? label : '工作流按钮').toBeDefined();
  expect(found!.props.disabled).not.toBe(true);
  const action = found!.props.onClick;
  if (typeof action !== 'function') throw new Error('按钮未绑定命令');
  await action(); await settleWorkbench();
}
export async function openWorkbenchFromPage(root: HostTree, fixture: WorkbenchFixture, openRun = true) {
  await clickWorkbench(root, '干扰分析');
  expect(workbenchNode(root, row => row.props['aria-label'] === '数据库冻结方案'), '分析命令进入冻结工作区').toBeDefined();
  await clickWorkbench(root, '打开冻结网络');
  const store = useInterferenceStore();
  expect(store.taskContext).toEqual(fixture.target);
  if (openRun) {
    await clickWorkbench(root, row => workbenchText(row).trim().startsWith('历史 '));
    await clickWorkbench(root, row => String(row.props.class).includes('history-row') && workbenchText(row).includes(fixture.run.run_id));
    expect(store.selected?.run_id).toBe(fixture.run.run_id);
    expect(fixture.workbench.getRun).toHaveBeenCalledWith({ task_id: fixture.target.taskId, run_id: fixture.run.run_id }, expect.any(AbortSignal));
  }
  fixture.assertNoWrites();
  return store;
}
export function analysisMap(root: HostTree) {
  const found = workbenchNode(root, row => row.tag === 'map-probe' && !!row.props.interferenceProjection);
  expect(found, '独立干扰地图投影').toBeDefined();
  return found!.props;
}
