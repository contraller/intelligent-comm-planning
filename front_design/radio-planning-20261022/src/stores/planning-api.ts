// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
import { computed, nextTick, ref, toRaw, watch } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { planPasses } from '../services/planning-api-validation';
import { sameValue } from '../services/planning-validation';
import { apiId, apiRecord } from '../services/task-api-validation';
import type { PlanningApiFeedbackState, PlanningFeedbackOperation } from '../services/planning-api-feedback';
import type { ApiPlan, ApiPlanningJob, PlanningPlanSummary, PlanningMutationReceipt } from '../types/planning-api';
import { planningProgress } from '../services/planning-api-validation';
import type { ApiPage, OperationKind } from '../types/task-api';
import { useAuthStore } from './auth';
import { uncertainWrite, useTaskInputStore } from './task-input';
import { createPlanningAdjustment, validatePlanningAdjustment } from '../services/planning-adjustment';
import type { PlanningAdjustment, PlanningAdjustmentContext } from '../types/planning-adjustment';
import type { PlanningIssue } from '../types/planning';
import { usePlanningStore } from './planning';

interface PendingWrite { kind: Exclude<OperationKind, 'saveTask'>; requestId: string; taskId: string; adjustment?:PlanningAdjustment; parentPlanId?:string|null; jobId?:string; solutionId?:string; snapshotId?:string; planId?:string; planVersion?:string; name?:string; note?:string }
// 只维护当前任务的接口现场；分页历史、异步作业和输入草稿各自独立。
export const usePlanningApiStore = defineStore('planning-api', () => {
  const auth = useAuthStore(), task = useTaskInputStore(), legacy = usePlanningStore();
  const job = ref<ApiPlanningJob | null>(null), selectedPlan = ref<ApiPlan | null>(null), plans = ref<ApiPage<PlanningPlanSummary> | null>(null), comparison = ref<ApiPlan[]>([]);
  const selectedSolutionId=ref('');
  // 保存和确认均可能改变作业版本；刷新成功前不能用旧基线继续保存其他备选结果。
  const refreshRequiredJobId=ref<string|null>(null);
  const currentSolution=computed(()=>job.value?.solutions?.find(row=>row.solutionId===selectedSolutionId.value)??null);
  const currentResult=computed(()=>job.value?.solutions?currentSolution.value?.result??null:job.value?.result??null);
  const currentOutcome=computed(()=>job.value?.solutions?currentSolution.value?.outcome??job.value.outcome:job.value?.outcome);
  const currentExpired=computed(()=>currentSolution.value?.expired??job.value?.expired??false);
  const currentSavedPlanId=computed(()=>job.value?.solutions?currentSolution.value?.savedPlanId??null:job.value?.savedPlanId??null);
  // 轮询保留有效选择；换作业和重新进入才采用服务指定的默认结果。
  watch(job,(next,previous)=>{if(!next?.solutions)selectedSolutionId.value='';else if(next.id!==previous?.id||!next.solutions.some(row=>row.solutionId===selectedSolutionId.value))selectedSolutionId.value=next.defaultSolutionId??'';},{flush:'sync'});
  function selectSolution(id:string, targetStep = 2){
    if(!task.readable||busy.value||pending.value||adjustmentDirty.value||!job.value?.solutions?.some(row=>row.solutionId===id))return false;
    selectedSolutionId.value=id;selectedPlan.value=null;step.value=targetStep;return true;
  }
  function markSaved(plan:ApiPlan){
    if(job.value?.id!==plan.jobId)return;
    const row=job.value.solutions?.find(item=>item.solutionId===plan.solutionId);
    if(row)row.savedPlanId=plan.id;
    if(!job.value.solutions||job.value.defaultSolutionId===plan.solutionId)job.value.savedPlanId=plan.id;
  }
  function assertSaveIdentity(plan:ApiPlan,expected:Partial<PendingWrite>){
    // 新集合保存才启用所选身份校验，旧单结果仍沿用原回执约定。
    if(expected.solutionId&&(plan.jobId!==expected.jobId||plan.solutionId!==expected.solutionId||plan.result.snapshotId!==expected.snapshotId||plan.name!==expected.name?.trim()||plan.note!==expected.note))
      throw new ApiError('保存回执与原请求的结果身份或说明不一致','INVALID_PLANNING_RESPONSE');
  }
  // 转正与待核实回执始终绑定原版本，不能把另一份已确认方案当成此次成功。
  function assertConfirmIdentity(plan:ApiPlan,expected:Partial<PendingWrite>){
    if(expected.planId&&(plan.id!==expected.planId||plan.taskId!==expected.taskId||plan.version!==expected.planVersion||plan.result.snapshotId!==expected.snapshotId||plan.state!=='CONFIRMED'||!plan.confirmedAt))
      throw new ApiError('转正回执与原方案版本不一致','INVALID_PLANNING_RESPONSE');
  }
  const page = ref(1), step = ref(1), notice = ref(''), busy = ref(false), loading = ref(false);
  const feedback = ref<PlanningApiFeedbackState | null>(null), queryFeedback = ref<PlanningApiFeedbackState | null>(null);
  const error = computed(() => feedback.value?.message ?? ''), queryError = computed(() => queryFeedback.value?.message ?? '');
  // 兼容读取只取完整的一条反馈，不能把另一次请求的载荷拼到当前摘要下。
  const businessDetails = computed(() => feedback.value ? feedback.value.data ?? null : queryFeedback.value?.data ?? null);
  const pending = ref<PendingWrite | null>(null), parentPlanId = ref<string | null>(null);
  const activeWriteKind = ref<PendingWrite['kind'] | null>(null);
  // 参数与路径草稿只从父结果读取，不写回任务输入或资源台账。
  const adjustmentParent=ref<ApiPlan|null>(null),adjustmentDraft=ref<PlanningAdjustment|null>(null),adjustmentOpen=ref(false),adjustmentBaseline=ref('');
  const adjustmentIssues=ref<PlanningIssue[]>([]);
  // 自动预览复用调整作业；仅排队最新输入，不取消已受理的服务端写入。
  const automaticPreview = ref(false), previewPaused = ref(false), previewQueued = ref(false);
  let previewTimer: ReturnType<typeof setTimeout> | undefined, lastPreviewAttempt = '';
  let adjustmentGeneration=0;
  const copy=<T>(value:T):T=>structuredClone(toRaw(value));
  const contextFor=(plan:ApiPlan):PlanningAdjustmentContext=>({id:plan.id,snapshotId:plan.result.snapshotId,input:plan.input,configuration:plan.result.configuration,nodeIds:plan.result.nodes.map(n=>n.id)});
  const adjustmentContext=computed(()=>adjustmentParent.value?contextFor(adjustmentParent.value):null);
  const adjustmentDirty=computed(()=>!!adjustmentDraft.value&&JSON.stringify(adjustmentDraft.value)!==adjustmentBaseline.value);
  const adjustmentResult=computed(()=>adjustmentParent.value&&adjustmentDraft.value&&job.value?.state==='SUCCESS'&&job.value.taskId===adjustmentParent.value.taskId&&job.value.parentPlanId===adjustmentParent.value.id&&job.value.adjustment?.sourceSnapshotId===adjustmentParent.value.result.snapshotId&&!validatePlanningAdjustment(adjustmentDraft.value,contextFor(adjustmentParent.value)).length&&sameValue(job.value.adjustment,adjustmentDraft.value)?job.value.result:null);
  const adjustmentStatus=computed(()=>pending.value?'调整提交结果待核实，请核实原请求。':queryError.value?'预览状态读取中断，请恢复查询；父方案与输入已保留。':adjustmentIssues.value.length?'输入待完善，当前输入暂无预览结果。':running.value?'正在计算预览；可继续编辑，完成后只预览最新输入。':previewQueued.value?'等待输入稳定后自动预览，当前输入暂无新结果。':adjustmentResult.value?'当前输入预览已就绪；保存后形成方案版本。':feedback.value?.code==='NO_PRESET'?'当前输入暂无预生成结果；输入与父方案已保留。':adjustmentDirty.value?'当前输入暂无预览结果，可修改输入或重试预览。':'显示父方案；修改有效参数后自动预览。');
  let generation = 0, lifetime = 0, timer: ReturnType<typeof setTimeout> | undefined, polling = false;
  let historySequence = 0;
  let feedbackEpoch = 0, feedbackSequence = 0;
  const controllers = new Map<string, AbortController>();
  const running = computed(() => !!job.value && ['PENDING','RUNNING'].includes(job.value.state));
  // 历史作业未核实前也占用当前任务，不能因页面尚无进度对象而放开提交。
  const checkedJobs = ref<Record<string, { taskId: string; state: ApiPlanningJob['state'] }>>({});
  const acceptedJobId = ref<string | null>(null);
  watch(job, value => { if (value) checkedJobs.value[value.id] = { taskId: value.taskId, state: value.state }; }, { flush: 'sync' });
  const savedJobId = computed(() => task.saved?.taskId === task.taskId ? acceptedJobId.value ?? task.saved.activeJobId : null);
  const savedJobState = computed(() => job.value && savedJobId.value === job.value.id ? job.value.state : savedJobId.value && checkedJobs.value[savedJobId.value]?.taskId === task.taskId ? checkedJobs.value[savedJobId.value]?.state : undefined);
  const unverifiedJobId = computed(() => savedJobId.value && !savedJobState.value ? savedJobId.value : null);
  const executionBlocked = computed(() => running.value || !!unverifiedJobId.value || ['PENDING', 'RUNNING'].includes(savedJobState.value ?? ''));
  // 只有预览提交期间允许继续编辑，保存、确认等写入仍冻结调整输入。
  const adjustmentLocked = computed(() => !!pending.value || !!task.pendingSave || busy.value && !(automaticPreview.value && activeWriteKind.value === 'submit'));
  const result = computed(() => selectedPlan.value?.result ?? currentResult.value);
  const sourceChanged = computed(() => {
    const snapshot=selectedPlan.value??job.value;
    return !!snapshot && (snapshot.sourceChanged || task.saved?.taskId===snapshot.taskId && task.saved.conditionVersion!==snapshot.conditionVersion);
  });
  const canSubmit = computed(() => auth.can('planning.execute') && !adjustmentOpen.value && !adjustmentDirty.value && !!task.saved && !task.dirty && !task.pendingSave && !task.loading && !task.busy && !executionBlocked.value && !busy.value && !pending.value);
  const canSave = computed(() => auth.can('planning.save') && !adjustmentDirty.value && (!adjustmentParent.value || !job.value?.adjustment || !!adjustmentResult.value) && !busy.value && !pending.value && !queryError.value && refreshRequiredJobId.value !== job.value?.id && !selectedPlan.value && job.value?.state === 'SUCCESS' && !!currentResult.value && !currentExpired.value && !currentSavedPlanId.value);
  const canConfirm = computed(() => auth.can('planning.confirm') && !busy.value && !pending.value && !!selectedPlan.value && selectedPlan.value.state === 'SAVED' && !sourceChanged.value && planPasses(selectedPlan.value.result) && selectedPlan.value.outcome.code === 0);
  const options = (signal?: AbortSignal) => ({ context: task.context, signal });
  watch(() => [executionBlocked.value, busy.value, pending.value,adjustmentOpen.value] as const, () => { task.running = executionBlocked.value || busy.value || !!pending.value || adjustmentOpen.value; }, { flush: 'sync' });
  watch(adjustmentDirty,value=>{task.auxiliary.planningAdjustment=value;},{flush:'sync'});
  function clearFeedback(operation?: PlanningFeedbackOperation) {
    if (!operation || feedback.value?.operation === operation) feedback.value = null;
    if (!operation || queryFeedback.value?.operation === operation) queryFeedback.value = null;
  }
  function localError(message: string, operation: PlanningFeedbackOperation = 'local') {
    // 本地提示替换通用错误，查询中断仍需通过重试恢复，不能顺带解除保存限制。
    feedbackEpoch++; feedback.value = null;
    feedback.value = { operation, taskId: task.taskId, requestToken: ++feedbackSequence, message };
  }
  function failure(operation: PlanningFeedbackOperation, requestToken: number, e: unknown, fallback: string, taskId = task.taskId): PlanningApiFeedbackState {
    return { operation, taskId, requestToken, message: e instanceof Error ? e.message : fallback,
      ...(e instanceof ApiError ? { code: e.code, requestId: e.requestId, data: e.data } : {}) };
  }
  function stop() { setAutomaticPreview(false); generation++; polling = false; clearTimeout(timer); controllers.forEach(c => c.abort()); controllers.clear(); loading.value = false; }
  function pauseAutomaticPreview() { previewPaused.value=true; clearTimeout(previewTimer); previewQueued.value=false; }
  function resumeAutomaticPreview() { previewPaused.value=false; queuePreview(); }
  function setAutomaticPreview(enabled:boolean) { automaticPreview.value=enabled; clearTimeout(previewTimer); previewQueued.value=false; if(enabled)queuePreview(); }
  function queuePreview() {
    clearTimeout(previewTimer); previewQueued.value=false;
    const parent=adjustmentParent.value,draft=adjustmentDraft.value;
    if(!automaticPreview.value||previewPaused.value||!adjustmentOpen.value||!parent||!draft||!task.readable||!auth.can('planning.execute')||pending.value||queryError.value||task.pendingSave||task.changed||task.importFiles.length||adjustmentUnavailable(parent))return;
    if(validatePlanningAdjustment(draft,contextFor(parent)).length||adjustmentResult.value||sameValue(draft,createPlanningAdjustment(contextFor(parent)))||JSON.stringify(draft)===lastPreviewAttempt)return;
    previewQueued.value=true;
    if(busy.value||running.value)return;
    const owner=JSON.stringify([auth.generation,task.taskId,parent.id,parent.result.snapshotId,draft]);
    previewTimer=setTimeout(()=>{
      if(!previewQueued.value||owner!==JSON.stringify([auth.generation,task.taskId,adjustmentParent.value?.id,adjustmentParent.value?.result.snapshotId,adjustmentDraft.value]))return;
      previewQueued.value=false; void submitAdjustment();
    },700);
  }
  watch(()=>[busy.value,running.value,pending.value,queryError.value,task.readable,auth.generation,task.changed,task.pendingSave,step.value],()=>queuePreview(),{flush:'post'});
  async function read<T>(key: PlanningFeedbackOperation, action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (!task.readable) return;
    controllers.get(key)?.abort(); const controller = new AbortController(), token = generation, session = auth.generation, taskId = task.taskId; controllers.set(key, controller);
    const epoch = feedbackEpoch, requestToken = ++feedbackSequence; clearFeedback(key);
    const current = () => token === generation && session === auth.generation && taskId === task.taskId && !controller.signal.aborted && controllers.get(key) === controller && task.readable;
    try { const value = await action(controller.signal); if (current()) { if (epoch === feedbackEpoch) clearFeedback(key); return value; } }
    catch (e) {
      if (current() && epoch === feedbackEpoch) {
        const value = failure(key, requestToken, e, '规划查询失败');
        if (key === 'job') queryFeedback.value = value; else feedback.value = value;
      }
    } finally { if (controllers.get(key) === controller) controllers.delete(key); }
  }
  function schedule() {
    clearTimeout(timer);
    if (polling && running.value && !busy.value && !pending.value && !queryError.value && task.readable) timer = setTimeout(() => { void refreshJob(undefined,false); }, 2000);
  }
  async function refreshJob(jobId = job.value?.id, forceDetail = true) {
    if (!jobId || !task.taskId || busy.value || pending.value) return;
    if(job.value?.id!==jobId&&adjustmentParent.value){if(!(await allowAdjustmentLeave()))return;clearAdjustment();}
    const expected=job.value?.id===jobId?copy(job.value):null;
    const value = await read('job', async signal => {
      const input={...options(signal),jobId,taskId:task.taskId};
      const progress=await previewService.getPlanningTaskProgress(input);
      const previous=expected?await planningProgress(expected):null;
      const next=forceDetail||!expected||previous?.adjustmentKey!==progress.adjustmentKey||previous?.resultKey!==progress.resultKey||expected.state!==progress.state&&['SUCCESS','FAILED','CANCELLED'].includes(progress.state)
        ?await previewService.getPlanningTask(input):{...expected,...progress};
      // 旧响应允许缺扩展，但已知调整作业后不能在轮询中丢掉其来源。
      if(expected?.adjustment&&(!sameValue(next.adjustment,expected.adjustment)||next.parentPlanId!==expected.parentPlanId))
        throw new ApiError('作业查询回显的调整来源与原提交不一致','INVALID_PLANNING_RESPONSE');
      return next;
    });
    if (value) {
      // 已确认保存的指针不被尚未同步的查询空值抹掉，版本仍只取服务响应。
      if(refreshRequiredJobId.value===value.id&&expected){
        value.savedPlanId??=expected.savedPlanId;
        for(const row of value.solutions??[])row.savedPlanId??=expected.solutions?.find(saved=>saved.solutionId===row.solutionId)?.savedPlanId??null;
      }
      job.value = value;
      if(refreshRequiredJobId.value===value.id)refreshRequiredJobId.value=null;
      if(value.adjustment&&!adjustmentParent.value){
        const parent=await read('plan',signal=>previewService.getPlanningPlan({...options(signal),taskId:value.taskId,planId:value.adjustment!.sourcePlanId}));
        if(parent&&job.value?.id===value.id&&parent.id===value.adjustment.sourcePlanId&&parent.result.snapshotId===value.adjustment.sourceSnapshotId){
          adjustmentParent.value=copy(parent);adjustmentDraft.value=copy(value.adjustment);adjustmentBaseline.value=JSON.stringify(value.adjustment);step.value=3;
        }
      }
      if (!value.result && value.state === 'SUCCESS' && !value.expired) notice.value = '作业已结束，但服务尚未提供完整可保存结果。';
    }
    schedule();
  }
  function start() { polling = true; if (job.value || savedJobId.value) void refreshJob(job.value?.id ?? savedJobId.value!,false); }
  async function refreshBlockingJob() {
    await refreshJob(unverifiedJobId.value ?? savedJobId.value ?? job.value?.id);
    polling = true; schedule();
  }
  async function loadPlans(nextPage = page.value) {
    const taskId = selectedPlan.value?.taskId ?? job.value?.taskId ?? task.taskId;
    if (!taskId) return; page.value = nextPage; loading.value = true;
    const value = await read('plans', signal => previewService.queryPlanningPlanSummaries({ ...options(signal), taskId, pageNum: nextPage, pageSize: 10 }));
    if (value) plans.value = value; loading.value = false;
  }
  async function selectPlan(planId: string, taskId = task.taskId, targetStep = 2) {
    if (busy.value || pending.value || !(await allowAdjustmentLeave())) return false;
    const adjustmentToken=adjustmentGeneration;
    const value = await read('plan', signal => previewService.getPlanningPlan({ ...options(signal), taskId, planId }));
    if (value&&adjustmentToken===adjustmentGeneration) { clearAdjustment();selectedPlan.value = value; step.value = targetStep; return true; }
    return false;
  }
  async function openHistoricalJob(taskId: string, jobId: string) {
    if (busy.value || pending.value || running.value || !(await allowAdjustmentLeave())) return false;
    if (task.taskId !== taskId && !(await task.open(taskId))) return false;
    else if (task.taskId === taskId && !(await task.allowLeave())) return false;
    await refreshJob(jobId);
    if (job.value?.id !== jobId) return false;
    selectedPlan.value = null; step.value = 2; start(); await loadPlans(1); return true;
  }
  async function openHistoricalPlan(taskId: string, planId: string, signal?: AbortSignal) {
    if (busy.value || pending.value || running.value || task.busy || task.pendingSave || !task.readable || signal?.aborted) return false;
    const sequence = ++historySequence, session = auth.generation, owner = lifetime;
    const valid = () => sequence === historySequence && session === auth.generation && owner === lifetime
      && !signal?.aborted && task.readable && !busy.value && !pending.value && !running.value;
    // 详情先验证，失败不切换任务；关闭目录可取消尚未完成的打开操作。
    const value = await read('plan', inner => previewService.getPlanningPlan({ ...options(signal ? AbortSignal.any([inner, signal]) : inner), taskId, planId }));
    if (!value || !valid()) return false;
    if (value.id !== planId || value.taskId !== taskId) { localError('历史方案与请求归属不一致'); return false; }
    if (!(await allowAdjustmentLeave(true)) || !valid()) return false;
    if (!(await task.allowLeave(true, ['planningAdjustment'])) || !valid()) return false;
    clearAdjustment();
    // 打开阶段关闭窗口时，任务读取也必须失效，不能只取消方案详情请求。
    const cancelTask = () => task.stop();
    signal?.addEventListener('abort', cancelTask, { once: true });
    try { if (!(await task.open(taskId, false))) return false; }
    finally { signal?.removeEventListener('abort', cancelTask); }
    // 任务切换的清理 watcher 先执行，再放入对应任务的冻结方案。
    await nextTick();
    if (!valid() || task.taskId !== taskId) return false;
    selectedPlan.value = value; job.value = null; step.value = 2;
    void loadPlans(1);
    return true;
  }
  async function reset() {
    if (!auth.can('planning.reset') || busy.value || pending.value || task.pendingSave || running.value || task.busy) return false;
    const token = generation, session = auth.generation, owner = lifetime;
    // 确认前读取当前版本；失败时保留全部输入和结果。
    const catalog = await read('plans', signal => previewService.loadPlanningOptions(options(signal)));
    if (!catalog && !['PLANNING_CORRUPT', 'PLANNING_INCOMPATIBLE'].includes(String(feedback.value?.code))) return false;
    const choice = await task.ask({ title: '重置规划数据', message: '清空规划作业、新保存方案、确认记录、干扰分析及措施采纳回执，恢复只读参考方案；已保存任务库、资源修改和诊断冻结记录保留。未保存规划输入将放弃，此操作不可恢复。', saveLabel: '重置规划数据' });
    if (choice !== 'save' || token !== generation || session !== auth.generation || !auth.can('planning.reset') || busy.value || pending.value || task.pendingSave || running.value || task.busy) return false;
    busy.value = true;
    try {
      const next = await previewService.resetPlanningReceipt({ ...options(), revision: catalog?.workspaceRevision ?? null });
      if (token !== generation || session !== auth.generation) return false;
      clearForTask(); if(task.catalog)task.catalog.workspaceRevision=next.revision; task.resetDraft(); notice.value = '规划数据已重置，独立任务库保留。';
      void legacy.refreshReadContext(); await task.refreshReferences(); return true;
    } catch (error) { if (token === generation && session === auth.generation) localError(error instanceof Error ? error.message : '重置失败，当前输入已保留'); return false; }
    finally { if (owner === lifetime) busy.value = false; }
  }
  async function write<T extends ApiPlan | ApiPlanningJob>(kind: PendingWrite['kind'], action: (requestId: string) => Promise<PlanningMutationReceipt>, apply: (value: T) => void,expected?:Omit<Partial<PendingWrite>,'kind'|'requestId'|'taskId'>, ownerTaskId = task.taskId): Promise<boolean> {
    if (busy.value || pending.value || !task.readable) return false;
    const operation = { kind, requestId: randomUuid(), taskId: ownerTaskId,...expected }, token = generation, session = auth.generation, owner = lifetime, draftTaskId = task.taskId;
    const epoch = ++feedbackEpoch, requestToken = ++feedbackSequence;
    busy.value = true; activeWriteKind.value = kind; feedback.value = null;
    // 取消/保存期间丢弃旧轮询，迟到的 RUNNING 不得覆盖终态或保存回执。
    controllers.get('job')?.abort(); controllers.delete('job'); clearTimeout(timer);
    let committed=false;
    try {
      const receipt=await action(operation.requestId);committed=true;
      const value=(receipt.referenceJob??(kind==='submit'||kind==='cancel'
        ?await previewService.getPlanningTask({...options(),taskId:receipt.taskId,jobId:receipt.objectId})
        :await previewService.getPlanningPlan({...options(),taskId:receipt.taskId,planId:receipt.objectId}))) as T;
      if(kind==='savePlan'&&expected)assertSaveIdentity(value as ApiPlan,expected);
      if(kind==='confirm')assertConfirmIdentity(value as ApiPlan,operation);
      if(expected?.adjustment&&(!sameValue(value.adjustment,expected.adjustment)||value.parentPlanId!==expected.parentPlanId))
        throw new ApiError('调整来源与原请求不一致','INVALID_PLANNING_RESPONSE');
      if (token !== generation || session !== auth.generation || task.taskId !== draftTaskId) {
        // 写入成功后失权仍保留核实入口，防止恢复权限后重复提交。
        if (owner === lifetime) { pending.value = operation; localError('写入期间会话状态变化，请恢复权限后核实原请求。', kind); }
        return false;
      }
      if (epoch === feedbackEpoch) clearFeedback(kind);
      if (kind === 'submit' && task.saved?.taskId === value.taskId) acceptedJobId.value = value.id;
      apply(value); void legacy.refreshReadContext(); return true;
    } catch (e) {
      if (owner === lifetime) {
        // 另一标签页或电脑已启动时，冲突回执提供的真实活跃作业也必须占用任务。
        if (kind === 'submit' && e instanceof ApiError && e.code === 2002 && e.status === 409 && task.saved?.taskId === ownerTaskId) {
          try {
            const active = apiRecord(e.data), id = apiId(active.job_id);
            if (active.task_id === ownerTaskId && (active.status === 'PENDING' || active.status === 'RUNNING')) {
              checkedJobs.value[id] = { taskId: ownerTaskId, state: active.status };
              acceptedJobId.value = id;
            }
          } catch { /* 损坏的冲突数据只展示原错误，不能成为新的任务身份。 */ }
        }
        const uncertain = committed || uncertainWrite(e); if (uncertain) pending.value = operation;
        // 写入的不确定回执继续保留；过期上下文不带回旧会话的错误详情。
        if (token === generation && session === auth.generation && draftTaskId === task.taskId && task.readable && epoch === feedbackEpoch) {
          const value = failure(kind, requestToken, e, '操作失败', operation.taskId);
          if (uncertain) value.message += committed?'。操作已受理，详情读取失败，请核实原请求。':'。结果待核实，请查询原请求回执。';
          feedback.value = value;
        }
      }
      return false;
    } finally { if (owner === lifetime) { busy.value = false; activeWriteKind.value = null; } }
  }
  async function submit() {
    if (!canSubmit.value || !task.saved) { localError('请先保存当前任务，并等待已有作业或待核实操作完成', pending.value?.kind ?? 'local'); return; }
    const saved = task.saved;
    if (await write<ApiPlanningJob>('submit', requestId => previewService.submitPlanningReceipt({ ...options(), taskId: saved.taskId, requestId, revision: saved.revision, inputVersion: saved.inputVersion, conditionVersion: saved.conditionVersion, resourceRevision: task.resourceRevision, parentPlanId: parentPlanId.value }), value => { job.value = value; selectedPlan.value = null; queryFeedback.value = null; step.value = 2; })) { polling = true; schedule(); }
  }
  async function cancel() {
    const current = job.value; if (!current || !running.value || current.cancelRequested || !auth.can('planning.execute')) return;
    const owner=current.adjustment?{generation,session:auth.generation,taskId:task.taskId}:null;
    const expected=current.adjustment?{adjustment:copy(current.adjustment),parentPlanId:current.parentPlanId}:undefined;
    if (await task.ask({ title: '取消规划任务', message: '向服务端请求取消当前作业；最终状态以服务端响应为准。', saveLabel: '请求取消' }) !== 'save') return;
    // 已知调整作业的确认弹窗只属于当前任务和账号，不能取消后来切换的对象。
    if(owner&&(owner.generation!==generation||owner.session!==auth.generation||owner.taskId!==task.taskId||job.value?.id!==current.id||!running.value||!auth.can('planning.execute')))return;
    await write<ApiPlanningJob>('cancel', requestId => previewService.cancelPlanningReceipt({ ...options(), taskId: current.taskId, jobId: current.id, revision: current.revision, requestId }), value => { job.value = value; },expected,current.taskId); schedule();
  }
  // 写后读取当前作业，不把方案修订号当作作业修订号。
  async function refreshWrittenJob(jobId:string){
    if(job.value?.id!==jobId)return;
    await refreshJob(jobId,false);
    if(refreshRequiredJobId.value===jobId&&queryError.value)notice.value+=' 作业状态刷新失败，可返回本次备选方案后恢复查询。';
  }
  async function savePlan(name: string, note: string) {
    const current = job.value; if (!canSave.value || !current) return false;
    const expected={jobId:current.id,snapshotId:currentResult.value!.snapshotId,name,note,...(currentSolution.value?{solutionId:currentSolution.value.solutionId}:{}),...(current.adjustment?{adjustment:copy(current.adjustment),parentPlanId:current.parentPlanId}:{})};
    const ok = await write<ApiPlan>('savePlan', async requestId => {
      return previewService.savePlanningReceipt({ ...options(), taskId: current.taskId, jobId: current.id, revision: current.revision, requestId, name, note,...(expected.solutionId?{solutionId:expected.solutionId,snapshotId:expected.snapshotId}:{}) });
    }, value => { selectedPlan.value = value; markSaved(value); refreshRequiredJobId.value=current.id; notice.value = '方案版本已保存。'; },expected,current.taskId);
    // 保存结果已确认；后续版本读取失败只保留查询错误，不重发写入。
    if (ok) { await refreshWrittenJob(current.id); await loadPlans(1); } return ok;
  }
  async function confirm() {
    if (!canConfirm.value || !selectedPlan.value) return;
    const current = copy(selectedPlan.value);
    const owner={generation,session:auth.generation,taskId:task.taskId};
    const expected={planId:current.id,planVersion:current.version,snapshotId:current.result.snapshotId,...(current.adjustment?{adjustment:copy(current.adjustment),parentPlanId:current.parentPlanId}:{})};
    if (await task.ask({ title: '确认方案转正', message: `将“${current.name} · ${current.version}”转正并设为本任务当前方案，保留旧版本。请先核对方案配置；本操作不下发设备，也不改写资源台账。`, saveLabel: '确认转正' }) !== 'save') return;
    if(owner.generation!==generation||owner.session!==auth.generation||owner.taskId!==task.taskId||selectedPlan.value?.id!==current.id||selectedPlan.value.version!==current.version||selectedPlan.value.result.snapshotId!==current.result.snapshotId||!canConfirm.value)return;
    const ok=await write<ApiPlan>('confirm', requestId => previewService.confirmPlanningReceipt({ ...options(), taskId: current.taskId, planId: current.id, revision: current.revision, requestId }), value => {
      selectedPlan.value = value;refreshRequiredJobId.value=job.value?.id??null;notice.value = value.confirmedConfiguration?'方案已转正，可查看正式配置快照。':'方案已转正；服务未返回正式配置快照。';
    },expected,current.taskId);
    // 确认结果与后续查询分开处理，查询失败不重发已成功的确认。
    if(ok){if(refreshRequiredJobId.value)await refreshWrittenJob(refreshRequiredJobId.value);await loadPlans();}
  }
  async function compare(planIds: string[]) {
    if (pending.value || busy.value) return;
    const taskId = selectedPlan.value?.taskId ?? job.value?.taskId ?? task.taskId;
    const value = await read('compare', signal => previewService.comparePlanningPlans({ ...options(signal), taskId, planIds })); if (value) comparison.value = value;
  }
  async function adjust() {
    if (unverifiedJobId.value) await refreshBlockingJob();
    const plan = selectedPlan.value; if (!plan || !task.editable || adjustmentParent.value&&!(await allowAdjustmentLeave()) || !(await task.copyPlanInput(plan))) return;
    feedbackEpoch++; clearFeedback();
    parentPlanId.value = plan.id; selectedPlan.value = null; job.value = null; step.value = 1;
    notice.value = '已复制方案输入，可修改任务条件；保存后重新提交将生成关联此父版本的新结果。';
    await task.refreshReferences();
  }
  function clearAdjustment(){clearTimeout(previewTimer);previewQueued.value=false;lastPreviewAttempt='';adjustmentGeneration++;adjustmentParent.value=null;adjustmentDraft.value=null;adjustmentOpen.value=false;adjustmentBaseline.value='';adjustmentIssues.value=[];delete task.auxiliary.planningAdjustment;}
  function adjustmentUnavailable(plan:ApiPlan|null=selectedPlan.value):string|null{
    if(!plan)return '请先选择已保存的完整方案。';
    if(plan.sourceChanged||task.saved?.taskId===plan.taskId&&task.saved.conditionVersion!==plan.conditionVersion)return '方案来源已变化，仅可查看历史结果。';
    if(!plan.result?.configuration||!plan.result.snapshotId)return '此历史方案没有完整配置快照。';
    return null;
  }
  async function openPlanAdjustment(){
    const plan=selectedPlan.value;if(!plan||!auth.can('planning.execute')||!task.readable||busy.value||running.value||pending.value)return false;
    const reason=adjustmentUnavailable(plan);if(reason){localError(reason);return false;}
    const session=auth.generation,token=generation;
    if(!(await allowAdjustmentLeave())||!(await task.allowLeave())||session!==auth.generation||token!==generation||!auth.can('planning.execute'))return false;
    clearAdjustment();adjustmentParent.value=copy(plan);adjustmentDraft.value=createPlanningAdjustment(contextFor(plan));
    adjustmentBaseline.value=JSON.stringify(adjustmentDraft.value);adjustmentOpen.value=true;step.value=3;clearFeedback();await task.loadAdjustmentExamples();return true;
  }
  function updateAdjustment(value:PlanningAdjustment){
    if(!auth.can('planning.execute')||!task.readable||adjustmentLocked.value||(!automaticPreview.value&&running.value)||!adjustmentParent.value)return;
    adjustmentGeneration++;adjustmentDraft.value=copy(value);adjustmentIssues.value=validatePlanningAdjustment(value,contextFor(adjustmentParent.value));clearFeedback('submit');queuePreview();
  }
  async function allowAdjustmentLeave(deferDiscard=false){
    if(busy.value||pending.value||adjustmentParent.value&&running.value){localError('请先等待调整完成或核实原请求回执');return false;}
    if(!adjustmentDirty.value)return true;
    const token=generation,session=auth.generation;
    const answer=await task.ask({title:'未提交的方案调整',message:'放弃本次设备参数与主路径输入后继续，原任务和父方案保持不变。',discardLabel:'放弃调整',cancelLabel:'继续编辑'});
    if(answer!=='discard'||token!==generation||session!==auth.generation)return false;
    if(!deferDiscard)clearAdjustment();return true;
  }
  async function closeAdjustment(){
    clearTimeout(previewTimer);previewQueued.value=false;
    // 已提交作业的抽屉可收起，父方案和提交现场仍保留在结果页。
    if(running.value&&!busy.value&&!pending.value){adjustmentOpen.value=false;return true;}
    if(!(await allowAdjustmentLeave())){queuePreview();return false;}adjustmentOpen.value=false;return true;
  }
  async function submitAdjustment(){
    clearTimeout(previewTimer);previewQueued.value=false;
    const parent=adjustmentParent.value,adjustment=adjustmentDraft.value,saved=task.saved;
    if(!parent||!adjustment||!saved||!auth.can('planning.execute')||!task.readable||busy.value||running.value||pending.value||task.pendingSave)return false;
    const reason=adjustmentUnavailable(parent);if(reason){localError(reason);return false;}
    if(saved.taskId!==parent.taskId||task.changed||task.importFiles.length){localError('请保持父方案的已保存任务条件，完成当前任务输入处理后再调整');return false;}
    adjustmentIssues.value=validatePlanningAdjustment(adjustment,contextFor(parent));if(adjustmentIssues.value.length){localError('请检查调整输入');return false;}
    const request=copy(adjustment);
    lastPreviewAttempt=JSON.stringify(request);
    const ok=await write<ApiPlanningJob>('submit',requestId=>previewService.submitPlanningReceipt({...options(),taskId:saved.taskId,requestId,revision:saved.revision,inputVersion:saved.inputVersion,
      conditionVersion:saved.conditionVersion,resourceRevision:task.resourceRevision,parentPlanId:parent.id,adjustment:request}),value=>{
        job.value=value;selectedPlan.value=null;adjustmentBaseline.value=JSON.stringify(request);adjustmentOpen.value=automaticPreview.value;queryFeedback.value=null;step.value=3;
      },{adjustment:request,parentPlanId:parent.id});
    if(ok){polling=true;schedule();}queuePreview();return ok;
  }
  async function reconcile() {
    const current = pending.value; if (!current || busy.value) return;
    const receipt = await read('receipt', signal => previewService.getPlanningOperation({ ...options(signal), kind:current.kind,requestId:current.requestId,taskId:current.taskId })); if (!receipt) return;
    if (receipt.state === 'SUCCEEDED' && receipt.entityId) {
      if (current.kind === 'submit' || current.kind === 'cancel') {
        const value = await read('receipt-job', async signal => {
          const next=await previewService.getPlanningTask({ ...options(signal), taskId: current.taskId, jobId: receipt.entityId! });
          const expected=current.adjustment?current:current.kind==='cancel'?job.value:null;
          if(expected?.adjustment&&(!sameValue(next.adjustment,expected.adjustment)||next.parentPlanId!==expected.parentPlanId))
            throw new ApiError('原请求回执的调整来源与提交输入不一致','INVALID_PLANNING_RESPONSE');
          return next;
        });
        if (!value) return; job.value = value; selectedPlan.value = null;
        if (current.kind === 'submit' && task.saved?.taskId === value.taskId) acceptedJobId.value = value.id;
        if(value.adjustment&&adjustmentDraft.value&&JSON.stringify(value.adjustment)===JSON.stringify(adjustmentDraft.value)){adjustmentBaseline.value=JSON.stringify(value.adjustment);step.value=3;}else step.value=2;
      } else {
        const value = await read('receipt-plan', async signal => {
          const plan=await previewService.getPlanningPlan({ ...options(signal), taskId: current.taskId, planId: receipt.entityId! });
          if(current.kind==='savePlan')assertSaveIdentity(plan,current);
          if(current.kind==='confirm')assertConfirmIdentity(plan,current);
          const expected=current;
          if(expected?.adjustment&&(!sameValue(plan.adjustment,expected.adjustment)||plan.parentPlanId!==expected.parentPlanId))
            throw new ApiError('原操作回执的调整来源与已知输入不一致','INVALID_PLANNING_RESPONSE');
          return plan;
        });
        if (!value) return; selectedPlan.value = value; markSaved(value);
        if(job.value&&(current.kind==='confirm'||current.kind==='savePlan'&&job.value.id===current.jobId))refreshRequiredJobId.value=job.value.id;
      }
      pending.value = null; notice.value = '已核实原请求成功。'; clearFeedback(current.kind); polling = true; schedule(); void legacy.refreshReadContext();
      // 核实成功的保存或确认沿用同一刷新流程，不再持有写入前的作业版本。
      if((current.kind==='savePlan'||current.kind==='confirm')&&refreshRequiredJobId.value)await refreshWrittenJob(refreshRequiredJobId.value);
      await loadPlans();
    } else if (receipt.state === 'FAILED' || receipt.state === 'NOT_FOUND') { pending.value = null; localError(receipt.message || '已核实原请求未成功，可重新操作。', 'receipt'); }
    else notice.value = '原请求仍在处理中，请稍后核实。';
  }
  function clearForTask() { clearAdjustment();stop(); feedbackEpoch++; clearFeedback(); refreshRequiredJobId.value = null; job.value = null; checkedJobs.value = {}; acceptedJobId.value = null; selectedPlan.value = null; plans.value = null; comparison.value = []; parentPlanId.value = null; step.value = 1; page.value = 1; notice.value = ''; task.running = executionBlocked.value || busy.value || !!pending.value; }
  watch(() => task.taskId, () => {
    if (!busy.value && !pending.value) clearForTask();
    else { feedbackEpoch++; clearFeedback(); } // 保留待核对写入，但详情不能串到另一个任务。
  });
  function clearForSession() { lifetime++; pending.value = null; busy.value = false; activeWriteKind.value = null; clearForTask(); }
  return { job, selectedPlan, plans, comparison, page, step, error, queryError, notice, businessDetails, feedback, queryFeedback, busy, loading, pending, parentPlanId, running, executionBlocked, unverifiedJobId, result, sourceChanged, canSubmit, canSave, canConfirm,
    selectedSolutionId,currentSolution,currentResult,currentOutcome,currentExpired,currentSavedPlanId,selectSolution,
    adjustmentParent,adjustmentDraft,adjustmentContext,adjustmentOpen,adjustmentDirty,adjustmentIssues,adjustmentResult,adjustmentStatus,
    automaticPreview,previewQueued,adjustmentLocked,setAutomaticPreview,pauseAutomaticPreview,resumeAutomaticPreview,
    adjustmentUnavailable,openPlanAdjustment,updateAdjustment,closeAdjustment,allowAdjustmentLeave,submitAdjustment,
    discardAdjustment: clearAdjustment,
    refreshJob, refreshBlockingJob, start, stop, loadPlans, selectPlan, openHistoricalJob, openHistoricalPlan, reset, submit, cancel, savePlan, confirm, compare, adjust, reconcile, clearForSession, localError };
});
