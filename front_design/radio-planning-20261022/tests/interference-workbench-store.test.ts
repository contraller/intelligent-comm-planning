import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { authorizeStore } from './helpers/auth';
import { useInterferenceStore } from '../src/stores/interference';
import { ApiError } from '../src/services/types';
import type { InterferenceSceneServices, InterferenceSceneVersion } from '../src/types/interference-scene';
import type { InterferenceWorkbenchServices, RunDetail, WorkbenchContext, WriteReceipt } from '../src/types/interference-workbench';

const hash = 'a'.repeat(64), target = { taskId: 'T1', planId: 'P1', planVersion: 'V1' };
const version = (): InterferenceSceneVersion => ({ sceneId: 'SC1', taskId: 'T1', versionId: 'SV1', versionNo: 1, name: '场景', note: '', planId: 'P1', planVersion: 'V1', resourceRevision: 'RES1', sourceCount: 0, snapshotHash: hash, dataOrigin: 'SYNTHETIC_INTEGRATION', savedAt: '2026-10-23T08:00:00Z',
  schemaVersion: 1, previousVersionId: null, savedBy: 'u1', resourceContentHash: hash, source: 'SR4', interferenceIds: [], interferenceSources: [],
  planSnapshot: { taskId: 'T1', planId: 'P1', planVersion: 'V1', inputVersion: 'I1', conditionVersion: 'C1', resourceRevision: 'RES1', source: 'SR4', inputSnapshot: {}, rawSnapshot: { detail: { nodes: [], links: [] } } } });
const receipt = (): WriteReceipt => ({ request_id: 'accepted', task_id: 'T1', operation: 'SUBMIT_ANALYSIS', actor_id: 'u1', object_type: 'RUN', object_id: 'RUN1', accepted_version: 1, changed: true, status: 'ACCEPTED', source_hash: hash, data_origin: 'SYNTHETIC_INTEGRATION', accepted_at: '2026-10-23T08:00:00Z' });
const run = (): RunDetail => ({ ...receipt(), run_id: 'RUN1', scene_id: 'SC1', scene_version_id: 'SV1', plan_id: 'P1', plan_version: 'V1', resource_revision: 'RES1', run_version: 1, state: 'PENDING', progress: 0, phase: '待执行', cancel_requested: false, error: null, source_state: { state: 'CURRENT', reasons: [] }, started_at: '2026-10-23T08:00:00Z', updated_at: '2026-10-23T08:00:00Z', source: version(), result: null, result_hash: null, adoptions: [], adoption_capabilities: {} as RunDetail['adoption_capabilities'] });
function context(taskId = 'T1'): WorkbenchContext {
  return { task_id: taskId, resource_revision: 'RES1', source_options: [{ task_id: taskId, plan_id: taskId === 'T1' ? 'P1' : 'P2', plan_version: 'V1', input_version: 'I1', condition_version: 'C1', resource_revision: 'RES1', source: 'SR4', data_origin: 'SYNTHETIC_INTEGRATION', name: '确认方案', plan_snapshot_id: null, current: true, eligible: true, unavailable_reasons: [] }], scene_count: 1, run_count: 0, active_run_ids: [], data_origin: 'SYNTHETIC_INTEGRATION', interference_sources: [], capabilities: Object.fromEntries(['scene_save', 'analyze', 'cancel', 'preview', 'adopt_replan'].map(key => [key, { enabled: true, reasons: [] }])) as WorkbenchContext['capabilities'] };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let pinia: ReturnType<typeof createPinia>;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('window', { confirm: vi.fn(() => false) }); pinia = createPinia(); setActivePinia(pinia); authorizeStore(); });
