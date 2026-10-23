import source from './resources.json';
import { knowledgeIdentityReferences, presetKnowledgeIdentity } from '../services/knowledge-identity';
import { knowledgePrincipleFlow } from './knowledge-principles';
import { knowledgeNetworkRule } from './knowledge-network-rules';
import { KNOWLEDGE_PRESET_VERSION, KNOWLEDGE_SCHEMA_VERSION } from '../config/demo';
import type { KnowledgeActor, KnowledgeCatalog, KnowledgeChange, KnowledgeEntity, KnowledgeRelation, KnowledgeVersion, KnowledgeWorkspace } from '../types/knowledge';

export const knowledgeActors: KnowledgeActor[] = [
  { id: 'KG-EDITOR', name: '知识编辑人', role: 'EDITOR' },
  { id: 'KG-REVIEWER', name: '知识审核人', role: 'REVIEWER' },
];
export const knowledgeTypes: KnowledgeCatalog['types'] = [
  ...[['Device','设备'],['DeviceModel','设备型号'],['Component','部件'],['Interface','接口'],['Antenna','天线'],['Function','功能'],['Parameter','参数'],['Manufacturer','厂家']].map(([id,name]) => ({id,name,category:'设备知识' as const})),
  ...[['Node','节点'],['Link','链路'],['Metric','运行指标'],['LinkState','链路状态'],['NetworkRole','网络角色'],['NetRule','组网规则']].map(([id,name]) => ({id,name,category:'网络态势知识' as const})),
  ...[['Fault','故障'],['FaultType','故障类型'],['Symptom','现象'],['Cause','原因'],['DiagnosisStep','诊断步骤'],['Solution','处置方案'],['Tool','工具'],['Spare','备件']].map(([id,name]) => ({id,name,category:'故障运维知识' as const})),
];
export const knowledgeRelationTypes = [
  ['hasComponent','包含部件'],['hasInterface','具有接口'],['hasAntenna','配接天线'],['hasFunction','具有功能'],['hasParameter','具有参数'],['producedBy','生产方'],['supportsMode','支持模式'],['constrainedBy','受约束于'],
  // 定义关系描述规则包含的等级，不表示某条链路同时处于这些状态。
  ['connects','连接'],['measuredBy','测量指标'],['indicates','指示'],['evaluatedAs','评估为'],['followsRule','遵循规则'],['definesState','定义状态等级'],
  ['hasSymptom','具有现象'],['causedBy','原因是'],['locatedAt','定位于'],['diagnosedBy','诊断步骤'],['resolvedBy','处置方式'],['affects','影响'],['propagatesTo','传播至'],['requiresTool','所需工具'],['requiresSpare','所需备件'],
].map(([id,name]) => ({id,name}));
export const knowledgeModels = source.models.map(({id,name}) => ({id,name}));
export function knowledgeCatalog(): KnowledgeCatalog {
  return structuredClone({ actors:knowledgeActors, types:knowledgeTypes, relationTypes:knowledgeRelationTypes, models:knowledgeModels });
}
const time = '2026-10-01T08:00:00+08:00';
const nextTime = '2026-10-02T10:00:00+08:00';
function entity(id: string, name: string, type: string, description: string, models: string[] = []): KnowledgeEntity {
  return {id,name,type,category:knowledgeTypes.find(t => t.id === type)!.category,description,keywords:[],source:'设备与运维知识库',attributes:[],modelIds:models};
}
const entities: KnowledgeEntity[] = [
  entity('KGE-MODEL','短波电台型号知识','DeviceModel','短波电台的基础信息、组成结构、功能及参数资料。',['DM-0001','DM-0002']),
  entity('KGE-POWER','功率放大模块','Component','放大发射通路的射频信号，关注供电、温度与散热条件。',['DM-0001','DM-0002']),
  entity('KGE-ANTENNA','短波天线','Antenna','配接短波电台的天线；检查接口外观与连接状态，由人员按操作规范处理。',['DM-0001']),
  entity('KGE-PRINCIPLE','通信工作原理','Function','输入信号 → 信号处理 → 射频传输 → 接收还原。',['DM-0001','DM-0002']),
  entity('KGE-OPERATION','设备操作规范','Function','核对型号与供电 → 查看状态 → 记录异常。',['DM-0001','DM-0002']),
  entity('KGE-PARAMETER','工作频率说明','Parameter','知识参数说明不改变设备实际工作频率。',['DM-0001']),
  entity('KGE-MAINTENANCE','日常维护要求','Function','记录温度、检查通风、核查连接并登记维护结果。',['DM-0001','DM-0002']),
  entity('KGE-MANUFACTURER','Harris Corporation','Manufacturer','短波电台型号的生产厂家。',['DM-0001','DM-0002']),
  entity('KGE-INTERFACE','射频与业务接口','Interface','射频接口连接天线系统，业务接口接入话音与数据终端。',['DM-0001']),
  entity('KGE-NODE','通信节点','Node','网络中的站点知识概念，不是当前资源节点实例。'),
  entity('KGE-LINK','通信链路','Link','端点之间的通信关系知识概念。'),
  entity('KGE-METRIC','链路质量指标','Metric','信噪比、误码率、丢包率、时延、吞吐率的定义。'),
  entity('KGE-RULE','链路状态判定说明','NetRule','链路质量指标、状态等级与状态变化的关联说明。'),
  ...[['EXCELLENT','优秀'],['GOOD','良好'],['WARNING','预警'],['FAULT','故障']].map(([id,name]) => entity('KGE-STATE-'+id,name+'状态','LinkState','链路四级状态中的“'+name+'”；具体门限与判定由正式服务提供。')),
  entity('KGE-SYMPTOM','功放过温现象','Symptom','功放温度告警，伴随输出能力下降或业务中断。'),
  entity('KGE-CAUSE','通风条件异常','Cause','通风通道受阻或环境散热条件不满足运行要求。'),
  entity('KGE-STEP','温度与连接检查','DiagnosisStep','按发现、分析、根因定位、处置与恢复验证顺序核查，保留每阶段记录。'),
  entity('KGE-SOLUTION','散热检查建议','Solution','核查通风通道与运行环境，按设备规程由维护人员处理。'),
  entity('KGE-TOOL','维护记录工具','Tool','记录告警时间、检查过程、温度变化和通联验证结果。'),
  entity('KGE-SPARE','功放备件','Spare','核对适用型号与备件状态，按维护规程更换并复测。'),
];
entities.find(e => e.id === 'KGE-PRINCIPLE')!.keywords = ['原理','射频','工作模式'];
// 参数为独立 Mock 展示值，不回写资源台账，也不用于真实评估。
entities.find(e => e.id === 'KGE-MODEL')!.attributes = [
  {name:'设备名称',value:'短波电台',unit:null},{name:'型号',value:'AN/PRC-150(C)、RF-7800H-MP',unit:null},
  {name:'类别',value:'HF',unit:null},{name:'厂家',value:'Harris Corporation',unit:null},
];
entities.find(e => e.id === 'KGE-PARAMETER')!.modelIds = ['DM-0001'];
entities.find(e => e.id === 'KGE-PARAMETER')!.attributes = [
  {name:'工作频段',value:'1600–59999.9',unit:'kHz'},{name:'发射功率',value:'43.01',unit:'dBm'},
  {name:'接收灵敏度',value:'-110',unit:'dBm'},{name:'调制方式',value:'LSB、USB、AME、CW、FM',unit:null},
  {name:'信道带宽',value:'3',unit:'kHz'},{name:'天线增益',value:'2.15',unit:'dBi'},
];
entities.find(e => e.id === 'KGE-PRINCIPLE')!.principleFlow = structuredClone(knowledgePrincipleFlow);
entities.find(e => e.id === 'KGE-PRINCIPLE')!.attributes = [
  {name:'功能名称',value:'话音与数据传输',unit:null},{name:'工作模式',value:'ALE、FH、SSB、CW、AM',unit:null},
  {name:'支持业务类型',value:'话音、数据',unit:null},{name:'功能约束条件',value:'频段、工作模式及天线须匹配；收发双方业务配置保持一致。',unit:null},
];
entities.find(e => e.id === 'KGE-INTERFACE')!.attributes = [
  {name:'组成接口',value:'射频、话音、数据、供电',unit:null},{name:'连接要求',value:'核对接口标识、连接牢固度及线缆状态。',unit:null},
];
entities.find(e => e.id === 'KGE-STEP')!.attributes = [
  {name:'1. 故障发现',value:'记录温度告警、发生时间、设备与受影响业务。',unit:null},
  {name:'2. 分析诊断',value:'核对温度趋势、通风通道、供电与外观连接。',unit:null},
  {name:'3. 根因定位',value:'结合检查记录确认散热条件异常，并关联功率放大模块。',unit:null},
  {name:'4. 处置恢复',value:'按维护规程改善通风；必要时使用匹配备件并记录操作。',unit:null},
  {name:'5. 恢复验证',value:'确认告警消除、温度稳定、链路恢复并完成业务通联复测。',unit:null},
];
entities.find(e => e.id === 'KGE-RULE')!.networkRule = structuredClone(knowledgeNetworkRule);
entities.find(e => e.id === 'KGE-METRIC')!.attributes = [
  {name:'信噪比',value:'信号与噪声的比值',unit:'dB'}, {name:'误码率',value:'错误比特比例',unit:null},
  {name:'丢包率',value:'丢失数据包比例',unit:null}, {name:'时延',value:'端到端时间',unit:'ms'}, {name:'吞吐率',value:'单位时间承载速率',unit:'kbps'},
];
const pairs = [
  ['KGE-MODEL','hasComponent','KGE-POWER'],['KGE-MODEL','hasAntenna','KGE-ANTENNA'],['KGE-MODEL','hasFunction','KGE-PRINCIPLE'],['KGE-MODEL','hasFunction','KGE-OPERATION'],['KGE-MODEL','hasFunction','KGE-MAINTENANCE'],['KGE-MODEL','hasParameter','KGE-PARAMETER'],
  ['KGE-MODEL','producedBy','KGE-MANUFACTURER'],['KGE-MODEL','hasInterface','KGE-INTERFACE'],
  ['KGE-NODE','connects','KGE-LINK'],['KGE-LINK','measuredBy','KGE-METRIC'],['KGE-LINK','followsRule','KGE-RULE'],
  ...['EXCELLENT','GOOD','WARNING','FAULT'].map(s => ['KGE-RULE','definesState','KGE-STATE-'+s]),
  ...['EXCELLENT','GOOD','WARNING','FAULT'].map(s => ['KGE-METRIC','indicates','KGE-STATE-'+s]),
  ['KGE-SYMPTOM','causedBy','KGE-CAUSE'],['KGE-SYMPTOM','locatedAt','KGE-POWER'],['KGE-SYMPTOM','diagnosedBy','KGE-STEP'],['KGE-SYMPTOM','resolvedBy','KGE-SOLUTION'],['KGE-SYMPTOM','affects','KGE-LINK'],['KGE-SOLUTION','requiresTool','KGE-TOOL'],['KGE-SOLUTION','requiresSpare','KGE-SPARE'],
];
const relations: KnowledgeRelation[] = pairs.map(([head,type,tail],i) => ({id:'KGR-'+String(i+1).padStart(3,'0'),head,type,tail,weight:null,source:'知识关联资料'}));
export const knowledgeRecommendations: Record<string,string[]> = { '发烫':['KGE-SYMPTOM','KGE-SOLUTION'], '没信号':['KGE-LINK','KGE-ANTENNA'], '怎么开机':['KGE-OPERATION'] };

