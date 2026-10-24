import type { FrozenCoverageAnchor,FrozenCoverageBandwidthOptions,FrozenCoverageBandwidthSelection,FrozenCoverageCache,FrozenCoverageJob,FrozenCoverageQuery,FrozenCoverageResult } from '../../src/types/frozen-coverage';
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
