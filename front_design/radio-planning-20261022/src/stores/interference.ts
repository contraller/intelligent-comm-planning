// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { createReadCancellation } from '../services/data-access';
import { INTERFERENCE_POLL_MS, PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../config/demo';
import type { Countermeasure, InterferenceLevel, InterferenceReadView, InterferenceHistoryItem, InterferenceScenario, InterferenceScenarioId, InterferenceReadSources, InterferenceMeasurePreview } from '../types/interference';
import type { PageResult } from '../types/data-access';
import type { PlanningIssue, PlanningWorkspace } from '../types/planning';
import { useAuthStore } from './auth';
import { usePlanningStore } from './planning';
import { useGisWorkspaceStore } from './gis-workspace';
import { useResourceReadStore } from './resource-read';

// 页面只组织选择；提交、轮询及迟到响应隔离集中在此处。
export const useInterferenceStore = defineStore('interference', () => {
  const requests=createReadCancellation();
  const auth = useAuthStore(), planning = usePlanningStore(), gis = useGisWorkspaceStore(), preview = useResourceReadStore();
  const workspace = ref<Pick<PlanningWorkspace,'revision'> | PlanningWorkspace | null>(null);
  const sources = ref<InterferenceReadSources>({ plans: [], sources: [], resourceRevision: null, error: null });
  const scenarios = ref<Omit<InterferenceScenario,'sources'>[]>([]), views = ref<InterferenceReadView[]>([]);
  const history=ref<PageResult<InterferenceHistoryItem>|null>(null),historyTotal=ref(0),historyPage=ref(1);
  const previewLoading=ref(false),loadedPreview=ref<InterferenceMeasurePreview|null>(null),adoptedTaskId=ref('');
  const acceptedAnalysisId=ref('');
  let previewSerial=0,historySerial=0;
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
    if(loadedPreview.value?.measureId===measure.value.id)return loadedPreview.value;
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
  const running = computed(() => !!acceptedAnalysisId.value || views.value.some(row => ['PENDING', 'RUNNING'].includes(row.state)));
  const locked = computed(() => loading.value || busy.value);
  const impact = computed(() => effectiveAfter.value ? measure.value!.after : selected.value?.result?.impact ?? null);
  watch([analysisId, () => selected.value?.run.network.taskId], () => {
    measureId.value = ''; after.value = false; measureOpen.value = false;
  }, { flush: 'sync' });
  watch(measureId, () => { after.value = false; loadedPreview.value=null; if(measureId.value&&!selected.value?.measurePreviews?.some(row=>row.measureId===measureId.value))void loadMeasurePreview(); }, { flush: 'sync' });
  watch(canPreviewAfter, available => { if (!available) after.value = false; }, { flush: 'sync' });
  const filteredImpact = computed(() => impact.value ? { ...impact.value,
    nodes: impact.value.nodes.filter(row => levels.value.includes(row.level)),
    links: impact.value.links.filter(row => levels.value.includes(row.level)),
    regions: impact.value.regions.filter(row => levels.value.includes(row.level)),
  } : null);
  let generation = 0, active = false, pending = false, serial = 0;
  let entrySerial=0,entryAbort:AbortController|undefined,entryLoading=false;
  let inputTarget:{taskId:string;planId:string}|null=null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let submission: { signature: string; id: string } | null = null;
  const valid = (token: number, session: number) => token === generation && session === auth.generation && readable.value;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  function report(reason: unknown) {
    error.value = reason instanceof Error ? reason.message : '干扰操作失败';
    issues.value = reason instanceof ApiError && Array.isArray(reason.data) ? reason.data : [];
  }
  function accept(next: Pick<PlanningWorkspace,'revision'>) {
    workspace.value = next;
    planning.readRevision=next.revision;
  }
  function updateView(next: InterferenceReadView) {
    if(acceptedAnalysisId.value===next.run.analysisId)acceptedAnalysisId.value='';
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
      const loaded = await previewService.loadInterferenceContext({signal:requests.signal('metadata')});
      if (!valid(token, session)) return;
      accept({revision:loaded.revision}); sources.value = loaded.sources; scenarios.value = loaded.scenarios; historyTotal.value=loaded.total;
      // 显式方案入口不自动恢复其他网络的最近分析，手动打开历史仍沿用原流程。
      if(inputTarget&&planId.value!==inputTarget.planId)inputTarget=null;
      if(!analysisId.value&&!inputTarget)analysisId.value=loaded.latestId??'';
      const ids=[...new Set([...loaded.activeIds,analysisId.value].filter(Boolean))];
      const selectedViews=await Promise.all(ids.map(analysisId=>previewService.getInterferenceDetail({analysisId,signal:requests.signal('detail:'+analysisId)})));
      if(!valid(token,session))return;views.value=selectedViews;
      if (!planId.value&&!inputTarget) planId.value = sources.value.plans.find(row => row.eligible)?.plan.id ?? '';
      if (!interferenceIds.value.length) interferenceIds.value = ['IF-0008'];
      error.value = ''; queryError.value = ''; issues.value = [];
    } catch (reason) { if (valid(token, session)) report(reason); }
    finally { if (token === generation) { loading.value = false; schedule(); } }
  }
  function cancelEntry(){
    entrySerial++;entryAbort?.abort();entryAbort=undefined;
    if(entryLoading){entryLoading=false;loading.value=false;schedule();}
  }
  async function enterPlan(taskId:string,targetPlanId:string,isCurrent:()=>boolean=()=>true){
    if(!readable.value||auth.blocked||busy.value||!isCurrent())return false;
    cancelEntry();requests.stop();generation++;serial++;pending=false;clearTimer();
    const token=generation,session=auth.generation,ticket=entrySerial;
    const current=()=>valid(token,session)&&ticket===entrySerial&&!auth.blocked&&isCurrent();
    entryAbort=new AbortController();const signal=entryAbort.signal;
    loading.value=true;entryLoading=true;
    try{
      const loaded=await previewService.loadInterferenceContext({signal});
      if(!current())return false;
      const target=loaded.sources.plans.find(row=>row.plan.id===targetPlanId&&row.plan.taskId===taskId);
      if(!target)throw new Error('目标方案不存在或不属于指定任务，请返回规划重新选择');
      if(loaded.sources.error)throw new Error(loaded.sources.error);
      if(!target.eligible)throw new Error(target.reason||'目标方案当前不可分析');
      const runningViews=await Promise.all(loaded.activeIds.map(analysisId=>previewService.getInterferenceDetail({analysisId,signal})));
      if(!current())return false;
      const running=runningViews.filter(row=>['PENDING','RUNNING'].includes(row.state));
      if(running.some(row=>row.run.network.id!==targetPlanId||row.run.network.taskId!==taskId))throw new Error('其他方案的干扰分析正在运行，请待其结束后再进入');
      // 只接纳本次指定网络；旧记录保留在历史中，不能冒充新目标的结果。
      accept({revision:loaded.revision});sources.value=loaded.sources;scenarios.value=loaded.scenarios;historyTotal.value=loaded.total;
      views.value=running;analysisId.value=running[0]?.run.analysisId??'';planId.value=targetPlanId;
      inputTarget={taskId,planId:targetPlanId};acceptedAnalysisId.value='';
      measureId.value='';after.value=false;measureOpen.value=false;historyOpen.value=false;loadedPreview.value=null;submission=null;
      if(!interferenceIds.value.length)interferenceIds.value=['IF-0008'];
      error.value='';queryError.value='';notice.value='';issues.value=[];
      return true;
    }catch(reason){if(current())report(reason);return false;}
    finally{if(ticket===entrySerial){entryLoading=false;loading.value=false;schedule();}}
  }
  async function query() {
    if (!readable.value || pending || locked.value) return;
    const token = generation, session = auth.generation, request = ++serial;
    const ids = [...new Set([...views.value.filter(row => ['PENDING', 'RUNNING'].includes(row.state)).map(row => row.run.analysisId), analysisId.value].filter(Boolean))];
    pending = true;
    try {
      const results = await Promise.all(ids.map(async id => {
        const progress=await previewService.getInterferenceProgress({analysisId:id,signal:requests.signal('progress:'+id)}),previous=views.value.find(row=>row.run.analysisId===id);
        if(!previous||previous.state!==progress.state&&['SUCCESS','FAILED','CANCELLED'].includes(progress.state))return previewService.getInterferenceDetail({analysisId:id,signal:requests.signal('detail:'+id)});
        return {...previous,...progress};
      }));
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
    if (submission?.signature !== signature) submission = { signature, id: randomUuid() };
    busy.value = true; error.value = ''; notice.value = ''; issues.value = []; clearTimer();
    try {
      const result = await previewService.submitInterferenceReceipt({ ...payload, requestId: submission.id });
      if (!valid(token, session)) return false;
      accept({revision:result.revision}); analysisId.value=result.objectId; submission=null;acceptedAnalysisId.value=result.objectId;gis.mapMode='analysis';
      const detail=await previewService.getInterferenceDetail({analysisId:result.objectId});
      if(!valid(token,session))return false;updateView(detail);historyTotal.value++;
      gis.mapMode = 'analysis'; after.value = false; measureId.value = ''; submission = null; queryError.value = '';
      return true;
    } catch (reason) { if (valid(token, session)) {report(reason);if(acceptedAnalysisId.value)queryError.value='操作已受理，详情读取失败，请重试查询';} return false; }
    finally { if (token === generation) { busy.value = false; schedule(); } }
  }
  async function cancel() {
    if (!executable.value || locked.value || !selected.value || !workspace.value) return;
    const token = generation, session = auth.generation;
    busy.value = true; clearTimer();let accepted=false;
    try {
      const result = await previewService.cancelInterferenceReceipt({ baseRevision: workspace.value.revision, analysisId: analysisId.value });
      if (!valid(token, session)) return;
      accepted=true;accept({revision:result.revision});const detail=await previewService.getInterferenceDetail({analysisId:result.objectId});
      if(!valid(token,session))return;updateView(detail);error.value = ''; queryError.value = '';
    } catch (reason) { if (valid(token, session)) {report(reason);if(accepted){notice.value='取消已受理，状态读取失败，请重试查询';queryError.value='请重新读取取消后的状态';}} }
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
      const result = await previewService.adoptInterferenceReceipt({
        baseRevision: workspace.value.revision, requestId: 'adopt:' + selectedAnalysis + ':' + selectedMeasure,
        analysisId: selectedAnalysis, measureId: selectedMeasure,
      });
      if (!valid(token, session)) return;
      accept({revision:result.revision});adoptedTaskId.value=result.taskId;
      const current = views.value.find(row => row.run.analysisId === selectedAnalysis);
      if (current && !current.adoptions.some(row => row.measureId === selectedMeasure))
        current.adoptions.push({ measureId: selectedMeasure, planId: result.planId });
      notice.value = result.changed ? '已生成待确认方案 ' + result.version + '，请前往网络规划查看并确认。' : '此措施已采纳，已定位原方案。';
      return result.planId;
    } catch (reason) { if (valid(token, session)) report(reason); }
    finally { if (token === generation) { busy.value = false; schedule(); } }
  }
  function select(id: string) {
    if (locked.value) return;
    inputTarget=null;
    views.value=views.value.filter(row=>row.run.analysisId===id||['PENDING','RUNNING'].includes(row.state));
    analysisId.value = id; after.value = false; measureId.value = ''; gis.mapMode = 'analysis'; historyOpen.value = false;
    void query();
  }
  function inspectMeasure(row: Countermeasure) { measureId.value = row.id; measureOpen.value = true; after.value = false; }
  async function loadMeasurePreview(){
    const id=analysisId.value,selectedId=measureId.value,serial=++previewSerial,session=auth.generation;
    if(!id||!selectedId||!readable.value)return;previewLoading.value=true;
    try{const value=await previewService.getInterferenceMeasurePreview({analysisId:id,measureId:selectedId,signal:requests.signal('measure')});
      if(serial===previewSerial&&session===auth.generation&&id===analysisId.value&&selectedId===measureId.value){loadedPreview.value=value;const item=selected.value?.result?.measures.find(row=>row.id===selectedId);if(item)item.after=value.impact;}
    }catch(e){if(serial===previewSerial&&session===auth.generation)error.value=e instanceof Error?e.message:'措施预览读取失败';}
    finally{if(serial===previewSerial)previewLoading.value=false;}
  }
  async function loadHistory(page=1){
    if(!readable.value)return;const token=generation,session=auth.generation,serial=++historySerial;
    try{const value=await previewService.queryInterferenceHistory({pageNum:page,pageSize:20,signal:requests.signal('history')});if(serial===historySerial&&valid(token,session)){history.value=value;historyPage.value=page;historyTotal.value=value.total;}}
    catch(e){if(valid(token,session))report(e);}
  }
  watch(historyOpen,value=>{if(value)void loadHistory();});
  function stop() {
    cancelEntry();
    requests.stop();active = false; generation++; historySerial++;serial++; previewSerial++; loadedPreview.value=null;previewLoading.value=false;pending = false; loading.value = false; busy.value = false; clearTimer();
    if (typeof window !== 'undefined') { window.removeEventListener('focus', refresh); window.removeEventListener('storage', storage); }
  }
  const refresh = () => { if (active) void load(); };
  const storage = (event: StorageEvent) => { if (!event.key || [PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY].includes(event.key)) refresh(); };
  function start() {
    active = true;
    if (typeof window !== 'undefined') { window.addEventListener('focus', refresh); window.addEventListener('storage', storage); }
    void load();
  }
  watch(() => preview.workspace?.revision, refresh);
  function clearForSession() {
    inputTarget=null;
    history.value=null;historyTotal.value=0;historyPage.value=1;adoptedTaskId.value='';acceptedAnalysisId.value='';
    stop(); workspace.value = null; sources.value = { plans: [], sources: [], resourceRevision: null, error: null };
    scenarios.value = []; views.value = []; planId.value = ''; interferenceIds.value = []; scenarioId.value = 'single';
    analysisId.value = ''; measureId.value = ''; gis.mapMode = 'resource'; after.value = false;
    historyOpen.value = false; measureOpen.value = false; error.value = ''; queryError.value = ''; notice.value = ''; issues.value = []; submission = null;
  }
  return { workspace, sources, scenarios, views, planId, interferenceIds, scenarioId, analysisId, selected, measureId, measure, history, historyTotal, historyPage,loadHistory,loadedPreview,previewLoading,loadMeasurePreview,adoptedTaskId,
    after, selectedMeasurePreview, previewUnavailableReason, canPreviewAfter, effectiveAfter, impact, levels, filteredImpact, historyOpen, measureOpen, loading, busy, locked, error, queryError, notice, issues,
    readable, executable, adoptable, running, load, query, submit, cancel, adopt, select, inspectMeasure, start, stop, clearForSession,enterPlan,cancelEntry };
});
