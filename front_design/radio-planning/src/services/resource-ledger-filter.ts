// 保留台账原有导出名称，共用纯频率规则而不改变台账状态或交互。
export type {
  DeviceFrequencyMode as LedgerFrequencyMode,
  DeviceFrequencyPresence as LedgerFrequencyPresence,
  DeviceFrequencyInput as LedgerFrequencyInput,
  DeviceFrequencyFilter as LedgerFrequencyFilter,
  DeviceFrequencySource as LedgerFrequencySource,
} from './device-frequency-filter';
export {
  emptyDeviceFrequencyInput as emptyLedgerFrequencyInput,
  emptyDeviceFrequencyFilter as emptyLedgerFrequencyFilter,
  parseDeviceFrequency as parseLedgerFrequency,
  matchesDeviceFrequency as matchesLedgerFrequency,
  deviceFrequencySummary as ledgerFrequencySummary,
} from './device-frequency-filter';

export type LedgerAlertFilter = 'ALL' | 'YES' | 'NO' | 'UNKNOWN';
// 未提供告警不能匹配“无告警”，原布尔值规则保持不变。
export function matchesLedgerAlert(device: { alert: boolean | null }, filter: LedgerAlertFilter) {
  return filter === 'ALL' || (filter === 'UNKNOWN' ? device.alert === null : filter === 'YES' ? device.alert === true : device.alert === false);
}
