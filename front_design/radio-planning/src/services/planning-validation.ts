import { TASK_MAX_DEMANDS } from '../config/demo';
import legacyCoverageCatalog from '../mocks/planning-coverage.json';
import coverageCatalog from '../mocks/planning-coverage-v2.json';
import { readCoverage } from './coverage-validation';
import { assertPlanningResultDetails } from './planning-result-details-validation';
import { resourceIdValid } from './resource-validation';
import { taskSourceChanged } from './task-validation';
import type { PlanVersion, ResourcesData } from '../types/domain';
import type {
  PlanningInput,
  PlanningIssue,
  PlanningJob,
  PlanningPreset,
  PlanningResult,
  ResourceDependencies,
} from '../types/planning';
import type { ResourceMeta } from '../types/resource-edit';
import { ApiError } from './types';
import { initialResources, onShelf } from '../mocks/resource-presets';
import { deploymentConstraintIssues, deploymentSignature } from './deployment-constraints';
import { coveragePresetId } from './planning-preset-catalog';
import { planningOptionIssues, planningOptionsSignature } from './planning-options';
import { routingIssues, routingSignature } from './planning-routing';

// 只比较结构和输入适用性；不推算覆盖、连通率或任何业务指标。
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
export function validatePlanningInput(
  input: PlanningInput,
  resources: ResourcesData,
): PlanningIssue[] {
  const issues: PlanningIssue[] = [];
  issues.push(...planningOptionIssues(input));
  const add = (objectId: string, field: string, message: string) =>
    issues.push({ objectId, field, message });
  // 通视可引用任意已保存节点，不强制成为任务参与节点或配置设备。
  issues.push(...deploymentConstraintIssues(input.deploymentConstraints, resources.stations.map(node => node.id)));
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60)
    add('TASK', 'name', '任务名称需为 1–60 字符');
  if (typeof input.description !== 'string' || input.description.length > 500)
    add('TASK', 'description', '说明最多 500 字符');
  if(!Array.isArray(input.bbox)||input.bbox.length!==4||!input.bbox.every(Number.isFinite)||input.bbox[0]<-180||input.bbox[2]>180||input.bbox[1]<-90||input.bbox[3]>90||input.bbox[0]>=input.bbox[2]||input.bbox[1]>=input.bbox[3])add('TASK','bbox','区域需为有效 WGS84 最小经纬度、最大经纬度');
  if(input.startTime!=null){
    const m=typeof input.startTime==='string'&&input.startTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/);
    if(!m||!Number.isFinite(Date.parse(input.startTime!))||Number(m[2])<1||Number(m[2])>12||Number(m[3])<1||Number(m[3])>new Date(Date.UTC(Number(m[1]),Number(m[2]),0)).getUTCDate()||Number(m[4])>23||Number(m[5])>59||Number(m[6])>59)add('TASK','startTime','时间须为带时区的有效 ISO 8601 文本');
  }
  if(input.durationH!=null&&(typeof input.durationH!=='number'||!Number.isFinite(input.durationH)||input.durationH<=0))add('TASK','durationH','持续时长可空，非空须大于 0');
  if (
    !Array.isArray(input.stationIds) ||
    input.stationIds.length < 2 ||
    new Set(input.stationIds).size !== input.stationIds.length ||
    input.stationIds.some((id) => !resourceIdValid(id)||!resources.stations.some((row) => row.id === id))
  )
    add('TASK', 'stationIds', '至少选择两个不同的已保存节点');
  if(Array.isArray(input.stationIds))for(const id of input.stationIds){
    if(!resources.devices.some(d=>d.stationId===id&&onShelf(d)))add(id,'stationIds','节点未配置设备或无在架设备，请调整输入');
  }
  if (
    !sameValue(input.constraints, {
      connectivityPercent: 100,
      maxRelayHops: 2,
      survivabilityPercent: 90,
    })
  )
    add('TASK', 'constraints', '连通率 100%、最大中继 2 跳、抗毁性 ≥90% 不可降低');
  if (!resourceIdValid(input.presetId) || !resourceIdValid(input.frequencyId)) add('TASK', 'presetId', '请选择预设及频率资源');
  if (!Array.isArray(input.demands) || !input.demands.length) {
    add('TASK', 'demands', '至少添加一条通联需求');
    return issues;
  }
  if(input.demands.length>TASK_MAX_DEMANDS)add('TASK','demands','通联需求最多 '+TASK_MAX_DEMANDS+' 条');
  const ids = new Set<string>();
  const relations = new Set<string>();
  for (const row of input.demands) {
    if (!row || !resourceIdValid(row.id) || ids.has(row.id)) {
      add('DEMAND', 'id', '需求 ID 缺失或重复');
      continue;
    }
    ids.add(row.id);
    // 先确认需求对象存在，再校验附加路由条件。
    issues.push(...routingIssues(row));
    if (
      !input.stationIds?.includes(row.sourceId) ||
      !input.stationIds?.includes(row.targetId) ||
      row.sourceId === row.targetId
    )
      add(row.id, 'endpoints', '起终点必须是参与节点且不能相同');
    const mode=row.endpointMode??'station';
    if(!['station','device'].includes(mode))add(row.id,'endpointMode','端点类型无效');
    if(row.preferredClass!=null&&!['HF','VUHF'].includes(row.preferredClass))add(row.id,'preferredClass','偏好类别须为 HF、VUHF 或空');
    if(mode==='device'){
      for(const [stationId,deviceId]of [[row.sourceId,row.sourceDeviceId],[row.targetId,row.targetDeviceId]]){
        const device=resources.devices.find(d=>d.id===deviceId&&d.stationId===stationId);
        if(!device||!onShelf(device))add(row.id,'devices','指定设备不存在、归属不符或已下架');
        else if(row.preferredClass&&resources.models.length&&resources.models.find(m=>m.id===device.modelId)?.deviceClass!==row.preferredClass)add(row.id,'preferredClass','设备类别不符合需求偏好');
      }
    }else if(row.sourceDeviceId||row.targetDeviceId)add(row.id,'devices','站点级需求不能携带指定设备');
    const relation = JSON.stringify([mode,row.sourceId,row.targetId,row.sourceDeviceId??null,row.targetDeviceId??null,row.service]);
    if (relations.has(relation)) add(row.id, 'endpoints', '同方向、同业务类型的需求重复');
    relations.add(relation);
    if (!['', '话音', '数据', '短消息'].includes(row.service))
      add(row.id, 'service', '请选择话音、数据或短消息');
    if (!['P1', 'P2', 'P3'].includes(row.priority) || typeof row.mandatory !== 'boolean')
      add(row.id, 'priority', '优先级或必要通联标记无效');
    for (const field of ['requiredRateKbps', 'maxDelayMs'] as const)
      if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field]! <= 0)
        add(row.id, field, '必填且必须为大于 0 的有限数值');
    if (
      row.dataVolumeMb !== null &&
      (typeof row.dataVolumeMb !== 'number' ||
        !Number.isFinite(row.dataVolumeMb) ||
        row.dataVolumeMb < 0)
    )
      add(row.id, 'dataVolumeMb', '数据量可空，非空必须 ≥0');
    if (
      typeof row.minReliability !== 'number' ||
      !Number.isFinite(row.minReliability) ||
      row.minReliability < 0 ||
      row.minReliability > 1
    )
      add(row.id, 'minReliability', '可靠性必填，范围为 0–1');
  }
  return issues;
}
export function inputSignature(input: PlanningInput, includePreset = true) {
  // 需求 ID 可自由生成，以关系及实际值匹配；顺序不影响适用性。
  return {
    startTime:input.startTime??null,durationH:input.durationH??null,
    bbox: input.bbox,
    constraints: input.constraints,
    deploymentConstraints: deploymentSignature(input.deploymentConstraints),
    ...planningOptionsSignature(input),
    stationIds: [...input.stationIds].sort(),
    demands: input.demands
      .map(({ id: _id, routeStrategy, needBackup, ...row }) => ({...row,...routingSignature({routeStrategy,needBackup}),endpointMode:row.endpointMode??'station',sourceDeviceId:row.sourceDeviceId??null,targetDeviceId:row.targetDeviceId??null,preferredClass:row.preferredClass??null}))
      .sort((a, b) =>
        JSON.stringify([a.sourceId,a.targetId,a.service,a.endpointMode,a.sourceDeviceId,a.targetDeviceId]).localeCompare(
          JSON.stringify([b.sourceId,b.targetId,b.service,b.endpointMode,b.sourceDeviceId,b.targetDeviceId]),
        ),
      ),
    ...(includePreset ? { presetId: input.presetId, frequencyId: input.frequencyId } : {}),
  };
}
export function matchPreset(
  input: PlanningInput,
  resources: ResourcesData,
  presets: PlanningPreset[],
) {
  const invalid = validatePlanningInput(input, resources);
  if (invalid.length) throw new ApiError('请修正任务输入', 'VALIDATION_ERROR', invalid);
  const preset = presets.find((item) => item.id === input.presetId);
  const mismatches: PlanningIssue[] = [];
  if (!preset)
    throw new ApiError('当前输入暂无预生成结果', 'NO_PRESET', [
      { objectId: 'TASK', field: 'presetId', message: '预设不存在' },
    ]);
  for(const row of preset.baseline.devices){
    if(resources.devices.find(d=>d.id===row.id)?.availability==='OFF_SHELF')
      throw new ApiError('预设引用设备已下架，请调整输入或恢复设备','VALIDATION_ERROR',[{objectId:row.id,field:'availability',message:'设备已下架，不能用于新规划'}]);
  }
  const initial=initialResources();
  for(const id of input.stationIds){
    const expectedIds=initial.devices.filter(d=>d.stationId===id&&onShelf(d)).map(d=>d.id).sort();
    const actualIds=resources.devices.filter(d=>d.stationId===id&&onShelf(d)).map(d=>d.id).sort();
    if(!sameValue(expectedIds,actualIds))mismatches.push({objectId:id,field:'devices',message:'当前在架设备集合暂无预生成结果'});
  }
  if(resources.interferences&&!sameValue(resources.interferences,initial.interferences))
    mismatches.push({objectId:'TASK',field:'interferences',message:'当前干扰配置暂无预生成结果；不会忽略新配置'});
  const actual = inputSignature(input);
  const expected = inputSignature(preset.input);
  for (const field of Object.keys(expected) as (keyof typeof expected)[])
    if (!sameValue(actual[field], expected[field]))
      mismatches.push({ objectId: 'TASK', field, message: `${field} 与所选预设输入不匹配` });
  for (const kind of ['stations', 'devices'] as const)
    for (const row of preset.baseline[kind]) {
      const current = resources[kind].find((item) => item.id === row.id);
      for (const field of Object.keys(row))
        if (!sameValue(current?.[field as keyof typeof current], row[field as keyof typeof row]))
          mismatches.push({ objectId: row.id, field, message: '已保存资源与预设基线不匹配' });
    }
  if (mismatches.length)
    throw new ApiError('当前输入暂无预生成结果；输入已保留', 'NO_PRESET', mismatches);
  return preset;
}
export function captureDependencies(
  meta: ResourceMeta,
  baseline: PlanningPreset['baseline'],
): ResourceDependencies {
  return {
    interferenceVersion:meta.interferenceVersion??'initial',
    resourceEpoch: meta.resourceEpoch,
    stationVersions: Object.fromEntries(
      baseline.stations.map((row) => [row.id, meta.stationVersions[row.id] ?? 'initial']),
    ),
    deviceVersions: Object.fromEntries(
      baseline.devices.map((row) => [row.id, meta.deviceVersions[row.id] ?? 'initial']),
    ),
  };
}
export function dependenciesChanged(deps: ResourceDependencies, meta: ResourceMeta) {
  return (
    !!deps.task && meta.taskWorkspace?.tasks.find(t=>t.id===deps.task!.id)?.versions.at(-1)?.conditionVersion!==deps.task.conditionVersion ||
    (deps.interferenceVersion??'initial')!==(meta.interferenceVersion??'initial') ||
    deps.resourceEpoch !== meta.resourceEpoch ||
    Object.entries(deps.stationVersions).some(
      ([id, revision]) => revision !== (meta.stationVersions[id] ?? 'initial'),
    ) ||
    Object.entries(deps.deviceVersions).some(
      ([id, revision]) => revision !== (meta.deviceVersions[id] ?? 'initial'),
    )
  );
}
export function checksPass(checks: PlanningResult['checks']) {
  return ['connectivity', 'survivability', 'relay', 'frequency'].every(
    (id) =>
      checks.filter((row) => row.id === id).length === 1 &&
      checks.find((row) => row.id === id)?.passed === true,
  );
}
function readPresetCoverage(presetId: string, catalog: typeof coverageCatalog) {
  // 新教学预设显式复用固定覆盖资产，不根据约束重新计算或改色。
  presetId = coveragePresetId(presetId);
  if (!Object.hasOwn(catalog.presetAssets, presetId)) return undefined;
  const assetId = catalog.presetAssets[presetId as keyof typeof catalog.presetAssets];
  const asset = catalog.assets[assetId as keyof typeof catalog.assets];
  return asset ? readCoverage(structuredClone(asset.coverage)) : undefined;
}
// 仅新提交默认捕获 v2；每次返回独立对象，查询旧任务仍使用其冻结字段。
export function getPresetCoverage(presetId: string) {
  return readPresetCoverage(presetId, coverageCatalog);
}
// 历史兼容只接受同档位的完整已知资产，不能混用旧 URL 与新色表。
export function matchesPresetCoverage(presetId: string, coverage: unknown): boolean {
  return [legacyCoverageCatalog, coverageCatalog].some(catalog => {
    const expected = readPresetCoverage(presetId, catalog);
    return expected !== undefined && sameValue(coverage, expected);
  });
}
export function resultForJob(job: PlanningJob, preset: PlanningPreset): PlanningResult | null {
  if (!preset.result) return null;
  // 核心预设即使将来附带明细，也不能给旧 Job 补入提交时不存在的数据。
  const { resultDetails: _presetDetails, ...coreResult } = structuredClone(preset.result);
  const result = {
    ...coreResult,
    ...(job.resultDetails === undefined ? {} : { resultDetails: structuredClone(job.resultDetails) }),
    coverage: job.coverage ? structuredClone(job.coverage) : undefined,
    snapshotId: job.snapshotId,
    inputSnapshot: structuredClone(job.inputSnapshot),
  };
  // 只替换引用身份；用户自建需求 ID 不改变预生成结果内容。
  for (const route of result.configuration.routes) {
    const original = preset.input.demands.find((row) => row.id === route.demandId)!;
    route.demandId = job.input.demands.find(
      (row) =>
        row.sourceId === original.sourceId &&
        row.targetId === original.targetId &&
        row.service === original.service && (row.endpointMode??'station')===(original.endpointMode??'station') && (row.sourceDeviceId??null)===(original.sourceDeviceId??null) && (row.targetDeviceId??null)===(original.targetDeviceId??null),
    )!.id;
  }
  return result;
}
// 明细仅引用此结果的冻结身份，兼容没有附加数据的历史任务。
export function planningResultDetailsContext(result: Pick<PlanningResult, 'inputSnapshot' | 'links' | 'configuration'>, input: PlanningInput) {
  return { nodes: result.inputSnapshot.stations, devices: result.inputSnapshot.devices,
    links: result.links, configuration: result.configuration, demandIds: input.demands.map(row => row.id) };
}
export function assertResult(result: PlanningResult, input: PlanningInput, resultPresetId = input.presetId) {
  const fail = () => {
    throw new ApiError('结果结构或引用不完整，不能保存', 'INVALID_RESULT');
  };
  const { stations, devices } = result.inputSnapshot;
  if (result.resultDetails !== undefined) assertPlanningResultDetails(result.resultDetails, planningResultDetailsContext(result, input));
  if (result.coverage !== undefined && !matchesPresetCoverage(resultPresetId, result.coverage)) fail();
  const ids = stations.map((row) => row.id);
  if (
    !sameValue([...ids].sort(), [...input.stationIds].sort()) ||
    new Set(devices.map((d) => d.id)).size !== devices.length
  )
    fail();
  if (
    Object.values(result.metrics).some(
      (v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0,
    ) ||
    Object.keys(result.metrics).length !== 5 ||
    (result.deploymentCost !== null &&
      (!Number.isFinite(result.deploymentCost) || result.deploymentCost < 0))
  )
    fail();
  for (const link of result.links)
    for (const [stationId, deviceId] of [
      [link.a, link.deviceA],
      [link.b, link.deviceB],
    ])
      if (
        !ids.includes(stationId) ||
        !devices.some((d) => d.id === deviceId && d.stationId === stationId)
      )
        fail();
  if (new Set(result.links.map((row) => row.id)).size !== result.links.length) fail();
  const config = result.configuration;
  if (
    !config.deployment.length ||
    !config.devices.length ||
    !config.routes.length ||
    !config.frequencies.length
  )
    fail();
  for (const row of config.deployment)
    if (
      !ids.includes(row.stationId) ||
      // 重新部署仅记录规划输出坐标，输入资源保持冻结。
      (row.plannedCoordinate !== undefined && (!Array.isArray(row.plannedCoordinate) || row.plannedCoordinate.length !== 2 ||
        !row.plannedCoordinate.every(Number.isFinite) || Math.abs(row.plannedCoordinate[0]) > 180 || Math.abs(row.plannedCoordinate[1]) > 90)) ||
      row.deviceIds.some((id) => !devices.some((d) => d.id === id && d.stationId === row.stationId))
    )
      fail();
  for (const row of config.devices)
    if (
      !devices.some((d) => d.id === row.deviceId && d.stationId === row.stationId) ||
      ![row.frequencyKhz, row.txPowerDbm, row.antennaHeightM].every(Number.isFinite)
    )
      fail();
  for (const route of config.routes) {
    const demand = input.demands.find((row) => row.id === route.demandId);
    if (
      !demand ||
      route.nodeIds[0] !== demand.sourceId ||
      route.nodeIds.at(-1) !== demand.targetId ||
      route.linkIds.length !== route.nodeIds.length - 1
    )
      fail();
    if(demand?.endpointMode==='device'){
      const first=result.links.find(l=>l.id===route.linkIds[0]),last=result.links.find(l=>l.id===route.linkIds.at(-1));
      const endpoint=(link:typeof first,node:string)=>link?.a===node?link.deviceA:link?.b===node?link.deviceB:undefined;
      if(endpoint(first,demand.sourceId)!==demand.sourceDeviceId||endpoint(last,demand.targetId)!==demand.targetDeviceId)fail();
    }
    route.linkIds.forEach((id, index) => {
      const link = result.links.find((row) => row.id === id);
      if (
        !link ||
        !sameValue([link.a, link.b].sort(), [route.nodeIds[index], route.nodeIds[index + 1]].sort())
      )
        fail();
    });
  }
  for (const region of result.regions)
    for (const ring of region.rings)
      if (
        ring.length < 4 ||
        !sameValue(ring[0], ring.at(-1)) ||
        ring.some((p) => p.length !== 2 || !p.every(Number.isFinite))
      )
        fail();
}
export function validateSaveFields(name: string, note: string) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 60 ||
    typeof note !== 'string' ||
    note.length > 500
  )
    throw new ApiError('方案名称为 1–60 字符，备注最多 500 字符', 'VALIDATION_ERROR');
}
export function assertConfirmable(plan: PlanVersion, meta: ResourceMeta) {
  if (
    !plan.workflow ||
    plan.state !== 'SAVED' ||
    plan.workflow.outcome.code !== 0 ||
    !checksPass(plan.workflow.checks)
  )
    throw new ApiError('仅完整、校验通过的待确认版本可确认', 'NOT_CONFIRMABLE');
  if (dependenciesChanged(plan.workflow.dependencies, meta)||taskSourceChanged(plan.taskId,plan.workflow.input,meta,plan.workflow.dependencies.task?.conditionVersion))
    throw new ApiError('源数据已变更，配置待更新；请重新规划', 'SOURCE_CHANGED');
}
export function assertComparable(plans: PlanVersion[]) {
  if (plans.length < 2 || plans.length > 4 || new Set(plans.map((p) => p.id)).size !== plans.length)
    throw new ApiError('请选择 2–4 个不同的已保存版本', 'INVALID_COMPARISON');
  if (plans.some((p) => p.taskId !== plans[0].taskId))
    throw new ApiError('不同任务的方案不可直接对比', 'INCOMPARABLE');
  const first = plans[0].workflow;
  if (
    first &&
    plans.some(
      (p) =>
        !p.workflow ||
        !sameValue(inputSignature(p.workflow.input, false), inputSignature(first.input, false)) ||
        !sameValue(p.inputSnapshot, plans[0].inputSnapshot),
    )
  )
    throw new ApiError('节点、需求或资源输入不同，不能作为可比调整结果', 'INCOMPARABLE');
}
