// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from './random-uuid';
import type { TaskServices, GisSaveRequest, TaskSaveResult } from '../types/task';
import type { ResourceStorage } from '../types/resource-edit';
import { RESOURCE_STORAGE_KEY } from '../config/demo';
import { readResources, writeResources, checkRevision } from './resource-storage';
import { initialResources } from '../mocks/resource-presets';
import { createResourceMock } from './resource-mock';
import { resourceFingerprint } from './resource-files';
import { applyChanges, assertValid, resourceIdValid } from './resource-validation';
import { emptyTasks, latestTask, taskConditions, validateTaskInput } from './task-validation';
import { sameValue } from './planning-validation';
import { parseTaskImport, taskTemplate } from './task-files';
import { ApiError } from './types';

// 暂存候选记录只用于校验，最终对真实存储仅执行一次写入。
export function createTaskMock(getStorage:()=>ResourceStorage):TaskServices{
  const source=initialResources(),read=()=>readResources(getStorage(),source);
  async function commit(request:GisSaveRequest):Promise<TaskSaveResult>{
    if(!resourceIdValid(request.requestId)||request.task&&!resourceIdValid(request.task.taskId))throw new ApiError('任务或请求 ID 无效','VALIDATION_ERROR');
    const signature=await resourceFingerprint(request),storage=getStorage(),before=storage.getItem(RESOURCE_STORAGE_KEY),current=read();
    const tasks=structuredClone(current.meta.taskWorkspace??emptyTasks());
    const prior=tasks.receipts.find(r=>r.requestId===request.requestId);
    if(prior){if(prior.signature!==signature)throw new ApiError('同一请求 ID 对应不同内容','IDEMPOTENCY_CONFLICT');return {...current,tasks,task:tasks.tasks.find(t=>t.id===prior.taskId)??null,changed:prior.changed,warnings:[]};}
    checkRevision(request.baseResourceRevision,current.meta.revision);
    if(request.baseTaskRevision!==tasks.revision)throw new ApiError('任务版本已变化，请重新打开后编辑','TASK_REVISION_CONFLICT');
    let staged=before;
    const staging:ResourceStorage={getItem:key=>key===RESOURCE_STORAGE_KEY?staged:storage.getItem(key),setItem:(key,value)=>{if(key!==RESOURCE_STORAGE_KEY)throw new Error('整体保存只允许资源任务记录');staged=value;}};
    const candidate=await createResourceMock(()=>staging).commit({...request.changes,baseRevision:current.meta.revision,context:'gis'});
    let task=request.task?tasks.tasks.find(t=>t.id===request.task!.taskId)??null:null,taskChanged=false;
    if(request.task){
      const input=structuredClone(request.task.input),issues=validateTaskInput(input,candidate.resources);
      if(issues.length)throw new ApiError('任务校验失败，全部修改未保存','VALIDATION_ERROR',issues);
      const last=task?.versions.at(-1);
      taskChanged=!last||!sameValue(input,last.input);
      if(taskChanged){
        const conditionVersion=last&&sameValue(taskConditions(last.input),taskConditions(input))?last.conditionVersion:randomUuid();
        if(!task){
          // 新任务只使用本次保存生成的条件版本。
          task={id:request.task.taskId,versions:[]};tasks.tasks.push(task);
        }
        task.versions.push({id:randomUuid(),number:task.versions.length+1,conditionVersion,savedAt:new Date().toISOString(),input});
        tasks.revision=randomUuid();
      }
    }
    const changed=candidate.changed||taskChanged;
    tasks.receipts.push({requestId:request.requestId,signature,taskId:task?.id??null,changed});
    // 包括仅任务变化在内，都不能覆盖等待期间发生的另一笔写入。
    if(storage.getItem(RESOURCE_STORAGE_KEY)!==before)throw new ApiError('工作区已变化，请重新加载后重试','REVISION_CONFLICT');
    const meta={...candidate.meta,taskWorkspace:tasks};
    writeResources(storage,candidate.resources,meta);
    return {...candidate,meta,tasks,task,changed};
  }
  return{
    async loadTaskWorkspace(){return structuredClone(read().meta.taskWorkspace??emptyTasks());},
    async saveTask(r){return commit({baseResourceRevision:r.baseResourceRevision,baseTaskRevision:r.baseTaskRevision,requestId:r.requestId,context:'gis',changes:{stations:[],devices:[]},task:{taskId:r.taskId,input:r.input}});},
    commitGisWorkspace:commit,
    async getTaskTemplate(format,kind){return taskTemplate(format,kind);},
    async previewTaskImport(request){
      const current=read();checkRevision(request.baseResourceRevision,current.meta.revision);
      if(request.baseTaskRevision!==(current.meta.taskWorkspace??emptyTasks()).revision)throw new ApiError('任务版本已变化','TASK_REVISION_CONFLICT');
      if(request.context!=='gis'&&request.draftChanges)throw new ApiError('规划页导入不能携带资源草稿','VALIDATION_ERROR');
      const candidate=request.draftChanges?applyChanges(current.resources,request.draftChanges):current.resources;
      assertValid(candidate,current.resources,source);
      return parseTaskImport(request,candidate,current.meta.taskWorkspace??emptyTasks());
    },
  };
}
