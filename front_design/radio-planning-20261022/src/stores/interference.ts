import { computed, markRaw, ref, shallowRef, watch, type Raw } from 'vue';
import { defineStore } from 'pinia';
import { randomUuid } from '../services/random-uuid';
import { ApiError } from '../services/types';
import { useAuthStore } from './auth';
import type { InterferenceSceneDetail, InterferenceScenePage, InterferenceSceneReceipt, InterferenceSceneSave, InterferenceSceneServices } from '../types/interference-scene';
import type { AdoptionDetail, InterferenceWorkbenchServices, MapProjection, MeasurePreview, Operation, Page,
  Impact, Measure, RunDetail, RunProgress, SourceOption, TaskContext, WorkbenchContext, WriteReceipt } from '../types/interference-workbench';
import type { SceneJsonObject } from '../types/interference-scene';

const activeStates = ['PENDING', 'RUNNING', 'CANCEL_REQUESTED'];
type PendingWrite = { request_id: string; task_id: string; operation: Operation; body: object; pathId?: string };
type Services = { workbench: InterferenceWorkbenchServices; scenes: InterferenceSceneServices };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type FrozenDto<T extends object> = Readonly<Raw<T>>;
// 服务DTO只整体替换：克隆隔离调用者，浅冻结根对象，Raw阻止Pinia递归解包JSON。
const frozenDto = <T extends object>(value: T): FrozenDto<T> => Object.freeze(markRaw(copy(value)));

