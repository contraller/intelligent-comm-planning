import { diagnosisNetworkKey, networkInterferenceIds } from '../services/diagnosis-catalog';
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import type { DiagnosisDemo, DiagnosisDraft, DiagnosisImportPreview, DiagnosisIssue, DiagnosisLoaded, DiagnosisPreset, DiagnosisRecord, DiagnosisRunView, DiagnosisScenarioVersion, DiagnosisSources, DiagnosisWorkspace, FaultInput, ReportFormat } from '../types/diagnosis';
import { DIAGNOSIS_POLL_MS, DIAGNOSIS_MAX_FILE_BYTES } from '../config/demo';
import { downloadDiagnosisFile } from '../reports/diagnosis-export';
import { useAuthStore } from './auth';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const useDiagnosisStore = defineStore('diagnosis', () => {
  const auth=useAuthStore();
  const workspace = ref<DiagnosisWorkspace | null>(null);
  const presets = ref<DiagnosisPreset[]>([]);
  const legacy = ref<DiagnosisRecord[]>([]);
  const sources = ref<DiagnosisSources>({plans:[],error:null});
  const symptoms = ref<DiagnosisLoaded['symptoms']>([]);
  const legacyInterferenceIds = ref<string[]>([]);
  const interferenceIds = computed(() => network.value ? networkInterferenceIds(network.value) : legacyInterferenceIds.value);
  const draft = ref<DiagnosisDraft | null>(null), baseline = ref<DiagnosisDraft | null>(null);
  const scenarioId = ref<string | null>(null), versionId = ref(''), runId = ref('');
  const view = ref<DiagnosisRunView | null>(null), record = ref<DiagnosisRecord | null>(null);
  const undoStack = ref<DiagnosisDraft[]>([]), redoStack = ref<DiagnosisDraft[]>([]);
  const formDirty = ref(false), importPreview = ref<DiagnosisImportPreview | null>(null);
  const demo = ref<DiagnosisDemo>('normal');
  const loading = ref(false), busy = ref(false), exporting = ref(false), importing = ref(false);
  const loadError = ref(''), error = ref(''), queryError = ref(''), notice = ref('');
  const issues = ref<DiagnosisIssue[]>([]), decision = ref<DecisionRequest | null>(null);
  let resolver: ((value: Decision) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, generation = 0, polling = false, queryPending = false,querySerial=0,loadSerial=0,importSerial=0,exportSerial=0;
  let pending: { signature: string; requestId: string } | null = null;
  const dirty = computed(() => formDirty.value || !!importPreview.value || JSON.stringify(draft.value) !== JSON.stringify(baseline.value));
  const running = computed(() => !!view.value && ['PENDING','RUNNING'].includes(view.value.state));
  const selectedVersion = computed(() => workspace.value?.scenarios.flatMap((s) => s.versions).find((v) => v.id === versionId.value) ?? null);
  const network = computed(() => view.value?.run.scenario.network ?? record.value?.network ??
    (draft.value ? sources.value.plans.find((p) => p.id === draft.value!.planId) ?? selectedVersion.value?.network : null) ?? null);
  const editableSource = computed(() => !!draft.value && !!workspace.value && sources.value.plans.some((p) => p.id === draft.value!.planId) && !view.value && !record.value && !workspace.value.scenarios.find((s) => s.id === scenarioId.value)?.archived);
  const canEdit=computed(()=>auth.can('diagnosis.scenario')&&editableSource.value);
  const canExecute=computed(()=>auth.can('diagnosis.execute')&&editableSource.value&&((!!versionId.value&&!dirty.value)||auth.can('diagnosis.scenario')));
  const locked = computed(() => busy.value || loading.value || importing.value);
  const result = computed(() => record.value?.result ?? (view.value?.diagnosisReady ? view.value.run.result : null));
  const impactReady = computed(() => !!record.value || !!view.value?.impactReady);
  const availablePresets = computed(() => presets.value.filter((p) => p.networkPresetId === (network.value ? diagnosisNetworkKey(network.value) : undefined)));
  function report(reason: unknown) { error.value = reason instanceof Error ? reason.message : '诊断操作失败'; issues.value = reason instanceof ApiError && Array.isArray(reason.data) ? reason.data : []; }
  function ask(request: DecisionRequest): Promise<Decision> {
    if (resolver) return Promise.resolve('cancel'); decision.value = request;
    return new Promise((resolve) => { resolver = resolve; });
  }
  function answer(choice: Decision) { const resolve = resolver; resolver = undefined; decision.value = null; resolve?.(choice); }
  async function allowDiscard(deferDiscard=false) {
    if (locked.value) { error.value = '操作尚未完成，请稍候'; return false; }
    if (!dirty.value) return true;
    if (await ask({title:'未保存的诊断输入',message:'放弃当前场景、表单或导入预览？已保存场景和已提交任务会保留。',saveLabel:'放弃并继续',cancelLabel:'继续编辑'}) !== 'save') return false;
    if(!deferDiscard){draft.value = baseline.value ? clone(baseline.value) : null; formDirty.value = false; importPreview.value = null; undoStack.value = []; redoStack.value = [];}
    return true;
  }
  function stopPolling() { polling = false; generation++; if (timer) clearTimeout(timer); timer = undefined; }
  function clearSelection() { stopPolling(); view.value = null; record.value = null; runId.value = ''; queryError.value = ''; }
  function setDraft(next: DiagnosisDraft, saved: boolean) {
    draft.value = clone(next); baseline.value = saved ? clone(next) : null; formDirty.value = false; importPreview.value = null; undoStack.value = []; redoStack.value = []; issues.value = [];
  }
  function updateDraft(next: DiagnosisDraft) { if (!canEdit.value || locked.value) return; if (draft.value) undoStack.value.push(clone(draft.value)); draft.value = clone(next); redoStack.value = []; issues.value = []; }
  function applyFaults(faults: FaultInput[], name?: string, description?: string) {
    if (!canEdit.value || !draft.value) return;
    updateDraft({...clone(draft.value),faults:clone(faults),name:name ?? draft.value.name,description:description ?? draft.value.description}); formDirty.value = false;
  }
  function undo() { if (!canEdit.value || !draft.value || locked.value) return; const previous = undoStack.value.pop(); if (previous) { redoStack.value.push(clone(draft.value)); draft.value = previous; } }
  function redo() { if (!canEdit.value || !draft.value || locked.value) return; const next = redoStack.value.pop(); if (next) { undoStack.value.push(clone(draft.value)); draft.value = next; } }
  async function newScenario(planId?: string, faults: FaultInput[] = []) {
    if (!auth.can('diagnosis.scenario') || !(await allowDiscard())) return false;
    await refreshSources();
    const plan = planId ? sources.value.plans.find((p) => p.id === planId) : sources.value.plans[0];
    if (!plan || !workspace.value) { error.value = '请先准备当前有效的已确认方案，并确保诊断存储可用'; return false; }
    clearSelection(); scenarioId.value = null; versionId.value = ''; demo.value = 'normal';
    setDraft({name:'新建故障场景',description:'',planId:plan.id,faults:clone(faults)},false); return true;
  }
  async function switchPlan(id: string) {
    const previous = draft.value ? clone(draft.value) : null;
    if (await newScenario(id,previous?.faults ?? [])) {
      if (previous) draft.value = {...previous,planId:id};
      notice.value = '已建立新场景草稿；请复核对象，历史场景及诊断没有重绑';
    }
  }
  async function selectVersion(v: DiagnosisScenarioVersion) {
    if (!(await allowDiscard())) return;
    clearSelection(); scenarioId.value = v.scenarioId; versionId.value = v.id;
    const {name,description,planId,faults} = v; setDraft({name,description,planId,faults},true);
  }
  async function copyVersion(v: DiagnosisScenarioVersion) {
    if (await newScenario(undefined,v.faults)) draft.value = {...draft.value!,name:`${v.name.slice(0,70)} 副本`,description:v.description};
  }
  function applyPreset(id: string) { const preset = availablePresets.value.find((p) => p.id === id); if (preset) applyFaults(preset.faults,preset.label); }
  function request(kind: string,payload: unknown) {
    if (!workspace.value) throw new ApiError('诊断工作区尚不可写','DIAGNOSIS_UNAVAILABLE');
    const signature = JSON.stringify({kind,payload}); if (pending?.signature !== signature) pending = {signature,requestId:crypto.randomUUID()};
    return {baseRevision:workspace.value.revision,requestId:pending.requestId};
  }
  function accept(w: DiagnosisWorkspace) { workspace.value = w; pending = null; error.value = ''; issues.value = []; }
  async function save() {
    if (!canEdit.value || locked.value || !draft.value) return false;
    if (versionId.value && !dirty.value) { notice.value = '场景没有新的修改'; return true; }
    if (formDirty.value) { error.value = '请先应用抽屉中的表单修改'; return false; }
    busy.value = true;
    try {
      const payload = {scenarioId:scenarioId.value,draft:clone(draft.value)};
      const req = {...request('save',payload),...payload};
      const next = await previewService.saveDiagnosisScenario(req);
      const savedReceipt = next.receipts.find((r) => r.requestId === req.requestId)!;
      accept(next); scenarioId.value = savedReceipt.entityIds[0]; versionId.value = savedReceipt.entityIds[1];
      baseline.value = clone(draft.value); undoStack.value = []; redoStack.value = []; notice.value = '场景新版本已保存，历史版本保留'; return true;
    } catch (reason) { report(reason); return false; } finally { busy.value = false; }
  }
  async function archive(id: string,archived: boolean) {
    if (!auth.can('diagnosis.scenario') || !(await allowDiscard())) return;
    if (await ask({title:archived ? '归档场景' : '恢复场景',message:'仅改变活动列表状态，场景版本和历史诊断继续保留。',saveLabel:archived ? '归档' : '恢复'}) !== 'save') return;
    busy.value = true;
    try { const payload = {scenarioId:id,archived}; accept(await previewService.archiveDiagnosisScenario({...request('archive',payload),...payload})); }
    catch (reason) { report(reason); } finally { busy.value = false; }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (auth.can('diagnosis.view') && polling && running.value && !queryError.value && !busy.value) timer = setTimeout(() => void query(), DIAGNOSIS_POLL_MS);
  }
  async function query() {
    if (!auth.can('diagnosis.view') || !runId.value || queryPending || busy.value) return;
    queryPending = true; const token = generation, id = runId.value,serial=++querySerial;
    try { const next = await previewService.getDiagnosisRun(id); if (token === generation && id === runId.value) { view.value = next; record.value = next.report; queryError.value = ''; } }
    catch (reason) { if (token === generation && id === runId.value) queryError.value = `查询失败，状态未确认：${reason instanceof Error ? reason.message : '请重试'}`; }
    finally { if(serial!==querySerial)return;queryPending = false; if (token !== generation && polling && runId.value) void query(); else schedule(); }
  }
  async function startPolling() { if(!auth.can('diagnosis.view'))return;polling = true; generation++; await query(); }
  async function selectRun(id: string) {
    if (!(await allowDiscard())) return;
    clearSelection(); draft.value = null; baseline.value = null; scenarioId.value = null; versionId.value = ''; runId.value = id; await startPolling();
  }
  async function selectLegacy(id: string) {
    if (!(await allowDiscard())) return;
    clearSelection(); draft.value = null; baseline.value = null; versionId.value = ''; scenarioId.value = null;
    const session=auth.generation,token=generation;
    try { const value=await previewService.getDiagnosisReport(id);if(session===auth.generation&&token===generation)record.value=value; } catch (reason) { report(reason); }
  }
  async function submit() {
    if (!canExecute.value || locked.value) return;
    if ((dirty.value || !versionId.value) && !(await save())) return;
    busy.value = true;
    try {
      const payload = {scenarioVersionId:versionId.value,demo:demo.value};
      const next = await previewService.submitDiagnosis({...request('submit',payload),...payload});
      accept(next.workspace); clearSelection(); runId.value = next.view.run.id; view.value = next.view; draft.value = null; baseline.value = null; notice.value = '诊断已提交，网络与场景快照已冻结';
    } catch (reason) { report(reason); } finally { busy.value = false; if (runId.value) await startPolling(); }
  }
  async function cancel() {
    if (!auth.can('diagnosis.execute') || !running.value || locked.value || await ask({title:'取消诊断',message:'取消尚未完成的诊断/影响阶段；冻结输入保留，不生成完整报告。',saveLabel:'确认取消'}) !== 'save') return;
    busy.value = true;
    try { const next = await previewService.cancelDiagnosisRun({...request('cancel',runId.value),runId:runId.value}); accept(next.workspace); view.value = next.view; record.value = null; stopPolling(); }
    catch (reason) { report(reason); } finally { busy.value = false; schedule(); }
  }
  async function refreshSources() {
    if(!auth.can('diagnosis.view'))return;const session=auth.generation,token=generation;
    try { const value=await previewService.loadDiagnosisSources();if(session!==auth.generation||token!==generation)return;sources.value=value;if(record.value){const id=record.value.id,next=await previewService.getDiagnosisReport(id);if(session===auth.generation&&token===generation&&record.value?.id===id)record.value=next;} }
    catch (reason) { if(session===auth.generation&&token===generation)sources.value = {plans:[],error:reason instanceof Error ? reason.message : '来源读取失败'}; }
  }
  function hydrate(loaded: DiagnosisLoaded) {
    workspace.value = loaded.workspace; loadError.value = loaded.error ?? ''; presets.value = loaded.presets; legacy.value = loaded.legacy; sources.value = loaded.sources; symptoms.value = loaded.symptoms; legacyInterferenceIds.value = loaded.interferenceIds;
  }
  async function load() {
    if (!auth.can('diagnosis.view') || locked.value) return; loading.value = true;const session=auth.generation,serial=++loadSerial;
    try { const loaded=await previewService.loadDiagnosisWorkspace();if(session!==auth.generation)return;hydrate(loaded); if (!record.value && !draft.value && !runId.value) { const last = workspace.value?.runs.at(-1); if (last) runId.value = last.id; else record.value = legacy.value[0] ?? null; } }
    catch (reason) { if(session===auth.generation)loadError.value = reason instanceof Error ? reason.message : '诊断加载失败'; } finally { if(serial===loadSerial)loading.value=false;if(session===auth.generation&&runId.value)await startPolling(); }
  }
  async function reload() { if (!(await allowDiscard())) return; clearSelection(); draft.value = null; baseline.value = null; await load(); }
  async function previewImport(file: File,planId: string) {
    if (!auth.can('diagnosis.scenario') || locked.value) return; importing.value = true; error.value = '';const session=auth.generation,serial=++importSerial;
    // 文件读取和生成都跨异步边界，旧账号的数据不能进入新会话。
    try { if (file.size > DIAGNOSIS_MAX_FILE_BYTES) throw new ApiError('单文件最多 5 MiB','IMPORT_LIMIT');const bytes=new Uint8Array(await file.arrayBuffer());if(session!==auth.generation||!auth.can('diagnosis.scenario'))return;const next=await previewService.previewDiagnosisImport({name:file.name,bytes},planId);if(session===auth.generation)importPreview.value=next; }
    catch (reason) { if(session===auth.generation)report(reason); } finally { if(serial===importSerial)importing.value = false; }
  }
  async function commitImport() {
    if (!auth.can('diagnosis.scenario') || !importPreview.value || importPreview.value.issues.length || locked.value) return false; busy.value = true;
    try { const drafts = clone(importPreview.value.drafts); accept(await previewService.commitDiagnosisImport({...request('import',drafts),drafts})); importPreview.value = null; notice.value = '全部场景已导入，未覆盖已有场景'; return true; }
    catch (reason) { report(reason); return false; } finally { busy.value = false; }
  }
  async function download(format: ReportFormat | 'xlsx' | 'png',filters = '') {
    if (!auth.can('diagnosis.export') || !record.value || exporting.value) return; exporting.value = true; error.value = '';const session=auth.generation,serial=++exportSerial;
    try { const id = record.value.id; const file = format === 'xlsx' || format === 'png' ? await previewService.exportDiagnosisImpact(id,format,filters) : await previewService.exportDiagnosisReport(id,format); if(!(await auth.check())||session!==auth.generation||!auth.can('diagnosis.export'))return;downloadDiagnosisFile(file); notice.value = '文件已生成并发起下载'; }
    catch (reason) { if(session===auth.generation)report(reason); } finally { if(serial===exportSerial)exporting.value = false; }
  }
  async function template(format: 'csv' | 'xlsx') { if(!auth.can('diagnosis.scenario'))return;const session=auth.generation;try { const file=await previewService.getDiagnosisTemplate(format, network.value?.id);if(await auth.check()&&session===auth.generation&&auth.can('diagnosis.scenario'))downloadDiagnosisFile(file); } catch (reason) { report(reason); } }
  async function reset() {
    if (!auth.can('diagnosis.reset') || locked.value || await ask({title:'重置诊断演示数据',message:'将清除自建场景及版本、诊断任务与结果、未保存输入和导入预览，恢复内置历史记录。资源和规划保留。此操作不可恢复。',saveLabel:'确认重置诊断'}) !== 'save') return;
    busy.value = true;
    try { const loaded = await previewService.resetDiagnosisWorkspace(workspace.value?.revision ?? null); clearSelection(); draft.value = null; baseline.value = null; formDirty.value = false; importPreview.value = null; undoStack.value = []; redoStack.value = []; pending = null; hydrate(loaded); record.value = legacy.value[0] ?? null; error.value = ''; notice.value = '诊断演示数据已重置'; }
    catch (reason) { report(reason); } finally { busy.value = false; }
  }
  function clearForSession(){loadSerial++;importSerial++;exportSerial++;querySerial++;queryPending=false;importing.value=false;exporting.value=false;stopPolling();answer('cancel');workspace.value=null;presets.value=[];legacy.value=[];sources.value={plans:[],error:null};symptoms.value=[];legacyInterferenceIds.value=[];draft.value=null;baseline.value=null;scenarioId.value=null;versionId.value='';runId.value='';view.value=null;record.value=null;undoStack.value=[];redoStack.value=[];formDirty.value=false;importPreview.value=null;demo.value='normal';loading.value=false;loadError.value='';error.value='';queryError.value='';notice.value='';issues.value=[];pending=null;}
  return { clearForSession,workspace,presets,legacy,sources,symptoms,interferenceIds,draft,baseline,scenarioId,versionId,runId,view,record,undoStack,redoStack,formDirty,importPreview,demo,loading,busy,exporting,importing,loadError,error,queryError,notice,issues,decision,dirty,running,selectedVersion,network,canEdit,canExecute,locked,result,impactReady,availablePresets,
    ask,answer,allowDiscard,updateDraft,applyFaults,undo,redo,newScenario,switchPlan,selectVersion,copyVersion,applyPreset,save,archive,query,startPolling,stopPolling,selectRun,selectLegacy,submit,cancel,refreshSources,load,reload,previewImport,commitImport,download,template,reset };
});
