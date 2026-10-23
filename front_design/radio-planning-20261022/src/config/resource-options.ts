import type { DeviceClass, ResourceOrigin, Station } from '../types/domain';

// 编成这里只用于表单枚举与字段组合校验，不执行路由或容量算法。
export const stationTypes: Record<string, { echelon: string; mobility: Station['mobility']; classes: DeviceClass[] }> = {
  I_FIXED: { echelon: 'I', mobility: 'FIXED', classes: ['HF'] },
  I_MOBILE: { echelon: 'I', mobility: 'VEHICLE', classes: ['HF'] },
  II_FIXED: { echelon: 'II', mobility: 'FIXED', classes: ['HF', 'VUHF'] },
  II_MOBILE: { echelon: 'II', mobility: 'VEHICLE', classes: ['HF', 'VUHF'] },
  II_NODE: { echelon: 'II', mobility: 'VEHICLE', classes: ['HF', 'VUHF'] },
  III_MOBILE: { echelon: 'III', mobility: 'VEHICLE', classes: ['HF', 'VUHF'] },
  IV_MOBILE: { echelon: 'IV', mobility: 'VEHICLE', classes: ['VUHF'] },
  VEHICLE_A: { echelon: 'I', mobility: 'VEHICLE', classes: ['HF'] },
  VEHICLE_B: { echelon: 'I', mobility: 'VEHICLE', classes: ['HF'] },
  MANPACK: { echelon: 'I', mobility: 'MANPACK', classes: ['HF'] },
};

// 来源标签供页面与校验共用，不依赖任何演示数据。
export const resourceOrigins: Record<ResourceOrigin, string> = { SOURCE: '初始资料', MANUAL: '手工创建', IMPORT: '文件导入' };