afterEach(() => { disposePinia(pinia); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  const unused = vi.fn(async () => { throw new Error('意外调用'); });
  const workbench: InterferenceWorkbenchServices = { getContext: vi.fn(async input => context(input.task_id)), listSources: vi.fn(async input => ({ items: context().source_options, total: 1, page: input.page ?? 1, page_size: 20 })),
    submitRun: vi.fn(async () => receipt()), listRuns: vi.fn(async input => ({ items: [], total: 0, page: input.page ?? 1, page_size: 20 })), getProgress: unused,
    getRun: vi.fn(async () => run()), getPreview: unused, cancelRun: vi.fn(async () => ({ ...receipt(), operation: 'CANCEL_ANALYSIS', object_state: 'CANCEL_REQUESTED' })),
    adoptMeasure: unused, getAdoption: unused, cancelAdoption: unused, getOperation: unused };
  const scenes: InterferenceSceneServices = { listScenes: vi.fn(async input => ({ items: [], total: 0, page: input.page ?? 1, pageSize: 20 })),
    getScene: vi.fn(async () => ({ version: version(), sourceState: { state: 'CURRENT', reasons: [] } })), saveScene: unused, listSceneVersions: unused, getSceneReceipt: unused };
  const store = useInterferenceStore(); store.bindServices({ workbench, scenes }); return { store, workbench, scenes };
}

describe('持久化干扰工作流store', () => {
  it('未注入时不使用Mock，不默认挑选网络或IF-0008', async () => {
    const store = useInterferenceStore(); await store.load(); expect(store.connected).toBe(false); expect(store.taskContext).toBeNull(); expect(store.draft.interferenceIds).toEqual([]); expect(store.canAnalyze).toBe(false);
  });
  it('保存场景和提交分析分开，空源场景允许真实提交', async () => {
    const { store, workbench } = setup(); expect(await store.enterPlan(target)).toBe(true);
    await store.selectScene({ sceneId: 'SC1', versionId: 'SV1' }); expect(store.canAnalyze).toBe(true);
    await store.submitAnalysis(); expect(workbench.submitRun).toHaveBeenCalledWith(expect.objectContaining({ scene_version_id: 'SV1', snapshot_hash: hash }));
    expect(store.selected?.state).toBe('PENDING'); expect(store.selected?.result).toBeNull();
  });
  it('取消受理不等于算法停止', async () => {
    const { store, workbench } = setup(); await store.enterPlan(target); await store.selectRun('RUN1');
    vi.mocked(workbench.getRun).mockResolvedValue({ ...run(), state: 'CANCEL_REQUESTED', cancel_requested: true, run_version: 2 });
    await store.cancelAnalysis(); expect(store.selected?.state).toBe('CANCEL_REQUESTED'); expect(store.running).toBe(true);
  });
  it('草稿离开保护和重置不清数据库历史', async () => {
    const { store, workbench } = setup(); await store.enterPlan(target); await store.loadHistory(1); const history = store.history;
    store.draft.name = '未保存'; expect(await store.enterPlan({ taskId: 'T2', planId: 'P2', planVersion: 'V1' })).toBe(false);
    expect(store.taskContext).toEqual(target); store.resetDraft(); expect(store.dirty).toBe(false); expect(store.history).toEqual(history); expect(workbench.submitRun).not.toHaveBeenCalled();
  });
  it('保存等待时改写数组不影响发起快照', async () => {
    const { store, scenes } = setup(); await store.enterPlan(target); store.draft.name = '场景'; store.draft.interferenceIds = ['IF1'];
    const pending = deferred<Awaited<ReturnType<InterferenceSceneServices['saveScene']>>>(); vi.mocked(scenes.saveScene).mockReturnValue(pending.promise);
    const action = store.saveScene(); store.draft.interferenceIds.push('IF2'); expect(vi.mocked(scenes.saveScene).mock.calls[0]![0].interferenceIds).toEqual(['IF1']);
    pending.resolve({ requestId: 'accepted', operation: 'SAVE_INTERFERENCE_SCENE', status: 'SUCCEEDED', actorId: 'u1', taskId: 'T1', sceneId: 'SC1', baseSceneVersionId: null, versionId: 'SV1', versionNo: 1, planId: 'P1', planVersion: 'V1', resourceRevision: 'RES1', snapshotHash: hash, dataOrigin: 'SYNTHETIC_INTEGRATION', changed: true, createdAt: '2026-10-23T08:00:00Z' }); await action;
  });
  it('传输超时保留原请求，先核实回执，不自动换ID重发', async () => {
    const { store, workbench } = setup(); await store.enterPlan(target); await store.selectScene({ sceneId: 'SC1', versionId: 'SV1' });
    vi.mocked(workbench.submitRun).mockRejectedValue(new Error('超时')); await store.submitAnalysis(); expect(store.pendingWrites).toHaveLength(1);
    const id = store.pendingWrites[0]!.request_id; vi.mocked(workbench.getOperation).mockResolvedValue({ ...receipt(), request_id: id });
    await store.resolvePending(id); expect(workbench.submitRun).toHaveBeenCalledTimes(1); expect(store.pendingWrites).toHaveLength(0); expect(store.lastReceipt?.request_id).toBe(id);
  });
  it('会话失效后晚到响应不能恢复旧状态', async () => {
    const { store, workbench } = setup(); await store.enterPlan(target); const pending = deferred<RunDetail>(); vi.mocked(workbench.getRun).mockReturnValue(pending.promise);
    const action = store.selectRun('RUN1'); store.clearForSession(); pending.resolve(run()); await action; expect(store.selected).toBeNull(); expect(store.connected).toBe(false);
  });
  it('A→B→A隔离旧入口完成值和乱序上下文', async () => {
    const { store, workbench } = setup(), old = deferred<WorkbenchContext>(); vi.mocked(workbench.getContext).mockReturnValueOnce(old.promise);
    const first = store.enterPlan(target); await Promise.resolve(); await Promise.resolve();
    await store.enterPlan({ taskId: 'T2', planId: 'P2', planVersion: 'V1' }); await store.enterPlan(target);
    old.resolve(context()); expect(await first).toBe(false); expect(store.taskContext).toEqual(target);
  });
  it('null全网指标不阻止真实影响预览，也不伪造PlanningResult', async () => {
    const { store, workbench } = setup(); await store.enterPlan(target);
    const view = run(); view.state = 'SUCCESS'; view.progress = 100; view.result_hash = hash;
    view.result = { analysis_id: 'RUN1', affected_nodes: [], affected_links: [], affected_area: {}, summary: { links: 0, jammers: 0, affected_nodes: 0, affected_links: 0, by_level: { SEVERE: 0, MODERATE: 0, MINOR: 0 } }, measures: [{ measure_id: 'CM1', type: 'POWER_OPT', target_node_id: null, target_link_id: 'L1', priority: 1, title: '功率', detail: '', risk: '', available: true, unavailable_reasons: [], change_set: {}, preview_hash: hash, pre_eval: null, restores: false }], measure_review: [], unresolved: [], parameter_substitutions: [], notes: [] };
    vi.mocked(workbench.getRun).mockResolvedValue(view); await store.selectRun('RUN1');
    vi.mocked(workbench.getPreview).mockResolvedValue({ run_id: 'RUN1', measure_id: 'CM1', run_version: 1, source_hash: hash, preview_hash: hash, before_configuration: {}, proposed_changes: {}, impact_after: view.result, metrics: null, available: true, unavailable_reasons: [] });
    await store.loadMeasurePreview('CM1'); expect(store.canPreviewAfter).toBe(true); expect(store.selectedMeasurePreview?.metrics).toBeNull(); expect(store.selectedMeasurePreview).not.toHaveProperty('result');
    const late = deferred<Awaited<ReturnType<InterferenceWorkbenchServices['getPreview']>>>(); vi.mocked(workbench.getPreview).mockReturnValue(late.promise);
    const old = store.loadMeasurePreview('CM1'); vi.mocked(workbench.getRun).mockResolvedValue({ ...run(), run_id: 'RUN2' }); await store.selectRun('RUN2');
    late.resolve({ run_id: 'RUN1', measure_id: 'CM1', run_version: 1, source_hash: hash, preview_hash: hash, before_configuration: {}, proposed_changes: {}, impact_after: view.result, metrics: null, available: true, unavailable_reasons: [] });
    await old; expect(store.preview).toBeNull(); expect(store.queryError).toBe(''); expect(store.previewLoading).toBe(false);
  });
});
