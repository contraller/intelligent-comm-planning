import type { PlanningInput } from '../types/planning';
import type { ResourcesData } from '../types/domain';
import type { ResourceMeta } from '../types/resource-edit';
import type { TaskWorkspace } from '../types/task';
import { inputSignature, sameValue, validatePlanningInput } from './planning-validation';
import { resourceIdValid } from './resource-validation';
import { ApiError } from './types';
export const emptyTasks=():TaskWorkspace=>({revision:'initial',tasks:[],receipts:[]});
export const taskConditions=(input:PlanningInput)=>inputSignature(input);
export const latestTask=(tasks:TaskWorkspace,id:string)=>tasks.tasks.find(t=>t.id===id)?.versions.at(-1);
export function taskSourceChanged(id:string,_input:PlanningInput,meta:ResourceMeta,conditionVersion?:string){
  const current=meta.taskWorkspace&&latestTask(meta.taskWorkspace,id);
  // 不能核实条件版本的结果不再认作当前有效来源。
  return !conditionVersion||!current||current.conditionVersion!==conditionVersion;
}
export function validateTaskWorkspace(w:TaskWorkspace){
  const fail=()=>{throw new ApiError('任务记录损坏，原记录已保留','TASK_CORRUPT');};
  if(!w||!resourceIdValid(w.revision)||!Array.isArray(w.tasks)||!Array.isArray(w.receipts))return fail();
  const ids=new Set<string>(),versions=new Set<string>();
  for(const task of w.tasks){
    if(!resourceIdValid(task.id)||ids.has(task.id)||!Array.isArray(task.versions)||!task.versions.length)fail();
    ids.add(task.id);
    const conditionVersions=new Set<string>();
    for(const [i,v]of task.versions.entries()){
      if(!resourceIdValid(v.id)||versions.has(v.id)||v.number!==i+1||!resourceIdValid(v.conditionVersion)||v.conditionVersion==='legacy'||!Number.isFinite(Date.parse(v.savedAt))||!v.input||typeof v.input.name!=='string'||!Array.isArray(v.input.demands)||!Array.isArray(v.input.stationIds))fail();
      // 历史任务的引用可以因资源重置失效，读取不删除或重新绑定引用。
      // 历史通视引用只保留当时身份，不因当前台账变化而删除旧任务。
      const losIds=Array.isArray(v.input.deploymentConstraints?.losRequiredNodeIds)?v.input.deploymentConstraints.losRequiredNodeIds:[];
      const shadow={stations:[...new Set([...v.input.stationIds,...losIds])].map(id=>({id})),devices:[
        ...v.input.stationIds.map(id=>({id:'shadow:'+id,stationId:id,availability:'ACTIVE'})),
        ...v.input.demands.flatMap(d=>d?.endpointMode==='device'?[{id:d.sourceDeviceId,stationId:d.sourceId,availability:'ACTIVE'},{id:d.targetDeviceId,stationId:d.targetId,availability:'ACTIVE'}]:[]),
      ],models:[]} as unknown as ResourcesData;
      if(validatePlanningInput(v.input,shadow).length)fail();
      const previous=task.versions[i-1];
      if(previous){
        const same=sameValue(taskConditions(previous.input),taskConditions(v.input));
        if(same?previous.conditionVersion!==v.conditionVersion:conditionVersions.has(v.conditionVersion))fail();
      }
      conditionVersions.add(v.conditionVersion);versions.add(v.id);
    }
  }
  const requests=new Set<string>();
  for(const r of w.receipts){if(!resourceIdValid(r.requestId)||requests.has(r.requestId)||!r.signature||typeof r.changed!=='boolean'||r.taskId!==null&&!ids.has(r.taskId))fail();requests.add(r.requestId);}
}
export { validatePlanningInput as validateTaskInput };
