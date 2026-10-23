import { allPermissions, permissions, adminPermissions, type Permission } from '../config/permissions';
import { SYSTEM_PAGE_SIZE, SYSTEM_PRESET_VERSION, SYSTEM_SCHEMA_VERSION } from '../config/demo';
import { systemParameters } from '../mocks/system-presets';
import type { SystemWorkspace, SystemQuery, SystemPage, OperationJournal } from '../types/system';
import { ApiError } from './types';
import { pageItems, validPageQuery } from './data-access';

export function systemAssert(ok: unknown,message: string,code='SYSTEM_INVALID'): asserts ok {
  if(!ok)throw new ApiError(message,code);
}
export const textValid=(s:unknown,min=1,max=120):s is string=>typeof s==='string'&&s.trim().length>=min&&s.length<=max;
export const validTime=(s:unknown):s is string=>typeof s==='string'&&Number.isFinite(Date.parse(s));
// 固定北京时间的单日范围；回查日历日期，拒绝被 Date 自动归一化的无效日期。
export function systemDateRange(value:unknown):{start:number;end:number}|null {
  if(value===undefined||value==='')return null;
  systemAssert(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value),'日志日期须为有效的年月日');
  const start=Date.parse(value+'T00:00:00+08:00'),day=24*60*60*1000;
  systemAssert(Number.isFinite(start)&&new Date(start+8*60*60*1000).toISOString().slice(0,10)===value,'日志日期须为有效的年月日');
  return {start,end:start+day};
}
// 幂等比较保留非法数值，不能把 NaN 复制成合法空值。
export function systemSignature(value:unknown):string {
  if(typeof value==='number'&&!Number.isFinite(value))return 'invalid:'+String(value);
  if(Array.isArray(value))return '['+value.map(systemSignature).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+systemSignature(v)).join(',')+'}';
  return JSON.stringify(value)??'undefined';
}
export function assertPermissions(codes:Permission[],roleId?:string) {
  systemAssert(Array.isArray(codes)&&new Set(codes).size===codes.length&&codes.every(p=>allPermissions.includes(p)),'权限含重复或未知编码');
  for(const p of permissions)if(codes.includes(p.code))systemAssert(p.requires.every(r=>codes.includes(r)),p.name+'缺少依赖的查看或审核权限');
  // 混授例外只属于内置管理员角色，不能通过角色名称取得。
  systemAssert(roleId==='ROLE-ADMIN'||!(codes.includes('knowledge.edit')&&codes.some(p=>['knowledge.review','knowledge.publish','knowledge.rollback','knowledge.reset'].includes(p))),'知识编辑与审核侧权限不能同时授予');
}
export function validateSystem(w:SystemWorkspace) {
  systemAssert(w&&w.schemaVersion===SYSTEM_SCHEMA_VERSION&&w.presetVersion===SYSTEM_PRESET_VERSION,'系统存储版本不兼容','SYSTEM_INCOMPATIBLE');
  systemAssert(textValid(w.revision)&&textValid(w.epoch)&&Array.isArray(w.accounts)&&Array.isArray(w.roles)&&Array.isArray(w.parameters)&&Array.isArray(w.receipts),'系统配置结构无效');
  const ids=new Set<string>(),unique=(id:string)=>{systemAssert(textValid(id)&&!ids.has(id),'对象 ID 无效或重复');ids.add(id);};
  const names=new Set<string>();
  for(const r of w.roles){
    unique(r.id);systemAssert(textValid(r.name,1,40)&&textValid(r.description,0,200),'角色名称或说明无效');
    systemAssert(!names.has(r.name.trim()),'角色名称重复');names.add(r.name.trim());assertPermissions(r.permissions,r.id);
  }
  const users=new Set<string>();
  for(const a of w.accounts){
    unique(a.id);systemAssert(typeof a.username==='string'&&/^[a-z][a-z0-9_.-]{2,31}$/.test(a.username)&&!users.has(a.username),'登录名格式无效或重复');users.add(a.username);
    systemAssert(textValid(a.name,1,40)&&textValid(a.department,1,60)&&typeof a.enabled==='boolean'&&w.roles.some(r=>r.id===a.roleId),'账号名称、部门、角色或状态无效');
  }
  systemAssert(w.accounts.some(a=>a.enabled&&adminPermissions.every(p=>w.roles.find(r=>r.id===a.roleId)!.permissions.includes(p))),'必须保留至少一个启用且具备完整系统管理权限的账号','LAST_ADMIN');
  systemAssert(w.parameters.length===systemParameters.length,'参数目录不完整');
  for(const p of w.parameters){
    unique(p.id);const preset=systemParameters.find(x=>x.id===p.id);systemAssert(preset,'未知参数');
    const {value:unused,...definition}=p,{value:ignored,...expected}=preset;
    systemAssert(systemSignature(definition)===systemSignature(expected),'参数名称、范围、单位或只读属性不可修改');
    systemAssert(p.readonly?p.value===preset.value:typeof p.value==='number'&&Number.isInteger(p.value)&&p.value>=p.min!&&p.value<=p.max!,'参数须为允许范围内的整数；固定坐标系不可修改');
  }
  const requests=new Set<string>();
  for(const r of w.receipts){systemAssert(r&&textValid(r.requestId)&&!requests.has(r.requestId)&&textValid(r.signature,1,100000)&&textValid(r.objectId)&&typeof r.changed==='boolean','系统请求回执无效');requests.add(r.requestId);}
}
export function validateJournal(w:OperationJournal) {
  systemAssert(w&&w.schemaVersion===1&&textValid(w.revision)&&textValid(w.epoch)&&Array.isArray(w.events),'操作日志结构或版本无效','LOG_CORRUPT');
  const ids=new Set<string>(),keys=new Set<string>();
  for(const e of w.events){
    systemAssert(e&&textValid(e.id)&&!ids.has(e.id)&&e.epoch===w.epoch&&validTime(e.time),'日志身份、时间或批次无效','LOG_CORRUPT');ids.add(e.id);
    systemAssert(e.actor===null||(textValid(e.actor.id)&&textValid(e.actor.name,1,40)&&textValid(e.actor.roleId)&&textValid(e.actor.roleName,1,40)),'日志身份快照无效','LOG_CORRUPT');
    systemAssert(textValid(e.attemptedUsername,0,32)&&textValid(e.module,1,40)&&textValid(e.action,1,80)&&textValid(e.objectId,0,500)&&textValid(e.summary,0,500)&&textValid(e.errorCode,0,120)&&textValid(e.dedupeKey,1,1000)&&['SUCCESS','FAILED','DENIED','UNCHANGED'].includes(e.outcome)&&(e.requestId===null||textValid(e.requestId)),'日志内容无效','LOG_CORRUPT');
    systemAssert(!keys.has(e.dedupeKey),'日志去重键重复','LOG_CORRUPT');keys.add(e.dedupeKey);
  }
}
export function systemPage<T extends object>(items:T[],q:SystemQuery,revision:string,epoch?:string):SystemPage<T> {
  systemAssert(q&&typeof q==='object'&&textValid(q.search??'',0,200),'查询条件无效');
  const pagination={pageNum:q.pageNum??1,pageSize:q.pageSize??SYSTEM_PAGE_SIZE};
  systemAssert(validPageQuery(pagination),'分页参数无效');
  // 保持服务原顺序分页；越界返回空页，不引入默认排序或旧排序参数兼容。
  const result=pageItems(items,pagination);
  return {...result,items:structuredClone(result.items),revision,epoch};
}
