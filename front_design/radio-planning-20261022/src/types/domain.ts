import type { ResourceMeta } from './resource-edit';
import type { PlanWorkflow } from './planning';
import type { PlanningCoverage } from './coverage';
import type { PlanningResultDetails } from './planning-result-details';
import type { DeviceDetailCatalog } from './device-detail';
import type { DeviceNetworkCatalog } from './device-network';
import type { LinkDetailCatalog } from './link-detail';
import type { CandidateLink } from './candidate-link';

// 前端预览契约 v0.1；对外坐标固定为 WGS84 [经度, 纬度]。
export type Coordinate = [number, number];
export type DeviceClass = 'HF' | 'VUHF';
export type OperationalStatus = 'NORMAL' | 'FAULT' | 'OFFLINE';
export type ResourceOrigin = 'SOURCE' | 'MANUAL' | 'IMPORT';
export type Availability = 'ACTIVE' | 'OFF_SHELF';
// 补充字段不回填已有方案快照；缺失生命周期按初始在架解释。
export interface Station {
  subtype?: string;
  role?: string;
  remark?: string;
  origin?: ResourceOrigin;
  id: string;
  name: string;
  echelon: string;
  parentIds: string[];
  coordinate: Coordinate;
  elevationM: number | null;
  region: string;
  classes: DeviceClass[];
  status: OperationalStatus | null;
  alert: boolean | null;
  relayCapable: boolean;
  key: boolean;
  mobility: string;
}
export interface Device {
  // 未提供不等于默认模式；端口仅保存维护值，不存观测状态。
  currentWorkMode?: string | null;
  ports?: import('./device-maintenance').DevicePort[] | null;
  availability?: Availability;
  origin?: ResourceOrigin;
  tiltDeg?: number | null;
  azimuthDeg?: number | null;
  id: string;
  stationId: string;
  modelId: string;
  antennaId: string;
  status: OperationalStatus | null;
  alert: boolean | null;
  antennaHeightM: number | null;
  txPowerDbm: number | null;
  workFreqKhz: number | null;
  installedAt: string;
}
export interface DeviceModel {
  id: string;
  name: string;
  manufacturer: string;
  deviceClass: DeviceClass;
  freqMinKhz: number;
  freqMaxKhz: number;
  txPowerMaxDbm: number;
  modulation: string[];
  workMode: string[];
}
export interface Antenna {
  id: string;
  name: string;
}
export interface InterferenceSource {
  id: string; name: string; coordinate: Coordinate; elevationM: number | null;
  antennaHeightM: number; centerFreqKhz: number; bandwidthKhz: number; txPowerDbm: number;
  antennaGainDbi: number | null; interferenceType: string; patternType: string | null;
  azimuthDeg: number | null; dutyCycle: number | null; active: boolean; origin: ResourceOrigin;
}
export interface ResourcesData {
  // HTTP 缺失保持缺失；仅 Mock 初始化与旧记录读取补来源目录。
  candidateLinks?: CandidateLink[];
  interferences?: InterferenceSource[];
  stations: Station[];
  devices: Device[];
  models: DeviceModel[];
  antennas: Antenna[];
  source: string;
  version: string;
}
export interface NetworkLink {
  id: string;
  // 由数据明确给出主干身份；缺失或 null 表示未知，地图保留显示。
  isBackbone?: boolean | null;
  a: string;
  b: string;
  deviceA: string;
  deviceB: string;
  state: 'EXCELLENT' | 'GOOD' | 'WARNING' | 'FAULT';
  deviceClass: DeviceClass;
  frequencyKhz: number;
  backup: boolean;
}
export interface MapRegion {
  id: string;
  label: string;
  kind: 'coverage' | 'blind' | 'uncalculated' | 'impact';
  // Polygon 的首环为外轮廓，其余为孔洞；均为预生成结果。
  rings: Coordinate[][];
}
export interface SituationData {
  // 链路指标独立绑定当前网络；旧快照缺失时明确显示暂无资料。
  linkDetails?: LinkDetailCatalog;
  // 关联业务与本态势快照绑定；旧网络缺失时不从其他方案补配。
  deviceNetwork?: DeviceNetworkCatalog;
  title: string;
  snapshotId: string;
  updatedAt: string;
  links: NetworkLink[];
  candidateLinks: NetworkLink[];
  regions: MapRegion[];
  alerts: { id: string; stationId: string; title: string; level: string; time: string }[];
  spectrum: { id: string; name: string; endpoint: string; interval: string; state: string }[];
}
export interface PlanVersion {
  // 后端核验过的方案地形；缺失时禁止借用当前资源底图。
  terrain?: import('./resource-read').ResourceTerrain | null;
  terrainNotice?: string;
  // 单次作业中所选完整结果的身份，不代替保存版本ID。
  solutionId?: string;
  // 保存结果自己的补充明细，不随当前教学资产变更。
  resultDetails?: PlanningResultDetails;
  // 仅保存此方案自己的覆盖元数据，不携带图片字节。
  coverage?: PlanningCoverage;
  workflow?: PlanWorkflow;
  // 历史方案只读取保存时的输入快照，不追随当前资源变化。
  inputSnapshot: { stations: Station[]; devices: Device[] };
  id: string;
  name: string;
  taskId: string;
  jobId: string | null;
  snapshotId: string;
  version: string;
  preset: string;
  state: string;
  sourceChanged: boolean;
  stationIds: string[];
  links: NetworkLink[];
  regions: MapRegion[];
  metrics: {
    // 冻结结果允许未计算指标；展示端不能用 0 代替未知。
    coveragePercent: number | null;
    connectivityPercent: number | null;
    survivabilityPercent: number | null;
    totalRadiatedPowerW: number | null;
    delayMs: number | null;
  };
  notes: string[];
}
export interface PlanningData {
  task: {
    id: string;
    name: string;
    region: string;
    service: string;
    priority: string;
    constraints: string[];
  };
  plans: PlanVersion[];
}
export interface DiagnosisCase {
  id: string;
  name: string;
  type: string;
  snapshotId: string;
  planVersionId: string;
  stationIds: string[];
  deviceIds: string[];
  linkIds: string[];
  confidence: number;
  severity: string;
  conclusion: string;
  branches: { name: string; result: string; confidence: number | null }[];
  evidence: { id: string; label: string; value: string; source: string }[];
  chain: string[];
  suggestions: string[];
  impact: string;
  regions: MapRegion[];
}
export interface DiagnosisData {
  cases: DiagnosisCase[];
}
export interface KnowledgeEntity {
  id: string;
  name: string;
  category: string;
  type: string;
  description: string;
  state: string;
  version: string;
}
export interface KnowledgeData {
  entities: KnowledgeEntity[];
  relations: { id: string; source: string; target: string; label: string }[];
  versions: { id: string; name: string; state: string; author: string; time: string }[];
}
export interface SystemData {
  accounts: {
    id: string;
    name: string;
    role: string;
    department: string;
    state: string;
    lastLogin: string;
  }[];
  roles: { id: string; name: string; description: string; permissions: string[] }[];
  logs: {
    id: string;
    time: string;
    user: string;
    module: string;
    action: string;
    result: string;
  }[];
  parameters: { id: string; name: string; value: string; unit: string; description: string }[];
}
export interface PreviewData {
  // 只读资料目录单独提供，不并入资源记录或回填历史方案。
  deviceDetails?: DeviceDetailCatalog;
  resources: ResourcesData;
  resourceMeta: ResourceMeta;
  situation: SituationData;
  planning: PlanningData;
  diagnosis: DiagnosisData;
  knowledge: KnowledgeData;
  system: SystemData;
}
