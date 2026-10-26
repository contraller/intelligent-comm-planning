import type { PlanningResultDetails, PlanningResultDetailsContext } from '../types/planning-result-details';
import { assertPlanningCandidateScreening } from './planning-candidates-validation';
import { assertPlanningOptimization } from './planning-optimization';

const invalid = (field: string): never => { throw new Error(`规划结果补充明细无效：${field}`); };
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(field);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[], field: string) {
  if (names.some(name => !Object.hasOwn(value, name))) invalid(field + ' 缺少字段');
}
function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) invalid(field);
}
function nullableText(value: unknown, field: string) { if (value !== null) text(value, field); }
function number(value: unknown, field: string, minimum = -Infinity, integer = false, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum ||
      (integer && !Number.isInteger(value)) || (positive && value <= 0)) invalid(field);
}
function nullableNumber(value: unknown, field: string, minimum = -Infinity, integer = false, positive = false) {
  if (value !== null) number(value, field, minimum, integer, positive);
}
function nullableBoolean(value: unknown, field: string) {
  if (value !== null && typeof value !== 'boolean') invalid(field);
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) return invalid(field);
  value.forEach(item => text(item, field));
  if (new Set(value).size !== value.length) invalid(field + ' 重复身份');
  return value;
}
function nullableStrings(value: unknown, field: string) {
  if (value === null) return;
  if (!Array.isArray(value)) return invalid(field);
  value.forEach(item => text(item, field));
}
function rows(value: unknown, field: string): Record<string, unknown>[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return invalid(field);
  return value.map(item => record(item, field));
}
function unique(rows: readonly Record<string, unknown>[], key: string, field: string) {
  rows.forEach(row => text(row[key], field + '.' + key));
  if (new Set(rows.map(row => row[key])).size !== rows.length) invalid(field + ' 重复身份');
}

