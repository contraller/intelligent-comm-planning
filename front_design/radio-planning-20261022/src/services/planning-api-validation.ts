import type { ApiPlan, ApiPlanningJob, ApiPlanningResult, ApiPlanningSolution, PlanningCatalog, PlanningApiServices, PlanningJobSummary } from '../types/planning-api';
import type { PlanningConfiguration, PlanningInput } from '../types/planning';
import { apiBool, apiChoice, apiDate, apiId, apiList, apiNullableNumber, apiNumber, apiRecord, apiText, invalidApi, readIssue, readResponseTaskInput, uniqueIds } from './task-api-validation';
import { readCoverage, readCoveragePoint } from './coverage-validation';
import { readPlanningResultDetails } from './planning-result-details-validation';
import type { PlanningAdjustment, PlanningAdjustmentExample } from '../types/planning-adjustment';
import { readPlanningAdjustment } from './planning-adjustment';
import { readFrequencyResources } from './planning-options';
import { sameValue } from './planning-validation';
import type { InterferenceOrigin } from '../types/interference';
import { planOriginLabel } from './planning-snapshot';

type ReadMethods='loadPlanningOptions'|'loadPlanningReadContext'|'getPlanningPreset'|'getPlanningAdjustmentExamples'|'getPlanningTaskProgress'|'queryPlanningPlanSummaries'|'queryPlanningReferenceSummaries'|'submitPlanningReceipt'|'cancelPlanningReceipt'|'savePlanningReceipt'|'confirmPlanningReceipt'|'resetPlanningReceipt';
// 同一出口投影用于两个适配器；HTTP 原始完整报文的瘦身仍需后端协议支持。
export function withPlanningReads(service: Omit<PlanningApiServices,ReadMethods>): PlanningApiServices {
  const receipt=(value:ApiPlan|ApiPlanningJob)=>({objectId:value.id,taskId:value.taskId,revision:value.revision,changed:true});
  return {...service,
    async loadPlanningOptions(input){const {presets,adjustmentExamples:_examples,...meta}=await service.loadPlanningCatalog(input);return {...meta,presets:presets.map(({defaults:_input,...option})=>option)};},
    async loadPlanningReadContext(input){const meta=await service.loadPlanningCatalog(input);return {revision:meta.workspaceRevision??meta.revision};},
    async getPlanningPreset(input){const found=(await service.loadPlanningCatalog(input)).presets.find(row=>row.id===input.presetId);if(!found)invalidApi('preset id');return found!;},
    async getPlanningAdjustmentExamples(input){return (await service.loadPlanningCatalog(input)).adjustmentExamples??[];},
    async getPlanningTaskProgress(input){const value=await service.getPlanningTask(input);return planningProgress(value);},
    async queryPlanningPlanSummaries(input){const page=await service.queryPlanningPlans(input);return {...page,items:page.items.map(({id,taskId,name,version,state,current,sourceChanged,savedAt})=>({id,taskId,name,version,state,current,sourceChanged,savedAt}))};},
    async queryPlanningReferenceSummaries(input){const page=await service.queryPlanningReferences(input);return {...page,items:page.items.map(row=>({id:row.id,taskId:row.taskId,name:row.name,version:row.version,state:row.state,sourceChanged:row.sourceChanged,originLabel:planOriginLabel(row)}))};},
    async submitPlanningReceipt(input){const job=await service.submitPlanningTask(input);return {...receipt(job),...(job.outcome&&job.outcome.code!==0?{referenceJob:job}:{})};},
    async cancelPlanningReceipt(input){return receipt(await service.cancelPlanningTask(input));},
    async savePlanningReceipt(input){return receipt(await service.savePlanningPlan(input));},
    async confirmPlanningReceipt(input){return receipt(await service.confirmPlanningPlan(input));},
    async resetPlanningReceipt(input){const meta=await service.resetPlanningData(input);return {objectId:'planning-workspace',revision:meta.workspaceRevision??meta.revision,changed:true};},
  };
}
export async function planningProgress(value:ApiPlanningJob){
  const {id,taskId,revision,state,progress,phases,error,expired,sourceChanged,savedPlanId}=value;
  // 调整内容用摘要核对，轮询无需重复运输整份人工参数与路由。
  const adjustmentKey=value.adjustment?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([value.parentPlanId,value.adjustment]))))).map(n=>n.toString(16).padStart(2,'0')).join(''):null;
  const resultKey=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([value.result,value.solutions]))))).map(n=>n.toString(16).padStart(2,'0')).join('');
  return {id,taskId,revision,state,progress,phases,error,expired,sourceChanged,savedPlanId,adjustmentKey,resultKey};
}

