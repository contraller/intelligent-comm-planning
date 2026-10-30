import { computed,onScopeDispose,ref,shallowRef,watch } from 'vue';
import { ApiError } from '../services/types';
import { coverageBandwidthChoices,coverageParameters,readFrozenBandwidthSelection } from '../services/frozen-coverage-decode';
import type { FrozenCoverageAnchor,FrozenCoverageBandwidthChoice,FrozenCoverageBandwidthOptions,FrozenCoverageBandwidthSelection,FrozenCoverageCache,FrozenCoverageClient,FrozenCoverageInput,FrozenCoverageJob,FrozenCoverageOverlay,FrozenCoverageQuery,FrozenCoverageDisplay } from '../types/frozen-coverage';
type Pending={requestId:string;query:FrozenCoverageQuery;parameters:FrozenCoverageInput;jobId:string|null};
const retained=new Map<string,Pending>();
const knownJobs=new Map<string,string>();
type SelectionPending={requestId:string;query:FrozenCoverageQuery;choices:FrozenCoverageBandwidthChoice[];anchor:FrozenCoverageAnchor};
// 只暂存本标签未核实写入原号；已保存选择始终从服务端读取，不以此作为当前值。
const selectionRequests=new Map<string,SelectionPending>();
const cloneQuery=(value:FrozenCoverageQuery):FrozenCoverageQuery=>({...value,...value.bandwidthSelection?{bandwidthSelection:{...value.bandwidthSelection}}:{}});
const active=(job:FrozenCoverageJob|null)=>!!job&&['PENDING','RUNNING'].includes(job.state);
export function useFrozenCoverage(options:{query:()=>FrozenCoverageQuery|null;parameters:()=>FrozenCoverageInput;client:()=>FrozenCoverageClient|undefined;owner:()=>string;canWrite:()=>boolean;requestId?:()=>string;storage?:()=>Storage|undefined;pollMs?:number}) {
  const cache=shallowRef<FrozenCoverageCache|null>(null),job=shallowRef<FrozenCoverageJob|null>(null),pending=ref<Pending|null>(null);
  const busy=ref(false),error=ref(''),selectedDeviceId=ref(''),visible=ref(true),invalidationReason=ref('');
  const display=ref<FrozenCoverageDisplay>('strength');
  const knownJobId=ref('');
  const bandwidthOptions=shallowRef<FrozenCoverageBandwidthOptions|null>(null),bandwidthReceipt=shallowRef<FrozenCoverageBandwidthSelection|null>(null);
  const bandwidthPending=shallowRef<SelectionPending|null>(null),bandwidthLoading=ref(false),bandwidthSaving=ref(false),bandwidthError=ref('');
  const bandwidthReady=ref(false);
  let bandwidthSerial=0,bandwidthAbort:AbortController|null=null;
  let serial=0,control:AbortController|null=null,timer:ReturnType<typeof setTimeout>|undefined,disposed=false;
  const baseKey=()=>JSON.stringify([options.owner(),options.query()]);
  const query=():FrozenCoverageQuery|null=>{
    const base=options.query(),selection=bandwidthReady.value?bandwidthOptions.value?.current_selection:null;
    return base?{...base,...selection?{bandwidthSelection:{selectionId:selection.selection_id,selectionHash:selection.selection_hash}}:{}}:null;
  };
  const key=()=>JSON.stringify([options.owner(),query(),options.parameters()]);
  const storage=()=>{try{return options.storage?.()??(typeof sessionStorage==='undefined'?undefined:sessionStorage);}catch{return undefined;}};
  function remember(value:Pending|null) {
    const name='frozen-coverage.pending:'+key();pending.value=value;
    if(value)retained.set(name,structuredClone(value));else retained.delete(name);
    try{if(value)storage()?.setItem(name,JSON.stringify(value));else storage()?.removeItem(name);}catch{ /* 原号仍保留在本标签内存，不把存储失败当作提交失败。 */ }
  }
  function recall() {
    const name='frozen-coverage.pending:'+key();let value:Pending|undefined=retained.get(name);
    try{if(!value){const raw=storage()?.getItem(name);if(raw)value=JSON.parse(raw) as Pending;}}catch{return null;}
    return value&&typeof value.requestId==='string'&&value.requestId.length>0&&JSON.stringify(value.query)===JSON.stringify(query())&&JSON.stringify(value.parameters)===JSON.stringify(options.parameters())?value:null;
  }
  function rememberJob(id:string){const name='frozen-coverage.job:'+key();knownJobId.value=id;knownJobs.set(name,id);try{storage()?.setItem(name,id);}catch{ /* 已确认作业仍可在本标签回读。 */ }}
  function recallJob(){const name='frozen-coverage.job:'+key();let id=knownJobs.get(name);try{id??=storage()?.getItem(name)??undefined;}catch{ /* 不用其他身份或来源的记录回填。 */ }return id&&/^FCJ-[a-f0-9]{32}$/.test(id)?id:'';}
  function cancelRead(){serial++;control?.abort();control=null;clearTimeout(timer);timer=undefined;busy.value=false;}
  const overlay=computed<FrozenCoverageOverlay|null>(()=>visible.value&&cache.value?.state==='HIT'&&cache.value.result&&selectedDeviceId.value?{anchor:cache.value.anchor,result:cache.value.result,deviceId:selectedDeviceId.value,...['V01-5','V01-6'].includes(cache.value.anchor.engine_version)?{display:display.value}:{},...cache.value.bandwidth_selection_id&&cache.value.bandwidth_selection_hash?{bandwidthSelection:{selectionId:cache.value.bandwidth_selection_id,selectionHash:cache.value.bandwidth_selection_hash}}:{}}:null);
  const devices=computed(()=>cache.value?.result?.devices??[]);
  async function run(action:(client:FrozenCoverageClient,query:FrozenCoverageQuery,signal:AbortSignal,current:()=>boolean)=>Promise<void>){
    const client=options.client(),source=query();if(disposed||busy.value||!client||!source)return;
    const captured=structuredClone(source),owner=key(),token=++serial;control=new AbortController();busy.value=true;error.value='';
    const current=()=>!disposed&&serial===token&&key()===owner;
    try{await action(client,captured,control.signal,current);}catch(reason){if(current())error.value=reason instanceof Error?reason.message:'冻结覆盖请求失败';}
    finally{if(current()){busy.value=false;control=null;}}
  }
  function acceptCache(value:FrozenCoverageCache){cache.value=value;invalidationReason.value='';if(!value.result?.devices.some(row=>row.device_id===selectedDeviceId.value))selectedDeviceId.value=value.result?.devices.find(row=>row.status==='COMPLETE')?.device_id??value.result?.devices[0]?.device_id??'';}
  async function read(){await run(async(client,query,signal,current)=>{const value=await client.getCache(query,{...options.parameters()},signal);if(current())acceptCache(value);});}
  function schedule(){clearTimeout(timer);if(!disposed&&active(job.value))timer=setTimeout(()=>void refreshJob(),options.pollMs??2000);}
  async function refreshJob(){
    const jid=job.value?.job_id??knownJobId.value;if(!jid)return;
    await run(async(client,query,signal,current)=>{
      const value=await client.getJob(query,jid,signal);if(!current())return;job.value=value;
      if(value.state==='SUCCESS'){const cached=await client.getCache(query,{...options.parameters()},signal);if(current())acceptCache(cached);}
      if(current()&&value.error)error.value=value.error.message;
    });schedule();
  }
  async function write(cancel=false){
    if(busy.value||bandwidthSaving.value||bandwidthLoading.value||bandwidthPending.value||!options.canWrite()||query()?.context!=='planning'||!cancel&&!bandwidthReady.value)return;
    if(!cancel&&query()?.engineVersion&&query()!.engineVersion!=='V01-6')return;
    try{coverageParameters(options.parameters());}catch(reason){error.value=reason instanceof Error?reason.message:'覆盖参数无效';return;}
    if(!pending.value){const source=query();if(!source||cancel&&!job.value)return;remember({requestId:options.requestId?.()??crypto.randomUUID(),query:structuredClone(source),parameters:{...options.parameters()},jobId:cancel?job.value!.job_id:null});}
    const request=pending.value!;
    await run(async(client,_query,signal,current)=>{
      try{
        const value=request.jobId?await client.cancel(request.query,request.jobId,request.requestId,signal):await client.compute(request.query,request.parameters,request.requestId,signal);
        if(!current())return;remember(null);rememberJob(value.job_id);job.value=value;
        if(value.state==='SUCCESS'){const cached=await client.getCache(request.query,request.parameters,signal);if(current())acceptCache(cached);}
      }catch(reason){
        if(current()&&reason instanceof ApiError&&reason.status&&reason.status>=400&&reason.status<500)remember(null);
        throw reason;
      }
    });schedule();
  }
  async function loadBandwidthOptions(){
    const client=options.client(),source=options.query();
    if(disposed||!client||!source||bandwidthSaving.value||bandwidthPending.value)return false;
    bandwidthAbort?.abort();const controller=new AbortController(),token=++bandwidthSerial,owner=baseKey();bandwidthAbort=controller;
    bandwidthLoading.value=true;bandwidthError.value='';
    try{
      const value=await client.getBandwidthOptions(cloneQuery(source),controller.signal);
      if(disposed||controller.signal.aborted||token!==bandwidthSerial||owner!==baseKey())return false;
      const receipt=bandwidthReceipt.value;
      const current=value.current_selection;
      if(receipt&&(!current||current.version_no<receipt.version_no||current.version_no===receipt.version_no&&(current.selection_id!==receipt.selection_id||current.selection_hash!==receipt.selection_hash)))
        throw new Error('当前选择回读尚未包含一致的已保存版本，请重试读取');
      bandwidthOptions.value=value;bandwidthReady.value=true;return true;
    }catch(reason){if(token===bandwidthSerial&&owner===baseKey()&&!controller.signal.aborted)bandwidthError.value=reason instanceof Error?reason.message:'带宽选择回读失败';return false;}
    finally{if(token===bandwidthSerial){bandwidthLoading.value=false;bandwidthAbort=null;}}
  }
  async function saveBandwidthSelection(choices?:FrozenCoverageBandwidthChoice[]){
    const client=options.client(),source=options.query(),catalog=bandwidthOptions.value;
    if(disposed||!client||!source||source.context!=='planning'||!options.canWrite()||bandwidthSaving.value||bandwidthLoading.value||busy.value||active(job.value)||pending.value)return;
    if(source.engineVersion&&source.engineVersion!=='V01-6')return;
    const owner=baseKey();
    if(!bandwidthPending.value){
      if(!catalog||!bandwidthReady.value||!choices)return;
      try{
        const values=coverageBandwidthChoices(choices),byId=new Map(catalog.devices.map(row=>[row.device_id,row]));
        if(values.some(row=>!byId.get(row.device_id)?.options_khz?.includes(row.rx_bandwidth_khz)))throw new Error('选值不属于冻结型号合法选项');
        const request={requestId:options.requestId?.()??crypto.randomUUID(),query:cloneQuery(source),choices:values,anchor:structuredClone(catalog.anchor)};
        selectionRequests.set(owner,request);bandwidthPending.value=request;
      }catch(reason){bandwidthError.value=reason instanceof Error?reason.message:'带宽选择无效';return;}
    }else if(choices)return;
    const request=bandwidthPending.value!,token=++bandwidthSerial,controller=new AbortController();
    bandwidthAbort?.abort();bandwidthAbort=controller;bandwidthSaving.value=true;bandwidthError.value='';
    const current=()=>!disposed&&token===bandwidthSerial&&owner===baseKey()&&!controller.signal.aborted;
    let saved=false;
    try{
      const value=await client.saveBandwidthSelection(request.query,structuredClone(request.choices),request.requestId,controller.signal);
      if(!current())return;
      readFrozenBandwidthSelection(value,request.query,request.anchor,request.choices);
      bandwidthReceipt.value=value;selectionRequests.delete(owner);bandwidthPending.value=null;
      // 回执可能是旧号重放，不能把它冒充最新选择；先清旧覆盖，再GET当前版本。
      bandwidthReady.value=false;saved=true;
    }catch(reason){
      if(current()){
        if(reason instanceof ApiError&&reason.status&&reason.status>=400&&reason.status<500){selectionRequests.delete(owner);bandwidthPending.value=null;}
        bandwidthError.value=reason instanceof Error?reason.message:'带宽选择提交未核实';
      }
    }finally{if(current()){bandwidthSaving.value=false;bandwidthAbort=null;}}
    if(saved&&current())await loadBandwidthOptions();
  }
  watch([baseKey,options.client],()=>{
    bandwidthSerial++;bandwidthAbort?.abort();bandwidthAbort=null;bandwidthLoading.value=false;bandwidthSaving.value=false;
    bandwidthOptions.value=null;bandwidthReceipt.value=null;bandwidthReady.value=false;bandwidthError.value='';bandwidthPending.value=selectionRequests.get(baseKey())??null;
  },{immediate:true,flush:'sync'});
  watch([key,options.client],()=>{if(cache.value?.state==='HIT'&&cache.value.result)invalidationReason.value='方案、带宽选择或覆盖参数已变化，原覆盖不再代表当前配置；请读取匹配缓存或重新计算。';cancelRead();cache.value=null;job.value=null;error.value='';selectedDeviceId.value='';pending.value=recall();knownJobId.value=recallJob();},{immediate:true,flush:'sync'});
  onScopeDispose(()=>{disposed=true;cancelRead();bandwidthSerial++;bandwidthAbort?.abort();});
  return {cache,job,knownJobId,pending,busy,error,invalidationReason,devices,selectedDeviceId,visible,overlay,read,refreshJob,compute:()=>write(false),cancel:()=>write(true),retry:()=>write(!!pending.value?.jobId),running:computed(()=>active(job.value)),stop:cancelRead,
    display,bandwidthOptions,bandwidthReceipt,bandwidthPending,bandwidthLoading,bandwidthSaving,bandwidthError,bandwidthReady,loadBandwidthOptions,saveBandwidthSelection,retryBandwidthSelection:()=>saveBandwidthSelection()};
}
