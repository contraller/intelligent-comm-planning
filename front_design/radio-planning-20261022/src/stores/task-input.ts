// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
import { computed, ref, toRaw, watch } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { taskInputIssues } from '../services/task-api-validation';
import type { ApiPage, ApiTask, ApiTaskSummary, ApiTaskImportPreview, TaskApiOptions, TaskApiSave } from '../types/task-api';
import type { ApiPlan, PlanningOptions } from '../types/planning-api';
import type { PlanningAdjustmentExample } from '../types/planning-adjustment';
import type { PlanningInput, PlanningIssue } from '../types/planning';
import type { ReadDevice, ReadNode } from '../types/resource-read';
import type { TaskFileInput } from '../types/task';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import { useAuthStore } from './auth';
import { useResourceReadStore } from './resource-read';

const copy = <T>(value: T): T => structuredClone(toRaw(value));
// 不确定写入必须保留原请求标识；请求成功与随后刷新失败分别处理。
export const uncertainWrite = (e: unknown) => !(e instanceof ApiError) || ['NETWORK_ERROR','REQUEST_TIMEOUT','REQUEST_ABORTED','INVALID_RESPONSE','INVALID_ENVELOPE','INVALID_PLANNING_RESPONSE','SESSION_CHANGED'].includes(String(e.code)) || (e.status ?? 0) >= 500;
export const useTaskInputStore = defineStore('task-input', () => {
  const auth = useAuthStore(), resources = useResourceReadStore();
  const context = ref<TaskApiOptions['context']>('planning'), catalog = ref<PlanningOptions | null>(null), draft = ref<PlanningInput | null>(null), saved = ref<ApiTask | null>(null);
  const initialInput=ref<PlanningInput|null>(null),adjustmentExamples=ref<PlanningAdjustmentExample[]>([]);
  const taskId = ref(''), resourceRevision = ref(''), baseline = ref(''), error = ref(''), notice = ref(''), busy = ref(false), loading = ref(false), running = ref(false);
  const library = ref<ApiPage<ApiTaskSummary> | null>(null), libraryQuery = ref({ pageNum: 1, pageSize: 10, search: '' });
  const nodes = ref<ReadNode[]>([]), losNodes = ref<ReadNode[]>([]), devices = ref<ReadDevice[]>([]), issues = ref<PlanningIssue[]>([]);
  const importPreview = ref<ApiTaskImportPreview | null>(null), importFiles = ref<TaskFileInput[]>([]), importVisible = ref(false), importBusy = ref(false), importBaseline = ref('');
  const pendingSave = ref<TaskApiSave | null>(null), auxiliary = ref<Record<string, boolean>>({}), decision = ref<DecisionRequest | null>(null);
  const validationInput = ref<PlanningInput | null>(null), validationTaskId = ref(''), validationExtras = ref<PlanningIssue[]>([]);
  watch(taskId, () => { validationInput.value=null;validationExtras.value=[]; }, {flush:'sync'});
  // 校验规则仍由原函数负责；修改后重读本地问题，服务问题只在对应输入变化后撤下。
  const issueValue = (input: PlanningInput, issue: PlanningIssue) => {
    const demand = input.demands.find(row => row.id === issue.objectId);
    const value = issue.field.split('.').reduce<unknown>((row, key) => row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined, demand ?? input);
    return JSON.stringify(value, (_key, item) => typeof item === 'number' && !Number.isFinite(item) ? String(item) : item);
  };
  const displayIssues = computed(() => {
    if (context.value !== 'planning' || !draft.value || !validationInput.value || validationTaskId.value !== taskId.value) return issues.value;
    const local = taskInputIssues(draft.value);
    const extra = validationExtras.value.filter(issue => issueValue(draft.value!, issue) === issueValue(validationInput.value!, issue));
    const pending = Object.entries(auxiliary.value).filter(([, value]) => value).map(([key]) => ({objectId:'',field:'auxiliary.'+key,message:key==='demand'?'需求尚未应用，请先完成或放弃需求编辑':'输入待完善，请检查对应条件'}));
    return [...local, ...extra, ...pending];
  });
  watch([() => draft.value, () => auxiliary.value], () => {
    if (context.value === 'planning' && validationInput.value && !Object.values(auxiliary.value).some(Boolean) && error.value === '请先完成或放弃当前抽屉输入，再保存任务') error.value = '';
  }, {deep:true});
  let resolveDecision: ((value: Decision) => void) | undefined, generation = 0, lifetime = 0;
  const controllers = new Map<string, AbortController>();
  const readable = computed(() => auth.can('planning.view') && (context.value !== 'gis' || auth.can('situation.view')));
  const editable = computed(() => readable.value && auth.can('planning.execute') && !busy.value && !running.value && !pendingSave.value);
  const changed = computed(() => !!draft.value && (JSON.stringify(draft.value) !== baseline.value || !!saved.value && resourceRevision.value !== saved.value.resourceRevision));
  const dirty = computed(() => changed.value || !!importFiles.value.length || Object.values(auxiliary.value).some(Boolean));
  const options = (signal?: AbortSignal): TaskApiOptions => ({ context: context.value, signal });
  function stop() { generation++; controllers.forEach(c => c.abort()); controllers.clear(); loading.value = false; importBusy.value = false; answer('cancel'); }
  async function read<T>(key: string, action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (!readable.value) return;
    controllers.get(key)?.abort(); const controller = new AbortController(), token = generation, session = auth.generation; controllers.set(key, controller);
    try { const value = await action(controller.signal); if (generation === token && session === auth.generation && controllers.get(key) === controller && !controller.signal.aborted && readable.value) return value; }
    catch (e) { if (token === generation && session === auth.generation && !controller.signal.aborted) error.value = e instanceof Error ? e.message : '任务读取失败'; }
    finally { if (controllers.get(key) === controller) controllers.delete(key); }
  }
  function ask(value: DecisionRequest): Promise<Decision> { answer('cancel'); decision.value = value; return new Promise(resolve => { resolveDecision = resolve; }); }
  function answer(value: Decision) { decision.value = null; const resolve = resolveDecision; resolveDecision = undefined; resolve?.(value); }
  function clearImport() { controllers.get('import')?.abort(); importFiles.value = []; importPreview.value = null; importVisible.value = false; }
  async function initialize(value: TaskApiOptions['context']) {
    context.value = value; loading.value = true; error.value = '';
    const data = await read('catalog', signal => previewService.loadPlanningOptions(options(signal)));
    if (data) {
      catalog.value = data;
      if (!draft.value && data.presets[0]) {
        const preset=await read('preset',signal=>previewService.getPlanningPreset({...options(signal),presetId:data.presets[0].id}));
        if(preset){initialInput.value=copy(preset.defaults);draft.value=copy(preset.defaults);taskId.value=randomUuid();baseline.value=JSON.stringify(draft.value);resourceRevision.value=resources.workspace?.revision??'';if(context.value==='planning')notice.value=`已载入“${preset.label}”的默认任务，尚未保存。`;}
      }
      await refreshReferences(false);
    }
    loading.value = false;
  }
  async function refreshReferences(adoptCurrent = true) {
    if (!draft.value || !resources.workspace || !readable.value) return;
    const revision = adoptCurrent ? resources.workspace.revision : resourceRevision.value || resources.workspace.revision;
    const input = copy(draft.value), selectedTask = taskId.value;
    const workspaceRevision = resources.workspace.revision;
    const referenceKey = (value: PlanningInput | null) => JSON.stringify([value?.stationIds, value?.deploymentConstraints?.losRequiredNodeIds ?? [], value?.demands.map(d => [d.sourceDeviceId,d.targetDeviceId])]);
    // 通视引用独立读取，不增加任务参与节点或通联需求。
    const losIds = input.deploymentConstraints?.losRequiredNodeIds ?? [];
    const values = await read('references', async signal => {
      const selectedNodes: ReadNode[] = [], selectedDevices: ReadDevice[] = [];
      const items = [...new Set([...input.stationIds, ...losIds])].map(id => ({ id, kind: 'node' as const }));
      const references: { id: string; kind: 'node' | 'device' }[] = [...items, ...[...new Set(input.demands.flatMap(d => [d.sourceDeviceId, d.targetDeviceId]).filter((id): id is string => !!id))].map(id => ({ id, kind: 'device' as const }))];
      // 有界并发只加载选中引用，不扫描整个设备库。
      for (let i = 0; i < references.length; i += 8) {
        const batch = await Promise.all(references.slice(i, i + 8).map(x => previewService.getResourceObject({ ...x, context: context.value, revision, signal })));
        for (const row of batch) { if (row.object.kind === 'node') selectedNodes.push(row.object); if (row.object.kind === 'device') selectedDevices.push(row.object); }
      }
      return { selectedNodes, selectedDevices };
    });
    // 草稿在异步读取期间改变时，不把旧节点或设备写入新现场。
    if (values && taskId.value === selectedTask && resources.workspace?.revision === workspaceRevision && referenceKey(draft.value) === referenceKey(input)) {
      nodes.value = values.selectedNodes.filter(node => input.stationIds.includes(node.id));
      losNodes.value = values.selectedNodes.filter(node => losIds.includes(node.id));
      devices.value = values.selectedDevices; resourceRevision.value = revision;
    }
  }
  async function queryLibrary(page = libraryQuery.value.pageNum) {
    libraryQuery.value.pageNum = page;
    const value = await read('library', signal => previewService.queryTaskSummaries({ ...libraryQuery.value, ...options(signal) })); if (value) library.value = value;
  }
  function accept(task: ApiTask) { validationInput.value=null;validationExtras.value=[];saved.value = copy(task); taskId.value = task.taskId; resourceRevision.value = task.resourceRevision; draft.value = copy(task.input); baseline.value = JSON.stringify(draft.value); issues.value = []; clearImport(); auxiliary.value = {}; }
  async function open(id: string, protect = true) {
    if (busy.value || running.value || pendingSave.value) {error.value='当前操作尚未结束，请完成后再打开任务';return false;}
    if(protect && !(await allowLeave())) return false;
    error.value = ''; const value = await read('task', signal => previewService.getTaskInput({ ...options(signal), taskId: id }));
    if (!value) return false; accept(value); if(context.value==='planning')notice.value=`已打开任务“${value.input.name}”及服务端保存版本。`; await refreshReferences(false); return true;
  }
  async function newTask() {
    if (!editable.value || !catalog.value || !(await allowLeave())) return;
    const preset=await read('preset',signal=>previewService.getPlanningPreset({...options(signal),presetId:catalog.value!.presets[0].id}));
    if(!preset)return;
    initialInput.value=copy(preset.defaults);saved.value = null; taskId.value = randomUuid(); draft.value = copy(preset.defaults); baseline.value = ''; resourceRevision.value = resources.workspace?.revision ?? ''; issues.value = []; notice.value = context.value==='planning'?`已载入“${preset.label}”的默认任务，尚未保存。`:''; await refreshReferences();
  }
  // 整套预设明确替换草稿，普通参数预设仍只更新对应约束。
  async function loadPreset(id: string) {
    const preset = catalog.value?.presets.find(p => p.id === id);
    const owner = auth.generation;
    if (!preset || !editable.value || !(await allowLeave()) || owner !== auth.generation || !editable.value) return false;
    const detail=await read('preset',signal=>previewService.getPlanningPreset({...options(signal),presetId:id}));
    if(!detail||owner!==auth.generation)return false;
    validationInput.value=null;validationExtras.value=[];
    draft.value = copy(detail.defaults); issues.value = []; clearImport();
    if(context.value==='planning')notice.value=`已载入“${detail.label}”，替换节点、通联需求及条件；尚未保存。`;
    await refreshReferences();
    return owner === auth.generation && readable.value;
  }
  function resetDraft() {
    // 仅在工作区重置成功后调用；任务库记录独立保留。
    saved.value = null; taskId.value = randomUuid(); draft.value = initialInput.value ? copy(initialInput.value) : null;
    baseline.value = JSON.stringify(draft.value); resourceRevision.value = resources.workspace?.revision ?? '';
    issues.value = []; clearImport(); auxiliary.value = {}; nodes.value = []; losNodes.value = []; devices.value = [];
  }
  async function copyPlanInput(plan: ApiPlan) {
    if (!editable.value || !(await allowLeave())) return false;
    // 采纳历史可能尚无独立任务；只复制真实输入，不伪造已保存版本。
    const target = await read('plan-input', async signal => {
      try { return await previewService.getTaskInput({ ...options(signal), taskId: plan.taskId }); }
      catch (error) { if (error instanceof ApiError && (error.code === 'TASK_NOT_FOUND' || error.status === 404)) return null; throw error; }
    });
    if (target === undefined) return false;
    saved.value = target; taskId.value = plan.taskId; draft.value = copy(plan.input);
    baseline.value = target ? JSON.stringify(target.input) : ''; resourceRevision.value = resources.workspace?.revision ?? '';
    issues.value = []; clearImport(); auxiliary.value = {};
    await refreshReferences(); return readable.value;
  }
  async function openPlanTask(id: string) {
    if (busy.value || running.value || pendingSave.value || !(await allowLeave())) return false;
    const value = await read('plan-task', async signal => {
      try { return await previewService.getTaskInput({ ...options(signal), taskId: id }); }
      catch (error) { if (error instanceof ApiError && (error.code === 'TASK_NOT_FOUND' || error.status === 404)) return null; throw error; }
    });
    if (value === undefined) return false;
    if (value) { accept(value); await refreshReferences(false); }
    return readable.value;
  }
  function updateInput(input: PlanningInput) { if (!editable.value) return; draft.value = copy(input); issues.value = []; }
  async function applyPreset(id: string) {
    if(!catalog.value?.presets.some(p=>p.id===id)||!draft.value||!editable.value)return;
    const selectedTask=taskId.value,inputBefore=JSON.stringify(draft.value);
    const preset=await read('preset',signal=>previewService.getPlanningPreset({...options(signal),presetId:id}));
    if(!preset||!draft.value||!editable.value||taskId.value!==selectedTask||JSON.stringify(draft.value)!==inputBefore)return;
    const previousLos = JSON.stringify(draft.value.deploymentConstraints?.losRequiredNodeIds ?? []);
    // 更换默认参数不替换用户已经维护的任务节点与需求。
    draft.value = { ...copy(draft.value), presetId: id, frequencyId: preset.defaults.frequencyId, constraints: copy(preset.defaults.constraints) };
    // 明确采用新预设的部署条件；旧预设缺省时移除上一套条件。
    if (Object.hasOwn(preset.defaults, 'deploymentConstraints')) draft.value.deploymentConstraints = copy(preset.defaults.deploymentConstraints);
    else delete draft.value.deploymentConstraints;
    // 新预设缺省时清除上一套频率和求解条件，不把隐藏条件留在草稿。
    for (const key of ['frequencyConstraints', 'deploymentSolve'] as const) {
      if (Object.hasOwn(preset.defaults, key)) Object.assign(draft.value, { [key]:copy(preset.defaults[key]) });
      else delete draft.value[key];
    }
    if (previousLos !== JSON.stringify(draft.value.deploymentConstraints?.losRequiredNodeIds ?? [])) void refreshReferences(false);
    if(context.value==='planning')notice.value='已更新参数预设、频率及高级条件；节点和通联需求保留，尚未保存。';
  }
  async function loadAdjustmentExamples(){const value=await read('examples',signal=>previewService.getPlanningAdjustmentExamples(options(signal)));if(value)adjustmentExamples.value=value;}
  async function save(): Promise<boolean> {
    // 未应用的子表单仍拦截保存，同时允许页面说明具体阻塞位置。
    if (context.value === 'planning' && editable.value && draft.value && !importFiles.value.length) {
      validationInput.value=copy(draft.value);validationTaskId.value=taskId.value;validationExtras.value=[];
    }
    if (!editable.value || !draft.value || importFiles.value.length || Object.values(auxiliary.value).some(Boolean)) { error.value = '请先完成或放弃当前抽屉输入，再保存任务'; return false; }
    // 输入框清空表示未设置；保留所有非空原值交给既有校验，重试也沿用规范化请求。
    if(draft.value.startTime==='')draft.value.startTime=null;
    issues.value = taskInputIssues(draft.value); if (issues.value.length) return false;
    const request: TaskApiSave = { ...options(), taskId: taskId.value, revision: saved.value?.revision ?? null, resourceRevision: resourceRevision.value, requestId: randomUuid(), input: copy(draft.value) };
    busy.value = true; error.value = ''; const session = auth.generation, token = generation, owner = lifetime;
    try {
      const value = await previewService.saveTaskInputReceipt(request);
      if (session !== auth.generation || token !== generation) {
        // 失权只冻结现场，已发送的写入仍须核实；明确清理后不恢复旧请求。
        if (owner === lifetime) { pendingSave.value = request; error.value = '写入期间会话状态变化，请恢复权限后核实原请求。'; }
        return false;
      }
      // 回执认证本次输入版本；后续读取失败不改写已成功的保存结果。
      accept({...value,input:request.input,activeJobId:null}); notice.value = '任务输入已保存；规划需单独提交。';
      const detail=await read('task',signal=>previewService.getTaskInput({...options(signal),taskId:value.taskId}));
      if(detail&&detail.revision===value.revision)accept(detail);
      else if(session===auth.generation&&token===generation)notice.value+='详情刷新失败，可稍后重新打开。';
      return session===auth.generation&&token===generation;
    } catch (e) {
      if (owner === lifetime) { error.value = e instanceof Error ? e.message : '保存失败'; if (uncertainWrite(e)) { pendingSave.value = request; error.value += '。结果待核实，请查询原请求回执。'; } if (session === auth.generation && e instanceof ApiError && Array.isArray(e.data)) {issues.value = e.data;validationExtras.value=e.data;} }
      return false;
    } finally { if (owner === lifetime) busy.value = false; }
  }
  async function reconcileSave() {
    const pending = pendingSave.value; if (!pending || busy.value) return;
    const receipt = await read('receipt', signal => previewService.getPlanningOperation({ ...options(signal), requestId: pending.requestId, taskId: pending.taskId, kind: 'saveTask' }));
    if (!receipt) return;
    if (receipt.state === 'SUCCEEDED') {
      const task = await read('receipt-task', signal => previewService.getTaskInput({ ...options(signal), taskId: pending.taskId }));
      if (task && pendingSave.value?.requestId === pending.requestId) { accept(task); pendingSave.value = null; notice.value = '已核实任务保存成功。'; }
    } else if (receipt.state === 'FAILED' || receipt.state === 'NOT_FOUND') { pendingSave.value = null; error.value = receipt.message || '原请求未成功，可保留当前输入重新保存。'; }
    else notice.value = '原请求仍在处理中，请稍后核实。';
  }
  async function previewImport(files: TaskFileInput[]) {
    if (!editable.value || !draft.value) return;
    importFiles.value = files; importPreview.value = null; importBusy.value = true; error.value = ''; importBaseline.value = JSON.stringify([taskId.value,draft.value,resourceRevision.value]);
    const value = await read('import', signal => previewService.previewTaskInputImport({ ...options(signal), files: copy(files), taskId: taskId.value, revision: saved.value?.revision ?? null, resourceRevision: resourceRevision.value, input: copy(draft.value!) }));
    if (value) importPreview.value = value; importBusy.value = false;
  }
  async function applyImport() {
    const value = importPreview.value; if (!editable.value || !value?.input || value.issues.length) return false;
    if (importBaseline.value !== JSON.stringify([taskId.value,draft.value,resourceRevision.value]) || value.resourceRevision !== resources.workspace?.revision) { error.value='任务草稿或资源版本已变化，请重新校验导入';return false; }
    let target: ApiTask | null = null;
    if (value.existing) { const found = await read('import-target', signal => previewService.getTaskInput({ ...options(signal), taskId: value.taskId })); if (!found) return false; if(found.revision!==value.taskRevision){error.value='目标任务在预览后已变化，请重新校验导入';return false;} target = found; }
    // 目标版本核实期间也可能发生编辑，不能用迟到预览覆盖新输入。
    if (value !== importPreview.value || importBaseline.value !== JSON.stringify([taskId.value,draft.value,resourceRevision.value]) || value.resourceRevision !== resources.workspace?.revision || !editable.value) { error.value='导入现场已变化，请重新校验';return false; }
    saved.value = target; taskId.value = value.taskId; baseline.value = target ? JSON.stringify(target.input) : ''; draft.value = copy(value.input); clearImport(); notice.value = '导入已应用到草稿，尚未保存。'; await refreshReferences(false); return true;
  }
  function discardDraft() {
    validationInput.value=null;validationExtras.value=[];
    if (saved.value) accept(saved.value);
    else { draft.value = initialInput.value ? copy(initialInput.value) : null; baseline.value = JSON.stringify(draft.value); clearImport(); auxiliary.value = {}; }
  }
  async function allowLeave(deferDiscard = false, ignoredAuxiliary: string[] = []): Promise<boolean> {
    if (busy.value || pendingSave.value) { error.value = '请先等待写入完成或核实回执'; return false; }
    // 调整输入已由独立保护处理，整页离开时不为同一输入重复弹窗。
    const auxiliaryDirty = Object.entries(auxiliary.value).some(([key, value]) => value && !ignoredAuxiliary.includes(key));
    if (!changed.value && !importFiles.value.length && !auxiliaryDirty) return true;
    const unapplied = importFiles.value.length || auxiliaryDirty;
    const session = auth.generation, token = generation;
    const choice = await ask({ title: '处理未保存任务输入', message: unapplied ? '尚有未应用的导入或抽屉输入，请继续完成，或明确放弃这些输入。' : '任务草稿尚未保存。保存成功后再离开，或明确放弃本次修改。', saveLabel: !unapplied && editable.value ? '保存任务后离开' : undefined, discardLabel: '放弃本次输入' });
    if (session !== auth.generation || token !== generation || !readable.value) return false;
    if (choice === 'save') return save();
    if (choice === 'discard') { if (!deferDiscard) discardDraft(); return true; }
    return false;
  }
  function clearForSession() { initialInput.value=null;adjustmentExamples.value=[];lifetime++; stop(); catalog.value = null; draft.value = null; saved.value = null; taskId.value = ''; baseline.value = ''; resourceRevision.value = ''; nodes.value = []; losNodes.value = []; devices.value = []; library.value = null; issues.value = []; pendingSave.value = null; busy.value = false; running.value = false; clearImport(); auxiliary.value = {}; error.value = ''; notice.value = ''; }
  return { context, catalog, draft, saved, taskId, resourceRevision, nodes, losNodes, devices, library, libraryQuery, error, notice, issues, displayIssues, busy, loading, running, pendingSave, importPreview, importFiles, importVisible, importBusy, auxiliary, decision, readable, editable, dirty, changed, adjustmentExamples, loadAdjustmentExamples,
    initialize, refreshReferences, queryLibrary, open, newTask, loadPreset, resetDraft, copyPlanInput, openPlanTask, updateInput, applyPreset, save, reconcileSave, previewImport, applyImport, clearImport, allowLeave, discardDraft, ask, answer, stop, clearForSession };
});
