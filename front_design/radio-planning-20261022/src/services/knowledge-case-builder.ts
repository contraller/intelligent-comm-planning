import type { KnowledgeCatalog, KnowledgeEntity, KnowledgeRelation, KnowledgeVersion } from '../types/knowledge';
import type { KnowledgeCaseInput, KnowledgeCaseIssue, KnowledgeCasePreview } from '../types/knowledge-case';
import { KNOWLEDGE_MAX_OPERATIONS } from '../config/demo';
import { randomUuid } from './random-uuid';

export const caseFaultTypes=[{id:'HW_FAILURE',name:'硬件故障'},{id:'LINK_DOWN',name:'链路中断'},{id:'SW_CONFIG',name:'软件配置异常'},{id:'EMI',name:'电磁干扰'}];
export const caseObjectTypes=[{id:'DEVICE',name:'设备'},{id:'NODE',name:'节点'},{id:'LINK',name:'链路'}];
const targets:Record<string,string[]>={HW_FAILURE:['DEVICE','NODE'],LINK_DOWN:['LINK'],SW_CONFIG:['DEVICE','NODE'],EMI:['LINK','NODE']};
const entityKey=(type:string,name:string)=>JSON.stringify([type,name.trim()]);
const relationKey=(head:string,type:string,tail:string)=>JSON.stringify([head,type,tail]);

