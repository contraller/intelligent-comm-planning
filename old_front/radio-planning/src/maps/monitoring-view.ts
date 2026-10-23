import type { MonitoringNetwork, NetworkObservationFrame } from '../types/monitoring';
import { configuredStations } from '../services/planning-snapshot';

// 只建立展示副本：节点沿用冻结部署位置，链路色标使用本帧观测；设备状态不冒充站点状态。
export function monitoringMap(network: MonitoringNetwork, frame: NetworkObservationFrame | null) {
  const observations=new Map(frame?.links.map(row=>[row.linkId,row])??[]);
  return { stations:configuredStations(network.stations,network.configuration),
    links:network.links.map(link=>({...link,state:observations.get(link.id)?.state??link.state})) };
}
