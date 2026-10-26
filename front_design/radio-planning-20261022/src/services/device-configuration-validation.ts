import type { ConfigurationContext, ConfigurationSubmit, ConfigurationValidation, ConfigurationValidationRequest, DeviceConfigurationContext } from '../types/device-configuration';
import { configurationScenarios } from '../mocks/device-configuration-presets';
import { ApiError } from './types';
import { maintenanceModes } from './device-maintenance';
import { DEVICE_CONFIGURATION_PRESET_VERSION } from '../config/demo';

// 边界先检查原值，禁止 JSON 复制把 NaN 转成 null 后掩盖错误。
export function configurationContext(value: unknown): asserts value is ConfigurationContext {
  if(value!=='gis'&&value!=='ledger')throw new ApiError('设备配置页面上下文无效','INVALID_CONFIGURATION');
}
export function configurationRequest(value: ConfigurationValidationRequest): void {
  if(!value||typeof value!=='object')throw new ApiError('配置请求无效','INVALID_CONFIGURATION');
  configurationContext(value.context);
  for(const field of ['deviceId','modelId','resourceEpoch','deviceVersion','presetVersion'] as const)
    if(typeof value[field]!=='string'||!value[field].trim()||value[field].length>200)throw new ApiError('配置身份或版本无效：'+field,'INVALID_CONFIGURATION');
  if(!value.values||!Number.isFinite(value.values.txPowerDbm)||!Number.isFinite(value.values.workFreqKhz))throw new ApiError('频率与功率必须是有效数值','INVALID_CONFIGURATION');
  // 只支持当前配置格式，旧请求不参与校验、核实或重试。
  if(value.presetVersion!==DEVICE_CONFIGURATION_PRESET_VERSION)throw new ApiError('配置格式不支持，原记录已保留','INVALID_CONFIGURATION');
  if(!maintenanceModes.some(m=>m.value===value.values.currentWorkMode))throw new ApiError('请明确选择允许的工作模式','INVALID_CONFIGURATION');
  if(!configurationScenarios.some(s=>s.id===value.scenario))throw new ApiError('教学场景无效','INVALID_CONFIGURATION');
}
export function configurationSubmit(value: ConfigurationSubmit): void {
  configurationRequest(value);
  if(typeof value.requestId!=='string'||!value.requestId.trim()||value.requestId.length>120||value.retryOf!==undefined&&(typeof value.retryOf!=='string'||!value.retryOf.trim()||value.retryOf.length>120))throw new ApiError('配置请求编号无效','INVALID_CONFIGURATION');
}
export function configurationSignature(value: ConfigurationSubmit): string {
  configurationSubmit(value);
  const parts: unknown[]=[value.context,value.deviceId,value.modelId,value.resourceEpoch,value.deviceVersion,value.presetVersion,value.values.txPowerDbm,value.values.workFreqKhz,value.scenario,value.retryOf??null,value.values.currentWorkMode];
  return JSON.stringify(parts);
}
export function validateConfiguration(value: ConfigurationValidationRequest, current: DeviceConfigurationContext): ConfigurationValidation {
  configurationRequest(value);
  if(['deviceId','modelId','resourceEpoch','deviceVersion'].some(key=>value[key as keyof ConfigurationValidationRequest]!==current[key as keyof DeviceConfigurationContext]))throw new ApiError('设备来源已变化，请重新读取配置','CONFIGURATION_SOURCE_CHANGED');
  const issues: ConfigurationValidation['issues']=[];
  if(current.device.availability==='OFF_SHELF')issues.push({field:'deviceId',message:'设备已下架，不能提交配置'});
  if(value.values.txPowerDbm>current.model.txPowerMaxDbm)issues.push({field:'txPowerDbm',message:'发射功率超过型号上限'});
  if(current.powerLevels?.length&&!current.powerLevels.includes(value.values.txPowerDbm))issues.push({field:'txPowerDbm',message:'请选择型号资料提供的功率档位'});
  if(value.values.workFreqKhz<current.model.freqMinKhz||value.values.workFreqKhz>current.model.freqMaxKhz)issues.push({field:'workFreqKhz',message:'频率超出型号范围'});
  if(issues.length)return {valid:false,issues,preset:null};
  const preset=current.presets.find(p=>p.version===value.presetVersion&&p.values.txPowerDbm===value.values.txPowerDbm&&p.values.workFreqKhz===value.values.workFreqKhz&&p.values.currentWorkMode===value.values.currentWorkMode)??null;
  if(!preset)throw new ApiError('此参数组合暂无预生成结果，请选择教学预设','NO_PRESET');
  if(value.scenario==='validation-rejected')issues.push({field:'values',message:'教学预设：服务校验拒绝，未模拟下发'});
  return {valid:!issues.length,issues,preset};
}
