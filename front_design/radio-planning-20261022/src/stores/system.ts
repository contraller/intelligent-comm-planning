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
import { env } from '../config/env';
import { ApiError } from '../services/types';
import type { SystemResult } from '../types/system';
import type { PasswordFields } from '../types/local-identity';
import type { SystemOptions, SystemRoleSummary, OperationSummary, SystemAccountQuery, SystemRoleQuery, SystemParameterQuery, SystemLogQuery } from '../types/system';
import { useRuntimeParametersStore } from './runtime-parameters';

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
  const passwordTarget=ref<{mode:'SELF'|'ADMIN';accountId:string;baseRevision:string}|null>(null),secretDirty=ref(false);
  const formOwner=ref('');
  const sessionStamp=()=>JSON.stringify([auth.generation,auth.identity?.id,auth.identity?.sessionId]);
  const identityStamp=()=>JSON.stringify([auth.generation,auth.identity?.id,auth.identity?.sessionId,auth.identity?.revision]);
  const pendingMutation=ref<{requestId:string;action:string;actorId:string}|null>(null);
  const decision=ref<DecisionRequest|null>(null);let resolver:((d:Decision)=>void)|null=null,generation=0;
  const form=computed(()=>accountForm.value??roleForm.value??parameterForm.value);
  const dirty=computed(()=>secretDirty.value||!!form.value&&JSON.stringify(form.value)!==initial.value);
  const formPermission=computed<Permission>(()=>accountForm.value?'system.accounts':roleForm.value?'system.roles':'system.parameters');
  const ownsForm=computed(()=>!!formOwner.value&&formOwner.value===identityStamp());
  const canSave=computed(()=>!!form.value&&ownsForm.value&&auth.can(formPermission.value)&&!busy.value&&!pendingMutation.value);
  const canSubmitPassword=computed(()=>!!passwordTarget.value&&ownsForm.value&&!busy.value&&!pendingMutation.value&&(passwordTarget.value.mode==='SELF'?passwordTarget.value.accountId===auth.identity?.id:auth.can('system.accounts')));
  const page=computed(()=>({accounts:accounts.value,roles:roles.value,logs:logs.value,parameters:parameters.value})[tab.value]);
  function answer(d:Decision){const next=resolver;resolver=null;decision.value=null;next?.(d);}
  function ask(request:DecisionRequest){if(decision.value||busy.value)return Promise.resolve<Decision>('cancel');decision.value=request;return new Promise<Decision>(resolve=>{resolver=resolve;});}
  function clearFeedback(){error.value='';notice.value='';}
  function resetQuery(){query.value={pageNum:1,pageSize:20};appliedQuery.value={...query.value};}
  function closeForms(){requests.stop('detail');generation++;loading.value=false;accountForm.value=null;roleForm.value=null;parameterForm.value=null;passwordTarget.value=null;formOwner.value='';secretDirty.value=false;initial.value='';error.value='';}
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
    const actor=identityStamp(),session=sessionStamp();
    if(pendingMutation.value){
      const choice=await ask({title:'操作结果尚未核实',message:'请求编号 '+pendingMutation.value.requestId+' 已保留。离开不会撤销服务端事务，不应重新提交相同操作。',saveLabel:'核实回执',discardLabel:'保留编号并离开'});
      if(actor!==identityStamp()||choice==='cancel'||choice==='save'&&!(await reconcilePending()))return false;
      if(session!==sessionStamp())return false;
    }
    if(secretDirty.value){
      const choice=await ask({title:'密码输入尚未提交',message:'离开将放弃当前表单及密码输入。',discardLabel:'放弃并离开'});
      if(actor!==identityStamp()||choice!=='discard')return false;
      secretDirty.value=false;
      if(passwordTarget.value)passwordTarget.value=null;
      if(!deferDiscard)closeForms();return true;
    }
    if(dirty.value){
      const choice=await ask({title:'系统表单尚未保存',message:'可保存本次修改，或明确放弃后离开。'+saveImpact(),saveLabel:canSave.value?'保存并离开':'当前身份不可保存',discardLabel:'放弃修改'});
      if(actor!==identityStamp()||choice==='cancel'||choice==='save'&&!(await save(true)))return false;
      if(session!==sessionStamp())return false;
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
    const token=++generation,session=auth.generation,actor=identityStamp();loading.value=true;clearFeedback();
    try{const value=await read(requests.signal('detail'));if(token===generation&&actor===identityStamp()){apply(value);formOwner.value=actor;}}
    catch(e){if(token===generation&&session===auth.generation)error.value=e instanceof Error?e.message:'详情读取失败，请重试';}
    finally{if(token===generation)loading.value=false;}
  }
  async function openAccount(account?:Pick<SystemAccount,'id'>){
    const actor=identityStamp();
    if(!auth.can('system.accounts')||(!account&&!catalog.value)||!(await allowLeave()))return;
    if(actor!==identityStamp()||!auth.can('system.accounts'))return;
    clearFeedback();
    if(account)await readForm(signal=>previewService.getSystemAccount({id:account.id,signal}),value=>{const {enabled,...form}=value.account;accountForm.value=form;baseRevision.value=value.revision;initial.value=JSON.stringify(accountForm.value);});
    else{accountForm.value={id:null,username:'',name:'',department:'',roleId:catalog.value?.roles[0]?.id??''};baseRevision.value=catalog.value?.revision??'';initial.value=JSON.stringify(accountForm.value);formOwner.value=actor;}
  }
  async function openRole(role?:Pick<SystemRole,'id'>){
    const actor=identityStamp();
    if(!auth.can('system.roles')||(!role&&!catalog.value)||!(await allowLeave()))return;
    if(actor!==identityStamp()||!auth.can('system.roles'))return;
    clearFeedback();
    if(role)await readForm(signal=>previewService.getSystemRole({id:role.id,signal}),value=>{roleForm.value=value.role;baseRevision.value=value.revision;initial.value=JSON.stringify(roleForm.value);});
    else{roleForm.value={id:null,name:'',description:'',permissions:[]};baseRevision.value=catalog.value?.revision??'';initial.value=JSON.stringify(roleForm.value);formOwner.value=actor;}
  }
  async function openParameter(p:Pick<SystemParameter,'id'>){
    const actor=identityStamp();
    if(!auth.can('system.parameters')||!(await allowLeave()))return;
    if(actor!==identityStamp()||!auth.can('system.parameters'))return;
    await readForm(signal=>previewService.getSystemParameter({id:p.id,signal}),value=>{parameterForm.value=value.parameter;baseRevision.value=value.revision;initial.value=JSON.stringify(parameterForm.value);});
  }
  function toggle(code:Permission,on:boolean){if(canSave.value&&roleForm.value)roleForm.value.permissions=togglePermission(roleForm.value.permissions,code,on);}
  async function runWrite(action:string,send:(requestId:string)=>Promise<SystemResult>){
    if(pendingMutation.value)throw new ApiError('请先核实上次操作回执','OPERATION_UNCERTAIN');
    const requestId=randomUuid(),actorId=auth.identity?.id??'',writer=identityStamp();
    if(env.mode==='http')pendingMutation.value={requestId,action,actorId};
    try{const result=await send(requestId);pendingMutation.value=null;
      // 事务成功与参数刷新分离；刷新失败不把已提交写入伪报失败。
      if(env.mode==='http'&&writer===identityStamp()&&['PAR-01','PAR-02','parameters'].includes(result.objectId))void useRuntimeParametersStore().refresh().catch(()=>{});
      return result;}
    catch(e){
      const uncertain=e instanceof ApiError&&['NETWORK_ERROR','REQUEST_TIMEOUT','INVALID_RESPONSE','INVALID_ENVELOPE','INVALID_SYSTEM_RESPONSE','REQUEST_ABORTED'].includes(String(e.code));
      if(!uncertain)pendingMutation.value=null;
      throw e;
    }
  }
  async function reconcilePending(){
    const pending=pendingMutation.value;if(!pending||busy.value)return !pending;
    const actor=identityStamp();
    if(pending.actorId!==auth.identity?.id){error.value='原操作必须由原账号重新认证后核实';return false;}
    if(!previewService.getSystemOperation){error.value='操作回执入口尚未接线，保留原请求编号';return false;}
    busy.value=true;
    try{const result=await previewService.getSystemOperation({requestId:pending.requestId});
      if(actor!==identityStamp()||pending!==pendingMutation.value){error.value='核实期间身份已变化，原请求编号继续保留';return false;}
      if(result.status==='NOT_FOUND'){error.value='尚未查到回执，不能判定失败；保留原请求编号，不自动重试';return false;}
      if(env.mode==='http'&&['PAR-01','PAR-02','parameters'].includes(result.objectId))void useRuntimeParametersStore().refresh().catch(()=>{});
      pendingMutation.value=null;closeForms();await auth.check();if(auth.can('system.view'))await load();notice.value='已核实操作提交成功';return true;
    }catch(e){error.value=e instanceof Error?e.message:'回执核实失败';return false;}finally{busy.value=false;}
  }
  async function save(impactConfirmed=false,secrets?:{initialPassword?:string}){
    if(!canSave.value)return false;
    if(!dirty.value){closeForms();notice.value='内容未变化';return true;}
    if(env.mode==='http'&&accountForm.value&&!accountForm.value.id&&!secrets?.initialPassword){error.value='新增账号请在密码字段显式输入初始密码';return false;}
    const submittedForm=form.value,serialized=JSON.stringify(submittedForm),actor=identityStamp(),session=sessionStamp(),baseline=baseRevision.value;
    const account=accountForm.value?JSON.parse(serialized) as AccountForm:null,role=roleForm.value?JSON.parse(serialized) as RoleForm:null;
    const parameter=parameterForm.value?{id:parameterForm.value.id,value:parameterForm.value.value}:null;
    const impact=saveImpact();
    if(impact&&!impactConfirmed){
      const choice=await ask({title:'确认账号与权限影响',message:impact,saveLabel:'确认保存'});
      if(choice!=='save'||!canSave.value||actor!==identityStamp()||submittedForm!==form.value||serialized!==JSON.stringify(form.value))return false;
    }
    busy.value=true;clearFeedback();
    try{
      const result=await runWrite('form.save',requestId=>{
        const mutation={baseRevision:baseline,requestId};
        return account?previewService.saveSystemAccount({...mutation,account,...(secrets?.initialPassword?{initialPassword:secrets.initialPassword}:{})}):
          role?previewService.saveSystemRole({...mutation,role}):
          previewService.saveSystemParameter({...mutation,parameterId:parameter!.id,value:parameter!.value});
      });
      // 先关闭确已提交的原表单；不能丢弃后续身份新打开的现场。
      if(form.value===submittedForm)closeForms();
      // 已确认的本人写入可推进身份版本；换会话仍停止后续刷新。
      if(session!==sessionStamp()){notice.value='原账号操作已提交；当前页面身份已变化';return true;}
      if(result.reauthenticationRequired)await auth.check();if(auth.can('system.view'))await load();notice.value=result.reauthenticationRequired?'修改已提交，请重新登录':result.changed?'修改已保存':'内容未变化';return true;
    }catch(e){error.value=e instanceof Error?e.message:'保存失败，输入已保留';return false;}
    finally{busy.value=false;}
  }
  async function setEnabled(account:SystemAccount){
    const actor=identityStamp(),session=sessionStamp(),snapshot={baseRevision:accounts.value?.revision,accountId:account.id,enabled:!account.enabled};
    if(!auth.can('system.accounts')||!(await allowLeave()))return;
    if(actor!==identityStamp()||!auth.can('system.accounts')||pendingMutation.value||!snapshot.baseRevision)return;
    clearFeedback();
    if(await ask({title:account.enabled?'停用账号':'启用账号',message:account.enabled?'停用后，该账号下次校验即失效。未保存输入冻结，已提交业务任务保留。':'启用后，该账号可按关联角色的权限登录。',saveLabel:'确认'})!=='save')return;
    if(actor!==identityStamp()||!auth.can('system.accounts')||pendingMutation.value)return;
    busy.value=true;
    try{const result=await runWrite('account.state',requestId=>previewService.setSystemAccountState({...snapshot,baseRevision:snapshot.baseRevision!,requestId}));if(session===sessionStamp()){if(result.reauthenticationRequired)await auth.check();if(auth.can('system.view'))await load();}notice.value='账号状态已提交';}
    catch(e){error.value=e instanceof Error?e.message:'状态修改失败';}finally{busy.value=false;}
  }
  async function reset(kind:'system'|'logs'){
    const formal=env.mode==='http',actor=identityStamp(),session=sessionStamp(),baseline=catalog.value?.revision,auditRevision=logs.value?.revision,throughSequence=logs.value?.snapshotSequence;
    const permitted=()=>auth.can('system.reset')&&(kind==='logs'?auth.can('system.logs'):!formal||auth.can('system.parameters'));
    if(!permitted()||busy.value||pendingMutation.value)return;
    if(!(await allowLeave())||actor!==identityStamp()||!permitted())return;
    clearFeedback();
    const message=formal?(kind==='system'?'将状态展示间隔恢复为30秒、请求超时恢复为15秒，保存新版本；账号、角色、业务和历史不变。':'归档当前快照及以前的日志视图。原事件保留，可通过包含归档历史查询。'):(kind==='system'?'恢复初始账号、角色和参数，所有旧会话失效；保留资源、规划、诊断、知识及日志。未保存系统表单将被丢弃。':'清空操作日志和旧待补记录，保留本次重置事件；业务数据和系统配置不变。');
    if(await ask({title:formal?(kind==='system'?'恢复参数默认值':'归档日志视图'):(kind==='system'?'重置系统配置':'重置操作日志'),message,saveLabel:'确认'})!=='save')return;
    if(actor!==identityStamp()||!permitted()||pendingMutation.value)return;
    busy.value=true;error.value='';
    try{
      if(formal){
        if(kind==='system'){
          if(!baseline||!previewService.resetSystemParameters)throw new Error('参数恢复入口未接线或缺少版本');
          await runWrite('parameter.reset',requestId=>previewService.resetSystemParameters!({baseRevision:baseline,requestId,parameterIds:['PAR-01','PAR-02'],reason:'显式恢复参数默认值',confirm:'RESTORE_PARAMETER_DEFAULTS'}));
        }else{
          if(!previewService.archiveSystemLogs||!auditRevision||throughSequence===undefined)throw new Error('日志归档入口未接线或缺少快照');
          await runWrite('logs.archive',requestId=>previewService.archiveSystemLogs!({baseAuditRevision:auditRevision,requestId,throughSequence,reason:'显式归档日志视图',confirm:'ARCHIVE_LOG_VIEW'}));
        }
        if(session===sessionStamp()){closeForms();await load();}
      }else if(kind==='system'){await previewService.resetSystemWorkspace({baseRevision:baseline!,requestId:randomUuid()});if(session===sessionStamp())closeForms();}
      else{await previewService.resetOperationLogs({baseRevision:logs.value?.revision??null});await refresh(appliedQuery.value);}
      notice.value=formal?'操作已提交，历史记录保留':'重置已完成';
    }catch(e){error.value=e instanceof Error?e.message:'重置失败';}finally{busy.value=false;}
  }
  function stopQueries(){requests.stop();generation++;loading.value=false;answer('cancel');}
  async function openPassword(account?:Pick<SystemAccount,'id'>){
    const actor=identityStamp();
    if(env.mode!=='http'||!auth.identity||account&&!auth.can('system.accounts')||!(await allowLeave()))return;
    if(actor!==identityStamp()||!auth.identity||account&&!auth.can('system.accounts'))return;
    if(account)await readForm(signal=>previewService.getSystemAccount({id:account.id,signal}),value=>{passwordTarget.value={mode:'ADMIN',accountId:account.id,baseRevision:value.revision};});
    else{passwordTarget.value={mode:'SELF',accountId:auth.identity.id,baseRevision:''};formOwner.value=actor;}
  }
  async function submitPassword(fields:PasswordFields){
    const target=passwordTarget.value;if(!target||!canSubmitPassword.value)throw new Error('密码操作不可用或当前身份已变化');
    if(target.mode==='ADMIN'&&!auth.can('system.accounts')||target.mode==='SELF'&&target.accountId!==auth.identity?.id)throw new Error('当前身份不可提交该密码操作');
    busy.value=true;
    try{return await runWrite('password',requestId=>{
      if(target.mode==='SELF'){if(!previewService.changeOwnPassword)throw new Error('本人改密入口尚未接线');return previewService.changeOwnPassword({requestId,currentPassword:fields.currentPassword,newPassword:fields.newPassword});}
      if(!previewService.maintainSystemAccountPassword)throw new Error('账号密码维护入口尚未接线');
      return previewService.maintainSystemAccountPassword({requestId,baseRevision:target.baseRevision,accountId:target.accountId,operatorPassword:fields.operatorPassword,newPassword:fields.newPassword});
    });}finally{busy.value=false;secretDirty.value=false;}
  }
  async function passwordSaved(result:SystemResult){closeForms();if(result.reauthenticationRequired)await auth.check();if(auth.can('system.view'))await load();notice.value=result.reauthenticationRequired?'密码已提交，请重新登录':'密码已维护，目标账号下次登录须自行改密';}
  function clearForSession(){stopQueries();closeForms();catalog.value=null;accounts.value=null;roles.value=null;logs.value=null;parameters.value=null;resetQuery();tab.value='accounts';loadError.value='';notice.value='';}
  return {catalog,tab,accounts,roles,logs,parameters,query,appliedQuery,loading,busy,error,loadError,notice,accountForm,roleForm,parameterForm,passwordTarget,secretDirty,pendingMutation,dirty,canSave,canSubmitPassword,decision,page,load,refresh,search,changePage,changeTab,resetQuery,openAccount,openRole,openParameter,openPassword,submitPassword,passwordSaved,reconcilePending,toggle,save,setEnabled,reset,allowLeave,answer,stopQueries,clearForSession};
});
