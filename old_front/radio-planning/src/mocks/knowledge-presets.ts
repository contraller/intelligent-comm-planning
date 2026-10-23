import source from './resources.json';
import legacy from './knowledge.json';
import { upgradeKnowledgeIdentity } from '../services/knowledge-identity';
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
  ['connects','连接'],['measuredBy','测量指标'],['indicates','指示'],['evaluatedAs','评估为'],['followsRule','遵循规则'],
  ['hasSymptom','具有现象'],['causedBy','原因是'],['locatedAt','定位于'],['diagnosedBy','诊断步骤'],['resolvedBy','处置方式'],['affects','影响'],['propagatesTo','传播至'],['requiresTool','所需工具'],['requiresSpare','所需备件'],
].map(([id,name]) => ({id,name}));
export const knowledgeModels = source.models.map(({id,name}) => ({id,name}));
export function knowledgeCatalog(): KnowledgeCatalog {
  return structuredClone({ actors:knowledgeActors, types:knowledgeTypes, relationTypes:knowledgeRelationTypes, models:knowledgeModels, legacy });
}
const time = '2026-10-01T08:00:00+08:00';
const nextTime = '2026-10-02T10:00:00+08:00';
function entity(id: string, name: string, type: string, description: string, models: string[] = []): KnowledgeEntity {
  return {id,name,type,category:knowledgeTypes.find(t => t.id === type)!.category,description,keywords:[],source:'独立教学预设 · 非厂家操作手册',attributes:[],modelIds:models};
}
const entities: KnowledgeEntity[] = [
  entity('KGE-MODEL','短波电台型号知识','DeviceModel','关联指定型号的教学知识目录，不替代厂家资料。',['DM-0001','DM-0002']),
  entity('KGE-POWER','功率放大模块','Component','教学发射通路中的功率放大部件。',['DM-0001','DM-0002']),
  entity('KGE-ANTENNA','短波天线检查','Antenna','检查接口外观与连接状态；由人员按操作规范处理。',['DM-0001']),
  entity('KGE-PRINCIPLE','通信工作原理','Function','教学流程：输入信号 → 信号处理 → 射频传输 → 接收还原。',['DM-0001','DM-0002']),
  entity('KGE-OPERATION','设备操作规范','Function','教学步骤：核对型号与供电 → 查看状态 → 记录异常。',['DM-0001','DM-0002']),
  entity('KGE-PARAMETER','工作频率说明','Parameter','知识参数说明不改变设备实际工作频率。',['DM-0001']),
  entity('KGE-MAINTENANCE','日常维护要求','Function','教学维护：记录温度、检查通风、核查连接；不执行真实控制。',['DM-0001','DM-0002']),
  entity('KGE-NODE','通信节点','Node','网络中的站点知识概念，不是当前资源节点实例。'),
  entity('KGE-LINK','通信链路','Link','端点之间的通信关系知识概念。'),
  entity('KGE-METRIC','链路质量指标','Metric','信噪比、误码率、丢包率、时延、吞吐率的定义。'),
  entity('KGE-RULE','链路状态判定说明','NetRule','由服务输出状态；本页只展示规则说明，不计算或执行表达式。'),
  ...[['EXCELLENT','优秀'],['GOOD','良好'],['WARNING','预警'],['FAULT','故障']].map(([id,name]) => entity('KGE-STATE-'+id,name+'状态','LinkState','链路四级状态中的“'+name+'”；具体门限与判定由正式服务提供。')),
  entity('KGE-SYMPTOM','功放过温现象','Symptom','独立预设现象，不表示设备当前发生该故障。'),
  entity('KGE-CAUSE','通风条件异常','Cause','预设候选原因，需由人员结合设备情况确认。'),
  entity('KGE-STEP','温度与连接检查','DiagnosisStep','依次记录告警、核对通风条件、检查外观连接、记录处理结果。'),
  entity('KGE-SOLUTION','散热检查建议','Solution','核查通风通道与运行环境，按设备规程由维护人员处理。'),
  entity('KGE-TOOL','维护记录工具','Tool','教学记录工具，不对设备下发命令。'),
  entity('KGE-SPARE','教学功放备件','Spare','备件知识示例；实际更换需要厂家规范。'),
];
entities.find(e => e.id === 'KGE-PRINCIPLE')!.keywords = ['原理','射频','工作模式'];
entities.find(e => e.id === 'KGE-PARAMETER')!.attributes = [{name:'频率单位',value:'接口以 kHz 表示，按资料展示',unit:null}];
entities.find(e => e.id === 'KGE-METRIC')!.attributes = [
  {name:'信噪比',value:'信号与噪声的比值',unit:'dB'}, {name:'误码率',value:'错误比特比例',unit:null},
  {name:'丢包率',value:'丢失数据包比例',unit:null}, {name:'时延',value:'端到端时间',unit:'ms'}, {name:'吞吐率',value:'单位时间承载速率',unit:'kbps'},
];
const pairs = [
  ['KGE-MODEL','hasComponent','KGE-POWER'],['KGE-MODEL','hasAntenna','KGE-ANTENNA'],['KGE-MODEL','hasFunction','KGE-PRINCIPLE'],['KGE-MODEL','hasFunction','KGE-OPERATION'],['KGE-MODEL','hasFunction','KGE-MAINTENANCE'],['KGE-MODEL','hasParameter','KGE-PARAMETER'],
  ['KGE-NODE','connects','KGE-LINK'],['KGE-LINK','measuredBy','KGE-METRIC'],['KGE-LINK','followsRule','KGE-RULE'],
  ...['EXCELLENT','GOOD','WARNING','FAULT'].map(s => ['KGE-RULE','evaluatedAs','KGE-STATE-'+s]),
  ['KGE-SYMPTOM','causedBy','KGE-CAUSE'],['KGE-SYMPTOM','locatedAt','KGE-POWER'],['KGE-SYMPTOM','diagnosedBy','KGE-STEP'],['KGE-SYMPTOM','resolvedBy','KGE-SOLUTION'],['KGE-SYMPTOM','affects','KGE-LINK'],['KGE-SOLUTION','requiresTool','KGE-TOOL'],['KGE-SOLUTION','requiresSpare','KGE-SPARE'],
];
const relations: KnowledgeRelation[] = pairs.map(([head,type,tail],i) => ({id:'KGR-'+String(i+1).padStart(3,'0'),head,type,tail,weight:null,source:'独立教学关系预设 · 不参与推理'}));
export const knowledgeRecommendations: Record<string,string[]> = { '发烫':['KGE-SYMPTOM','KGE-SOLUTION'], '没信号':['KGE-LINK','KGE-ANTENNA'], '怎么开机':['KGE-OPERATION'] };

