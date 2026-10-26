import type { Device, ResourcesData } from '../types/domain';
import type { ReadDevice, ResourceReadStats } from '../types/resource-read';
import type { DeviceStatusDisplay } from '../types/resource-status';
import type { LedgerCounts, ResourceLedgerRow } from '../types/resource-ledger';
import type { ResourceReadFilter } from '../types/resource-read';
import { matchesLedgerClassification, matchesLedgerAlert, matchesLedgerFrequency } from './resource-ledger-filter';

export function projectLedgerRows(resources: ResourcesData, display: (device: Device) => DeviceStatusDisplay | undefined): ResourceLedgerRow[] {
  const stations = new Map(resources.stations.map(row => [row.id, row]));
  const models = new Map(resources.models.map(row => [row.id, row]));
  const antennas = new Map(resources.antennas.map(row => [row.id, row]));
  return resources.devices.map(device => {
    const station = stations.get(device.stationId)!, model = models.get(device.modelId)!, statusDisplay = display(device);
    return { ...device, kind: 'device', origin: device.origin ?? null, availability: device.availability ?? null,
      stationName: station.name, stationCoordinate: station.coordinate, modelName: model.name,
      deviceClass: model.deviceClass, antennaName: antennas.get(device.antennaId)?.name ?? '',
      region: station.region, mobility: station.mobility, nodeRole: station.role ?? null, relayCapable: station.relayCapable,
      freqMinKhz: model.freqMinKhz, freqMaxKhz: model.freqMaxKhz, statusDisplay,
      displayedStatus: statusDisplay ? statusDisplay.status ?? 'UNKNOWN' : device.status ?? 'UNKNOWN' };
  });
}
// 两种适配器都投影为同一行模型，缺失关联值不参与推断。
export function projectReadLedgerRows(rows: ReadDevice[]): ResourceLedgerRow[] {
  return rows.map(row => ({ ...row, region: row.region ?? null, mobility: row.mobility ?? null, nodeRole: row.nodeRole ?? null, relayCapable: row.relayCapable ?? null,
    freqMinKhz: row.freqMinKhz ?? null, freqMaxKhz: row.freqMaxKhz ?? null, displayedStatus: row.statusDisplay ? row.statusDisplay.status ?? 'UNKNOWN' : row.status ?? 'UNKNOWN' }));
}
// 完整筛选发生在服务边界，组件只绑定当前页；导出复用相同条件。
export function matchesLedgerQuery(row: ResourceLedgerRow, query: ResourceReadFilter) {
  return (!query.deviceClass || row.deviceClass === query.deviceClass)
    && (!query.status || row.displayedStatus === query.status)
    && (!query.availability || (query.availability === 'UNKNOWN' ? row.availability == null : row.availability === query.availability))
    && matchesLedgerClassification(row, { mobility: query.mobility ?? '', role: query.nodeRole ?? '', relay: query.relayCapable === undefined ? '' : query.relayCapable ? 'YES' : 'NO' })
    && matchesLedgerAlert(row.statusDisplay ?? row, query.alert ?? 'ALL')
    && (!query.frequency || matchesLedgerFrequency(row, query.frequency))
    && (!query.search || `${row.id} ${row.modelName} ${row.stationName}`.toLowerCase().includes(query.search.trim().toLowerCase()));
}
// 台账统计直接采用服务结果，缺失值保持未知。
export function readLedgerCounts(stats?: ResourceReadStats): LedgerCounts {
  return { devices: stats?.devices ?? null, nodes: stats?.nodes ?? null, models: stats?.models ?? null,
    alerts: stats?.alerts ?? null, hf: stats?.hf ?? null, vuhf: stats?.vuhf ?? null, deployments: stats?.deployments ?? null };
}
