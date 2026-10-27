import type { ApiPlanningResult } from '../types/planning-api';
import type { PlanningConfiguration } from '../types/planning';

// 历史配置可能省略位置；只从同一冻结结果的节点回读，不借用当前资源坐标。
export function deploymentDisplayRows(result: ApiPlanningResult | null, deployment?: PlanningConfiguration['deployment']) {
  const nodes = new Map(result?.nodes.map(node => [node.id, node]) ?? []);
  const devices = new Map(result?.devices.map(device => [device.id, device]) ?? []);
  return (deployment ?? result?.configuration.deployment ?? []).map(row => {
    const node = nodes.get(row.stationId);
    return { ...row, id: row.stationId, stationName: node?.name ?? row.stationId,
      plannedCoordinate: row.plannedCoordinate ?? node?.coordinate,
      isNewDeployment: node?.isNewDeployment === true,
      deviceLabels: row.deviceIds.map(id => {
        const model = devices.get(id)?.modelName;
        return model ? `${id} · ${model}` : id;
      }).join(' / '),
    };
  });
}
