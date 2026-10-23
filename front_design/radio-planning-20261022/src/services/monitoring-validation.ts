import type { PlanVersion } from '../types/domain';
import type { MonitoringNetwork, NetworkObservationFrame, SpectrumObservationFrame, SpectrumMonitoringSource } from '../types/monitoring';
import { assessmentOwner, selectLinkAssessment } from './link-assessment';
import type { SpectrumSource, SpectrumWorkspace } from '../types/spectrum';
import { planningPresets } from '../mocks/planning-presets';
import { monitoringPresets, type MonitoringPreset } from '../mocks/monitoring-presets';
import { spectrumObservationPresets } from '../mocks/spectrum-observation-presets';
import { assertAdoptedSnapshot } from './interference-validation';
import { inputSignature, matchesPresetCoverage, sameValue } from './planning-validation';
import { bindResultDemands } from './planning-snapshot';
import { spectrumIssues } from './spectrum-validation';
import { ApiError } from './types';
import { assertPlanningResultIdentity, normalizeResultInput, planningResultPresetId } from './planning-result-identity';
import { assertPlanningAdjustmentResult } from './planning-adjustment';

const fail = (message: string): never => { throw new ApiError(message, 'INVALID_OBSERVATION'); };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optional = (value: number | null, min = -Infinity, max = Infinity) => value === null || finite(value) && value >= min && value <= max;

// 可选解释单独反馈错误；统计、地图及原观测校验不依赖它。
export function selectMonitoringAssessment(network: MonitoringNetwork | null | undefined, frame: NetworkObservationFrame | undefined, linkId: string) {
  const link = network?.links.find(row => row.id === linkId), observed = frame?.links.find(row => row.linkId === linkId);
  const owner = network && link && observed && frame ? assessmentOwner(network.key, link, frame.observedAt, observed) : null;
  return { owner, display: selectLinkAssessment(observed?.assessment, owner) };
}

