import { servicePermissions } from '../config/permissions';
import type { PreviewService } from './types';
import { ApiError } from './types';
import type { AuthIdentity, OperationEvent } from '../types/system';
import type { OperationLogger } from './operation-log';
import { actorSnapshot } from './operation-log';
import { resourceReadMethods } from '../types/resource-read';

export interface AccessNotice { identity?: AuthIdentity|null; error?: Error; busy?: number }
const listeners=new Set<(notice:AccessNotice)=>void>();
export function subscribeAccess(fn:(n:AccessNotice)=>void){listeners.add(fn);return()=>{listeners.delete(fn);};}
const emit=(n:AccessNotice)=>listeners.forEach(fn=>fn(n));
const publicMethods=['getLoginCatalog','login','logout','getSession','recoverSystemWorkspace'] as const;
export const operationActions:Record<string,string> = {
  changeOwnPassword:'维护本人密码',
  maintainSystemAccountPassword:'维护账号密码',
  resetSystemParameters:'恢复系统参数新版本',
  archiveSystemLogs:'归档日志视图',
  saveKnowledgeReceipt:'保存知识草稿',
  submitKnowledgeReceipt:'知识送审',
  withdrawKnowledgeReceipt:'撤回知识',
  reviewKnowledgeReceipt:'审核知识',
  publishKnowledgeReceipt:'发布知识',
  rollbackKnowledgeReceipt:'回滚知识',
  resetKnowledgeReceipt:'重置知识',

  saveDiagnosisReceipt:'保存故障场景',
  archiveDiagnosisReceipt:'调整场景归档',
  importDiagnosisReceipt:'整批导入场景',
  submitDiagnosisReceipt:'提交诊断',
  submitDiagnosisImpactReceipt:'提交影响分析',
  submitDiagnosisFeedback:'提交诊断知识反馈',
  cancelDiagnosisReceipt:'取消诊断',
  resetDiagnosisReceipt:'重置诊断',

  submitDeviceConfigurationReceipt:'模拟配置请求受理',
  saveSpectrumReceipt:'保存频谱配置',checkSpectrumReceipt:'Mock 频谱检查',resetSpectrumReceipt:'重置频谱配置',
  submitInterferenceReceipt:'提交干扰分析',cancelInterferenceReceipt:'取消干扰分析',adoptInterferenceReceipt:'采纳抗干扰措施',
  submitPlanningReceipt:'提交规划',cancelPlanningReceipt:'取消规划',savePlanningReceipt:'保存方案版本',confirmPlanningReceipt:'确认方案',resetPlanningReceipt:'重置规划',
  saveTaskInputReceipt:'保存任务输入',
  saveResourceChanges:'保存资源',applyResourceImport:'整批导入资源',updateDeviceAvailability:'调整设备上下架',resetResourceData:'重置资源',
  // 日志成功仅表示受理请求，执行结果查独立配置回执。
  submitDeviceConfiguration:'模拟配置请求受理',
  saveTaskInput:'保存任务输入',submitPlanningTask:'提交规划',cancelPlanningTask:'取消规划',savePlanningPlan:'保存方案版本',confirmPlanningPlan:'确认方案',exportPlanningPlan:'导出方案快照',exportPlanningReference:'导出只读历史方案',resetPlanningData:'重置规划',
  submitInterferenceAnalysis:'提交干扰分析',cancelInterferenceAnalysis:'取消干扰分析',adoptInterferenceMeasure:'采纳抗干扰措施',
  saveTask:'保存任务输入',commitGisWorkspace:'整体保存 GIS 资源与任务',exportPlanVersion:'导出方案快照',
  login:'登录',logout:'退出',recoverSystemWorkspace:'恢复损坏系统配置',resetOperationLogs:'重置操作日志',
  saveSystemAccount:'保存账号',setSystemAccountState:'调整账号启停',saveSystemRole:'保存角色权限',saveSystemParameter:'保存演示参数',resetSystemWorkspace:'重置系统配置',
  commitResourceImport:'整批导入资源',exportResources:'导出已保存资源',setDeviceAvailability:'调整设备上下架',saveSpectrumSource:'保存频谱配置',checkSpectrumSource:'Mock 频谱检查',resetSpectrumWorkspace:'重置频谱配置',
  commitResources:'保存资源',resetResources:'重置资源',submitPlanning:'提交规划',cancelPlanningJob:'取消规划',savePlanVersion:'保存方案版本',confirmPlanVersion:'确认方案',resetPlanningWorkspace:'重置规划',
  saveDiagnosisScenario:'保存故障场景',archiveDiagnosisScenario:'调整场景归档',commitDiagnosisImport:'整批导入场景',submitDiagnosis:'提交诊断',cancelDiagnosisRun:'取消诊断',exportDiagnosisReport:'生成报告文件',exportDiagnosisImpact:'生成影响文件',resetDiagnosisWorkspace:'重置诊断',
  saveKnowledgeChange:'保存知识草稿',submitKnowledgeChange:'知识送审',withdrawKnowledgeChange:'撤回知识',reviewKnowledgeChange:'审核知识',publishKnowledgeChange:'发布知识',rollbackKnowledgeVersion:'回滚知识',resetKnowledgeWorkspace:'重置知识',
};

