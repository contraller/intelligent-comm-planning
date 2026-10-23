import { ApiError } from './types';
import type { FrozenCoverageAnchor,FrozenCoverageCache,FrozenCoverageFeature,FrozenCoverageInput,FrozenCoverageJob,FrozenCoverageParameters,FrozenCoverageQuery,FrozenCoverageResult } from '../types/frozen-coverage';
const fail=():never=>{throw new ApiError('冻结覆盖响应与来源契约不符','INVALID_FROZEN_COVERAGE_RESPONSE');};
const object=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail();
const text=(v:unknown):string=>typeof v==='string'&&v.length<=2000&&!/[\u0000-\u001f\u007f]/.test(v)?v:fail();
const number=(v:unknown):number=>typeof v==='number'&&Number.isFinite(v)?v:fail();
const strings=(v:unknown):string[]=>Array.isArray(v)?v.map(text):fail();
const hash=(v:unknown):string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:fail();
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
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
  if(row.engine_version!=='V01-1')return fail();
  return row as unknown as FrozenCoverageAnchor;
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
function result(value:unknown,bound:FrozenCoverageAnchor,options:FrozenCoverageParameters):FrozenCoverageResult {
  const row=object(value),provenance=object(row.provenance);
  if(row.schema_version!==1||row.solution_id!==bound.snapshot_id.slice(4)||!['COMPLETE','PARTIAL','UNAVAILABLE'].includes(String(row.status)))return fail();
  for(const key of ['raw_snapshot_sha256','frozen_tables_sha256','terrain_fingerprint','engine_version'])if(provenance[key]!==bound[key as keyof FrozenCoverageAnchor])return fail();
  parameters(provenance.parameters,options);
  const units=object(provenance.units);if(units.margin_db!=='dB'||units.frequency!=='kHz'||units.ring_radius!=='m')return fail();
  strings(provenance.limitations);
  const box=provenance.dem_bbox;if(!Array.isArray(box)||box.length!==4)return fail();box.forEach(number);if(box[0]>=box[2]||box[1]>=box[3])return fail();
  if(!Array.isArray(row.devices)||row.devices.length>1024)return fail();
  const ids=new Set<string>();let count=0;
  for(const value of row.devices){const device=object(value),id=text(device.device_id),nid=text(device.node_id);
    if(!id||!nid||ids.has(id)||!text(device.model_id)||!text(device.antenna_id))return fail();ids.add(id);
    coordinate([device.lon,device.lat]);strings(device.reasons);
    if(device.band!==null)text(device.band);
    if(!['COMPLETE','UNAVAILABLE'].includes(String(device.status))||!Array.isArray(device.computations))return fail();
    if(device.status==='COMPLETE'&&!['HF','VUHF'].includes(String(device.band)))return fail();
    if((device.status==='COMPLETE')!==(device.computations.length>0))return fail();
    for(const computation of device.computations){const part=object(computation),frequency=number(part.freq_khz),geo=object(part.geojson);
      if(frequency<=0||!['CELLS','RINGS'].includes(String(part.shape))||!strings(part.link_ids).length||geo.type!=='FeatureCollection'||!Array.isArray(geo.features))return fail();
      count+=geo.features.length;if(count>300000)return fail();geo.features.forEach(value=>feature(value,id,nid,frequency));
    }
  }
  const successes=row.devices.filter(value=>object(value).status==='COMPLETE').length;
  if(row.status!==(successes===row.devices.length&&successes>0?'COMPLETE':successes?'PARTIAL':'UNAVAILABLE'))return fail();
  return row as unknown as FrozenCoverageResult;
}
export function readFrozenCoverageCache(value:unknown,query:FrozenCoverageQuery,input:FrozenCoverageInput):FrozenCoverageCache {
  const row=object(value),bound=anchor(row.anchor,query),options=parameters(row.parameters,input);
  if(!['HIT','MISS','STALE'].includes(String(row.state))||!/^FCC-[a-f0-9]{64}$/.test(text(row.cache_key)))return fail();
  if(row.state==='HIT')result(row.result,bound,options);else if(row.result!==null)return fail();text(row.reason);
  return row as unknown as FrozenCoverageCache;
}
export function readFrozenCoverageJob(value:unknown,query:FrozenCoverageQuery,input?:FrozenCoverageInput):FrozenCoverageJob {
  const row=object(value);anchor(row.anchor,query);
  if(!/^FCJ-[a-f0-9]{32}$/.test(text(row.job_id))||!text(row.request_id)||!/^FCC-[a-f0-9]{64}$/.test(text(row.cache_key)))return fail();
  if(!['PENDING','RUNNING','SUCCESS','FAILED','CANCELLED','INTERRUPTED'].includes(String(row.state)))return fail();
  const progress=number(row.progress);if(progress<0||progress>1||typeof row.from_cache!=='boolean'||typeof row.cancel_requested!=='boolean')return fail();
  parameters(row.parameters,input??object(row.parameters));text(row.stage);text(row.created_at);text(row.updated_at);
  if(row.finished_at!==null)text(row.finished_at);
  if(row.error!==null){const error=object(row.error);if(!['number','string'].includes(typeof error.code))return fail();text(error.message);}
  return row as unknown as FrozenCoverageJob;
}
