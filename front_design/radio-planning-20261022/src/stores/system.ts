// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { useAuthStore } from './auth';
import { createReadCancellation } from '../services/data-access';
import type { SystemAccount, SystemRole, SystemParameter, SystemQuery, SystemPage } from '../types/system';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import { togglePermission, type Permission } from '../config/permissions';
import type { SystemOptions, SystemRoleSummary, OperationSummary, SystemAccountQuery, SystemRoleQuery, SystemParameterQuery, SystemLogQuery } from '../types/system';

type AccountForm=Omit<SystemAccount,'id'|'enabled'> & {id:string|null};
type RoleForm=Omit<SystemRole,'id'> & {id:string|null};
export const useSystemStore=defineStore('system',()=>{
  const requests=createReadCancellation();
  const auth=useAuthStore(),catalog=ref<SystemOptions|null>(null),tab=ref<'accounts'|'roles'|'logs'|'parameters'>('accounts');
  const accounts=ref<SystemPage<SystemAccount & {roleName:string;lastLogin:string|null}>|null>(null),roles=ref<SystemPage<SystemRoleSummary>|null>(null);
  const logs=ref<SystemPage<OperationSummary>|null>(null),parameters=ref<SystemPage<SystemParameter>|null>(null);
  const query=ref<SystemQuery>({pageNum:1,pageSize:20}),loading=ref(false),busy=ref(false),error=ref(''),loadError=ref(''),notice=ref('');
  // 输入条件与成功查询分开，翻页不提交尚未查询的筛选输入。
  const appliedQuery=ref<SystemQuery>({pageNum:1,pageSize:20});
  const accountForm=ref<AccountForm|null>(null),roleForm=ref<RoleForm|null>(null),parameterForm=ref<SystemParameter|null>(null),initial=ref(''),baseRevision=ref('');
  const decision=ref<DecisionRequest|null>(null);let resolver:((d:Decision)=>void)|null=null,generation=0;
  const form=computed(()=>accountForm.value??roleForm.value??parameterForm.value);
  const dirty=computed(()=>!!form.value&&JSON.stringify(form.value)!==initial.value);
  const formPermission=computed<Permission>(()=>accountForm.value?'system.accounts':roleForm.value?'system.roles':'system.parameters');
  const canSave=computed(()=>!!form.value&&auth.can(formPermission.value)&&!busy.value);
  const page=computed(()=>({accounts:accounts.value,roles:roles.value,logs:logs.value,parameters:parameters.value})[tab.value]);
  function answer(d:Decision){const next=resolver;resolver=null;decision.value=null;next?.(d);}
  function ask(request:DecisionRequest){if(decision.value||busy.value)return Promise.resolve<Decision>('cancel');decision.value=request;return new Promise<Decision>(resolve=>{resolver=resolve;});}
  function clearFeedback(){error.value='';notice.value='';}
  function resetQuery(){query.value={pageNum:1,pageSize:20};appliedQuery.value={...query.value};}
  function closeForms(){requests.stop('detail');generation++;loading.value=false;accountForm.value=null;roleForm.value=null;parameterForm.value=null;initial.value='';error.value='';}
  // 只有实际改变本人角色或已关联角色权限时才提示权限影响。
  function saveImpact(){
    if(accountForm.value&&accountForm.value.id===auth.identity?.id&&initial.value){
      const before=JSON.parse(initial.value) as AccountForm;
      if(before.roleId!==accountForm.value.roleId)return '修改当前账号角色可能立即收回页面或操作权限。';
    }
    if(roleForm.value?.id&&initial.value){
      const before=JSON.parse(initial.value) as RoleForm,current=roleForm.value.permissions;
      const changed=current.length!==before.permissions.length||current.some(p=>!before.permissions.includes(p));
      if(changed&&(roles.value?.items.some(r=>r.id===roleForm.value!.id&&r.accountCount>0)||auth.identity?.roleId===roleForm.value.id))
        return '保存后，所有使用此角色的账号按新权限操作；已有知识历史身份保持不变。';
    }
    return '';
  }
  async function allowLeave(deferDiscard=false){
    if(busy.value)return false;
    if(dirty.value){
      const choice=await ask({title:'系统表单尚未保存',message:'可保存本次修改，或明确放弃后离开。'+saveImpact(),saveLabel:auth.can(formPermission.value)?'保存并离开':'无保存权限',discardLabel:'放弃修改'});
      if(choice==='cancel'||choice==='save'&&!(await save(true)))return false;
    }
    if(!deferDiscard)closeForms();return true;
  }
  async function load(){
    if(!auth.can('system.view'))return;const token=++generation,session=auth.generation;loading.value=true;loadError.value='';clearFeedback();
    try{const value=await previewService.loadSystemOptions({signal:requests.signal('options')});if(token!==generation||session!==auth.generation)return;catalog.value=value;loading.value=false;await refresh(appliedQuery.value);}
    catch(e){if(token===generation)loadError.value=e instanceof Error?e.message:'系统读取失败';}
    finally{if(token===generation)loading.value=false;}
  }
  async function refresh(nextQuery:SystemQuery=query.value){
    const permission=('system.'+tab.value) as Permission;if(!auth.can(permission))return;
    const token=++generation,session=auth.generation,snapshot={pageNum:1,pageSize:20,...nextQuery};loading.value=true;loadError.value='';clearFeedback();
    try{
      const name=tab.value,q={...snapshot,signal:requests.signal('list')};
      if(name==='accounts'){const value=await previewService.queryAccountSummaries(q as SystemAccountQuery);if(token===generation&&session===auth.generation)accounts.value=value;}
      if(name==='roles'){const value=await previewService.queryRoleSummaries(q as SystemRoleQuery);if(token===generation&&session===auth.generation)roles.value=value;}
      if(name==='logs'){const value=await previewService.queryOperationSummaries(q as SystemLogQuery);if(token===generation&&session===auth.generation)logs.value=value;}
      if(name==='parameters'){const value=await previewService.queryParameterSummaries(q as SystemParameterQuery);if(token===generation&&session===auth.generation)parameters.value=value;}
      if(token===generation&&session===auth.generation){appliedQuery.value=snapshot;query.value.pageNum=snapshot.pageNum;}
    }catch(e){if(token===generation&&session===auth.generation)loadError.value=e instanceof Error?e.message:'列表读取失败';}
    finally{if(token===generation)loading.value=false;}
  }
  async function search(){if(loading.value||busy.value)return;query.value.pageNum=1;await refresh();}
  async function changePage(delta:number){if(loading.value||busy.value)return;await refresh({...appliedQuery.value,pageNum:(page.value?.pageNum??1)+delta});}
  // 首次目录读取中切页签也要补齐目录，避免新建一直缺少选项和基线。
  async function changeTab(next:typeof tab.value){if(!(await allowLeave()))return;tab.value=next;resetQuery();if(catalog.value)await refresh();else await load();}
  // 单对象详情自带提交基线；列表摘要只用于选择身份。
  async function readForm<T>(read:(signal:AbortSignal)=>Promise<T>,apply:(value:T)=>void){
    const token=++generation,session=auth.generation;loading.value=true;clearFeedback();
    try{const value=await read(requests.signal('detail'));if(token===generation&&session===auth.generation)apply(value);}
    catch(e){if(token===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'详情读取失败，请重试';}
    finally{if(token===generation)loading.value=false;}
  }
  async function openAccount(account?:Pick<SystemAccount,'id'>){
    if(!auth.can('system.accounts')||(!account&&!catalog.value)||!(await allowLeave()))return;
    clearFeedback();
    if(account)await readForm(signal=>previewService.getSystemAccount({id:account.id,signal}),value=>{const {enabled,...form}=value.account;accountForm.value=form;baseRevision.value=value.revision;initial.value=JSON.stringify(accountForm.value);});
    else{accountForm.value={id:null,username:'',name:'',department:'',roleId:catalog.value?.roles[0]?.id??''};baseRevision.value=catalog.value?.revision??'';initial.value=JSON.stringify(accountForm.value);}
  }
  async function openRole(role?:Pick<SystemRole,'id'>){
    if(!auth.can('system.roles')||(!role&&!catalog.value)||!(await allowLeave()))return;
    clearFeedback();
    if(role)await readForm(signal=>previewService.getSystemRole({id:role.id,signal}),value=>{roleForm.value=value.role;baseRevision.value=value.revision;initial.value=JSON.stringify(roleForm.value);});
    else{roleForm.value={id:null,name:'',description:'',permissions:[]};baseRevision.value=catalog.value?.revision??'';initial.value=JSON.stringify(roleForm.value);}
  }
  async function openParameter(p:Pick<SystemParameter,'id'>){
    if(!auth.can('system.parameters')||!(await allowLeave()))return;
    await readForm(signal=>previewService.getSystemParameter({id:p.id,signal}),value=>{parameterForm.value=value.parameter;baseRevision.value=value.revision;initial.value=JSON.stringify(parameterForm.value);});
  }
  function toggle(code:Permission,on:boolean){if(canSave.value&&roleForm.value)roleForm.value.permissions=togglePermission(roleForm.value.permissions,code,on);}
  async function save(impactConfirmed=false){
    if(!canSave.value)return false;
    if(!dirty.value){closeForms();notice.value='内容未变化';return true;}
    const impact=saveImpact();
    if(impact&&!impactConfirmed){
      const choice=await ask({title:'确认账号与权限影响',message:impact,saveLabel:'确认保存'});
      if(choice!=='save'||!canSave.value)return false;
    }
    busy.value=true;clearFeedback();
    try{
      const mutation={baseRevision:baseRevision.value,requestId:randomUuid()};
      const result=accountForm.value?await previewService.saveSystemAccount({...mutation,account:JSON.parse(JSON.stringify(accountForm.value))}):
        roleForm.value?await previewService.saveSystemRole({...mutation,role:JSON.parse(JSON.stringify(roleForm.value))}):
        await previewService.saveSystemParameter({...mutation,parameterId:parameterForm.value!.id,value:parameterForm.value!.value});
      initial.value=JSON.stringify(form.value);baseRevision.value=result.revision;
      closeForms();if(auth.can('system.view'))await load();notice.value=result.changed?'修改已保存':'内容未变化';return true;
    }catch(e){error.value=e instanceof Error?e.message:'保存失败，输入已保留';return false;}
    finally{busy.value=false;}
  }
  async function setEnabled(account:SystemAccount){
    if(!auth.can('system.accounts')||!(await allowLeave()))return;
    clearFeedback();
    if(await ask({title:account.enabled?'停用账号':'启用账号',message:account.enabled?'停用后，该账号下次校验即失效。未保存输入冻结，已提交业务任务保留。':'启用后，该账号可按关联角色的权限登录。',saveLabel:'确认'})!=='save')return;
    busy.value=true;
    try{await previewService.setSystemAccountState({baseRevision:accounts.value!.revision,requestId:randomUuid(),accountId:account.id,enabled:!account.enabled});await load();notice.value='账号状态已保存';}
    catch(e){error.value=e instanceof Error?e.message:'状态修改失败';}finally{busy.value=false;}
  }
  async function reset(kind:'system'|'logs'){
    if(!auth.can('system.reset')||kind==='logs'&&!auth.can('system.logs')||busy.value)return;
    clearFeedback();
    const message=kind==='system'?'恢复初始账号、角色和参数，所有旧会话失效；保留资源、规划、诊断、知识及日志。未保存系统表单将被丢弃。':'清空操作日志和旧待补记录，保留本次重置事件；业务数据和系统配置不变。';
    if(await ask({title:kind==='system'?'重置系统配置':'重置操作日志',message,saveLabel:'确认重置'})!=='save')return;
    busy.value=true;error.value='';
    try{
      if(kind==='system'){await previewService.resetSystemWorkspace({baseRevision:catalog.value!.revision,requestId:randomUuid()});closeForms();}
      else{await previewService.resetOperationLogs({baseRevision:logs.value?.revision??null});await refresh(appliedQuery.value);}
      notice.value='重置已完成';
    }catch(e){error.value=e instanceof Error?e.message:'重置失败';}finally{busy.value=false;}
  }
  function stopQueries(){requests.stop();generation++;loading.value=false;answer('cancel');}
  function clearForSession(){stopQueries();closeForms();catalog.value=null;accounts.value=null;roles.value=null;logs.value=null;parameters.value=null;resetQuery();tab.value='accounts';loadError.value='';notice.value='';}
  return {catalog,tab,accounts,roles,logs,parameters,query,appliedQuery,loading,busy,error,loadError,notice,accountForm,roleForm,parameterForm,dirty,canSave,decision,page,load,refresh,search,changePage,changeTab,resetQuery,openAccount,openRole,openParameter,toggle,save,setEnabled,reset,allowLeave,answer,stopQueries,clearForSession};
});