// 对外动作身份保持稳定，读取与回执拆分不改变审计含义。
const operationAliases:Record<string,string>={"saveKnowledgeReceipt":"saveKnowledgeChange","submitKnowledgeReceipt":"submitKnowledgeChange","withdrawKnowledgeReceipt":"withdrawKnowledgeChange","reviewKnowledgeReceipt":"reviewKnowledgeChange","publishKnowledgeReceipt":"publishKnowledgeChange","rollbackKnowledgeReceipt":"rollbackKnowledgeVersion","resetKnowledgeReceipt":"resetKnowledgeWorkspace","saveDiagnosisReceipt":"saveDiagnosisScenario","archiveDiagnosisReceipt":"archiveDiagnosisScenario","importDiagnosisReceipt":"commitDiagnosisImport","submitDiagnosisReceipt":"submitDiagnosis","cancelDiagnosisReceipt":"cancelDiagnosisRun","resetDiagnosisReceipt":"resetDiagnosisWorkspace","submitDeviceConfigurationReceipt": "submitDeviceConfiguration", "saveSpectrumReceipt": "saveSpectrumSource", "checkSpectrumReceipt": "checkSpectrumSource", "resetSpectrumReceipt": "resetSpectrumWorkspace", "submitInterferenceReceipt": "submitInterferenceAnalysis", "cancelInterferenceReceipt": "cancelInterferenceAnalysis", "adoptInterferenceReceipt": "adoptInterferenceMeasure", "submitPlanningReceipt": "submitPlanningTask", "cancelPlanningReceipt": "cancelPlanningTask", "savePlanningReceipt": "savePlanningPlan", "confirmPlanningReceipt": "confirmPlanningPlan", "resetPlanningReceipt": "resetPlanningData", "saveTaskInputReceipt": "saveTaskInput", "saveResourceChanges": "commitResources", "applyResourceImport": "commitResourceImport", "updateDeviceAvailability": "setDeviceAvailability", "resetResourceData": "resetResources"};
export const isWriteMethod=(name:string)=>!!operationActions[name]&&!name.startsWith('export')||name==='resetOperationLogs';
// 能力尚未接入不是身份失效；无法读取会话的失败由校验阶段单独处理。
const authFailure=(e:unknown)=>e instanceof ApiError&&/^(AUTH_|SESSION_|SYSTEM_READ|SYSTEM_CORRUPT|SYSTEM_INCOMPATIBLE)/.test(String(e.code));
const moduleName=(name:string)=>name.includes('Interference')?'GIS 干扰分析':name.includes('Knowledge')?'知识图谱':name.includes('Diagnosis')?'故障诊断':(name.includes('Plan')||name.includes('Task')||name==='commitGisWorkspace')?'网络规划':(name.includes('Resource')||name.includes('DeviceAvailability')||name.includes('DeviceConfiguration'))?'资源管理':name.includes('Spectrum')?'频谱配置':'系统管理';
function check(actor:AuthIdentity|null,name:string){
  if(!actor)throw new ApiError('请先登录','AUTH_REQUIRED');
  const p=servicePermissions[name];
  if(!p||p.all?.some(x=>!actor.permissions.includes(x))||(p.any&&!p.any.some(x=>actor.permissions.includes(x))))throw new ApiError('当前账号没有此操作权限','FORBIDDEN');
}
// 同一读取契约可用于台账/GIS，但不能伪造上下文绕过对应页面权限。
function checkReadContext(actor:AuthIdentity|null,name:string,input:Record<string,unknown>|undefined){
  // 单设备维护权限不能借通用保存方法开放 GIS、导入或其他字段。
  const workspaceEditor = actor?.permissions.includes('resources.workspace.edit');
  const createsResources = actor?.permissions.includes('resources.create');
  const fullContext = name === 'loadResourceMaintenanceContext' && input?.context === 'ledger'
    && input.deviceId === undefined && input.ids === undefined
    && (workspaceEditor || createsResources || actor?.permissions.includes('resources.import'));
  const workspaceSave = name === 'saveResourceChanges' && !!input && ['ledger','gis'].includes(String(input.context))
    && (workspaceEditor || createsResources && ['newStations','newDevices','newInterferences'].some(key=>Array.isArray(input[key])&&(input[key] as unknown[]).length)
      && ['stations','devices','interferences'].every(key=>input[key]===undefined||Array.isArray(input[key])&&!(input[key] as unknown[]).length));
  // 新增/导入的完整上下文不要求先选设备；窄权限仍不能借此维护其他资源。
  if (['loadResourceMaintenanceContext','saveResourceChanges'].includes(name) && !actor?.permissions.includes('resources.edit') && !fullContext && !workspaceSave) {
    if (input?.context !== 'ledger') throw new ApiError('仅允许台账单设备参数维护','FORBIDDEN');
    if (name === 'loadResourceMaintenanceContext') {
      if (input.ids !== undefined) {
        if (!actor?.permissions.includes('resources.device.availability') || input.deviceId !== undefined || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 50)
          throw new ApiError('没有批量上下架预览权限或设备清单无效','FORBIDDEN');
      } else if (!actor?.permissions.includes('resources.device.edit') || typeof input.deviceId !== 'string' || !input.deviceId)
        throw new ApiError('必须有单设备参数维护权限并选择设备','FORBIDDEN');
    }
    if (name === 'saveResourceChanges' && (!actor?.permissions.includes('resources.device.edit') || Object.keys(input).some(k => !['context','baseRevision','requestId','stations','devices'].includes(k))
      || !Array.isArray(input.stations) || input.stations.length || !Array.isArray(input.devices) || input.devices.length !== 1
      || !input.devices[0] || Object.keys(input.devices[0]).some(k => !['id','antennaHeightM','txPowerDbm','workFreqKhz'].includes(k))))
      throw new ApiError('本次权限不包含其他资源维护','FORBIDDEN');
  }
  if(['getDeviceMaintenance','queryDeviceHistory','getDeviceHistory','previewDeviceRestore','getDeviceNetworkDetail'].includes(name)){
    if(!input||!['gis','ledger'].includes(String(input.context)))throw new ApiError('设备维护页面上下文无效','INVALID_MAINTENANCE_QUERY');
    if(!actor?.permissions.includes(input.context==='gis'?'situation.view':'resources.view'))throw new ApiError('没有当前页面的设备查看权限','FORBIDDEN');
  }
  if (['getGisCoverageCatalog', 'getGisLinkDetails', 'loadGisResourceDirectory', 'loadGisResourceScene', 'loadGisResourceEditContext'].includes(name)) {
    if (input?.context !== 'gis') throw new ApiError('GIS 上下文无效', 'INVALID_RESOURCE_QUERY');
    return;
  }
  // 五种配置调用均受页面上下文保护，写权限不能代替页面读取权限。
  if (name.includes('DeviceConfiguration')) {
    if(!input||!['gis','ledger'].includes(String(input.context)))throw new ApiError('设备配置页面上下文无效','INVALID_CONFIGURATION');
    if(!actor?.permissions.includes(input.context==='gis'?'situation.view':'resources.view'))throw new ApiError('没有当前页面的设备配置权限','FORBIDDEN');
    return;
  }
  // 状态只允许台账/GIS，前后两次会话校验共用相同规则。
  if (['loadDeviceStatusContext', 'queryDeviceStatuses','loadDeviceStatusOptions','synchronizeDeviceStatuses','queryDeviceStatusBatch'].includes(name)) {
    if (!input || !['ledger', 'gis'].includes(String(input.context))) throw new ApiError('设备状态页面上下文无效', 'INVALID_DEVICE_STATUS_QUERY');
    if (!actor?.permissions.includes(input.context === 'gis' ? 'situation.view' : 'resources.view')) throw new ApiError('没有当前页面的状态读取权限', 'FORBIDDEN');
    return;
  }
  if(!(resourceReadMethods as readonly string[]).includes(name))return;
  if(!input||!['gis','ledger','planning'].includes(String(input.context)))throw new ApiError('资源读取缺少页面上下文','INVALID_RESOURCE_QUERY');
  const permission=input.context==='gis'?'situation.view':input.context==='planning'?'planning.view':'resources.view';
  if(!actor?.permissions.includes(permission))throw new ApiError('没有当前资源页面的读取权限','FORBIDDEN');
  // 所属节点由设备详情服务按关联返回，台账角色不能直接读取任意节点。
  if(input.context==='ledger'&&(['queryResourceNodes','queryResourceInterferences','queryResourceMap'].includes(name)||name==='getResourceObject'&&input.kind!=='device'))throw new ApiError('台账上下文仅允许设备读取','FORBIDDEN');
  if(input.context==='planning'&&(name==='queryResourceInterferences'||name==='getResourceObject'&&input.kind==='interference'||name==='queryResourceMap'&&input.showInterferences!==false))throw new ApiError('规划上下文只读取任务节点与设备','FORBIDDEN');
}

