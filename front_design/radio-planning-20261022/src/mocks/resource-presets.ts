import base from './resources.json';
import supplement from './resource-supplement.json';
import candidateCatalog from './candidate-links.json';
import type { ResourcesData, Station } from '../types/domain';
import type { CandidateLink } from '../types/candidate-link';
import { portPresets } from './device-maintenance-presets';
import { DEMO_BBOX } from '../config/demo';

// 保留旧导入路径；共用逻辑位于不依赖 Mock 数据的模块。
export { stationTypes, resourceOrigins } from '../config/resource-options';
export { onShelf, stationEquipmentLabel } from '../services/resource-display';
export const initialInterferences = () => structuredClone(supplement.interferences) as NonNullable<ResourcesData['interferences']>;
// 仅 Mock 来源目录使用；通用补充函数不能给 HTTP 响应注入候选样例。
export const initialCandidateLinks = () => structuredClone(candidateCatalog) as CandidateLink[];
// 仅组装初始 Mock 资料，不补齐已保存记录或外部响应。
export function completeResources(input: ResourcesData): ResourcesData {
  const data=structuredClone(input);
  // 仅明确Mock来源保留旧样件区域；HTTP decoder不调用此函数。
  if (data.planningBounds === undefined) data.planningBounds = [...DEMO_BBOX];
  data.stations=data.stations.map(row=>({...supplement.stations.find(s=>s.id===row.id),origin:'SOURCE',...row} as Station));
  data.devices=data.devices.map(row=>({...supplement.devices.find(s=>s.id===row.id),origin:'SOURCE',availability:'ACTIVE',...row}));
  data.interferences ??= initialInterferences();
  return data;
}
export const initialResources = () => {
  const data = completeResources({ ...base as ResourcesData, candidateLinks:initialCandidateLinks() });
  // 初始化教学目录，不给旧存储或外部响应补造当前模式。
  data.devices = data.devices.map(device => portPresets[device.id] ? { ...device, ports: structuredClone(portPresets[device.id]) } : device);
  return data;
};
