import { ApiError } from './types';
import type { FrozenCoverageAnchor,FrozenCoverageBandwidthChoice,FrozenCoverageBandwidthOptions,FrozenCoverageBandwidthSelection,FrozenCoverageCache,FrozenCoverageFeature,FrozenCoverageInput,FrozenCoverageJob,FrozenCoverageParameters,FrozenCoverageQuery,FrozenCoverageResult,FrozenCoverageSelectionRef } from '../types/frozen-coverage';
const fail=():never=>{throw new ApiError('冻结覆盖响应与来源契约不符','INVALID_FROZEN_COVERAGE_RESPONSE');};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail();
const text=(v:unknown):string=>typeof v==='string'&&v.length<=2000&&!/[\u0000-\u001f\u007f]/.test(v)?v:fail();
const number=(v:unknown):number=>typeof v==='number'&&Number.isFinite(v)?v:fail();
const strings=(v:unknown):string[]=>Array.isArray(v)?v.map(text):fail();
const hash=(v:unknown):string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:fail();
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const keys=(row:Record<string,unknown>,expected:readonly string[])=>Object.keys(row).length===expected.length&&expected.every(key=>Object.hasOwn(row,key));
const engines=['V01-2','V01-3','V01-4'];
function bandwidthProvenance(value:unknown) {
  if(value===null)return null;
  const row=object(value);
  if(!keys(row,['origin','source_id','source_sha256','source_note','original_khz'])||row.origin!=='SYNTHETIC_COVERAGE_ASSUMPTION'
    ||row.source_id!=='R5-HF-RX-3KHZ-V1'||row.original_khz!==''||!text(row.source_note).trim())return fail();
  hash(row.source_sha256);return row;
}
function frozenBandwidth(value:unknown):{values:number[]|null;multiple:boolean} {
  if(value===undefined||value===null||value==='')return {values:null,multiple:false};
  const multiple=typeof value==='string'&&value.includes(';');
  const tokens=multiple?(value as string).split(';'):[value];
  if(tokens.length>1024)return fail();
  const values=tokens.map(token=>{
    if(typeof token!=='number'&&typeof token!=='string')return fail();
    if(typeof token==='string'&&!/^\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(token.trim()))return fail();
    const value=number(typeof token==='number'?token:Number(token));if(value<1e-9||value>1e9)return fail();return value;
  });
  return {values:[...new Set(values)].sort((a,b)=>a-b),multiple};
}
const defaults:FrozenCoverageParameters={radius_m:60000,cell_m:1000,az_step_deg:2,margin_min_db:6,rx_height_m:2,hour:12,hf_max_km:900,ring_vertices:72};
export function coverageParameters(input:FrozenCoverageInput):FrozenCoverageParameters {
  const source=object(input),result={...defaults,...source};
  if(Object.keys(source).some(key=>!Object.hasOwn(defaults,key))) return fail();
  const ranges:Record<keyof FrozenCoverageParameters,[number,number]>={radius_m:[250,120000],cell_m:[250,5000],az_step_deg:[1,45],margin_min_db:[-100,100],rx_height_m:[0,300],hour:[0,24],hf_max_km:[1,900],ring_vertices:[24,360]};
  for(const key of Object.keys(ranges) as (keyof FrozenCoverageParameters)[]){const value=number(result[key]),[lo,hi]=ranges[key];if(value<lo||value>hi)return fail();}
  if(result.hour>=24||result.cell_m>result.radius_m||360%result.az_step_deg!==0||!Number.isInteger(result.hf_max_km)||!Number.isInteger(result.ring_vertices)||result.ring_vertices%4!==0)return fail();
  return result;
}
export function validateCoverageQuery(query:FrozenCoverageQuery) {
  if(!['planning','gis'].includes(query.context)) return fail();
  for(const key of ['planId','taskId','snapshotId','resourceRevision'] as const) if(!text(query[key]).trim()||query[key].length>160)return fail();
  if(query.bandwidthSelection){coverageSelectionId(query.bandwidthSelection.selectionId);hash(query.bandwidthSelection.selectionHash);}
  if(query.engineVersion!==undefined&&!engines.includes(query.engineVersion))return fail();
}
export function coverageSelectionId(value:unknown):string { const id=text(value);if(!/^FBS-[a-f0-9]{32}$/.test(id))return fail();return id; }
export function coverageBandwidthChoices(value:unknown):FrozenCoverageBandwidthChoice[] {
  if(!Array.isArray(value)||value.length>1024)return fail();
  const ids=new Set<string>();
  return value.map(value=>{const row=object(value),id=text(row.device_id),bw=number(row.rx_bandwidth_khz);
    if(Object.keys(row).length!==2||!id.trim()||id.length>160||ids.has(id)||bw<1e-9||bw>1e9)return fail();ids.add(id);
    return {device_id:id,rx_bandwidth_khz:bw};
  }).sort((a,b)=>a.device_id<b.device_id?-1:a.device_id>b.device_id?1:0);
}
function parameters(value:unknown,input:FrozenCoverageInput) {
  const result=coverageParameters(object(value));
  if(!equal(result,coverageParameters(input))||Object.keys(object(value)).length!==Object.keys(defaults).length)return fail();
  return result;
}
function anchor(value:unknown,query:FrozenCoverageQuery):FrozenCoverageAnchor {
  const row=object(value);
  for(const [key,expected] of [['plan_id',query.planId],['task_id',query.taskId],['snapshot_id',query.snapshotId]])if(row[key]!==expected)return fail();
  if(row.resource_revision!==query.resourceRevision)return fail();
  for(const key of ['input_version','condition_version','resource_revision'])if(!text(row[key]))return fail();
  for(const key of ['resource_content_hash','plan_input_sha256','raw_snapshot_sha256','frozen_tables_sha256','terrain_fingerprint'])hash(row[key]);
  // 原选择可绑定同一冻结来源的V3/V4，历史缓存不升级或补新字段。
  if(!engines.includes(String(row.engine_version))||query.bandwidthSelection&&row.engine_version==='V01-2')return fail();
  return row as unknown as FrozenCoverageAnchor;
}
const sourceKeys=['plan_id','task_id','snapshot_id','input_version','condition_version','resource_revision','resource_content_hash','plan_input_sha256','raw_snapshot_sha256','frozen_tables_sha256','terrain_fingerprint'] as const;
export function readFrozenBandwidthSelection(value:unknown,query:FrozenCoverageQuery,bound?:FrozenCoverageAnchor,expected?:FrozenCoverageBandwidthChoice[]):FrozenCoverageBandwidthSelection {
  const row=object(value),source=object(row.source_anchor);
  if(Object.keys(row).length!==6||Object.keys(source).length!==sourceKeys.length||sourceKeys.some(key=>!Object.hasOwn(source,key)))return fail();
  anchor({...source,engine_version:'V01-3'},query);coverageSelectionId(row.selection_id);hash(row.selection_hash);
  if(bound&&sourceKeys.some(key=>source[key]!==bound[key]))return fail();
  const choices=coverageBandwidthChoices(row.choices);
  if(expected&&!equal(choices,coverageBandwidthChoices(expected)))return fail();
  if(!Number.isSafeInteger(row.version_no)||number(row.version_no)<=0||!Number.isFinite(Date.parse(text(row.created_at))))return fail();
  return row as unknown as FrozenCoverageBandwidthSelection;
}
export function readFrozenBandwidthOptions(value:unknown,query:FrozenCoverageQuery):FrozenCoverageBandwidthOptions {
  const row=object(value),bound=anchor(row.anchor,query);
  const v4=bound.engine_version==='V01-4';
  if(Object.keys(row).length!==3||!['V01-3','V01-4'].includes(bound.engine_version)||!Array.isArray(row.devices)||row.devices.length>1024)return fail();
  const ids=new Set<string>(),options=new Map<string,number[]|null>();
  for(const value of row.devices){const device=object(value),id=text(device.device_id);
    const expected=['device_id','node_id','model_id','band','model_bandwidth_khz','options_khz','state','reason_code','reason',...v4?['bandwidth_provenance']:[]];
    if(!keys(device,expected)||!id.trim()||ids.has(id)||!text(device.node_id).trim()||!text(device.model_id).trim())return fail();ids.add(id);
    if(device.band!==null)text(device.band);
    if(device.model_bandwidth_khz!==null){if(typeof device.model_bandwidth_khz==='number')number(device.model_bandwidth_khz);else text(device.model_bandwidth_khz);}
    const values=device.options_khz;
    if(values!==null&&(!Array.isArray(values)||!values.length||values.length>1024||values.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<1e-9||v>1e9)||new Set(values).size!==values.length))return fail();
    const reasons:Record<string,string|null>={SINGLE_VALUE:null,SELECTION_REQUIRED:'RX_BANDWIDTH_SELECTION_REQUIRED',UNKNOWN:'RX_BANDWIDTH_UNKNOWN',NO_ASSIGNED_FREQUENCY:'NO_ASSIGNED_FREQUENCY'};
    if(!Object.hasOwn(reasons,String(device.state))||device.reason_code!==reasons[String(device.state)])return fail();text(device.reason);
    if(device.state==='SINGLE_VALUE'&&(!Array.isArray(values)||values.length!==1)||device.state==='SELECTION_REQUIRED'&&values===null||device.state==='UNKNOWN'&&values!==null)return fail();
    if(v4){
      const raw=frozenBandwidth(device.model_bandwidth_khz);
      if(!equal(raw.values,values))return fail();
      if(device.state!=='NO_ASSIGNED_FREQUENCY'&&device.state!==(raw.values===null?'UNKNOWN':raw.multiple?'SELECTION_REQUIRED':'SINGLE_VALUE'))return fail();
    }
    if(v4&&bandwidthProvenance(device.bandwidth_provenance)!==null
      &&(device.band!=='HF'||!equal(values,[3])||Number(device.model_bandwidth_khz)!==3))return fail();
    options.set(id,values as number[]|null);
  }
  if(row.current_selection!==null){const selection=readFrozenBandwidthSelection(row.current_selection,query,bound);
    if(selection.choices.some(choice=>!options.get(choice.device_id)?.includes(choice.rx_bandwidth_khz)))return fail();}
  return row as unknown as FrozenCoverageBandwidthOptions;
}
function selectionBinding(row:Record<string,unknown>,bound:FrozenCoverageAnchor,query:FrozenCoverageQuery):FrozenCoverageSelectionRef|null {
  const id=row.bandwidth_selection_id,digest=row.bandwidth_selection_hash;
  if(bound.engine_version==='V01-2'){if(id!=null||digest!=null||query.bandwidthSelection)return fail();return null;}
  if(!Object.hasOwn(row,'bandwidth_selection_id')||!Object.hasOwn(row,'bandwidth_selection_hash'))return fail();
  if(id===null&&digest===null){if(query.bandwidthSelection)return fail();return null;}
  const ref={selectionId:coverageSelectionId(id),selectionHash:hash(digest)};
  if(!query.bandwidthSelection||ref.selectionId!==query.bandwidthSelection.selectionId||ref.selectionHash!==query.bandwidthSelection.selectionHash)return fail();
  return ref;
}
function coordinate(value:unknown):[number,number] {
  if(!Array.isArray(value)||value.length!==2)return fail();
  const lon=number(value[0]),lat=number(value[1]);if(Math.abs(lon)>180||Math.abs(lat)>90)return fail();return [lon,lat];
}
function feature(value:unknown,device:string,node:string,frequency:number):FrozenCoverageFeature {
  const row=object(value),properties=object(row.properties);
  if(row.type!=='Feature'||properties.device_id!==device||properties.node_id!==node||properties.freq_khz!==frequency||typeof properties.is_coverage!=='boolean')return fail();
  if(properties.margin_db!==undefined)number(properties.margin_db);
  if(row.geometry!==null){const geometry=object(row.geometry);
    if(geometry.type==='Point')coordinate(geometry.coordinates);
    else if(geometry.type==='Polygon'){
      if(!Array.isArray(geometry.coordinates)||!geometry.coordinates.length)return fail();
      for(const ring of geometry.coordinates){if(!Array.isArray(ring)||ring.length<4||ring.length>361)return fail();ring.forEach(coordinate);if(!equal(ring[0],ring.at(-1)))return fail();}
    }else return fail();
  }
  return row as unknown as FrozenCoverageFeature;
}
function frozenNumber(row:Record<string,unknown>,key:string,lo:number,hi:number):number|undefined {
  const raw=row[key];if(raw===undefined||raw===null||raw==='')return undefined;
  if(typeof raw!=='number'&&typeof raw!=='string'||typeof raw==='string'&&!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(raw.trim()))return fail();
  const value=number(typeof raw==='number'?raw:Number(raw));if(value<lo||value>hi)return fail();return value;
}
function v4Device(device:Record<string,unknown>) {
  const provenance=bandwidthProvenance(device.bandwidth_provenance);
  const model=device.frozen_model===null?null:object(device.frozen_model),antenna=device.frozen_antenna===null?null:object(device.frozen_antenna);
  const plan=device.planned_parameters===null?null:object(device.planned_parameters);
  if(device.band!==null&&device.band!==''&&!['HF','VUHF'].includes(String(device.band)))return fail();
  // 跳过射频求解仍核对已有快照的身份和数值，不能用SKIPPED掩盖损坏来源。
  if(model){
    if(model.model_id!==device.model_id||(model.device_class??null)!==device.band)return fail();
    frozenNumber(model,'rx_sensitivity_dbm',-300,100);
    const lo=frozenNumber(model,'freq_min_khz',1e-9,1e9),hi=frozenNumber(model,'freq_max_khz',1e-9,1e9);
    if(lo!==undefined&&hi!==undefined&&lo>hi)return fail();
    const rawProvenance=['bandwidth_origin','bandwidth_source_id','bandwidth_source_sha256','bandwidth_source_note','bandwidth_original_khz'];
    const values=provenance?['origin','source_id','source_sha256','source_note','original_khz'].map(key=>provenance[key]):null;
    if(provenance){if(rawProvenance.some((key,index)=>model[key]!==values![index])||device.band!=='HF'||Number(model.bandwidth_khz)!==3)return fail();}
    else if(rawProvenance.some(key=>Object.hasOwn(model,key)))return fail();
  }else if(provenance)return fail();
  if(antenna){
    if(antenna.antenna_id!==device.antenna_id)return fail();frozenNumber(antenna,'gain_dbi',-100,100);
    if(antenna.pattern_type!==undefined&&antenna.pattern_type!==null&&antenna.pattern_type!=='')text(antenna.pattern_type);
  }
  if(plan){
    if(plan.device_id!==device.device_id)return fail();
    for(const key of ['node_id','model_id','antenna_id'])if(Object.hasOwn(plan,key)&&plan[key]!==device[key])return fail();
    if(Object.hasOwn(plan,'band')&&(!['HF','VUHF'].includes(String(plan.band))||device.band!==null&&device.band!==''&&plan.band!==device.band))return fail();
    frozenNumber(plan,'tx_power_dbm',-100,100);frozenNumber(plan,'antenna_height_m',0,1000);
  }
  const code=device.reason_code,radio=device.radio_parameters,bw=object(device.rx_bandwidth);
  if(!keys(bw,['value_khz','source']))return fail();
  const rawBandwidth=frozenBandwidth(model?.bandwidth_khz);
  if(bw.source==='EXPLICIT_COMPUTE_PARAMETER'){
    if(!rawBandwidth.values?.includes(number(bw.value_khz)))return fail();
  }else{
    const expected=rawBandwidth.values===null?'UNKNOWN':rawBandwidth.multiple?'UNSELECTED':'FROZEN_MODEL_SINGLE_VALUE';
    if(bw.source!==expected||expected==='FROZEN_MODEL_SINGLE_VALUE'&&bw.value_khz!==rawBandwidth.values![0])return fail();
  }
  if(device.status==='COMPLETE'){
    if(code!==null||!model||!antenna||!plan||(device.reasons as string[]).length)return fail();
    const row=object(radio);
    if(!keys(row,['tx_dbm','height','gain','sens','fmin','fmax','pattern','bw']))return fail();
    const ranges:Record<string,[number,number]>={tx_dbm:[-100,100],height:[0,1000],gain:[-100,100],sens:[-300,100],fmin:[1e-9,1e9],fmax:[1e-9,1e9],bw:[1e-9,1e9]};
    for(const [key,[lo,hi]] of Object.entries(ranges)){const value=number(row[key]);if(value<lo||value>hi)return fail();}
    if(!text(row.pattern).trim()||number(row.fmin)>number(row.fmax)||row.bw!==bw.value_khz)return fail();
    const rawFields:{key:string;source:Record<string,unknown>;field:string}[]=[
      {key:'tx_dbm',source:plan,field:'tx_power_dbm'},{key:'height',source:plan,field:'antenna_height_m'},
      {key:'gain',source:antenna,field:'gain_dbi'},{key:'sens',source:model,field:'rx_sensitivity_dbm'},
      {key:'fmin',source:model,field:'freq_min_khz'},{key:'fmax',source:model,field:'freq_max_khz'}];
    if(rawFields.some(({key,source,field})=>row[key]!==frozenNumber(source,field,...ranges[key]!))||row.pattern!==antenna.pattern_type)return fail();
    for(const value of device.computations as unknown[]){const frequency=number(object(value).freq_khz);if(frequency<number(row.fmin)||frequency>number(row.fmax))return fail();}
  }else{
    if(radio!==null||!(device.reasons as string[]).length)return fail();
    if(device.status==='SKIPPED'){if(code!=='NO_ASSIGNED_FREQUENCY')return fail();}
    else if(!['RX_BANDWIDTH_UNKNOWN','RX_BANDWIDTH_SELECTION_REQUIRED','FROZEN_PARAMETERS_UNKNOWN'].includes(String(code)))return fail();
    if(code==='RX_BANDWIDTH_UNKNOWN'&&bw.source!=='UNKNOWN'||code==='RX_BANDWIDTH_SELECTION_REQUIRED'&&bw.source!=='UNSELECTED')return fail();
  }
}
function result(value:unknown,bound:FrozenCoverageAnchor,options:FrozenCoverageParameters,query:FrozenCoverageQuery):FrozenCoverageResult {
  const row=object(value),provenance=object(row.provenance);
  const v4=bound.engine_version==='V01-4';
  if(row.schema_version!==(v4?2:1)||row.solution_id!==bound.snapshot_id.slice(4)||![...(v4?['NOT_APPLICABLE']:[]),'COMPLETE','PARTIAL','UNAVAILABLE'].includes(String(row.status)))return fail();
  if(!v4&&Object.hasOwn(row,'summary'))return fail();
  for(const key of ['raw_snapshot_sha256','frozen_tables_sha256','terrain_fingerprint','engine_version'])if(provenance[key]!==bound[key as keyof FrozenCoverageAnchor])return fail();
  parameters(provenance.parameters,options);
  const ref=selectionBinding(provenance,bound,query);
  const selected=bound.engine_version!=='V01-2'?coverageBandwidthChoices(provenance.bandwidth_choices):[];
  if(!ref&&selected.length)return fail();
  const selectedById=new Map(selected.map(row=>[row.device_id,row.rx_bandwidth_khz]));
  const units=object(provenance.units);if(units.margin_db!=='dB'||units.frequency!=='kHz'||units.ring_radius!=='m')return fail();
  strings(provenance.limitations);
  const box=provenance.dem_bbox;if(!Array.isArray(box)||box.length!==4)return fail();box.forEach(number);if(box[0]>=box[2]||box[1]>=box[3])return fail();
  if(!Array.isArray(row.devices)||row.devices.length>1024)return fail();
  const ids=new Set<string>();let count=0;
  for(const value of row.devices){const device=object(value),id=text(device.device_id),nid=text(device.node_id);
    if(!id.trim()||!nid.trim()||ids.has(id)||!text(device.model_id).trim()||!text(device.antenna_id).trim())return fail();ids.add(id);
    coordinate([device.lon,device.lat]);strings(device.reasons);
    if(device.band!==null)text(device.band);
    if(!['COMPLETE','UNAVAILABLE',...v4?['SKIPPED']:[]].includes(String(device.status))||!Array.isArray(device.computations))return fail();
    if(device.status==='COMPLETE'&&!['HF','VUHF'].includes(String(device.band)))return fail();
    if((device.status==='COMPLETE')!==(device.computations.length>0))return fail();
    if(bound.engine_version!=='V01-2'){
      const bw=object(device.rx_bandwidth),source=bw.source,value=bw.value_khz;
      if(!['EXPLICIT_COMPUTE_PARAMETER','FROZEN_MODEL_SINGLE_VALUE','UNSELECTED','UNKNOWN'].includes(String(source)))return fail();
      if(source==='EXPLICIT_COMPUTE_PARAMETER'){if(!selectedById.has(id)||value!==selectedById.get(id))return fail();}
      else if(selectedById.has(id))return fail();
      if(source==='EXPLICIT_COMPUTE_PARAMETER'||source==='FROZEN_MODEL_SINGLE_VALUE'){if(number(value)<1e-9||number(value)>1e9)return fail();}
      else if(value!==null||device.status==='COMPLETE')return fail();
    }
    if(!v4&&['reason_code','bandwidth_provenance'].some(key=>Object.hasOwn(device,key)))return fail();
    if(v4)v4Device(device);
    for(const computation of device.computations){const part=object(computation),frequency=number(part.freq_khz),geo=object(part.geojson);
      if(frequency<=0||!['CELLS','RINGS'].includes(String(part.shape))||!strings(part.link_ids).length||geo.type!=='FeatureCollection'||!Array.isArray(geo.features))return fail();
      count+=geo.features.length;if(count>300000)return fail();geo.features.forEach(value=>feature(value,id,nid,frequency));
    }
  }
  if(selected.some(choice=>!ids.has(choice.device_id)))return fail();
  const successes=row.devices.filter(value=>object(value).status==='COMPLETE').length;
  const skipped=row.devices.filter(value=>object(value).status==='SKIPPED').length,eligible=row.devices.length-skipped;
  if(v4){
    const summary=object(row.summary),expected={total:row.devices.length,eligible,complete:successes,unavailable:eligible-successes,skipped};
    if(!keys(summary,Object.keys(expected))||Object.entries(expected).some(([key,value])=>!Number.isSafeInteger(summary[key])||summary[key]!==value))return fail();
  }
  if(row.status!==(v4&&eligible===0?'NOT_APPLICABLE':successes===eligible&&successes>0?'COMPLETE':successes?'PARTIAL':'UNAVAILABLE'))return fail();
  return row as unknown as FrozenCoverageResult;
}
export function readFrozenCoverageCache(value:unknown,query:FrozenCoverageQuery,input:FrozenCoverageInput):FrozenCoverageCache {
  const row=object(value),bound=anchor(row.anchor,query),options=parameters(row.parameters,input);
  if(query.engineVersion!==undefined&&bound.engine_version!==query.engineVersion)return fail();
  if(!['HIT','MISS','STALE'].includes(String(row.state))||!/^FCC-[a-f0-9]{64}$/.test(text(row.cache_key)))return fail();
  selectionBinding(row,bound,query);
  if(row.state==='HIT')result(row.result,bound,options,query);else if(row.result!==null)return fail();text(row.reason);
  return row as unknown as FrozenCoverageCache;
}
export function readFrozenCoverageJob(value:unknown,query:FrozenCoverageQuery,input?:FrozenCoverageInput):FrozenCoverageJob {
  const row=object(value),bound=anchor(row.anchor,query);selectionBinding(row,bound,query);
  if(!/^FCJ-[a-f0-9]{32}$/.test(text(row.job_id))||!text(row.request_id)||!/^FCC-[a-f0-9]{64}$/.test(text(row.cache_key)))return fail();
  if(!['PENDING','RUNNING','SUCCESS','FAILED','CANCELLED','INTERRUPTED'].includes(String(row.state)))return fail();
  const progress=number(row.progress);if(progress<0||progress>1||typeof row.from_cache!=='boolean'||typeof row.cancel_requested!=='boolean')return fail();
  parameters(row.parameters,input??object(row.parameters));text(row.stage);text(row.created_at);text(row.updated_at);
  if(row.finished_at!==null)text(row.finished_at);
  if(row.error!==null){const error=object(row.error);if(!['number','string'].includes(typeof error.code))return fail();text(error.message);}
  return row as unknown as FrozenCoverageJob;
}
