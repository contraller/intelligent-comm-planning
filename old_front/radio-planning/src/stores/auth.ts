import { computed, ref, onScopeDispose } from 'vue';
import { defineStore } from 'pinia';
import { previewService, releasePageSessionBinding } from '../services';
import { env } from '../config/env';
import { ApiError } from '../services/types';
import { subscribeAccess } from '../services/access';
import { operationLogger } from '../services/operation-log';
import { routePermissions, safeReturnPath, type Permission } from '../config/permissions';
import type { AuthIdentity } from '../types/system';

export const useAuthStore=defineStore('auth',()=>{
  const identity=ref<AuthIdentity|null>(null),checked=ref(false),error=ref(''),busy=ref(0),generation=ref(0);
  const currentPath=ref(''),bypassLeave=ref(false),transition=ref(false),pendingLogs=ref(0),logWarning=ref(''),notice=ref('');
  const errorCode=ref(''),sessionReplaced=ref(false);
  const can=(p:Permission)=>!!identity.value&&!error.value&&identity.value.permissions.includes(p);
  const pageDenied=computed(()=>!!identity.value&&!!routePermissions[currentPath.value]&&!can(routePermissions[currentPath.value]));
  const blocked=computed(()=>checked.value&&currentPath.value!=='/login'&&(!identity.value||!!error.value||pageDenied.value));
  const cleaners=new Set<()=>void>();
  const leavers=new Map<symbol,{leave:()=>Promise<boolean>;dirty:()=>boolean}>();
  let checking:Promise<boolean>|null=null;
  let checkGeneration=0;
  const codeOf=(reason:unknown)=>reason instanceof ApiError?String(reason.code):'';
  function accept(next:AuthIdentity|null,message='',code=''){
    if(env.mode==='http'&&code==='SESSION_REPLACED')sessionReplaced.value=true;
    // 换号后即使再次校验成功，也不能把旧页面的输入挂到新身份下。
    if(env.mode==='http'&&sessionReplaced.value&&next)return;
    const before=JSON.stringify([identity.value?.sessionId,identity.value?.roleId,identity.value?.permissions,error.value]);
    identity.value=next;error.value=message;errorCode.value=code;checked.value=true;
    if(before!==JSON.stringify([next?.sessionId,next?.roleId,next?.permissions,message]))generation.value++;
  }
  // 订阅统一服务的校验结果；权限变化不等待重新登录。
  const stopAccess=subscribeAccess(n=>{
    if(n.busy!==undefined)busy.value=n.busy;
    if('identity'in n)accept(n.identity??null,n.error?.message??'',codeOf(n.error));
  });
  const stopLogs=operationLogger.subscribe(n=>{pendingLogs.value=n.pending;logWarning.value=n.warning;});
  onScopeDispose(()=>{stopAccess();stopLogs();});
  async function check(){
    if(env.mode==='http'&&(transition.value||busy.value))return false;
    if(checking)return checking;
    const token=checkGeneration;
    const task=(async()=>{try{
      const value=await previewService.getSession();if(token!==checkGeneration)return false;
      accept(value);return !!identity.value&&!error.value;
    }catch(e){
      if(token===checkGeneration&&!['SESSION_CHANGED','HTTP_AUTH_BUSY'].includes(codeOf(e)))accept(null,e instanceof Error?e.message:'会话不可用',codeOf(e));
      return false;
    }})();
    checking=task;
    void task.finally(()=>{if(checking===task)checking=null;});
    return checking;
  }
  function firstPath(target?:unknown){
    const safe=safeReturnPath(target),path=safe?.split('?')[0];
    if(path&&can(routePermissions[path]))return safe!;
    return Object.entries(routePermissions).find(([,p])=>can(p))?.[0]??'/system';
  }
  async function login(username:string,password:string){
    if(busy.value||transition.value)return false;
    transition.value=true;
    // 新登录成功后结束旧会话提示；失败仍保留本次认证错误及原提示。
    try{accept(await previewService.login({username,password}));notice.value='';return true;}
    catch(e){error.value=e instanceof Error?e.message:'登录失败';errorCode.value=codeOf(e);return false;}
    finally{transition.value=false;}
  }
  async function leaveSession(force=false){
    if(busy.value||transition.value){notice.value='正在执行写操作，请完成后再退出';return false;}
    transition.value=true;
    try{
      if(!force)for(const entry of leavers.values())if(!(await entry.leave()))return false;
      await previewService.logout();
      // 退出标记成功后才丢弃输入；失败仍保留组件及未保存现场。
      bypassLeave.value=true;generation.value++;cleaners.forEach(fn=>fn());accept(null);return true;
    }catch(e){notice.value=e instanceof Error?e.message:'退出失败';return false;}
    finally{transition.value=false;}
  }
  function registerLeave(leave:()=>Promise<boolean>,dirty:()=>boolean){
    const key=Symbol();leavers.set(key,{leave,dirty});return()=>{leavers.delete(key);};
  }
  const hasUnsaved=()=>[...leavers.values()].some(x=>x.dirty());
  function registerCleaner(fn:()=>void){cleaners.add(fn);return()=>{cleaners.delete(fn);};}
  async function discardRestricted(){
    if(env.mode==='http'){
      if(busy.value||transition.value)return false;
      transition.value=true;
      try{
        // 明确丢弃只结束本页面现场，不向可能已换人的共享会话发送 logout。
        releasePageSessionBinding();checkGeneration++;checking=null;
        bypassLeave.value=true;generation.value++;cleaners.forEach(fn=>fn());
        sessionReplaced.value=false;notice.value='';accept(null);
      }catch(e){notice.value=e instanceof Error?e.message:'清理页面失败';return false;}
      finally{transition.value=false;}
      await check();return true;
    }
    if(!identity.value||error.value||!Object.values(routePermissions).some(can))return leaveSession(true);
    if(busy.value)return false;
    bypassLeave.value=true;generation.value++;cleaners.forEach(fn=>fn());return true;
  }
  async function retryLogs(){if(await check())operationLogger.retry();}
  return {identity,checked,error,errorCode,sessionReplaced,notice,busy,generation,currentPath,bypassLeave,transition,pendingLogs,logWarning,can,pageDenied,blocked,accept,check,firstPath,login,leaveSession,registerLeave,hasUnsaved,registerCleaner,discardRestricted,retryLogs};
});
