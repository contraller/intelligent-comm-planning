import type { CandidateLink, CandidateLinkConfig, CandidateLinkData, CandidateLinkSource } from '../types/candidate-link';
import type { ResourcesData } from '../types/domain';
import type { ResourceChanges, ResourceIssue } from '../types/resource-edit';

export const candidateConfigFields = ['nodeAId','nodeBId','deviceAId','deviceBId','deviceClass','freqKhz','bandwidthKhz','isBackup'] as const;
export const candidateAssessmentFields = ['distanceM','pathLossDb','rxPowerDbm','linkMarginDb','isAvailable','linkState'] as const;
export const candidateDataFields = ['id',...candidateConfigFields,...candidateAssessmentFields] as const;
const candidateRecordFields=new Set<string>([...candidateDataFields,'assessmentState','source','reference','notices']);
const evaluationInputs = candidateConfigFields.filter(field => field !== 'isBackup');
const finite = (value:unknown):value is number => typeof value === 'number' && Number.isFinite(value);
const idValid = (id:unknown):id is string => typeof id==='string' && id.trim()===id && id.length>0 && id.length<=120 && !/[\u0000-\u001f\u007f]/.test(id);
const presentAssessment = (row:CandidateLinkData) => candidateAssessmentFields.some(field => row[field] !== null);
const equalInputs = (a:CandidateLinkConfig,b:CandidateLinkConfig) => evaluationInputs.every(field => a[field] === b[field]);
export const candidateData = (row:CandidateLinkData):CandidateLinkData => Object.fromEntries(candidateDataFields.map(field => [field,row[field]])) as unknown as CandidateLinkData;
export const emptyCandidateAssessment = () => ({ distanceM:null,pathLossDb:null,rxPowerDbm:null,linkMarginDb:null,isAvailable:null,linkState:null });

// 服务导入只接收文件数值；部分缺失逐项保留，空评估不能升级为参考结果。
export function externalCandidateLink(data:CandidateLinkData,source:CandidateLinkSource):CandidateLink {
  const assessmentState=presentAssessment(data)?'REFERENCE':'PENDING';
  return { ...structuredClone(data), assessmentState, source:structuredClone(source),
    reference:assessmentState==='REFERENCE'?{data:structuredClone(data),source:structuredClone(source)}:null };
}

export function candidateSourceNotes(row:CandidateLink):string[] {
  const notes=Array.isArray(row.notices)?row.notices.filter(note=>typeof note==='string'):[];
  if(row.source?.kind==='SOURCE')notes.push('来源样例／非当前评估；原资料包含故障注入及型号带宽疑点，未按当前台账重新评估。');
  else if(row.assessmentState==='REFERENCE')notes.push('外部参考数据，未取得当前评估结果。');
  if(row.linkState==='FAULT'&&row.isAvailable===true)notes.push('来源中质量为 FAULT，同时可用性为 true；保留原值待核对。');
  if(row.pathLossDb!==null&&row.pathLossDb<0)notes.push('来源传播损耗为负值；保留原值待核对。');
  return [...new Set(notes)];
}

const validSource=(source:CandidateLinkSource|undefined)=>!!source&&typeof source==='object'&&!Array.isArray(source)&&
  Object.keys(source).every(key=>['kind','file','row'].includes(key))&&['SOURCE','IMPORT','MANUAL'].includes(source.kind)&&
  (source.kind==='MANUAL'?source.file===null&&source.row===null:typeof source.file==='string'&&source.file.length>0&&Number.isInteger(source.row)&&source.row!>=2);