// 匹配完整网络与任务条件，不能只凭名称或 presetId 把其他网络当成已有结果。
export function monitoringPresetForPlan(plan: PlanVersion): MonitoringPreset {
  const flow = plan.workflow;
  const id = flow?.interferenceOrigin?.variantId ?? (flow ? planningResultPresetId(flow) : undefined);
  const selected = monitoringPresets.find(row => row.id === id);
  if (!flow || !selected) throw new ApiError('该网络暂无监控预设', 'NO_PRESET');
  assertPlanningResultIdentity(flow);
  if (flow.interferenceOrigin) assertAdoptedSnapshot(plan);
  else {
    const base = planningPresets.find(row => row.id === id)!;
    // 仅结果档位可独立变化，频率与其余任务条件仍须完整匹配。
    if (!base?.result || !sameValue(inputSignature(normalizeResultInput(flow.input, base.id)), inputSignature(base.input)))
      throw new ApiError('任务条件暂无监控预设', 'NO_PRESET');
    if (flow.adjustment) {
      if (flow.resultPresetId === undefined) throw new ApiError('调整网络缺少结果身份', 'INVALID_OBSERVATION');
      assertPlanningAdjustmentResult(flow.adjustment, { input: flow.input, configuration: flow.configuration, nodeIds: plan.inputSnapshot.stations.map(row => row.id) });
      if (plan.coverage !== undefined && !matchesPresetCoverage(base.id, plan.coverage))
        throw new ApiError('调整网络覆盖与结果身份不一致', 'INVALID_OBSERVATION');
    }
    const expected = bindResultDemands(base.result, flow.input, base.input);
    if (!sameValue(plan.inputSnapshot, base.baseline) || !sameValue(flow.configuration, expected.configuration) ||
        !sameValue(flow.confirmation?.configuration, flow.configuration) || !sameValue(flow.checks, expected.checks) ||
        ['links','regions','metrics','notes'].some(key => !sameValue(plan[key as 'links'], expected[key as 'links'])))
      throw new ApiError('完整网络与监控预设不匹配', 'NO_PRESET');
  }
  return selected;
}
export function spectrumMonitoringSource(source: SpectrumSource, workspace: SpectrumWorkspace): SpectrumMonitoringSource {
  const latest = workspace.checks.filter(row => row.sourceId === source.id).at(-1);
  const preset = spectrumObservationPresets.find(row => row.minKhz === source.minKhz && row.maxKhz === source.maxKhz);
  const reason = !source.enabled ? '采集源已停用' : spectrumIssues(source).length ? '请先补齐并保存采集配置'
    : !latest || latest.configRevision !== source.revision ? '当前配置尚未通过 Mock 检查'
    : latest.connection !== 'SUCCESS' || latest.validation !== 'SUCCESS' ? '最新 Mock 检查未通过'
    : !preset ? '该频段暂无预生成数据' : '';
  const { endpoint: _endpoint, ...display } = source;
  return { ...display, checkId: latest?.id ?? null, checkedAt: latest?.checkedAt ?? null,
    eligible: !reason, reason, presetId: preset?.id ?? null, frameCount: preset?.frames.length ?? 0 };
}
export function assertFrameIndex(index: number, count: number) {
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new ApiError('观测帧索引无效', 'INVALID_FRAME');
}
export function assertNetworkObservation(frame: NetworkObservationFrame, preset: MonitoringPreset) {
  if (!frame || !frame.id || !Number.isFinite(Date.parse(frame.observedAt)) || !Array.isArray(frame.devices) || !Array.isArray(frame.links))
    fail('观测帧结构或时间无效');
  const network = preset.network;
  if (frame.devices.length !== network.devices.length || new Set(frame.devices.map(row=>row.deviceId)).size !== frame.devices.length ||
      frame.links.length !== network.links.length || new Set(frame.links.map(row=>row.linkId)).size !== frame.links.length) fail('观测对象缺失或重复');
  for (const row of frame.devices) {
    if (!network.devices.some(device=>device.id===row.deviceId && device.stationId===row.stationId) ||
        !['NORMAL','FAULT','OFFLINE'].includes(row.status) || typeof row.online !== 'boolean' || typeof row.alarm !== 'boolean' ||
        row.online === (row.status === 'OFFLINE') || !optional(row.txPowerDbm) || !optional(row.frequencyKhz,0) ||
        row.violations.some(item=>!['txPowerDbm','frequencyKhz'].includes(item.field) || !item.message) ||
        row.status === 'OFFLINE' && (row.txPowerDbm !== null || row.frequencyKhz !== null)) fail('设备观测字段或归属无效');
  }
  for (const row of frame.links) {
    if (!network.links.some(link=>link.id===row.linkId) || !['EXCELLENT','GOOD','WARNING','FAULT'].includes(row.state) ||
        !optional(row.snrDb) || !optional(row.ber,0,1) || !optional(row.packetLossRate,0,1) ||
        !optional(row.delayMs,0) || !optional(row.throughputKbps,0)) fail('链路观测字段或单位无效');
  }
  for (const alert of frame.alerts) {
    if (!alert.id || !alert.message || !['WARNING','FAULT'].includes(alert.level) || !alert.deviceId && !alert.linkId ||
        alert.deviceId && !frame.devices.some(row=>row.deviceId===alert.deviceId) ||
        alert.linkId && !frame.links.some(row=>row.linkId===alert.linkId)) fail('告警对象无法关联');
  }
}
export function assertSpectrumObservation(frame: SpectrumObservationFrame, minKhz: number, maxKhz: number) {
  if (!frame || !frame.id || !Number.isFinite(Date.parse(frame.observedAt)) || !Array.isArray(frame.bins) || !frame.bins.length ||
      !optional(frame.occupancyPercent,0,100) || frame.occupancyPercent === null ||
      new Set(frame.bins.map(row=>row.id)).size !== frame.bins.length) fail('频谱观测结构无效');
  let boundary = minKhz;
  for (const row of frame.bins) {
    if (!row.id || row.minKhz !== boundary || !finite(row.maxKhz) || row.maxKhz <= row.minKhz || row.maxKhz > maxKhz ||
        !finite(row.occupancyPercent) || row.occupancyPercent < 0 || row.occupancyPercent > 100 ||
        !finite(row.powerDbm) || typeof row.abnormal !== 'boolean' || row.abnormal && !row.reason) fail('频谱分箱、单位或异常字段无效');
    boundary = row.maxKhz;
  }
  if (boundary !== maxKhz || frame.abnormalBandCount !== frame.bins.filter(row=>row.abnormal).length) fail('频谱范围或异常数量不一致');
}
