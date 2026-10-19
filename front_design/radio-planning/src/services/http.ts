import { ApiError, type PreviewService } from './types';
import { env } from '../config/env';
import { createAuthHttp } from './auth-http';
import { createResourceReadHttp } from './resource-read-http';
import { createTaskHttp } from './task-http';
import { createPlanningHttp } from './planning-http';

// 保留既有导出路径；认证、传输与页面会话分别维护，不在入口堆叠实现。
export { createHttpClient } from './http-client';
const authentication = createAuthHttp({ baseUrl: () => env.apiBaseUrl });
export const releaseHttpSessionBinding = () => authentication.releaseSessionBinding();

export const httpService: PreviewService = {
  // 正式配置协议未确认；占位不发真实控制请求，不回落教学成功。
  async loadDeviceConfigurationContext() { throw new ApiError('HTTP 设备配置协议尚未接入', 'NOT_IMPLEMENTED'); },
  async validateDeviceConfiguration() { throw new ApiError('HTTP 设备配置协议尚未接入', 'NOT_IMPLEMENTED'); },
  async submitDeviceConfiguration() { throw new ApiError('HTTP 设备配置协议尚未接入', 'NOT_IMPLEMENTED'); },
  async getDeviceConfigurationOperation() { throw new ApiError('HTTP 设备配置协议尚未接入', 'NOT_IMPLEMENTED'); },
  async queryDeviceConfigurationOperations() { throw new ApiError('HTTP 设备配置协议尚未接入', 'NOT_IMPLEMENTED'); },
  // 设备上报协议尚待确认，占位不发送猜测请求，也不回退 Mock。
  async loadDeviceStatusContext() { throw new ApiError('HTTP 设备状态适配尚未接入', 'NOT_IMPLEMENTED'); },
  async queryDeviceStatuses() { throw new ApiError('HTTP 设备状态适配尚未接入', 'NOT_IMPLEMENTED'); },
  ...createTaskHttp(authentication.authenticatedRequest),
  ...createPlanningHttp(authentication.authenticatedRequest, () => env.apiBaseUrl),
  // 分页读取与全量编辑契约隔离；未接入的写操作继续明确拒绝。
  ...createResourceReadHttp({ baseUrl: () => env.apiBaseUrl }),
  // 观测 DTO、版本关系及采集协议尚待甲方确认，不猜测实际端点。
  async loadMonitoringContext() { throw new ApiError('HTTP 态势观测适配尚未接入', 'NOT_IMPLEMENTED'); },
  async getMonitoringFrame() { throw new ApiError('HTTP 态势观测适配尚未接入', 'NOT_IMPLEMENTED'); },
  async loadSpectrumMonitoringContext() { throw new ApiError('HTTP 频谱观测适配尚未接入', 'NOT_IMPLEMENTED'); },
  async getSpectrumObservationFrame() { throw new ApiError('HTTP 频谱观测适配尚未接入', 'NOT_IMPLEMENTED'); },
  // 原接口尚缺快照、取消和采纳版本语义，不猜测端点。
  async loadInterferenceWorkspace() { throw new ApiError('HTTP 干扰分析及采纳适配尚未接入', 'NOT_IMPLEMENTED'); },
  async loadInterferenceSources() { throw new ApiError('HTTP 干扰分析及采纳适配尚未接入', 'NOT_IMPLEMENTED'); },
  async submitInterferenceAnalysis() { throw new ApiError('HTTP 干扰分析及采纳适配尚未接入', 'NOT_IMPLEMENTED'); },
  async getInterferenceAnalysis() { throw new ApiError('HTTP 干扰分析及采纳适配尚未接入', 'NOT_IMPLEMENTED'); },
  async cancelInterferenceAnalysis() { throw new ApiError('HTTP 干扰分析及采纳适配尚未接入', 'NOT_IMPLEMENTED'); },
  async adoptInterferenceMeasure() { throw new ApiError('HTTP 干扰分析及采纳适配尚未接入', 'NOT_IMPLEMENTED'); },
  // 任务保存、整体提交及文件 DTO 尚待确认，明确拒绝且不回退 Mock。
  async loadTaskWorkspace(){throw new ApiError('HTTP 任务与方案导出适配尚未接入','NOT_IMPLEMENTED');},
  async saveTask(){throw new ApiError('HTTP 任务与方案导出适配尚未接入','NOT_IMPLEMENTED');},
  async commitGisWorkspace(){throw new ApiError('HTTP 任务与方案导出适配尚未接入','NOT_IMPLEMENTED');},
  async getTaskTemplate(){throw new ApiError('HTTP 任务与方案导出适配尚未接入','NOT_IMPLEMENTED');},
  async previewTaskImport(){throw new ApiError('HTTP 任务与方案导出适配尚未接入','NOT_IMPLEMENTED');},
  async exportPlanVersion(){throw new ApiError('HTTP 任务与方案导出适配尚未接入','NOT_IMPLEMENTED');},
  // 资源导入/频谱正式协议待对齐，不向配置 URL 发出采集请求。
  async getResourceTemplate() { throw new ApiError('HTTP 资源及频谱适配尚未接入','NOT_IMPLEMENTED'); },
  async previewResourceImport() { throw new ApiError('HTTP 资源及频谱适配尚未接入','NOT_IMPLEMENTED'); },
  async commitResourceImport() { throw new ApiError('HTTP 资源及频谱适配尚未接入','NOT_IMPLEMENTED'); },
  async exportResources() { throw new ApiError('HTTP 资源及频谱适配尚未接入','NOT_IMPLEMENTED'); },
  async setDeviceAvailability() { throw new ApiError('HTTP 资源及频谱适配尚未接入','NOT_IMPLEMENTED'); },
  async loadSpectrumWorkspace() { throw new ApiError('HTTP 资源及频谱适配尚未接入','NOT_IMPLEMENTED'); },
  async saveSpectrumSource() { throw new ApiError('HTTP 资源及频谱适配尚未接入','NOT_IMPLEMENTED'); },
  async checkSpectrumSource() { throw new ApiError('HTTP 资源及频谱适配尚未接入','NOT_IMPLEMENTED'); },
  async resetSpectrumWorkspace() { throw new ApiError('HTTP 资源及频谱适配尚未接入','NOT_IMPLEMENTED'); },
  // 认证按暂定 Cookie 契约调用；账号管理与演示辅助仍未接入，不回退 Mock。
  async getLoginCatalog() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  login: authentication.login,
  logout: authentication.logout,
  getSession: authentication.getSession,
  async loadSystemCatalog() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async querySystemAccounts() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async saveSystemAccount() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async setSystemAccountState() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async querySystemRoles() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async saveSystemRole() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async querySystemParameters() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async saveSystemParameter() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async queryOperationLogs() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async resetSystemWorkspace() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async recoverSystemWorkspace() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  async resetOperationLogs() { throw new ApiError('HTTP 登录与系统管理适配尚未接入','NOT_IMPLEMENTED'); },
  // 正式知识查询/变更 DTO 尚待对齐；明确拒绝，不猜路径或回退 Mock。
  async loadKnowledgeWorkspace() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async searchKnowledge() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async getKnowledgeEntity() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async queryKnowledgeGraph() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async getDeviceKnowledge() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async saveKnowledgeChange() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async submitKnowledgeChange() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async withdrawKnowledgeChange() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async reviewKnowledgeChange() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async publishKnowledgeChange() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async rollbackKnowledgeVersion() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  async resetKnowledgeWorkspace() { throw new ApiError('HTTP 知识适配尚未接入','NOT_IMPLEMENTED'); },
  // 故障任务查询/取消和报告协议待确认，不调用猜测端点。
  async loadDiagnosisWorkspace() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async loadDiagnosisSources() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async validateDiagnosisScenario() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async saveDiagnosisScenario() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async archiveDiagnosisScenario() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async getDiagnosisTemplate() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async previewDiagnosisImport() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async commitDiagnosisImport() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async submitDiagnosis() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async getDiagnosisRun() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async cancelDiagnosisRun() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async getDiagnosisReport() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async exportDiagnosisReport() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async exportDiagnosisImpact() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  async resetDiagnosisWorkspace() { throw new ApiError('HTTP 诊断适配尚未接入，不会回退 Mock', 'NOT_IMPLEMENTED'); },
  // 规划 DTO 和取消/保存协议待甲方确认，统一拒绝而不请求猜测端点。
  async loadPlanningWorkspace() {
    throw new ApiError('HTTP 规划适配尚未接入', 'NOT_IMPLEMENTED');
  },
  async submitPlanning() {
    throw new ApiError('HTTP 规划提交尚未接入', 'NOT_IMPLEMENTED');
  },
  async getPlanningJob() {
    throw new ApiError('HTTP 规划查询尚未接入', 'NOT_IMPLEMENTED');
  },
  async cancelPlanningJob() {
    throw new ApiError('HTTP 规划取消尚未接入', 'NOT_IMPLEMENTED');
  },
  async savePlanVersion() {
    throw new ApiError('HTTP 方案保存尚未接入', 'NOT_IMPLEMENTED');
  },
  async confirmPlanVersion() {
    throw new ApiError('HTTP 方案确认尚未接入', 'NOT_IMPLEMENTED');
  },
  async comparePlanVersions() {
    throw new ApiError('HTTP 方案对比尚未接入', 'NOT_IMPLEMENTED');
  },
  async resetPlanningWorkspace() {
    throw new ApiError('HTTP 模式不支持本地规划重置', 'NOT_IMPLEMENTED');
  },
  async commitResources() {
    // 批次保存与版本冲突语义待甲方确认，不请求猜测的写入端点。
    throw new ApiError('HTTP 资源保存尚未接入，不会回退到 Mock。', 'NOT_IMPLEMENTED');
  },
  async resetResources() {
    throw new ApiError('HTTP 资源重置尚未接入，不会回退到 Mock。', 'NOT_IMPLEMENTED');
  },
  async loadPreview() {
    // 本批仅准备客户端；未确认业务 DTO 映射前不猜测接口或伪造成功。
    throw new ApiError('HTTP 业务适配尚未接入，请使用 Mock 模式查看本批界面。', 'NOT_IMPLEMENTED');
  },
};
