// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from './random-uuid';
import type { PlanVersion, ResourcesData } from '../types/domain';
import type { ResourceMeta, ResourceStorage } from '../types/resource-edit';
import type { PlanningWorkspace } from '../types/planning';
import type { InterferenceRun, InterferenceRunView, InterferenceServices, InterferenceSources } from '../types/interference';
import { INTERFERENCE_PHASE_MS, INTERFERENCE_PRESET_VERSION } from '../config/demo';
// 仅保证新旧规划记录共存可读，干扰匹配范围保持。
import { planningPresets } from './planning-preset-catalog';
import { interferencePhases, interferenceScenarios, interferenceVariants } from '../mocks/interference-presets';
import { analysisEligibility, interferenceSourceState, validateInterferenceSubmit, variantResult } from './interference-validation';
import { checkPlanningRevision, readPlanning, writePlanning } from './planning-storage';
import { dependenciesChanged, sameValue } from './planning-validation';
import { taskSourceChanged } from './task-validation';
import { resourceIdValid } from './resource-validation';
import { ApiError } from './types';
import { getVariantResultDetails } from './planning-result-details-mock';
import { planningResultPresetId } from './planning-result-identity';
import { assertReading, pageItems } from './data-access';

// 全部写操作复用规划记录；分析、回执和方案不会出现分键半成功。
export function createInterferenceMock(
  getStorage: () => ResourceStorage,
  getResources: () => { resources: ResourcesData; meta: ResourceMeta },
  now = () => Date.now(),
): InterferenceServices {
  const read = () => markSources(readPlanning(getStorage(), planningPresets));
  const duration = INTERFERENCE_PHASE_MS * interferencePhases.length;
  function metaOrNull() { try { return getResources().meta; } catch { return null; } }
  function sourceList(workspace: PlanningWorkspace): InterferenceSources {
    try {
      const { resources, meta } = getResources();
      return {
        plans: workspace.plans.map(plan => ({ plan: structuredClone(plan), ...analysisEligibility(plan, workspace, meta) })),
        sources: structuredClone(resources.interferences ?? []), resourceRevision: meta.revision, error: null,
      };
    } catch (error) {
      return { plans: [], sources: [], resourceRevision: null, error: error instanceof Error ? error.message : '无法读取已保存资源' };
    }
  }
  function runById(workspace: PlanningWorkspace, id: string) {
    const run = workspace.interference.runs.find(row => row.analysisId === id);
    if (!run) throw new ApiError('分析记录不存在，请重新加载', 'ANALYSIS_NOT_FOUND');
    return run;
  }
  function view(run: InterferenceRun, workspace: PlanningWorkspace, measureId?: string): InterferenceRunView {
    const elapsed = Math.max(0, (run.cancelledAt ?? now()) - run.startedAt);
    const state = run.cancelledAt !== null ? 'CANCELLED' : elapsed >= duration
      ? run.scenarioId === 'failed' ? 'FAILED' : 'SUCCESS' : elapsed < 300 ? 'PENDING' : 'RUNNING';
    return {
      run: structuredClone(run), state, progress: Math.min(100, Math.floor(elapsed / duration * 100)),
      phase: state === 'CANCELLED' ? '已取消' : state === 'FAILED' ? '执行失败' : state === 'SUCCESS' ? '分析完成'
        : interferencePhases[Math.min(interferencePhases.length - 1, Math.floor(elapsed / INTERFERENCE_PHASE_MS))],
      result: state === 'SUCCESS' ? structuredClone(run.result) : null,
      // 仅服务出口读取预设；历史记录保持原样，返回对象与预设及持久化隔离。
      measurePreviews: state === 'SUCCESS' ? run.result.measures.filter(measure=>!measureId||measure.id===measureId).map(measure => {
        if (measure.unavailableReason || !measure.variantId)
          return { measureId: measure.id, result: null, unavailableReason: measure.unavailableReason ?? '未提供完整措施预览' };
        try {
          const result = variantResult(measure.variantId, run.network.workflow!.input, planningResultPresetId(run.network.workflow!));
          const details = run.measureResultDetails?.find(row => row.measureId === measure.id)?.resultDetails;
          // 只读取提交时冻结的措施明细；旧分析不从当前目录回填。
          if (details !== undefined) result.resultDetails = structuredClone(details);
          return { measureId: measure.id, result: structuredClone(result), unavailableReason: null };
        } catch (error) {
          return { measureId: measure.id, result: null, unavailableReason: error instanceof Error ? error.message : '未提供完整措施预览' };
        }
      }) : [],
      error: state === 'FAILED' ? '教学场景模拟分析执行失败，可保留输入重新提交' : null,
      source: interferenceSourceState(run, workspace, metaOrNull()),
      adoptions: [...new Map(workspace.interference.receipts.filter(row => row.analysisId === run.analysisId)
        .map(row => [row.measureId, { measureId: row.measureId, planId: row.planId }])).values()],
    };
  }
  function markSources(workspace: PlanningWorkspace) {
    const meta = metaOrNull();
    if (meta) for (const plan of workspace.plans) {
      const flow = plan.workflow!;
      plan.sourceChanged = dependenciesChanged(flow.dependencies, meta) ||
        taskSourceChanged(plan.taskId, flow.input, meta, flow.dependencies.task?.conditionVersion);
    }
    return workspace;
  }
  function persist(workspace: PlanningWorkspace) {
    markSources(workspace);
    workspace.revision = randomUuid();
    writePlanning(getStorage(), workspace, planningPresets);
    return workspace;
  }
  const service:InterferenceServices = {
    async loadInterferenceContext(input){
      assertReading(input);const workspace=read(),sources=sourceList(workspace);
      return {revision:workspace.revision,sources:{...sources,plans:sources.plans.map(({plan,...entry})=>({...entry,plan:{id:plan.id,taskId:plan.taskId,name:plan.name,version:plan.version,state:plan.state,sourceChanged:plan.sourceChanged}}))},
        scenarios:interferenceScenarios.map(({sources:_sources,...row})=>row),latestId:workspace.interference.runs.at(-1)?.analysisId??null,
        activeIds:workspace.interference.runs.filter(run=>run.cancelledAt===null&&now()-run.startedAt<duration).map(run=>run.analysisId),total:workspace.interference.runs.length};
    },
    async queryInterferenceHistory(input){
      assertReading(input);const workspace=read();
      const rows=workspace.interference.runs.filter(run=>!input.search||`${run.analysisId} ${run.network.name}`.includes(input.search)).slice().reverse().map(run=>{
        const elapsed=Math.max(0,(run.cancelledAt??now())-run.startedAt);
        const state=run.cancelledAt!==null?'CANCELLED' as const:elapsed>=duration?(run.scenarioId==='failed'?'FAILED' as const:'SUCCESS' as const):elapsed<300?'PENDING' as const:'RUNNING' as const;
        return {id:run.analysisId,taskId:run.network.taskId,name:run.network.name,version:run.network.version,startedAt:run.startedAt,state,source:interferenceSourceState(run,workspace,metaOrNull()),sourceIds:run.sources.map(row=>row.id),adoptionCount:new Set(workspace.interference.receipts.filter(row=>row.analysisId===run.analysisId).map(row=>row.measureId)).size};
      });return pageItems(rows,input);
    },
    async getInterferenceProgress(input){
      assertReading(input);const workspace=read(),run=runById(workspace,input.analysisId),elapsed=Math.max(0,(run.cancelledAt??now())-run.startedAt);
      const state=run.cancelledAt!==null?'CANCELLED' as const:elapsed>=duration?(run.scenarioId==='failed'?'FAILED' as const:'SUCCESS' as const):elapsed<300?'PENDING' as const:'RUNNING' as const;
      return {analysisId:run.analysisId,revision:workspace.revision,state,progress:Math.min(100,Math.floor(elapsed/duration*100)),phase:state==='SUCCESS'?'分析完成':state==='FAILED'?'执行失败':state==='CANCELLED'?'已取消':interferencePhases[Math.min(interferencePhases.length-1,Math.floor(elapsed/INTERFERENCE_PHASE_MS))],error:state==='FAILED'?'教学场景模拟分析执行失败，可保留输入重新提交':null,source:interferenceSourceState(run,workspace,metaOrNull()),adoptions:workspace.interference.receipts.filter(row=>row.analysisId===run.analysisId).map(row=>({measureId:row.measureId,planId:row.planId}))};
    },
    async getInterferenceDetail(input){
      const progress=await service.getInterferenceProgress(input),workspace=read();
      const {result,measureResultDetails:_details,...run}=structuredClone(runById(workspace,input.analysisId));
      // 所选冻结输入独立读取；结果中不运输各措施的完整后态和规划预览。
      return {...progress,run,result:progress.state==='SUCCESS'?{...result,measures:result.measures.map(row=>({...row,after:null}))}:null};
    },
    async getInterferenceMeasurePreview(input){
      assertReading(input);const workspace=read(),value=view(runById(workspace,input.analysisId),workspace,input.measureId);
      const preview=value.measurePreviews?.find(row=>row.measureId===input.measureId);
      if(!preview)throw new ApiError('措施预览尚未就绪','MEASURE_NOT_READY');
      return {...preview,impact:value.result?.measures.find(row=>row.id===input.measureId)?.after??null};
    },
    async submitInterferenceReceipt(request){const value=await service.submitInterferenceAnalysis(request);return {objectId:value.view.run.analysisId,revision:value.workspace.revision,changed:true};},
    async cancelInterferenceReceipt(request){const value=await service.cancelInterferenceAnalysis(request);return {objectId:request.analysisId,revision:value.workspace.revision,changed:true};},
    async adoptInterferenceReceipt(request){const value=await service.adoptInterferenceMeasure(request);return {objectId:value.plan.id,planId:value.plan.id,taskId:value.plan.taskId,version:value.plan.version,revision:value.workspace.revision,changed:value.changed};},
    async loadInterferenceWorkspace() {
      const workspace = read();
      return { workspace, sources: sourceList(workspace), scenarios: structuredClone(interferenceScenarios),
        views: workspace.interference.runs.map(run => view(run, workspace)) };
    },
    async loadInterferenceSources() { return sourceList(read()); },
    async submitInterferenceAnalysis(request) {
      const workspace = read();
      const previous = workspace.interference.runs.find(row => row.requestId === request.requestId);
      if (previous) {
        if (previous.network.id !== request.planId || previous.scenarioId !== request.scenarioId ||
            !sameValue(previous.sources.map(row => row.id).sort(), [...request.interferenceIds].sort()))
          throw new ApiError('提交标识对应不同输入', 'IDEMPOTENCY_CONFLICT');
        return { workspace, view: view(previous, workspace) };
      }
      checkPlanningRevision(request.baseRevision, workspace.revision);
      const current = getResources();
      if (request.baseResourceRevision !== current.meta.revision)
        throw new ApiError('已保存资源已变化，请刷新选择后再提交', 'RESOURCE_CONFLICT');
      if (workspace.interference.runs.some(run => ['PENDING', 'RUNNING'].includes(view(run, workspace).state)))
        throw new ApiError('已有干扰分析运行中', 'ANALYSIS_RUNNING');
      const network = workspace.plans.find(plan => plan.id === request.planId);
      if (!network) throw new ApiError('源方案不存在', 'PLAN_NOT_FOUND');
      const eligibility = analysisEligibility(network, workspace, current.meta);
      if (!eligibility.eligible) throw new ApiError(eligibility.reason, 'SOURCE_CHANGED');
      const sources = (current.resources.interferences ?? []).filter(row => request.interferenceIds.includes(row.id));
      const result = validateInterferenceSubmit(request, network, sources);
      const run: InterferenceRun = {
        jobId: randomUuid(), analysisId: randomUuid(), requestId: request.requestId,
        presetVersion: INTERFERENCE_PRESET_VERSION, scenarioId: request.scenarioId,
        network: structuredClone(network), sources: structuredClone(sources),
        dependencies: { ...structuredClone(network.workflow!.dependencies), interferenceVersion: current.meta.interferenceVersion ?? 'initial' },
        startedAt: now(), cancelledAt: null, result,
        measureResultDetails: result.measures.filter(measure => request.scenarioId !== 'failed' && measure.variantId && !measure.unavailableReason)
          .map(measure => ({ measureId: measure.id, resultDetails: getVariantResultDetails(measure.variantId!, network.workflow!.input) })),
      };
      workspace.interference.runs.push(run);
      return { workspace: persist(workspace), view: view(run, workspace) };
    },
    async getInterferenceAnalysis(analysisId) {
      const workspace = read();
      return view(runById(workspace, analysisId), workspace);
    },
    async cancelInterferenceAnalysis(request) {
      const workspace = read(), run = runById(workspace, request.analysisId);
      if (run.cancelledAt !== null) return { workspace, view: view(run, workspace) };
      checkPlanningRevision(request.baseRevision, workspace.revision);
      if (!['PENDING', 'RUNNING'].includes(view(run, workspace).state))
        throw new ApiError('分析已结束，不能取消', 'TERMINAL_JOB');
      run.cancelledAt = now();
      return { workspace: persist(workspace), view: view(run, workspace) };
    },
    async adoptInterferenceMeasure(request) {
      if (!resourceIdValid(request.requestId)) throw new ApiError('操作标识无效', 'VALIDATION_ERROR');
      const workspace = read();
      const receipt = workspace.interference.receipts.find(row => row.requestId === request.requestId);
      if (receipt && (receipt.analysisId !== request.analysisId || receipt.measureId !== request.measureId))
        throw new ApiError('采纳标识对应不同措施', 'IDEMPOTENCY_CONFLICT');
      const previous = receipt ?? workspace.interference.receipts.find(row =>
        row.analysisId === request.analysisId && row.measureId === request.measureId);
      if (previous) {
        // 新标识重试同一措施也留回执，避免该标识以后被用于其他内容。
        if (!receipt) {
          checkPlanningRevision(request.baseRevision, workspace.revision);
          workspace.interference.receipts.push({ ...previous, requestId: request.requestId });
          persist(workspace);
        }
        return { workspace, plan: workspace.plans.find(plan => plan.id === previous.planId)!, changed: false };
      }
      checkPlanningRevision(request.baseRevision, workspace.revision);
      const run = runById(workspace, request.analysisId), current = view(run, workspace);
      if (current.state !== 'SUCCESS' || !current.result) throw new ApiError('分析未成功完成', 'NO_RESULT');
      if (current.source.state !== 'CURRENT') throw new ApiError('分析来源已变化或无法核实，请重新分析', 'SOURCE_CHANGED');
      const measure = current.result.measures.find(row => row.id === request.measureId);
      if (!measure?.variantId || measure.unavailableReason)
        throw new ApiError(measure?.unavailableReason ?? '措施不存在', 'MEASURE_UNAVAILABLE');
      const flow = run.network.workflow!, result = variantResult(measure.variantId, flow.input, planningResultPresetId(flow));
      // 采纳与预览共享 Run 明细，不重新选择当前最新资产。
      const resultDetails = run.measureResultDetails?.find(row => row.measureId === measure.id)?.resultDetails;
      const plan: PlanVersion = {
        id: randomUuid(), jobId: null, snapshotId: randomUuid(), taskId: run.network.taskId,
        version: 'V' + (workspace.plans.filter(row => row.taskId === run.network.taskId).length + 1),
        name: (run.network.name + ' · ' + measure.title).slice(0, 60),
        preset: interferenceVariants.find(row => row.id === measure.variantId)!.label,
        state: 'SAVED', sourceChanged: false, stationIds: [...run.network.stationIds],
        inputSnapshot: result.inputSnapshot, links: result.links, regions: result.regions,
        metrics: result.metrics, notes: result.notes,
        ...(resultDetails === undefined ? {} : { resultDetails: structuredClone(resultDetails) }),
        workflow: {
          // 继承已验证的规划结果基线，直接操作来源仍是本次措施采纳。
          ...(flow.resultPresetId === undefined ? {} : { resultPresetId: flow.resultPresetId }),
          input: structuredClone(flow.input), inputVersion: flow.inputVersion, dependencies: structuredClone(run.dependencies),
          presetVersion: flow.presetVersion, saveRequestId: request.requestId, savedAt: new Date(now()).toISOString(),
          parentPlanVersionId: run.network.id, changeSummary: '采纳单项抗干扰措施：' + measure.title,
          note: '预生成配置，确认后才切换本任务当前网络。', checks: result.checks,
          deploymentCost: result.deploymentCost, costUnit: result.costUnit, configuration: result.configuration,
          outcome: { code: 0, message: '抗干扰预生成方案可确认', suggestions: [], gap: [] }, confirmation: null,
          interferenceOrigin: {
            analysisId: run.analysisId, measureId: measure.id, sourcePlanId: run.network.id,
            scenarioId: run.scenarioId, variantId: measure.variantId, presetVersion: run.presetVersion,
            sources: structuredClone(run.sources),
          },
        },
      };
      workspace.plans.push(plan);
      workspace.interference.receipts.push({ requestId: request.requestId, analysisId: request.analysisId, measureId: request.measureId, planId: plan.id });
      return { workspace: persist(workspace), plan, changed: true };
    },
  };
  return service;
}
