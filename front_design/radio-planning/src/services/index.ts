import { env } from '../config/env';
import { httpService, releaseHttpSessionBinding } from './http';
import { mockService } from './mock';
import { createAccessService } from './access';
import { operationLogger } from './operation-log';
import { ApiError, type PreviewService } from './types';

function selectedService(): PreviewService {
  if (env.mode === 'mock') return mockService;
  if (env.mode === 'http') return httpService;
  throw new ApiError(`未知数据模式：${env.mode}`, 'INVALID_MODE');
}

// 仅在用户明确丢弃本页面现场后调用；不修改共享 Cookie，也不发出退出请求。
export function releasePageSessionBinding() {
  if (env.mode === 'http') releaseHttpSessionBinding();
}

const dispatchService: PreviewService = {
  // 配置入口仍经过统一模式、权限及操作日志包装。
  loadDeviceConfigurationContext: (...args) => selectedService().loadDeviceConfigurationContext(...args),
  validateDeviceConfiguration: (...args) => selectedService().validateDeviceConfiguration(...args),
  submitDeviceConfiguration: (...args) => selectedService().submitDeviceConfiguration(...args),
  getDeviceConfigurationOperation: (...args) => selectedService().getDeviceConfigurationOperation(...args),
  queryDeviceConfigurationOperations: (...args) => selectedService().queryDeviceConfigurationOperations(...args),
  // 状态读取沿用当前模式及统一权限包装，不写资源配置。
  loadDeviceStatusContext: (...args) => selectedService().loadDeviceStatusContext(...args),
  queryDeviceStatuses: (...args) => selectedService().queryDeviceStatuses(...args),
  // 新契约独立分派，不向旧工作区填入分页数据。
  queryTaskInputs: (...args) => selectedService().queryTaskInputs(...args),
  getTaskInput: (...args) => selectedService().getTaskInput(...args),
  saveTaskInput: (...args) => selectedService().saveTaskInput(...args),
  validateTaskInputApi: (...args) => selectedService().validateTaskInputApi(...args),
  previewTaskInputImport: (...args) => selectedService().previewTaskInputImport(...args),
  getTaskInputTemplate: (...args) => selectedService().getTaskInputTemplate(...args),
  getPlanningOperation: (...args) => selectedService().getPlanningOperation(...args),
  loadPlanningCatalog: (...args) => selectedService().loadPlanningCatalog(...args),
  submitPlanningTask: (...args) => selectedService().submitPlanningTask(...args),
  getPlanningTask: (...args) => selectedService().getPlanningTask(...args),
  cancelPlanningTask: (...args) => selectedService().cancelPlanningTask(...args),
  queryPlanningPlans: (...args) => selectedService().queryPlanningPlans(...args),
  getPlanningPlan: (...args) => selectedService().getPlanningPlan(...args),
  savePlanningPlan: (...args) => selectedService().savePlanningPlan(...args),
  confirmPlanningPlan: (...args) => selectedService().confirmPlanningPlan(...args),
  comparePlanningPlans: (...args) => selectedService().comparePlanningPlans(...args),
  exportPlanningPlan: (...args) => selectedService().exportPlanningPlan(...args),
  getPlanningCoverageImage: (...args) => selectedService().getPlanningCoverageImage(...args),
  // 资源读取复用会话、权限与模式选择，不向全量编辑对象灌入分页片段。
  loadResourceReadContext: (...args) => selectedService().loadResourceReadContext(...args),
  queryResourceDevices: (...args) => selectedService().queryResourceDevices(...args),
  queryResourceNodes: (...args) => selectedService().queryResourceNodes(...args),
  queryResourceInterferences: (...args) => selectedService().queryResourceInterferences(...args),
  getResourceObject: (...args) => selectedService().getResourceObject(...args),
  queryResourceMap: (...args) => selectedService().queryResourceMap(...args),
  // 监控读取与现有业务共用模式分派，不在组件内读取配置或样例。
  loadMonitoringContext: (...args) => selectedService().loadMonitoringContext(...args),
  getMonitoringFrame: (...args) => selectedService().getMonitoringFrame(...args),
  loadSpectrumMonitoringContext: (...args) => selectedService().loadSpectrumMonitoringContext(...args),
  getSpectrumObservationFrame: (...args) => selectedService().getSpectrumObservationFrame(...args),
  // 干扰流程复用统一数据源与访问包装。
  loadInterferenceWorkspace: (...args) => selectedService().loadInterferenceWorkspace(...args),
  loadInterferenceSources: (...args) => selectedService().loadInterferenceSources(...args),
  submitInterferenceAnalysis: (...args) => selectedService().submitInterferenceAnalysis(...args),
  getInterferenceAnalysis: (...args) => selectedService().getInterferenceAnalysis(...args),
  cancelInterferenceAnalysis: (...args) => selectedService().cancelInterferenceAnalysis(...args),
  adoptInterferenceMeasure: (...args) => selectedService().adoptInterferenceMeasure(...args),
  // 任务入口与其他业务共用模式分派，不在页面读取本地记录。
  async loadTaskWorkspace(){return selectedService().loadTaskWorkspace();},
  async saveTask(request){return selectedService().saveTask(request);},
  async commitGisWorkspace(request){return selectedService().commitGisWorkspace(request);},
  async getTaskTemplate(format,kind){return selectedService().getTaskTemplate(format,kind);},
  async previewTaskImport(request){return selectedService().previewTaskImport(request);},
  async exportPlanVersion(request){return selectedService().exportPlanVersion(request);},
  // 本批资源与频谱始终使用同一模式的契约。
  getResourceTemplate: (...args) => selectedService().getResourceTemplate(...args),
  previewResourceImport: (...args) => selectedService().previewResourceImport(...args),
  commitResourceImport: (...args) => selectedService().commitResourceImport(...args),
  exportResources: (...args) => selectedService().exportResources(...args),
  setDeviceAvailability: (...args) => selectedService().setDeviceAvailability(...args),
  loadSpectrumWorkspace: (...args) => selectedService().loadSpectrumWorkspace(...args),
  saveSpectrumSource: (...args) => selectedService().saveSpectrumSource(...args),
  checkSpectrumSource: (...args) => selectedService().checkSpectrumSource(...args),
  resetSpectrumWorkspace: (...args) => selectedService().resetSpectrumWorkspace(...args),
  getLoginCatalog: (...args) => selectedService().getLoginCatalog(...args),
  login: (...args) => selectedService().login(...args),
  logout: (...args) => selectedService().logout(...args),
  getSession: (...args) => selectedService().getSession(...args),
  loadSystemCatalog: (...args) => selectedService().loadSystemCatalog(...args),
  querySystemAccounts: (...args) => selectedService().querySystemAccounts(...args),
  saveSystemAccount: (...args) => selectedService().saveSystemAccount(...args),
  setSystemAccountState: (...args) => selectedService().setSystemAccountState(...args),
  querySystemRoles: (...args) => selectedService().querySystemRoles(...args),
  saveSystemRole: (...args) => selectedService().saveSystemRole(...args),
  querySystemParameters: (...args) => selectedService().querySystemParameters(...args),
  saveSystemParameter: (...args) => selectedService().saveSystemParameter(...args),
  queryOperationLogs: (...args) => selectedService().queryOperationLogs(...args),
  resetSystemWorkspace: (...args) => selectedService().resetSystemWorkspace(...args),
  recoverSystemWorkspace: (...args) => selectedService().recoverSystemWorkspace(...args),
  resetOperationLogs: (...args) => selectedService().resetOperationLogs(...args),
  // 知识的读写和检索使用同一数据模式。
  loadKnowledgeWorkspace: (...args) => selectedService().loadKnowledgeWorkspace(...args),
  searchKnowledge: (...args) => selectedService().searchKnowledge(...args),
  getKnowledgeEntity: (...args) => selectedService().getKnowledgeEntity(...args),
  queryKnowledgeGraph: (...args) => selectedService().queryKnowledgeGraph(...args),
  getDeviceKnowledge: (...args) => selectedService().getDeviceKnowledge(...args),
  saveKnowledgeChange: (...args) => selectedService().saveKnowledgeChange(...args),
  submitKnowledgeChange: (...args) => selectedService().submitKnowledgeChange(...args),
  withdrawKnowledgeChange: (...args) => selectedService().withdrawKnowledgeChange(...args),
  reviewKnowledgeChange: (...args) => selectedService().reviewKnowledgeChange(...args),
  publishKnowledgeChange: (...args) => selectedService().publishKnowledgeChange(...args),
  rollbackKnowledgeVersion: (...args) => selectedService().rollbackKnowledgeVersion(...args),
  resetKnowledgeWorkspace: (...args) => selectedService().resetKnowledgeWorkspace(...args),
  // 诊断与文件流程遵循同一数据模式，不在失败时自动回退。
  loadDiagnosisWorkspace: (...args) => selectedService().loadDiagnosisWorkspace(...args),
  loadDiagnosisSources: (...args) => selectedService().loadDiagnosisSources(...args),
  validateDiagnosisScenario: (...args) => selectedService().validateDiagnosisScenario(...args),
  saveDiagnosisScenario: (...args) => selectedService().saveDiagnosisScenario(...args),
  archiveDiagnosisScenario: (...args) => selectedService().archiveDiagnosisScenario(...args),
  getDiagnosisTemplate: (...args) => selectedService().getDiagnosisTemplate(...args),
  previewDiagnosisImport: (...args) => selectedService().previewDiagnosisImport(...args),
  commitDiagnosisImport: (...args) => selectedService().commitDiagnosisImport(...args),
  submitDiagnosis: (...args) => selectedService().submitDiagnosis(...args),
  getDiagnosisRun: (...args) => selectedService().getDiagnosisRun(...args),
  cancelDiagnosisRun: (...args) => selectedService().cancelDiagnosisRun(...args),
  getDiagnosisReport: (...args) => selectedService().getDiagnosisReport(...args),
  exportDiagnosisReport: (...args) => selectedService().exportDiagnosisReport(...args),
  exportDiagnosisImpact: (...args) => selectedService().exportDiagnosisImpact(...args),
  resetDiagnosisWorkspace: (...args) => selectedService().resetDiagnosisWorkspace(...args),
  // 新规划方法保持同一数据源，不在 HTTP 失败时退回演示成功。
  async loadPlanningWorkspace() {
    return selectedService().loadPlanningWorkspace();
  },
  async submitPlanning(request) {
    return selectedService().submitPlanning(request);
  },
  async getPlanningJob(id) {
    return selectedService().getPlanningJob(id);
  },
  async cancelPlanningJob(request) {
    return selectedService().cancelPlanningJob(request);
  },
  async savePlanVersion(request) {
    return selectedService().savePlanVersion(request);
  },
  async confirmPlanVersion(request) {
    return selectedService().confirmPlanVersion(request);
  },
  async comparePlanVersions(ids) {
    return selectedService().comparePlanVersions(ids);
  },
  async resetPlanningWorkspace(revision) {
    return selectedService().resetPlanningWorkspace(revision);
  },
  async loadPreview() {
    if (env.mode === 'mock') return mockService.loadPreview();
    if (env.mode === 'http') return httpService.loadPreview();
    throw new ApiError(`未知数据模式：${env.mode}`, 'INVALID_MODE');
  },
  async commitResources(request) {
    if (env.mode === 'mock') return mockService.commitResources(request);
    if (env.mode === 'http') return httpService.commitResources(request);
    throw new ApiError(`未知数据模式：${env.mode}`, 'INVALID_MODE');
  },
  async resetResources(baseRevision) {
    if (env.mode === 'mock') return mockService.resetResources(baseRevision);
    if (env.mode === 'http') return httpService.resetResources(baseRevision);
    throw new ApiError(`未知数据模式：${env.mode}`, 'INVALID_MODE');
  },
};

// 统一入口按当前会话授权，HTTP 模式不向本地 Mock 日志写入成功记录。
export const previewService = createAccessService(() => dispatchService,env.mode === 'mock' ? operationLogger : null);
