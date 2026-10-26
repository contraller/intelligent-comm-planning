import { env } from '../config/env';
import { httpService, releaseHttpSessionBinding } from './http';
export { loadIntegrationIdentities, switchIntegrationIdentity } from './http';
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
  getDeviceNetworkDetail: (...args) => selectedService().getDeviceNetworkDetail(...args),
  getDeviceMaintenance: (...args) => selectedService().getDeviceMaintenance(...args),
  queryDeviceHistory: (...args) => selectedService().queryDeviceHistory(...args),
  getDeviceHistory: (...args) => selectedService().getDeviceHistory(...args),
  previewDeviceRestore: (...args) => selectedService().previewDeviceRestore(...args),
  getGisCoverageCatalog: (...args) => selectedService().getGisCoverageCatalog(...args),
  loadSystemOptions: (...args) => selectedService().loadSystemOptions(...args),
  queryAccountSummaries: (...args) => selectedService().queryAccountSummaries(...args),
  queryRoleSummaries: (...args) => selectedService().queryRoleSummaries(...args),
  queryParameterSummaries: (...args) => selectedService().queryParameterSummaries(...args),
  queryOperationSummaries: (...args) => selectedService().queryOperationSummaries(...args),
  getSystemAccount: (...args) => selectedService().getSystemAccount(...args),
  getSystemRole: (...args) => selectedService().getSystemRole(...args),
  getSystemParameter: (...args) => selectedService().getSystemParameter(...args),
  getOperationEvent: (...args) => selectedService().getOperationEvent(...args),
  loadKnowledgeMetadata: (...args) => selectedService().loadKnowledgeMetadata(...args),
  searchKnowledgeSummaries: (...args) => selectedService().searchKnowledgeSummaries(...args),
  getKnowledgeGraph: (...args) => selectedService().getKnowledgeGraph(...args),
  queryKnowledgeChanges: (...args) => selectedService().queryKnowledgeChanges(...args),
  queryKnowledgeVersions: (...args) => selectedService().queryKnowledgeVersions(...args),
  queryKnowledgeLogs: (...args) => selectedService().queryKnowledgeLogs(...args),
  getKnowledgeChange: (...args) => selectedService().getKnowledgeChange(...args),
  getKnowledgeVersion: (...args) => selectedService().getKnowledgeVersion(...args),
  saveKnowledgeReceipt: (...args) => selectedService().saveKnowledgeReceipt(...args),
  submitKnowledgeReceipt: (...args) => selectedService().submitKnowledgeReceipt(...args),
  withdrawKnowledgeReceipt: (...args) => selectedService().withdrawKnowledgeReceipt(...args),
  reviewKnowledgeReceipt: (...args) => selectedService().reviewKnowledgeReceipt(...args),
  publishKnowledgeReceipt: (...args) => selectedService().publishKnowledgeReceipt(...args),
  rollbackKnowledgeReceipt: (...args) => selectedService().rollbackKnowledgeReceipt(...args),
  resetKnowledgeReceipt: (...args) => selectedService().resetKnowledgeReceipt(...args),
  loadDiagnosisContext: (...args) => selectedService().loadDiagnosisContext(...args),
  loadDiagnosisSourceOptions: (...args) => selectedService().loadDiagnosisSourceOptions(...args),
  getDiagnosisSource: (...args) => selectedService().getDiagnosisSource(...args),
  queryDiagnosisScenarios: (...args) => selectedService().queryDiagnosisScenarios(...args),
  queryDiagnosisHistory: (...args) => selectedService().queryDiagnosisHistory(...args),
  getDiagnosisVersion: (...args) => selectedService().getDiagnosisVersion(...args),
  getDiagnosisPreset: (...args) => selectedService().getDiagnosisPreset(...args),
  getDiagnosisProgress: (...args) => selectedService().getDiagnosisProgress(...args),
  getDiagnosisDetail: (...args) => selectedService().getDiagnosisDetail(...args),
  getDiagnosisStage: (...args) => selectedService().getDiagnosisStage(...args),
  saveDiagnosisReceipt: (...args) => selectedService().saveDiagnosisReceipt(...args),
  archiveDiagnosisReceipt: (...args) => selectedService().archiveDiagnosisReceipt(...args),
  importDiagnosisReceipt: (...args) => selectedService().importDiagnosisReceipt(...args),
  submitDiagnosisReceipt: (...args) => selectedService().submitDiagnosisReceipt(...args),
  submitDiagnosisImpactReceipt: (...args) => selectedService().submitDiagnosisImpactReceipt(...args),
  submitDiagnosisFeedback: (...args) => selectedService().submitDiagnosisFeedback(...args),
  cancelDiagnosisReceipt: (...args) => selectedService().cancelDiagnosisReceipt(...args),
  resetDiagnosisReceipt: (...args) => selectedService().resetDiagnosisReceipt(...args),
  queryDeviceConfigurationHistory: (...args) => selectedService().queryDeviceConfigurationHistory(...args),
  submitDeviceConfigurationReceipt: (...args) => selectedService().submitDeviceConfigurationReceipt(...args),
  getDeviceConfigurationProgress: (...args) => selectedService().getDeviceConfigurationProgress(...args),
  loadDeviceStatusOptions: (...args) => selectedService().loadDeviceStatusOptions(...args),
  synchronizeDeviceStatuses: (...args) => selectedService().synchronizeDeviceStatuses(...args),
  queryDeviceStatusBatch: (...args) => selectedService().queryDeviceStatusBatch(...args),
  querySpectrumSources: (...args) => selectedService().querySpectrumSources(...args),
  getSpectrumSource: (...args) => selectedService().getSpectrumSource(...args),
  saveSpectrumReceipt: (...args) => selectedService().saveSpectrumReceipt(...args),
  checkSpectrumReceipt: (...args) => selectedService().checkSpectrumReceipt(...args),
  resetSpectrumReceipt: (...args) => selectedService().resetSpectrumReceipt(...args),
  loadInterferenceContext: (...args) => selectedService().loadInterferenceContext(...args),
  queryInterferenceHistory: (...args) => selectedService().queryInterferenceHistory(...args),
  getInterferenceProgress: (...args) => selectedService().getInterferenceProgress(...args),
  getInterferenceDetail: (...args) => selectedService().getInterferenceDetail(...args),
  getInterferenceMeasurePreview: (...args) => selectedService().getInterferenceMeasurePreview(...args),
  submitInterferenceReceipt: (...args) => selectedService().submitInterferenceReceipt(...args),
  cancelInterferenceReceipt: (...args) => selectedService().cancelInterferenceReceipt(...args),
  adoptInterferenceReceipt: (...args) => selectedService().adoptInterferenceReceipt(...args),
  getMonitoringObservation: (...args) => selectedService().getMonitoringObservation(...args),
  loadPlanningOptions: (...args) => selectedService().loadPlanningOptions(...args),
  loadPlanningReadContext: (...args) => selectedService().loadPlanningReadContext(...args),
  getPlanningPreset: (...args) => selectedService().getPlanningPreset(...args),
  getPlanningAdjustmentExamples: (...args) => selectedService().getPlanningAdjustmentExamples(...args),
  getPlanningTaskProgress: (...args) => selectedService().getPlanningTaskProgress(...args),
  queryPlanningPlanSummaries: (...args) => selectedService().queryPlanningPlanSummaries(...args),
  queryPlanningReferenceSummaries: (...args) => selectedService().queryPlanningReferenceSummaries(...args),
  submitPlanningReceipt: (...args) => selectedService().submitPlanningReceipt(...args),
  cancelPlanningReceipt: (...args) => selectedService().cancelPlanningReceipt(...args),
  savePlanningReceipt: (...args) => selectedService().savePlanningReceipt(...args),
  confirmPlanningReceipt: (...args) => selectedService().confirmPlanningReceipt(...args),
  resetPlanningReceipt: (...args) => selectedService().resetPlanningReceipt(...args),
  queryTaskSummaries: (...args) => selectedService().queryTaskSummaries(...args),
  saveTaskInputReceipt: (...args) => selectedService().saveTaskInputReceipt(...args),
  getGisLinkDetails: (...args) => selectedService().getGisLinkDetails(...args),
  saveResourceChanges: (...args) => selectedService().saveResourceChanges(...args),
  applyResourceImport: (...args) => selectedService().applyResourceImport(...args),
  updateDeviceAvailability: (...args) => selectedService().updateDeviceAvailability(...args),
  resetResourceData: (...args) => selectedService().resetResourceData(...args),
  loadGisResourceDirectory: (...args) => selectedService().loadGisResourceDirectory(...args),
  loadGisResourceScene: (...args) => selectedService().loadGisResourceScene(...args),
  loadGisResourceEditContext: (...args) => selectedService().loadGisResourceEditContext(...args),
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
  queryPlanningJobs: (...args) => selectedService().queryPlanningJobs(...args),
  querySavedPlanningPlans: (...args) => selectedService().querySavedPlanningPlans(...args),
  queryPlanningReferences: (...args) => selectedService().queryPlanningReferences(...args),
  getPlanningReference: (...args) => selectedService().getPlanningReference(...args),
  comparePlanningReferences: (...args) => selectedService().comparePlanningReferences(...args),
  exportPlanningReference: (...args) => selectedService().exportPlanningReference(...args),
  resetPlanningData: (...args) => selectedService().resetPlanningData(...args),
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
  loadResourceMaintenanceContext: (...args) => selectedService().loadResourceMaintenanceContext(...args),
  previewResourceExport: (...args) => selectedService().previewResourceExport(...args),
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
  // 正式身份扩展也必须经过统一授权；未接入的数据模式明确拒绝，不回退 Mock。
  getSystemOperation: (...args) => {
    const action = selectedService().getSystemOperation;
    if (!action) throw new ApiError('当前数据模式不支持系统操作回执', 'UNSUPPORTED_SYSTEM_ACTION');
    return action(...args);
  },
  changeOwnPassword: (...args) => {
    const action = selectedService().changeOwnPassword;
    if (!action) throw new ApiError('当前数据模式不支持本人密码维护', 'UNSUPPORTED_SYSTEM_ACTION');
    return action(...args);
  },
  maintainSystemAccountPassword: (...args) => {
    const action = selectedService().maintainSystemAccountPassword;
    if (!action) throw new ApiError('当前数据模式不支持账号密码维护', 'UNSUPPORTED_SYSTEM_ACTION');
    return action(...args);
  },
  resetSystemParameters: (...args) => {
    const action = selectedService().resetSystemParameters;
    if (!action) throw new ApiError('当前数据模式不支持参数恢复', 'UNSUPPORTED_SYSTEM_ACTION');
    return action(...args);
  },
  archiveSystemLogs: (...args) => {
    const action = selectedService().archiveSystemLogs;
    if (!action) throw new ApiError('当前数据模式不支持日志视图归档', 'UNSUPPORTED_SYSTEM_ACTION');
    return action(...args);
  },
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
