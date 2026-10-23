// 型号资料独立于设备当前配置及规划快照；空值表示来源未提供，不补零或默认值。
export interface DeviceModelDetail {
  modelId: string;
  category: string | null;
  txPowerLevelsDbm: number[] | null;
  rxSensitivityDbm: number | null;
  bandwidthKhz: number[] | null;
  serviceTypes: string[] | null;
  dataRatesKbps: number[] | null;
  constraintNote: string | null;
  sourceDoc: string | null;
}
export interface AntennaDetail {
  antennaId: string;
  gainDbi: number | null;
}
export interface DeviceDetailCatalog {
  version: string;
  // 文件路径和哈希用于核对来源；界面不将缺失说明书文件名变成下载链接。
  sources: { path: string; sha256: string }[];
  models: DeviceModelDetail[];
  antennas: AntennaDetail[];
}
