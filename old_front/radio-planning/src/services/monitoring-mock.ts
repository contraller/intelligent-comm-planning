import type { MonitoringContext, MonitoringServices, MonitoringNetwork } from '../types/monitoring';
import type { ResourcesData } from '../types/domain';
import type { ResourceMeta, ResourceStorage } from '../types/resource-edit';
import { monitoringPresets } from '../mocks/monitoring-presets';
import { spectrumObservationPresets } from '../mocks/spectrum-observation-presets';
// 新作业不应阻断旧网络读取；观测仍使用原有限预设。
import { planningPresets } from './planning-preset-catalog';
import { MONITORING_PRESET_VERSION } from '../config/demo';
import { readPlanning } from './planning-storage';
import { readSpectrum } from './spectrum-storage';
import { readSystem } from './system-storage';
import { checksPass, dependenciesChanged } from './planning-validation';
import { latestTask, taskSourceChanged } from './task-validation';
import { monitoringPresetForPlan, spectrumMonitoringSource, assertFrameIndex, assertNetworkObservation, assertSpectrumObservation } from './monitoring-validation';
import { ApiError } from './types';
import { planningResultPresetId } from './planning-result-identity';
import { withMonitoringAssessments } from './link-assessment-mock';

// 该工厂只读取现有工作区；帧游标属于当前标签页，不写采集记录或模拟业务事务。
export function createMonitoringMock(
  getStorage: () => ResourceStorage,
  readResource: () => { resources: ResourcesData; meta: ResourceMeta },
): MonitoringServices {
  async function loadMonitoringContext(taskId: string | null): Promise<MonitoringContext> {
    const context: MonitoringContext = { taskId, network: null, source: {state:'CURRENT',reasons:[]},
      intervalSeconds:null,frameCount:0,message:'',errorCode:null };
    try {
      if (taskId !== null && (typeof taskId !== 'string' || !taskId)) throw new ApiError('任务 ID 无效','VALIDATION_ERROR');
      const storage = getStorage(), system = readSystem(storage);
      context.intervalSeconds = system.parameters.find(row=>row.id==='PAR-01')!.value as number;
      const { meta } = readResource(), workspace = readPlanning(storage,planningPresets);
      if (taskId && (!meta.taskWorkspace || !latestTask(meta.taskWorkspace,taskId)))
        throw new ApiError('所选任务不存在，不能替换成内置演示','TASK_NOT_FOUND');
      const confirmedId = taskId ? workspace.currentConfirmedByTask[taskId] : undefined;
      if (!confirmedId) {
        const preset = monitoringPresets.find(row=>row.id==='balanced')!;
        context.network = { ...structuredClone(preset.network), key:'demo:'+MONITORING_PRESET_VERSION+':'+(taskId??'none') };
        context.frameCount = preset.frames.length;
        context.message = '内置三站演示网络，与当前任务和资源修改无关；未下发设备配置';
        return context;
      }
      const plan = workspace.plans.find(row=>row.id===confirmedId);
      if (!plan?.workflow?.confirmation || plan.state !== 'CONFIRMED') throw new ApiError('确认网络无法核实','INVALID_CONFIRMED_NETWORK');
      const flow = plan.workflow;
      const network: MonitoringNetwork = { key:plan.id+':'+flow.confirmation!.requestId,
        kind:'PLAN',taskId:plan.taskId,planId:plan.id,version:plan.version,name:plan.name,
        // 独立调整保留原任务条件，观测必须取调整后的完整结果身份。
        presetId:flow.interferenceOrigin?.variantId??planningResultPresetId(flow),
        stations:structuredClone(plan.inputSnapshot.stations),devices:structuredClone(plan.inputSnapshot.devices),
        links:structuredClone(plan.links),configuration:structuredClone(flow.configuration) };
      context.network = network;
      if (dependenciesChanged(flow.dependencies,meta) || taskSourceChanged(plan.taskId,flow.input,meta,flow.dependencies.task?.conditionVersion)) {
        context.source = {state:'HISTORICAL',reasons:['任务、资源或干扰源依赖已改变，需确认新的有效方案']};
        context.message = '历史监控快照';context.errorCode='MONITORING_HISTORICAL';return context;
      }
      if (!checksPass(flow.checks) || flow.outcome.code !== 0) throw new ApiError('方案约束未通过','INVALID_CONFIRMED_NETWORK');
      const preset = monitoringPresetForPlan(plan);
      context.frameCount = preset.frames.length;
      context.message = '当前确认网络 · 独立预生成监控观测';
      return context;
    } catch (reason) {
      context.errorCode = reason instanceof ApiError ? String(reason.code) : 'MONITORING_READ_FAILED';
      context.message = reason instanceof Error ? reason.message : '监控来源读取失败';
      // 无预设是明确业务分支；损坏或读取失败不能回退演示网络。
      context.source = {state:context.errorCode==='NO_PRESET'?'CURRENT':'UNKNOWN',reasons:[context.message]};
      return context;
    }
  }
  async function loadSpectrumMonitoringContext() {
    const workspace = readSpectrum(getStorage());
    return { revision:workspace.revision,sources:workspace.sources.map(source=>spectrumMonitoringSource(source,workspace)),
      source:{state:'CURRENT' as const,reasons:[]} };
  }
  return {
    loadMonitoringContext,
    async getMonitoringFrame(request) {
      const context = await loadMonitoringContext(request.taskId);
      if (context.network && context.network.key !== request.networkKey)
        throw new ApiError('当前确认网络已切换，请刷新监控来源','MONITORING_SOURCE_CHANGED',context);
      if (!context.network || context.source.state !== 'CURRENT' || context.errorCode)
        throw new ApiError(context.message || '确认网络已切换，请重新读取',context.errorCode??'MONITORING_SOURCE_CHANGED',context);
      const preset = monitoringPresets.find(row=>row.id===context.network!.presetId)!;
      assertFrameIndex(request.index,preset.frames.length);
      const frame = structuredClone(preset.frames[request.index]);
      assertNetworkObservation(frame,preset);
      frame.id = context.network.key+'/'+frame.id;
      // 最终网络身份确定后附加说明，旧观测资产和等级均保持原值。
      return {context,index:request.index,frame:withMonitoringAssessments(context.network,frame,request.index)};
    },
    loadSpectrumMonitoringContext,
    async getSpectrumObservationFrame(request) {
      const context = await loadSpectrumMonitoringContext(), source = context.sources.find(row=>row.id===request.sourceId);
      if (!source || !source.eligible || source.revision !== request.configRevision)
        throw new ApiError(source?.reason || '采集源配置已变化，需重新读取','SPECTRUM_SOURCE_CHANGED',context);
      const preset = spectrumObservationPresets.find(row=>row.id===source.presetId)!;
      assertFrameIndex(request.index,preset.frames.length);
      const frame = structuredClone(preset.frames[request.index]);
      assertSpectrumObservation(frame,preset.minKhz,preset.maxKhz);
      frame.id = source.id+':'+source.revision+'/'+frame.id;
      return {source,index:request.index,frame};
    },
  };
}
