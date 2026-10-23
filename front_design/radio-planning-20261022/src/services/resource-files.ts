import type { ResourcesData, Station, Device, InterferenceSource, NetworkLink } from '../types/domain';
import type { CandidateLink } from '../types/candidate-link';
import type { ResourceFile, ResourceFormat, ResourceKind, ResourceImportRequest, ResourceImportPreview, ResourceExportRequest, ResourceIssue } from '../types/resource-edit';
import { RESOURCE_MAX_FILE_BYTES, RESOURCE_MAX_IMPORT_ROWS } from '../config/demo';
import { initialResources } from '../mocks/resource-presets';
import { applyChanges, diffResources, resourceSignature, validateResources, same } from './resource-validation';
import { ApiError } from './types';
import { externalCandidateLink } from './candidate-link';
import { matchesLedgerQuery, projectLedgerRows } from './resource-ledger-workspace';
import { deviceStatusDisplay } from './resource-status-display';
import type { DeviceStatusSnapshot } from '../types/resource-status';
import { projectGisTree } from './gis-workspace';
import { gisResourceExportIds, gisCandidateExportIds } from './gis-resource-tree';
import type { GisClassification } from '../types/gis-workspace';

export const resourceHeaders:Record<ResourceKind,string[]>={
  nodes:'node_id,node_name,echelon,node_subtype,parent_node_id,node_role,mobility,lon,lat,elevation_m,region,device_class,relay_capable,status,is_key,remark'.split(','),
  devices:'device_id,node_id,model_id,antenna_id,antenna_height_m,tilt_deg,azimuth_deg,tx_power_dbm,work_freq_khz,status,install_time'.split(','),
  interference_sources:'interference_id,name,lon,lat,elevation_m,antenna_height_m,center_freq_khz,bandwidth_khz,tx_power_dbm,antenna_gain_dbi,interference_type,pattern_type,azimuth_deg,duty_cycle,active'.split(','),
  topology_links:'link_id,node_a_id,node_b_id,device_a_id,device_b_id,device_class,freq_khz,bandwidth_khz,distance_m,path_loss_db,rx_power_dbm,link_margin_db,is_available,link_state,is_backup'.split(','),
};
// 原资源默认仍为三表；候选只通过 GIS 专用文件入口读写。
export const resourceKinds:Exclude<ResourceKind,'topology_links'>[]=['nodes','devices','interference_sources'];
const allResourceKinds=Object.keys(resourceHeaders) as ResourceKind[];
export const resourceCollections={nodes:'stations',devices:'devices',interference_sources:'interferences',topology_links:'candidateLinks'} as const;
const mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const text=(v:unknown)=>v==null?'':String(v).trim();
const number=(v:string,nullable=false)=>v===''?(nullable?null:NaN):Number(v);
const bool=(v:string)=>v==='true'?true:v==='false'?false:v as unknown as boolean;
const nullableBool=(v:string)=>v===''?null:bool(v);
const list=(v:string)=>v.split(';').map(v=>v.trim()).filter(Boolean);
const csvEscape=(v:unknown)=>typeof v==='string'&&(/^\s*[=+\-@]/.test(v)||v.startsWith('~rp~'))?'~rp~'+JSON.stringify(v):v;
function csvUnescape(v:string){
  if(!v.startsWith('~rp~'))return v;
  try{const parsed=JSON.parse(v.slice(4));if(typeof parsed==='string')return parsed;}catch{/* 非本项目转义按错误反馈，避免静默改变文本。 */}
  throw new ApiError('CSV 文本转义无效，请使用下载模板','IMPORT_FORMAT');
}
export async function resourceFingerprint(value:unknown){
  const bytes=new TextEncoder().encode(resourceSignature(value));
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
}
async function workbook(){const Excel=(await import('exceljs')).default;return new Excel.Workbook();}
type FileResource=Station|Device|InterferenceSource|CandidateLink;
function rowValues(kind:ResourceKind,row:FileResource):unknown[]{
  if(kind==='nodes'){const s=row as Station;return [s.id,s.name,s.echelon,s.subtype,s.parentIds.join(';'),s.role,s.mobility,...s.coordinate,s.elevationM,s.region,s.classes.join(';'),s.relayCapable,s.status,s.key,s.remark];}
  if(kind==='devices'){const d=row as Device;return [d.id,d.stationId,d.modelId,d.antennaId,d.antennaHeightM,d.tiltDeg,d.azimuthDeg,d.txPowerDbm,d.workFreqKhz,d.status,d.installedAt,d.availability??'ACTIVE'];}
  if(kind==='topology_links'){
    const c=row as CandidateLink;
    // 待评估只导出当前配置，不把旧参考结果拼接到新端点。
    const assessment=c.assessmentState==='PENDING'?Array(6).fill(null):[c.distanceM,c.pathLossDb,c.rxPowerDbm,c.linkMarginDb,c.isAvailable,c.linkState];
    return [c.id,c.nodeAId,c.nodeBId,c.deviceAId,c.deviceBId,c.deviceClass,c.freqKhz,c.bandwidthKhz,...assessment,c.isBackup];
  }
  const r=row as InterferenceSource;return [r.id,r.name,...r.coordinate,r.elevationM,r.antennaHeightM,r.centerFreqKhz,r.bandwidthKhz,r.txPowerDbm,r.antennaGainDbi,r.interferenceType,r.patternType,r.azimuthDeg,r.dutyCycle,r.active];
}
const headers=(kind:ResourceKind)=>[...resourceHeaders[kind],...(kind==='devices'?['availability']:[])];
const instructions=[
 ['项目','说明'],['编码/单位','UTF-8；WGS84 [lon,lat]；kHz、dBm、m；布尔 true/false；多值用分号'],
 ['导入','按 ID 新增/更新；只读字段必须一致；整批校验通过才保存；空数值保留空值'],
 ['CSV 文本转义','以 = + - @ 开始的文本或以 ~rp~ 开始的文本，导出为 ~rp~ 加 JSON 字符串；导入恢复原文'],
 ['在架状态','availability 为只读列；空值保留当前状态；上下架请使用页面操作'],
 ['日期','安装时间使用带时区 ISO 8601 文本，不使用 Excel 日期或公式'],
];
const candidateInstructions=[
 ['候选数据性质','原 15 列为候选配置及外部参考，不等于正式规划网络或实时评估；页面不计算传播和质量'],
 ['空值','未提供的评估留空；待评估行全部评估字段为空，false 与 0 保留原义'],
 ['引用与保存','接收端需已有两端节点和设备；增量新增/更新，未出现的记录保留；GIS 应用草稿后需统一保存'],
 ['来源参考','单份旧来源参考在详情查看，文件不包含完整历史；再次导入记录本文件和行号'],
 ['原件疑点','原样例中存在型号带宽资料不齐或不一致、FAULT 但可用以及负损耗；保留来源值，不据此推算或纠正'],
];
async function makeFile(format:ResourceFormat,tables:{kind:ResourceKind;rows:unknown[][]}[],name:string,notes:unknown[][]=[]):Promise<ResourceFile>{
  if(format==='csv'){
    const Papa=(await import('papaparse')).default;
    const table=tables[0];
    return {name:name+'.csv',mime:'text/csv;charset=utf-8',bytes:new TextEncoder().encode(Papa.unparse([headers(table.kind),...table.rows.map(r=>r.map(csvEscape))]))};
  }
  const book=await workbook();
  for(const table of tables){const sheet=book.addWorksheet(table.kind);sheet.addRows([headers(table.kind),...table.rows]);sheet.views=[{state:'frozen',ySplit:1}];sheet.getRow(1).font={bold:true};sheet.columns.forEach(c=>{c.width=23;});}
  const commonNotes=tables.length===1&&tables[0].kind==='topology_links'?[instructions[0],instructions[1],instructions[3]]:instructions;
  book.addWorksheet('说明').addRows([...commonNotes,...notes]);
  return {name:name+'.xlsx',mime,bytes:new Uint8Array(await book.xlsx.writeBuffer())};
}
export async function resourceTemplate(format:ResourceFormat,kind:ResourceKind='nodes'):Promise<ResourceFile>{
  if(!['csv','xlsx'].includes(format)||!allResourceKinds.includes(kind))throw new ApiError('模板类型无效','IMPORT_FORMAT');
  if(kind==='topology_links'){
    const source=initialResources(),example=source.candidateLinks?.[0];
    if(!example)throw new ApiError('候选模板来源缺失','IMPORT_FORMAT');
    // 使用已核对端点归属的独立示例，不能复制原模板中错误的设备关联。
    const row:CandidateLink={...structuredClone(example),id:'NEW-LINK-01',distanceM:null,pathLossDb:null,rxPowerDbm:null,linkMarginDb:null,isAvailable:null,linkState:null,assessmentState:'PENDING',reference:null};
    return makeFile(format,[{kind,rows:[rowValues(kind,row)]}],'候选链路模板',candidateInstructions);
  }
  const source=initialResources(),station=structuredClone(source.stations[0]),device=structuredClone(source.devices.find(d=>d.stationId===station.id)!),interference=structuredClone(source.interferences![0]);
  station.id='NEW-STATION-01';station.name='新建固定站示例';station.parentIds=[];station.status='OFFLINE';
  device.id='NEW-DEVICE-01';device.stationId=station.id;device.txPowerDbm=source.models.find(m=>m.id===device.modelId)!.txPowerMaxDbm;device.status='OFFLINE';
  interference.id='NEW-INTERFERENCE-01';interference.name='新建干扰源示例';
  const rows={nodes:station,devices:device,interference_sources:interference};
  return makeFile(format,(format==='csv'?[kind]:resourceKinds).map(k=>({kind:k,rows:[rowValues(k,rows[k])]})),'资源模板-'+(format==='csv'?kind:'全部'));
}
export async function parseResourceImport(request:ResourceImportRequest,current:ResourcesData,source:ResourcesData):Promise<ResourceImportPreview>{
  if(!request.file||!(request.file.bytes instanceof Uint8Array)||request.file.bytes.length>RESOURCE_MAX_FILE_BYTES)throw new ApiError('单文件最多 5 MiB','IMPORT_LIMIT');
  if(!allResourceKinds.includes(request.kind)||!['gis','ledger'].includes(request.context))throw new ApiError('导入类型或上下文无效','IMPORT_FORMAT');
  if(request.kind==='topology_links'&&request.context!=='gis')throw new ApiError('候选链路仅支持 GIS 专用导入','IMPORT_FORMAT');
  if(request.context==='ledger'&&request.draftChanges)throw new ApiError('台账导入不能携带 GIS 草稿','VALIDATION_ERROR');
  // 导入基线来自当前工作区；模板样例不能补入已有资源。
  const base=request.draftChanges?applyChanges(current,request.draftChanges):structuredClone(current);
  const issues:ResourceIssue[]=validateResources(base,current,source).issues;
  const tables:{kind:ResourceKind;headers:string[];rows:{row:number;values:string[]}[]}[]=[];
  let total=0;
  if(/\.csv$/i.test(request.file.name)){
    let decoded:string;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(request.file.bytes);}catch{throw new ApiError('CSV 必须使用 UTF-8 编码','IMPORT_ENCODING');}
    const Papa=(await import('papaparse')).default,parsed=Papa.parse<string[]>(decoded,{skipEmptyLines:false});
    const head=(parsed.data.shift()??[]).map(text);
    const rows=parsed.data.map((values,i)=>({row:i+2,values:values.map(v=>csvUnescape(text(v)))})).filter(r=>r.values.some(v=>v!==''));
    total=rows.length;tables.push({kind:request.kind,headers:head,rows});
    for(const error of parsed.errors)issues.push({objectId:'file',sheet:request.kind,row:(error.row??0)+1,field:'CSV',message:error.message});
  }else if(/\.xlsx$/i.test(request.file.name)){
    const book=await workbook();
    try{await book.xlsx.load(new Uint8Array(request.file.bytes).buffer);}catch{throw new ApiError('XLSX 无法读取，请使用模板','IMPORT_FORMAT');}
    for(const sheet of book.worksheets){
      if(sheet.name==='说明')continue;
      const accepted=request.kind==='topology_links'?['topology_links']:resourceKinds;
      if(!(accepted as readonly string[]).includes(sheet.name))throw new ApiError('未知或不属于当前导入类型的业务工作表：'+sheet.name,'IMPORT_SHEET');
      const kind=sheet.name as ResourceKind;
      if(sheet.state!=='visible'||sheet.rowCount>RESOURCE_MAX_IMPORT_ROWS+1||sheet.columnCount>headers(kind).length)throw new ApiError('工作表隐藏或超过行列限制','IMPORT_LIMIT');
      const table={kind,headers:[] as string[],rows:[] as {row:number;values:string[]}[]};
      sheet.eachRow({includeEmpty:true},(row,index)=>{
        const values:string[]=[];
        for(let c=1;c<=sheet.columnCount;c++){
          const value=row.getCell(c).value;
          if(row.hidden||sheet.getColumn(c).hidden||value!==null&&typeof value==='object'){
            issues.push({objectId:'file',sheet:kind,row:index,field:String(c),message:'不接受隐藏数据、公式、日期对象、富文本或错误单元格'});values.push('');
          }else values.push(text(value));
        }
        if(index===1)table.headers=values;else if(values.some(Boolean)){table.rows.push({row:index,values});total++;}
      });
      tables.push(table);
    }
  }else throw new ApiError('请选择 CSV 或 XLSX；不支持 XLS/宏文件','IMPORT_FORMAT');
  if(!tables.length||total<1||total>RESOURCE_MAX_IMPORT_ROWS)throw new ApiError('每次需导入 1–5000 行业务记录','IMPORT_LIMIT');
  const candidate=structuredClone(base),rows:ResourceImportPreview['rows']=[];
  for(const table of tables){
    const {kind,headers:head}=table,required=resourceHeaders[kind],allowed=headers(kind);
    if(new Set(head).size!==head.length||required.some(k=>!head.includes(k))||head.some(k=>!allowed.includes(k))){issues.push({objectId:'file',sheet:kind,row:1,field:'header',message:'表头缺失、重复或包含未知字段'});continue;}
    const seen=new Set<string>();
    for(const line of table.rows){
      const data=Object.fromEntries(head.map((h,i)=>[h,line.values[i]??'']));
      const id=data[required[0]];
      if(line.values.length!==head.length)issues.push({objectId:id,sheet:kind,row:line.row,field:'row',message:'字段数与表头不一致'});
      if(seen.has(id)){issues.push({objectId:id,sheet:kind,row:line.row,field:'id',message:'同类资源 ID 重复'});continue;}seen.add(id);
      if(kind==='topology_links'&&!candidate.candidateLinks)candidate.candidateLinks=[];
      const collection=candidate[resourceCollections[kind]]! as FileResource[];
      // 基线集合缺失已由上方校验报告，不能补样例或访问缺失集合。
      if(!Array.isArray(collection))continue;
      const old=collection.find(r=>r.id===id);
      const origin=old&&'origin' in old?old.origin??'IMPORT':'IMPORT';
      let value:FileResource;
      if(kind==='nodes')value={
        id,name:data.node_name,echelon:data.echelon,subtype:data.node_subtype,parentIds:list(data.parent_node_id),role:data.node_role,mobility:data.mobility,
        coordinate:[number(data.lon)!,number(data.lat)!],elevationM:number(data.elevation_m,true),region:data.region,classes:list(data.device_class) as Station['classes'],
        relayCapable:bool(data.relay_capable),status:data.status as Station['status'],key:bool(data.is_key),remark:data.remark,alert:(old as Station)?.alert??false,origin,
      };
      else if(kind==='devices')value={
        // 旧模板无维护列，导入不得清空独立保存的模式和端口。
        ...((old as Device)?.currentWorkMode !== undefined ? {currentWorkMode:(old as Device).currentWorkMode}:{}),
        ...((old as Device)?.ports !== undefined ? {ports:structuredClone((old as Device).ports)}:{}),
        id,stationId:data.node_id,modelId:data.model_id,antennaId:data.antenna_id,antennaHeightM:number(data.antenna_height_m),tiltDeg:number(data.tilt_deg,true),
        azimuthDeg:number(data.azimuth_deg,true),txPowerDbm:number(data.tx_power_dbm),workFreqKhz:number(data.work_freq_khz,true),status:data.status as Device['status'],
        installedAt:data.install_time,alert:(old as Device)?.alert??false,origin,
        availability:(data.availability||(old as Device)?.availability||'ACTIVE') as Device['availability'],
      };
      else if(kind==='topology_links')value=externalCandidateLink({
        id,nodeAId:data.node_a_id,nodeBId:data.node_b_id,deviceAId:data.device_a_id,deviceBId:data.device_b_id,deviceClass:data.device_class as CandidateLink['deviceClass'],
        freqKhz:number(data.freq_khz,true),bandwidthKhz:number(data.bandwidth_khz,true),distanceM:number(data.distance_m,true),pathLossDb:number(data.path_loss_db,true),
        rxPowerDbm:number(data.rx_power_dbm,true),linkMarginDb:number(data.link_margin_db,true),isAvailable:nullableBool(data.is_available),
        linkState:(data.link_state||null) as CandidateLink['linkState'],isBackup:nullableBool(data.is_backup),
      },{kind:'IMPORT',file:request.file.name,row:line.row});
      else value={
        id,name:data.name,coordinate:[number(data.lon)!,number(data.lat)!],elevationM:number(data.elevation_m,true),antennaHeightM:number(data.antenna_height_m)!,
        centerFreqKhz:number(data.center_freq_khz)!,bandwidthKhz:number(data.bandwidth_khz)!,txPowerDbm:number(data.tx_power_dbm)!,antennaGainDbi:number(data.antenna_gain_dbi,true),
        interferenceType:data.interference_type,patternType:data.pattern_type||null,azimuthDeg:number(data.azimuth_deg,true),dutyCycle:number(data.duty_cycle,true),active:bool(data.active),origin,
      };
      if(kind==='devices'&&(value as Device).availability!==((old as Device)?.availability??'ACTIVE'))issues.push({objectId:id,sheet:kind,row:line.row,field:'availability',message:'导入不能更改在架状态，请使用上下架操作'});
      if(old)collection[collection.indexOf(old)]=value;else collection.push(value);
      rows.push({sheet:kind,row:line.row,id,action:!old?'NEW':same(old,value)?'UNCHANGED':'UPDATE',differences:Object.entries(value).filter(([key,v])=>!same((old as unknown as Record<string,unknown>)?.[key],v)).map(([field,after])=>({field,before:(old as unknown as Record<string,unknown>)?.[field]??null,after}))});
    }
  }
  const validation=validateResources(candidate,base,source);
  for(const issue of validation.issues){
    const match=rows.find(r=>r.id===issue.objectId&&(!issue.sheet||r.sheet===issue.sheet));
    issues.push({...issue,sheet:issue.sheet??match?.sheet,row:match?.row});
  }
  const warnings=validation.warnings.filter(issue=>issue.sheet!=='topology_links'||rows.some(row=>row.sheet===issue.sheet&&row.id===issue.objectId)).map(issue=>({...issue,row:rows.find(row=>row.id===issue.objectId&&(!issue.sheet||row.sheet===issue.sheet))?.row}));
  return {request:structuredClone(request),rows,issues,warnings,candidate,changes:diffResources(base,candidate),signature:await resourceFingerprint(request)};
}
export function selectResourceExport(resources:ResourcesData,request:ResourceExportRequest,observation?:DeviceStatusSnapshot,links:NetworkLink[]=[]){
  if (request.gis) {
    const scope = request.gis;
    if (request.context !== 'gis' || request.ledger || request.ids || !['all', 'filtered', 'selected'].includes(scope.range)
      || !['devices', 'stations'].includes(scope.browse)) throw new ApiError('GIS 导出范围无效', 'EXPORT_RANGE');
    if (scope.range === 'selected') request = { ...request, ids: { nodes: [], devices: [], interference_sources: [], topology_links: [], ...scope.selectedIds } };
    if (scope.range === 'filtered') {
      const q = scope.filter ?? {}, tree = projectGisTree(resources, links, q.search ?? '', q.alert === 'YES' ? '告警' : q.deviceClass ?? '全部', true,
        scope.browse, { mobility: (q.mobility ?? '') as GisClassification['mobility'], role: (q.nodeRole ?? '') as GisClassification['role'], relay: q.relayCapable === undefined ? '' : q.relayCapable ? 'YES' : 'NO' });
      request = { ...request, ids: { ...gisResourceExportIds(tree, resources), ...gisCandidateExportIds(tree, resources) } };
    }
  }
  if(!['csv','xlsx'].includes(request.format)||!request.kinds.length||new Set(request.kinds).size!==request.kinds.length||request.kinds.some(k=>!allResourceKinds.includes(k))||request.format==='csv'&&request.kinds.length!==1)
    throw new ApiError('请选择有效导出格式和资源类型','EXPORT_FORMAT');
  if(request.kinds.includes('topology_links')&&(request.context!=='gis'||request.kinds.length!==1))throw new ApiError('候选链路仅支持 GIS 专用导出，不能混入其他资源表','EXPORT_FORMAT');
  if(request.ledger){
    const scope=request.ledger;
    if(request.context!=='ledger'||!['all','filtered','selected'].includes(scope.range)||request.ids)throw new ApiError('台账导出范围无效','EXPORT_RANGE');
    if(scope.range!=='all'){
      const rows=projectLedgerRows(resources,d=>observation?deviceStatusDisplay(d,'observed',observation.records[d.id],observation.source.label):undefined);
      const deviceIds=scope.range==='selected'?scope.selectedIds:rows.filter(r=>matchesLedgerQuery(r,scope.filter??{})).map(r=>r.id);
      if(!deviceIds||scope.range==='selected'&&!deviceIds.length)throw new ApiError('请勾选当前页设备','EXPORT_RANGE');
      // 保持台账原有范围语义：筛选／勾选仅针对设备，非设备表为空。
      request={...request,ids:{devices:deviceIds,nodes:[],interference_sources:[]}};
    }
  }
  const selected=new Map<ResourceKind,Set<string>>();
  for(const kind of request.kinds){
    const rows=resources[resourceCollections[kind]]??[],ids=request.ids?.[kind]??rows.map(r=>r.id);
    if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!rows.some(r=>r.id===id)))throw new ApiError('导出范围包含未知或重复 ID','EXPORT_RANGE');
    selected.set(kind,new Set(ids));
  }
  let added=0;
  if(request.format==='xlsx'&&selected.has('nodes')){
    const nodes=selected.get('nodes')!;
    const add=(id:string)=>{if(!nodes.has(id)){nodes.add(id);added++;}};
    if(selected.has('devices'))for(const d of resources.devices)if(selected.get('devices')!.has(d.id))add(d.stationId);
    const visited=new Set<string>();
    const parents=(id:string)=>{if(visited.has(id))return;visited.add(id);for(const p of resources.stations.find(s=>s.id===id)?.parentIds??[]){add(p);parents(p);}};
    [...nodes].forEach(parents);
  }
  return {added,tables:request.kinds.map(kind=>({kind,rows:(resources[resourceCollections[kind]]??[]).filter(r=>selected.get(kind)!.has(r.id)).map(r=>rowValues(kind,r))}))};
}
export async function exportResourceFile(resources:ResourcesData,request:ResourceExportRequest,observation?:DeviceStatusSnapshot,links:NetworkLink[]=[]):Promise<ResourceFile>{
  const {tables,added}=selectResourceExport(resources,request,observation,links);
  return makeFile(request.format,tables,'已保存资源-'+request.kinds.join('-')+'-'+new Date().toISOString().replace(/[:.]/g,'-'),[['导出范围','最后成功保存的数据；不含草稿'],['补齐节点数',added],...(request.kinds.includes('topology_links')?candidateInstructions:[])]);
}