const planningApiMethods = ['queryTaskInputs','getTaskInput','saveTaskInput','validateTaskInputApi','previewTaskInputImport','getTaskInputTemplate','getPlanningOperation','loadPlanningCatalog','queryPlanningJobs','queryPlanningReferences','getPlanningReference','comparePlanningReferences','exportPlanningReference','resetPlanningData','submitPlanningTask','getPlanningTask','cancelPlanningTask','queryPlanningPlans','getPlanningPlan','savePlanningPlan','confirmPlanningPlan','comparePlanningPlans','exportPlanningPlan','getPlanningCoverageImage'];
function checkTaskContext(actor: AuthIdentity | null, name: string, input: Record<string, unknown> | undefined) {
  if (!planningApiMethods.includes(name) && !['querySavedPlanningPlans','queryTaskSummaries','saveTaskInputReceipt','loadPlanningOptions','loadPlanningReadContext','getPlanningPreset','getPlanningAdjustmentExamples','getPlanningTaskProgress','queryPlanningPlanSummaries','queryPlanningReferenceSummaries','submitPlanningReceipt','cancelPlanningReceipt','savePlanningReceipt','confirmPlanningReceipt','resetPlanningReceipt'].includes(name)) return;
  if (!input || !['gis','planning'].includes(String(input.context))) throw new ApiError('任务页面上下文无效','INVALID_TASK_QUERY');
  if (!actor?.permissions.includes('planning.view') || input.context==='gis'&&!actor.permissions.includes('situation.view')) throw new ApiError('缺少任务所在页面权限','FORBIDDEN');
}
type AnyMethod=(...args:any[])=>Promise<any>;
// 所有页面走该包装；原业务工厂仅供内部组合和隔离测试。
export function createAccessService(select:()=>PreviewService,logger:OperationLogger|null,observe:(n:AccessNotice)=>void=emit):PreviewService {
  let busy=0;
  const result:Record<string,AnyMethod>={};
  for(const name of [...publicMethods,...Object.keys(servicePermissions)]){
    result[name]=async(...args:unknown[])=>{
      let actor:AuthIdentity|null=null,service:PreviewService|undefined,checkingSession=name==='getSession';
      const operation=operationAliases[name]??name;
      const action=operationActions[name],first=args[0] as Record<string,unknown>|undefined;
      const writing=isWriteMethod(name);
      // 在异步处理之前捕获安全的标识，绝不把原始请求/密码交给日志。
      const requestId=first&&typeof first.requestId==='string'?first.requestId.slice(0,120):null;
      const attempted=['login','recoverSystemWorkspace'].includes(name)&&first&&typeof first.username==='string'?first.username.slice(0,32):'';
      const resetTargets:Record<string,string>={resetResources:'resource-workspace',resetPlanningWorkspace:'planning-workspace',resetDiagnosisWorkspace:'diagnosis-workspace',resetSpectrumWorkspace:'spectrum-workspace'};
      const importChanges=(first?.preview as {changes?:Record<string,unknown>}|undefined)?.changes;
      const resourceRequest=operation==='commitResourceImport'?importChanges:first;
      const resourceIds=['commitResources','commitResourceImport'].includes(operation)?['stations','devices','newStations','newDevices','interferences','newInterferences','availability'].flatMap(k=>Array.isArray(resourceRequest?.[k])?(resourceRequest![k] as {id?:unknown}[]).map(x=>typeof x?.id==='string'?x.id:'').filter(Boolean):[]).join(',').slice(0,500):'';
      const selectedIds=operation==='setDeviceAvailability'&&Array.isArray(first?.ids)?first.ids.filter(id=>typeof id==='string').join(',').slice(0,500):'';
      const spectrumId=operation==='saveSpectrumSource'&&(first?.source as {id?:unknown})?.id;
      const exported=name==='exportResources'&&Array.isArray(first?.kinds)?first.kinds.filter(k=>typeof k==='string').join(','):'';
      const requestedObject=resetTargets[operation]??(resourceIds||selectedIds||(typeof spectrumId==='string'?spectrumId.slice(0,120):'')||exported||(typeof args[0]==='string'?String(args[0]).slice(0,120):['deviceId','analysisId','taskId','planId','changeId','accountId','parameterId','versionId','runId','jobId','sourceId'].map(k=>first?.[k]).find(v=>typeof v==='string') as string|undefined));
      function record(outcome:OperationEvent['outcome'],value?:any,error?:unknown){
        // 日志重置成功事件已在同一次日志事务中写入；失败仍需记录或待补。
        if(!action||!logger||name==='resetOperationLogs'&&outcome==='SUCCESS')return;
        const receiptIds=value?.receipts?.find((r:{requestId:string})=>r.requestId===requestId)?.entityIds?.join(',');
        const objectId=String(value?.objectId??value?.entityId??value?.plan?.id??value?.view?.job?.id??value?.view?.run?.analysisId??value?.view?.run?.id??receiptIds??requestedObject??'').slice(0,500);
        logger.record({actor:actorSnapshot(actor),attemptedUsername:outcome==='SUCCESS'?'':attempted,module:moduleName(name),action:operation,objectId,requestId,outcome,summary:action+(outcome==='SUCCESS'?'：请求已完成':outcome==='UNCHANGED'?'：无实际变化':outcome==='DENIED'?'：请求被拒绝':'：请求失败'),errorCode:error instanceof ApiError?String(error.code).slice(0,120):error?'UNEXPECTED_ERROR':''});
      }
      if(writing)observe({busy:++busy});
      try{
        service=select();
        const method=(service as unknown as Record<string,AnyMethod>)[name];
        if(!method)throw new ApiError('服务方法尚未实现','NOT_IMPLEMENTED');
        if(!publicMethods.includes(name as typeof publicMethods[number])){
          checkingSession=true;actor=await service.getSession();checkingSession=false;observe({identity:actor});check(actor,name);
          checkReadContext(actor,name,first);
          checkTaskContext(actor,name,first);
          // GIS 上下文额外检查页面权限，台账操作仍按资源权限处理。
          if(first?.context==='gis'&&!actor!.permissions.includes('situation.view'))throw new ApiError('没有 GIS 操作权限','FORBIDDEN');
          if(name==='commitGisWorkspace'){
            const changes=first?.changes as Record<string,unknown>|undefined;
            const resourceChange=changes&&Object.values(changes).some(v=>Array.isArray(v)&&v.length);
            if(resourceChange&&!actor!.permissions.includes('resources.edit')||first?.task&&!actor!.permissions.includes('planning.execute'))throw new ApiError('缺少本次整体保存所需权限','FORBIDDEN');
          }
          if(name.includes('Knowledge')&&first&&'actorId'in first&&first.actorId!==actor!.id)throw new ApiError('请求操作者与登录账号不符','FORBIDDEN');
        }else if(name==='logout'){
          try{actor=await service.getSession();}catch(e){if(!authFailure(e))throw e;}
        }
        const value=await method.apply(service,args);
        if(name==='login'){actor=value;observe({identity:actor});}
        else if(name==='getSession')observe({identity:value});
        else if(name==='logout')observe({identity:null});
        else if(actor){
          // 读请求可丢弃迟到响应；已经写入的业务成功不能被后续失权改成失败。
          if(writing){
            try{observe({identity:await service.getSession()});}catch(e){observe({identity:null,error:e instanceof Error?e:new Error('会话校验失败')});}
          }else{
            checkingSession=true;const fresh=await service.getSession();checkingSession=false;observe({identity:fresh});
            if(!fresh||fresh.sessionId!==actor.sessionId||select()!==service)throw new ApiError('会话已变化，旧响应已丢弃','SESSION_CHANGED');
            check(fresh,name);
            checkReadContext(fresh,name,first);
            checkTaskContext(fresh,name,first);
            if(first?.context==='gis'&&!fresh.permissions.includes('situation.view'))throw new ApiError('GIS 权限已变化','FORBIDDEN');
          }
        }
        if(name==='resetOperationLogs'&&logger)logger.reset(value.objectId);
        const failedCheck=['checkSpectrumSource','checkSpectrumReceipt'].includes(name)&&(value?.check?.connection==='FAILED'||value?.check?.validation==='FAILED');
        record(failedCheck?'FAILED':value?.changed===false?'UNCHANGED':'SUCCESS',value,failedCheck?new ApiError('模拟检查失败','MOCK_CHECK_FAILED'):undefined);
        return value;
      }catch(e){
        let failure=e;
        // 含有效业务数据的失败响应也需隔离旧会话；不能把新账号误置为退出。
        if(actor&&!writing&&service){try{checkingSession=true;const fresh=await service.getSession();checkingSession=false;observe({identity:fresh});if(!fresh||fresh.sessionId!==actor.sessionId)throw new ApiError('会话已变化，旧响应已丢弃','SESSION_CHANGED');check(fresh,name);checkReadContext(fresh,name,first);checkTaskContext(fresh,name,first);}catch(changed){failure=changed;}}
        const obsolete=failure instanceof ApiError&&['SESSION_CHANGED','HTTP_AUTH_BUSY'].includes(String(failure.code));
        if((authFailure(failure)||checkingSession)&&!obsolete)observe({identity:null,error:failure instanceof Error?failure:new Error('会话不可用')});
        record(failure instanceof ApiError&&['FORBIDDEN','AUTH_REQUIRED','AUTH_DISABLED','AUTH_EXPIRED','AUTH_CREDENTIALS'].includes(String(failure.code))?'DENIED':'FAILED',undefined,failure);
        throw failure;
      }finally{if(writing)observe({busy:--busy});}
    };
  }
  return result as unknown as PreviewService;
}
