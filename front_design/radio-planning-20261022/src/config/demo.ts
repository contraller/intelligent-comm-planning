// 演示边界沿用附件规划区域，坐标顺序为 [经度, 纬度]。
export const DEMO_BBOX = [114.0465, 36.911, 115.4045, 37.989] as const;
export const RESOURCE_STORAGE_KEY = 'radio-planning:resource-workspace';
export const RESOURCE_SCHEMA_VERSION = 6;
// 配置操作与待核实请求独立保存，资源重置不清除此记录。
export const DEVICE_CONFIGURATION_STORAGE_KEY = 'radio-planning:device-configuration-workspace';
export const DEVICE_CONFIGURATION_PENDING_KEY = 'radio-planning:device-configuration-pending';
export const DEVICE_CONFIGURATION_SCHEMA_VERSION = 1;
export const DEVICE_CONFIGURATION_PRESET_VERSION = 'device-configuration-demo-2';
export const DEVICE_CONFIGURATION_PHASE_MS = 1500;
export const DEVICE_CONFIGURATION_POLL_MS = 1000;
export const DEVICE_CONFIGURATION_PAGE_SIZE = 20;
// 规划工作区独立持久化；时间轴只用于演示，不执行规划算法。
export const PLANNING_STORAGE_KEY = 'radio-planning:planning-workspace';
export const PLANNING_SCHEMA_VERSION = 2;
export const PLANNING_PRESET_VERSION = 'planning-demo-1';
export const PLANNING_PHASE_MS = 1500;
export const PLANNING_POLL_MS = 1000;
export const PLANNING_TTL_MS = 24 * 60 * 60 * 1000;
// 诊断独立保存冻结快照；结果不采用规划临时结果的过期时间。
export const DIAGNOSIS_STORAGE_KEY = 'radio-planning:diagnosis-workspace';
export const DIAGNOSIS_SCHEMA_VERSION = 1;
// 诊断读写只采用当前预设，旧格式报错且不改写原记录。
export const DIAGNOSIS_PRESET_VERSION = 'diagnosis-demo-2';
export const DIAGNOSIS_PHASE_MS = 1500;
export const DIAGNOSIS_POLL_MS = 1000;
export const DIAGNOSIS_MAX_FAULTS = 20;
export const DIAGNOSIS_MAX_IMPORT_SCENARIOS = 20;
export const DIAGNOSIS_MAX_FILE_BYTES = 5 * 1024 * 1024;
// 知识发布独立保存全量快照，画布限制只影响展示，不截断存储。
export const KNOWLEDGE_STORAGE_KEY = 'radio-planning:knowledge-workspace';
export const KNOWLEDGE_SCHEMA_VERSION = 3;
export const KNOWLEDGE_PRESET_VERSION = 'knowledge-demo-3';
export const KNOWLEDGE_PAGE_SIZE = 20;
export const KNOWLEDGE_MAX_NODES = 60;
export const KNOWLEDGE_MAX_EDGES = 120;
export const KNOWLEDGE_MAX_OPERATIONS = 30;
// 系统配置、操作日志及标签页会话独立保存，重置不能清除业务工作区。
export const SYSTEM_STORAGE_KEY = 'radio-planning:system-workspace';
export const OPERATION_LOG_KEY = 'radio-planning:operation-logs';
export const SESSION_STORAGE_KEY = 'radio-planning:session';
export const SYSTEM_SCHEMA_VERSION = 1;
// 新预设只接受当前配置，旧浏览器配置由用户明确初始化。
export const SYSTEM_PRESET_VERSION = 'system-demo-2';
export const SYSTEM_PAGE_SIZE = 20;

// 资源文件限制与频谱工作区独立，不影响原业务轮询。
export const RESOURCE_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const RESOURCE_MAX_IMPORT_ROWS = 5000;
export const SPECTRUM_STORAGE_KEY = 'radio-planning:spectrum-workspace';
export const SPECTRUM_SCHEMA_VERSION = 1;

// 单任务文件沿用资源文件规模限制。
export const TASK_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const TASK_MAX_DEMANDS = 5000;

// 分析结果和采纳回执同规划记录保存，不增加第二个事务写入点。
export const INTERFERENCE_PRESET_VERSION = 'interference-demo-1';
export const INTERFERENCE_PHASE_MS = 1500;
export const INTERFERENCE_POLL_MS = 1000;

// 态势只播放有限的独立观测；采集周期读取已保存配置，不修改其他轮询。
export const MONITORING_PRESET_VERSION = 'monitoring-demo-1';
export const SPECTRUM_MONITORING_BANDS = [
  { id: 'hf-observation', label: 'HF 教学频段', minKhz: 6000, maxKhz: 10000 },
  { id: 'vuhf-observation', label: 'VUHF 教学频段', minKhz: 30000, maxKhz: 88000 },
] as const;
