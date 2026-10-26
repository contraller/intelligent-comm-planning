import type { Device, NetworkLink, OperationalStatus, Station } from './domain';
import type { PlanningConfiguration } from './planning';
import type { SpectrumSource } from './spectrum';
import type { LinkStateAssessment } from './link-assessment';

// 观测与配置分开：网络、采集源及每帧身份都可追溯，刷新不产生业务写入。
export interface ObservationSource {
  state: 'CURRENT' | 'HISTORICAL' | 'UNKNOWN';
  reasons: string[];
}
export interface MonitoringNetwork {
  key: string;
  kind: 'DEMO' | 'PLAN';
  taskId: string | null;
  planId: string | null;
  version: string;
  name: string;
  presetId: string;
  stations: Station[];
  devices: Device[];
  links: NetworkLink[];
  configuration: PlanningConfiguration;
}
export interface DistributionBin { label: string; count: number }
export interface DeviceObservation {
  deviceId: string;
  stationId: string;
  status: OperationalStatus;
  online: boolean;
  alarm: boolean;
  txPowerDbm: number | null;
  frequencyKhz: number | null;
  violations: { field: 'txPowerDbm' | 'frequencyKhz'; message: string }[];
}
export interface LinkObservation {
  // 当前采样的服务解释，不能用于重算观测等级。
  assessment?: LinkStateAssessment | null;
  linkId: string;
  state: NetworkLink['state'];
  snrDb: number | null;
  ber: number | null;
  packetLossRate: number | null;
  delayMs: number | null;
  throughputKbps: number | null;
}
export interface NetworkObservationFrame {
  id: string;
  observedAt: string;
  label: string;
  devices: DeviceObservation[];
  links: LinkObservation[];
  statistics: {
    devices: { total: number; normal: number; fault: number; offline: number; online: number; alarms: number };
    links: Record<NetworkLink['state'], number>;
    power: DistributionBin[];
    frequency: DistributionBin[];
  };
  alerts: { id: string; deviceId: string | null; linkId: string | null; level: 'WARNING' | 'FAULT'; message: string }[];
}
export interface MonitoringContext {
  taskId: string | null;
  network: MonitoringNetwork | null;
  source: ObservationSource;
  intervalSeconds: number | null;
  frameCount: number;
  message: string;
  errorCode: string | null;
}
export interface MonitoringFrameRequest { taskId: string | null; networkKey: string; index: number }
export interface MonitoringFrameResult { context: MonitoringContext; index: number; frame: NetworkObservationFrame }
// 周期帧只核对网络身份；结构由独立上下文提供。
export interface MonitoringObservation { networkKey: string; context: Omit<MonitoringContext,'network'>; index: number; frame: NetworkObservationFrame }
export interface SpectrumObservationBin {
  id: string;
  minKhz: number;
  maxKhz: number;
  occupancyPercent: number;
  powerDbm: number;
  abnormal: boolean;
  reason: string | null;
}
export interface SpectrumObservationFrame {
  id: string;
  observedAt: string;
  label: string;
  bins: SpectrumObservationBin[];
  occupancyPercent: number;
  abnormalBandCount: number;
}
// 监控只接收展示所需配置，不暴露接入地址或系统的其他配置。
export interface SpectrumMonitoringSource extends Omit<SpectrumSource, 'endpoint'> {
  checkId: string | null;
  checkedAt: string | null;
  eligible: boolean;
  reason: string;
  presetId: string | null;
  frameCount: number;
}
export interface SpectrumMonitoringContext {
  revision: string | null;
  sources: SpectrumMonitoringSource[];
  source: ObservationSource;
}
export interface SpectrumFrameRequest { sourceId: string; configRevision: string; index: number }
export interface SpectrumFrameResult {
  source: SpectrumMonitoringSource;
  index: number;
  frame: SpectrumObservationFrame;
}
export interface MonitoringServices {
  getMonitoringObservation(request: MonitoringFrameRequest): Promise<MonitoringObservation>;
  loadMonitoringContext(taskId: string | null): Promise<MonitoringContext>;
  getMonitoringFrame(request: MonitoringFrameRequest): Promise<MonitoringFrameResult>;
  loadSpectrumMonitoringContext(): Promise<SpectrumMonitoringContext>;
  getSpectrumObservationFrame(request: SpectrumFrameRequest): Promise<SpectrumFrameResult>;
}