// 两个完整版本具有可检查的发布记录，不把旧 JSON 的版本摘要伪造成历史快照。
export function initialKnowledgeWorkspace(): KnowledgeWorkspace {
  const v1: KnowledgeVersion = {id:'KGV-SEED-1',number:1,parentId:null,restoredFromVersionId:null,kind:'BASELINE',actorId:'KG-REVIEWER',time,summary:'三类知识教学基线',changeId:null,entities:structuredClone(entities),relations:structuredClone(relations)};
  const updated = {...structuredClone(entities.find(e => e.id === 'KGE-MAINTENANCE')!),description:'教学维护：记录温度、检查通风、核查连接；维护完成后复查并记录结果。'};
  const content = {summary:'补充维护后的复查步骤',baseVersionId:v1.id,entities:[updated],relations:[]};
  const published: KnowledgeChange = {id:'KGC-SEED-PUBLISHED',authorId:'KG-EDITOR',state:'PUBLISHED',revision:1,content,createdAt:time,updatedAt:nextTime,publishedVersionId:'KGV-SEED-2',submissions:[{number:1,revision:1,actorId:'KG-EDITOR',time,content:structuredClone(content),outcome:'APPROVED',review:{actorId:'KG-REVIEWER',time:nextTime,opinion:'教学内容已核对'}}]};
  const v2: KnowledgeVersion = {...structuredClone(v1),id:'KGV-SEED-2',number:2,parentId:v1.id,kind:'PUBLISH',time:nextTime,summary:content.summary,changeId:published.id,entities:v1.entities.map(e => e.id === updated.id ? updated : structuredClone(e))};
  const draftContent = {summary:'补充设备操作记录说明',baseVersionId:v2.id,entities:[{...structuredClone(v2.entities.find(e => e.id === 'KGE-OPERATION')!),description:'教学步骤：核对型号与供电 → 查看状态 → 记录异常与操作时间。'}],relations:[]};
  const pendingContent = {summary:'补充天线外观检查来源说明',baseVersionId:v2.id,entities:[{...structuredClone(v2.entities.find(e => e.id === 'KGE-ANTENNA')!),source:'独立教学预设 · 天线检查记录样例'}],relations:[]};
  const draft: KnowledgeChange = {id:'KGC-SEED-DRAFT',authorId:'KG-EDITOR',state:'DRAFT',revision:1,content:draftContent,createdAt:nextTime,updatedAt:nextTime,submissions:[],publishedVersionId:null};
  const pending: KnowledgeChange = {...structuredClone(draft),id:'KGC-SEED-PENDING',state:'PENDING',content:pendingContent,submissions:[{number:1,revision:1,actorId:'KG-EDITOR',time:nextTime,content:structuredClone(pendingContent),outcome:'PENDING',review:null}]};
  return upgradeKnowledgeIdentity({schemaVersion:KNOWLEDGE_SCHEMA_VERSION,presetVersion:KNOWLEDGE_PRESET_VERSION,revision:'knowledge-initial',currentVersionId:v2.id,versions:[v1,v2],changes:[published,draft,pending],receipts:[],logs:[
    {id:'KGL-SEED',actorId:'KG-REVIEWER',action:'PUBLISH',time:nextTime,objectId:published.id,before:'APPROVED',after:'PUBLISHED',versionId:v2.id,opinion:'独立教学发布记录'},
  ]});
}
