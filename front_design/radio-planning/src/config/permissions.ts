// 固定权限目录是页面与公开服务共同采用的白名单，未知方法默认拒绝。
const names = {
  'situation.view': '查看 GIS 态势', 'resources.view': '查看资源', 'resources.edit': '维护资源及频谱配置', 'resources.reset': '重置资源',
  'planning.view': '查看规划', 'planning.execute': '维护任务、调整/提交/取消规划', 'planning.save': '保存方案版本', 'planning.confirm': '确认方案', 'planning.reset': '重置规划',
  'diagnosis.view': '查看诊断及报告', 'diagnosis.scenario': '维护/导入场景', 'diagnosis.execute': '提交/取消诊断', 'diagnosis.export': '导出诊断文件', 'diagnosis.reset': '重置诊断',
  'knowledge.view': '查看图谱及型号知识', 'knowledge.edit': '编辑/送审/撤回本人知识', 'knowledge.review': '审核知识', 'knowledge.publish': '发布知识', 'knowledge.rollback': '回滚知识', 'knowledge.reset': '重置知识',
  'system.view': '访问系统管理', 'system.accounts': '维护账号', 'system.roles': '维护角色权限', 'system.logs': '查看操作日志', 'system.parameters': '维护演示参数', 'system.reset': '重置系统配置/日志',
} as const;
export type Permission = keyof typeof names;
const groups: Record<string,string> = { situation:'GIS 态势',resources:'资源',planning:'规划',diagnosis:'诊断',knowledge:'知识',system:'系统' };
export const permissions = (Object.keys(names) as Permission[]).map(code => {
  const [group,action] = code.split('.');
  const requires: Permission[] = action === 'view' ? [] : [group + '.view' as Permission];
  if (['knowledge.publish','knowledge.rollback','knowledge.reset'].includes(code)) requires.push('knowledge.review');
  return {code,name:names[code],group:groups[group],requires};
});
export const allPermissions = permissions.map(p => p.code);
export const adminPermissions = allPermissions.filter(p => p.startsWith('system.'));
export const routePermissions: Record<string,Permission> = {
  '/situation':'situation.view','/resources':'resources.view','/planning':'planning.view',
  '/sr4-live':'planning.view',
  '/diagnosis':'diagnosis.view','/knowledge':'knowledge.view','/system':'system.view',
};
export const servicePermissions: Record<string, { any?: Permission[]; all?: Permission[] }> = {
  // 配置读取按具体页面再次校验；校验和模拟提交需要资源维护权限。
  loadDeviceConfigurationContext: { any: ['resources.view', 'situation.view'] },
  getDeviceConfigurationOperation: { any: ['resources.view', 'situation.view'] },
  queryDeviceConfigurationOperations: { any: ['resources.view', 'situation.view'] },
  validateDeviceConfiguration: { all: ['resources.edit'] },
  submitDeviceConfiguration: { all: ['resources.edit'] },
  // 状态查询复用页面只读权限，具体上下文在访问包装中检查。
  loadDeviceStatusContext: { any: ['resources.view', 'situation.view'] },
  queryDeviceStatuses: { any: ['resources.view', 'situation.view'] },
  queryTaskInputs: { all: ['planning.view'] },
  getTaskInput: { all: ['planning.view'] },
  saveTaskInput: { all: ['planning.execute'] },
  validateTaskInputApi: { all: ['planning.execute'] },
  previewTaskInputImport: { all: ['planning.execute'] },
  getTaskInputTemplate: { all: ['planning.execute'] },
  getPlanningOperation: { all: ['planning.view'] },
  loadPlanningCatalog: { all: ['planning.view'] },
  submitPlanningTask: { all: ['planning.execute'] },
  getPlanningTask: { all: ['planning.view'] },
  cancelPlanningTask: { all: ['planning.execute'] },
  queryPlanningPlans: { all: ['planning.view'] },
  getPlanningPlan: { all: ['planning.view'] },
  savePlanningPlan: { all: ['planning.save'] },
  confirmPlanningPlan: { all: ['planning.confirm'] },
  comparePlanningPlans: { all: ['planning.view'] },
  exportPlanningPlan: { all: ['planning.view'] },
  getPlanningCoverageImage: { all: ['planning.view'] },
  // 读取按请求页面再细分权限，GIS 浏览不额外要求台账权限。
  loadResourceReadContext: { any: ['resources.view', 'situation.view', 'planning.view'] },
  queryResourceDevices: { any: ['resources.view', 'situation.view', 'planning.view'] },
  queryResourceNodes: { any: ['situation.view', 'planning.view'] },
  queryResourceInterferences: { all: ['situation.view'] },
  getResourceObject: { any: ['resources.view', 'situation.view', 'planning.view'] },
  queryResourceMap: { any: ['situation.view', 'planning.view'] },
  // 两类只读监控分别检查关联模块权限，不要求管理系统参数的权限。
  loadMonitoringContext: { all: ['situation.view', 'planning.view'] },
  getMonitoringFrame: { all: ['situation.view', 'planning.view'] },
  loadSpectrumMonitoringContext: { all: ['situation.view', 'resources.view'] },
  getSpectrumObservationFrame: { all: ['situation.view', 'resources.view'] },
  // 复用 GIS 与规划权限，不增加角色能力。
  loadInterferenceWorkspace: { all: ['situation.view', 'planning.view'] },
  loadInterferenceSources: { all: ['situation.view', 'planning.view'] },
  submitInterferenceAnalysis: { all: ['situation.view', 'planning.view', 'planning.execute'] },
  getInterferenceAnalysis: { all: ['situation.view', 'planning.view'] },
  cancelInterferenceAnalysis: { all: ['situation.view', 'planning.view', 'planning.execute'] },
  adoptInterferenceMeasure: { all: ['situation.view', 'planning.view', 'planning.execute', 'planning.save'] },
  loadTaskWorkspace:{all:['planning.view']},saveTask:{all:['planning.execute']},commitGisWorkspace:{all:['situation.view']},
  getTaskTemplate:{all:['planning.execute']},previewTaskImport:{all:['planning.execute']},exportPlanVersion:{all:['planning.view']},
  getResourceTemplate:{all:['resources.edit']},previewResourceImport:{all:['resources.edit']},commitResourceImport:{all:['resources.edit']},
  exportResources:{all:['resources.view']},setDeviceAvailability:{all:['resources.edit']},
  loadSpectrumWorkspace:{all:['resources.view']},saveSpectrumSource:{all:['resources.edit']},checkSpectrumSource:{all:['resources.edit']},resetSpectrumWorkspace:{all:['resources.reset']},
  loadPreview:{any:['situation.view','resources.view','planning.view','diagnosis.view']},
  commitResources:{all:['resources.edit']},resetResources:{all:['resources.reset']},
  loadPlanningWorkspace:{all:['planning.view']},getPlanningJob:{all:['planning.view']},comparePlanVersions:{all:['planning.view']},
  submitPlanning:{all:['planning.execute']},cancelPlanningJob:{all:['planning.execute']},
  savePlanVersion:{all:['planning.save']},confirmPlanVersion:{all:['planning.confirm']},resetPlanningWorkspace:{all:['planning.reset']},
  loadDiagnosisWorkspace:{all:['diagnosis.view']},loadDiagnosisSources:{all:['diagnosis.view']},getDiagnosisRun:{all:['diagnosis.view']},getDiagnosisReport:{all:['diagnosis.view']},
  validateDiagnosisScenario:{all:['diagnosis.scenario']},saveDiagnosisScenario:{all:['diagnosis.scenario']},archiveDiagnosisScenario:{all:['diagnosis.scenario']},
  getDiagnosisTemplate:{all:['diagnosis.scenario']},previewDiagnosisImport:{all:['diagnosis.scenario']},commitDiagnosisImport:{all:['diagnosis.scenario']},
  submitDiagnosis:{all:['diagnosis.execute']},cancelDiagnosisRun:{all:['diagnosis.execute']},exportDiagnosisReport:{all:['diagnosis.export']},exportDiagnosisImpact:{all:['diagnosis.export']},resetDiagnosisWorkspace:{all:['diagnosis.reset']},
  loadKnowledgeWorkspace:{all:['knowledge.view']},searchKnowledge:{all:['knowledge.view']},getKnowledgeEntity:{all:['knowledge.view']},queryKnowledgeGraph:{all:['knowledge.view']},getDeviceKnowledge:{all:['knowledge.view']},
  saveKnowledgeChange:{all:['knowledge.edit']},submitKnowledgeChange:{all:['knowledge.edit']},withdrawKnowledgeChange:{all:['knowledge.edit']},
  reviewKnowledgeChange:{all:['knowledge.review']},publishKnowledgeChange:{all:['knowledge.publish']},rollbackKnowledgeVersion:{all:['knowledge.rollback']},resetKnowledgeWorkspace:{all:['knowledge.reset']},
  loadSystemCatalog:{all:['system.view']},querySystemAccounts:{all:['system.accounts']},saveSystemAccount:{all:['system.accounts']},setSystemAccountState:{all:['system.accounts']},
  querySystemRoles:{all:['system.roles']},saveSystemRole:{all:['system.roles']},querySystemParameters:{all:['system.parameters']},saveSystemParameter:{all:['system.parameters']},
  queryOperationLogs:{all:['system.logs']},resetSystemWorkspace:{all:['system.reset']},resetOperationLogs:{all:['system.logs','system.reset']},
};
export function togglePermission(current: Permission[],code: Permission,on: boolean): Permission[] {
  const chosen = new Set(current);
  if (on) {
    const add=(key:Permission)=>{chosen.add(key);permissions.find(p=>p.code===key)?.requires.forEach(add);};
    add(code);
  } else {
    chosen.delete(code);
    let changed=true;
    while(changed){changed=false;for(const p of permissions)if(chosen.has(p.code)&&p.requires.some(r=>!chosen.has(r))){chosen.delete(p.code);changed=true;}}
  }
  return allPermissions.filter(p=>chosen.has(p));
}
// 返回地址仅允许站内已知路由和这些页面实际使用的查询字段。
export function safeReturnPath(value: unknown): string | null {
  if(typeof value!=='string'||value.length>1000||/[\\#\r\n]/.test(value))return null;
  const [path,search='']=value.split('?');
  if(!routePermissions[path])return null;
  const query=new URLSearchParams(search), allowed:Record<string,string[]>={'/situation':['stationId','deviceId','interferenceId','taskId','diagnosisId'],'/planning':['taskId','jobId','planId'],'/knowledge':['entityId']};
  for(const [key,val]of query)if(!(allowed[path]??[]).includes(key)||!val||val.length>120||/[\u0000-\u001f\u007f]/.test(val))return null;
  if(path==='/planning'&&((query.has('jobId')||query.has('planId'))&&!query.has('taskId')||query.has('jobId')&&query.has('planId')))return null;
  // 诊断快照只能绑定一份报告，不能与当前资源或任务定位混用。
  if(path==='/situation'&&query.has('diagnosisId')&&['stationId','deviceId','interferenceId','taskId'].some(key=>query.has(key)))return null;
  // 完整定位允许不透明 ID；历史单设备返回地址仍限制为简单标识，拒绝路径和混合/重复参数。
  if(new Set([...query.keys()]).size!==query.size||path==='/situation'&&(query.has('deviceId')&&!query.has('stationId')&&!/^[\w-]+$/.test(query.get('deviceId')??'')||query.has('interferenceId')&&(query.has('stationId')||query.has('deviceId'))))return null;
  return path+(query.size?'?'+query.toString():'');
}
