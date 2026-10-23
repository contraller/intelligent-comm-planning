import { SESSION_STORAGE_KEY } from '../config/demo';
import type { ResourceStorage } from '../types/resource-edit';
import type { SessionRecord } from '../types/system';
import { ApiError } from './types';
import { systemAssert,textValid,validTime } from './system-validation';

export function browserSessionStorage():ResourceStorage {
  try{return window.sessionStorage;}catch{throw new ApiError('标签页会话存储不可用','SESSION_READ_FAILED');}
}
function validateSession(s:SessionRecord) {
  systemAssert(s&&s.schemaVersion===1&&['ACTIVE','SIGNED_OUT'].includes(s.state)&&textValid(s.id)&&textValid(s.accountId)&&textValid(s.epoch)&&validTime(s.loginAt),'会话记录无效，请重新登录','SESSION_CORRUPT');
  systemAssert(Object.keys(s).every(k=>['schemaVersion','state','id','accountId','epoch','loginAt'].includes(k)),'会话含未允许字段','SESSION_CORRUPT');
}
export function readSession(storage:ResourceStorage):SessionRecord|null {
  let raw:string|null;try{raw=storage.getItem(SESSION_STORAGE_KEY);}catch{throw new ApiError('会话读取失败，请检查标签页存储权限','SESSION_READ_FAILED');}
  if(raw===null)return null;
  try{const s=JSON.parse(raw);validateSession(s);return s.state==='ACTIVE'?s:null;}catch{throw new ApiError('会话损坏，请重新登录','SESSION_CORRUPT');}
}
export function writeSession(storage:ResourceStorage,s:SessionRecord) {
  validateSession(s);
  // 显式退出标记代替 removeItem，不触碰同源其他会话数据。
  try{storage.setItem(SESSION_STORAGE_KEY,JSON.stringify(s));}catch{throw new ApiError('会话写入失败，尚未完成登录或持久退出','SESSION_WRITE_FAILED');}
}
