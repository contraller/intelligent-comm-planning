// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from './random-uuid';
import { allDiagnosisPresets as diagnosisPresets, networkDiagnosisPresets, diagnosisNetworkKey } from './diagnosis-catalog';
import { diagnosisHistory } from '../mocks/diagnosis-history';
import { diagnosisInterferenceIds, diagnosisPhases, diagnosisSymptoms } from '../mocks/diagnosis-presets';
import { diagnosisPresetResult, supportsThreeWay } from '../mocks/diagnosis-result-presets';
// 仅扩大规划库可读目录，不新增诊断预生成场景。
import { planningPresets } from './planning-preset-catalog';
import type { PlanVersion, ResourcesData } from '../types/domain';
import type { ResourceMeta, ResourceStorage } from '../types/resource-edit';
import type { PlanningWorkspace } from '../types/planning';
import type { DiagnosisDraft, DiagnosisLoaded, DiagnosisMutation, DiagnosisRecord, DiagnosisRun, DiagnosisRunView, DiagnosisScenarioVersion, DiagnosisServices, DiagnosisWorkspace } from '../types/diagnosis';
import { DIAGNOSIS_MAX_IMPORT_SCENARIOS, DIAGNOSIS_PHASE_MS, DIAGNOSIS_PRESET_VERSION } from '../config/demo';
import { readPlanning } from './planning-storage';
import { checkDiagnosisRevision, emptyDiagnosisWorkspace, readDiagnosis, writeDiagnosis } from './diagnosis-storage';
import { assertDiagnosisNetwork, assertDiagnosisResult, bindDiagnosisResult, diagnosisSource, eligibleDiagnosisPlans, matchDiagnosisPreset, validateDiagnosisDraft } from './diagnosis-validation';
import { sameValue } from './planning-validation';
import { diagnosisImpactWorkbook, diagnosisTemplate, parseDiagnosisImport } from './diagnosis-files';
import { createDiagnosisExport } from '../reports/diagnosis-export';
import { diagnosisFigurePng } from '../reports/diagnosis-figure';
import { ApiError } from './types';
import { assertReading, pageItems } from './data-access';
import type { DiagnosisReceipt, DiagnosisProgress } from '../types/diagnosis';

