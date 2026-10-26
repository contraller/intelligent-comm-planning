import type { Availability } from '../types/domain';

// 在架提示仅依赖目录字段，不要求完整设备参数；缺省沿用原兼容含义。
export const onShelf = (device: { availability?: Availability | null }) => device.availability !== 'OFF_SHELF';

export const stationEquipmentLabel = (resources: { devices: { stationId: string; availability?: Availability | null }[] }, id: string) => {
  const devices = resources.devices.filter(d => d.stationId === id);
  return !devices.length ? '未配置设备' : !devices.some(onShelf) ? '无在架设备' : devices.some(d => !onShelf(d)) ? '本站存在下架设备' : '';
};
