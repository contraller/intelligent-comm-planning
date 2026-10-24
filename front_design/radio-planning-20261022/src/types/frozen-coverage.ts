export interface FrozenCoverageQuery { planId:string;taskId:string;snapshotId:string;resourceRevision:string;context:'planning'|'gis';bandwidthSelection?:FrozenCoverageSelectionRef }
export interface FrozenCoverageSelectionRef { selectionId:string;selectionHash:string }
export interface FrozenCoverageBandwidthChoice { device_id:string;rx_bandwidth_khz:number }
export type FrozenCoverageSourceAnchor=Omit<FrozenCoverageAnchor,'engine_version'>;
export interface FrozenCoverageBandwidthSelection {
  selection_id:string;selection_hash:string;source_anchor:FrozenCoverageSourceAnchor;
  choices:FrozenCoverageBandwidthChoice[];version_no:number;created_at:string;
}
export interface FrozenCoverageBandwidthOption {
  device_id:string;node_id:string;model_id:string;band:string|null;model_bandwidth_khz:string|number|null;options_khz:number[]|null;
  state:'SINGLE_VALUE'|'SELECTION_REQUIRED'|'UNKNOWN'|'NO_ASSIGNED_FREQUENCY';
  reason_code:null|'RX_BANDWIDTH_SELECTION_REQUIRED'|'RX_BANDWIDTH_UNKNOWN'|'NO_ASSIGNED_FREQUENCY';reason:string;
}
export interface FrozenCoverageBandwidthOptions {
  anchor:FrozenCoverageAnchor;devices:FrozenCoverageBandwidthOption[];current_selection:FrozenCoverageBandwidthSelection|null;
}
// V2历史没有这些字段；V3解码必须逐项核验，不以可选类型放宽新响应。
export interface FrozenCoverageSelectionBinding { bandwidth_selection_id?:string|null;bandwidth_selection_hash?:string|null }
export interface FrozenCoverageParameters {
  radius_m:number;cell_m:number;az_step_deg:number;margin_min_db:number;rx_height_m:number;hour:number;hf_max_km:number;ring_vertices:number;
}
export type FrozenCoverageInput=Partial<FrozenCoverageParameters>;
export interface FrozenCoverageAnchor {
  plan_id:string;task_id:string;snapshot_id:string;input_version:string;condition_version:string;
  resource_revision:string;resource_content_hash:string;plan_input_sha256:string;raw_snapshot_sha256:string;
  frozen_tables_sha256:string;terrain_fingerprint:string;engine_version:string;
}
export interface FrozenCoverageFeature {
  type:'Feature';geometry:{type:'Point';coordinates:[number,number]}|{type:'Polygon';coordinates:[number,number][][]}|null;
  properties:{device_id:string;node_id:string;freq_khz:number;is_coverage:boolean;margin_db?:number;note?:string;inner_m?:number;outer_m?:number};
}
export interface FrozenCoverageDevice {
  device_id:string;node_id:string;model_id:string;antenna_id:string;lon:number;lat:number;band:string|null;
  status:'COMPLETE'|'UNAVAILABLE';reasons:string[];
  rx_bandwidth?:{value_khz:number|null;source:'EXPLICIT_COMPUTE_PARAMETER'|'FROZEN_MODEL_SINGLE_VALUE'|'UNSELECTED'|'UNKNOWN'};
  computations:{freq_khz:number;link_ids:string[];shape:'CELLS'|'RINGS';geojson:{type:'FeatureCollection';features:FrozenCoverageFeature[]}}[];
}
export interface FrozenCoverageResult {
  schema_version:1;solution_id:string;status:'COMPLETE'|'PARTIAL'|'UNAVAILABLE';devices:FrozenCoverageDevice[];
  provenance:FrozenCoverageSelectionBinding&{raw_snapshot_sha256:string;frozen_tables_sha256:string;terrain_fingerprint:string;engine_version:string;bandwidth_choices?:FrozenCoverageBandwidthChoice[];
    parameters:FrozenCoverageParameters;dem_bbox:[number,number,number,number];units:{margin_db:'dB';frequency:'kHz';ring_radius:'m'};limitations:string[]};
}
export interface FrozenCoverageCache extends FrozenCoverageSelectionBinding { state:'HIT'|'MISS'|'STALE';cache_key:string;anchor:FrozenCoverageAnchor;parameters:FrozenCoverageParameters;result:FrozenCoverageResult|null;reason:string }
export interface FrozenCoverageJob extends FrozenCoverageSelectionBinding {
  job_id:string;request_id:string;state:'PENDING'|'RUNNING'|'SUCCESS'|'FAILED'|'CANCELLED'|'INTERRUPTED';
  progress:number;stage:string;anchor:FrozenCoverageAnchor;cache_key:string;parameters:FrozenCoverageParameters;from_cache:boolean;cancel_requested:boolean;
  error:{code:string|number;message:string}|null;created_at:string;updated_at:string;finished_at:string|null;
}
export interface FrozenCoverageOverlay { anchor:FrozenCoverageAnchor;result:FrozenCoverageResult;deviceId:string;bandwidthSelection?:FrozenCoverageSelectionRef }
export interface FrozenCoverageClient {
  getBandwidthOptions(query:FrozenCoverageQuery,signal?:AbortSignal):Promise<FrozenCoverageBandwidthOptions>;
  saveBandwidthSelection(query:FrozenCoverageQuery,choices:FrozenCoverageBandwidthChoice[],requestId:string,signal?:AbortSignal):Promise<FrozenCoverageBandwidthSelection>;
  getBandwidthSelection(query:FrozenCoverageQuery,selectionId:string,signal?:AbortSignal):Promise<FrozenCoverageBandwidthSelection>;
  getCache(query:FrozenCoverageQuery,parameters:FrozenCoverageInput,signal?:AbortSignal):Promise<FrozenCoverageCache>;
  compute(query:FrozenCoverageQuery,parameters:FrozenCoverageInput,requestId:string,signal?:AbortSignal):Promise<FrozenCoverageJob>;
  getJob(query:FrozenCoverageQuery,jobId:string,signal?:AbortSignal):Promise<FrozenCoverageJob>;
  cancel(query:FrozenCoverageQuery,jobId:string,requestId:string,signal?:AbortSignal):Promise<FrozenCoverageJob>;
}
