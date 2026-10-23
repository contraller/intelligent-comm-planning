import type { PlanVersion, Station } from '../types/domain';
import type { PlanningConfiguration } from '../types/planning';

// 只按冻结配置替换展示坐标；台账和方案输入快照均不修改。
export function configuredStations(stations: Station[], configuration?: PlanningConfiguration): Station[] {
  return stations.map(station => {
    const coordinate = configuration?.deployment.find(row => row.stationId === station.id)?.plannedCoordinate;
    return { ...station, classes: [...station.classes], parentIds: [...station.parentIds], coordinate: [...(coordinate ?? station.coordinate)] };
  });
}
export function planStations(plan: PlanVersion): Station[] {
  return configuredStations(plan.inputSnapshot.stations, plan.workflow?.configuration);
}
export function planOriginLabel(plan: PlanVersion): string {
  const origin = plan.workflow?.interferenceOrigin;
  // 多结果保存保留自己的来源标签，不能只显示相同的作业名称。
  return origin ? '抗干扰采纳 · ' + origin.variantId : plan.workflow?.adjustment ? '设备参数与路由调整' : plan.workflow?.solutionOrigin ? '网络规划 · '+plan.workflow.solutionOrigin.label : plan.workflow ? '网络规划' : '内置历史快照';
}

// 预设需求 ID 可与用户保存的 ID 不同；这里只映射身份，不重建路由。
export function bindResultDemands<T extends { configuration: PlanningConfiguration }>(
  result: T,
  input: import('../types/planning').PlanningInput,
  template: import('../types/planning').PlanningInput,
): T {
  const copy = structuredClone(result);
  for (const route of copy.configuration.routes) {
    const original = template.demands.find(demand => demand.id === route.demandId);
    const mapped = original && input.demands.find(demand =>
      demand.sourceId === original.sourceId && demand.targetId === original.targetId &&
      demand.service === original.service && (demand.endpointMode ?? 'station') === (original.endpointMode ?? 'station') &&
      (demand.sourceDeviceId ?? null) === (original.sourceDeviceId ?? null) &&
      (demand.targetDeviceId ?? null) === (original.targetDeviceId ?? null));
    if (!mapped) throw new Error('预生成路由无法关联当前任务需求');
    route.demandId = mapped.id;
  }
  return copy;
}
