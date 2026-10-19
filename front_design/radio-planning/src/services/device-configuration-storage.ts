import { DEVICE_CONFIGURATION_PENDING_KEY, DEVICE_CONFIGURATION_SCHEMA_VERSION, DEVICE_CONFIGURATION_STORAGE_KEY } from '../config/demo';
import type { ConfigurationPending, ConfigurationWorkspace } from '../types/device-configuration';
import type { ResourceStorage } from '../types/resource-edit';
import { configurationSignature, configurationSubmit } from './device-configuration-validation';
import { ApiError } from './types';

// 读取失败保留原字节，不把损坏记录覆盖成空工作区。
function read(storage:ResourceStorage,key:string):unknown {
  try {const text=storage.getItem(key);return text===null?null:JSON.parse(text);}catch{throw new ApiError('配置记录读取失败，原内容已保留','CONFIGURATION_STORAGE_READ');}
}
function write(storage:ResourceStorage,key:string,value:unknown){
  try{storage.setItem(key,JSON.stringify(value));}catch{throw new ApiError('配置记录保存失败，未报告成功','CONFIGURATION_STORAGE_WRITE');}
}
export function readConfigurationWorkspace(storage:ResourceStorage):ConfigurationWorkspace {
  const value=read(storage,DEVICE_CONFIGURATION_STORAGE_KEY) as ConfigurationWorkspace|null;
  if(value===null)return {schemaVersion:DEVICE_CONFIGURATION_SCHEMA_VERSION,operations:[]};
  try{
    if(value.schemaVersion!==DEVICE_CONFIGURATION_SCHEMA_VERSION||!Array.isArray(value.operations))throw 0;
    const ids=new Set<string>(),requests=new Set<string>();
    for(const op of value.operations){
      configurationSubmit(op.request);
      if(typeof op.id!=='string'||!op.id||ids.has(op.id)||requests.has(op.request.requestId)||op.signature!==configurationSignature(op.request)||op.device?.id!==op.request.deviceId||op.device.modelId!==op.request.modelId||typeof op.modelName!=='string'||!Number.isFinite(Date.parse(op.acceptedAt))||!Number.isFinite(Date.parse(op.updatedAt))||!['DISPATCH','RECEIPT'].includes(op.phase)||!['RUNNING','SUCCEEDED','FAILED'].includes(op.status)||typeof op.message!=='string'||typeof op.source!=='string')throw 0;
      if(op.status==='SUCCEEDED'?(op.phase!=='RECEIPT'||op.appliedValues?.txPowerDbm!==op.request.values.txPowerDbm||op.appliedValues.workFreqKhz!==op.request.values.workFreqKhz):op.appliedValues!==null)throw 0;
      ids.add(op.id);requests.add(op.request.requestId);
    }
    for(const op of value.operations)if(op.request.retryOf&&!value.operations.some(parent=>parent.id===op.request.retryOf&&parent.status==='FAILED'&&parent.request.deviceId===op.request.deviceId))throw 0;
  }catch{throw new ApiError('配置记录损坏或版本不兼容，原内容已保留','CONFIGURATION_STORAGE_CORRUPT');}
  return value;
}
export function saveConfigurationWorkspace(storage:ResourceStorage,value:ConfigurationWorkspace){write(storage,DEVICE_CONFIGURATION_STORAGE_KEY,value);}
function pendingRecords(storage:ResourceStorage):ConfigurationPending[]{
  const value=read(storage,DEVICE_CONFIGURATION_PENDING_KEY) as {schemaVersion:number;items:ConfigurationPending[]}|null;
  if(value===null)return [];
  try{
    if(value.schemaVersion!==1||!Array.isArray(value.items))throw 0;
    const owners=new Set<string>();
    for(const item of value.items){if(typeof item.ownerId!=='string'||!item.ownerId||owners.has(item.ownerId))throw 0;owners.add(item.ownerId);configurationSubmit(item.request);}
  }catch{throw new ApiError('待核实请求记录损坏，原内容已保留','CONFIGURATION_PENDING_CORRUPT');}
  return value.items;
}
export function readConfigurationPending(storage:ResourceStorage,ownerId:string){return pendingRecords(storage).find(p=>p.ownerId===ownerId)?.request??null;}
export function saveConfigurationPending(storage:ResourceStorage,ownerId:string,request:ConfigurationPending['request']|null){
  const items=pendingRecords(storage).filter(p=>p.ownerId!==ownerId);
  if(request){configurationSubmit(request);items.push({ownerId,request:structuredClone(request)});}
  write(storage,DEVICE_CONFIGURATION_PENDING_KEY,{schemaVersion:1,items});
}
