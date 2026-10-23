import { computed,onScopeDispose,ref,shallowRef,watch } from 'vue';
import { ApiError } from '../services/types';
import { coverageParameters } from '../services/frozen-coverage-decode';
import type { FrozenCoverageCache,FrozenCoverageClient,FrozenCoverageInput,FrozenCoverageJob,FrozenCoverageOverlay,FrozenCoverageQuery } from '../types/frozen-coverage';
type Pending={requestId:string;query:FrozenCoverageQuery;parameters:FrozenCoverageInput;jobId:string|null};
const retained=new Map<string,Pending>();
const knownJobs=new Map<string,string>();
const active=(job:FrozenCoverageJob|null)=>!!job&&['PENDING','RUNNING'].includes(job.state);
export function useFrozenCoverage(options:{query:()=>FrozenCoverageQuery|null;parameters:()=>FrozenCoverageInput;client:()=>FrozenCoverageClient|undefined;owner:()=>string;canWrite:()=>boolean;requestId?:()=>string;storage?:()=>Storage|undefined;pollMs?:number}) {
  const cache=shallowRef<FrozenCoverageCache|null>(null),job=shallowRef<FrozenCoverageJob|null>(null),pending=ref<Pending|null>(null);
  const busy=ref(false),error=ref(''),selectedDeviceId=ref(''),visible=ref(true);
  const knownJobId=ref('');
  let serial=0,control:AbortController|null=null,timer:ReturnType<typeof setTimeout>|undefined,disposed=false;
  const key=()=>JSON.stringify([options.owner(),options.query(),options.parameters()]);
  const storage=()=>{try{return options.storage?.()??(typeof sessionStorage==='undefined'?undefined:sessionStorage);}catch{return undefined;}};
  function remember(value:Pending|null) {
    const name='frozen-coverage.pending:'+key();pending.value=value;
    if(value)retained.set(name,structuredClone(value));else retained.delete(name);
    try{if(value)storage()?.setItem(name,JSON.stringify(value));else storage()?.removeItem(name);}catch{ /* 原号仍保留在本标签内存，不把存储失败当作提交失败。 */ }
  }
  function recall() {
    const name='frozen-coverage.pending:'+key();let value:Pending|undefined=retained.get(name);
    try{if(!value){const raw=storage()?.getItem(name);if(raw)value=JSON.parse(raw) as Pending;}}catch{return null;}
    return value&&typeof value.requestId==='string'&&value.requestId.length>0&&JSON.stringify(value.query)===JSON.stringify(options.query())&&JSON.stringify(value.parameters)===JSON.stringify(options.parameters())?value:null;
  }
  function rememberJob(id:string){const name='frozen-coverage.job:'+key();knownJobId.value=id;knownJobs.set(name,id);try{storage()?.setItem(name,id);}catch{ /* 已确认作业仍可在本标签回读。 */ }}
  function recallJob(){const name='frozen-coverage.job:'+key();let id=knownJobs.get(name);try{id??=storage()?.getItem(name)??undefined;}catch{ /* 不用其他身份或来源的记录回填。 */ }return id&&/^FCJ-[a-f0-9]{32}$/.test(id)?id:'';}
  function cancelRead(){serial++;control?.abort();control=null;clearTimeout(timer);timer=undefined;busy.value=false;}
  const overlay=computed<FrozenCoverageOverlay|null>(()=>visible.value&&cache.value?.state==='HIT'&&cache.value.result&&selectedDeviceId.value?{anchor:cache.value.anchor,result:cache.value.result,deviceId:selectedDeviceId.value}:null);
  const devices=computed(()=>cache.value?.result?.devices??[]);
  async function run(action:(client:FrozenCoverageClient,query:FrozenCoverageQuery,signal:AbortSignal,current:()=>boolean)=>Promise<void>){
    const client=options.client(),query=options.query();if(disposed||busy.value||!client||!query)return;
    const captured={...query},owner=key(),token=++serial;control=new AbortController();busy.value=true;error.value='';
    const current=()=>!disposed&&serial===token&&key()===owner;
    try{await action(client,captured,control.signal,current);}catch(reason){if(current())error.value=reason instanceof Error?reason.message:'冻结覆盖请求失败';}
    finally{if(current()){busy.value=false;control=null;}}
  }
  function acceptCache(value:FrozenCoverageCache){cache.value=value;if(!value.result?.devices.some(row=>row.device_id===selectedDeviceId.value))selectedDeviceId.value=value.result?.devices.find(row=>row.status==='COMPLETE')?.device_id??value.result?.devices[0]?.device_id??'';}
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
    if(busy.value||!options.canWrite()||options.query()?.context!=='planning')return;
    try{coverageParameters(options.parameters());}catch(reason){error.value=reason instanceof Error?reason.message:'覆盖参数无效';return;}
    if(!pending.value){const query=options.query();if(!query||cancel&&!job.value)return;remember({requestId:options.requestId?.()??crypto.randomUUID(),query:{...query},parameters:{...options.parameters()},jobId:cancel?job.value!.job_id:null});}
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
  watch([key,options.client],()=>{cancelRead();cache.value=null;job.value=null;error.value='';selectedDeviceId.value='';pending.value=recall();knownJobId.value=recallJob();},{immediate:true,flush:'sync'});
  onScopeDispose(()=>{disposed=true;cancelRead();});
  return {cache,job,knownJobId,pending,busy,error,devices,selectedDeviceId,visible,overlay,read,refreshJob,compute:()=>write(false),cancel:()=>write(true),retry:()=>write(!!pending.value?.jobId),running:computed(()=>active(job.value)),stop:cancelRead};
}
