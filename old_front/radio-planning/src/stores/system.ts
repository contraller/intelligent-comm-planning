import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { useAuthStore } from './auth';
import type { SystemAccount, SystemRole, SystemParameter, SystemCatalog, SystemQuery, OperationEvent, SystemPage } from '../types/system';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import { togglePermission, type Permission } from '../config/permissions';

type AccountForm=Omit<SystemAccount,'id'|'enabled'> & {id:string|null};
type RoleForm=Omit<SystemRole,'id'> & {id:string|null};
export const useSystemStore=defineStore('system',()=>{
  const auth=useAuthStore(),catalog=ref<SystemCatalog|null>(null),tab=ref<'accounts'|'roles'|'logs'|'parameters'>('accounts');
  const accounts=ref<SystemPage<SystemAccount & {roleName:string;lastLogin:string|null}>|null>(null),roles=ref<SystemPage<SystemRole & {accountCount:number}>|null>(null);
  const logs=ref<SystemPage<OperationEvent>|null>(null),parameters=ref<SystemPage<SystemParameter>|null>(null);
  const query=ref<SystemQuery>({page:1}),loading=ref(false),busy=ref(false),error=ref(''),loadError=ref(''),notice=ref('');
  const accountForm=ref<AccountForm|null>(null),roleForm=ref<RoleForm|null>(null),parameterForm=ref<SystemParameter|null>(null),initial=ref(''),baseRevision=ref('');
  const decision=ref<DecisionRequest|null>(null);let resolver:((d:Decision)=>void)|null=null,generation=0;
  const form=computed(()=>accountForm.value??roleForm.value??parameterForm.value);
  const dirty=computed(()=>!!form.value&&JSON.stringify(form.value)!==initial.value);
  const formPermission=computed<Permission>(()=>accountForm.value?'system.accounts':roleForm.value?'system.roles':'system.parameters');
  const canSave=computed(()=>!!form.value&&auth.can(formPermission.value)&&!busy.value);
  const page=computed(()=>({accounts:accounts.value,roles:roles.value,logs:logs.value,parameters:parameters.value})[tab.value]);
  function answer(d:Decision){const next=resolver;resolver=null;decision.value=null;next?.(d);}
  function ask(request:DecisionRequest){if(decision.value||busy.value)return Promise.resolve<Decision>('cancel');decision.value=request;return new Promise<Decision>(resolve=>{resolver=resolve;});}
  function closeForms(){accountForm.value=null;roleForm.value=null;parameterForm.value=null;initial.value='';error.value='';}
  async function allowLeave(deferDiscard=false){
    if(busy.value)return false;
    if(dirty.value){
      const choice=await ask({title:'系统表单尚未保存',message:'可保存本次修改，或明确放弃后离开。',saveLabel:auth.can(formPermission.value)?'保存并离开':'无保存权限',discardLabel:'放弃修改'});
      if(choice==='cancel'||choice==='save'&&!(await save()))return false;
    }
    if(!deferDiscard)closeForms();return true;
  }
  async function load(){
    if(!auth.can('system.view'))return;const token=++generation,session=auth.generation;loading.value=true;loadError.value='';
    try{const value=await previewService.loadSystemCatalog();if(token!==generation||session!==auth.generation)return;catalog.value=value;loading.value=false;await refresh();}
    catch(e){if(token===generation)loadError.value=e instanceof Error?e.message:'系统读取失败';}
    finally{if(token===generation)loading.value=false;}
  }
  async function refresh(){
    const permission=('system.'+tab.value) as Permission;if(!auth.can(permission))return;
    const token=++generation,session=auth.generation;loading.value=true;loadError.value='';
    try{
      const name=tab.value,q={...query.value};
      if(name==='accounts'){const value=await previewService.querySystemAccounts(q);if(token===generation&&session===auth.generation)accounts.value=value;}
      if(name==='roles'){const value=await previewService.querySystemRoles(q);if(token===generation&&session===auth.generation)roles.value=value;}
      if(name==='logs'){const value=await previewService.queryOperationLogs(q);if(token===generation&&session===auth.generation)logs.value=value;}
      if(name==='parameters'){const value=await previewService.querySystemParameters(q);if(token===generation&&session===auth.generation)parameters.value=value;}
    }catch(e){if(token===generation)loadError.value=e instanceof Error?e.message:'列表读取失败';}
    finally{if(token===generation)loading.value=false;}
  }
  async function changeTab(next:typeof tab.value){if(!(await allowLeave()))return;tab.value=next;query.value={page:1};await refresh();}
  async function openAccount(account?:SystemAccount){
    if(!auth.can('system.accounts')||!(await allowLeave()))return;
    accountForm.value=account?{id:account.id,username:account.username,name:account.name,department:account.department,roleId:account.roleId}:{id:null,username:'',name:'',department:'',roleId:catalog.value?.roles[0]?.id??''};
    baseRevision.value=accounts.value?.revision??catalog.value?.revision??'';initial.value=JSON.stringify(form.value);
  }
  async function openRole(role?:SystemRole){
    if(!auth.can('system.roles')||!(await allowLeave()))return;
    roleForm.value=role?JSON.parse(JSON.stringify(role)):{id:null,name:'',description:'',permissions:[]};
    baseRevision.value=roles.value?.revision??catalog.value?.revision??'';initial.value=JSON.stringify(form.value);
  }
  async function openParameter(p:SystemParameter){
    if(!auth.can('system.parameters')||!(await allowLeave()))return;
    parameterForm.value={...p};baseRevision.value=parameters.value?.revision??catalog.value?.revision??'';initial.value=JSON.stringify(form.value);
  }
  function toggle(code:Permission,on:boolean){if(canSave.value&&roleForm.value)roleForm.value.permissions=togglePermission(roleForm.value.permissions,code,on);}
  async function save(){
    if(!canSave.value)return false;
    // 改自己的角色或修改共享角色，先明确影响；服务再次检查最后管理员与新权限。
    if(accountForm.value?.id===auth.identity?.id||roleForm.value){
      const choice=await ask({title:'确认账号与权限影响',message:roleForm.value?'保存后，所有使用此角色的账号按新权限操作；已有知识历史身份保持不变。':'修改当前账号角色可能立即收回页面或操作权限。',saveLabel:'确认保存'});
      if(choice!=='save'||!canSave.value)return false;
    }
    busy.value=true;error.value='';
    try{
      const mutation={baseRevision:baseRevision.value,requestId:crypto.randomUUID()};
      const result=accountForm.value?await previewService.saveSystemAccount({...mutation,account:JSON.parse(JSON.stringify(accountForm.value))}):
        roleForm.value?await previewService.saveSystemRole({...mutation,role:JSON.parse(JSON.stringify(roleForm.value))}):
        await previewService.saveSystemParameter({...mutation,parameterId:parameterForm.value!.id,value:parameterForm.value!.value});
      initial.value=JSON.stringify(form.value);baseRevision.value=result.revision;
      notice.value=result.changed?'修改已保存':'内容未变化';closeForms();if(auth.can('system.view'))await load();return true;
    }catch(e){error.value=e instanceof Error?e.message:'保存失败，输入已保留';return false;}
    finally{busy.value=false;}
  }
  async function setEnabled(account:SystemAccount){
    if(!auth.can('system.accounts')||!(await allowLeave()))return;
    if(await ask({title:account.enabled?'停用账号':'启用账号',message:account.enabled?'停用后，该账号下次校验即失效。未保存输入冻结，已提交业务任务保留。':'启用后可使用公开演示口令登录。',saveLabel:'确认'})!=='save')return;
    busy.value=true;error.value='';
    try{await previewService.setSystemAccountState({baseRevision:accounts.value!.revision,requestId:crypto.randomUUID(),accountId:account.id,enabled:!account.enabled});notice.value='账号状态已保存';await load();}
    catch(e){error.value=e instanceof Error?e.message:'状态修改失败';}finally{busy.value=false;}
  }
  async function reset(kind:'system'|'logs'){
    if(!auth.can('system.reset')||kind==='logs'&&!auth.can('system.logs')||busy.value)return;
    const message=kind==='system'?'恢复初始账号、角色和演示参数，所有旧会话失效；保留资源、规划、诊断、知识及日志。未保存系统表单将被丢弃。':'清空操作日志和旧待补记录，保留本次重置事件；业务数据和系统配置不变。';
    if(await ask({title:kind==='system'?'重置系统配置':'重置操作日志',message,saveLabel:'确认重置'})!=='save')return;
    busy.value=true;error.value='';
    try{
      if(kind==='system'){await previewService.resetSystemWorkspace({baseRevision:catalog.value!.revision,requestId:crypto.randomUUID()});closeForms();}
      else{await previewService.resetOperationLogs({baseRevision:logs.value?.revision??null});await refresh();}
      notice.value='重置已完成';
    }catch(e){error.value=e instanceof Error?e.message:'重置失败';}finally{busy.value=false;}
  }
  function stopQueries(){generation++;loading.value=false;answer('cancel');}
  function clearForSession(){stopQueries();closeForms();catalog.value=null;accounts.value=null;roles.value=null;logs.value=null;parameters.value=null;query.value={page:1};tab.value='accounts';loadError.value='';notice.value='';}
  return {catalog,tab,accounts,roles,logs,parameters,query,loading,busy,error,loadError,notice,accountForm,roleForm,parameterForm,dirty,canSave,decision,page,load,refresh,changeTab,openAccount,openRole,openParameter,toggle,save,setEnabled,reset,allowLeave,answer,stopQueries,clearForSession};
});
