import type { Coordinate, DeviceClass, OperationalStatus, ResourcesData } from '../types/domain';
import type { DeviceStatusDisplay } from '../types/resource-status';

// 仅为 GIS 显示副本，不向资源、方案或对外接口增加字段。
export interface GisDevicePoint {
  id: string; stationId: string; stationName: string; modelId: string; deviceClass: DeviceClass;
  coordinate: Coordinate; status: OperationalStatus | null; alert: boolean | null; offShelf: boolean; manualStation: boolean;
  statusDisplay?: DeviceStatusDisplay;
}
export interface GisDeviceLayerSetting { visible: boolean; opacity: number }
export type GisDeviceSettings = Record<DeviceClass, GisDeviceLayerSetting>;
export type GisDeviceStateFilter = 'ALL' | 'NORMAL' | 'FAULT' | 'OFFLINE' | 'ALERT' | 'UNKNOWN' | 'UNKNOWN_ALERT';
export interface GisDeviceMapFrame { points: GisDevicePoint[]; settings: GisDeviceSettings; selectedDeviceId: string; version: number; statusSource?: string }
export const GIS_DEVICE_TYPES: DeviceClass[] = ['HF', 'VUHF'];
export const GIS_DEVICE_FILTERS: { value: GisDeviceStateFilter; label: string }[] = [
  { value: 'ALL', label: '全部状态' }, { value: 'NORMAL', label: '正常（无告警）' },
  { value: 'FAULT', label: '故障' }, { value: 'OFFLINE', label: '离线' }, { value: 'ALERT', label: '有告警' },
  { value: 'UNKNOWN', label: '状态未提供' }, { value: 'UNKNOWN_ALERT', label: '告警未提供' },
];
export const GIS_DEVICE_COLORS = { NORMAL: '#45c9af', FAULT: '#f27887', OFFLINE: '#8192a8', ALERT: '#f0bd67', UNKNOWN: '#b8bed0' };
export function defaultGisDeviceSettings(): GisDeviceSettings {
  return { HF: { visible: true, opacity: 1 }, VUHF: { visible: true, opacity: 1 } };
}
export function gisDevicePoints(resources: ResourcesData, displays?: Record<string, DeviceStatusDisplay>) {
  const stations = new Map(resources.stations.map(row => [row.id, row]));
  const models = new Map(resources.models.map(row => [row.id, row]));
  const points: GisDevicePoint[] = []; let missingCount = 0;
  for (const device of resources.devices) {
    const station = stations.get(device.stationId), model = models.get(device.modelId), xy = station?.coordinate;
    // 缺类型或坐标不能借用站点能力、同站设备或默认经纬度补配。
    if (!station || !model || !GIS_DEVICE_TYPES.includes(model.deviceClass) || !xy || xy.length !== 2
      || !xy.every(Number.isFinite) || Math.abs(xy[0]) > 180 || Math.abs(xy[1]) > 90) { missingCount++; continue; }
    // 显式接入才覆盖显示字段；位置、在架状态和 Device 原对象保持不变。
    const display = displays?.[device.id];
    points.push({ id: device.id, stationId: station.id, stationName: station.name, modelId: model.id,
      deviceClass: model.deviceClass, coordinate: [...xy], status: display ? display.status : device.status, alert: display ? display.alert : device.alert,
      ...(display ? { statusDisplay: display } : {}),
      offShelf: device.availability === 'OFF_SHELF', manualStation: station.origin === 'MANUAL' });
  }
  return { points, missingCount };
}
export function matchesGisDeviceState(point: GisDevicePoint, state: GisDeviceStateFilter) {
  return state === 'ALL' || (state === 'UNKNOWN' ? point.status === null : state === 'UNKNOWN_ALERT' ? point.alert === null
    : state === 'ALERT' ? point.alert === true : state === 'NORMAL' ? point.status === 'NORMAL' && point.alert === false : point.status === state);
}
export function visibleGisDevices(points: readonly GisDevicePoint[], stationIds: readonly string[], settings: GisDeviceSettings, state: GisDeviceStateFilter) {
  const stations = new Set(stationIds);
  return points.filter(row => stations.has(row.stationId) && settings[row.deviceClass].visible
    && settings[row.deviceClass].opacity > 0 && matchesGisDeviceState(row, state));
}
export function gisDeviceStatus(point: GisDevicePoint) {
  const label = point.status === null ? '状态未提供' : point.status === 'FAULT' ? '故障' : point.status === 'OFFLINE' ? '离线' : '正常';
  return label + (point.alert === null ? ' · 告警未提供' : point.alert ? ' · 告警' : '') + (point.statusDisplay?.retained ? ' · 上次记录' : '');
}
export function gisDeviceTone(point: GisDevicePoint) {
  return point.status === 'FAULT' || point.status === 'OFFLINE' ? point.status : point.status === null || point.alert === null
    ? 'UNKNOWN' : point.alert ? 'ALERT' : 'NORMAL';
}
export function sortGisDevices(points: readonly GisDevicePoint[]) {
  const rank = (row: GisDevicePoint) => row.status === 'FAULT' ? 0 : row.alert ? 1 : 2;
  return [...points].sort((a, b) => rank(a) - rank(b) || a.stationId.localeCompare(b.stationId) || a.id.localeCompare(b.id));
}
export function gisDeviceSummary(points: readonly GisDevicePoint[]) {
  return { count: points.length, HF: points.filter(row => row.deviceClass === 'HF').length,
    VUHF: points.filter(row => row.deviceClass === 'VUHF').length,
    faults: points.filter(row => row.status === 'FAULT').length, alerts: points.filter(row => row.alert).length };
}