// 这里只把明确输入映射为现有本体，不执行自由文本推理或自动覆盖已发布知识。
export function buildKnowledgeCases(cases:KnowledgeCaseInput[],base:KnowledgeVersion,catalog:KnowledgeCatalog,createId=()=>randomUuid()):KnowledgeCasePreview{
  const issues:KnowledgeCaseIssue[]=[],entities:KnowledgeEntity[]=[],relations:KnowledgeRelation[]=[];
  const known=new Map(base.entities.map(e=>[entityKey(e.type,e.name),e]));
  const triples=new Set(base.relations.map(r=>relationKey(r.head,r.type,r.tail)));
  const reused=new Set<string>();let skippedRelations=0;
  const ids=new Set([...base.entities,...base.relations].map(e=>e.id));
  const nextId=(prefix:string)=>{const id=prefix+createId();if(ids.has(id))throw new Error('生成的知识编号冲突，请重新预检');ids.add(id);return id;};
  const addIssue=(input:KnowledgeCaseInput,field:string,message:string,location?:{sheet:string;row:number})=>issues.push({sheet:location?.sheet??'知识条目',row:location?.row??input.row??0,field,message});
  const text=(input:KnowledgeCaseInput,field:string,value:string,max=80,required=true,location?:{sheet:string;row:number})=>{if(typeof value!=='string'||required&&!value.trim()||value.length>max){addIssue(input,field,`${field}${required?'不能为空，且':''}最多 ${max} 字符`,location);return false;}return true;};
  const entity=(type:string,name:string,input:KnowledgeCaseInput):string=>{
    name=name.trim();if(!text(input,type,name))return '';
    const key=entityKey(type,name),old=known.get(key);
    if(old){if(base.entities.some(e=>e.id===old.id))reused.add(old.id);return old.id;}
    const definition=catalog.types.find(t=>t.id===type);
    if(!definition){addIssue(input,'类型',`当前知识目录未提供 ${type}，无法构建`);return '';}
    const e:KnowledgeEntity={id:nextId('new:entity:'),name,type,category:definition.category,description:'',keywords:[],attributes:[],modelIds:[],source:input.source.trim()};
    known.set(key,e);entities.push(e);return e.id;
  };
  const relation=(head:string,type:string,tail:string,input:KnowledgeCaseInput)=>{
    if(!head||!tail)return;
    if(!catalog.relationTypes.some(r=>r.id===type)){addIssue(input,'关系',`当前目录不支持 ${type}`);return;}
    const key=relationKey(head,type,tail);if(triples.has(key)){skippedRelations++;return;}
    // 原案例的单值因果不能被一次导入悄悄追加成多个互斥结论。
    if(['instanceOf','occursOn','causedBy','resolvedBy','locatedAt','constrainedBy'].includes(type)&&[...base.relations,...relations].some(r=>r.head===head&&r.type===type&&r.tail!==tail)){addIssue(input,'案例编号',`已有案例的 ${type} 内容不同，请核对案例编号或另建案例`);return;}
    triples.add(key);relations.push({id:nextId('new:relation:'),head,type,tail,weight:null,source:input.source.trim()});
  };
  if(!cases.length)issues.push({sheet:'知识条目',row:0,field:'案例',message:'请至少填写一条案例'});
  const caseIds=new Set<string>();
  for(const input of cases){
    const before=issues.length;
    text(input,'案例编号',input.caseId);text(input,'标题',input.title,80,false);text(input,'知识来源',input.source,200);
    text(input,'原因',input.cause);text(input,'解决方案',input.solution);text(input,'故障部件',input.component,80,false);
    if(caseIds.has(input.caseId.trim()))addIssue(input,'案例编号','案例编号重复，请合并现象和步骤或使用不同编号');caseIds.add(input.caseId.trim());
    if(!targets[input.faultType]?.includes(input.objectType))addIssue(input,'故障类型/适用对象','故障类型与适用对象搭配无效');
    if(!['','HF','VUHF'].includes(input.deviceClass))addIssue(input,'设备类别','设备类别只能为空、HF 或 VUHF');
    if(!input.symptoms.length)addIssue(input,'故障现象','至少填写一个现象');
    const symptomNames=new Set<string>();
    input.symptoms.forEach((s,i)=>{const location={sheet:'故障现象',row:input.symptomRows?.[i]??0};text(input,'故障现象',s,80,true,location);if(symptomNames.has(s.trim()))addIssue(input,'故障现象','同一案例的现象重复',location);symptomNames.add(s.trim());});
    if(!input.steps.length)addIssue(input,'排故步骤','至少填写一步排故步骤');
    const steps=[...input.steps].sort((a,b)=>a.order-b.order);
    steps.forEach((s,i)=>{const location={sheet:'排故步骤',row:s.row??0};if(s.order!==i+1)addIssue(input,'排故步骤','步骤序号须从 1 连续递增且不重复',location);text(input,'步骤内容',s.text,77,true,location);});
    const existingFault=base.entities.find(e=>e.type==='Fault'&&e.name.trim()===input.caseId.trim());
    if(existingFault){
      const oldSteps=base.relations.filter(r=>r.head===existingFault.id&&r.type==='diagnosedBy').map(r=>base.entities.find(e=>e.id===r.tail)?.name.trim()??'').sort();
      const proposedSteps=steps.map(s=>`${String(s.order).padStart(2,'0')}:${s.text.trim()}`).sort();
      // 已有案例的步骤只能完整复用，不能把新的同序号步骤静默追加到原流程。
      if(oldSteps.length&&(oldSteps.length!==proposedSteps.length||oldSteps.some((name,i)=>name!==proposedSteps[i])))addIssue(input,'排故步骤','已有案例的步骤集合不同，请核对编号或通过知识维护另行修改；本批不追加或覆盖步骤',{sheet:'排故步骤',row:steps[0]?.row??0});
    }
    if(issues.length!==before)continue;
    const fault=entity('Fault',input.caseId,input),caseEntity=entity('Case',input.caseId,input);
    const created=entities.find(e=>e.id===caseEntity);if(created)created.description=input.title.trim();
    relation(fault,'recordedIn',caseEntity,input);
    relation(fault,'instanceOf',entity('FaultType',input.faultType,input),input);
    relation(fault,'occursOn',entity('ObjectType',input.objectType,input),input);
    for(const symptom of input.symptoms)relation(fault,'hasSymptom',entity('Symptom',symptom,input),input);
    relation(fault,'causedBy',entity('Cause',input.cause,input),input);
    if(input.component.trim())relation(fault,'locatedAt',entity('Component',input.component,input),input);
    relation(fault,'resolvedBy',entity('Solution',input.solution,input),input);
    for(const step of steps)relation(fault,'diagnosedBy',entity('DiagnosisStep',`${String(step.order).padStart(2,'0')}:${step.text.trim()}`,input),input);
    if(input.deviceClass)relation(fault,'constrainedBy',entity('Parameter',`device_class=${input.deviceClass}`,input),input);
  }
  const count=entities.length+relations.length;
  if(count>KNOWLEDGE_MAX_OPERATIONS)issues.push({sheet:'知识条目',row:0,field:'容量',message:`本批新增 ${entities.length} 实体、${relations.length} 关系，共 ${count}/${KNOWLEDGE_MAX_OPERATIONS} 项，请拆分文件后重试`});
  if(!count&&!issues.length)issues.push({sheet:'知识条目',row:0,field:'变更',message:'全部内容已存在，无可生成的新知识'});
  return {draft:issues.length?null:{baseVersionId:base.id,summary:`结构化构建 ${cases.length} 条故障案例：${cases.map(c=>c.caseId).join('、')}`.slice(0,120),entities,relations},issues,reusedEntities:reused.size,skippedRelations,entityCount:entities.length,relationCount:relations.length,caseCount:cases.length};
}
