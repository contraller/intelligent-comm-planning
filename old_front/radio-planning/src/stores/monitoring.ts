import { computed, reactive, ref, watch, onScopeDispose } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { createMonitoringPlayback, initialPlaybackState } from '../services/monitoring-playback';
import type { MonitoringContext, MonitoringFrameResult, SpectrumMonitoringContext, SpectrumFrameResult } from '../types/monitoring';
import { useAuthStore } from './auth';
import { useGisWorkspaceStore } from './gis-workspace';

// 只保存当前标签页的展示状态；两个通道独立，不把频谱异常改写成干扰或故障场景。
export const useMonitoringStore = defineStore('monitoring', () => {
  const auth=useAuthStore(),gis=useGisWorkspaceStore();
  const tab=ref<'devices'|'links'|'spectrum'>('devices'),open=ref(true),visible=ref(false);
  const taskId=ref<string|null>(null),context=ref<MonitoringContext|null>(null),networkResult=ref<MonitoringFrameResult|null>(null);
  const spectrumContext=ref<SpectrumMonitoringContext|null>(null),spectrumResult=ref<SpectrumFrameResult|null>(null),sourceId=ref('');
  const networkLoading=ref(false),spectrumLoading=ref(false),networkError=ref(''),spectrumError=ref('');
  const networkReadAt=ref(''),spectrumReadAt=ref('');
  const selectedDeviceId=ref(''),selectedStationId=ref(''),selectedLinkId=ref('');
  const networkState=reactive(initialPlaybackState()),spectrumState=reactive(initialPlaybackState());
  const networkReadable=computed(()=>auth.can('situation.view')&&auth.can('planning.view')&&!auth.blocked);
  const spectrumReadable=computed(()=>auth.can('situation.view')&&auth.can('resources.view')&&!auth.blocked);
  const network=computed(()=>networkResult.value?.context.network??context.value?.network??null);
  const source=computed(()=>spectrumContext.value?.sources.find(row=>row.id===sourceId.value)??null);
  const spectrumStale=computed(()=>!!spectrumResult.value&&(!source.value?.eligible||source.value.revision!==spectrumResult.value.source.revision||!!spectrumError.value));
  const networkReady=computed(()=>networkReadable.value&&context.value?.source.state==='CURRENT'&&!context.value.errorCode&&context.value.frameCount>0);
  const spectrumReady=computed(()=>spectrumReadable.value&&spectrumContext.value?.source.state==='CURRENT'&&source.value?.eligible===true);
  let networkSerial=0,spectrumSerial=0,networkKey='',spectrumKey='';
  const valid=(serial:number,current:number,session:number)=>serial===current&&session===auth.generation;
  function clearSelection(){selectedDeviceId.value='';selectedStationId.value='';selectedLinkId.value='';}
  function acceptContext(value:MonitoringContext){
    const key=value.network?.key;
    if(key&&key!==networkKey){
      networkKey=key;networkPlayer.reset();networkResult.value=null;networkReadAt.value='';clearSelection();
    }
    context.value=value;networkError.value=value.errorCode?value.message:'';
  }
  const networkPlayer=createMonitoringPlayback<MonitoringFrameResult>(networkState,
    index=>previewService.getMonitoringFrame({taskId:taskId.value,networkKey:context.value!.network!.key,index}),
    value=>{
      networkResult.value=value;context.value=value.context;networkError.value='';networkReadAt.value=new Date().toISOString();
    },
    reason=>{
      networkError.value=reason instanceof Error?reason.message:'读取观测失败';
      const data=reason instanceof ApiError?reason.data as MonitoringContext|undefined:undefined;
      if(context.value)context.value={...context.value,source:{state:data?.source?.state==='HISTORICAL'?'HISTORICAL':'UNKNOWN',reasons:[networkError.value]}};
    });
  const spectrumPlayer=createMonitoringPlayback<SpectrumFrameResult>(spectrumState,
    index=>previewService.getSpectrumObservationFrame({sourceId:sourceId.value,configRevision:source.value!.revision,index}),
    value=>{spectrumResult.value=value;spectrumError.value='';spectrumReadAt.value=new Date().toISOString();},
    reason=>{
      spectrumError.value=reason instanceof Error?reason.message:'频谱观测读取失败';
      if(spectrumContext.value)spectrumContext.value={...spectrumContext.value,source:{state:'UNKNOWN',reasons:[spectrumError.value]}};
    });
  function syncPlayback(){
    networkPlayer.configure(context.value?.frameCount??0,context.value?.intervalSeconds??30);
    spectrumPlayer.configure(source.value?.frameCount??0,source.value?.intervalSeconds??30);
    const show=visible.value&&open.value;
    networkPlayer.setActive(show&&tab.value!=='spectrum'&&gis.mapMode==='monitoring'&&networkReady.value&&!networkLoading.value);
    spectrumPlayer.setActive(show&&tab.value==='spectrum'&&spectrumReady.value&&!spectrumLoading.value);
    if(networkState.active&&networkState.index<0)void networkPlayer.next();
    if(spectrumState.active&&spectrumState.index<0)void spectrumPlayer.next();
  }
  watch(()=>[visible.value,open.value,tab.value,gis.mapMode,networkReady.value,spectrumReady.value,
    context.value?.intervalSeconds,context.value?.frameCount,source.value?.intervalSeconds,source.value?.frameCount,
    networkLoading.value,spectrumLoading.value],syncPlayback,{flush:'sync'});
  watch(()=>source.value?.id+':'+source.value?.revision,()=>{
    const next=source.value?.eligible?source.value.id+':'+source.value.revision:'';
    if(next&&next!==spectrumKey){spectrumKey=next;spectrumPlayer.reset();}
    syncPlayback();
  },{flush:'sync'});
  async function loadNetwork(id:string|null=taskId.value){
    if(!networkReadable.value)return;
    const changed=id!==taskId.value;
    if(changed){networkPlayer.reset();networkResult.value=null;context.value=null;networkKey='';clearSelection();taskId.value=id;}
    const serial=++networkSerial,session=auth.generation;networkLoading.value=true;
    try{
      const value=await previewService.loadMonitoringContext(id);
      if(valid(serial,networkSerial,session))acceptContext(value);
    }catch(reason){
      if(!valid(serial,networkSerial,session))return;
      networkError.value=reason instanceof Error?reason.message:'监控来源读取失败';
      context.value={taskId:id,network:network.value,intervalSeconds:context.value?.intervalSeconds??null,frameCount:0,
        source:{state:'UNKNOWN',reasons:[networkError.value]},message:networkError.value,errorCode:'MONITORING_READ_FAILED'};
    }finally{if(valid(serial,networkSerial,session))networkLoading.value=false;}
  }
  async function loadSpectrum(){
    if(!spectrumReadable.value)return;
    const serial=++spectrumSerial,session=auth.generation;spectrumLoading.value=true;
    try{
      const value=await previewService.loadSpectrumMonitoringContext();
      if(!valid(serial,spectrumSerial,session))return;
      spectrumContext.value=value;spectrumError.value='';
      if(!sourceId.value)sourceId.value=value.sources.find(row=>row.eligible)?.id??value.sources[0]?.id??'';
      const next=source.value?.eligible?source.value.id+':'+source.value.revision:'';
      if(next&&next!==spectrumKey){spectrumKey=next;spectrumPlayer.reset();}
    }catch(reason){
      if(!valid(serial,spectrumSerial,session))return;
      spectrumError.value=reason instanceof Error?reason.message:'采集源读取失败';
      spectrumContext.value={revision:null,sources:spectrumContext.value?.sources??[],source:{state:'UNKNOWN',reasons:[spectrumError.value]}};
    }finally{if(valid(serial,spectrumSerial,session))spectrumLoading.value=false;}
  }
  async function refreshNetwork(){
    if(networkState.busy)return networkPlayer.next();
    const before=networkState.index;
    await loadNetwork();
    // 首帧由可见性监听加载；已有帧才显式推进，避免一次点击跳过首帧。
    if(before>=0&&networkState.index>=0)await networkPlayer.next();
  }
  async function refreshSpectrum(){
    if(spectrumState.busy)return spectrumPlayer.next();
    const before=spectrumState.index;
    await loadSpectrum();
    if(before>=0&&spectrumState.index>=0)await spectrumPlayer.next();
  }
  function selectSource(id:string){
    if(id===sourceId.value)return;
    spectrumPlayer.reset();spectrumResult.value=null;spectrumReadAt.value='';spectrumKey='';spectrumError.value='';sourceId.value=id;
  }
  function showNetwork(){gis.mapMode='monitoring';if(tab.value==='spectrum')tab.value='devices';open.value=true;}
  function selectDevice(id:string){
    const row=network.value?.devices.find(device=>device.id===id);if(!row)return;
    showNetwork();selectedDeviceId.value=id;selectedStationId.value=row.stationId;selectedLinkId.value='';
  }
  function selectStation(id:string){
    if(!network.value?.stations.some(row=>row.id===id))return;
    showNetwork();selectedStationId.value=id;selectedDeviceId.value='';selectedLinkId.value='';
  }
  function selectLink(id:string){
    if(!network.value?.links.some(row=>row.id===id))return;
    gis.mapMode='monitoring';open.value=true;tab.value='links';selectedLinkId.value=id;selectedStationId.value='';selectedDeviceId.value='';
  }
  function stop(){visible.value=false;networkSerial++;spectrumSerial++;networkLoading.value=false;spectrumLoading.value=false;networkPlayer.setActive(false);spectrumPlayer.setActive(false);}
  function clearForSession(){
    stop();networkPlayer.clear();spectrumPlayer.clear();context.value=null;networkResult.value=null;spectrumContext.value=null;spectrumResult.value=null;
    taskId.value=null;sourceId.value='';networkKey='';spectrumKey='';networkError.value='';spectrumError.value='';networkReadAt.value='';spectrumReadAt.value='';clearSelection();
  }
  watch(()=>auth.generation,()=>{
    networkSerial++;spectrumSerial++;networkLoading.value=false;spectrumLoading.value=false;
    networkPlayer.setActive(false);spectrumPlayer.setActive(false);syncPlayback();
  },{flush:'sync'});
  // Pinia 作用域销毁同样释放定时器，避免测试或应用卸载后继续读数据。
  onScopeDispose(()=>{networkPlayer.clear();spectrumPlayer.clear();});
  return {tab,open,visible,taskId,context,networkResult,spectrumContext,spectrumResult,sourceId,source,network,networkState,spectrumState,
    networkLoading,spectrumLoading,networkError,spectrumError,networkReadAt,spectrumReadAt,networkReadable,spectrumReadable,spectrumStale,
    selectedDeviceId,selectedStationId,selectedLinkId,loadNetwork,loadSpectrum,refreshNetwork,refreshSpectrum,selectSource,
    showNetwork,selectDevice,selectStation,selectLink,stop,clearForSession,
    restartNetwork:()=>networkPlayer.restart(),restartSpectrum:()=>spectrumPlayer.restart()};
});