// 只核对服务声明的关系，不根据频点、路径长度或质量值推导业务结论。
export function assertPlanningResultDetails(value: unknown, context: PlanningResultDetailsContext): asserts value is PlanningResultDetails {
  const root = record(value, '容器');
  fields(root, ['schemaVersion', 'assetVersion', 'deviceParameters', 'routeQuality', 'frequencyAssignments',
    'frequencyConflicts', 'frequencyGap', 'conflictFree', 'unreachableDemandIds'], '容器');
  if (root.schemaVersion !== 1) invalid('schemaVersion');
  text(root.assetVersion, 'assetVersion');
  // 可选候选扩展沿结果读取；统计与当前明细条数无等量假设。
  if (Object.hasOwn(root, 'candidateScreening') && root.candidateScreening !== null) {
    assertPlanningCandidateScreening(root.candidateScreening);
    if (Object.hasOwn(root.candidateScreening, 'unavailableReasons'))
      nullableStrings(root.candidateScreening.unavailableReasons, 'candidateScreening.unavailableReasons');
    if (Object.hasOwn(root.candidateScreening, 'dataSources'))
      nullableStrings(root.candidateScreening.dataSources, 'candidateScreening.dataSources');
  }
  // 旧结果缺省保留；只校验服务声明，不从数量反推满足条件或最优性。
  if (Object.hasOwn(root, 'deploymentSummary') && root.deploymentSummary !== null) {
    const summary = record(root.deploymentSummary, 'deploymentSummary');
    fields(summary, ['mode', 'requestedCount', 'actualCount', 'requestedSolutionCount', 'returnedSolutionCount',
      'countSatisfied', 'shortfallReasons', 'forcedSiteIds', 'lowerBound', 'provedOptimal'], 'deploymentSummary');
    if (summary.mode !== null && summary.mode !== 'MIN_COUNT' && summary.mode !== 'FIXED_COUNT') invalid('deploymentSummary.mode');
    for (const key of ['requestedCount', 'actualCount', 'requestedSolutionCount', 'returnedSolutionCount', 'lowerBound']) {
      nullableNumber(summary[key], 'deploymentSummary.' + key, 0, true);
      if (summary[key] !== null && !Number.isSafeInteger(summary[key])) invalid('deploymentSummary.' + key);
    }
    nullableBoolean(summary.countSatisfied, 'deploymentSummary.countSatisfied');
    nullableBoolean(summary.provedOptimal, 'deploymentSummary.provedOptimal');
    nullableStrings(summary.shortfallReasons, 'deploymentSummary.shortfallReasons');
    if (summary.forcedSiteIds !== null) strings(summary.forcedSiteIds, 'deploymentSummary.forcedSiteIds');
  }
  if (Object.hasOwn(root, 'optimization') && root.optimization !== null) assertPlanningOptimization(root.optimization, context);
  const { nodes, devices, links, configuration, demandIds } = context;
  const identities = [nodes.map(row => row.id), devices.map(row => row.id), links.map(row => row.id),
    configuration.devices.map(row => row.deviceId), configuration.routes.map(row => row.id),
    configuration.frequencies.map(row => row.id), demandIds];
  if (identities.some(ids => new Set(ids).size !== ids.length)) invalid('冻结上下文重复身份');
  const validDevice = (id: unknown) => {
    const config = configuration.devices.find(row => row.deviceId === id);
    return config && nodes.some(node => node.id === config.stationId) &&
      devices.some(row => row.id === id && row.stationId === config.stationId);
  };
  const validLink = (id: unknown) => {
    const link = links.find(row => row.id === id);
    if (!link || !validDevice(link.deviceA) || !validDevice(link.deviceB) ||
        !devices.some(row => row.id === link.deviceA && row.stationId === link.a) ||
        !devices.some(row => row.id === link.deviceB && row.stationId === link.b)) return invalid('链路及设备端点关联');
    return link;
  };
  const parameters = rows(root.deviceParameters, 'deviceParameters');
  if (parameters) {
    unique(parameters, 'deviceId', 'deviceParameters');
    for (const row of parameters) {
      fields(row, ['deviceId', 'tiltDeg', 'tiltEffective'], 'deviceParameters');
      if (!validDevice(row.deviceId)) invalid('deviceParameters.deviceId');
      nullableNumber(row.tiltDeg, 'tiltDeg'); nullableBoolean(row.tiltEffective, 'tiltEffective');
    }
  }
  const quality = rows(root.routeQuality, 'routeQuality');
  if (quality) {
    unique(quality, 'routeId', 'routeQuality');
    for (const row of quality) {
      fields(row, ['routeId', 'demandId', 'hopCount', 'totalDistanceM', 'totalDelayMs', 'bottleneckMarginDb',
        'reliability', 'isFeasible', 'bottleneckLinkId'], 'routeQuality');
      text(row.demandId, 'demandId');
      const route = configuration.routes.find(item => item.id === row.routeId);
      if (!route) return invalid('路由需求关联');
      if (route.demandId !== row.demandId || !demandIds.includes(row.demandId)) invalid('路由需求关联');
      nullableNumber(row.hopCount, 'hopCount', 0, true);
      nullableNumber(row.totalDistanceM, 'totalDistanceM', 0);
      nullableNumber(row.totalDelayMs, 'totalDelayMs', 0);
      nullableNumber(row.bottleneckMarginDb, 'bottleneckMarginDb');
      nullableNumber(row.reliability, 'reliability', 0);
      if (typeof row.reliability === 'number' && row.reliability > 1) invalid('reliability');
      nullableBoolean(row.isFeasible, 'isFeasible'); nullableText(row.bottleneckLinkId, 'bottleneckLinkId');
      if (row.bottleneckLinkId !== null) {
        if (!route.linkIds.includes(row.bottleneckLinkId as string)) invalid('瓶颈链路不属于该路由');
        validLink(row.bottleneckLinkId);
      }
    }
  }
  const assignments = rows(root.frequencyAssignments, 'frequencyAssignments');
  if (assignments) {
    unique(assignments, 'id', 'frequencyAssignments'); unique(assignments, 'linkId', 'frequencyAssignments');
    for (const row of assignments) {
      fields(row, ['id', 'linkId', 'resourceGroupId', 'freqId', 'reuseGroup', 'frequencyKhz', 'bandwidthKhz'], 'frequencyAssignments');
      nullableText(row.resourceGroupId, 'resourceGroupId'); nullableText(row.freqId, 'freqId');
      nullableNumber(row.reuseGroup, 'reuseGroup', 0, true);
      number(row.frequencyKhz, 'frequencyKhz', 0, false, true);
      nullableNumber(row.bandwidthKhz, 'bandwidthKhz', 0, false, true);
      const link = validLink(row.linkId);
      if (link.frequencyKhz !== row.frequencyKhz) invalid('分配频点与明确链路不一致');
      if (row.resourceGroupId !== null) {
        const group = configuration.frequencies.find(item => item.id === row.resourceGroupId);
        if (!group || !group.allocatedKhz.includes(row.frequencyKhz as number)) invalid('频率池明确分配关联');
      }
    }
  }
  const conflicts = rows(root.frequencyConflicts, 'frequencyConflicts');
  if (conflicts) {
    unique(conflicts, 'id', 'frequencyConflicts');
    for (const row of conflicts) {
      fields(row, ['id', 'type', 'linkIds', 'frequencyKhz', 'distanceM', 'requiredDistanceM', 'severity'], 'frequencyConflicts');
      text(row.type, 'type'); strings(row.linkIds, 'linkIds').forEach(validLink);
      nullableNumber(row.frequencyKhz, 'frequencyKhz', 0, false, true);
      nullableNumber(row.distanceM, 'distanceM', 0); nullableNumber(row.requiredDistanceM, 'requiredDistanceM', 0);
      nullableText(row.severity, 'severity');
    }
  }
  if (root.frequencyGap !== null) {
    const gap = record(root.frequencyGap, 'frequencyGap');
    fields(gap, ['requiredChannels', 'availableChannels', 'shortage'], 'frequencyGap');
    for (const key of ['requiredChannels', 'availableChannels', 'shortage']) nullableNumber(gap[key], key, 0, true);
  }
  nullableBoolean(root.conflictFree, 'conflictFree');
  if (root.unreachableDemandIds !== null && strings(root.unreachableDemandIds, 'unreachableDemandIds').some(id => !demandIds.includes(id)))
    invalid('不可达需求关联');
}

export function readPlanningResultDetails(value: unknown, context: PlanningResultDetailsContext): PlanningResultDetails {
  assertPlanningResultDetails(value, context);
  return structuredClone(value);
}
