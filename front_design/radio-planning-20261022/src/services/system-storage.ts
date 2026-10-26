import { SYSTEM_STORAGE_KEY, OPERATION_LOG_KEY } from '../config/demo';
import { initialSystemWorkspace, initialOperationJournal } from '../mocks/system-presets';
import type { ResourceStorage } from '../types/resource-edit';
import type { SystemWorkspace,OperationJournal } from '../types/system';
import { ApiError } from './types';
import { validateSystem,validateJournal } from './system-validation';

// 三类存储各自报错；日志损坏不影响账号配置读取。
function read(storage:ResourceStorage,key:string,domain:string):string|null {
  try{return storage.getItem(key);}catch{throw new ApiError(domain+'读取失败，请检查浏览器存储权限',domain==='系统配置'?'SYSTEM_READ_FAILED':'LOG_READ_FAILED');}
}
export function readSystem(storage:ResourceStorage):SystemWorkspace {
  const raw=read(storage,SYSTEM_STORAGE_KEY,'系统配置');if(raw===null)return initialSystemWorkspace();
  let w:SystemWorkspace;
  try{w=JSON.parse(raw);validateSystem(w);}
  catch(e){if(e instanceof ApiError&&e.code==='SYSTEM_INCOMPATIBLE')throw e;throw new ApiError('系统配置损坏或引用不一致，原记录已保留','SYSTEM_CORRUPT');}
  // 读取仅校验当前版本；不迁移旧配置，也不自动修改角色权限。
  return w;
}
export function writeSystem(storage:ResourceStorage,w:SystemWorkspace) {
  validateSystem(w);
  try{storage.setItem(SYSTEM_STORAGE_KEY,JSON.stringify(w));}catch{throw new ApiError('系统配置保存失败，原值和输入已保留','SYSTEM_WRITE_FAILED');}
}
export function readJournal(storage:ResourceStorage):OperationJournal {
  const raw=read(storage,OPERATION_LOG_KEY,'操作日志');if(raw===null)return initialOperationJournal();
  try{const w=JSON.parse(raw);validateJournal(w);return w;}catch{throw new ApiError('操作日志损坏，业务配置不受影响','LOG_CORRUPT');}
}
export function writeJournal(storage:ResourceStorage,w:OperationJournal) {
  validateJournal(w);
  try{storage.setItem(OPERATION_LOG_KEY,JSON.stringify(w));}catch{throw new ApiError('日志保存失败，业务结果不因此撤销','LOG_WRITE_FAILED');}
}
