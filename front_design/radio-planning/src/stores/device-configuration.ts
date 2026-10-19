import { computed, ref, toRaw, watch } from 'vue';
import { defineStore } from 'pinia';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import type { ConfigurationContext, ConfigurationHistory, ConfigurationOperationResult, ConfigurationScenario, ConfigurationSubmit, ConfigurationValidation, DeviceConfigurationContext } from '../types/device-configuration';
import { DEVICE_CONFIGURATION_PAGE_SIZE, DEVICE_CONFIGURATION_POLL_MS, DEVICE_CONFIGURATION_PRESET_VERSION } from '../config/demo';
import { previewService } from '../services';
import { browserResourceStorage } from '../services/resource-storage';
import { readConfigurationPending, saveConfigurationPending } from '../services/device-configuration-storage';
import { configurationSignature } from '../services/device-configuration-validation';
import { useAuthStore } from './auth';

// 草稿只在内存；受理回执及待核实请求独立保留，不加入资源联合保存。
export const useDeviceConfigurationStore=defineStore('device-configuration',()=>{
  const auth=useAuthStore(),visible=ref(false),context=ref<ConfigurationContext>('ledger'),deviceId=ref('');
  const data=ref<DeviceConfigurationContext|null>(null),power=ref(''),frequency=ref(''),scenario=ref<ConfigurationScenario>('success');
  const initial=ref(''),validation=ref<ConfigurationValidation|null>(null),validated=ref(''),result=ref<ConfigurationOperationResult|null>(null);
  // 旧回执可继续查看，但不能代表修改后输入的校验、发送和回执进度。
  const progressFromRecord=ref(false);
  const pending=ref<ConfigurationSubmit|null>(null),notFound=ref(false),retryOf=ref<string|undefined>(),history=ref<ConfigurationHistory|null>(null),tab=ref<'configure'|'history'>('configure');
  const busy=ref(false),error=ref(''),notice=ref(''),decision=ref<DecisionRequest|null>(null),writeRequested=ref(false),eligible=ref(false),disabledReason=ref('');
  let generation=0,timer:ReturnType<typeof setTimeout>|undefined,resolver:((value:Decision)=>void)|null=null;
  const readable=computed(()=>!auth.blocked&&auth.can(context.value==='gis'?'situation.view':'resources.view'));
  const editable=computed(()=>readable.value&&auth.can('resources.edit')&&writeRequested.value&&eligible.value&&!!data.value&&data.value.device.availability!=='OFF_SHELF');
  const inputSignature=()=>JSON.stringify([power.value,frequency.value,scenario.value]);
  const dirty=computed(()=>!!data.value&&inputSignature()!==initial.value);
  const locked=computed(()=>!editable.value||busy.value||!!pending.value||result.value?.status==='RUNNING');
  function report(reason:unknown){error.value=reason instanceof Error?reason.message:'配置操作失败';}
  function stop(){generation++;if(timer)clearTimeout(timer);timer=undefined;busy.value=false;validated.value='';validation.value=null;answer('cancel');}
  function answer(value:Decision){const fn=resolver;resolver=null;decision.value=null;fn?.(value);}
  function ask(request:DecisionRequest){if(decision.value||busy.value)return Promise.resolve('cancel' as Decision);decision.value=request;return new Promise<Decision>(r=>{resolver=r;});}
  function setEligibility(page:ConfigurationContext,allowed:boolean,reason=''){
    if(context.value!==page)return;eligible.value=allowed;disabledReason.value=reason;
    // 被动切入快照仅冻结，不丢弃独立设备输入；旧校验不能继续使用。
    if(!allowed){validated.value='';validation.value=null;}
  }
  watch([power,frequency,scenario],()=>{validated.value='';validation.value=null;retryOf.value=undefined;progressFromRecord.value=false;},{flush:'sync'});
  async function leave(defer=false){
    if(!visible.value)return true;
    if(busy.value)return false;
    if(pending.value){error.value='本次请求尚待核实，请先核实结果，再关闭或进行其他操作';return false;}
    if(dirty.value&&await ask({title:'配置输入尚未提交',message:'放弃只清除此表单输入，已受理操作和回执仍保留。',discardLabel:'放弃输入'})!=='discard')return false;
    if(!defer)clearForSession();return true;
  }
  function clearForSession(){stop();visible.value=false;data.value=null;pending.value=null;result.value=null;history.value=null;initial.value='';power.value='';frequency.value='';validation.value=null;validated.value='';error.value='';notice.value='';notFound.value=false;retryOf.value=undefined;}
  function request():ConfigurationSubmit {
    if(!data.value||!String(power.value).trim()||!String(frequency.value).trim())throw new Error('请明确填写发射功率和工作频率');
    const d=data.value;
    const value:ConfigurationSubmit={context:context.value,deviceId:d.deviceId,modelId:d.modelId,resourceEpoch:d.resourceEpoch,deviceVersion:d.deviceVersion,presetVersion:d.presets[0]?.version??DEVICE_CONFIGURATION_PRESET_VERSION,
      values:{txPowerDbm:Number(power.value),workFreqKhz:Number(frequency.value)},scenario:scenario.value,requestId:'validation',...(retryOf.value?{retryOf:retryOf.value}:{})};
    configurationSignature(value);return value;
  }
  function live(token:number,session:number){return token===generation&&session===auth.generation&&visible.value&&readable.value;}
  async function open(page:ConfigurationContext,id:string,write=false){
    if(!auth.can(page==='gis'?'situation.view':'resources.view')||auth.blocked||!await leave())return false;
    context.value=page;deviceId.value=id;writeRequested.value=write;visible.value=true;tab.value=id?'configure':'history';
    const token=generation,session=auth.generation;busy.value=true;error.value='';
    try{
      pending.value=readConfigurationPending(browserResourceStorage(),auth.identity!.id);
      if(pending.value){deviceId.value=pending.value.deviceId;tab.value='configure';notice.value='发现本账号待核实请求，请先核实，禁止自动重新提交。';}
      if(deviceId.value){const value=await previewService.loadDeviceConfigurationContext({context:page,deviceId:deviceId.value});if(!live(token,session))return false;data.value=value;power.value=value.device.txPowerDbm==null?'':String(value.device.txPowerDbm);frequency.value=value.device.workFreqKhz==null?'':String(value.device.workFreqKhz);initial.value=inputSignature();}
      if(!live(token,session))return false;
      const records=await previewService.queryDeviceConfigurationOperations({context:page,deviceId:deviceId.value||undefined,page:1,pageSize:DEVICE_CONFIGURATION_PAGE_SIZE});
      if(!live(token,session))return false;history.value=records;return true;
    }catch(e){if(live(token,session))report(e);return false;}finally{if(token===generation)busy.value=false;}
  }
  async function refreshContext(){
    if(!readable.value||busy.value||pending.value||!deviceId.value)return;
    const token=generation,session=auth.generation;busy.value=true;
    try{const value=await previewService.loadDeviceConfigurationContext({context:context.value,deviceId:deviceId.value});if(live(token,session)){data.value=value;validation.value=null;validated.value='';notice.value='已重新读取来源，输入保留，请重新校验';error.value='';}}
    catch(e){if(live(token,session))report(e);}finally{if(token===generation)busy.value=false;}
  }
  async function usePreset(id:string){
    if(locked.value)return;const preset=data.value?.presets.find(p=>p.id===id);if(!preset)return;
    const token=generation,session=auth.generation;
    if(dirty.value&&await ask({title:'替换本次配置输入',message:'使用教学预设替换当前输入，不保存台账或自动提交。',saveLabel:'替换输入'})!=='save')return;
    if(!live(token,session)||locked.value)return;
    power.value=String(preset.values.txPowerDbm);frequency.value=String(preset.values.workFreqKhz);notice.value=preset.name+'已填入，尚未提交';
  }
  async function validate(){
    if(locked.value)return false;const token=generation,session=auth.generation;error.value='';validated.value='';validation.value=null;progressFromRecord.value=false;
    try{const value=request(),signature=configurationSignature(value);busy.value=true;const checked=await previewService.validateDeviceConfiguration(value);
      if(!live(token,session)||!editable.value||signature!==configurationSignature(request()))return false;
      validation.value=checked;validated.value=checked.valid?signature:'';return checked.valid;
    }catch(e){if(live(token,session))report(e);return false;}finally{if(token===generation)busy.value=false;}
  }
  function schedule(){if(timer)clearTimeout(timer);if(visible.value&&readable.value&&result.value?.status==='RUNNING')timer=setTimeout(()=>{void poll();},DEVICE_CONFIGURATION_POLL_MS);}
  async function poll(){
    if(!result.value?.operation||!readable.value)return;
    // 同一抽屉正在读历史时延后轮询，不能永久丢掉运行中操作的刷新。
    if(busy.value){schedule();return;}
    const token=generation,session=auth.generation,id=result.value.operation.request.requestId;
    try{const value=await previewService.getDeviceConfigurationOperation({context:context.value,requestId:id});if(live(token,session)&&result.value?.operation?.request.requestId===id){result.value=value;schedule();}}
    catch(e){if(live(token,session))report(e);}
  }
  async function send(value:ConfigurationSubmit){
    const token=generation,session=auth.generation,owner=auth.identity!.id;error.value='';busy.value=true;
    try{
      // 先持久化请求身份；受理结果不明时不可丢弃或换新请求编号。
      saveConfigurationPending(browserResourceStorage(),owner,value);pending.value=value;notFound.value=false;
      const response=await previewService.submitDeviceConfiguration(structuredClone(toRaw(value)));
      if(!live(token,session))return;
      result.value=response;progressFromRecord.value=true;saveConfigurationPending(browserResourceStorage(),owner,null);pending.value=null;initial.value=inputSignature();notice.value='请求已受理；执行结果以回执为准，台账未保存';schedule();
    }catch(e){if(live(token,session))report(e);}finally{if(token===generation)busy.value=false;}
  }
  async function submit(){
    if(locked.value)return;
    try{const value=request();if(configurationSignature(value)!==validated.value){error.value='请先校验本次配置';return;}value.requestId=crypto.randomUUID();await send(value);}catch(e){report(e);}
  }
  async function verify(){
    if(!pending.value||busy.value||!readable.value)return;const token=generation,session=auth.generation,value=structuredClone(toRaw(pending.value)),owner=auth.identity!.id;busy.value=true;error.value='';
    try{const response=await previewService.getDeviceConfigurationOperation({context:context.value,requestId:value.requestId,deviceId:value.deviceId});
      if(!live(token,session))return;result.value=response;notFound.value=response.status==='NOT_FOUND';progressFromRecord.value=!notFound.value;
      if(notFound.value){notice.value='服务明确未找到请求，可用原编号重发，或放弃此未受理请求';return;}
      saveConfigurationPending(browserResourceStorage(),owner,null);pending.value=null;initial.value=inputSignature();notice.value='已核实原请求，台账未改变';schedule();
    }catch(e){if(live(token,session))report(e);}finally{if(token===generation)busy.value=false;}
  }
  async function resend(){if(!pending.value||!notFound.value||!editable.value||busy.value)return;await send(structuredClone(toRaw(pending.value)));}
  function discardNotFound(){if(!notFound.value||busy.value||!pending.value||!readable.value)return;try{saveConfigurationPending(browserResourceStorage(),auth.identity!.id,null);pending.value=null;notFound.value=false;notice.value='已放弃经核实未受理的请求';}catch(e){report(e);}}
  async function queryHistory(page=1){
    if(!readable.value||busy.value)return;const token=generation,session=auth.generation;busy.value=true;
    try{const value=await previewService.queryDeviceConfigurationOperations({context:context.value,deviceId:deviceId.value||undefined,page,pageSize:DEVICE_CONFIGURATION_PAGE_SIZE});if(live(token,session)){history.value=value;tab.value='history';error.value='';}}
    catch(e){if(live(token,session))report(e);}finally{if(token===generation)busy.value=false;}
  }
  async function selectRecord(item:ConfigurationOperationResult){
    if(busy.value||pending.value||!readable.value)return;const token=generation,session=auth.generation;
    if(dirty.value&&await ask({title:'查看配置记录',message:'放弃未提交输入后查看冻结请求。',discardLabel:'放弃并查看'})!=='discard')return;
    if(!live(token,session))return;
    // 确认放弃后恢复未修改基线，历史回执仍单独只读显示。
    if(dirty.value&&initial.value){const [p,f,s]=JSON.parse(initial.value);power.value=p;frequency.value=f;scenario.value=s;}
    result.value=structuredClone(toRaw(item));progressFromRecord.value=true;tab.value='configure';validated.value='';validation.value=null;schedule();
  }
  async function prepareRetry(){
    const operation=result.value?.operation;if(!operation||result.value?.status!=='FAILED'||result.value.sourceChanged||locked.value||operation.request.deviceId!==data.value?.deviceId)return;
    const token=generation,session=auth.generation;
    // 重试会恢复失败请求的参数，覆盖新输入前也必须得到明确决定。
    if(dirty.value&&await ask({title:'准备失败重试',message:'用原失败请求的参数替换当前输入，仍须重新校验后提交。',saveLabel:'替换并准备重试'})!=='save')return;
    if(!live(token,session)||locked.value||result.value?.operation?.id!==operation.id||result.value.sourceChanged)return;
    await refreshContext();if(!live(token,session)||locked.value||!data.value||result.value?.operation?.id!==operation.id||result.value.sourceChanged)return;
    if(operation.request.resourceEpoch!==data.value.resourceEpoch||operation.request.deviceVersion!==data.value.deviceVersion){error.value='来源已变化，不能重试旧请求';return;}
    power.value=String(operation.request.values.txPowerDbm);frequency.value=String(operation.request.values.workFreqKhz);scenario.value='success';retryOf.value=operation.id;validated.value='';validation.value=null;progressFromRecord.value=false;notice.value='已准备原参数的成功教学场景，请重新校验后重试';
  }
  return {visible,context,deviceId,data,power,frequency,scenario,dirty,validation,validated,result,progressFromRecord,pending,notFound,retryOf,history,tab,busy,error,notice,decision,readable,editable,locked,disabledReason,open,leave,clearForSession,stop,answer,setEligibility,refreshContext,usePreset,validate,submit,verify,resend,discardNotFound,queryHistory,selectRecord,prepareRetry};
});
