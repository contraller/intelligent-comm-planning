import type { PlanningInput } from '../types/planning';
import type { ResourcesData } from '../types/domain';
import type { ResourceFile } from '../types/resource-edit';
import type { TaskImportRequest, TaskImportPreview, TaskImportIssue, TaskWorkspace } from '../types/task';
import { TASK_MAX_FILE_BYTES, TASK_MAX_DEMANDS } from '../config/demo';
import { planningPresets } from '../mocks/planning-presets';
import { resourceFingerprint } from './resource-files';
import { resourceIdValid } from './resource-validation';
import { validateTaskInput, latestTask } from './task-validation';
import { sameValue } from './planning-validation';
import { ApiError } from './types';
import { deploymentHeaders, deploymentFileValues, readDeploymentFile } from './deployment-constraints';
import { planningOptionHeaders, planningOptionFileValues, readPlanningOptionsFile, planningOptionKeys, planningOptionIssues } from './planning-options';
import { readRoutingFile, routingClearNotes, routingFileValues, routingHeaders, routingIssues } from './planning-routing';

type Kind='task_scenarios'|'task_links';
export const taskHeaders:Record<Kind,string[]>={
  // 部署列是前端补充，旧模板六个必需列及两文件结构保持。
  task_scenarios:[...'task_id,task_name,area_bbox,start_time,duration_h,description,station_ids,preset_id,frequency_id'.split(','),...deploymentHeaders,...planningOptionHeaders],
  task_links:[...'demand_id,task_id,src_node_id,dst_node_id,priority,is_mandatory,data_volume_mb,required_rate_kbps,max_delay_ms,min_reliability,service_type,preferred_class,endpoint_mode,src_device_id,dst_device_id'.split(','),...routingHeaders],
};
const required:Record<Kind,string[]>={task_scenarios:taskHeaders.task_scenarios.slice(0,6),task_links:taskHeaders.task_links.slice(0,12)};
const kinds:Kind[]=['task_scenarios','task_links'];
const value=(v:unknown)=>v==null?'':String(v).trim();
const numeric=(s:string)=>s===''?null:/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)?Number(s):NaN;
const escapeText=(v:unknown)=>typeof v==='string'&&(/^\s*[=+\-@]/.test(v)||v.startsWith('~rp~'))?'~rp~'+JSON.stringify(v):v;
function unescapeText(v:string){if(!v.startsWith('~rp~'))return v;try{const parsed=JSON.parse(v.slice(4));if(typeof parsed==='string')return parsed;}catch{/* 非本项目转义不静默改变文本。 */}throw new ApiError('CSV 文本转义无效','IMPORT_FORMAT');}
export async function taskTemplate(format:'csv'|'xlsx',kind:Kind='task_scenarios',defaults?:PlanningInput):Promise<ResourceFile>{
  if(!['csv','xlsx'].includes(format)||!kinds.includes(kind))throw new ApiError('任务模板格式无效','IMPORT_FORMAT');
  // HTTP 模板由当前接口输入提供真实引用；旧调用继续使用原演示模板。
  const input=defaults??planningPresets[0].input,id=defaults?'TASK-NEW':'TASK-IMPORT-DEMO';
  // 无效草稿不能通过JSON序列化变成貌似合法的空值模板。
  const optionIssues=[...planningOptionIssues(input),...input.demands.flatMap(routingIssues)];
  if(optionIssues.length)throw new ApiError('请先修正频率、部署求解和路由条件再下载模板','VALIDATION_ERROR',optionIssues);
  const rows:Record<Kind,unknown[][]>={
    task_scenarios:[[id,input.name,input.bbox.join(';'),defaults?.startTime??'',defaults?.durationH??'',input.description,input.stationIds.join(';'),input.presetId,input.frequencyId,...deploymentFileValues(input.deploymentConstraints),...planningOptionFileValues(input)]],
    task_links:input.demands.map(d=>[d.id,id,d.sourceId,d.targetId,d.priority,String(d.mandatory),d.dataVolumeMb,d.requiredRateKbps,d.maxDelayMs,d.minReliability,d.service,defaults?d.preferredClass??'':'',defaults?d.endpointMode:'station',defaults?d.sourceDeviceId??'':'',defaults?d.targetDeviceId??'':'',...routingFileValues(d)]),
  };
  if(format==='csv'){const Papa=(await import('papaparse')).default;return {name:kind+'.csv',mime:'text/csv;charset=utf-8',bytes:new TextEncoder().encode(Papa.unparse([taskHeaders[kind],...rows[kind].map(r=>r.map(escapeText))]))};}
  const Excel=(await import('exceljs')).default,book=new Excel.Workbook();
  for(const k of kinds){const sheet=book.addWorksheet(k);sheet.addRows([taskHeaders[k],...rows[k]]);sheet.columns.forEach(c=>c.width=24);sheet.getRow(1).font={bold:true};sheet.views=[{state:'frozen',ySplit:1}];}
  book.addWorksheet('说明').addRows([
    ['项目','规则'],['范围','每次一个任务，校验后仅替换草稿，保存与运行规划分别操作。'],
    ['字段','沿用原任务/通联模板；station_ids/preset_id/frequency_id 和设备端点列为我方扩展。'],
    ['缺省','原模板缺少参与节点列时取需求端点合集；预设/频率列缺少时沿用当前草稿，预览显示。'],
    ['设备','endpoint_mode=station/device；device 必须填写两端设备 ID，且在架、归属正确。'],
    ['路由条件','strategy、need_backup为我方可选扩展列；策略为SHORTEST_PATH/MIN_DELAY/MAX_RELIABILITY，备份为true/false；缺列或空白表示未指定，不继承当前草稿。'],
    ['时间/单位','时间为含时区 ISO 8601 文本，持续时长为小时；坐标 WGS84，速率 kbps、时延 ms。'],
    ['空值','start_time、duration_h、data_volume_mb、service_type、preferred_class 可空，不把空转为 0。'],
    ['CSV','UTF-8；两个 CSV 同批选择。前导 = + - @ 或 ~rp~ 文本用 ~rp~ 加 JSON 字符串可逆转义。'],
    ['部署约束','十个可选部署列；地物/通视ID以分号分隔，强制点及Polygon为JSON。全部空/缺列表示未设置，不沿用当前草稿。'],
    ['部署空值','普通数值/地物留空为未指定；海拔上下界成组，强制点/禁区空白为无项目。约束变化随任务保存，前端不计算通视或筛选结果。'],
    ['频率条件','HF/VUHF各有上下界kHz及分号排除ID列；每类范围成组。六列全空/缺省将清空额外过滤，不继承当前草稿。'],
    ['部署求解','deployment_solve_json 示例：{"mode":"MIN_COUNT","fixedCount":null,"solutionCount":2}；FIXED_COUNT允许0，表示不新增部署；空/缺列清空该条件。'],
  ]);
  return {name:'任务导入模板.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',bytes:new Uint8Array(await book.xlsx.writeBuffer())};
}
export async function parseTaskImport(request:TaskImportRequest,resources:ResourcesData,tasks:TaskWorkspace):Promise<TaskImportPreview>{
  const {sourceRows: _sourceRows, taskRow: _taskRow, ...preview}=await parseTaskFileInput(request,resources,tasks);
  return preview;
}
// HTTP 预检需要实际行号；旧 Mock 对外返回结构保持原样。
export async function parseTaskFileInput(request:TaskImportRequest,resources?:ResourcesData,tasks?:TaskWorkspace):Promise<TaskImportPreview & {sourceRows:Record<string,number>;taskRow:number} >{
  if(!Array.isArray(request.files)||!request.files.length||request.files.length>2||request.files.some(f=>!f||!(f.bytes instanceof Uint8Array)||!f.bytes.length||f.bytes.length>TASK_MAX_FILE_BYTES))throw new ApiError('请选择一个 XLSX 或配套两个 CSV，单文件最多 5 MiB','IMPORT_LIMIT');
  const tables=new Map<Kind,{headers:string[];rows:{row:number;values:string[]}[]}>();
  const issues:TaskImportIssue[]=[],notes:string[]=[];
  const add=(sheet:string,row:number,field:string,message:string)=>issues.push({sheet,row,field,objectId:sheet,message});
  const addTable=(k:Kind,headers:string[],rows:{row:number;values:string[]}[])=>{
    if(tables.has(k))throw new ApiError('工作表重复：'+k,'IMPORT_FORMAT');tables.set(k,{headers,rows});
    if(headers.some(h=>!taskHeaders[k].includes(h))||new Set(headers).size!==headers.length||required[k].some(h=>!headers.includes(h)))add(k,1,'header','表头缺失、未知或重复，请使用模板');
    for(const r of rows)if(r.values.length>headers.length)add(k,r.row,'columns','数据列多于表头');
  };
  if(request.files.length===1&&/\.xlsx$/i.test(request.files[0].name)){
    const Excel=(await import('exceljs')).default,book=new Excel.Workbook();
    try{await book.xlsx.load(new Uint8Array(request.files[0].bytes).buffer);}catch{throw new ApiError('XLSX 无法读取','IMPORT_FORMAT');}
    for(const sheet of book.worksheets){
      if(sheet.name==='说明')continue;
      if(!kinds.includes(sheet.name as Kind)||sheet.state!=='visible')throw new ApiError('未知或隐藏业务表：'+sheet.name,'IMPORT_FORMAT');
      const k=sheet.name as Kind;
      if(sheet.rowCount>TASK_MAX_DEMANDS+1||sheet.columnCount>taskHeaders[k].length)throw new ApiError('行列超出任务模板限制','IMPORT_LIMIT');
      let headers:string[]=[];const rows:{row:number;values:string[]}[]=[];
      sheet.eachRow({includeEmpty:true},(row,index)=>{
        const values:string[]=[];
        if(row.hidden)add(k,index,'row','不支持隐藏数据行');
        for(let col=1;col<=sheet.columnCount;col++){
          if(sheet.getColumn(col).hidden)add(k,index,'column','不支持隐藏业务列');
          const raw=row.getCell(col).value;
          if(raw!==null&&!['string','number','boolean'].includes(typeof raw))add(k,index,String(col),'只支持文本、数值和布尔，不支持日期对象、公式或错误单元格');
          values.push(value(raw));
        }
        if(index===1){headers=values;return;}if(values.some(v=>v!==''))rows.push({row:index,values});
      });
      addTable(k,headers,rows);
    }
  }else{
    if(request.files.length!==2||request.files.some(f=>!/\.csv$/i.test(f.name)))throw new ApiError('CSV 需同时选择任务信息和通联需求两个文件','IMPORT_FORMAT');
    const Papa=(await import('papaparse')).default;
    for(const file of request.files){
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);}catch{throw new ApiError('CSV 必须是 UTF-8 编码','IMPORT_ENCODING');}
      const parsed=Papa.parse<string[]>(text,{skipEmptyLines:false}),headers=(parsed.data.shift()??[]).map(value);
      const k:Kind=headers.includes('demand_id')?'task_links':'task_scenarios';
      for(const error of parsed.errors)add(k,(error.row??0)+1,'CSV',error.message);
      addTable(k,headers,parsed.data.map((v,i)=>({row:i+2,values:v.map(x=>unescapeText(value(x)))})).filter(r=>r.values.some(v=>v!=='')));
    }
  }
  const scene=tables.get('task_scenarios'),links=tables.get('task_links');
  if(!scene||!links)throw new ApiError('必须同时包含 task_scenarios 和 task_links','IMPORT_FORMAT');
  if(scene.rows.length!==1)add('task_scenarios',2,'task_id','每次必须且只能导入一个任务');
  if(!links.rows.length||links.rows.length>TASK_MAX_DEMANDS)add('task_links',2,'rows','通联需求需为 1–'+TASK_MAX_DEMANDS+' 条');
  const rowObject=(headers:string[],values:string[])=>Object.fromEntries(headers.map((h,i)=>[h,values[i]??'']));
  const row=rowObject(scene.headers,scene.rows[0]?.values??[]),id=row.task_id??'';
  if(!resourceIdValid(id))add('task_scenarios',2,'task_id','任务 ID 无效');
  const input:PlanningInput={...structuredClone(request.input),name:row.task_name??'',description:row.description??'',bbox:(row.area_bbox??'').split(';').map(v=>numeric(v)??NaN),startTime:row.start_time||null,durationH:numeric(row.duration_h??''),demands:[]};
  // 完整任务导入不能从另一任务暗中继承部署条件，预览会显示清空差异。
  delete input.deploymentConstraints;
  const deployment=readDeploymentFile(row,(field,message)=>add('task_scenarios',scene.rows[0]?.row??2,field,message));
  if(deployment!==undefined)input.deploymentConstraints=deployment;
  // 新条件同样按完整导入替换；不能继承目标草稿中未出现在文件的字段。
  for(const key of planningOptionKeys)delete input[key];
  Object.assign(input,readPlanningOptionsFile(row,(field,message)=>add('task_scenarios',scene.rows[0]?.row??2,field,message)));
  if(row.preset_id)input.presetId=row.preset_id;else notes.push('未提供 preset_id，沿用当前'+(resources?'演示档位':'参数预设')+'：'+input.presetId);
  if(row.frequency_id)input.frequencyId=row.frequency_id;else notes.push('未提供 frequency_id，沿用当前频率资源：'+input.frequencyId);
  for(const r of links.rows){
    const d=rowObject(links.headers,r.values);
    if(d.task_id!==id)add('task_links',r.row,'task_id','需求必须属于本次唯一任务');
    input.demands.push({...readRoutingFile(d,(field,message)=>add('task_links',r.row,field,message)),id:d.demand_id??'',sourceId:d.src_node_id??'',targetId:d.dst_node_id??'',priority:d.priority as 'P1',mandatory:(d.is_mandatory==='true'?true:d.is_mandatory==='false'?false:d.is_mandatory) as boolean,
      dataVolumeMb:numeric(d.data_volume_mb??''),requiredRateKbps:numeric(d.required_rate_kbps??''),maxDelayMs:numeric(d.max_delay_ms??''),minReliability:numeric(d.min_reliability??''),service:(d.service_type??'') as '话音',preferredClass:(d.preferred_class||null) as 'HF'|null,
      endpointMode:(d.endpoint_mode||((d.src_device_id||d.dst_device_id)?'device':'station')) as 'station',sourceDeviceId:d.src_device_id||null,targetDeviceId:d.dst_device_id||null});
  }
  input.stationIds=row.station_ids?row.station_ids.split(';').map(value):[...new Set(input.demands.flatMap(d=>[d.sourceId,d.targetId]))];
  if(!row.station_ids)notes.push('参与节点由通联需求两端 ID 合并得到；没有额外补入当前草稿节点。');
  // 文件解析可独立复用；HTTP 引用与业务规则随后交由服务端校验。
  for(const issue of resources?validateTaskInput(input,resources):[]){
    const index=input.demands.findIndex(d=>d.id===issue.objectId);
    issues.push({...issue,sheet:index<0?'task_scenarios':'task_links',row:index<0?(scene.rows[0]?.row??2):links.rows[index].row});
  }
  const before=(tasks?latestTask(tasks,id)?.input:undefined)??request.input;
  notes.push(...routingClearNotes(before,input));
  const compareKeys=[...new Set([...Object.keys(input),...['deploymentConstraints',...planningOptionKeys].filter(key=>Object.hasOwn(before,key))])];
  if(before.deploymentConstraints&&input.deploymentConstraints===undefined)notes.push('文件未设置部署条件，确认应用后将清空原部署条件；尚未保存。');
  for(const key of planningOptionKeys)if(before[key]&&input[key]===undefined)notes.push('文件未设置'+(key==='frequencyConstraints'?'频率过滤':'部署求解')+'，确认应用后将清空原设置；尚未保存。');
  const differences=compareKeys.filter(k=>!sameValue(input[k as keyof PlanningInput],before[k as keyof PlanningInput])).map(k=>({field:k,before:before[k as keyof PlanningInput],after:input[k as keyof PlanningInput]}));
  // 内部保存任务实际行号，供HTTP部署条件错误定位；对外预览剔除此元数据。
  return {taskId:id,input:issues.length?null:input,issues,signature:await resourceFingerprint(request),existing:tasks?.tasks.some(t=>t.id===id)??false,differences,notes,taskRow:scene.rows[0]?.row??2,sourceRows:Object.fromEntries(input.demands.map((d,i)=>[d.id,links.rows[i].row]))};
}
