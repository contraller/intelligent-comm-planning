import type { PlanningInput,PlanningSubmit } from '../../src/types/planning';
import type { ResourceStorage } from '../../src/types/resource-edit';
import { createMockService } from '../../src/services/mock';
import { readResources } from '../../src/services/resource-storage';
import { initialResources } from '../../src/mocks/resource-presets';
import { sameValue } from '../../src/services/planning-validation';
import { PLANNING_STORAGE_KEY } from '../../src/config/demo';

// 流程夹具明确执行“保存任务”前置步骤；生产提交不自动保存。
export async function saveTaskInput(storage:ResourceStorage,input:PlanningInput,id:string=crypto.randomUUID()){
  const service=createMockService(()=>storage),loaded=readResources(storage,initialResources()),tasks=await service.loadTaskWorkspace();
  const previous=tasks.tasks.find(t=>t.id===id)?.versions.at(-1);
  if(!previous||!sameValue(previous.input,input))await service.saveTask({taskId:id,input:structuredClone(input),baseResourceRevision:loaded.meta.revision,baseTaskRevision:tasks.revision,requestId:crypto.randomUUID()});
  return id;
}
export const taskMeta=(storage:ResourceStorage)=>readResources(storage,initialResources()).meta.taskWorkspace;
export async function savedRequest(storage:ResourceStorage,request:PlanningSubmit):Promise<PlanningSubmit>{
  const prior=JSON.parse(storage.getItem(PLANNING_STORAGE_KEY)??'{"jobs":[]}').jobs?.some((j:{requestId:string})=>j.requestId===request.requestId);
  if(prior)return request;
  const taskId=request.taskId??'test-task:'+request.requestId;
  await saveTaskInput(storage,request.input,taskId);
  return {...request,taskId};
}