export function validateCandidateLinks(rows:CandidateLink[]|undefined,resources:ResourcesData,previousRows:CandidateLink[]=[]){
  const issues:ResourceIssue[]=[],warnings:ResourceIssue[]=[];
  const issue=(objectId:string,field:string,message:string)=>issues.push({sheet:'topology_links',objectId,field,message});
  if(rows===undefined)return {issues,warnings};
  if(!Array.isArray(rows)){issue('candidateLinks','structure','候选集合格式无效');return {issues,warnings};}
  const seen=new Set<string>(),stations=new Set(resources.stations.map(row=>row.id));
  const devices=new Map(resources.devices.map(row=>[row.id,row])),models=new Map(resources.models.map(row=>[row.id,row]));
  const validData=(data:CandidateLinkData,id:string,reference=false)=>{
    const field=(name:string)=>reference?'reference':name;
    if(!data||typeof data!=='object'||Array.isArray(data)){issue(id,'reference','参考记录格式无效');return;}
    // 当前行的完整字段已在外层检查；参考才使用仅含原 15 字段的结构。
    if(reference&&Object.keys(data).some(key=>!candidateDataFields.includes(key as never)))issue(id,field('structure'),'候选记录包含未知字段');
    for(const key of ['id','nodeAId','nodeBId','deviceAId','deviceBId'] as const)if(!idValid(data[key]))issue(id,field(key),'候选或端点 ID 无效');
    if(data.nodeAId===data.nodeBId)issue(id,field('nodeBId'),'两端节点不能相同');
    if(data.deviceAId===data.deviceBId)issue(id,field('deviceBId'),'两端设备不能相同');
    if(!['HF','VUHF'].includes(data.deviceClass))issue(id,field('deviceClass'),'类别须为 HF 或 VUHF');
    for(const key of ['freqKhz','bandwidthKhz'] as const)if(data[key]!==null&&(!finite(data[key])||data[key]!<=0))issue(id,field(key),'须为空或有限正数');
    for(const key of ['distanceM','pathLossDb','rxPowerDbm','linkMarginDb'] as const)if(data[key]!==null&&!finite(data[key]))issue(id,field(key),'评估值须为有限数或空值');
    for(const key of ['isAvailable','isBackup'] as const)if(data[key]!==null&&typeof data[key]!=='boolean')issue(id,field(key),'须为布尔值或空值');
    if(data.linkState!==null&&!['EXCELLENT','GOOD','WARNING','FAULT'].includes(data.linkState))issue(id,field('linkState'),'质量等级无效');
    // 历史参考只校验自身结构，不能按当前端点资料重新认证或覆盖。
    if(reference)return;
    for(const [nodeField,deviceField] of [['nodeAId','deviceAId'],['nodeBId','deviceBId']] as const){
      if(!stations.has(data[nodeField]))issue(id,nodeField,'节点不存在');
      const device=devices.get(data[deviceField]);
      if(!device){issue(id,deviceField,'设备不存在');continue;}
      if(device.stationId!==data[nodeField])issue(id,deviceField,'设备不属于所选节点');
      const model=models.get(device.modelId);
      if(!model||model.deviceClass!==data.deviceClass)issue(id,'deviceClass','两端设备型号类别须与候选类别一致');
      if(data.freqKhz!==null&&finite(data.freqKhz)&&model&&(data.freqKhz<model.freqMinKhz||data.freqKhz>model.freqMaxKhz))issue(id,'freqKhz',`频率须位于端点型号 ${model.freqMinKhz}–${model.freqMaxKhz} kHz 范围内`);
    }
  };
  for(const row of rows){
    if(!row||!idValid(row.id)||seen.has(row.id)){issue(row?.id??'candidateLinks','id','候选 ID 无效或重复');continue;}seen.add(row.id);
    if(Object.keys(row).some(key=>!candidateRecordFields.has(key)))issue(row.id,'structure','候选记录包含未知字段');
    validData(row,row.id);
    if(!validSource(row.source))issue(row.id,'source','候选来源格式无效');
    if(row.notices!==undefined&&(!Array.isArray(row.notices)||!row.notices.every(note=>typeof note==='string')))issue(row.id,'notices','服务提示格式无效');
    if(!['REFERENCE','PENDING'].includes(row.assessmentState))issue(row.id,'assessmentState','候选评估状态无效');
    if(row.reference!==null){
      if(!row.reference||Object.keys(row.reference).some(key=>!['data','source'].includes(key))||!validSource(row.reference.source))issue(row.id,'reference','来源参考格式无效');
      else{validData(row.reference.data,row.id,true);if(row.reference.data?.id!==row.id||!row.reference.data||!presentAssessment(row.reference.data))issue(row.id,'reference','参考 ID 或评估字段无效');}
    }
    if(row.assessmentState==='PENDING'&&presentAssessment(row))issue(row.id,'assessmentState','待评估记录不能带当前评估结果');
    if(row.assessmentState==='REFERENCE'&&(!presentAssessment(row)||!row.reference?.data||candidateAssessmentFields.some(field=>row[field]!==row.reference!.data[field])))issue(row.id,'assessmentState','参考结果须与来源评估字段一致');
    if(row.source?.kind==='MANUAL'&&(row.assessmentState!=='PENDING'||row.reference!==null))issue(row.id,'source','新手工记录不能伪造评估结果');
    for(const message of candidateSourceNotes(row))warnings.push({sheet:'topology_links',objectId:row.id,field:'reference',message});
  }
  if(previousRows.some(row=>!seen.has(row.id)))issue('candidateLinks','id','不允许移除已保存候选');
  return {issues,warnings};
}

// 只有 Mock 保存服务执行业务状态转换；页面 diff/apply 保留旧服务结果和配置草稿。
export function settleCandidateLinks(candidate:ResourcesData,previous:ResourcesData,changes:ResourceChanges):ResourcesData {
  const result=structuredClone(candidate),oldRows=new Map((previous.candidateLinks??[]).map(row=>[row.id,row]));
  const imported=new Set((changes.importedCandidateLinks??[]).map(row=>row.id));
  for(const row of changes.newCandidateLinks??[])if(row.source.kind==='IMPORT')imported.add(row.id);
  const stations=new Set([...changes.stations,...changes.newStations??[]].map(row=>row.id));
  const devices=new Set([...changes.devices,...changes.newDevices??[],...changes.availability??[]].map(row=>row.id));
  for(const row of result.candidateLinks??[]){
    const old=oldRows.get(row.id),changed=!!old&&!equalInputs(row,old);
    const importedCurrent=imported.has(row.id)&&(row.assessmentState==='PENDING'||!!row.reference&&equalInputs(row,row.reference.data));
    const editedAfterImport=imported.has(row.id)&&row.assessmentState==='REFERENCE'&&!importedCurrent;
    if(changed&&!importedCurrent||editedAfterImport||!old&&row.source.kind==='MANUAL'){
      Object.assign(row,emptyCandidateAssessment());row.assessmentState='PENDING';
    }
    if(stations.has(row.nodeAId)||stations.has(row.nodeBId)||devices.has(row.deviceAId)||devices.has(row.deviceBId)){
      row.notices=[...new Set([...(row.notices??[]),'关联站点或设备资料已变化；外部参考未获重新评估。'])];
    }
  }
  return result;
}
