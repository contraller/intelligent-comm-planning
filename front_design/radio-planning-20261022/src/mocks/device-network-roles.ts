import type { DeviceNetworkRoles } from '../types/device-network';

// 角色由教学资料明确声明，不能以同站点或路径位置自动分配。
export const deviceNetworkRoles: DeviceNetworkRoles = {
  version: 'device-network-roles-v1', snapshotId: 'NET-DEMO-03', source: '独立教学角色目录 · 非正式角色枚举',
  items: [
    { deviceId: 'DV-0001', role: '教学角色 A', description: '此网络中为该设备明确提供的角色展示示例。', source: '固定 Mock 声明' },
    { deviceId: 'DV-0027', role: '教学角色 B', description: '仅用于验证不同设备的角色切换，不代表真实组网分工。', source: '固定 Mock 声明' },
  ],
};
