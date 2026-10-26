// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
import { networkInterferenceIds } from '../services/diagnosis-catalog';
import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { createReadCancellation } from '../services/data-access';
import { diagnosisDataOrigin, diagnosisDemoEnabled, diagnosisTemplateAvailable } from '../services/diagnosis-presentation';
import type { DiagnosisCapabilities, DiagnosisDataOrigin } from '../types/diagnosis';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import type { DiagnosisDemo, DiagnosisDraft, DiagnosisImportPreview, DiagnosisIssue, DiagnosisLoaded, DiagnosisPreset, DiagnosisRecord, DiagnosisRunView, DiagnosisScenarioVersion, DiagnosisSources, DiagnosisWorkspace, FaultInput, ReportFormat } from '../types/diagnosis';
import { DIAGNOSIS_POLL_MS, DIAGNOSIS_MAX_FILE_BYTES } from '../config/demo';
import { downloadDiagnosisFile } from '../reports/diagnosis-export';
import { useAuthStore } from './auth';
import type { PlanVersion } from '../types/domain';
import type { DiagnosisContext, DiagnosisReadSources, DiagnosisScenarioSummary, DiagnosisRunSummary, DiagnosisVersionSummary, DiagnosisPresetOption, DiagnosisLegacySummary, DiagnosisReadView, DiagnosisResult, DiagnosisReceipt } from '../types/diagnosis';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const useDiagnosisStore = defineStore('diagnosis', () => {
  const auth=useAuthStore(),requests=createReadCancellation();
  const workspace = ref<{revision:string;scenarios:{id:string;archived:boolean;versions:(DiagnosisVersionSummary|DiagnosisScenarioVersion)[]}[];runs:(DiagnosisRunSummary|DiagnosisWorkspace['runs'][number])[]} | null>(null);
  const scenarioPage=ref(1),scenarioPageSize=ref(20),scenarioTotal=ref(0),showArchived=ref(false),historyPage=ref(1),historyPageSize=ref(20),historyTotal=ref(0);
  const selectedDetail=ref<DiagnosisScenarioVersion|null>(null),sourceNetwork=ref<PlanVersion|null>(null),stageResult=ref<DiagnosisResult|null>(null);
  // 归档状态来自详情元数据，不依赖当前页是否仍包含该场景。
  const selectedArchived=ref(false);
  let stageKey='', detailSerial=0, scenarioListSerial=0, historyListSerial=0;
  const presets = ref<DiagnosisPresetOption[]>([]);
  const legacy = ref<(DiagnosisLegacySummary|DiagnosisRecord)[]>([]);
  const sources = ref<{plans:(DiagnosisReadSources['plans'][number]|PlanVersion)[];error:string|null}>({plans:[],error:null});
  const symptoms = ref<DiagnosisLoaded['symptoms']>([]);
  const legacyInterferenceIds = ref<string[]>([]);
  const interferenceIds = computed(() => capabilities.value.twoStep ? legacyInterferenceIds.value : network.value ? networkInterferenceIds(network.value) : legacyInterferenceIds.value);
  const draft = ref<DiagnosisDraft | null>(null), baseline = ref<DiagnosisDraft | null>(null);
  const scenarioId = ref<string | null>(null), versionId = ref(''), runId = ref('');
  const view = ref<DiagnosisReadView|DiagnosisRunView | null>(null), record = ref<DiagnosisRecord | null>(null);
  const undoStack = ref<DiagnosisDraft[]>([]), redoStack = ref<DiagnosisDraft[]>([]);
  const formDirty = ref(false), importPreview = ref<DiagnosisImportPreview | null>(null);
  // 只允许当前身份把同一份场景草稿交给 GIS，不把普通导航当作放弃确认的例外。
  const gisHandoff = ref<{ session: number; signature: string; scenarioId: string | null; versionId: string } | null>(null);
  const demo = ref<DiagnosisDemo>('normal');
  const capabilities = ref<DiagnosisCapabilities>({}), contextOrigin = ref<DiagnosisDataOrigin>('UNKNOWN');
  const demoEnabled = computed(() => diagnosisDemoEnabled(capabilities.value));
  // 报告缺少来源时保持未知，不能借当前工作区给历史记录重新定性。
  const dataOrigin = computed(() => diagnosisDataOrigin(record.value ? record.value.dataOrigin : view.value ? view.value.dataOrigin : contextOrigin.value));
  watch(demoEnabled, enabled => { if (!enabled) demo.value = 'normal'; }, { flush:'sync' });
  const loading = ref(false), busy = ref(false), exporting = ref(false), importing = ref(false);
  const loadError = ref(''), error = ref(''), queryError = ref(''), notice = ref('');
  const importError=ref(''),exportError=ref('');
  // 各入口独立反馈，重试成功只清理本次操作的错误。
  const scenarioQueryError=ref(''),historyQueryError=ref(''),impactExportError=ref('');
  const exportTarget=ref<'report'|'impact'|null>(null),cancelAwaitingRefresh=ref(false);
  const issues = ref<DiagnosisIssue[]>([]), decision = ref<DecisionRequest | null>(null);
  let resolver: ((value: Decision) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, generation = 0, polling = false, queryPending = false,querySerial=0,loadSerial=0,importSerial=0,exportSerial=0,saveSerial=0,stageRetries=0;
  let pending: { signature: string; requestId: string } | null = null;
  const dirty = computed(() => formDirty.value || !!importPreview.value || JSON.stringify(draft.value) !== JSON.stringify(baseline.value));
  const running = computed(() => !!view.value && ['PENDING','RUNNING'].includes(view.value.state));
  const selectedVersion = computed(() => selectedDetail.value ?? workspace.value?.scenarios.flatMap((s) => s.versions).find((v):v is DiagnosisScenarioVersion => v.id === versionId.value && 'network' in v) ?? null);
  const network = computed<PlanVersion|null>(() => {
    if(view.value)return view.value.run.scenario.network;
    if(record.value)return record.value.network;
    if(!draft.value)return null;
    const plan=sources.value.plans.find(p=>p.id===draft.value!.planId);
    return sourceNetwork.value??selectedVersion.value?.network??(plan&&'inputSnapshot' in plan?plan:null);
  });
  const editableSource = computed(() => !!draft.value && !!workspace.value && sources.value.plans.some((p) => p.id === draft.value!.planId && (!('canCreate' in p) || p.canCreate)) && !view.value && !record.value && !selectedArchived.value);
  const canEdit=computed(()=>auth.can('diagnosis.scenario')&&editableSource.value);
  // 空场景先引导设置故障，保存的完整校验仍由原服务负责。
  const canExecute=computed(()=>auth.can('diagnosis.execute')&&editableSource.value&&!!draft.value?.faults.length&&((!!versionId.value&&!dirty.value)||auth.can('diagnosis.scenario')));
  const locked = computed(() => busy.value || loading.value || importing.value);
  const result = computed(() => record.value?.result ?? stageResult.value ?? (view.value?.diagnosisReady && 'result' in view.value.run ? view.value.run.result : null));
  const impactReady = computed(() => !!record.value || !!view.value?.impactReady);
  const availablePresets = computed(() => network.value ? presets.value.filter(p => diagnosisTemplateAvailable(p,network.value!.id)) : []);
  function report(reason: unknown) { error.value = reason instanceof Error ? reason.message : '诊断操作失败'; issues.value = reason instanceof ApiError && Array.isArray(reason.data) ? reason.data : []; }
  function ask(request: DecisionRequest): Promise<Decision> {
    if (resolver) return Promise.resolve('cancel'); decision.value = request;
    return new Promise((resolve) => { resolver = resolve; });
  }
  function answer(choice: Decision) { const resolve = resolver; resolver = undefined; decision.value = null; resolve?.(choice); }
  function prepareGisEditing() {
    if (!auth.can('situation.view') || !auth.can('diagnosis.view') || !canEdit.value || locked.value || !draft.value) return false;
    if (formDirty.value || importPreview.value) { error.value = '请先应用或关闭场景表单及导入预览，再进入 GIS 标绘'; return false; }
    gisHandoff.value = { session: auth.generation, signature: JSON.stringify(draft.value), scenarioId: scenarioId.value, versionId: versionId.value };
    return true;
  }
  function allowsGisTransfer(query: Record<string, unknown>) {
    const target = gisHandoff.value;
    return !!target && target.session === auth.generation && query.faultEdit === '1' &&
      Object.keys(query).every(key => ['faultEdit', 'scenarioId', 'versionId'].includes(key)) &&
      (query.scenarioId === undefined || query.scenarioId === target.scenarioId) &&
      (query.versionId === undefined || query.versionId === target.versionId) &&
      auth.can('situation.view') && auth.can('diagnosis.view') && canEdit.value && !locked.value &&
      !formDirty.value && !importPreview.value && target.scenarioId === scenarioId.value &&
      target.versionId === versionId.value && target.signature === JSON.stringify(draft.value);
  }
  function acceptGisTransfer(query: Record<string, unknown>) {
    if (!allowsGisTransfer(query)) return false;
    gisHandoff.value = null; return true;
  }
  function clearGisTransfer() { gisHandoff.value = null; }
  function discardDraft() {
    draft.value = baseline.value ? clone(baseline.value) : null; formDirty.value = false; importPreview.value = null; undoStack.value = []; redoStack.value = [];
  }
  async function allowDiscard(deferDiscard=false) {
    if (locked.value) { error.value = '操作尚未完成，请稍候'; return false; }
    if (!dirty.value) return true;
    if (await ask({title:'未保存的诊断输入',message:'放弃当前场景、表单或导入预览？已保存场景和已提交任务会保留。',saveLabel:'放弃并继续',cancelLabel:'继续编辑'}) !== 'save') return false;
    if(!deferDiscard)discardDraft();
    return true;
  }
  function stopPolling() { requests.stop();loadSerial++;loading.value=false;polling = false; generation++; detailSerial++; if (timer) clearTimeout(timer); timer = undefined; }
  function clearSelection() { stopPolling(); stageKey='';stageResult.value=null;selectedDetail.value=null;selectedArchived.value=false;sourceNetwork.value=null; view.value = null; record.value = null; runId.value = ''; cancelAwaitingRefresh.value=false;queryError.value = '';error.value='';exportError.value='';impactExportError.value='';exportTarget.value=null;importError.value='';notice.value=''; }
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
    const session=auth.generation;
    // 先确认是否可离开，但目标读取成功前不丢弃当前草稿或撤销历史。
    if (!auth.can('diagnosis.scenario') || !(await allowDiscard(true)) || session!==auth.generation) return false;
    await refreshSources();
    if(session!==auth.generation||!auth.can('diagnosis.scenario'))return false;
    // 诊断页的新建/复制显式传网络；GIS 原有无参初始化仍保持原流程。
    const plan = planId ? sources.value.plans.find((p) => p.id === planId) : sources.value.plans[0];
    if (!plan || !workspace.value) { error.value = '请先准备当前有效的已确认方案，并确保诊断存储可用'; return false; }
    if ('canCreate' in plan && !plan.canCreate) { error.value=plan.unavailableReason || '当前网络暂不支持诊断';return false; }
    const token=++detailSerial;
    let bound:PlanVersion;try{bound=await previewService.getDiagnosisSource({planId:plan.id,signal:requests.signal('source')});}catch(e){if(session===auth.generation)report(e);return false;}
    if(session!==auth.generation||token!==detailSerial)return false;
    clearSelection();sourceNetwork.value=bound; scenarioId.value = null; versionId.value = ''; demo.value = 'normal';
    setDraft({name:'新建故障场景',description:'',planId:plan.id,faults:clone(faults)},false); return true;
  }
  async function switchPlan(id: string) {
    const previous = draft.value ? clone(draft.value) : null,session=auth.generation;
    if (await newScenario(id,previous?.faults ?? [])&&session===auth.generation) {
      if (previous) draft.value = {...previous,planId:id};
      notice.value = '已建立新场景草稿；请复核对象，历史场景及诊断没有重绑';
    }
  }
  async function selectVersion(v: Pick<DiagnosisScenarioVersion,'id'|'scenarioId'>) {
    const session=auth.generation;
    if (!(await allowDiscard())||session!==auth.generation||!auth.can('diagnosis.view')) return;
    const token=++detailSerial;loading.value=true;
    try {
      const value=await previewService.getDiagnosisVersion({scenarioId:v.scenarioId,versionId:v.id,signal:requests.signal('version')});
      if(session!==auth.generation||token!==detailSerial)return;
      clearSelection();const {scenarioArchived,...frozen}=value;selectedDetail.value=frozen;selectedArchived.value=scenarioArchived;scenarioId.value=value.scenarioId;versionId.value=value.id;
      const {name,description,planId,faults}=value;setDraft({name,description,planId,faults},true);
    } catch(e) {if(session===auth.generation&&token===detailSerial)report(e);}
    finally {if(session===auth.generation)loading.value=false;}
  }
  async function copyVersion(v: DiagnosisScenarioVersion,planId: string) {
    if (await newScenario(planId,v.faults)) { draft.value = {...draft.value!,name:`${v.name.slice(0,70)} 副本`,description:v.description};return true; }
    return false;
  }
  async function applyPreset(id: string) {
    if(!canEdit.value||locked.value||!availablePresets.value.some(p=>p.id===id))return;
    const token=++detailSerial,session=auth.generation,target=JSON.stringify(draft.value);
    try { const preset=await previewService.getDiagnosisPreset({id,signal:requests.signal('preset')});
      if(session===auth.generation&&token===detailSerial&&target===JSON.stringify(draft.value))applyFaults(preset.faults,preset.label);
    } catch(e){if(session===auth.generation&&token===detailSerial)report(e);}
  }
  function request(kind: string,payload: unknown) {
    if (!workspace.value) throw new ApiError('诊断工作区尚不可写','DIAGNOSIS_UNAVAILABLE');
    const signature = JSON.stringify({kind,payload}); if (pending?.signature !== signature) pending = {signature,requestId:randomUuid()};
    return {baseRevision:workspace.value.revision,requestId:pending.requestId};
  }
  function accept(w: DiagnosisReceipt) { if(workspace.value)workspace.value.revision=w.revision; pending = null; error.value = ''; issues.value = []; }
  async function refreshLists(scope:'all'|'scenarios'|'history'='all'){
    // 场景与运行目录可分别重试，另一目录的请求不能使本次恢复失效。
    const scenarioSerial=scope!=='history'?++scenarioListSerial:scenarioListSerial,
      historySerial=scope!=='scenarios'?++historyListSerial:historyListSerial,session=auth.generation;
    const [scenes,runs]=await Promise.all([
      scope!=='history'?previewService.queryDiagnosisScenarios({archived:showArchived.value,pageNum:scenarioPage.value,pageSize:scenarioPageSize.value,signal:requests.signal('scenarios')}):Promise.resolve(null),
      scope!=='scenarios'?previewService.queryDiagnosisHistory({pageNum:historyPage.value,pageSize:historyPageSize.value,signal:requests.signal('history')}):Promise.resolve(null)]);
    if(session!==auth.generation||!workspace.value)return;
    // 页码和条数取自响应，分页展示与本次查询保持一致。
    if(scenes&&scenarioSerial===scenarioListSerial){workspace.value.scenarios=scenes.items;scenarioTotal.value=scenes.total;scenarioPage.value=scenes.pageNum;scenarioPageSize.value=scenes.pageSize;scenarioQueryError.value='';}
    if(runs&&historySerial===historyListSerial){workspace.value.runs=runs.items;historyTotal.value=runs.total;historyPage.value=runs.pageNum;historyPageSize.value=runs.pageSize;historyQueryError.value='';}
  }
  async function queryScenarios(page=1,archived=showArchived.value){
    const session=auth.generation,serial=scenarioListSerial+1;showArchived.value=archived;scenarioPage.value=page;
    try{await refreshLists('scenarios');}catch(e){if(session===auth.generation&&serial===scenarioListSerial)scenarioQueryError.value=e instanceof Error?e.message:'场景目录查询失败';}
  }
  async function queryHistory(page=1){
    const session=auth.generation,serial=historyListSerial+1;historyPage.value=page;
    try{await refreshLists('history');}catch(e){if(session===auth.generation&&serial===historyListSerial)historyQueryError.value=e instanceof Error?e.message:'运行目录查询失败';}
  }
  async function save() {
    if (!canEdit.value || locked.value || !draft.value) return false;
    if (versionId.value && !dirty.value) { notice.value = '场景没有新的修改'; return true; }
    if (formDirty.value) { error.value = '请先应用抽屉中的表单修改'; return false; }
    busy.value = true;
    const session = auth.generation, owner = scenarioId.value, originalVersion = versionId.value, input = clone(draft.value), saving = ++saveSerial;
    try {
      const payload = {scenarioId:owner,draft:input};
      const req = {...request('save',payload),...payload};
      const next = await previewService.saveDiagnosisReceipt(req);
      // GIS 保存可能跨越离页或身份变化，迟到回执不能覆盖另一场景的草稿。
      if (session !== auth.generation || !auth.can('diagnosis.scenario') || scenarioId.value !== owner || versionId.value !== originalVersion || JSON.stringify(draft.value) !== JSON.stringify(input)) return false;
      accept(next); scenarioId.value = next.entityIds[0]; versionId.value = next.entityIds[1];
      baseline.value = clone(draft.value); undoStack.value = []; redoStack.value = []; notice.value = '场景新版本已保存，历史版本保留';
      try{const detail=await previewService.getDiagnosisVersion({scenarioId:scenarioId.value!,versionId:versionId.value});if(session===auth.generation){const {scenarioArchived,...frozen}=detail;selectedDetail.value=frozen;selectedArchived.value=scenarioArchived;}await refreshLists('scenarios');}
      catch(e){if(session===auth.generation)notice.value='场景已保存，目录或详情刷新失败，请重新读取；无需重复保存';}
      return true;
    } catch (reason) { if (session === auth.generation) report(reason); return false; } finally { if (saving === saveSerial) busy.value = false; }
  }
  async function archive(id: string,archived: boolean) {
    if (!auth.can('diagnosis.scenario') || !(await allowDiscard())) return;
    if (await ask({title:archived ? '归档场景' : '恢复场景',message:'仅改变活动列表状态，场景版本和历史诊断继续保留。',saveLabel:archived ? '归档' : '恢复'}) !== 'save') return;
    busy.value = true;
    try { const payload = {scenarioId:id,archived}; accept(await previewService.archiveDiagnosisReceipt({...request('archive',payload),...payload}));if(scenarioId.value===id)selectedArchived.value=archived; try{await refreshLists('scenarios');}catch(e){notice.value='场景状态已更新，目录刷新失败，请重试读取';} }
    catch (reason) { report(reason); } finally { busy.value = false; }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    if (auth.can('diagnosis.view') && polling && running.value && !queryError.value && !busy.value) timer = setTimeout(() => void query(), DIAGNOSIS_POLL_MS);
  }
  async function query() {
    if (!auth.can('diagnosis.view') || !runId.value || queryPending || busy.value) return;
    queryPending = true; const token = generation, id = runId.value,serial=++querySerial;let retryStage=false;
    try {
      let next=await previewService.getDiagnosisProgress({id,signal:requests.signal('progress')});
      if(token!==generation||id!==runId.value)return;
      if(!view.value||view.value.run.id!==id){
        const detail=await previewService.getDiagnosisDetail({id,signal:requests.signal('run')});
        if(token!==generation||id!==runId.value)return;view.value=detail;
      }
      view.value={...view.value,...next};
      // 两段异步提交是独立 POST；读取进度和结果不会在后端偷偷启动影响分析。
      if(capabilities.value.twoStep&&next.diagnosisReady&&!next.impactReady&&!view.value.run.impactTaskId&&next.state==='RUNNING'&&auth.can('diagnosis.execute')){
        const payload={runId:id};
        const receipt=await previewService.submitDiagnosisImpactReceipt({...request('impact',payload),...payload});
        if(token!==generation||id!==runId.value)return;
        accept(receipt);
        view.value=await previewService.getDiagnosisDetail({id,signal:requests.signal('run')});
        if(token!==generation||id!==runId.value)return;
        next=await previewService.getDiagnosisProgress({id,signal:requests.signal('progress')});
        if(token!==generation||id!==runId.value)return;
        view.value={...view.value,...next};
      }
      const stage=next.impactReady?'impact':next.diagnosisReady?'diagnosis':null,key=stage?next.resultVersion+':'+stage:'';
      if(stage&&stageKey!==key){
        const result=await previewService.getDiagnosisStage({id,stage,resultVersion:next.resultVersion,signal:requests.signal('stage')});
        if(token!==generation||id!==runId.value)return;stageResult.value=result;stageKey=key;
      }
      if(next.state==='SUCCESS'&&!record.value){
        const report=await previewService.getDiagnosisReport(id);
        if(token!==generation||id!==runId.value)return;record.value=report;
      }
      queryError.value='';
      stageRetries=0;
      if(cancelAwaitingRefresh.value){cancelAwaitingRefresh.value=false;notice.value='取消状态已刷新';}
    }
    catch (reason) { if (token === generation && id === runId.value) {retryStage=reason instanceof ApiError&&Number(reason.code)===1203&&stageRetries++<2;queryError.value = retryStage?'':`查询失败，状态未确认：${reason instanceof Error ? reason.message : '请重试'}`;} }
    finally { if(serial!==querySerial)return;queryPending = false; if (retryStage&&token===generation&&polling)timer=setTimeout(()=>void query(),0);else if (token !== generation && polling && runId.value) void query(); else schedule(); }
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
    // 保留无现象的注入影响分析，但提交前必须明确其不能识别根因。
    const session = auth.generation, signature = JSON.stringify(draft.value), version = versionId.value;
    const missing = draft.value?.faults.filter(fault => !fault.symptomIds.length).length ?? 0;
    if (missing && await ask({title:'故障现象不足',message:`有 ${missing} 个故障对象未填写观察现象，无法据此识别其根因；这些对象将仅按注入标记分析影响。`,saveLabel:'继续分析影响',cancelLabel:'返回补填现象'}) !== 'save') return;
    // 确认期间身份、草稿或版本变化时，不沿用旧确认提交新输入。
    if (session !== auth.generation || signature !== JSON.stringify(draft.value) || version !== versionId.value || !canExecute.value || locked.value) return;
    if ((dirty.value || !versionId.value) && !(await save())) return;
    busy.value = true;
    try {
      // 演示能力关闭后，即使旧控件残留值也不能进入普通业务请求。
      const payload = {scenarioVersionId:versionId.value,...(demoEnabled.value ? {demo:demo.value} : {})};
      const next = await previewService.submitDiagnosisReceipt({...request('submit',payload),...payload});
      accept(next); clearSelection(); runId.value = next.objectId; draft.value = null; baseline.value = null; notice.value = '诊断已提交，网络与场景快照已冻结';try{await refreshLists('history');}catch(e){notice.value='诊断已提交，运行目录读取失败，请重试读取；无需重复提交';}
    } catch (reason) { report(reason); } finally { busy.value = false; if (runId.value) await startPolling(); }
  }
  async function cancel() {
    const id=runId.value,session=auth.generation;
    if (!auth.can('diagnosis.execute') || !running.value || cancelAwaitingRefresh.value || locked.value || await ask({title:'取消诊断',message:'取消尚未完成的诊断/影响阶段；冻结输入保留，不生成完整报告。',saveLabel:'确认取消'}) !== 'save') return;
    if(session!==auth.generation||id!==runId.value||!auth.can('diagnosis.execute'))return;
    busy.value = true;
    try { const next = await previewService.cancelDiagnosisReceipt({...request('cancel',id),runId:id});
      if(session!==auth.generation||id!==runId.value)return;
      accept(next); record.value = null;cancelAwaitingRefresh.value=true;queryError.value='';notice.value='';stopPolling();
      // 取消回执已确认；详情失败只重查状态，不再发送取消操作。
      const token=generation;
      try{const detail=await previewService.getDiagnosisDetail({id});if(session===auth.generation&&token===generation&&id===runId.value){view.value=detail;cancelAwaitingRefresh.value=false;notice.value='取消已完成，状态已刷新';}}
      catch(e){if(session===auth.generation&&token===generation&&id===runId.value)queryError.value=`状态读取失败：${e instanceof Error?e.message:'请重试'}`;}
    }
    catch (reason) { if(session===auth.generation&&id===runId.value)report(reason); } finally { if(session===auth.generation){busy.value = false; schedule();} }
  }
  async function refreshSources() {
    if(!auth.can('diagnosis.view'))return;const session=auth.generation,token=generation;
    try { const value=await previewService.loadDiagnosisSourceOptions({signal:requests.signal('options')});if(session!==auth.generation||token!==generation)return;sources.value=value;if(record.value){const id=record.value.id,next=await previewService.getDiagnosisReport(id);if(session===auth.generation&&token===generation&&record.value?.id===id)record.value=next;} }
    catch (reason) { if(session===auth.generation&&token===generation)sources.value = {plans:[],error:reason instanceof Error ? reason.message : '来源读取失败'}; }
  }
  function hydrate(loaded: DiagnosisContext) {
    capabilities.value=loaded.capabilities ?? {};contextOrigin.value=diagnosisDataOrigin(loaded.dataOrigin);
    workspace.value=loaded.revision?{revision:loaded.revision,scenarios:[],runs:[]}:null;loadError.value=loaded.error??'';
    presets.value=loaded.presets;legacy.value=loaded.legacy;sources.value=loaded.sources;symptoms.value=loaded.symptoms;legacyInterferenceIds.value=loaded.interferenceIds;
  }
  async function load() {
    if(!auth.can('diagnosis.view')||locked.value)return;loading.value=true;const session=auth.generation,serial=++loadSerial;
    try{
      const loaded=await previewService.loadDiagnosisContext({signal:requests.signal('metadata')});if(session!==auth.generation||serial!==loadSerial)return;hydrate(loaded);
      if(workspace.value)await refreshLists();
      if(session!==auth.generation||serial!==loadSerial)return;
      // 无运行时保留创建引导；内置历史仅由用户主动选择。
      if(!record.value&&!draft.value&&!runId.value&&loaded.latestRunId)runId.value=loaded.latestRunId;
    }catch(e){if(session===auth.generation)loadError.value=e instanceof Error?e.message:'诊断加载失败';}
    finally{if(serial===loadSerial)loading.value=false;if(serial===loadSerial&&session===auth.generation&&runId.value)await startPolling();}
  }
  async function reload() { if (!(await allowDiscard())) return; clearSelection(); draft.value = null; baseline.value = null; await load(); }
  async function previewImport(file: File,planId: string) {
    if (!auth.can('diagnosis.scenario') || locked.value) return; importing.value = true; importError.value = '';const session=auth.generation,serial=++importSerial;
    // 一旦开始读取新文件，旧文件的预检资格失效，失败后不能误提交旧内容。
    importPreview.value = null;
    // 文件读取和生成都跨异步边界，旧账号的数据不能进入新会话。
    try { if (file.size > DIAGNOSIS_MAX_FILE_BYTES) throw new ApiError('单文件最多 5 MiB','IMPORT_LIMIT');const bytes=new Uint8Array(await file.arrayBuffer());if(session!==auth.generation||!auth.can('diagnosis.scenario'))return;const next=await previewService.previewDiagnosisImport({name:file.name,bytes},planId);if(session===auth.generation)importPreview.value=next; }
    catch (reason) { if(session===auth.generation)importError.value=reason instanceof Error ? reason.message : '场景导入预检失败'; } finally { if(serial===importSerial)importing.value = false; }
  }
  async function commitImport() {
    if (!auth.can('diagnosis.scenario') || !importPreview.value || importPreview.value.issues.length || locked.value) return false; busy.value = true; importError.value = '';
    try { const drafts = clone(importPreview.value.drafts); accept(await previewService.importDiagnosisReceipt({...request('import',drafts),drafts})); importPreview.value = null; notice.value = '全部场景已导入，未覆盖已有场景';try{await refreshLists('scenarios');}catch(e){notice.value='场景已导入，目录刷新失败，请重试读取';} return true; }
    catch (reason) { importError.value=reason instanceof Error ? reason.message : '场景导入失败'; return false; } finally { busy.value = false; }
  }
  async function download(format: ReportFormat | 'xlsx' | 'png',filters = '') {
    if (!auth.can('diagnosis.export') || !record.value || exporting.value) return;
    const impact=format==='xlsx'||format==='png',id=record.value.id,session=auth.generation,serial=++exportSerial;
    exporting.value=true;exportTarget.value=impact?'impact':'report';
    if(impact)impactExportError.value='';else exportError.value='';
    if(notice.value==='文件已生成并发起下载')notice.value='';
    try { const file = impact ? await previewService.exportDiagnosisImpact(id,format as 'xlsx'|'png',filters) : await previewService.exportDiagnosisReport(id,format as ReportFormat); if(!(await auth.check())||session!==auth.generation||!auth.can('diagnosis.export'))return;downloadDiagnosisFile(file); notice.value = '文件已生成并发起下载'; }
    catch (reason) { if(session===auth.generation&&serial===exportSerial&&record.value?.id===id){const message=reason instanceof Error ? reason.message : '诊断文件导出失败';if(impact)impactExportError.value=message;else exportError.value=message;} } finally { if(serial===exportSerial)exporting.value = false; }
  }
  async function template(format: 'csv' | 'xlsx',planId: string) { if(!auth.can('diagnosis.scenario'))return;const session=auth.generation;importError.value='';try { if(!planId)throw new Error('请先选择导入网络');const file=await previewService.getDiagnosisTemplate(format, planId);if(await auth.check()&&session===auth.generation&&auth.can('diagnosis.scenario'))downloadDiagnosisFile(file); } catch (reason) { if(session===auth.generation)importError.value=reason instanceof Error ? reason.message : '模板下载失败'; } }
  async function reset() {
    if (!demoEnabled.value || !auth.can('diagnosis.reset') || locked.value || await ask({title:'重置诊断演示数据',message:'将清除自建场景及版本、诊断任务与结果、未保存输入和导入预览，恢复内置历史记录。资源和规划保留。此操作不可恢复。',saveLabel:'确认重置诊断'}) !== 'save') return;
    busy.value = true;
    try { await previewService.resetDiagnosisReceipt(workspace.value?.revision ?? null); const loaded=await previewService.loadDiagnosisContext({signal:requests.signal('metadata')}); clearSelection(); draft.value = null; baseline.value = null; formDirty.value = false; importPreview.value = null; undoStack.value = []; redoStack.value = []; pending = null; hydrate(loaded); if(workspace.value)await refreshLists(); error.value = ''; notice.value = '诊断演示数据已重置'; }
    catch (reason) { report(reason); } finally { busy.value = false; }
  }
  function clearForSession(){capabilities.value={};contextOrigin.value='UNKNOWN';selectedArchived.value=false;importError.value='';exportError.value='';impactExportError.value='';exportTarget.value=null;cancelAwaitingRefresh.value=false;scenarioQueryError.value='';historyQueryError.value='';requests.stop();scenarioListSerial++;historyListSerial++;detailSerial++;selectedDetail.value=null;sourceNetwork.value=null;stageResult.value=null;stageKey='';scenarioPage.value=1;scenarioPageSize.value=20;historyPage.value=1;historyPageSize.value=20;scenarioTotal.value=0;historyTotal.value=0;showArchived.value=false;loadSerial++;importSerial++;exportSerial++;querySerial++;saveSerial++;queryPending=false;importing.value=false;exporting.value=false;busy.value=false;stopPolling();answer('cancel');gisHandoff.value=null;workspace.value=null;presets.value=[];legacy.value=[];sources.value={plans:[],error:null};symptoms.value=[];legacyInterferenceIds.value=[];draft.value=null;baseline.value=null;scenarioId.value=null;versionId.value='';runId.value='';view.value=null;record.value=null;undoStack.value=[];redoStack.value=[];formDirty.value=false;importPreview.value=null;demo.value='normal';loading.value=false;loadError.value='';error.value='';queryError.value='';notice.value='';issues.value=[];pending=null;}
  return { demoEnabled,dataOrigin,selectedArchived,importError,exportError,impactExportError,exportTarget,cancelAwaitingRefresh,scenarioQueryError,historyQueryError,scenarioPage,scenarioPageSize,scenarioTotal,showArchived,historyPage,historyPageSize,historyTotal,queryScenarios,queryHistory,clearForSession,workspace,presets,legacy,sources,symptoms,interferenceIds,draft,baseline,scenarioId,versionId,runId,view,record,undoStack,redoStack,formDirty,importPreview,demo,loading,busy,exporting,importing,loadError,error,queryError,notice,issues,decision,dirty,running,selectedVersion,network,canEdit,canExecute,locked,result,impactReady,availablePresets,
    ask,answer,prepareGisEditing,allowsGisTransfer,acceptGisTransfer,clearGisTransfer,discardDraft,allowDiscard,updateDraft,applyFaults,undo,redo,newScenario,switchPlan,selectVersion,copyVersion,applyPreset,save,archive,query,startPolling,stopPolling,selectRun,selectLegacy,submit,cancel,refreshSources,load,reload,previewImport,commitImport,download,template,reset };
});
