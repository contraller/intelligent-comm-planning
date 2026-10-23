import { DEVICE_CONFIGURATION_PHASE_MS } from '../config/demo';
import type { DeviceDetailCatalog } from '../types/device-detail';
import type { ResourcesData } from '../types/domain';
import type { ResourceMeta, ResourceStorage } from '../types/resource-edit';
import type { ConfigurationOperation, ConfigurationOperationResult, ConfigurationSubmit, DeviceConfigurationContext, DeviceConfigurationServices } from '../types/device-configuration';
import { configurationPresets, configurationScenarios, configurationSource } from '../mocks/device-configuration-presets';
import { configurationContext, configurationSignature, configurationSubmit, validateConfiguration } from './device-configuration-validation';
import { readConfigurationWorkspace, saveConfigurationWorkspace } from './device-configuration-storage';
import { ApiError } from './types';

// 固定教学时序只更新新工作区；资源读取回调没有写入能力。
export function createDeviceConfigurationMock(storage:()=>ResourceStorage,read:()=>{resources:ResourcesData;meta:ResourceMeta},details:DeviceDetailCatalog,now:()=>number=Date.now):DeviceConfigurationServices {
  function context(deviceId:string):DeviceConfigurationContext {
    const {resources,meta}=read(),device=resources.devices.find(d=>d.id===deviceId),model=resources.models.find(m=>m.id===device?.modelId);
    if(!device||!model)throw new ApiError('已保存设备或型号不存在','CONFIGURATION_DEVICE_MISSING');
    const presets=configurationPresets.filter(p=>p.modelId===model.id);
    return structuredClone({deviceId,modelId:model.id,resourceEpoch:meta.resourceEpoch,deviceVersion:meta.deviceVersions[deviceId]??'initial',device,model,
      powerLevels:details.models.find(m=>m.modelId===model.id)?.txPowerLevelsDbm??null,presets,defaultPresetId:presets[0]?.id??null,
      unavailableReason:device.availability==='OFF_SHELF'?'设备已下架':presets.length?'':'此型号暂无教学默认配置',source:configurationSource,scenarios:configurationScenarios});
  }
  function view(op:ConfigurationOperation):ConfigurationOperationResult {
    let sourceChanged=true;
    try{const current=context(op.request.deviceId);sourceChanged=current.resourceEpoch!==op.request.resourceEpoch||current.deviceVersion!==op.request.deviceVersion||current.modelId!==op.request.modelId||current.device.availability==='OFF_SHELF';}catch{/* 历史保留冻结身份，源设备缺失也可查看。 */}
    return structuredClone({status:op.status,operation:op,sourceChanged});
  }
  function advance(op:ConfigurationOperation){
    if(op.status!=='RUNNING')return;
    const elapsed=now()-Date.parse(op.acceptedAt);
    if(elapsed<DEVICE_CONFIGURATION_PHASE_MS)return;
    op.updatedAt=new Date(now()).toISOString();
    if(op.request.scenario==='send-failed'){op.status='FAILED';op.message='教学预设：模拟发送失败，未收到执行回执';return;}
    op.phase='RECEIPT';op.message='模拟请求已发送，等待教学回执';
    if(elapsed<DEVICE_CONFIGURATION_PHASE_MS*2)return;
    op.status=op.request.scenario==='receipt-failed'?'FAILED':'SUCCEEDED';
    op.message=op.status==='FAILED'?'教学预设：执行回执失败，台账未改变':'教学预设：成功回执已记录，台账仍需单独保存';
    op.appliedValues=op.status==='SUCCEEDED'?structuredClone(op.request.values):null;
  }
  function workspace(){const s=storage(),value=readConfigurationWorkspace(s),before=JSON.stringify(value);value.operations.forEach(advance);if(before!==JSON.stringify(value))saveConfigurationWorkspace(s,value);return {s,value};}
  return {
    async loadDeviceConfigurationContext(request){configurationContext(request?.context);return context(request.deviceId);},
    async validateDeviceConfiguration(request){configurationContext(request?.context);return validateConfiguration(request,context(request.deviceId));},
    async submitDeviceConfiguration(request){
      configurationSubmit(request);const signature=configurationSignature(request),{s,value}=workspace();
      const existing=value.operations.find(op=>op.request.requestId===request.requestId);
      if(existing){if(existing.signature!==signature)throw new ApiError('同一请求编号不能用于不同配置','CONFIGURATION_REQUEST_CONFLICT');return view(existing);}
      const current=context(request.deviceId),checked=validateConfiguration(request,current);
      if(!checked.valid)throw new ApiError('设备配置校验未通过','VALIDATION_ERROR',checked.issues);
      if(request.retryOf){
        const parent=value.operations.find(op=>op.id===request.retryOf),prior=parent?.request;
        if(!parent||parent.status!=='FAILED'||!prior||['deviceId','modelId','resourceEpoch','deviceVersion','presetVersion'].some(k=>prior[k as keyof ConfigurationSubmit]!==request[k as keyof ConfigurationSubmit])||prior.values.txPowerDbm!==request.values.txPowerDbm||prior.values.workFreqKhz!==request.values.workFreqKhz)
          throw new ApiError('仅能重试来源有效且参数相同的失败请求','CONFIGURATION_RETRY_INVALID');
      }
      const time=new Date(now()).toISOString();
      const operation:ConfigurationOperation={id:crypto.randomUUID(),request:structuredClone(request),signature,device:current.device,modelName:current.model.name,acceptedAt:time,updatedAt:time,phase:'DISPATCH',status:'RUNNING',message:'模拟配置请求已受理，等待发送',appliedValues:null,source:configurationSource};
      value.operations.push(operation);saveConfigurationWorkspace(s,value);
      if(request.scenario==='reply-lost')throw new ApiError('教学预设：提交响应丢失，请按原请求编号核实','CONFIGURATION_REPLY_LOST');
      return view(operation);
    },
    async getDeviceConfigurationOperation(request){
      configurationContext(request?.context);if(typeof request.requestId!=='string'||!request.requestId.trim())throw new ApiError('请求编号无效','INVALID_CONFIGURATION');
      const {value}=workspace(),operation=value.operations.find(op=>op.request.requestId===request.requestId);
      if(operation&&request.deviceId&&request.deviceId!==operation.request.deviceId)throw new ApiError('配置记录不属于此设备','CONFIGURATION_OWNER_MISMATCH');
      return operation?view(operation):{status:'NOT_FOUND',operation:null,sourceChanged:false};
    },
    async queryDeviceConfigurationOperations(request){
      configurationContext(request?.context);
      if(!Number.isInteger(request.page)||request.page<1||!Number.isInteger(request.pageSize)||request.pageSize<1||request.pageSize>100||request.deviceId!==undefined&&(typeof request.deviceId!=='string'||!request.deviceId.trim()))throw new ApiError('配置记录查询条件无效','INVALID_CONFIGURATION');
      const {value}=workspace(),all=value.operations.filter(op=>!request.deviceId||op.request.deviceId===request.deviceId).reverse();
      return {items:all.slice((request.page-1)*request.pageSize,request.page*request.pageSize).map(view),page:request.page,pageSize:request.pageSize,total:all.length};
    },
  };
}