// 两份新基线均保存完整正文，便于直接核验发布与回滚。
export function initialKnowledgeWorkspace(): KnowledgeWorkspace {
  const v1: KnowledgeVersion = {id:'KGV-SEED-1',number:1,parentId:null,restoredFromVersionId:null,kind:'BASELINE',actorId:'KG-REVIEWER',time,summary:'设备、网络态势与故障运维知识基线',changeId:null,entities:structuredClone(entities),relations:structuredClone(relations)};
  const updated = {...structuredClone(entities.find(e => e.id === 'KGE-MAINTENANCE')!),description:'记录温度、检查通风、核查连接；维护完成后复查并记录结果。'};
  const content = {summary:'补充维护后的复查步骤',baseVersionId:v1.id,entities:[updated],relations:[]};
  const published: KnowledgeChange = {id:'KGC-SEED-PUBLISHED',authorId:'KG-EDITOR',state:'PUBLISHED',revision:1,content,createdAt:time,updatedAt:nextTime,publishedVersionId:'KGV-SEED-2',submissions:[{number:1,revision:1,actorId:'KG-EDITOR',time,content:structuredClone(content),outcome:'APPROVED',review:{actorId:'KG-REVIEWER',time:nextTime,opinion:'知识内容已核对'}}]};
  const v2: KnowledgeVersion = {...structuredClone(v1),id:'KGV-SEED-2',number:2,parentId:v1.id,kind:'PUBLISH',time:nextTime,summary:content.summary,changeId:published.id,entities:v1.entities.map(e => e.id === updated.id ? updated : structuredClone(e))};
  const draftContent = {summary:'补充设备操作记录说明',baseVersionId:v2.id,entities:[{...structuredClone(v2.entities.find(e => e.id === 'KGE-OPERATION')!),description:'核对型号与供电 → 查看状态 → 记录异常与操作时间。'}],relations:[]};
  const pendingContent = {summary:'补充天线外观检查来源说明',baseVersionId:v2.id,entities:[{...structuredClone(v2.entities.find(e => e.id === 'KGE-ANTENNA')!),source:'天线检查记录样例'}],relations:[]};
  const draft: KnowledgeChange = {id:'KGC-SEED-DRAFT',authorId:'KG-EDITOR',state:'DRAFT',revision:1,content:draftContent,createdAt:nextTime,updatedAt:nextTime,submissions:[],publishedVersionId:null};
  const pending: KnowledgeChange = {...structuredClone(draft),id:'KGC-SEED-PENDING',state:'PENDING',content:pendingContent,submissions:[{number:1,revision:1,actorId:'KG-EDITOR',time:nextTime,content:structuredClone(pendingContent),outcome:'PENDING',review:null}]};
  const workspace: KnowledgeWorkspace = {schemaVersion:KNOWLEDGE_SCHEMA_VERSION,presetVersion:KNOWLEDGE_PRESET_VERSION,revision:'knowledge-initial',currentVersionId:v2.id,versions:[v1,v2],changes:[published,draft,pending],receipts:[],logs:[
    {id:'KGL-SEED',actorId:'KG-REVIEWER',action:'PUBLISH',time:nextTime,objectId:published.id,before:'APPROVED',after:'PUBLISHED',versionId:v2.id,opinion:'维护内容审核发布'},
  ]};
  workspace.identitySnapshots = knowledgeIdentityReferences(workspace).map(r => ({...presetKnowledgeIdentity(r.id,r.role),key:r.key}));
  return workspace;
}
