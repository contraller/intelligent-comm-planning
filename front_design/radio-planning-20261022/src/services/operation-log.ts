// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from './random-uuid';
import { browserResourceStorage } from './resource-storage';
import type { ResourceStorage } from '../types/resource-edit';
import type { OperationEvent, AuthIdentity } from '../types/system';
import { readJournal,writeJournal } from './system-storage';

export interface LogNotice { pending: number; warning: string }
export interface OperationLogger {
  record(event:Omit<OperationEvent,'id'|'time'|'epoch'|'dedupeKey'>):void;
  retry():void; reset(epoch:string):void; status():LogNotice; subscribe(fn:(notice:LogNotice)=>void):()=>void;
}
export const actorSnapshot=(a:AuthIdentity|null)=>a?{id:a.id,name:a.name,roleId:a.roleId,roleName:a.roleName}:null;
// 日志写入是附加动作；失败只进入待补队列，绝不能抛出并覆盖业务返回结果。
export function createOperationLogger(getStorage:()=>ResourceStorage,clock=()=>Date.now()):OperationLogger {
  let pending:OperationEvent[]=[],warning='',knownEpoch:string|null=null;
  const listeners=new Set<(n:LogNotice)=>void>();
  const status=()=>({pending:pending.length,warning});
  const notify=()=>listeners.forEach(fn=>fn(status()));
  function append(e:OperationEvent) {
    const storage=getStorage(),w=readJournal(storage);knownEpoch=w.epoch;
    if(e.epoch==='unknown'){
      const reset=w.events.find(x=>x.action==='resetOperationLogs');
      if(reset&&Date.parse(e.time)<=Date.parse(reset.time))return false;
      e.epoch=w.epoch;
    }
    if(e.epoch!==w.epoch)return false;
    if(w.events.some(x=>x.id===e.id||x.dedupeKey===e.dedupeKey))return true;
    w.events.push(e);w.revision='LOGM-'+randomUuid();writeJournal(storage,w);return true;
  }
  return {
    record(event){
      const id='LOG-'+randomUuid(),time=new Date(clock()).toISOString();
      try{knownEpoch=readJournal(getStorage()).epoch;}catch{/* 保留待补记录，读取失败不阻断业务。 */}
      const dedupeKey=event.outcome==='SUCCESS'&&event.requestId?[event.actor?.id??'anonymous',event.action,event.requestId].join(':'):id;
      const e={...event,id,time,epoch:knownEpoch??'unknown',dedupeKey};
      try{if(!append(e))warning='日志批次已被显式重置，旧记录未写回';}
      catch{if(!pending.some(x=>x.dedupeKey===dedupeKey))pending.push(e);warning='操作结果已确定，但日志记录失败；可仅重试补记，刷新或关闭可能丢失待补日志。';}
      notify();
    },
    retry(){
      const remaining:OperationEvent[]=[];let obsolete=false;
      for(const e of pending)try{if(!append(e))obsolete=true;}catch{remaining.push(e);}
      pending=remaining;warning=pending.length?'日志仍未补记，请检查存储权限或空间':obsolete?'旧批次日志已被显式重置，不再补写':'';notify();
    },
    reset(epoch){knownEpoch=epoch;pending=[];warning='日志已显式重置，旧待补记录已废弃';notify();},
    status,
    subscribe(fn){listeners.add(fn);fn(status());return()=>{listeners.delete(fn);};},
  };
}
export const operationLogger=createOperationLogger(browserResourceStorage);
