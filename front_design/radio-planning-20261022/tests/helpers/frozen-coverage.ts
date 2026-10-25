import type { FrozenCoverageAnchor,FrozenCoverageBandwidthOptions,FrozenCoverageBandwidthSelection,FrozenCoverageCache,FrozenCoverageDevice,FrozenCoverageJob,FrozenCoverageQuery,FrozenCoverageResult } from '../../src/types/frozen-coverage';
import { coverageParameters } from '../../src/services/frozen-coverage-decode';
// 只用于协议/状态/几何测试，不声称为后端算法或现场DEM输出。
export function coverageCase(){
  const query:FrozenCoverageQuery={planId:'PLAN-1',taskId:'TASK-1',snapshotId:'SNP-PL-1',resourceRevision:'resource-frozen',context:'planning'};
  const parameters=coverageParameters({cell_m:5000,az_step_deg:10});
  const anchor:FrozenCoverageAnchor={plan_id:query.planId,task_id:query.taskId,snapshot_id:query.snapshotId,input_version:'INPUT-1',condition_version:'C1',resource_revision:query.resourceRevision,
    resource_content_hash:'a'.repeat(64),plan_input_sha256:'b'.repeat(64),raw_snapshot_sha256:'c'.repeat(64),frozen_tables_sha256:'d'.repeat(64),terrain_fingerprint:'e'.repeat(64),engine_version:'V01-2'};
  const result:FrozenCoverageResult={schema_version:1,solution_id:'PL-1',status:'COMPLETE',devices:[{device_id:'D1',node_id:'N1',model_id:'M1',antenna_id:'A1',lon:114,lat:37.5,band:'VUHF',status:'COMPLETE',reasons:[],computations:[{freq_khz:30000,link_ids:['L1'],shape:'CELLS',geojson:{type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[114,37.5]},properties:{device_id:'D1',node_id:'N1',freq_khz:30000,is_coverage:true,margin_db:12}}]}}]}],
    provenance:{raw_snapshot_sha256:anchor.raw_snapshot_sha256,frozen_tables_sha256:anchor.frozen_tables_sha256,terrain_fingerprint:anchor.terrain_fingerprint,engine_version:'V01-2',parameters,dem_bbox:[113,37,115,38],units:{margin_db:'dB',frequency:'kHz',ring_radius:'m'},limitations:['测试构造余量，非实测场强']}};
  const cache:FrozenCoverageCache={state:'HIT',cache_key:'FCC-'+'f'.repeat(64),anchor,parameters,result,reason:'持久缓存命中'};
  const job:FrozenCoverageJob={job_id:'FCJ-'+'1'.repeat(32),request_id:'request-1',state:'SUCCESS',progress:1,stage:'完成',anchor,cache_key:cache.cache_key,parameters,from_cache:false,cancel_requested:false,error:null,created_at:'2026-10-24T00:00:00Z',updated_at:'2026-10-24T00:00:01Z',finished_at:'2026-10-24T00:00:01Z'};
  return {query,parameters,anchor,result,cache,job};
}
export function bandwidthCase(selected=true){
  const value=coverageCase();value.anchor.engine_version='V01-3';value.result.provenance.engine_version='V01-3';
  const {engine_version:_,...source_anchor}=value.anchor;
  const selection:FrozenCoverageBandwidthSelection={selection_id:'FBS-'+'2'.repeat(32),selection_hash:'9'.repeat(64),source_anchor,
    choices:[{device_id:'D1',rx_bandwidth_khz:2.4}],version_no:1,created_at:'2026-10-24T00:00:00Z'};
  const binding={bandwidth_selection_id:selected?selection.selection_id:null,bandwidth_selection_hash:selected?selection.selection_hash:null};
  Object.assign(value.cache,binding);Object.assign(value.job,binding);
  Object.assign(value.result.provenance,binding,{bandwidth_choices:selected?selection.choices:[]});
  value.result.devices[0]!.rx_bandwidth=selected?{value_khz:2.4,source:'EXPLICIT_COMPUTE_PARAMETER'}:{value_khz:null,source:'UNSELECTED'};
  if(selected)value.query.bandwidthSelection={selectionId:selection.selection_id,selectionHash:selection.selection_hash};
  else{value.result.devices[0]!.status='UNAVAILABLE';value.result.devices[0]!.computations=[];value.result.status='UNAVAILABLE';}
  const options:FrozenCoverageBandwidthOptions={anchor:value.anchor,devices:[{device_id:'D1',node_id:'N1',model_id:'M1',band:'VUHF',model_bandwidth_khz:'0.5;2.4',options_khz:[0.5,2.4],state:'SELECTION_REQUIRED',reason_code:'RX_BANDWIDTH_SELECTION_REQUIRED',reason:'需要显式冻结接收带宽选值'}],current_selection:selected?selection:null};
  return {...value,options,selection};
}
export function coverageV4Case(counts={complete:1,unavailable:1,skipped:1},synthetic=false,selected=false){
  const value=bandwidthCase(false),total=counts.complete+counts.unavailable+counts.skipped;
  value.anchor.engine_version='V01-4';value.result.schema_version=2;value.result.provenance.engine_version='V01-4';
  value.result.devices=[];value.options.devices=[];
  for(let index=0;index<total;index++){
    const device_id=`D${index+1}`,status=index<counts.complete?'COMPLETE':index<counts.complete+counts.unavailable?'UNAVAILABLE':'SKIPPED';
    const band=synthetic?'HF':'VUHF',model_id=synthetic?'DM-0001':'M1',bw=synthetic?3:2.4,freq=synthetic?7000:30000;
    const bandwidth_provenance=synthetic?{origin:'SYNTHETIC_COVERAGE_ASSUMPTION' as const,source_id:'R5-HF-RX-3KHZ-V1' as const,source_sha256:'6'.repeat(64),source_note:'构造覆盖接收假设，非厂家实参',original_khz:'' as const}:null;
    const model:Record<string,unknown>={model_id,device_class:band,bandwidth_khz:String(bw),rx_sensitivity_dbm:-110,freq_min_khz:2000,freq_max_khz:300000,source_doc:'原冻结型号资料'};
    if(bandwidth_provenance)Object.assign(model,{bandwidth_origin:bandwidth_provenance.origin,bandwidth_source_id:bandwidth_provenance.source_id,bandwidth_source_sha256:bandwidth_provenance.source_sha256,bandwidth_source_note:bandwidth_provenance.source_note,bandwidth_original_khz:''});
    if(status==='UNAVAILABLE')model.bandwidth_khz='';
    const device:FrozenCoverageDevice={device_id,node_id:'N1',model_id,antenna_id:'A1',lon:114,lat:37.5,band,status,
      reasons:status==='SKIPPED'?['本次无活动冻结链路']:status==='UNAVAILABLE'?['缺少接收带宽']:[],
      reason_code:status==='SKIPPED'?'NO_ASSIGNED_FREQUENCY':status==='UNAVAILABLE'?'RX_BANDWIDTH_UNKNOWN':null,
      bandwidth_provenance,rx_bandwidth:status==='UNAVAILABLE'?{value_khz:null,source:'UNKNOWN'}:{value_khz:bw,source:'FROZEN_MODEL_SINGLE_VALUE'},
      frozen_model:model,frozen_antenna:{antenna_id:'A1',gain_dbi:0,pattern_type:'OMNI'},
      planned_parameters:{device_id,node_id:'N1',model_id,antenna_id:'A1',band,tx_power_dbm:30,antenna_height_m:10},
      radio_parameters:status==='COMPLETE'?{tx_dbm:30,height:10,gain:0,sens:-110,fmin:2000,fmax:300000,pattern:'OMNI',bw}:null,
      computations:status==='COMPLETE'?[{freq_khz:freq,link_ids:['L1'],shape:synthetic?'RINGS':'CELLS',geojson:{type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[114,37.5]},properties:{device_id,node_id:'N1',freq_khz:freq,is_coverage:true,margin_db:12}}]}}]:[]};
    value.result.devices.push(device);
    value.options.devices.push({device_id,node_id:'N1',model_id,band,model_bandwidth_khz:model.bandwidth_khz as string,options_khz:status==='UNAVAILABLE'?null:[bw],
      state:status==='SKIPPED'?'NO_ASSIGNED_FREQUENCY':status==='UNAVAILABLE'?'UNKNOWN':'SINGLE_VALUE',reason_code:status==='SKIPPED'?'NO_ASSIGNED_FREQUENCY':status==='UNAVAILABLE'?'RX_BANDWIDTH_UNKNOWN':null,
      reason:device.reasons.join('；'),bandwidth_provenance});
  }
  const eligible=counts.complete+counts.unavailable;
  value.result.summary={total,eligible,...counts};
  value.result.status=eligible===0?'NOT_APPLICABLE':counts.complete===eligible?'COMPLETE':counts.complete?'PARTIAL':'UNAVAILABLE';
  if(selected){
    const first=value.result.devices[0]!;
    value.selection.choices=[{device_id:first.device_id,rx_bandwidth_khz:first.rx_bandwidth!.value_khz!}];
    value.options.current_selection=value.selection;
    value.query.bandwidthSelection={selectionId:value.selection.selection_id,selectionHash:value.selection.selection_hash};
    const binding={bandwidth_selection_id:value.selection.selection_id,bandwidth_selection_hash:value.selection.selection_hash};
    Object.assign(value.cache,binding);Object.assign(value.job,binding);Object.assign(value.result.provenance,binding,{bandwidth_choices:value.selection.choices});
    first.rx_bandwidth!.source='EXPLICIT_COMPUTE_PARAMETER';
  }
  return value;
}
