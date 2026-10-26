import type { DevicePort, PortObservation } from '../types/device-maintenance';
export const maintenanceSource = '独立 Mock 端口预设 · 非真实装备台账或采集';
// 仅显式设备有教学清单，不能按型号推造全库端口。
export const portPresets: Record<string, DevicePort[]> = Object.fromEntries(['DV-0001','DV-0002','DV-0027','DV-0037'].map(deviceId => [deviceId, [
  { id: deviceId + ':RF1', number: 'RF-1', type: 'RF', freqMinKhz: ['DV-0001','DV-0002'].includes(deviceId) ? 1500 : 1600, freqMaxKhz: 30000, rateKbps: 9.6, gainDbi: 3, heightM: 10, azimuthDeg: 0, tiltDeg: 0 },
  { id: deviceId + ':BUS1', number: 'BUS-1', type: 'BUSINESS', freqMinKhz: null, freqMaxKhz: null, rateKbps: 64, gainDbi: null, heightM: null, azimuthDeg: null, tiltDeg: null },
]]));
export function portObservations(deviceId: string): PortObservation[] {
  return (portPresets[deviceId] ?? []).map(port => ({ portId: port.id, status: 'NORMAL', observedAt: '2026-10-20T08:00:00+08:00', source: maintenanceSource }));
}
