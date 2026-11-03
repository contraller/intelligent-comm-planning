import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { previewService } from '../services';
import { collaborationHttp } from '../services/http';
import { env } from '../config/env';
import type { ApiPlan, PlanningPlanSummary } from '../types/planning-api';
import type { GisNetwork } from '../types/gis-plan';
import type { FrozenCoverageCache, FrozenCoverageOverlay, FrozenCoverageDisplay } from '../types/frozen-coverage';
import { loadTerrainBasemap, type TerrainBasemap } from '../services/terrain-basemap';
import { MAP_DISPLAY_BOUNDS, planningBounds } from '../maps/planning-bounds-layer';
import { coverageFrequency } from '../maps/frozen-coverage-layers';

export interface SituationFrame {plan:ApiPlan;network:GisNetwork;terrain:TerrainBasemap|null;coverage:FrozenCoverageCache|null;notices:string[];readAt:string}
// Mock 只投影实际保存的示例方案；HTTP 失败绝不进入此分支。
function mockNetwork(plan:ApiPlan):GisNetwork {
  return {identity:{plan_id:plan.id,task_id:plan.taskId,snapshot_id:plan.result.snapshotId,input_version:plan.inputVersion??plan.revision,condition_version:plan.conditionVersion,resource_revision:plan.resourceRevision??'mock-unprovided',state:plan.state,source_changed:plan.sourceChanged,data_origin:'SYNTHETIC_INTEGRATION',source:'SR4'},
    nodes:plan.result.nodes.map(n=>({...n,status:['NORMAL','FAULT','OFFLINE'].includes(n.status??'')?n.status as 'NORMAL'|'FAULT'|'OFFLINE':null})),
    devices:plan.result.devices.map(d=>({id:d.id,station_id:d.stationId,model_id:d.modelId,device_class:d.deviceClass,frequency_khz:d.workFreqKhz,tx_power_dbm:d.txPowerDbm,antenna_height_m:d.antennaHeightM})),
    links:plan.result.links.map(l=>({id:l.id,a:l.a,b:l.b,device_a:l.deviceA,device_b:l.deviceB,device_class:l.deviceClass,frequency_khz:l.frequencyKhz,backup:l.backup,planned_state:l.state})),demands:[],routes:[],paths_state:'missing',paths_message:'本地示例未提供冻结路径明细'};
}
export function useGisSituation(access:()=>boolean,owner:()=>number){
  const frame=shallowRef<SituationFrame|null>(null),rows=ref<PlanningPlanSummary[]>([]),loading=ref(false),error=ref(''),notice=ref(''),newest=ref<PlanningPlanSummary|null>(null);
  const autoRefresh=ref(true),page=ref(1),total=ref(0),deviceId=ref(''),coverageVisible=ref(false),display=ref<FrozenCoverageDisplay>('field');
  const frequencyKhz=ref<number>(),terrainReference=ref(false);
  const selectedFrequency=computed(()=>coverageFrequency(frame.value?.coverage?.result?.devices.find(d=>d.device_id===deviceId.value),frequencyKhz.value));
  watch(deviceId,()=>{frequencyKhz.value=undefined;},{flush:'sync'});
  let serial=0,listSerial=0,latestSerial=0,findingLatest=false,controller:AbortController|undefined;
  const context=()=>env.mode==='http'?'gis' as const:'planning' as const;
  const coverageOverlay=computed<FrozenCoverageOverlay|null>(()=>{
    const cache=frame.value?.coverage;
    if(!coverageVisible.value||!deviceId.value||cache?.state!=='HIT'||!cache.result||cache.result.devices.find(d=>d.device_id===deviceId.value)?.status!=='COMPLETE')return null;
    return {anchor:cache.anchor,result:cache.result,deviceId:deviceId.value,display:display.value,frequencyKhz:selectedFrequency.value,terrainReference:terrainReference.value,...cache.bandwidth_selection_id&&cache.bandwidth_selection_hash?{bandwidthSelection:{selectionId:cache.bandwidth_selection_id,selectionHash:cache.bandwidth_selection_hash}}:{}};
  });
  const dimensions=computed(()=>planningBounds(MAP_DISPLAY_BOUNDS));
  async function catalog(nextPage=page.value,signal?:AbortSignal){
    const epoch=owner(),token=++listSerial;const result=await previewService.querySavedPlanningPlans({context:context(),pageNum:nextPage,pageSize:10,signal});
    if(signal?.aborted||epoch!==owner()||token!==listSerial||!access())return [];
    rows.value=result.items;page.value=nextPage;total.value=result.total;
    return result.items;
  }
  async function fetchFrame(row:PlanningPlanSummary,signal:AbortSignal):Promise<SituationFrame>{
    const plan=await previewService.getPlanningPlan({context:context(),planId:row.id,taskId:row.taskId,signal});
    if(plan.id!==row.id||plan.taskId!==row.taskId)throw new Error('方案目录与详情身份不一致');
    const query={planId:plan.id,taskId:plan.taskId,snapshotId:plan.result.snapshotId};
    const network=env.mode==='http'?await collaborationHttp.gisPlans.getNetwork(query,signal):mockNetwork(plan);
    if(network.identity.snapshot_id!==plan.result.snapshotId||network.identity.plan_id!==plan.id||network.identity.task_id!==plan.taskId)throw new Error('冻结网络身份不一致');
    const notices:string[]=[];let terrain:TerrainBasemap|null=null,coverage:FrozenCoverageCache|null=null;
    if(env.mode==='http'){
      const results=await Promise.allSettled([
        collaborationHttp.gisPlans.getSurface(query,network,signal).then(async surface=>{
          if(!surface.terrain){notices.push(surface.terrain_notice||'冻结地形未提供');return null;}
          return loadTerrainBasemap(surface.terrain,globalThis.fetch,import.meta.env.BASE_URL,signal);
        }),
        collaborationHttp.frozenCoverage.getLatestCache!({...query,resourceRevision:network.identity.resource_revision,context:'gis',engineVersion:'V01-6'},signal),
      ]);
      if(results[0].status==='fulfilled')terrain=results[0].value;else notices.push('地形底图读取失败：'+String(results[0].reason instanceof Error?results[0].reason.message:results[0].reason));
      if(results[1].status==='fulfilled'){coverage=results[1].value;if(coverage.state!=='HIT')notices.push(coverage.reason||'尚无已计算覆盖');}else notices.push('覆盖缓存读取失败，未显示覆盖');
    }else notices.push('Mock 本地示例：未提供经后端核验的 DEM 和 V6 覆盖缓存');
    if(signal.aborted){terrain?.dispose();throw new Error('读取已取消');}
    return {plan,network,terrain,coverage,notices,readAt:new Date().toISOString()};
  }
  async function select(row:PlanningPlanSummary){
    controller?.abort();const request=new AbortController();controller=request;const token=++serial,epoch=owner();loading.value=true;error.value='';
    try{const next=await fetchFrame(row,request.signal);if(token!==serial||epoch!==owner()||!access()){next.terrain?.dispose();return;}
      const previous=frame.value;frame.value=next;previous?.terrain?.dispose();
      // 同一快照刷新保留查看偏好；换来源不把旧覆盖套入新网络。
      if(previous?.plan.id!==next.plan.id||previous.network.identity.snapshot_id!==next.network.identity.snapshot_id){deviceId.value='';coverageVisible.value=false;frequencyKhz.value=undefined;terrainReference.value=false;notice.value='';}
      if(deviceId.value&&!next.network.devices.some(d=>d.id===deviceId.value)){deviceId.value='';coverageVisible.value=false;}
      // 列表变化时保留有效频点，回退后固定实际显示值。
      if(selectedFrequency.value!==undefined)frequencyKhz.value=selectedFrequency.value;
      newest.value=newest.value?.id===next.plan.id?null:newest.value;return true;
    }catch(reason){if(!request.signal.aborted&&token===serial)error.value=(reason instanceof Error?reason.message:'读取失败')+(frame.value?'；已保留上次成功画面':'');}
    finally{if(token===serial)loading.value=false;}
  }
  async function latest(){
    if(!access()||loading.value||findingLatest)return;error.value='';notice.value='';const epoch=owner(),latestToken=++latestSerial;findingLatest=true;
    let skipped=0;
    try{for(let nextPage=1;;nextPage++){
      const before=serial,candidates=await catalog(nextPage);if(epoch!==owner()||before!==serial||latestToken!==latestSerial||!access())return;
      if(!candidates.length){if(!skipped)notice.value='尚无已保存的规划方案。请先在网络规划中计算并保存方案。';return;}
      for(const candidate of candidates){const expected=serial+1;const accepted=await select(candidate);if(serial!==expected||epoch!==owner()||!access())return;
        if(accepted){if(skipped)notice.value=`较新的 ${skipped} 份方案无法读取，当前展示最近可读取版本，请核对原方案。`;return;}skipped++;}
      if(nextPage*10>=total.value)return;
    }}catch(e){if(epoch===owner()&&latestToken===latestSerial)error.value=e instanceof Error?e.message:'方案目录读取失败';}finally{if(latestToken===latestSerial)findingLatest=false;}
  }
  async function refresh(){
    if(!access()||loading.value||findingLatest)return;
    if(!frame.value){await latest();return;}
    const current=frame.value.plan,epoch=owner(),before=serial;
    try{const result=await previewService.querySavedPlanningPlans({context:context(),pageNum:1,pageSize:5});if(epoch!==owner()||before!==serial||frame.value?.plan.id!==current.id||!access())return;newest.value=result.items[0]?.id!==current.id?result.items[0]??null:null;
      await select({id:current.id,taskId:current.taskId,name:current.name,version:current.version,state:current.state,current:current.current,sourceChanged:current.sourceChanged,savedAt:current.savedAt});
    }catch(e){if(epoch===owner())error.value=(e instanceof Error?e.message:'刷新失败')+'；已保留上次成功画面';}
  }
  function reset(){controller?.abort();serial++;listSerial++;latestSerial++;findingLatest=false;frame.value?.terrain?.dispose();frame.value=null;rows.value=[];newest.value=null;deviceId.value='';frequencyKhz.value=undefined;terrainReference.value=false;coverageVisible.value=false;loading.value=false;error.value='';notice.value='';}
  const timer=setInterval(()=>{if(autoRefresh.value&&typeof document!=='undefined'&&!document.hidden)void refresh();},30000);
  onScopeDispose(()=>{clearInterval(timer);reset();});
  return {frame,rows,loading,error,notice,newest,autoRefresh,page,total,deviceId,coverageVisible,display,frequencyKhz,selectedFrequency,terrainReference,coverageOverlay,dimensions,catalog,select,latest,refresh,reset};
}
