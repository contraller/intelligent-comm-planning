import { computed, ref, toRaw } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { taskInputIssues } from '../services/task-api-validation';
import type { ApiPage, ApiTask, ApiTaskImportPreview, TaskApiOptions, TaskApiSave } from '../types/task-api';
import type { PlanningCatalog } from '../types/planning-api';
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
  const context = ref<TaskApiOptions['context']>('planning'), catalog = ref<PlanningCatalog | null>(null), draft = ref<PlanningInput | null>(null), saved = ref<ApiTask | null>(null);
  const taskId = ref(''), resourceRevision = ref(''), baseline = ref(''), error = ref(''), notice = ref(''), busy = ref(false), loading = ref(false), running = ref(false);
  const library = ref<ApiPage<ApiTask> | null>(null), libraryQuery = ref({ page: 1, pageSize: 10, search: '' });
  const nodes = ref<ReadNode[]>([]), losNodes = ref<ReadNode[]>([]), devices = ref<ReadDevice[]>([]), issues = ref<PlanningIssue[]>([]);
  const importPreview = ref<ApiTaskImportPreview | null>(null), importFiles = ref<TaskFileInput[]>([]), importVisible = ref(false), importBusy = ref(false), importBaseline = ref('');
  const pendingSave = ref<TaskApiSave | null>(null), auxiliary = ref<Record<string, boolean>>({}), decision = ref<DecisionRequest | null>(null);
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
    const data = await read('catalog', signal => previewService.loadPlanningCatalog(options(signal)));
    if (data) {
      catalog.value = data;
      if (!draft.value) { draft.value = copy(data.presets[0].defaults); taskId.value = crypto.randomUUID(); baseline.value = JSON.stringify(draft.value); resourceRevision.value = resources.workspace?.revision ?? ''; }
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
  async function queryLibrary(page = libraryQuery.value.page) {
    libraryQuery.value.page = page;
    const value = await read('library', signal => previewService.queryTaskInputs({ ...libraryQuery.value, ...options(signal) })); if (value) library.value = value;
  }
  function accept(task: ApiTask) { saved.value = copy(task); taskId.value = task.taskId; resourceRevision.value = task.resourceRevision; draft.value = copy(task.input); baseline.value = JSON.stringify(draft.value); issues.value = []; clearImport(); auxiliary.value = {}; }
  async function open(id: string, protect = true) {
    if (busy.value || running.value || pendingSave.value || protect && !(await allowLeave())) return false;
    error.value = ''; const value = await read('task', signal => previewService.getTaskInput({ ...options(signal), taskId: id }));
    if (!value) return false; accept(value); await refreshReferences(false); return true;
  }
  async function newTask() {
    if (!editable.value || !catalog.value || !(await allowLeave())) return;
    saved.value = null; taskId.value = crypto.randomUUID(); draft.value = copy(catalog.value.presets[0].defaults); baseline.value = ''; resourceRevision.value = resources.workspace?.revision ?? ''; issues.value = []; notice.value = ''; await refreshReferences();
  }
  function updateInput(input: PlanningInput) { if (!editable.value) return; draft.value = copy(input); issues.value = []; }
  function applyPreset(id: string) {
    const preset = catalog.value?.presets.find(p => p.id === id); if (!preset || !draft.value || !editable.value) return;
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
  }
  async function save(): Promise<boolean> {
    if (!editable.value || !draft.value || importFiles.value.length || Object.values(auxiliary.value).some(Boolean)) { error.value = '请先完成或放弃当前抽屉输入，再保存任务'; return false; }
    issues.value = taskInputIssues(draft.value); if (issues.value.length) return false;
    const request: TaskApiSave = { ...options(), taskId: taskId.value, revision: saved.value?.revision ?? null, resourceRevision: resourceRevision.value, requestId: crypto.randomUUID(), input: copy(draft.value) };
    busy.value = true; error.value = ''; const session = auth.generation, token = generation, owner = lifetime;
    try {
      const value = await previewService.saveTaskInput(request);
      if (session !== auth.generation || token !== generation) {
        // 失权只冻结现场，已发送的写入仍须核实；明确清理后不恢复旧请求。
        if (owner === lifetime) { pendingSave.value = request; error.value = '写入期间会话状态变化，请恢复权限后核实原请求。'; }
        return false;
      }
      accept(value); notice.value = '任务输入已保存；规划需单独提交。'; return true;
    } catch (e) {
      if (owner === lifetime) { error.value = e instanceof Error ? e.message : '保存失败'; if (uncertainWrite(e)) { pendingSave.value = request; error.value += '。结果待核实，请查询原请求回执。'; } if (session === auth.generation && e instanceof ApiError && Array.isArray(e.data)) issues.value = e.data; }
      return false;
    } finally { busy.value = false; }
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
  async function allowLeave(): Promise<boolean> {
    if (busy.value || pendingSave.value) { error.value = '请先等待写入完成或核实回执'; return false; }
    if (!dirty.value) return true;
    const unapplied = importFiles.value.length || Object.values(auxiliary.value).some(Boolean);
    const choice = await ask({ title: '处理未保存任务输入', message: unapplied ? '尚有未应用的导入或抽屉输入，请继续完成，或明确放弃这些输入。' : '任务草稿尚未保存。保存成功后再离开，或明确放弃本次修改。', saveLabel: !unapplied && editable.value ? '保存任务后离开' : undefined, discardLabel: '放弃本次输入' });
    if (choice === 'save') return save();
    if (choice === 'discard') { if (saved.value) accept(saved.value); else { draft.value = catalog.value ? copy(catalog.value.presets[0].defaults) : null; baseline.value = JSON.stringify(draft.value); clearImport(); auxiliary.value = {}; } return true; }
    return false;
  }
  function clearForSession() { lifetime++; stop(); catalog.value = null; draft.value = null; saved.value = null; taskId.value = ''; baseline.value = ''; resourceRevision.value = ''; nodes.value = []; losNodes.value = []; devices.value = []; library.value = null; issues.value = []; pendingSave.value = null; busy.value = false; running.value = false; clearImport(); auxiliary.value = {}; error.value = ''; notice.value = ''; }
  return { context, catalog, draft, saved, taskId, resourceRevision, nodes, losNodes, devices, library, libraryQuery, error, notice, issues, busy, loading, running, pendingSave, importPreview, importFiles, importVisible, importBusy, auxiliary, decision, readable, editable, dirty, changed,
    initialize, refreshReferences, queryLibrary, open, newTask, updateInput, applyPreset, save, reconcileSave, previewImport, applyImport, clearImport, allowLeave, ask, answer, stop, clearForSession };
});
