import { computed, ref, toRaw, watch } from 'vue';
import type { PlanningFrequencyResource } from '../types/planning-options';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { dependenciesChanged, sameValue } from '../services/planning-validation';
import { PLANNING_POLL_MS } from '../config/demo';
import type { PlanVersion } from '../types/domain';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import type {
  PlanningInput,
  PlanningIssue,
  PlanningJobView,
  PlanningLoaded,
  PlanningPreset,
  PlanningSubmit,
  PlanningSave,
  PlanningWorkspace,
} from '../types/planning';
import type { TaskWorkspace, TaskImportRequest, TaskImportPreview, TaskSaveResult } from '../types/task';
import type { ResourceChanges } from '../types/resource-edit';
import { emptyTasks, latestTask, taskSourceChanged } from '../services/task-validation';
import { resourceSignature } from '../services/resource-validation';
import { usePreviewStore } from './preview';
import { useAuthStore } from './auth';
import { createPlanningAdjustment, planningAdjustmentUnavailable, validatePlanningAdjustment } from '../services/planning-adjustment';
import type { PlanningAdjustment, PlanningAdjustmentExample } from '../types/planning-adjustment';
import { uncertainWrite } from './task-input';

const clone = <T>(value: T): T => structuredClone(toRaw(value));
export const usePlanningStore = defineStore('planning', () => {
  const preview = usePreviewStore(),auth=useAuthStore();
  const workspace = ref<PlanningWorkspace | null>(null);
  const tasks=ref<TaskWorkspace>(emptyTasks());
  const importRequest=ref<TaskImportRequest|null>(null),importPreview=ref<TaskImportPreview|null>(null),importing=ref(false),importOpen=ref(false);
  let importSerial=0,saveRequest:{signature:string;id:string}|null=null;
  let applyPending:(()=>boolean)|null=null;
  function registerPendingApply(fn:(()=>boolean)|null){applyPending=fn;}
  const savedTask=computed(()=>taskId.value?latestTask(tasks.value,taskId.value):undefined);
  const needsTaskSave=computed(()=>!savedTask.value||!sameValue(draft.value,savedTask.value.input));

  const presets = ref<PlanningPreset[]>([]);
  const frequencyResources = ref<PlanningFrequencyResource[] | null>(null);
  const draft = ref<PlanningInput | null>(null);
  const baseline = ref<PlanningInput | null>(null);
  const formDirty = ref(false),auxiliaryDirty=ref(false);
  const taskId = ref<string | null>(null),baselineTaskId=ref<string|null>(null);
  const parentPlanId = ref<string | null>(null);
  // 具体方案调整独立于任务条件，保存任务不会吸收这些设备和路径输入。
  const adjustmentParent = ref<PlanVersion | null>(null), adjustmentDraft = ref<PlanningAdjustment | null>(null);
  const adjustmentOpen = ref(false), adjustmentExamples = ref<PlanningAdjustmentExample[]>([]), adjustmentBaseline = ref('');
  const adjustmentPending=ref<PlanningSubmit|null>(null);
  let adjustmentSerial = 0;
  const adjustmentDirty = computed(() => !!adjustmentDraft.value && JSON.stringify(adjustmentDraft.value) !== adjustmentBaseline.value);
  const jobId = ref('');
  const view = ref<PlanningJobView | null>(null);
  const selectedSolutionId = ref(''), savePending = ref<PlanningSave | null>(null);
  // 作业原始回包保留默认结果，页面选择只改变当前展示投影。
  const currentSolution = computed(() => view.value?.solutions?.find(row => row.solutionId === selectedSolutionId.value) ?? null);
  const currentResult = computed(() => view.value?.solutions ? currentSolution.value?.result ?? null : view.value?.result ?? null);
  const currentOutcome = computed(() => view.value?.solutions ? currentSolution.value?.outcome ?? view.value.outcome : view.value?.outcome);
  const currentExpired = computed(() => currentSolution.value?.expired ?? view.value?.expired ?? false);
  watch(() => view.value, (next, previous) => {
    if (!next?.solutions) selectedSolutionId.value = '';
    else if (previous?.job.id !== next.job.id || !next.solutions.some(row => row.solutionId === selectedSolutionId.value))
      selectedSolutionId.value = next.defaultSolutionId ?? '';
  }, { flush: 'sync' });
  function selectSolution(id: string) {
    if (!auth.can('planning.view') || busy.value || savePending.value || adjustmentPending.value || adjustmentDirty.value || !view.value?.solutions?.some(row => row.solutionId === id)) return false;
    selectedSolutionId.value = id; selectedPlanId.value = ''; step.value = 2; return true;
  }
  const selectedPlanId = ref('');
  const step = ref(1);
  const loading = ref(false);
  const busy = ref(false);
  const loadError = ref('');
  const queryError = ref('');
  const error = ref('');
  const issues = ref<PlanningIssue[]>([]);
  const notice = ref('');
  const comparison = ref<PlanVersion[]>([]);
  const comparisonError = ref('');
  const decision = ref<DecisionRequest | null>(null);
  let resolveDecision: ((value: Decision) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pollingActive = false;
  let generation = 0;
  let queryPending = false,querySerial=0,loadSerial=0;
  let submission: { signature: string; requestId: string } | null = null;
  const dirty = computed(() => !!savePending.value || adjustmentDirty.value || taskId.value!==baselineTaskId.value || !!importRequest.value || formDirty.value || auxiliaryDirty.value || !sameValue(draft.value, baseline.value));
  const running = computed(() => !!view.value && ['PENDING', 'RUNNING'].includes(view.value.state));
  const locked = computed(() => busy.value || importing.value || loading.value || running.value || !!adjustmentPending.value || !!savePending.value || !!loadError.value);
  const selectedPlan = computed(
    () => preview.data?.planning.plans.find((p) => p.id === selectedPlanId.value) ?? null,
  );
  const sourceChanged = computed(
    () =>
      !!view.value &&
      !!preview.data &&
      (dependenciesChanged(view.value.job.dependencies, preview.data.resourceMeta)||taskSourceChanged(view.value.job.taskId,view.value.job.input,preview.data.resourceMeta,view.value.job.dependencies.task?.conditionVersion)),
  );
  const savedCurrent = computed(() => workspace.value?.plans.find((p) => p.jobId === jobId.value && (p.solutionId ?? '') === selectedSolutionId.value));
  const adjustmentResult = computed(() => adjustmentParent.value && view.value?.state === 'SUCCESS' &&
    sameValue(view.value.job.adjustment, adjustmentDraft.value) ? view.value.result : null);
  const adjustmentStatus = computed(() => adjustmentPending.value ? '调整提交结果待核实，请查询原请求回执。' : adjustmentDirty.value ? '调整输入尚未提交，下方保留父方案。' :
    running.value ? '调整正在处理，下方保留父方案。' : adjustmentResult.value ? '调整完成，预览读取新结果；保存后形成新版本。' :
    view.value?.job.adjustment ? '调整未成功完成，输入及父方案保留，可修改后重试。' : '尚未提交调整，下方显示父方案。');

  function setWorkspace(next: PlanningWorkspace) {
    workspace.value = next;
    preview.mergePlanning(next.plans);
  }
  function report(reason: unknown) {
    error.value = reason instanceof Error ? reason.message : '规划操作失败';
    issues.value = reason instanceof ApiError && Array.isArray(reason.data) ? reason.data : [];
  }
  function ask(request: DecisionRequest): Promise<Decision> {
    if (resolveDecision) return Promise.resolve('cancel');
    decision.value = request;
    return new Promise((resolve) => {
      resolveDecision = resolve;
    });
  }
  function answer(value: Decision) {
    const resolve = resolveDecision;
    decision.value = null;
    resolveDecision = undefined;
    resolve?.(value);
  }
  async function allowDiscard(deferDiscard=false) {
    if (savePending.value) { error.value = '请先核实原方案保存请求'; return false; }
    if(busy.value||importing.value||adjustmentPending.value||adjustmentParent.value&&running.value){error.value=adjustmentPending.value?'请先核实原调整请求':'正在处理，请稍候';return false;}
    if(!dirty.value)return true;
    const cannotSave=!!importRequest.value||auxiliaryDirty.value||adjustmentDirty.value;
    const choice=await ask({title:'未保存的任务输入',message:cannotSave?'未确认导入或方案抽屉输入不能随离开自动保存。':'保存任务后继续，或放弃本次未保存输入？已有方案和输入快照保留。',
      saveLabel:cannotSave?undefined:'保存任务后继续',discardLabel:'放弃未保存输入',cancelLabel:'继续编辑'});
    if(choice==='cancel'||choice==='save'&&!(await saveTask()))return false;
    if(!deferDiscard&&choice==='discard')discardTaskDraft();
    return true;
  }
  function clearAdjustment(){adjustmentSerial++;adjustmentPending.value=null;adjustmentParent.value=null;adjustmentDraft.value=null;adjustmentOpen.value=false;adjustmentBaseline.value='';}
  function discardTaskDraft(){clearAdjustment();taskId.value=baselineTaskId.value;draft.value=baseline.value?clone(baseline.value):null;formDirty.value=false;auxiliaryDirty.value=false;importRequest.value=null;importPreview.value=null;importOpen.value=false;importSerial++;}
  function acceptTaskSave(result:TaskSaveResult){
    tasks.value=clone(result.tasks);preview.acceptResources(result);
    if(result.task){taskId.value=result.task.id;baselineTaskId.value=result.task.id;draft.value=clone(result.task.versions.at(-1)!.input);baseline.value=clone(draft.value);}
    formDirty.value=false;error.value='';issues.value=[];saveRequest=null;
  }
  function prepareTask(){
    if(formDirty.value&&(!applyPending||!applyPending()))throw new Error('请先应用当前通联表单');
    if(importRequest.value)throw new Error('请先明确确认或取消任务导入');
    if(!draft.value)throw new Error('任务输入尚未加载');
    taskId.value??=crypto.randomUUID();
    return {taskId:taskId.value,input:clone(draft.value)};
  }
  async function saveTask(){
    if(!auth.can('planning.execute')||locked.value)return false;
    const session=auth.generation;
    try{
      const task=prepareTask();
      if(!preview.data)await preview.load();
      if(session!==auth.generation)return false;
      if(!preview.data)throw new Error('资源未加载，任务未保存');
      const content={...task,baseTaskRevision:tasks.value.revision,baseResourceRevision:preview.data.resourceMeta.revision};
      const signature=resourceSignature(content);
      if(saveRequest?.signature!==signature)saveRequest={signature,id:crypto.randomUUID()};
      busy.value=true;
      const result=await previewService.saveTask({...content,requestId:saveRequest.id,context:'planning'});
      if(session!==auth.generation)return false;
      acceptTaskSave(result);notice.value=result.changed?'任务已保存到当前浏览器，尚未运行规划':'任务没有变化';return true;
    }catch(e){if(session===auth.generation)report(e);return false;}finally{if(session===auth.generation)busy.value=false;}
  }
  async function openTask(id:string){
    if(locked.value||!(await allowDiscard()))return false;
    const saved=latestTask(tasks.value,id);if(!saved){error.value='任务不存在';return false;}
    clearAdjustment();generation++;clearTimer();taskId.value=id;baselineTaskId.value=id;draft.value=clone(saved.input);baseline.value=clone(draft.value);
    jobId.value='';view.value=null;selectedPlanId.value='';parentPlanId.value=null;step.value=1;error.value='';return true;
  }
  async function previewTaskFiles(files:TaskImportRequest['files'],context:'gis'|'planning',draftChanges?:ResourceChanges){
    if(!auth.can('planning.execute')||locked.value||!draft.value||!preview.data)return;
    const serial=++importSerial,session=auth.generation;
    const request:TaskImportRequest={files,context,input:clone(draft.value),baseResourceRevision:preview.data.resourceMeta.revision,baseTaskRevision:tasks.value.revision,...(draftChanges?{draftChanges:clone(draftChanges)}:{})};
    importRequest.value=request;importPreview.value=null;importing.value=true;if(context==='gis')preview.busy=true;error.value='';
    try{const result=await previewService.previewTaskImport(request);if(serial===importSerial&&session===auth.generation)importPreview.value=result;}
    catch(e){if(serial===importSerial&&session===auth.generation)report(e);}
    finally{if(serial===importSerial){importing.value=false;if(context==='gis')preview.busy=false;}}
  }
  async function confirmTaskImport(draftChanges?:ResourceChanges){
    if(!auth.can('planning.execute')||importing.value||!importRequest.value||!importPreview.value?.input||!preview.data)return false;
    const request=clone(importRequest.value),serial=importSerial,session=auth.generation;
    if(request.baseResourceRevision!==preview.data.resourceMeta.revision||request.baseTaskRevision!==tasks.value.revision||!sameValue(request.input,draft.value)||!sameValue(request.draftChanges,draftChanges)){error.value='资源、任务或草稿已变化，请重新预检';return false;}
    importing.value=true;if(request.context==='gis')preview.busy=true;
    try{
      const fresh=await previewService.previewTaskImport(request);
      if(serial!==importSerial||session!==auth.generation)return false;
      if(!fresh.input||fresh.issues.length||fresh.signature!==importPreview.value?.signature||!sameValue(request.input,draft.value))throw new Error('预检已失效，请重新预检');
      taskId.value=fresh.taskId;draft.value=clone(fresh.input);
      const savedTarget=latestTask(tasks.value,fresh.taskId);
      if(savedTarget){baseline.value=clone(savedTarget.input);baselineTaskId.value=fresh.taskId;}
      jobId.value='';view.value=null;parentPlanId.value=null;selectedPlanId.value='';step.value=1;
      importRequest.value=null;importPreview.value=null;importOpen.value=false;notice.value='任务导入已应用到草稿，请保存后再运行规划';return true;
    }catch(e){if(session===auth.generation)report(e);return false;}finally{if(serial===importSerial){importing.value=false;if(request.context==='gis')preview.busy=false;}}
  }
  async function closeTaskImport(){
    if(importing.value)return false;
    if(importRequest.value&&(await ask({title:'任务导入尚未确认',message:'取消只放弃本次预览，不改变当前草稿。',discardLabel:'放弃导入',cancelLabel:'继续查看'}))!=='discard')return false;
    importRequest.value=null;importPreview.value=null;importOpen.value=false;importSerial++;return true;
  }
  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function stopPolling() {
    pollingActive = false;
    generation += 1;
    clearTimer();
  }
  function schedule() {
    clearTimer();
    if (auth.can('planning.view') && pollingActive && running.value && !queryError.value && !busy.value)
      timer = setTimeout(() => {
        void query();
      }, PLANNING_POLL_MS);
  }
  async function query() {
    if (!auth.can('planning.view') || !jobId.value || queryPending || busy.value) return;
    queryPending = true;
    const token = generation,serial=++querySerial;
    const requestedJob = jobId.value;
    try {
      const next = await previewService.getPlanningJob(requestedJob);
      if (token === generation && requestedJob === jobId.value) {
        view.value = next;
        queryError.value = '';
      }
    } catch (reason) {
      if (token === generation && requestedJob === jobId.value) {
        if (reason instanceof ApiError && reason.code === 2001 && reason.data) {
          view.value = reason.data as PlanningJobView;
          queryError.value = '';
        } else
          queryError.value = `查询失败，状态未确认：${reason instanceof Error ? reason.message : '请重试'}`;
      }
    } finally {
      if(serial!==querySerial)return;
      queryPending = false;
      // 离页/切换后的迟到响应不落入当前视图，恢复时重新查询当前任务。
      if (token !== generation && pollingActive && jobId.value && !busy.value) void query();
      else schedule();
    }
  }
  async function startPolling() {
    if(!auth.can('planning.view'))return;
    pollingActive = true;
    generation += 1;
    await query();
  }
  function restore(loaded: PlanningLoaded) {
    frequencyResources.value = clone(loaded.frequencyResources ?? null);
    clearAdjustment();adjustmentExamples.value=clone(loaded.adjustmentExamples??[]);
    setWorkspace(loaded.workspace);
    presets.value = loaded.presets;
    const last = loaded.workspace.jobs.at(-1);
    if(last?.adjustment){
      const parent=loaded.workspace.plans.find(plan=>plan.id===last.adjustment!.sourcePlanId&&plan.snapshotId===last.adjustment!.sourceSnapshotId);
      if(parent){adjustmentParent.value=clone(parent);adjustmentDraft.value=clone(last.adjustment);adjustmentBaseline.value=JSON.stringify(last.adjustment);}
    }
    const saved=latestTask(tasks.value,last?.taskId??'')??tasks.value.tasks.at(-1)?.versions.at(-1);
    const savedId=saved?tasks.value.tasks.find(t=>t.versions.some(v=>v.id===saved.id))!.id:null;
    draft.value = clone(saved?.input??last?.input ?? loaded.presets[0].input);
    baseline.value = clone(draft.value);
    taskId.value = savedId??last?.taskId ?? null;baselineTaskId.value=taskId.value;
    parentPlanId.value = last?.parentPlanVersionId ?? null;
    jobId.value = last?.id ?? '';
    view.value = null;
    selectedPlanId.value = '';
    formDirty.value = false;
    step.value = last?.adjustment ? 3 : last ? 2 : 1;
  }
  async function load() {
    if (!auth.can('planning.view') || loading.value || busy.value || adjustmentPending.value || savePending.value) return;
    const session=auth.generation,serial=++loadSerial;
    loading.value = true;
    try {
      const [loaded,taskLibrary] = await Promise.all([previewService.loadPlanningWorkspace(),previewService.loadTaskWorkspace()]);
      if(session!==auth.generation)return;
      generation += 1;
      clearTimer();
      tasks.value=taskLibrary;
      restore(loaded);
      loadError.value = '';
      error.value = '';
      issues.value = [];
      queryError.value = '';
    } catch (reason) {
      if(session===auth.generation)loadError.value = reason instanceof Error ? reason.message : '规划加载失败';
    } finally {
      if(serial===loadSerial)loading.value = false;
    }
    if (session===auth.generation && !loadError.value && jobId.value) await query();
  }
  async function reload() {
    if (await allowDiscard()) await load();
  }
  function updateDraft(next: PlanningInput) {
    if (auth.can('planning.execute') && !locked.value) {
      draft.value = clone(next);
      error.value = '';
      issues.value = [];
    }
  }
  function applyPreset(id: string) {
    const preset = presets.value.find((p) => p.id === id);
    if (!auth.can('planning.execute') || !preset || locked.value || !draft.value) return;
    // 只更新方案输入草稿，绝不提交到资源台账。
    draft.value = {
      ...clone(preset.input),
      name: draft.value.name,
      description: draft.value.description,
    };
    error.value = '';
    issues.value = [];
  }
  async function newTask() {
    if (!auth.can('planning.execute') || running.value || !presets.value.length || !(await allowDiscard())) return;
    clearAdjustment();
    generation += 1;
    clearTimer();
    draft.value = clone(presets.value[0].input);
    baseline.value = clone(draft.value);
    taskId.value = crypto.randomUUID();baselineTaskId.value=null;
    parentPlanId.value = null;
    jobId.value = '';
    view.value = null;
    selectedPlanId.value = '';
    step.value = 1;
    error.value = '';
    queryError.value = '';
  }
  async function switchJob(id: string) {
    if (running.value || !(await allowDiscard())) return;
    const job = workspace.value?.jobs.find((j) => j.id === id);
    if (!job) return;
    clearAdjustment();
    generation += 1;
    clearTimer();
    jobId.value = id;
    view.value = null;
    selectedPlanId.value = '';
    draft.value = clone(job.input);
    baseline.value = clone(draft.value);
    taskId.value = job.taskId;baselineTaskId.value=job.taskId;
    parentPlanId.value = job.parentPlanVersionId;
    step.value = 2;
    queryError.value = '';
    await query();
  }
  async function selectPlan(id: string) {
    if (!(await allowDiscard())) return false;
    clearAdjustment();
    selectedPlanId.value = id;
    step.value = 2;
    return true;
  }
  async function adjustPlan(plan: PlanVersion) {
    if (!auth.can('planning.execute') || !plan.workflow || locked.value || !(await allowDiscard())) return false;
    clearAdjustment();draft.value = clone(plan.workflow.input);
    baseline.value = clone(draft.value);
    taskId.value = plan.taskId;baselineTaskId.value=plan.taskId;
    parentPlanId.value = plan.id;
    selectedPlanId.value = '';
    jobId.value = '';
    view.value = null;
    step.value = 1;
    return true;
  }
  function adjustmentUnavailable(plan: PlanVersion | null) {
    return plan ? planningAdjustmentUnavailable(plan) : '请先选择已保存且来源有效的完整方案。';
  }
  async function openPlanAdjustment(plan: PlanVersion) {
    if(!auth.can('planning.execute')||locked.value)return false;
    const reason=adjustmentUnavailable(plan);if(reason){error.value=reason;return false;}
    const session=auth.generation;
    if(!(await allowDiscard())||session!==auth.generation||!auth.can('planning.execute'))return false;
    clearAdjustment();adjustmentParent.value=clone(plan);adjustmentDraft.value=createPlanningAdjustment(plan);
    adjustmentBaseline.value=JSON.stringify(adjustmentDraft.value);adjustmentOpen.value=true;error.value='';issues.value=[];step.value=3;
    return true;
  }
  function updateAdjustment(value: PlanningAdjustment) {
    if(!auth.can('planning.execute')||locked.value||!adjustmentParent.value)return;
    adjustmentDraft.value=clone(value);error.value='';issues.value=[];
  }
  async function closeAdjustment() {
    if(busy.value||adjustmentPending.value){error.value='请先等待提交完成或核实原请求';return false;}
    if(running.value){adjustmentOpen.value=false;return true;}
    const serial=adjustmentSerial,session=auth.generation;
    if(adjustmentDirty.value){
      if(await ask({title:'未提交的方案调整',message:'关闭将放弃本次设备参数与路径输入，原任务和父方案保持不变。',discardLabel:'放弃调整',cancelLabel:'继续编辑'})!=='discard')return false;
      if(serial!==adjustmentSerial||session!==auth.generation)return false;
      clearAdjustment();
    }else adjustmentOpen.value=false;
    return true;
  }
  async function submitAdjustment() {
    const parent=adjustmentParent.value,adjustment=adjustmentDraft.value;
    if(!auth.can('planning.execute')||locked.value||!workspace.value||!parent?.workflow||!adjustment)return false;
    const reason=adjustmentUnavailable(parent);if(reason){error.value=reason;return false;}
    issues.value=validatePlanningAdjustment(adjustment,parent);if(issues.value.length){error.value='请检查调整输入';return false;}
    const request=clone(adjustment),serial=adjustmentSerial,session=auth.generation;
    const signature=JSON.stringify({adjustment:request,input:parent.workflow.input,taskId:parent.taskId});
    if(submission?.signature!==signature)submission={signature,requestId:crypto.randomUUID()};
    const submitted:PlanningSubmit={baseRevision:workspace.value.revision,requestId:submission.requestId,taskId:parent.taskId,parentPlanVersionId:parent.id,input:clone(parent.workflow.input),adjustment:request};
    busy.value=true;error.value='';notice.value='';generation++;clearTimer();
    try{
      const result=await previewService.submitPlanning(submitted);
      if(serial!==adjustmentSerial)return false;
      if(session!==auth.generation||!auth.can('planning.execute')){adjustmentPending.value=submitted;error.value='写入期间会话状态变化，请恢复权限后核实原请求';return false;}
      setWorkspace(result.workspace);view.value=result.view;jobId.value=result.view.job.id;selectedPlanId.value='';
      adjustmentBaseline.value=JSON.stringify(request);adjustmentOpen.value=false;queryError.value='';submission=null;step.value=3;
      return true;
    }catch(reason){if(serial===adjustmentSerial){if(uncertainWrite(reason))adjustmentPending.value=submitted;if(session===auth.generation){report(reason);if(adjustmentPending.value)error.value+='。请先核实原请求，勿重复提交';}}return false;}
    finally{if(serial===adjustmentSerial){busy.value=false;schedule();}}
  }
  async function reconcileAdjustment(){
    const pending=adjustmentPending.value;if(!pending||busy.value||!auth.can('planning.view'))return;
    const serial=adjustmentSerial,session=auth.generation;busy.value=true;
    try{
      // Mock 回执位于持久化作业的 requestId，先读取再决定是否允许重试。
      const loaded=await previewService.loadPlanningWorkspace();
      if(serial!==adjustmentSerial||session!==auth.generation)return;
      const job=loaded.workspace.jobs.find(row=>row.requestId===pending.requestId);
      if(job){
        if(!sameValue(job.adjustment,pending.adjustment)||job.taskId!==pending.taskId)throw new Error('原请求回执与调整输入不一致');
        const next=await previewService.getPlanningJob(job.id);if(serial!==adjustmentSerial||session!==auth.generation)return;
        setWorkspace(loaded.workspace);view.value=next;jobId.value=job.id;selectedPlanId.value='';adjustmentBaseline.value=JSON.stringify(job.adjustment);step.value=3;
        notice.value='已核实原调整请求成功';
      }else notice.value='已核实原请求未产生作业，可保留输入重新提交';
      adjustmentPending.value=null;error.value='';issues.value=[];
    }catch(reason){if(serial===adjustmentSerial&&session===auth.generation)report(reason);}
    finally{if(serial===adjustmentSerial){busy.value=false;schedule();}}
  }
  async function submit() {
    if (!auth.can('planning.execute') || locked.value || !draft.value || !workspace.value) return false;
    if(adjustmentOpen.value||adjustmentDirty.value){error.value='请先完成或关闭独立方案调整';return false;}
    if(needsTaskSave.value||formDirty.value||importRequest.value){error.value='请先保存当前任务，再开始规划';return false;}
    busy.value = true;
    error.value = '';
    issues.value = [];
    notice.value = '';
    generation += 1;
    clearTimer();
    const input = clone(draft.value);
    input.name = input.name.trim();
    const signature = JSON.stringify({ input, taskId: taskId.value, parent: parentPlanId.value });
    if (submission?.signature !== signature)
      submission = { signature, requestId: crypto.randomUUID() };
    try {
      const result = await previewService.submitPlanning({
        baseRevision: workspace.value.revision,
        requestId: submission.requestId,
        taskId: taskId.value,
        parentPlanVersionId: parentPlanId.value,
        input,
      });
      setWorkspace(result.workspace);
      view.value = result.view;
      jobId.value = result.view.job.id;
      taskId.value = result.view.job.taskId;
      draft.value = clone(result.view.job.input);
      baseline.value = clone(draft.value);
      formDirty.value = false;
      selectedPlanId.value = '';
      step.value = 2;
      queryError.value = '';
      submission = null;
      return true;
    } catch (reason) {
      report(reason);
      return false;
    } finally {
      busy.value = false;
      schedule();
    }
  }
  async function cancelJob() {
    if (!auth.can('planning.execute') || busy.value || !running.value || !workspace.value) return;
    if (
      (await ask({
        title: '取消规划任务',
        message: '确认取消当前 Mock 任务？输入记录保留，取消后不会生成方案结果。',
        saveLabel: '确认取消任务',
        cancelLabel: '继续等待',
      })) !== 'save'
    )
      return;
    busy.value = true;
    generation += 1;
    clearTimer();
    try {
      const result = await previewService.cancelPlanningJob({
        baseRevision: workspace.value.revision,
        jobId: jobId.value,
      });
      setWorkspace(result.workspace);
      view.value = result.view;
      queryError.value = '';
      error.value = '';
      notice.value = '任务已取消，输入可重新提交';
    } catch (reason) {
      report(reason);
    } finally {
      busy.value = false;
      schedule();
    }
  }
  async function save(name: string, note: string) {
    if (!auth.can('planning.save') || busy.value || savePending.value || adjustmentDirty.value || adjustmentPending.value || !workspace.value || !jobId.value || !!loadError.value || !currentResult.value || currentExpired.value || savedCurrent.value) return false;
    const owner = { serial:adjustmentSerial, session:auth.generation, jobId:jobId.value, solutionId:selectedSolutionId.value };
    const current=()=>owner.serial===adjustmentSerial&&owner.session===auth.generation&&owner.jobId===jobId.value&&owner.solutionId===selectedSolutionId.value&&auth.can('planning.save');
    const request:PlanningSave = { baseRevision:workspace.value.revision, jobId:owner.jobId, requestId:crypto.randomUUID(), name, note,
      ...(currentSolution.value ? { solutionId:owner.solutionId, snapshotId:currentResult.value.snapshotId } : {}) };
    busy.value = true;
    try {
      const result = await previewService.savePlanVersion(request);
      // 保存身份在点击时冻结；不确定回执不能切到另一份结果后继续写入。
      if(!current()){if(owner.serial===adjustmentSerial)savePending.value=request;return false;}
      setWorkspace(result.workspace);
      selectedPlanId.value = result.plan.id;
      error.value = '';
      notice.value = '方案版本已保存到当前浏览器';
      return true;
    } catch (reason) {
      if(owner.serial===adjustmentSerial&&uncertainWrite(reason))savePending.value=request;
      if(current())report(reason);
      return false;
    } finally {
      if(owner.serial===adjustmentSerial)busy.value = false;
    }
  }
  async function reconcileSave() {
    const request=savePending.value;if(!request||busy.value||!auth.can('planning.view'))return;
    const session=auth.generation;busy.value=true;
    try {
      const loaded=await previewService.loadPlanningWorkspace();if(session!==auth.generation||savePending.value?.requestId!==request.requestId)return;
      const plan=loaded.workspace.plans.find(row=>row.workflow?.saveRequestId===request.requestId);
      if(plan&&(plan.jobId!==request.jobId||(plan.solutionId??null)!==(request.solutionId??null)||request.snapshotId&&plan.snapshotId!==request.snapshotId||plan.name!==request.name.trim()||plan.workflow?.note!==request.note))throw new Error('原保存回执与所选结果不一致');
      setWorkspace(loaded.workspace);if(plan)selectedPlanId.value=plan.id;
      savePending.value=null;error.value='';notice.value=plan?'已核实原方案保存成功':'已核实原请求未保存，可保留输入重试';
    }catch(reason){if(session===auth.generation)report(reason);}finally{if(session===auth.generation)busy.value=false;}
  }
  async function confirm(plan: PlanVersion) {
    if (!auth.can('planning.confirm') || busy.value || savePending.value || !workspace.value || !!loadError.value) return;
    const adjustmentOwner=(plan.workflow?.adjustment||plan.solutionId)?{serial:adjustmentSerial,session:auth.generation,selected:selectedPlanId.value}:null;
    const current=()=>!adjustmentOwner||adjustmentOwner.serial===adjustmentSerial&&adjustmentOwner.session===auth.generation&&adjustmentOwner.selected===selectedPlanId.value&&auth.can('planning.confirm');
    const previous = workspace.value.currentConfirmedByTask[plan.taskId];
    if (
      (await ask({
        title: '确认方案配置',
        message: `${previous ? '将替换该任务的当前确认版本，旧确认记录仍保留。绑定旧版的诊断继续按冻结快照完成并标记为历史。' : ''}确认后保存部署、设备参数、路由和频率配置快照；不下发设备，也不改写台账或 GIS。`,
        saveLabel: '确认配置',
      })) !== 'save'
    )
      return;
    if(!current())return;
    busy.value = true;
    try {
      const result = await previewService.confirmPlanVersion({
        baseRevision: workspace.value.revision,
        planId: plan.id,
        requestId: `confirm:${plan.id}`,
      });
      if(!current())return;
      setWorkspace(result.workspace);
      error.value = '';
      notice.value = '配置已确认，可查看确认快照';
    } catch (reason) {
      if(current())report(reason);
    } finally {
      if(!adjustmentOwner||adjustmentOwner.serial===adjustmentSerial)busy.value = false;
    }
  }
  async function compare(ids: string[]) {
    comparisonError.value = '';
    const session=auth.generation;
    try {
      const value=await previewService.comparePlanVersions(ids);if(session===auth.generation)comparison.value=value;
    } catch (reason) {
      if(session===auth.generation){comparison.value = [];
      comparisonError.value = reason instanceof Error ? reason.message : '对比失败';}
    }
  }
  async function reset() {
    if (!auth.can('planning.reset') || busy.value || loading.value || adjustmentPending.value || savePending.value) return;
    if (
      (await ask({
        title: '重置规划演示数据',
        message:
          '清空规划运行记录、新保存方案、确认记录、干扰分析及措施采纳回执，恢复内置只读方案；独立保存的任务库保留，未保存输入将放弃。资源修改及诊断冻结记录保留；诊断继续完成并标记为历史，不再使用这些版本发起新诊断。此操作不可恢复。',
        saveLabel: '重置规划数据',
      })) !== 'save'
    )
      return;
    busy.value = true;
    generation += 1;
    clearTimer();
    try {
      const loaded = await previewService.resetPlanningWorkspace(workspace.value?.revision ?? null);
      restore(loaded);
      loadError.value = '';
      queryError.value = '';
      error.value = '';
      issues.value = [];
      comparison.value = [];
      comparisonError.value = '';
      notice.value = '规划演示数据已重置';
    } catch (reason) {
      report(reason);
    } finally {
      busy.value = false;
      schedule();
    }
  }
  // 切换账号不取消持久化任务，只释放轮询、缓存与当前输入。
  function clearForSession(){savePending.value=null;frequencyResources.value=null;selectedSolutionId.value='';clearAdjustment();adjustmentExamples.value=[];busy.value=false;tasks.value=emptyTasks();importSerial++;importRequest.value=null;importPreview.value=null;importing.value=false;importOpen.value=false;saveRequest=null;applyPending=null;loadSerial++;querySerial++;queryPending=false;auxiliaryDirty.value=false;stopPolling();answer('cancel');workspace.value=null;presets.value=[];draft.value=null;baseline.value=null;formDirty.value=false;taskId.value=null;baselineTaskId.value=null;parentPlanId.value=null;jobId.value='';view.value=null;selectedPlanId.value='';step.value=1;loading.value=false;loadError.value='';queryError.value='';error.value='';issues.value=[];notice.value='';comparison.value=[];comparisonError.value='';submission=null;}
  return {
    frequencyResources,selectedSolutionId,currentSolution,currentResult,currentOutcome,currentExpired,selectSolution,savePending,reconcileSave,
    adjustmentParent,adjustmentDraft,adjustmentOpen,adjustmentExamples,adjustmentDirty,adjustmentResult,adjustmentStatus,adjustmentPending,
    adjustmentUnavailable,openPlanAdjustment,updateAdjustment,closeAdjustment,submitAdjustment,reconcileAdjustment,
    baselineTaskId,tasks,savedTask,needsTaskSave,importRequest,importPreview,importing,importOpen,prepareTask,acceptTaskSave,saveTask,openTask,previewTaskFiles,confirmTaskImport,closeTaskImport,discardTaskDraft,registerPendingApply,
    clearForSession,
    // 外部采纳只同步方案集合，不覆盖正在编辑的任务。
    acceptWorkspace: setWorkspace,
    workspace,
    presets,
    draft,
    baseline,
    formDirty,
    auxiliaryDirty,
    taskId,
    parentPlanId,
    jobId,
    view,
    selectedPlanId,
    selectedPlan,
    step,
    loading,
    busy,
    loadError,
    queryError,
    error,
    issues,
    notice,
    comparison,
    comparisonError,
    decision,
    dirty,
    running,
    locked,
    sourceChanged,
    savedCurrent,
    load,
    reload,
    updateDraft,
    applyPreset,
    newTask,
    switchJob,
    selectPlan,
    adjustPlan,
    submit,
    query,
    startPolling,
    stopPolling,
    cancelJob,
    save,
    confirm,
    compare,
    reset,
    ask,
    answer,
    allowDiscard,
  };
});