// 数据库场景、运行、采纳分别管理；未接服务时没有构造演示或隐式成功回退。
export const useInterferenceStore = defineStore('interference', () => {
  const auth = useAuthStore();
  let services: Services | null = null, epoch = 0, previewSerial = 0, active = false;
  const controllers = new Map<string, AbortController>(), sequences = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const taskContext = ref<TaskContext | null>(null), context = ref<WorkbenchContext | null>(null);
  const sourceDirectory = ref<Page<SourceOption> | null>(null), sourceSearch = ref('');
  const selected = shallowRef<FrozenDto<RunDetail> | null>(null), preview = shallowRef<FrozenDto<MeasurePreview> | null>(null);
  const scene = shallowRef<FrozenDto<InterferenceSceneDetail> | null>(null), scenes = ref<InterferenceScenePage | null>(null);
  const sceneVersions = ref<InterferenceScenePage | null>(null);
  const draft = ref({ sceneId: '', name: '', note: '', interferenceIds: [] as string[] });
  const baselineDraft = ref(''), pendingScene = ref<InterferenceSceneSave | null>(null);
  const pendingWrites = ref<PendingWrite[]>([]), adoptions = ref<AdoptionDetail[]>([]);
  const lastReceipt = ref<WriteReceipt | null>(null);
  const lastSceneReceipt = ref<InterferenceSceneReceipt | null>(null);
  const history = ref<Page<RunProgress & { adoption_count: number }> | null>(null);
  const historySearch = ref(''), historyState = ref<RunProgress['state'] | ''>('');
  const measureId = ref(''), after = ref(false), historyOpen = ref(false), measureOpen = ref(false), sceneOpen = ref(false);
  const levels = ref(['SEVERE', 'MODERATE', 'MINOR']), busy = ref(false), loading = ref(false), previewLoading = ref(false);
  const error = ref(''), queryErrors = ref<Record<string, string>>({}), notice = ref(''), connected = ref(false);
  const queryError = computed(() => Object.values(queryErrors.value).filter(Boolean).join('；'));
  const readable = computed(() => !auth.blocked && auth.can('situation.view') && auth.can('planning.view'));
  const executable = computed(() => readable.value && auth.can('planning.execute') && connected.value);
  const adoptable = computed(() => executable.value && auth.can('planning.save'));
  const locked = computed(() => busy.value || loading.value);
  const dirty = computed(() => JSON.stringify(draft.value) !== baselineDraft.value);
  const running = computed(() => !!context.value?.active_run_ids.length || !!selected.value && activeStates.includes(selected.value.state));
  const analysisId = computed(() => selected.value?.run_id ?? '');
  const measure = computed<FrozenDto<Measure> | null>(() => {
    const value = selected.value?.result?.measures.find(row => row.measure_id === measureId.value);
    return value ? frozenDto(value) : null;
  });
  const selectedMeasurePreview = computed(() => preview.value);
  const previewUnavailableReason = computed(() => !measure.value ? '' : previewLoading.value ? '预览查询中'
    : !preview.value ? '尚未取得此措施的冻结预览' : !preview.value.available ? preview.value.unavailable_reasons.join('；')
    : !preview.value.impact_after ? '未提供措施后影响，保留措施前状态' : '');
  const canPreviewAfter = computed(() => !!preview.value?.available && !!preview.value.impact_after && !previewUnavailableReason.value);
  const effectiveAfter = computed(() => after.value && canPreviewAfter.value);
  const impact = computed<FrozenDto<Impact> | null>(() => {
    const value = effectiveAfter.value ? preview.value!.impact_after : selected.value?.result;
    return value ? frozenDto({ affected_nodes: value.affected_nodes, affected_links: value.affected_links,
      affected_area: value.affected_area, summary: value.summary }) : null;
  });
  const filteredImpact = computed<FrozenDto<Impact> | null>(() => impact.value ? frozenDto({ ...impact.value,
    affected_nodes: impact.value.affected_nodes.filter(row => levels.value.includes(row.level)),
    affected_links: impact.value.affected_links.filter(row => levels.value.includes(row.level)),
  }) : null);
  const mapProjection = computed<FrozenDto<MapProjection> | null>(() => {
    const run = selected.value, effect = filteredImpact.value;
    if (!run || !effect) return null;
    const detail = copy(run.source.planSnapshot.rawSnapshot.detail) as SceneJsonObject;
    const nodes = (detail.nodes ?? []) as SceneJsonObject[], links = (detail.links ?? []) as SceneJsonObject[];
    if (effectiveAfter.value && measure.value?.type === 'NODE_REDEPLOY') {
      const change = measure.value.change_set, target = change.target as SceneJsonObject, values = change.detail as SceneJsonObject;
      const node = nodes.find(row => row.node_id === target.node_id);
      if (node) { node.lon = values.to_lon ?? null; node.lat = values.to_lat ?? null; }
    }
    return frozenDto<MapProjection>({ taskId: run.task_id, planId: run.plan_id, sceneVersionId: run.scene_version_id, runId: run.run_id,
      sourceHash: run.source_hash, phase: effectiveAfter.value ? 'PREVIEW' : 'BEFORE', nodes, links,
      sources: copy(run.source.interferenceSources.map(row => row.sourceRow)), impact: copy(effect) });
  });
  const selectedSource = computed(() => context.value?.source_options.find(row => row.plan_id === taskContext.value?.planId
    && row.task_id === taskContext.value?.taskId && row.plan_version === taskContext.value?.planVersion) ?? null);
  const canAnalyze = computed(() => executable.value && !!selectedSource.value?.eligible && !!scene.value && !dirty.value
    && scene.value.sourceState.state === 'CURRENT' && scene.value.version.planId === taskContext.value?.planId
    && scene.value.version.planVersion === taskContext.value?.planVersion && !pendingScene.value && !pendingWrites.value.length && !running.value);
  const historyTotal = computed(() => history.value?.total ?? context.value?.run_count ?? 0);
  const historyPage = computed(() => history.value?.page ?? 1);

  function invalidate() { epoch++; previewSerial++; controllers.forEach(controller => controller.abort()); controllers.clear(); sequences.clear(); loading.value = false; previewLoading.value = false; clearTimer(); }
  const valid = (generation: number, session: number) => generation === epoch && session === auth.generation && readable.value;
  function api() { if (!services) throw new Error('干扰工作流尚未接入真实服务'); return services; }
  function report(reason: unknown, channel?: string) {
    const message = reason instanceof Error ? reason.message : '干扰操作失败';
    if (channel) queryErrors.value[channel] = message; else error.value = message;
  }
  function clearTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function schedule() {
    clearTimer();
    if (active && readable.value && connected.value && (running.value || adoptions.value.some(row => activeStates.includes(row.state))))
      timer = setTimeout(() => { void query(); }, 1500);
  }
  async function read<T>(key: string, action: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void) {
    const generation = epoch, session = auth.generation, number = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, number); controllers.get(key)?.abort();
    const controller = new AbortController(); controllers.set(key, controller);
    try {
      const value = await action(controller.signal);
      if (valid(generation, session) && sequences.get(key) === number) { accept(value); delete queryErrors.value[key]; }
      return valid(generation, session) && sequences.get(key) === number;
    } catch (reason) {
      if (!controller.signal.aborted && valid(generation, session) && sequences.get(key) === number) report(reason, key);
      return false;
    } finally { if (controllers.get(key) === controller) controllers.delete(key); }
  }
  function newDraft() {
    scene.value = null; sceneVersions.value = null;
    draft.value = { sceneId: 'ISC-' + randomUuid(), name: '', note: '', interferenceIds: [] };
    baselineDraft.value = JSON.stringify(draft.value);
  }
  function resetDraft() {
    if (scene.value) {
      const saved = scene.value.version;
      draft.value = { sceneId: saved.sceneId, name: saved.name, note: saved.note, interferenceIds: [...saved.interferenceIds] };
      baselineDraft.value = JSON.stringify(draft.value);
    } else newDraft();
  }
  async function prepareLeave() {
    if (busy.value) { notice.value = '写入正在受理，请先核实回执'; return false; }
    return !dirty.value && !pendingScene.value && !pendingWrites.value.length
      || window.confirm('有未保存草稿或待核实请求。离开不会取消服务器运行，是否离开？');
  }
  function bindServices(value: Services) { invalidate(); services = value; connected.value = true; error.value = ''; if (active) void load(); }
  async function load() {
    if (!readable.value) return;
    const generation = epoch, target = taskContext.value ? { ...taskContext.value } : null;
    loading.value = true;
    try {
      const loaded = await read('context', signal => api().workbench.getContext(target ? { task_id: target.taskId } : {}, signal), value => { context.value = value; });
      if (!loaded) return;
      if (target && generation === epoch && !selectedSource.value) {
        await read('selected-source', signal => api().workbench.listSources({ task_id: target.taskId, page: 1, page_size: 100, search: target.planId }, signal), value => {
          const source = value.items.find(row => row.task_id === target.taskId && row.plan_id === target.planId && row.plan_version === target.planVersion);
          if (source && context.value && generation === epoch) context.value = { ...context.value, source_options: [...context.value.source_options, source] };
        });
      }
      if (generation === epoch) await loadSourceOptions(sourceDirectory.value?.page ?? 1);
      if (target && generation === epoch) await loadScenes();
    } finally { if (generation === epoch) { loading.value = false; schedule(); } }
  }
  async function enterPlan(input: TaskContext): Promise<boolean> {
    const target = copy(input);
    if (!readable.value || !await prepareLeave()) return false;
    if (!target.taskId || !target.planId || !/^V[1-9][0-9]*$/.test(target.planVersion)) { error.value = '目标方案身份不完整'; return false; }
    invalidate(); taskContext.value = target; selected.value = null; preview.value = null; measureId.value = '';
    const generation = epoch;
    history.value = null; adoptions.value = []; newDraft(); error.value = ''; queryErrors.value = {};
    lastReceipt.value = null; lastSceneReceipt.value = null;
    await load();
    return generation === epoch && taskContext.value?.taskId === target.taskId && taskContext.value?.planId === target.planId && !!selectedSource.value;
  }
  async function chooseSource(value: SourceOption) { return enterPlan({ taskId: value.task_id, planId: value.plan_id, planVersion: value.plan_version }); }
  async function loadSourceOptions(page = 1) {
    const input = { page, page_size: 20, search: sourceSearch.value };
    await read('source-directory', signal => api().workbench.listSources(input, signal), value => { sourceDirectory.value = value; });
  }
  async function loadScenes(page = 1, search = '') {
    const target = taskContext.value; if (!target) return;
    await read('scenes', () => api().scenes.listScenes({ taskId: target.taskId, page, pageSize: 20, search }), value => { scenes.value = value; });
  }
  async function selectScene(input: { sceneId: string; versionId: string }) {
    const chosen = { ...input };
    const target = taskContext.value; if (!target || !await prepareLeave()) return;
    invalidate(); preview.value = null;
    await read('scene', () => api().scenes.getScene({ taskId: target.taskId, sceneId: chosen.sceneId, versionId: chosen.versionId }), value => {
      scene.value = frozenDto(value); resetDraft(); notice.value = value.sourceState.state === 'CURRENT' ? '' : '正在查看冻结历史来源';
    });
    schedule();
  }
  async function loadSceneVersions(sceneId: string, page = 1) {
    const target = taskContext.value; if (!target) return;
    await read('scene-versions', () => api().scenes.listSceneVersions({ taskId: target.taskId, sceneId, page, pageSize: 20 }), value => { sceneVersions.value = value; });
  }
  async function acceptScene(receipt: InterferenceSceneReceipt, isCurrent: () => boolean) {
    const loaded = await api().scenes.getScene({ sceneId: receipt.sceneId, versionId: receipt.versionId, taskId: receipt.taskId });
    if (!isCurrent()) return;
    scene.value = frozenDto(loaded); lastSceneReceipt.value = receipt; resetDraft(); pendingScene.value = null; notice.value = '场景版本已保存；尚未提交分析';
    await loadScenes();
  }
  async function saveScene() {
    const target = taskContext.value, source = selectedSource.value;
    if (!target || !source?.eligible || busy.value || !auth.can('planning.save') || pendingScene.value) return;
    const payload: InterferenceSceneSave = { sceneId: draft.value.sceneId, requestId: randomUuid(), taskId: target.taskId,
      planId: target.planId, planVersion: target.planVersion, resourceRevision: source.resource_revision,
      baseSceneVersionId: scene.value?.version.versionId ?? null, name: draft.value.name, note: draft.value.note,
      interferenceIds: [...draft.value.interferenceIds] };
    const generation = epoch, session = auth.generation;
    busy.value = true; pendingScene.value = copy(payload);
    try { const receipt = await api().scenes.saveScene(payload); if (valid(generation, session)) await acceptScene(receipt, () => valid(generation, session)); }
    catch (reason) { if (valid(generation, session)) { report(reason); if (knownRejection(reason)) pendingScene.value = null; } }
    finally { if (generation === epoch) busy.value = false; }
  }
  function knownRejection(reason: unknown) { return reason instanceof ApiError && ['VALIDATION_ERROR', 'NOT_FOUND', 'VERSION_CONFLICT', 'RESOURCE_VERSION_CHANGED', 'REQUEST_CONFLICT', 'STATE_CONFLICT', 'FORBIDDEN', 'CSRF_REJECTED', 'SESSION_REPLACED'].includes(String(reason.code)); }
  async function resolveSceneSave(retry = false) {
    const payload = pendingScene.value; if (!payload || busy.value || payload.taskId !== taskContext.value?.taskId) return;
    const generation = epoch, session = auth.generation; busy.value = true;
    try {
      const receipt = retry ? await api().scenes.saveScene(copy(payload)) : await api().scenes.getSceneReceipt({ taskId: payload.taskId, sceneId: payload.sceneId, requestId: payload.requestId });
      if (valid(generation, session)) await acceptScene(receipt, () => valid(generation, session));
    } catch (reason) { if (valid(generation, session)) report(reason); }
    finally { if (generation === epoch) busy.value = false; }
  }
  async function acceptReceipt(receipt: WriteReceipt, isCurrent: () => boolean) {
    lastReceipt.value = receipt;
    if (receipt.object_type === 'RUN') await selectRun(receipt.object_id);
    else {
      const row = await api().workbench.getAdoption({ task_id: receipt.task_id, adoption_id: receipt.object_id });
      if (!isCurrent()) return;
      const index = adoptions.value.findIndex(item => item.adoption_id === row.adoption_id);
      if (index < 0) adoptions.value.push(row); else adoptions.value[index] = row;
      notice.value = row.state === 'SUCCESS' ? '重算方案已保存，尚未改变当前确认方案' : '采纳已受理，等待真实重算';
    }
    if (isCurrent()) { void loadHistory(historyPage.value); schedule(); }
  }
  async function dispatch(item: PendingWrite): Promise<WriteReceipt> {
    const service = api().workbench;
    if (item.operation === 'SUBMIT_ANALYSIS') return service.submitRun(item.body as Parameters<typeof service.submitRun>[0]);
    if (item.operation === 'CANCEL_ANALYSIS') return service.cancelRun(item.body as Parameters<typeof service.cancelRun>[0]);
    if (item.operation === 'ADOPT_MEASURE') return service.adoptMeasure(item.body as Parameters<typeof service.adoptMeasure>[0]);
    return service.cancelAdoption(item.body as Parameters<typeof service.cancelAdoption>[0]);
  }
  async function write(item: PendingWrite, resolve = false, retry = false) {
    if (busy.value || !executable.value) return;
    if (item.task_id !== taskContext.value?.taskId) { notice.value = '请先返回原任务核实此请求'; return; }
    const generation = epoch, session = auth.generation; busy.value = true; error.value = '';
    if (!pendingWrites.value.some(row => row.request_id === item.request_id)) pendingWrites.value.push(copy(item));
    try {
      const receipt = resolve && !retry ? await api().workbench.getOperation({ task_id: item.task_id, request_id: item.request_id, operation: item.operation })
        : await dispatch(copy(item));
      if (valid(generation, session)) {
        pendingWrites.value = pendingWrites.value.filter(row => row.request_id !== item.request_id);
        await acceptReceipt(receipt, () => valid(generation, session));
      }
    } catch (reason) {
      if (valid(generation, session)) { report(reason); if (!resolve && knownRejection(reason)) pendingWrites.value = pendingWrites.value.filter(row => row.request_id !== item.request_id); }
    } finally { if (generation === epoch) { busy.value = false; schedule(); } }
  }
  async function resolvePending(requestId: string, retry = false) {
    const item = pendingWrites.value.find(row => row.request_id === requestId); if (item) await write(item, true, retry);
  }
  async function submitAnalysis() {
    if (!canAnalyze.value || busy.value) return;
    const value = scene.value!.version, request_id = randomUuid();
    await write({ request_id, task_id: value.taskId, operation: 'SUBMIT_ANALYSIS', body: {
      request_id, task_id: value.taskId, plan_id: value.planId, plan_version: value.planVersion,
      resource_revision: value.resourceRevision, scene_id: value.sceneId, scene_version_id: value.versionId, snapshot_hash: value.snapshotHash } });
  }
  async function cancelAnalysis() {
    const run = selected.value; if (!run || !activeStates.includes(run.state) || pendingWrites.value.length) return;
    const request_id = randomUuid();
    await write({ request_id, task_id: run.task_id, operation: 'CANCEL_ANALYSIS', body: { request_id, task_id: run.task_id, run_id: run.run_id, expected_run_version: run.run_version } });
  }
  async function selectRun(runId: string) {
    const target = taskContext.value; if (!target) return;
    controllers.get('preview')?.abort(); controllers.delete('preview');
    sequences.set('preview', (sequences.get('preview') ?? 0) + 1);
    previewSerial++; previewLoading.value = false; delete queryErrors.value.preview;
    preview.value = null; after.value = false; measureId.value = '';
    await read('run', signal => api().workbench.getRun({ task_id: target.taskId, run_id: runId }, signal), value => {
      selected.value = frozenDto(value); adoptions.value = [...value.adoptions]; historyOpen.value = false;
    }); schedule();
  }
  async function loadMeasurePreview(id: string) {
    const run = selected.value; if (!run) return;
    measureId.value = id; measureOpen.value = true; after.value = false; preview.value = null; previewLoading.value = true;
    const generation = epoch, number = ++previewSerial;
    await read('preview', signal => api().workbench.getPreview({ task_id: run.task_id, run_id: run.run_id, measure_id: id, expected_run_version: run.run_version }, signal), value => {
      const item = run.result?.measures.find(row => row.measure_id === id);
      if (selected.value?.run_id === run.run_id && measureId.value === id && item
          && value.source_hash === run.source_hash && value.preview_hash === item.preview_hash) preview.value = frozenDto(value);
      else throw new Error('措施预览来源不一致');
    });
    if (generation === epoch && number === previewSerial) previewLoading.value = false;
  }
  async function adoptMeasure(id: string) {
    const run = selected.value, item = run?.result?.measures.find(row => row.measure_id === id);
    if (!run || !item?.available || !adoptable.value || !run.adoption_capabilities[item.type].enabled || pendingWrites.value.length) return;
    const request_id = randomUuid(), value = run.source;
    await write({ request_id, task_id: run.task_id, operation: 'ADOPT_MEASURE', body: {
      request_id, task_id: run.task_id, run_id: run.run_id, measure_id: id, expected_run_version: run.run_version,
      plan_id: run.plan_id, plan_version: run.plan_version, resource_revision: run.resource_revision,
      scene_version_id: run.scene_version_id, snapshot_hash: value.snapshotHash } });
  }
  async function cancelAdoption(id: string) {
    const row = adoptions.value.find(item => item.adoption_id === id); if (!row || !activeStates.includes(row.state) || pendingWrites.value.length) return;
    const request_id = randomUuid();
    await write({ request_id, task_id: row.task_id, operation: 'CANCEL_ADOPTION', body: {
      request_id, task_id: row.task_id, adoption_id: id, expected_adoption_version: row.adoption_version } });
  }
  async function loadHistory(page = 1) {
    const target = taskContext.value; if (!target) return;
    const input = { task_id: target.taskId, page, page_size: 20, search: historySearch.value,
      ...(historyState.value ? { state: historyState.value } : {}) };
    await read('history', signal => api().workbench.listRuns(input, signal), value => { history.value = value; });
  }
  async function query() {
    if (!readable.value || busy.value) { schedule(); return; }
    const run = selected.value;
    if (run && activeStates.includes(run.state)) await read('run', signal => api().workbench.getRun({ task_id: run.task_id, run_id: run.run_id }, signal), value => { selected.value = frozenDto(value); });
    const rows = adoptions.value.filter(row => activeStates.includes(row.state));
    for (const row of rows) await read('adoption:' + row.adoption_id, signal => api().workbench.getAdoption({ task_id: row.task_id, adoption_id: row.adoption_id }, signal), value => {
      const index = adoptions.value.findIndex(item => item.adoption_id === value.adoption_id); if (index >= 0) adoptions.value[index] = value;
    });
    const target = taskContext.value;
    await read('context', signal => api().workbench.getContext(target ? { task_id: target.taskId } : {}, signal), value => { context.value = value; });
    schedule();
  }
  function start() { active = true; void load(); }
  function stop() { active = false; invalidate(); busy.value = false; }
  function clearForSession() {
    stop(); services = null; connected.value = false; busy.value = false; taskContext.value = null; context.value = null;
    selected.value = null; preview.value = null; history.value = null; scenes.value = null; adoptions.value = [];
    pendingWrites.value = []; pendingScene.value = null; lastReceipt.value = null; lastSceneReceipt.value = null; sourceDirectory.value = null; sourceSearch.value = ''; measureId.value = ''; historyOpen.value = false;
    measureOpen.value = false; sceneOpen.value = false; newDraft(); error.value = ''; queryErrors.value = {}; notice.value = '';
  }
  watch(() => auth.generation, clearForSession, { flush: 'sync' });
  watch(measureId, () => { preview.value = null; after.value = false; }, { flush: 'sync' });
  newDraft();
  return { taskContext, context, connected, selectedSource, sourceDirectory, sourceSearch, scene, scenes, sceneVersions, draft, dirty, pendingScene, pendingWrites, lastReceipt, lastSceneReceipt,
    selected, preview, adoptions, history, historySearch, historyState, historyTotal, historyPage, analysisId, measureId, measure,
    after, levels, impact, filteredImpact, mapProjection, selectedMeasurePreview, previewUnavailableReason, canPreviewAfter, effectiveAfter,
    historyOpen, measureOpen, sceneOpen, busy, loading, previewLoading, error, queryError, notice, readable, executable, adoptable,
    locked, running, canAnalyze, bindServices, enterPlan, chooseSource, load, query, loadSourceOptions, loadScenes, selectScene, loadSceneVersions,
    newDraft, resetDraft, saveScene, resolveSceneSave, resolvePending, submitAnalysis, cancelAnalysis, selectRun, loadMeasurePreview,
    adoptMeasure, cancelAdoption, loadHistory, prepareLeave, start, stop, clearForSession };
});
