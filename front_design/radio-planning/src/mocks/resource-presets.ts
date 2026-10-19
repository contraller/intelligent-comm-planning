import base from './resources.json';
import supplement from './resource-supplement.json';
import candidateCatalog from './candidate-links.json';
import type { ResourcesData, Station } from '../types/domain';
import type { CandidateLink } from '../types/candidate-link';

// 编成这里只用于表单枚举与字段组合校验，不执行路由或容量算法。
export const stationTypes: Record<string,{echelon:string;mobility:string;classes:('HF'|'VUHF')[]}> = {
  I_FIXED:{echelon:'I',mobility:'FIXED',classes:['HF']},I_MOBILE:{echelon:'I',mobility:'VEHICLE',classes:['HF']},
  II_FIXED:{echelon:'II',mobility:'FIXED',classes:['HF','VUHF']},II_MOBILE:{echelon:'II',mobility:'VEHICLE',classes:['HF','VUHF']},
  II_NODE:{echelon:'II',mobility:'VEHICLE',classes:['HF','VUHF']},III_MOBILE:{echelon:'III',mobility:'VEHICLE',classes:['HF','VUHF']},
  IV_MOBILE:{echelon:'IV',mobility:'VEHICLE',classes:['VUHF']},VEHICLE_A:{echelon:'I',mobility:'VEHICLE',classes:['HF']},
  VEHICLE_B:{echelon:'I',mobility:'VEHICLE',classes:['HF']},MANPACK:{echelon:'I',mobility:'MANPACK',classes:['HF']},
};
export const initialInterferences = () => structuredClone(supplement.interferences) as NonNullable<ResourcesData['interferences']>;
// 仅 Mock 来源目录使用；通用补充函数不能给 HTTP 响应注入候选样例。
export const initialCandidateLinks = () => structuredClone(candidateCatalog) as CandidateLink[];
export function completeResources(input: ResourcesData): ResourcesData {
  const data=structuredClone(input);
  data.stations=data.stations.map(row=>({...supplement.stations.find(s=>s.id===row.id),origin:'SOURCE',...row} as Station));
  data.devices=data.devices.map(row=>({...supplement.devices.find(s=>s.id===row.id),origin:'SOURCE',availability:'ACTIVE',...row}));
  data.interferences ??= initialInterferences();
  return data;
}
export const initialResources = () => completeResources({ ...base as ResourcesData, candidateLinks:initialCandidateLinks() });
export const resourceOrigins = { SOURCE:'初始资料',MANUAL:'手工创建',IMPORT:'文件导入' };
export const onShelf = (device: ResourcesData['devices'][number]) => device.availability !== 'OFF_SHELF';
export const stationEquipmentLabel = (resources:ResourcesData,id:string) => {
  const devices=resources.devices.filter(d=>d.stationId===id);
  return !devices.length?'未配置设备':!devices.some(onShelf)?'无在架设备':devices.some(d=>!onShelf(d))?'本站存在下架设备':'';
};