// 时钟、存储和上游读取均可注入；查询历史不依赖源规划仍存在。
export function createDiagnosisMock(getStorage: () => ResourceStorage, getResources: () => { resources: ResourcesData; meta: ResourceMeta }, now = () => Date.now()): DiagnosisServices {
  const read = () => readDiagnosis(getStorage());
  function upstream() {
    let planning: PlanningWorkspace | null = null, meta: ResourceMeta | null = null;
    const errors: string[] = [];
    try { planning = readPlanning(getStorage(), planningPresets); } catch (e) { errors.push(e instanceof Error ? e.message : '规划读取失败'); }
    try { meta = getResources().meta; } catch (e) { errors.push(e instanceof Error ? e.message : '资源读取失败'); }
    return { planning, meta, errors };
  }
  function sources() {
    const u = upstream();
    return { plans: u.planning && u.meta ? eligibleDiagnosisPlans(u.planning, u.meta) : [], error: u.errors.length ? u.errors.join('；') : null };
  }
  function requirePlan(id: string) {
    const current = sources();
    if (current.error) throw new ApiError(current.error, 'SOURCE_UNAVAILABLE');
    const plan = current.plans.find((p) => p.id === id);
    if (!plan) throw new ApiError('请选择当前有效且已确认的规划版本', 'NETWORK_NOT_ELIGIBLE');
    assertDiagnosisNetwork(plan);
    return structuredClone(plan);
  }
  function source(plan: PlanVersion) { const u = upstream(); return diagnosisSource(plan,u.planning,u.meta); }
  function legacy() {
    return diagnosisHistory.map((record) => {
      const network = record.network;
      const state = source(network);
      const u = upstream();
      if (u.meta && (network.inputSnapshot.stations.some((s) => u.meta!.changedStationIds.includes(s.id)) || network.inputSnapshot.devices.some((d) => u.meta!.changedDeviceIds.includes(d.id)))) state.reasons.push('相关资源已变化，历史快照未修改');
      return { ...structuredClone(record), source: state };
    });
  }
  function loaded(): DiagnosisLoaded {
    let workspace: DiagnosisWorkspace | null = null, error: string | null = null;
    try { workspace = read(); } catch (e) { error = e instanceof Error ? e.message : '诊断读取失败'; }
    return { workspace, error, presets:structuredClone(diagnosisPresets), legacy:legacy(), sources:sources(), symptoms:structuredClone(diagnosisSymptoms), interferenceIds:[...diagnosisInterferenceIds] };
  }
  // 合法写操作只更新当前工作区版本，不修改冻结运行内容。
  function persist(w: DiagnosisWorkspace) { w.presetVersion = DIAGNOSIS_PRESET_VERSION; w.revision = randomUuid(); writeDiagnosis(getStorage(),w); return w; }
  function mutation(request: DiagnosisMutation, kind: string, payload: unknown) {
    if (!request.requestId?.trim()) throw new ApiError('操作标识不能为空', 'VALIDATION_ERROR');
    const w = read(), signature = JSON.stringify({kind,payload});
    const old = w.receipts.find((r) => r.requestId === request.requestId);
    if (old && old.signature !== signature) throw new ApiError('同一操作标识对应不同输入', 'IDEMPOTENCY_CONFLICT');
    if (!old) checkDiagnosisRevision(request.baseRevision,w.revision);
    return { w, old, signature };
  }
  function receipt(w: DiagnosisWorkspace, request: DiagnosisMutation, signature: string, entityIds: string[]) {
    w.receipts.push({ requestId:request.requestId,signature,entityIds });
    return persist(w);
  }
  function version(draft: DiagnosisDraft, scenarioId: string, number: number): DiagnosisScenarioVersion {
    const network = requirePlan(draft.planId);
    const issues = validateDiagnosisDraft(draft,network);
    if (issues.length) throw new ApiError('场景校验未通过',3003,issues);
    return { ...structuredClone(draft), id:randomUuid(), scenarioId, version:number, savedAt:new Date(now()).toISOString(), network };
  }
  function view(run: DiagnosisRun): DiagnosisRunView {
    const failurePhase = run.demo === 'diagnosis-failed' ? 3 : run.demo === 'impact-failed' ? 4 : null;
    const duration = DIAGNOSIS_PHASE_MS * (failurePhase ?? diagnosisPhases.length);
    const elapsed = Math.max(0,(run.cancelledAt ?? now()) - run.startedAt);
    const state = run.cancelledAt !== null ? 'CANCELLED' : elapsed >= duration ? failurePhase ? 'FAILED' : 'SUCCESS' : elapsed < 300 ? 'PENDING' : 'RUNNING';
    const resultSource = source(run.scenario.network);
    const report: DiagnosisRecord | null = state === 'SUCCESS' ? {
      id:run.id, dataOrigin:'SAMPLE', legacy:false, scenarioId:run.scenario.scenarioId, scenarioVersion:String(run.scenario.version), name:run.scenario.name, description:run.scenario.description,
      faults:structuredClone(run.scenario.faults),network:structuredClone(run.scenario.network),startedAt:new Date(run.startedAt).toISOString(),completedAt:new Date(run.startedAt+duration).toISOString(),
      diagnoseTaskId:run.diagnoseTaskId,impactTaskId:run.impactTaskId,result:structuredClone(run.result),source:resultSource,
    } : null;
    return { run:structuredClone(run), dataOrigin:'SAMPLE', state, progress:state === 'SUCCESS' ? 100 : Math.min(99,Math.floor(elapsed/(DIAGNOSIS_PHASE_MS * diagnosisPhases.length)*100)),
      phases:diagnosisPhases.map((name,i) => ({name:run.demo === 'three-way' && i === 1 ? '规则、图谱与机器学习推理' : name,state:elapsed >= (i+1)*DIAGNOSIS_PHASE_MS && !(failurePhase !== null && i >= failurePhase-1) ? 'done' : state === 'RUNNING' && elapsed >= i*DIAGNOSIS_PHASE_MS && elapsed < (i+1)*DIAGNOSIS_PHASE_MS ? 'running' : 'waiting'})),
      diagnosisReady:elapsed >= DIAGNOSIS_PHASE_MS*3 && run.demo !== 'diagnosis-failed', impactReady:elapsed >= DIAGNOSIS_PHASE_MS*4 && run.demo !== 'diagnosis-failed' && run.demo !== 'impact-failed',
      error:state === 'FAILED' ? run.demo === 'diagnosis-failed' ? 'Mock 诊断执行失败；未启动影响分析' : 'Mock 影响分析失败；诊断结论已保留，完整报告未就绪' : null, source:resultSource, report };
  }
  function getRun(w: DiagnosisWorkspace,id: string) { const run = w.runs.find((r) => r.id === id); if (!run) throw new ApiError('诊断任务不存在，请重新加载', 'DIAGNOSIS_NOT_FOUND'); return run; }
  function report(id: string) {
    const historical = legacy().find((r) => r.id === id); if (historical) return historical;
    const r = view(getRun(read(),id)).report;
    if (!r) throw new ApiError('诊断或影响分析尚未完成，完整报告未就绪', 'REPORT_NOT_READY');
    return r;
  }
  // 轮询不复制冻结网络或报告；阶段身份在该次运行内保持不变。
  function progress(run: DiagnosisRun): DiagnosisProgress {
    const failurePhase = run.demo === 'diagnosis-failed' ? 3 : run.demo === 'impact-failed' ? 4 : null;
    const elapsed = Math.max(0, (run.cancelledAt ?? now()) - run.startedAt), duration = DIAGNOSIS_PHASE_MS * (failurePhase ?? diagnosisPhases.length);
    const state = run.cancelledAt !== null ? 'CANCELLED' : elapsed >= duration ? failurePhase ? 'FAILED' : 'SUCCESS' : elapsed < 300 ? 'PENDING' : 'RUNNING';
    return { id: run.id, dataOrigin:'SAMPLE', resultVersion: run.presetVersion + ':' + run.id, state,
      progress: state === 'SUCCESS' ? 100 : Math.min(99, Math.floor(elapsed / (DIAGNOSIS_PHASE_MS * diagnosisPhases.length) * 100)),
      phases: diagnosisPhases.map((name, i) => ({ name:run.demo === 'three-way' && i === 1 ? '规则、图谱与机器学习推理' : name, state: elapsed >= (i+1)*DIAGNOSIS_PHASE_MS && !(failurePhase !== null && i >= failurePhase-1) ? 'done' : state === 'RUNNING' && elapsed >= i*DIAGNOSIS_PHASE_MS && elapsed < (i+1)*DIAGNOSIS_PHASE_MS ? 'running' : 'waiting' })),
      diagnosisReady: elapsed >= DIAGNOSIS_PHASE_MS*3 && run.demo !== 'diagnosis-failed',
      impactReady: elapsed >= DIAGNOSIS_PHASE_MS*4 && run.demo !== 'diagnosis-failed' && run.demo !== 'impact-failed',
      error: state === 'FAILED' ? run.demo === 'diagnosis-failed' ? 'Mock 诊断执行失败；未启动影响分析' : 'Mock 影响分析失败；诊断结论已保留，完整报告未就绪' : null, source: source(run.scenario.network) };
  }
  function compact(w: DiagnosisWorkspace, requestId: string): DiagnosisReceipt {
    const ids = w.receipts.find(r => r.requestId === requestId)?.entityIds ?? [];
    return { objectId: ids[0] ?? 'diagnosis-workspace', changed: true, revision: w.revision, entityIds: [...ids] };
  }
  const service: DiagnosisServices = {
    async loadDiagnosisContext(input) {
      assertReading(input); let w: DiagnosisWorkspace | null = null, error: string | null = null;
      try { w = read(); } catch(e) { error = e instanceof Error ? e.message : '诊断读取失败'; }
      // 只为已知示例服务声明演示能力，不由页面猜测传输方式。
      const networks = sources().plans;
      return { revision: w?.revision ?? null, error, dataOrigin:'SAMPLE', capabilities:{demoControls:true}, presets: diagnosisPresets.map(({id,label,networkPresetId})=>({id,label,planIds:networks.filter(plan=>diagnosisNetworkKey(plan)===networkPresetId).map(plan=>plan.id),supportsThreeWay:supportsThreeWay(id)})),
        legacy: diagnosisHistory.map(record=>({id:record.id,name:record.name,planId:record.network.id})),
        sources: await service.loadDiagnosisSourceOptions(input), symptoms: structuredClone(diagnosisSymptoms), interferenceIds: [...diagnosisInterferenceIds], latestRunId: w?.runs.at(-1)?.id ?? null };
    },
    async loadDiagnosisSourceOptions(input) {
      assertReading(input); const s=sources();
      return {error:s.error,plans:s.plans.map(plan => {
        const {id,taskId,name,version,preset,snapshotId}=plan; let unavailableReason: string | null = null;
        try { assertDiagnosisNetwork(plan); if (!networkDiagnosisPresets(plan).length) unavailableReason='该网络暂无预生成诊断结果'; }
        catch(e) { unavailableReason=e instanceof Error ? e.message : '无法核实网络支持条件'; }
        return {id,taskId,name,version,preset,snapshotId,canCreate:unavailableReason === null,unavailableReason};
      })};
    },
    async getDiagnosisSource(input) { assertReading(input); return requirePlan(input.planId); },
    async queryDiagnosisScenarios(input) {
      assertReading(input); const search=input.search?.trim().toLowerCase();
      return pageItems(read().scenarios.filter(s=>s.archived===input.archived&&(!search||s.versions.at(-1)?.name.toLowerCase().includes(search)||s.id.toLowerCase().includes(search))).slice().reverse().map(s=>({id:s.id,archived:s.archived,versions:s.versions.map(({id,scenarioId,version,name,planId,savedAt,faults})=>({id,scenarioId,version,name,planId,savedAt,faultCount:faults.length}))})), input);
    },
    async queryDiagnosisHistory(input) { assertReading(input); return pageItems(read().runs.slice().reverse().map(r=>({id:r.id,dataOrigin:'SAMPLE' as const,demo:r.demo,startedAt:r.startedAt,name:r.scenario.name,scenarioVersion:r.scenario.version})),input); },
    async getDiagnosisVersion(input) { assertReading(input); const scene=read().scenarios.find(s=>s.id===input.scenarioId),v=scene?.versions.find(v=>v.id===input.versionId); if(!v)throw new ApiError('指定的故障场景版本不存在','SCENARIO_NOT_FOUND'); return {...structuredClone(v),scenarioArchived:scene!.archived}; },
    async getDiagnosisPreset(input) { assertReading(input); const p=diagnosisPresets.find(p=>p.id===input.id); if(!p)throw new ApiError('诊断模板不存在','PRESET_NOT_FOUND'); const {result,...value}=p; return structuredClone(value); },
    async getDiagnosisProgress(input) { assertReading(input); return progress(getRun(read(),input.id)); },
    async getDiagnosisDetail(input) { assertReading(input); const r=getRun(read(),input.id), {result,...header}=r; return {...progress(r),run:structuredClone(header)}; },
    async getDiagnosisStage(input) {
      assertReading(input); const r=getRun(read(),input.id), p=progress(r);
      if(input.resultVersion!==p.resultVersion)throw new ApiError('诊断结果版本已变化','SOURCE_CHANGED');
      if(input.stage==='impact'?!p.impactReady:!p.diagnosisReady)throw new ApiError('阶段结果尚未就绪','REPORT_NOT_READY');
      const result=structuredClone(r.result);
      // 传播与其他影响数据同阶段开放，避免诊断就绪时提前泄漏后续结果。
      if(input.stage==='diagnosis') { result.nodes=[];result.links=[];result.regions=[];result.summary=null;delete result.propagationPaths; }
      return result;
    },
    async saveDiagnosisReceipt(request) { return compact(await service.saveDiagnosisScenario(request),request.requestId); },
    async archiveDiagnosisReceipt(request) { return compact(await service.archiveDiagnosisScenario(request),request.requestId); },
    async importDiagnosisReceipt(request) { return compact(await service.commitDiagnosisImport(request),request.requestId); },
    async submitDiagnosisReceipt(request) { return compact((await service.submitDiagnosis(request)).workspace,request.requestId); },
    async submitDiagnosisImpactReceipt() { throw new ApiError('旧示例由固定阶段推进，不调用真实影响提交','UNSUPPORTED_OPERATION'); },
    async submitDiagnosisFeedback() { throw new ApiError('示例答案不能直接沉淀为后端知识，请使用 HTTP 联调','UNSUPPORTED_OPERATION'); },
    async cancelDiagnosisReceipt(request) { return compact((await service.cancelDiagnosisRun(request)).workspace,request.requestId); },
    async resetDiagnosisReceipt(revision) { const next=await service.resetDiagnosisWorkspace(revision); return {objectId:'diagnosis-workspace',changed:true,revision:next.workspace!.revision,entityIds:[]}; },
    async loadDiagnosisWorkspace() { return loaded(); },
    async loadDiagnosisSources() { return sources(); },
    async validateDiagnosisScenario(draft) { return validateDiagnosisDraft(draft, requirePlan(draft.planId)); },
    async saveDiagnosisScenario(request) {
      const {w,old,signature} = mutation(request,'save',{scenarioId:request.scenarioId,draft:request.draft}); if (old) return w;
      let scenario = request.scenarioId ? w.scenarios.find((s) => s.id === request.scenarioId) : undefined;
      if (request.scenarioId && !scenario) throw new ApiError('场景不存在','SCENARIO_NOT_FOUND');
      if (scenario?.archived) throw new ApiError('请先恢复归档场景','SCENARIO_ARCHIVED');
      if (!scenario) { scenario = {id:randomUuid(),archived:false,versions:[]}; w.scenarios.push(scenario); }
      const next = version(request.draft,scenario.id,scenario.versions.length+1); scenario.versions.push(next);
      return receipt(w,request,signature,[scenario.id,next.id]);
    },
    async archiveDiagnosisScenario(request) {
      const {w,old,signature} = mutation(request,'archive',{id:request.scenarioId,archived:request.archived}); if (old) return w;
      const scene = w.scenarios.find((s) => s.id === request.scenarioId); if (!scene) throw new ApiError('场景不存在','SCENARIO_NOT_FOUND');
      scene.archived = request.archived; return receipt(w,request,signature,[scene.id]);
    },
    async getDiagnosisTemplate(format, planId) { return diagnosisTemplate(format, planId ? networkDiagnosisPresets(requirePlan(planId)) : diagnosisPresets); },
    async previewDiagnosisImport(file,planId) { return parseDiagnosisImport(file,requirePlan(planId),diagnosisPresets); },
    async commitDiagnosisImport(request) {
      const {w,old,signature} = mutation(request,'import',request.drafts); if (old) return w;
      if (!request.drafts.length || request.drafts.length > DIAGNOSIS_MAX_IMPORT_SCENARIOS || new Set(request.drafts.map((d) => d.planId)).size !== 1) throw new ApiError('每批需为同一网络的 1–20 个场景','IMPORT_LIMIT');
      const scenes = request.drafts.map((draft) => { const id = randomUuid(); return {id,archived:false,versions:[version(draft,id,1)]}; });
      w.scenarios.push(...scenes); return receipt(w,request,signature,scenes.map((s) => s.id));
    },
    async submitDiagnosis(request) {
      // 归一后保留原 normal 请求签名，重试旧回执不创建新运行。
      const demo = request.demo === undefined ? 'normal' : request.demo;
      const {w,old,signature} = mutation(request,'submit',{version:request.scenarioVersionId,demo});
      if (old) return { workspace:w,view:view(getRun(w,old.entityIds[0])) };
      if (!['normal','three-way','low-confidence','diagnosis-failed','impact-failed'].includes(demo)) throw new ApiError('诊断演示分支无效','VALIDATION_ERROR');
      if (w.runs.some((r) => ['PENDING','RUNNING'].includes(view(r).state))) throw new ApiError('已有诊断正在运行，请等待或取消','DIAGNOSIS_RUNNING');
      const scene = w.scenarios.find((s) => s.versions.some((v) => v.id === request.scenarioVersionId));
      const v = scene?.versions.find((v) => v.id === request.scenarioVersionId);
      if (!v || scene?.archived) throw new ApiError('场景版本不存在或已归档','SCENARIO_NOT_FOUND');
      const network = requirePlan(v.planId);
      if (!sameValue(network, v.network)) throw new ApiError('场景所绑定的确认快照已变化，请复制为新场景','SOURCE_CHANGED');
      const preset = matchDiagnosisPreset(v,network,diagnosisPresets);
      const result = bindDiagnosisResult(diagnosisPresetResult(preset,DIAGNOSIS_PRESET_VERSION,demo),v,network);
      assertDiagnosisResult(result,network,v.faults);
      const run: DiagnosisRun = {id:randomUuid(),diagnoseTaskId:randomUuid(),impactTaskId:randomUuid(),scenario:structuredClone(v),presetId:preset.id,presetVersion:DIAGNOSIS_PRESET_VERSION,demo,startedAt:now(),cancelledAt:null,result};
      w.runs.push(run); const nextView = view(run);
      return {workspace:receipt(w,request,signature,[run.id]),view:nextView};
    },
    async getDiagnosisRun(id) { return view(getRun(read(),id)); },
    async cancelDiagnosisRun(request) {
      const {w,old,signature} = mutation(request,'cancel',request.runId); const run = getRun(w,request.runId);
      if (old) return {workspace:w,view:view(run)};
      if (!['PENDING','RUNNING'].includes(view(run).state)) throw new ApiError('任务已结束，不能取消','DIAGNOSIS_TERMINAL');
      run.cancelledAt = now(); const nextView = view(run); return {workspace:receipt(w,request,signature,[run.id]),view:nextView};
    },
    async getDiagnosisReport(id) { return report(id); },
    async exportDiagnosisReport(id,format) { return createDiagnosisExport(report(id),format); },
    async exportDiagnosisImpact(id,format,filters) {
      const record = report(id);
      if (format === 'xlsx') return diagnosisImpactWorkbook(record,filters);
      return {name:`${record.name}-影响示意.png`,mime:'image/png',bytes:await diagnosisFigurePng(record)};
    },
    async resetDiagnosisWorkspace(revision) {
      try { const w = read(); checkDiagnosisRevision(revision ?? 'initial',w.revision); }
      catch (e) { if (!(e instanceof ApiError) || !['DIAGNOSIS_CORRUPT','DIAGNOSIS_INCOMPATIBLE'].includes(String(e.code))) throw e; }
      persist(emptyDiagnosisWorkspace()); return loaded();
    },
  };
  return service;
}
