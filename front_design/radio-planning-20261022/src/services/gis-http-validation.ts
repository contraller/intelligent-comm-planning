import { ApiError } from './types';
import { decodeModel, decodeObject, readRecord, readText, requireRevision } from './resource-read-validation';
import type { GisResourceDirectory, GisResourceScene } from '../types/gis-workspace';
import type { ReadDevice, ReadInterference, ReadNode } from '../types/resource-read';

const fail=():never=>{throw new ApiError('GIS 资料字段或关联不符合契约','INVALID_RESOURCE_RESPONSE');};
function rows(value:unknown):Record<string,unknown>[]{if(!Array.isArray(value))return fail();return value.map(row=>readRecord(row));}
function unique(items:{id:string}[]){if(new Set(items.map(x=>x.id)).size!==items.length)fail();}
function common(value:unknown,expected:string){
  const v=readRecord(value);requireRevision(v.revision,expected);
  if(v.context!=='gis'||v.dataOrigin!=='SYNTHETIC_INTEGRATION')fail();
  const stations=rows(v.nodes).map(row=>{const node=decodeObject('node',row) as ReadNode;if(node.origin!=='SOURCE')fail();return {...node,origin:'SOURCE' as const};});
  unique(stations);const stationIds=new Set(stations.map(row=>row.id));
  if(stations.some(row=>row.parentIds.some(id=>!stationIds.has(id))))fail();
  const interferences=rows(v.interferences).map(row=>{const source=decodeObject('interference',row) as ReadInterference;if(source.origin!=='SOURCE')fail();return {...source,origin:'SOURCE' as const};});unique(interferences);
  const source=readText(v.source,'source'),updatedAt=readText(v.updatedAt,'updatedAt');
  if(!Number.isFinite(Date.parse(updatedAt)))fail();
  return {v,stations,stationIds,interferences,source,updatedAt};
}
export function decodeGisDirectory(value:unknown,revision:string):GisResourceDirectory{
  const s=common(value,revision),models=rows(s.v.models).map(row=>({id:readText(row.model_id,'model_id'),name:readText(row.model_name,'model_name'),deviceClass:row.device_class}));
  unique(models);if(models.some(row=>!['HF','VUHF'].includes(String(row.deviceClass))))fail();
  const modelIds=new Set(models.map(row=>row.id));
  const devices=rows(s.v.devices).map(row=>{
    if(!s.stationIds.has(String(row.node_id))||!modelIds.has(String(row.model_id))||!['NORMAL','FAULT','OFFLINE'].includes(String(row.status))
      ||typeof row.alert!=='boolean'||!['ACTIVE','OFF_SHELF'].includes(String(row.availability))||row.origin!=='SOURCE')fail();
    return {id:readText(row.device_id,'device_id'),stationId:readText(row.node_id,'node_id'),modelId:readText(row.model_id,'model_id'),status:row.status,alert:row.alert,availability:row.availability,origin:row.origin};
  });unique(devices);
  return {revision,resources:{stations:s.stations,devices,models,interferences:s.interferences,source:s.source,version:revision}} as GisResourceDirectory;
}
export function decodeGisScene(value:unknown,revision:string):GisResourceScene{
  const s=common(value,revision),models=rows(s.v.models).map(decodeModel),devices=rows(s.v.devices).map(row=>decodeObject('device',row) as ReadDevice);
  unique(models);unique(devices);const modelMap=new Map(models.map(row=>[row.id,row])),stationMap=new Map(s.stations.map(row=>[row.id,row]));
  if(devices.some(row=>!s.stationIds.has(row.stationId)||!modelMap.has(row.modelId)||row.stationCoordinate.some((part,i)=>part!==stationMap.get(row.stationId)!.coordinate[i])))fail();
  const snapshotId=readText(s.v.snapshotId,'snapshotId');
  if(snapshotId!=='GIS-RES-'+revision||s.v.networkState!=='missing')fail();
  const message=readText(s.v.networkMessage,'networkMessage');
  // 没有关联任务的资源浏览只展示资源；空数组不代表已经计算出零影响或零链路。
  return {revision,resourceMeta:{revision,resourceEpoch:revision,stationVersions:Object.fromEntries(s.stations.map(row=>[row.id,revision])),deviceVersions:Object.fromEntries(devices.map(row=>[row.id,revision])),savedAt:s.updatedAt,changedStationIds:[],changedDeviceIds:[]},
    situation:{title:'GIS 资源基线',snapshotId,updatedAt:s.updatedAt,links:[],candidateLinks:[],regions:[],alerts:[],spectrum:[]},
    map:{stations:s.stations,interferences:s.interferences,missingCount:0,devices:devices.map(row=>{const station=stationMap.get(row.stationId)!,model=modelMap.get(row.modelId)!;return{id:row.id,stationId:row.stationId,stationName:station.name,modelId:row.modelId,deviceClass:model.deviceClass,coordinate:[...station.coordinate],status:row.status,alert:row.alert,offShelf:row.availability==='OFF_SHELF',manualStation:false,workFreqKhz:row.workFreqKhz,freqMinKhz:model.freqMinKhz,freqMaxKhz:model.freqMaxKhz};})},
    network:{state:'missing',message,title:'未关联规划网络',snapshotId,source:s.source,links:[],services:[],routes:[]},
    linkDetails:{state:'missing',message,snapshotId,source:s.source,records:[]}};
}
