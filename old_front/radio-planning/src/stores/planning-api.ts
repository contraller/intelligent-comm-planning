import { computed, ref, toRaw, watch } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { planPasses } from '../services/planning-api-validation';
import { sameValue } from '../services/planning-validation';
import type { PlanningApiFeedbackState, PlanningFeedbackOperation } from '../services/planning-api-feedback';
import type { ApiPlan, ApiPlanningJob } from '../types/planning-api';
import type { ApiPage, OperationKind } from '../types/task-api';
import { useAuthStore } from './auth';
import { uncertainWrite, useTaskInputStore } from './task-input';
import { createPlanningAdjustment, validatePlanningAdjustment } from '../services/planning-adjustment';
import type { PlanningAdjustment, PlanningAdjustmentContext } from '../types/planning-adjustment';
import type { PlanningIssue } from '../types/planning';

interface PendingWrite { kind: Exclude<OperationKind, 'saveTask'>; requestId: string; taskId: string; adjustment?:PlanningAdjustment; parentPlanId?:string|null; jobId?:string; solutionId?:string; snapshotId?:string; name?:string; note?:string }
// 只维护当前任务的接口现场；分页历史、异步作业和输入草稿各自独立。
export const usePlanningApiStore = defineStore('planning-api', () => {
  const auth = useAuthStore(), task = useTaskInputStore();
  const job = ref<ApiPlanningJob | null>(null), selectedPlan = ref<ApiPlan | null>(null), plans = ref<ApiPage<ApiPlan> | null>(null), comparison = ref<ApiPlan[]>([]);
  const selectedSolutionId=ref('');
  const currentSolution=computed(()=>job.value?.solutions?.find(row=>row.solutionId===selectedSolutionId.value)??null);
  const currentResult=computed(()=>job.value?.solutions?currentSolution.value?.result??null:job.value?.result??null);
  const currentOutcome=computed(()=>job.value?.solutions?currentSolution.value?.outcome??job.value.outcome:job.value?.outcome);
  const currentExpired=computed(()=>currentSolution.value?.expired??job.value?.expired??false);
  const currentSavedPlanId=computed(()=>job.value?.solutions?currentSolution.value?.savedPlanId??null:job.value?.savedPlanId??null);
  // 轮询保留有效选择；换作业和重新进入才采用服务指定的默认结果。
  watch(job,(next,previous)=>{if(!next?.solutions)selectedSolutionId.value='';else if(next.id!==previous?.id||!next.solutions.some(row=>row.solutionId===selectedSolutionId.value))selectedSolutionId.value=next.defaultSolutionId??'';},{flush:'sync'});
  function selectSolution(id:string){
    if(!task.readable||busy.value||pending.value||adjustmentDirty.value||!job.value?.solutions?.some(row=>row.solutionId===id))return false;
    selectedSolutionId.value=id;selectedPlan.value=null;step.value=2;return true;
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
  const page = ref(1), step = ref(1), notice = ref(''), busy = ref(false), loading = ref(false);
  const feedback = ref<PlanningApiFeedbackState | null>(null), queryFeedback = ref<PlanningApiFeedbackState | null>(null);
  const error = computed(() => feedback.value?.message ?? ''), queryError = computed(() => queryFeedback.value?.message ?? '');
  // 兼容读取只取完整的一条反馈，不能把另一次请求的载荷拼到当前摘要下。
  const businessDetails = computed(() => feedback.value ? feedback.value.data ?? null : queryFeedback.value?.data ?? null);
  const pending = ref<PendingWrite | null>(null), parentPlanId = ref<string | null>(null);
  // 参数与路径草稿只从父结果读取，不写回任务输入或资源台账。
  const adjustmentParent=ref<ApiPlan|null>(null),adjustmentDraft=ref<PlanningAdjustment|null>(null),adjustmentOpen=ref(false),adjustmentBaseline=ref('');
  const adjustmentIssues=ref<PlanningIssue[]>([]);
  let adjustmentGeneration=0;
  const copy=<T>(value:T):T=>structuredClone(toRaw(value));
  const contextFor=(plan:ApiPlan):PlanningAdjustmentContext=>({id:plan.id,snapshotId:plan.result.snapshotId,input:plan.input,configuration:plan.result.configuration,nodeIds:plan.result.nodes.map(n=>n.id)});
  const adjustmentContext=computed(()=>adjustmentParent.value?contextFor(adjustmentParent.value):null);
  const adjustmentDirty=computed(()=>!!adjustmentDraft.value&&JSON.stringify(adjustmentDraft.value)!==adjustmentBaseline.value);
  const adjustmentResult=computed(()=>adjustmentParent.value&&job.value?.state==='SUCCESS'&&JSON.stringify(job.value.adjustment)===JSON.stringify(adjustmentDraft.value)?job.value.result:null);
  const adjustmentStatus=computed(()=>pending.value?'调整提交结果待核实，请查询原请求回执。':adjustmentDirty.value?'调整输入尚未提交，下方保留父方案。':running.value?'调整正在处理，下方保留父方案。':adjustmentResult.value?'调整完成，预览读取新结果；保存后形成新版本。':job.value?.adjustment?'调整未成功完成，输入及父方案保留。':'尚未提交调整，下方显示父方案。');
  let generation = 0, lifetime = 0, timer: ReturnType<typeof setTimeout> | undefined, polling = false;
  let feedbackEpoch = 0, feedbackSequence = 0;
  const controllers = new Map<string, AbortController>();
  const running = computed(() => !!job.value && ['PENDING','RUNNING'].includes(job.value.state));
  const result = computed(() => selectedPlan.value?.result ?? currentResult.value);
  const sourceChanged = computed(() => {
    const snapshot=selectedPlan.value??job.value;
    return !!snapshot && (snapshot.sourceChanged || task.saved?.taskId===snapshot.taskId && task.saved.conditionVersion!==snapshot.conditionVersion);
  });
  const canSubmit = computed(() => auth.can('planning.execute') && !adjustmentOpen.value && !adjustmentDirty.value && !!task.saved && !task.dirty && !task.pendingSave && !running.value && !busy.value && !pending.value);
  const canSave = computed(() => auth.can('planning.save') && !adjustmentDirty.value && !busy.value && !pending.value && !queryError.value && !selectedPlan.value && job.value?.state === 'SUCCESS' && !!currentResult.value && !currentExpired.value && !currentSavedPlanId.value);
  const canConfirm = computed(() => auth.can('planning.confirm') && !busy.value && !pending.value && !!selectedPlan.value && selectedPlan.value.state === 'SAVED' && !sourceChanged.value && planPasses(selectedPlan.value.result) && selectedPlan.value.outcome.code === 0);
  const options = (signal?: AbortSignal) => ({ context: task.context, signal });
  watch(() => [running.value, busy.value, pending.value,adjustmentOpen.value] as const, () => { task.running = running.value || busy.value || !!pending.value || adjustmentOpen.value; }, { flush: 'sync' });
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
  function failure(operation: PlanningFeedbackOperation, requestToken: number, e: unknown, fallback: string): PlanningApiFeedbackState {
    return { operation, taskId: task.taskId, requestToken, message: e instanceof Error ? e.message : fallback,
      ...(e instanceof ApiError ? { code: e.code, requestId: e.requestId, data: e.data } : {}) };
  }
  function stop() { generation++; polling = false; clearTimeout(timer); controllers.forEach(c => c.abort()); controllers.clear(); loading.value = false; }
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
    if (polling && running.value && !busy.value && !pending.value && !queryError.value && task.readable) timer = setTimeout(() => { void refreshJob(); }, 2000);
  }
  async function refreshJob(jobId = job.value?.id) {
    if (!jobId || !task.taskId || busy.value || pending.value) return;
    if(job.value?.id!==jobId&&adjustmentParent.value){if(!(await allowAdjustmentLeave()))return;clearAdjustment();}
    const expected=job.value?.id===jobId?copy(job.value):null;
    const value = await read('job', async signal => {
      const next=await previewService.getPlanningTask({ ...options(signal), jobId, taskId: task.taskId });
      // 旧响应允许缺扩展，但已知调整作业后不能在轮询中丢掉其来源。
      if(expected?.adjustment&&(!sameValue(next.adjustment,expected.adjustment)||next.parentPlanId!==expected.parentPlanId))
        throw new ApiError('作业查询回显的调整来源与原提交不一致','INVALID_PLANNING_RESPONSE');
      return next;
    });
    if (value) {
      job.value = value;
      if(value.adjustment&&!adjustmentParent.value){
        const parent=await read('plan',signal=>previewService.getPlanningPlan({...options(signal),taskId:value.taskId,planId:value.adjustment!.sourcePlanId}));
        if(parent&&job.value?.id===value.id&&parent.id===value.adjustment.sourcePlanId&&parent.result.snapshotId===value.adjustment.sourceSnapshotId){
          adjustmentParent.value=copy(parent);adjustmentDraft.value=copy(value.adjustment);adjustmentBaseline.value=JSON.stringify(value.adjustment);step.value=3;
        }
      }
      if (!value.result && value.state === 'SUCCESS') notice.value = '作业已结束，但接口尚未提供完整可保存结果。';
    }
    schedule();
  }
  function start() { polling = true; if (job.value) void refreshJob(); }
  async function loadPlans(nextPage = page.value) {
    if (!task.taskId) return; page.value = nextPage; loading.value = true;
    const value = await read('plans', signal => previewService.queryPlanningPlans({ ...options(signal), taskId: task.taskId, page: nextPage, pageSize: 10 }));
    if (value) plans.value = value; loading.value = false;
  }
  async function selectPlan(planId: string) {
    if (busy.value || pending.value || !(await allowAdjustmentLeave())) return;
    const adjustmentToken=adjustmentGeneration;
    const value = await read('plan', signal => previewService.getPlanningPlan({ ...options(signal), taskId: task.taskId, planId }));
    if (value&&adjustmentToken===adjustmentGeneration) { clearAdjustment();selectedPlan.value = value; step.value = 2; }
  }
  async function write<T extends ApiPlan | ApiPlanningJob>(kind: PendingWrite['kind'], action: (requestId: string) => Promise<T>, apply: (value: T) => void,expected?:Omit<Partial<PendingWrite>,'kind'|'requestId'|'taskId'>): Promise<boolean> {
    if (busy.value || pending.value || !task.readable) return false;
    const operation = { kind, requestId: crypto.randomUUID(), taskId: task.taskId,...expected }, token = generation, session = auth.generation, owner = lifetime;
    const epoch = ++feedbackEpoch, requestToken = ++feedbackSequence;
    busy.value = true; feedback.value = null;
    // 取消/保存期间丢弃旧轮询，迟到的 RUNNING 不得覆盖终态或保存回执。
    controllers.get('job')?.abort(); controllers.delete('job'); clearTimeout(timer);
    try {
      const value = await action(operation.requestId);
      if(expected?.adjustment&&(!sameValue(value.adjustment,expected.adjustment)||value.parentPlanId!==expected.parentPlanId))
        throw new ApiError('调整提交回显与原请求不一致','INVALID_PLANNING_RESPONSE');
      if (token !== generation || session !== auth.generation || task.taskId !== operation.taskId) {
        // 写入成功后失权仍保留核实入口，防止恢复权限后重复提交。
        if (owner === lifetime) { pending.value = operation; localError('写入期间会话状态变化，请恢复权限后核实原请求。', kind); }
        return false;
      }
      if (epoch === feedbackEpoch) clearFeedback(kind);
      apply(value); return true;
    } catch (e) {
      if (owner === lifetime) {
        const uncertain = uncertainWrite(e); if (uncertain) pending.value = operation;
        // 写入的不确定回执继续保留；过期上下文不带回旧会话的错误详情。
        if (token === generation && session === auth.generation && operation.taskId === task.taskId && task.readable && epoch === feedbackEpoch) {
          const value = failure(kind, requestToken, e, '操作失败');
          if (uncertain) value.message += '。结果待核实，请查询原请求回执。';
          feedback.value = value;
        }
      }
      return false;
    } finally { busy.value = false; }
  }
  async function submit() {
    if (!canSubmit.value || !task.saved) { localError('请先保存当前任务，并等待已有作业或待核实操作完成', pending.value?.kind ?? 'local'); return; }
    const saved = task.saved;
    if (await write('submit', requestId => previewService.submitPlanningTask({ ...options(), taskId: saved.taskId, requestId, revision: saved.revision, inputVersion: saved.inputVersion, conditionVersion: saved.conditionVersion, resourceRevision: task.resourceRevision, parentPlanId: parentPlanId.value }), value => { job.value = value; selectedPlan.value = null; queryFeedback.value = null; step.value = 2; })) { polling = true; schedule(); }
  }
  async function cancel() {
    const current = job.value; if (!current || !running.value || !auth.can('planning.execute')) return;
    const owner=current.adjustment?{generation,session:auth.generation,taskId:task.taskId}:null;
    const expected=current.adjustment?{adjustment:copy(current.adjustment),parentPlanId:current.parentPlanId}:undefined;
    if (await task.ask({ title: '取消规划任务', message: '向服务端请求取消当前作业；最终状态以服务端响应为准。', saveLabel: '请求取消' }) !== 'save') return;
    // 已知调整作业的确认弹窗只属于当前任务和账号，不能取消后来切换的对象。
    if(owner&&(owner.generation!==generation||owner.session!==auth.generation||owner.taskId!==task.taskId||job.value?.id!==current.id||!running.value||!auth.can('planning.execute')))return;
    await write('cancel', requestId => previewService.cancelPlanningTask({ ...options(), taskId: current.taskId, jobId: current.id, revision: current.revision, requestId }), value => { job.value = value; },expected); schedule();
  }
  async function savePlan(name: string, note: string) {
    const current = job.value; if (!canSave.value || !current) return false;
    const expected={jobId:current.id,snapshotId:currentResult.value!.snapshotId,name,note,...(currentSolution.value?{solutionId:currentSolution.value.solutionId}:{}),...(current.adjustment?{adjustment:copy(current.adjustment),parentPlanId:current.parentPlanId}:{})};
    const ok = await write('savePlan', async requestId => {
      const value=await previewService.savePlanningPlan({ ...options(), taskId: current.taskId, jobId: current.id, revision: current.revision, requestId, name, note,...(expected.solutionId?{solutionId:expected.solutionId,snapshotId:expected.snapshotId}:{}) });
      assertSaveIdentity(value,expected);
      // 已知本次提交时，保存回执必须保留同一份人工输入及父版本；损坏回包进入核实流程。
      if(current.adjustment&&(!sameValue(value.adjustment,current.adjustment)||value.parentPlanId!==current.parentPlanId))
        throw new ApiError('保存回执的调整来源与当前作业不一致','INVALID_PLANNING_RESPONSE');
      return value;
    }, value => { selectedPlan.value = value; markSaved(value); notice.value = '方案版本已保存。'; },expected);
    if (ok) await loadPlans(1); return ok;
  }
  async function confirm() {
    const current = selectedPlan.value; if (!canConfirm.value || !current) return;
    const owner=current.adjustment?{generation,session:auth.generation,taskId:task.taskId}:null;
    const expected=current.adjustment?{adjustment:copy(current.adjustment),parentPlanId:current.parentPlanId}:undefined;
    if (await task.ask({ title: '确认方案配置', message: '将此版本设置为当前确认方案，保留旧版本。本操作不下发设备，也不改写资源台账。', saveLabel: '确认方案' }) !== 'save') return;
    if(owner&&(owner.generation!==generation||owner.session!==auth.generation||owner.taskId!==task.taskId||selectedPlan.value?.id!==current.id||!canConfirm.value))return;
    if (await write('confirm', requestId => previewService.confirmPlanningPlan({ ...options(), taskId: current.taskId, planId: current.id, revision: current.revision, requestId }), value => { selectedPlan.value = value; notice.value = '方案配置已确认。'; },expected)) await loadPlans();
  }
  async function compare(planIds: string[]) {
    if (pending.value || busy.value) return;
    const value = await read('compare', signal => previewService.comparePlanningPlans({ ...options(signal), taskId: task.taskId, planIds })); if (value) comparison.value = value;
  }
  async function adjust() {
    const plan = selectedPlan.value; if (!plan || !task.editable || adjustmentParent.value&&!(await allowAdjustmentLeave()) || !(await task.allowLeave())) return;
    feedbackEpoch++; clearFeedback();
    task.updateInput(plan.input); parentPlanId.value = plan.id; selectedPlan.value = null; job.value = null; step.value = 1;
    notice.value = '已复制方案输入，可修改任务条件；保存后重新提交将生成关联此父版本的新结果。';
    await task.refreshReferences();
  }
  function clearAdjustment(){adjustmentGeneration++;adjustmentParent.value=null;adjustmentDraft.value=null;adjustmentOpen.value=false;adjustmentBaseline.value='';adjustmentIssues.value=[];delete task.auxiliary.planningAdjustment;}
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
    adjustmentBaseline.value=JSON.stringify(adjustmentDraft.value);adjustmentOpen.value=true;step.value=3;clearFeedback();return true;
  }
  function updateAdjustment(value:PlanningAdjustment){
    if(!auth.can('planning.execute')||!task.readable||busy.value||running.value||pending.value||!adjustmentParent.value)return;
    adjustmentGeneration++;adjustmentDraft.value=copy(value);adjustmentIssues.value=[];clearFeedback('submit');
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
    // 已提交作业的抽屉可收起，父方案和提交现场仍保留在结果页。
    if(running.value&&!busy.value&&!pending.value){adjustmentOpen.value=false;return true;}
    if(!(await allowAdjustmentLeave()))return false;adjustmentOpen.value=false;return true;
  }
  async function submitAdjustment(){
    const parent=adjustmentParent.value,adjustment=adjustmentDraft.value,saved=task.saved;
    if(!parent||!adjustment||!saved||!auth.can('planning.execute')||!task.readable||busy.value||running.value||pending.value||task.pendingSave)return false;
    const reason=adjustmentUnavailable(parent);if(reason){localError(reason);return false;}
    if(saved.taskId!==parent.taskId||task.changed||task.importFiles.length){localError('请保持父方案的已保存任务条件，完成当前任务输入处理后再调整');return false;}
    adjustmentIssues.value=validatePlanningAdjustment(adjustment,contextFor(parent));if(adjustmentIssues.value.length){localError('请检查调整输入');return false;}
    const request=copy(adjustment);
    const ok=await write('submit',requestId=>previewService.submitPlanningTask({...options(),taskId:saved.taskId,requestId,revision:saved.revision,inputVersion:saved.inputVersion,
      conditionVersion:saved.conditionVersion,resourceRevision:task.resourceRevision,parentPlanId:parent.id,adjustment:request}),value=>{
        job.value=value;selectedPlan.value=null;adjustmentBaseline.value=JSON.stringify(request);adjustmentOpen.value=false;queryFeedback.value=null;step.value=3;
      },{adjustment:request,parentPlanId:parent.id});
    if(ok){polling=true;schedule();}return ok;
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
        if(value.adjustment&&adjustmentDraft.value&&JSON.stringify(value.adjustment)===JSON.stringify(adjustmentDraft.value)){adjustmentBaseline.value=JSON.stringify(value.adjustment);step.value=3;}else step.value=2;
      } else {
        const value = await read('receipt-plan', async signal => {
          const plan=await previewService.getPlanningPlan({ ...options(signal), taskId: current.taskId, planId: receipt.entityId! });
          if(current.kind==='savePlan')assertSaveIdentity(plan,current);
          const expected=current;
          if(expected?.adjustment&&(!sameValue(plan.adjustment,expected.adjustment)||plan.parentPlanId!==expected.parentPlanId))
            throw new ApiError('原操作回执的调整来源与已知输入不一致','INVALID_PLANNING_RESPONSE');
          return plan;
        });
        if (!value) return; selectedPlan.value = value; markSaved(value);
      }
      pending.value = null; notice.value = '已核实原请求成功。'; clearFeedback(current.kind); polling = true; schedule(); await loadPlans();
    } else if (receipt.state === 'FAILED' || receipt.state === 'NOT_FOUND') { pending.value = null; localError(receipt.message || '已核实原请求未成功，可重新操作。', 'receipt'); }
    else notice.value = '原请求仍在处理中，请稍后核实。';
  }
  function clearForTask() { clearAdjustment();stop(); feedbackEpoch++; clearFeedback(); job.value = null; selectedPlan.value = null; plans.value = null; comparison.value = []; parentPlanId.value = null; step.value = 1; page.value = 1; notice.value = ''; task.running = false; }
  watch(() => task.taskId, () => {
    if (!busy.value && !pending.value) clearForTask();
    else { feedbackEpoch++; clearFeedback(); } // 保留待核对写入，但详情不能串到另一个任务。
  });
  function clearForSession() { lifetime++; pending.value = null; busy.value = false; clearForTask(); }
  return { job, selectedPlan, plans, comparison, page, step, error, queryError, notice, businessDetails, feedback, queryFeedback, busy, loading, pending, parentPlanId, running, result, sourceChanged, canSubmit, canSave, canConfirm,
    selectedSolutionId,currentSolution,currentResult,currentOutcome,currentExpired,currentSavedPlanId,selectSolution,
    adjustmentParent,adjustmentDraft,adjustmentContext,adjustmentOpen,adjustmentDirty,adjustmentIssues,adjustmentResult,adjustmentStatus,
    adjustmentUnavailable,openPlanAdjustment,updateAdjustment,closeAdjustment,allowAdjustmentLeave,submitAdjustment,
    refreshJob, start, stop, loadPlans, selectPlan, submit, cancel, savePlan, confirm, compare, adjust, reconcile, clearForSession, localError };
});