const ids = (v: unknown, field: string) => uniqueIds(apiList(v, field, x => apiId(x)), x => x, field);
const noteList = (v: unknown) => apiList(v, 'notes', x => apiText(x, 'note'));
const nullableId = (v: unknown) => v === null ? null : apiId(v);

export function readPlanningJobSummary(value: unknown): PlanningJobSummary {
  const v = apiRecord(value);
  return {
    id: apiId(v.job_id), taskId: apiId(v.task_id), name: apiText(v.name, 'name'),
    startedAt: apiDate(v.created_at, 'created_at'),
    state: apiChoice(v.status, ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'], 'status'),
  };
}

export function readSavedPlanSummary(value: unknown): import('../types/planning-api').PlanningPlanSummary {
  const v = apiRecord(value), state = apiChoice(v.state, ['SAVED', 'REFERENCE', 'CONFIRMED'], 'state');
  const current = apiBool(v.current, 'current'), sourceChanged = apiBool(v.source_changed, 'source_changed');
  if (current && (state !== 'CONFIRMED' || sourceChanged)) invalidApi('current plan state');
  return { id: apiId(v.plan_id), taskId: apiId(v.task_id), name: apiText(v.name, 'name'),
    version: apiText(v.version, 'version'), state, current, sourceChanged, savedAt: apiDate(v.saved_at, 'saved_at') };
}
// 采纳来源独立于规划作业；原样保存经过校验的干扰源快照。
function readInterferenceOrigin(value: unknown): InterferenceOrigin {
  const v = apiRecord(value);
  return { analysisId: apiId(v.analysis_id), measureId: apiId(v.measure_id), sourcePlanId: apiId(v.source_plan_id),
    scenarioId: apiChoice(v.scenario_id, ['single','multiple','enhanced','unaffected','unavailable','failed'], 'scenario_id'), variantId: apiId(v.variant_id), presetVersion: apiId(v.preset_version),
    sources: uniqueIds(apiList(v.sources, 'interference sources', raw => {
      const s = apiRecord(raw);
      return { id: apiId(s.id), name: apiText(s.name, 'source.name'), coordinate: readCoveragePoint(s.coordinate), elevationM: apiNullableNumber(s.elevationM, 'elevationM'),
        antennaHeightM: apiNumber(s.antennaHeightM, 'antennaHeightM', 0), centerFreqKhz: apiNumber(s.centerFreqKhz, 'centerFreqKhz', 0), bandwidthKhz: apiNumber(s.bandwidthKhz, 'bandwidthKhz', 0), txPowerDbm: apiNumber(s.txPowerDbm, 'txPowerDbm'),
        antennaGainDbi: apiNullableNumber(s.antennaGainDbi, 'antennaGainDbi'), interferenceType: apiText(s.interferenceType, 'interferenceType'), patternType: s.patternType === null ? null : apiText(s.patternType, 'patternType'),
        azimuthDeg: apiNullableNumber(s.azimuthDeg, 'azimuthDeg', 0, 360), dutyCycle: apiNullableNumber(s.dutyCycle, 'dutyCycle', 0, 1), active: apiBool(s.active, 'active'), origin: apiChoice(s.origin, ['SOURCE','MANUAL','IMPORT'], 'origin') };
    }), s => s.id, 'interference sources') };
}
// 原资料仅提供子接口字段；全流程的可选调整扩展在适配边界统一转换。
export function readApiPlanningAdjustment(value: unknown): PlanningAdjustment {
  const v = apiRecord(value);
  try {
    const adjustment = readPlanningAdjustment({ schemaVersion: v.schema_version, sourcePlanId: apiId(v.source_plan_id), sourceSnapshotId: apiId(v.source_snapshot_id),
      manualOverrides: apiList(v.manual_override, 'manual_override', raw => { const d = apiRecord(raw); return { deviceId: apiId(d.device_id), ...('tx_power_dbm' in d ? { txPowerDbm: d.tx_power_dbm } : {}), ...('antenna_height_m' in d ? { antennaHeightM: d.antenna_height_m } : {}) }; }),
      manualPaths: apiList(v.manual_paths, 'manual_paths', raw => { const r = apiRecord(raw); return { demandId: apiId(r.demand_id), nodePath: ids(r.node_path, 'node_path') }; }),
    });
    return adjustment;
  } catch (error) { return invalidApi('adjustment: ' + (error instanceof Error ? error.message : 'invalid')); }
}

function readAdjustmentEcho(v: Record<string, unknown>, input: PlanningInput, result: ApiPlanningResult | null): PlanningAdjustment | undefined {
  if (!('adjustment' in v)) return undefined;
  const adjustment = readApiPlanningAdjustment(v.adjustment);
  if (adjustment.sourcePlanId !== v.parent_plan_id || adjustment.sourcePlanId === v.plan_id || adjustment.sourceSnapshotId === result?.snapshotId) invalidApi('adjustment source association');
  for (const route of adjustment.manualPaths) {
    const demand = input.demands.find(d => d.id === route.demandId);
    if (!demand || route.nodePath[0] !== demand.sourceId || route.nodePath.at(-1) !== demand.targetId) invalidApi('adjustment demand association');
    if (result && route.nodePath.some(id => !result.nodes.some(n => n.id === id))) invalidApi('adjustment node association');
  }
  if (result && adjustment.manualOverrides.some(d => !result.devices.some(r => r.id === d.deviceId))) invalidApi('adjustment device association');
  return adjustment;
}

function readAdjustmentExamples(value: unknown): PlanningAdjustmentExample[] {
  return uniqueIds(apiList(value, 'adjustment_examples', raw => {
    const v = apiRecord(raw), id = apiId(v.id);
    // 示例不含父方案身份；填写时由当前选中方案绑定，并再次检查节点和需求。
    const sample = readApiPlanningAdjustment({ ...v, schema_version: 1, source_plan_id: 'catalog-example', source_snapshot_id: 'catalog-example-snapshot' });
    const input = readResponseTaskInput(v.input);
    for (const route of sample.manualPaths) {
      const demand = input.demands.find(d => d.id === route.demandId);
      if (!demand || route.nodePath[0] !== demand.sourceId || route.nodePath.at(-1) !== demand.targetId) invalidApi('adjustment example demand');
    }
    return { id, label: apiText(v.label, 'example label'), source: apiText(v.source, 'example source'), input, manualOverrides: sample.manualOverrides, manualPaths: sample.manualPaths };
  }), e => e.id, 'adjustment example ids');
}
// 规划结果和转正配置共用结构校验，配置内容只取各自的响应字段。
function readPlanningConfiguration(value: unknown): PlanningConfiguration {
  const c = apiRecord(value);
  return {
    deployment: uniqueIds(apiList(c.deployment, 'deployment', raw => { const d = apiRecord(raw); return { stationId: apiId(d.stationId), deviceIds: ids(d.deviceIds, 'deviceIds'), role: apiText(d.role, 'role'), ...(d.plannedCoordinate == null ? {} : { plannedCoordinate: readCoveragePoint(d.plannedCoordinate) }) }; }), d => d.stationId, 'deployment'),
    devices: uniqueIds(apiList(c.devices, 'configuration.devices', raw => { const d = apiRecord(raw); return { deviceId: apiId(d.deviceId), stationId: apiId(d.stationId), frequencyKhz: apiNumber(d.frequencyKhz, 'frequencyKhz', 0), txPowerDbm: apiNumber(d.txPowerDbm, 'txPowerDbm'), antennaHeightM: apiNumber(d.antennaHeightM, 'antennaHeightM', 0) }; }), d => d.deviceId, 'device configuration'),
    routes: uniqueIds(apiList(c.routes, 'routes', raw => { const r = apiRecord(raw); return { id: apiId(r.id), demandId: apiId(r.demandId), nodeIds: ids(r.nodeIds, 'nodeIds'), linkIds: ids(r.linkIds, 'linkIds'), backup: apiBool(r.backup, 'backup') }; }), r => r.id, 'routes'),
    frequencies: uniqueIds(apiList(c.frequencies, 'frequencies', raw => { const f = apiRecord(raw), minKhz = apiNumber(f.minKhz, 'minKhz', 0), maxKhz = apiNumber(f.maxKhz, 'maxKhz', minKhz); return { id: apiId(f.id), minKhz, maxKhz, allocatedKhz: apiList(f.allocatedKhz, 'allocatedKhz', x => apiNumber(x, 'allocatedKhz', minKhz, maxKhz)) }; }), f => f.id, 'frequencies'),
  };
}
function assertConfiguration(configuration: PlanningConfiguration, result: Pick<ApiPlanningResult, 'nodes' | 'devices' | 'links'>) {
  const nodeIds = new Set(result.nodes.map(n => n.id)), deviceById = new Map(result.devices.map(d => [d.id, d])), linkById = new Map(result.links.map(l => [l.id, l]));
  for (const d of configuration.deployment) if (!nodeIds.has(d.stationId) || d.deviceIds.some(id => deviceById.get(id)?.stationId !== d.stationId)) invalidApi('deployment association');
  for (const d of configuration.devices) if (deviceById.get(d.deviceId)?.stationId !== d.stationId) invalidApi('configuration association');
  for (const r of configuration.routes) {
    if (r.nodeIds.length < 2 || r.linkIds.length !== r.nodeIds.length - 1 || r.nodeIds.some(id => !nodeIds.has(id))) invalidApi('route');
    r.linkIds.forEach((id, i) => { const l = linkById.get(id), a = r.nodeIds[i], b = r.nodeIds[i + 1]; if (!l || !(l.a === a && l.b === b || l.a === b && l.b === a)) invalidApi('route/link association'); });
  }
}
export function readPlanningResult(value: unknown, input?: PlanningInput): ApiPlanningResult {
  const v = apiRecord(value), m = apiRecord(v.metrics);
  const nodes = uniqueIds(apiList(v.nodes, 'nodes', raw => { const n = apiRecord(raw); return { id: apiId(n.id), name: apiText(n.name, 'name'), coordinate: readCoveragePoint(n.coordinate), status: n.status === null ? null : apiChoice(n.status, ['NORMAL', 'FAULT', 'OFFLINE'], 'status'), alert: n.alert === null ? null : apiBool(n.alert, 'alert') }; }), n => n.id, 'nodes');
  const devices = uniqueIds(apiList(v.devices, 'devices', raw => { const d = apiRecord(raw); return {
    id: apiId(d.id), stationId: apiId(d.stationId), modelId: apiId(d.modelId), modelName: apiText(d.modelName, 'modelName'), deviceClass: apiChoice(d.deviceClass, ['HF', 'VUHF'], 'deviceClass'),
    availability: d.availability === null ? null : apiChoice(d.availability, ['ACTIVE', 'OFF_SHELF'], 'availability'),
    workFreqKhz: apiNullableNumber(d.workFreqKhz, 'workFreqKhz', 0), txPowerDbm: apiNullableNumber(d.txPowerDbm, 'txPowerDbm'), antennaHeightM: apiNullableNumber(d.antennaHeightM, 'antennaHeightM', 0), tiltDeg: apiNullableNumber(d.tiltDeg, 'tiltDeg'), azimuthDeg: apiNullableNumber(d.azimuthDeg, 'azimuthDeg', 0, 360),
  }; }), d => d.id, 'devices');
  const links = uniqueIds(apiList(v.links, 'links', raw => { const l = apiRecord(raw); return { id: apiId(l.id), a: apiId(l.a), b: apiId(l.b), deviceA: apiId(l.deviceA), deviceB: apiId(l.deviceB), state: apiChoice(l.state, ['EXCELLENT', 'GOOD', 'WARNING', 'FAULT'], 'state'), deviceClass: apiChoice(l.deviceClass, ['HF', 'VUHF'], 'deviceClass'), frequencyKhz: apiNumber(l.frequencyKhz, 'frequencyKhz', 0), backup: apiBool(l.backup, 'backup') }; }), l => l.id, 'links');
  const configuration = readPlanningConfiguration(v.configuration);
  const nodeIds = new Set(nodes.map(n => n.id)), deviceById = new Map(devices.map(d => [d.id, d]));
  if (!nodes.length || devices.some(d => !nodeIds.has(d.stationId))) invalidApi('snapshot node/device association');
  for (const l of links) if (l.a === l.b || !nodeIds.has(l.a) || !nodeIds.has(l.b) || deviceById.get(l.deviceA)?.stationId !== l.a || deviceById.get(l.deviceB)?.stationId !== l.b || deviceById.get(l.deviceA)?.deviceClass !== l.deviceClass || deviceById.get(l.deviceB)?.deviceClass !== l.deviceClass) invalidApi('link association');
  assertConfiguration(configuration, { nodes, devices, links });
  // 只校验本次响应的冻结身份；HTTP 版本不要求命中本地教学资产。
  let resultDetails: ApiPlanningResult['resultDetails'];
  if (v.result_details != null) {
    try { resultDetails = readPlanningResultDetails(v.result_details, { nodes, devices, links, configuration, demandIds: input ? input.demands.map(d => d.id) : [...new Set(configuration.routes.map(r => r.demandId))] }); }
    catch (error) { invalidApi('result_details: ' + (error instanceof Error ? error.message : 'invalid')); }
  }
  return { snapshotId: apiId(v.snapshot_id), nodes, devices, links, configuration, coverage: readCoverage(v.coverage),
    ...(resultDetails === undefined ? {} : { resultDetails }),
    metrics: { connectivityPercent: apiNullableNumber(m.connectivityPercent, 'connectivityPercent', 0, 100), totalRadiatedPowerW: apiNullableNumber(m.totalRadiatedPowerW, 'totalRadiatedPowerW', 0), survivabilityPercent: apiNullableNumber(m.survivabilityPercent, 'survivabilityPercent', 0, 100), coveragePercent: apiNullableNumber(m.coveragePercent, 'coveragePercent', 0, 100), delayMs: apiNullableNumber(m.delayMs, 'delayMs', 0) },
    deploymentCost: apiNullableNumber(v.deployment_cost, 'deployment_cost', 0), costUnit: apiText(v.cost_unit, 'cost_unit', true), notes: noteList(v.notes),
    checks: uniqueIds(apiList(v.checks, 'checks', raw => { const x = apiRecord(raw); return { id: apiChoice(x.id, ['connectivity', 'survivability', 'relay', 'frequency'], 'check id'), label: apiText(x.label, 'label'), passed: x.passed === null ? null : apiBool(x.passed, 'passed'), detail: apiText(x.detail, 'detail', true) }; }), x => x.id, 'check ids'),
  };
}
export function readOutcome(value: unknown): NonNullable<ApiPlanningJob['outcome']> {
  const v = apiRecord(value), code = apiNumber(v.code, 'outcome.code'); if (!Number.isInteger(code)) invalidApi('outcome.code');
  return { code, message: apiText(v.message, 'outcome.message'), suggestions: noteList(v.suggestions), gap: apiList(v.gap, 'gap', readIssue) };
}
function assertResultInput(result: ApiPlanningResult, input: ApiPlanningJob['input']) {
  if (input.stationIds.some(id => !result.nodes.some(n => n.id === id))) invalidApi('input nodes');
  for (const route of result.configuration.routes) {
    const demand = input.demands.find(d => d.id === route.demandId);
    if (!demand || route.nodeIds[0] !== demand.sourceId || route.nodeIds.at(-1) !== demand.targetId) invalidApi('route/demand association');
  }
  for (const d of input.demands) if (d.endpointMode === 'device' && (!result.devices.some(x => x.id === d.sourceDeviceId && x.stationId === d.sourceId) || !result.devices.some(x => x.id === d.targetDeviceId && x.stationId === d.targetId))) invalidApi('demand/device association');
}
export function readPlanningJob(value: unknown, expected: { taskId: string; jobId?: string }): ApiPlanningJob {
  const v = apiRecord(value), id = apiId(v.job_id), taskId = apiId(v.task_id), input = readResponseTaskInput(v.input);
  if (taskId !== expected.taskId || expected.jobId && id !== expected.jobId) invalidApi('job owner');
  const state = apiChoice(v.status, ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'], 'status'), progress = apiNumber(v.progress, 'progress', 0, 1);
  let solutions: ApiPlanningSolution[] | undefined, defaultSolutionId: string | null | undefined;
  if (Object.hasOwn(v, 'solutions')) {
    solutions = uniqueIds(apiList(v.solutions, 'solutions', raw => {
      const s = apiRecord(raw), result = s.result === null ? null : readPlanningResult(s.result, input);
      const expired = apiBool(s.expired, 'solution.expired'), savedPlanId = nullableId(s.saved_plan_id);
      const radioCount = s.radio_count===undefined?null:apiNullableNumber(s.radio_count, 'radio_count', 0);
      if (radioCount !== null && !Number.isSafeInteger(radioCount) || expired && (result !== null || savedPlanId !== null) || !expired && !result) invalidApi('solution availability');
      if (result) assertResultInput(result, input);
      return { solutionId: apiId(s.solution_id), label: apiText(s.label, 'solution.label'), radioCount, result, outcome: readOutcome(s.outcome), expired, savedPlanId };
    }), s => s.solutionId, 'solution ids');
    if (state !== 'SUCCESS' && solutions.length) invalidApi('solution state');
    uniqueIds(solutions.filter(s => s.result), s => s.result!.snapshotId, 'solution snapshots');
    uniqueIds(solutions.filter(s => s.savedPlanId), s => s.savedPlanId!, 'solution saved plans');
    defaultSolutionId = v.default_solution_id === undefined ? solutions[0]?.solutionId ?? null : nullableId(v.default_solution_id);
    if (solutions.length ? !solutions.some(s => s.solutionId === defaultSolutionId) : defaultSolutionId !== null) invalidApi('default solution');
  }
  const selected = solutions?.find(s => s.solutionId === defaultSolutionId);
  const result = solutions !== undefined && v.result === undefined ? selected?.result ?? null : v.result === null ? null : readPlanningResult(v.result, input);
  const outcome = v.outcome === null ? null : solutions !== undefined && v.outcome === undefined ? selected?.outcome ?? null : readOutcome(v.outcome);
  if (solutions !== undefined && !sameValue(result, selected?.result ?? null)) invalidApi('legacy/default result mismatch');
  if (result) { assertResultInput(result, input); if (state !== 'SUCCESS' || !outcome) invalidApi('result state'); }
  const adjustment = readAdjustmentEcho(v, input, result);
  if (adjustment && solutions !== undefined) invalidApi('adjustment solution collection');
  const savedPlanId = solutions !== undefined && v.saved_plan_id === undefined ? selected?.savedPlanId ?? null : nullableId(v.saved_plan_id);
  if (solutions !== undefined && savedPlanId !== (selected?.savedPlanId ?? null)) invalidApi('legacy/default saved plan mismatch');
  return { id, taskId, revision: apiId(v.revision), inputVersion: nullableId(v.input_version), conditionVersion: apiId(v.condition_version), resourceRevision: nullableId(v.resource_revision), input, parentPlanId: nullableId(v.parent_plan_id), state, progress: progress * 100,
    ...(adjustment === undefined ? {} : { adjustment }),
    ...(solutions === undefined ? {} : { solutions, defaultSolutionId }),
    phases: apiList(v.phases, 'phases', raw => { const p = apiRecord(raw); return { name: apiText(p.name, 'phase'), state: apiChoice(p.state, ['waiting', 'running', 'done'], 'phase state') }; }), result, outcome, error: v.error === null ? null : apiText(v.error, 'error'), expired: apiBool(v.expired, 'expired'), sourceChanged: apiBool(v.source_changed, 'source_changed'), savedPlanId,
  };
}
export function planPasses(result: ApiPlanningResult): boolean {
  return ['connectivity', 'survivability', 'relay', 'frequency'].every(id => result.checks.find(c => c.id === id)?.passed === true)
    && result.metrics.connectivityPercent !== null && result.metrics.survivabilityPercent !== null && result.metrics.totalRadiatedPowerW !== null;
}
export function readApiPlan(value: unknown, expected: { taskId: string; planId?: string }): ApiPlan {
  const v = apiRecord(value), id = apiId(v.plan_id), taskId = apiId(v.task_id), input = readResponseTaskInput(v.input), result = readPlanningResult(v.result, input);
  if (taskId !== expected.taskId || expected.planId && id !== expected.planId) invalidApi('plan owner'); assertResultInput(result, input);
  const state = apiChoice(v.state, ['SAVED', 'REFERENCE', 'CONFIRMED'], 'state'), current = apiBool(v.current, 'current'), sourceChanged = apiBool(v.source_changed, 'source_changed'), outcome = readOutcome(v.outcome);
  if (current && (state !== 'CONFIRMED' || sourceChanged) || state === 'CONFIRMED' && !v.confirmed_at || state !== 'REFERENCE' && (!planPasses(result) || outcome.code !== 0)) invalidApi('plan state');
  const adjustment = readAdjustmentEcho(v, input, result);
  const interferenceOrigin = v.interference_origin === undefined ? undefined : readInterferenceOrigin(v.interference_origin);
  const jobId = nullableId(v.job_id);
  if (jobId === null && !interferenceOrigin || interferenceOrigin && (jobId !== null || interferenceOrigin.sourcePlanId !== v.parent_plan_id || adjustment)) invalidApi('interference plan origin');
  let origin: Pick<ApiPlan, 'solutionId' | 'solutionLabel' | 'radioCount'> = {};
  if (Object.hasOwn(v, 'solution_id')) {
    const radioCount = v.radio_count===undefined?null:apiNullableNumber(v.radio_count, 'radio_count', 0);
    if (radioCount !== null && !Number.isSafeInteger(radioCount) || adjustment) invalidApi('saved solution origin');
    origin = { solutionId: apiId(v.solution_id), solutionLabel: apiText(v.solution_label, 'solution_label'), radioCount };
  }
  const version = apiText(v.version, 'version'), confirmedAt = v.confirmed_at === null ? null : apiDate(v.confirmed_at, 'confirmed_at');
  let confirmedConfiguration: ApiPlan['confirmedConfiguration'];
  if (v.confirmed_configuration != null) {
    const c = apiRecord(v.confirmed_configuration);
    confirmedConfiguration = { sourcePlanId: apiId(c.source_plan_id), sourcePlanVersion: apiText(c.source_plan_version, 'source_plan_version'), sourceSnapshotId: apiId(c.source_snapshot_id), confirmedAt: apiDate(c.confirmed_at, 'confirmed_configuration.confirmed_at'), configuration: readPlanningConfiguration(c.configuration) };
    if (state !== 'CONFIRMED' || confirmedConfiguration.sourcePlanId !== id || confirmedConfiguration.sourcePlanVersion !== version || confirmedConfiguration.sourceSnapshotId !== result.snapshotId || confirmedConfiguration.confirmedAt !== confirmedAt) invalidApi('confirmed configuration owner');
    assertConfiguration(confirmedConfiguration.configuration, result);
  }
  return { id, taskId, jobId, revision: apiId(v.revision), version, name: apiText(v.name, 'name'), note: apiText(v.note, 'note', true), inputVersion: nullableId(v.input_version), conditionVersion: apiId(v.condition_version), resourceRevision: nullableId(v.resource_revision), input, parentPlanId: nullableId(v.parent_plan_id), state, current, sourceChanged, savedAt: apiDate(v.saved_at, 'saved_at'), confirmedAt, source: apiText(v.source, 'source'), result, outcome, ...origin, ...(v.confirmed_configuration === undefined ? {} : { confirmedConfiguration: confirmedConfiguration ?? null }), ...(interferenceOrigin === undefined ? {} : { interferenceOrigin }), ...(adjustment === undefined ? {} : { adjustment }) };
}
export function readPlanningCatalog(presetValue: unknown, frequencyValue: unknown): PlanningCatalog {
  const p = apiRecord(presetValue), f = apiRecord(frequencyValue), revision = apiId(p.revision);
  if (f.revision !== revision) invalidApi('catalog revision');
  const frequencies = uniqueIds(apiList(f.items, 'frequencies', raw => { const x = apiRecord(raw), minKhz = apiNumber(x.min_khz, 'min_khz', 0); return { id: apiId(x.id), label: apiText(x.label, 'label'), minKhz, maxKhz: apiNumber(x.max_khz, 'max_khz', minKhz) }; }), x => x.id, 'frequency ids');
  const presets = uniqueIds(apiList(p.items, 'presets', raw => { const x = apiRecord(raw), id = apiId(x.id), defaults = readResponseTaskInput(x.defaults); if (defaults.presetId !== id || !frequencies.some(f => f.id === defaults.frequencyId)) invalidApi('preset association'); return { id, label: apiText(x.label, 'label'), description: apiText(x.description, 'description', true), defaults }; }), x => x.id, 'preset ids');
  if (!presets.length || !frequencies.length) invalidApi('catalog empty');
  let frequencyResources: PlanningCatalog['frequencyResources'];
  if (Object.hasOwn(f, 'frequency_resources')) {
    try { frequencyResources = readFrequencyResources(f.frequency_resources, true); } catch { invalidApi('frequency_resources'); }
  }
  return { revision, ...(p.workspace_revision === undefined ? {} : { workspaceRevision: apiId(p.workspace_revision) }), presets, frequencies, ...(frequencyResources === undefined ? {} : { frequencyResources }), ...('adjustment_examples' in p ? { adjustmentExamples: readAdjustmentExamples(p.adjustment_examples) } : {}) };
}
