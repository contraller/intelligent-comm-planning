import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { INTERFERENCE_POLL_MS, PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../config/demo';
import type { Countermeasure, InterferenceLevel, InterferenceRunView, InterferenceScenario, InterferenceScenarioId, InterferenceSources } from '../types/interference';
import type { PlanningIssue, PlanningWorkspace } from '../types/planning';
import { useAuthStore } from './auth';
import { usePlanningStore } from './planning';
import { useGisWorkspaceStore } from './gis-workspace';
import { usePreviewStore } from './preview';

// 页面只组织选择；提交、轮询及迟到响应隔离集中在此处。
export const useInterferenceStore = defineStore('interference', () => {
  const auth = useAuthStore(), planning = usePlanningStore(), gis = useGisWorkspaceStore(), preview = usePreviewStore();
  const workspace = ref<PlanningWorkspace | null>(null);
  const sources = ref<InterferenceSources>({ plans: [], sources: [], resourceRevision: null, error: null });
  const scenarios = ref<InterferenceScenario[]>([]), views = ref<InterferenceRunView[]>([]);
  const planId = ref(''), interferenceIds = ref<string[]>([]), scenarioId = ref<InterferenceScenarioId>('single');
  const analysisId = ref(''), measureId = ref('');
  const levels = ref<InterferenceLevel[]>(['SEVERE', 'MODERATE', 'MINOR']);
  const after = ref(false), historyOpen = ref(false), measureOpen = ref(false);
  const loading = ref(false), busy = ref(false), error = ref(''), queryError = ref(''), notice = ref('');
  const issues = ref<PlanningIssue[]>([]);
  const readable = computed(() => auth.can('situation.view') && auth.can('planning.view'));
  const executable = computed(() => readable.value && auth.can('planning.execute'));
  const adoptable = computed(() => executable.value && auth.can('planning.save'));
  const selected = computed(() => views.value.find(row => row.run.analysisId === analysisId.value) ?? null);
  const measure = computed(() => selected.value?.result?.measures.find(row => row.id === measureId.value) ?? null);
  // 按明确措施身份唯一匹配，旧服务缺省字段时不在页面回查预设。
  const selectedMeasurePreview = computed(() => {
    if (!measure.value) return null;
    const matches = selected.value?.measurePreviews?.filter(row => row.measureId === measure.value!.id) ?? [];
    return matches.length === 1 ? matches[0] : null;
  });
  const previewUnavailableReason = computed(() => {
    const entry = selectedMeasurePreview.value, result = entry?.result;
    if (measure.value?.unavailableReason) return measure.value.unavailableReason;
    if (entry?.unavailableReason) return entry.unavailableReason;
    // 只检查展示所需结构，不计算或重判服务提供的业务结果。
    if (!result || !Array.isArray(result.inputSnapshot?.stations) || !Array.isArray(result.inputSnapshot?.devices) ||
      !Array.isArray(result.links) || !Array.isArray(result.regions) || !Array.isArray(result.checks) || !Array.isArray(result.notes) ||
      !['deployment', 'devices', 'routes', 'frequencies'].every(key => Array.isArray(result.configuration?.[key as keyof typeof result.configuration])) ||
      !result.metrics || !['coveragePercent', 'connectivityPercent', 'survivabilityPercent', 'totalRadiatedPowerW', 'delayMs']
        .every(key => Number.isFinite(result.metrics[key as keyof typeof result.metrics])) ||
      !(result.deploymentCost === null || Number.isFinite(result.deploymentCost)) || typeof result.costUnit !== 'string')
      return '未提供完整措施预览';
    if (!measure.value?.after) return '未提供措施后影响结果';
    return '';
  });
  const canPreviewAfter = computed(() => !!measure.value && !previewUnavailableReason.value);
  const effectiveAfter = computed(() => after.value && canPreviewAfter.value);
  const running = computed(() => views.value.some(row => ['PENDING', 'RUNNING'].includes(row.state)));
  const locked = computed(() => loading.value || busy.value);
  const impact = computed(() => effectiveAfter.value ? measure.value!.after : selected.value?.result?.impact ?? null);
  watch([analysisId, () => selected.value?.run.network.taskId], () => {
    measureId.value = ''; after.value = false; measureOpen.value = false;
  }, { flush: 'sync' });
  watch(measureId, () => { after.value = false; }, { flush: 'sync' });
  watch(canPreviewAfter, available => { if (!available) after.value = false; }, { flush: 'sync' });
  const filteredImpact = computed(() => impact.value ? { ...impact.value,
    nodes: impact.value.nodes.filter(row => levels.value.includes(row.level)),
    links: impact.value.links.filter(row => levels.value.includes(row.level)),
    regions: impact.value.regions.filter(row => levels.value.includes(row.level)),
  } : null);
  let generation = 0, active = false, pending = false, serial = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let submission: { signature: string; id: string } | null = null;
  const valid = (token: number, session: number) => token === generation && session === auth.generation && readable.value;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  function report(reason: unknown) {
    error.value = reason instanceof Error ? reason.message : '干扰操作失败';
    issues.value = reason instanceof ApiError && Array.isArray(reason.data) ? reason.data : [];
  }
  function accept(next: PlanningWorkspace) {
    workspace.value = next;
    planning.acceptWorkspace(next);
  }
  function updateView(next: InterferenceRunView) {
    const index = views.value.findIndex(row => row.run.analysisId === next.run.analysisId);
    if (index < 0) views.value.push(next); else views.value[index] = next;
  }
  function schedule() {
    clearTimer();
    if (active && readable.value && running.value && !queryError.value && !locked.value)
      timer = setTimeout(() => { void query(); }, INTERFERENCE_POLL_MS);
  }
  async function load() {
    if (!readable.value || locked.value) return;
    const token = generation, session = auth.generation;
    loading.value = true;
    try {
      const loaded = await previewService.loadInterferenceWorkspace();
      if (!valid(token, session)) return;
      accept(loaded.workspace); sources.value = loaded.sources; scenarios.value = loaded.scenarios; views.value = loaded.views;
      if (!analysisId.value || !views.value.some(row => row.run.analysisId === analysisId.value))
        analysisId.value = views.value.at(-1)?.run.analysisId ?? '';
      if (!planId.value) planId.value = sources.value.plans.find(row => row.eligible)?.plan.id ?? '';
      if (!interferenceIds.value.length) interferenceIds.value = ['IF-0008'];
      error.value = ''; queryError.value = ''; issues.value = [];
    } catch (reason) { if (valid(token, session)) report(reason); }
    finally { if (token === generation) { loading.value = false; schedule(); } }
  }
  async function query() {
    if (!readable.value || pending || locked.value) return;
    const token = generation, session = auth.generation, request = ++serial;
    const ids = [...new Set([...views.value.filter(row => ['PENDING', 'RUNNING'].includes(row.state)).map(row => row.run.analysisId), analysisId.value].filter(Boolean))];
    pending = true;
    try {
      const results = await Promise.all(ids.map(id => previewService.getInterferenceAnalysis(id)));
      if (!valid(token, session)) return;
      results.forEach(updateView); queryError.value = '';
    } catch (reason) {
      if (valid(token, session)) queryError.value = '查询失败，状态未确认：' + (reason instanceof Error ? reason.message : '请重试');
    } finally { if (request === serial) { pending = false; schedule(); } }
  }
  async function submit() {
    if (!executable.value || locked.value || running.value) return false;
    const token = generation, session = auth.generation;
    // 资源表单与任务草稿必须先作出保存/放弃选择；绝不分析未保存输入。
    if (!(await gis.prepareAnalysis()) || !valid(token, session)) return false;
    await load();
    if (!valid(token, session) || !workspace.value || sources.value.error || !sources.value.resourceRevision) return false;
    const payload = { planId: planId.value, scenarioId: scenarioId.value, interferenceIds: [...interferenceIds.value],
      baseRevision: workspace.value.revision, baseResourceRevision: sources.value.resourceRevision };
    const signature = JSON.stringify(payload);
    if (submission?.signature !== signature) submission = { signature, id: crypto.randomUUID() };
    busy.value = true; error.value = ''; notice.value = ''; issues.value = []; clearTimer();
    try {
      const result = await previewService.submitInterferenceAnalysis({ ...payload, requestId: submission.id });
      if (!valid(token, session)) return false;
      accept(result.workspace); updateView(result.view); analysisId.value = result.view.run.analysisId;
      gis.mapMode = 'analysis'; after.value = false; measureId.value = ''; submission = null; queryError.value = '';
      return true;
    } catch (reason) { if (valid(token, session)) report(reason); return false; }
    finally { if (token === generation) { busy.value = false; schedule(); } }
  }
  async function cancel() {
    if (!executable.value || locked.value || !selected.value || !workspace.value) return;
    const token = generation, session = auth.generation;
    busy.value = true; clearTimer();
    try {
      const result = await previewService.cancelInterferenceAnalysis({ baseRevision: workspace.value.revision, analysisId: analysisId.value });
      if (!valid(token, session)) return;
      accept(result.workspace); updateView(result.view); error.value = ''; queryError.value = '';
    } catch (reason) { if (valid(token, session)) report(reason); }
    finally { if (token === generation) { busy.value = false; schedule(); } }
  }
  async function adopt() {
    if (!adoptable.value || locked.value || !selected.value || !measure.value || !workspace.value) return;
    if (!canPreviewAfter.value && !selected.value.adoptions.some(row => row.measureId === measure.value!.id)) {
      error.value = previewUnavailableReason.value; return;
    }
    const token = generation, session = auth.generation, selectedMeasure = measure.value.id, selectedAnalysis = analysisId.value;
    busy.value = true; error.value = ''; clearTimer();
    try {
      const result = await previewService.adoptInterferenceMeasure({
        baseRevision: workspace.value.revision, requestId: 'adopt:' + selectedAnalysis + ':' + selectedMeasure,
        analysisId: selectedAnalysis, measureId: selectedMeasure,
      });
      if (!valid(token, session)) return;
      accept(result.workspace);
      const current = views.value.find(row => row.run.analysisId === selectedAnalysis);
      if (current && !current.adoptions.some(row => row.measureId === selectedMeasure))
        current.adoptions.push({ measureId: selectedMeasure, planId: result.plan.id });
      notice.value = result.changed ? '已生成待确认方案 ' + result.plan.version + '，请前往网络规划查看并确认。' : '此措施已采纳，已定位原方案。';
      return result.plan.id;
    } catch (reason) { if (valid(token, session)) report(reason); }
    finally { if (token === generation) { busy.value = false; schedule(); } }
  }
  function select(id: string) {
    if (locked.value) return;
    analysisId.value = id; after.value = false; measureId.value = ''; gis.mapMode = 'analysis'; historyOpen.value = false;
    void query();
  }
  function inspectMeasure(row: Countermeasure) { measureId.value = row.id; measureOpen.value = true; after.value = false; }
  function stop() {
    active = false; generation++; serial++; pending = false; loading.value = false; busy.value = false; clearTimer();
    if (typeof window !== 'undefined') { window.removeEventListener('focus', refresh); window.removeEventListener('storage', storage); }
  }
  const refresh = () => { if (active) void load(); };
  const storage = (event: StorageEvent) => { if (!event.key || [PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY].includes(event.key)) refresh(); };
  function start() {
    active = true;
    if (typeof window !== 'undefined') { window.addEventListener('focus', refresh); window.addEventListener('storage', storage); }
    void load();
  }
  watch(() => preview.data?.resourceMeta.revision, refresh);
  function clearForSession() {
    stop(); workspace.value = null; sources.value = { plans: [], sources: [], resourceRevision: null, error: null };
    scenarios.value = []; views.value = []; planId.value = ''; interferenceIds.value = []; scenarioId.value = 'single';
    analysisId.value = ''; measureId.value = ''; gis.mapMode = 'resource'; after.value = false;
    historyOpen.value = false; measureOpen.value = false; error.value = ''; queryError.value = ''; notice.value = ''; issues.value = []; submission = null;
  }
  return { workspace, sources, scenarios, views, planId, interferenceIds, scenarioId, analysisId, selected, measureId, measure,
    after, selectedMeasurePreview, previewUnavailableReason, canPreviewAfter, effectiveAfter, impact, levels, filteredImpact, historyOpen, measureOpen, loading, busy, locked, error, queryError, notice, issues,
    readable, executable, adoptable, running, load, query, submit, cancel, adopt, select, inspectMeasure, start, stop, clearForSession };
});
