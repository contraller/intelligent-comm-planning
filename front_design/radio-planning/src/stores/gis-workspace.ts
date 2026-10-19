import { computed,ref,toRaw,watch } from 'vue';
import { defineStore } from 'pinia';
import { useResourceEditStore } from './resource-edit';
import { usePlanningStore } from './planning';
import { usePreviewStore } from './preview';
import { useAuthStore } from './auth';
import { previewService } from '../services';
import { diffResources,resourceSignature,changesPresent } from '../services/resource-validation';
import type { ResourcesData } from '../types/domain';
import { ApiError } from '../services/types';
import { gisIssues, type GisValidationIssue } from '../services/gis-validation';
import type { PlanningInput } from '../types/planning';

interface EditSnapshot{resources:ResourcesData|null;input:PlanningInput|null;taskId:string|null;baseline:PlanningInput|null;baselineTaskId:string|null}
const clone=<T>(v:T):T=>structuredClone(toRaw(v));
export const useGisWorkspaceStore=defineStore('gis-workspace',()=>{
  const editor=useResourceEditStore(),planning=usePlanningStore(),preview=usePreviewStore(),auth=useAuthStore();
  // 四种地图上下文只有一个所有者，诊断只读快照与资源草稿分别保留。
  const mapMode=ref<'resource'|'analysis'|'monitoring'|'diagnosis'>('resource');
  const active=ref(false),busy=ref(false),undoStack=ref<EditSnapshot[]>([]),redoStack=ref<EditSnapshot[]>([]);
  let restoring=false,last:EditSnapshot|null=null,request:{signature:string;id:string}|null=null,generation=0;
  const taskIssues=ref<GisValidationIssue[]>([]);
  // GIS 联合保存返回任务数组；资源表单仍沿用自己的错误，不混进导入行错误。
  const validationIssues=computed(()=>[
    ...(!editor.importOpen ? gisIssues(editor.issues,'resource') : []), ...taskIssues.value,
  ]);
  watch([()=>planning.taskId,()=>editor.context,()=>auth.generation,()=>preview.data?.resourceMeta.revision],
    ()=>{taskIssues.value=[];},{flush:'sync'});
  editor.$onAction(({name})=>{if(['applyForm','report','clearSession'].includes(name))taskIssues.value=[];});
  const dirty=computed(()=>editor.dirty||planning.dirty||planning.importing);
  const snapshot=():EditSnapshot=>({resources:preview.data?clone(editor.resources):null,input:planning.draft?clone(planning.draft):null,taskId:planning.taskId,baselineTaskId:planning.baselineTaskId,baseline:planning.baseline?clone(planning.baseline):null});
  // 每个应用操作只产生一个联合撤销步骤；异步导入不拆成 ID/内容多个步骤。
  function track(store:typeof editor|typeof planning,names:string[]){
    store.$onAction(({name,after})=>{
      if(!active.value||restoring||busy.value||!names.includes(name))return;
      const before=snapshot(),token=generation;
      after(()=>{
        if(!active.value||restoring||busy.value||token!==generation)return;
        const next=snapshot();
        if(resourceSignature(before)!==resourceSignature(next)){undoStack.value.push(before);redoStack.value=[];}
        last=next;
      });
    });
  }
  track(editor,['applyForm','confirmImport','settleForm','openForm','closeForm','newForm']);
  track(planning,['updateDraft','applyPreset','confirmTaskImport','newTask','openTask']);
  function start(){active.value=true;clearHistory();editor.registerGisSave(save);}
  function stop(){active.value=false;editor.registerGisSave(null);}
  function clearHistory(){undoStack.value=[];redoStack.value=[];last=snapshot();}
  function begin(){mapMode.value='resource';editor.begin('gis');clearHistory();}
  const changes=()=>editor.context==='gis'&&editor.base?diffResources(clone(editor.base),clone(editor.resources)):{stations:[],devices:[]};
  async function save(){
    if(busy.value||editor.busy||planning.busy||planning.importing||!preview.data)return false;
    const token=generation,session=auth.generation;
    taskIssues.value=[];
    try{
      if(editor.importFile||planning.importRequest)throw new Error('请先明确确认或取消文件导入');
      const task=planning.draft&&(planning.needsTaskSave||planning.formDirty)?planning.prepareTask():null;
      const candidate=editor.context==='gis'?editor.candidateWithForm():clone(preview.data.resources);
      const resourceChanges=diffResources(editor.base??preview.data.resources,candidate);
      if(changesPresent(resourceChanges)&&!auth.can('resources.edit')||task&&!auth.can('planning.execute')||!auth.can('situation.view'))throw new Error('缺少本次整体保存所需权限');
      const content={baseResourceRevision:editor.context==='gis'?editor.baseRevision:preview.data.resourceMeta.revision,baseTaskRevision:planning.tasks.revision,changes:resourceChanges,task,context:'gis' as const};
      const signature=resourceSignature(content);if(request?.signature!==signature)request={signature,id:crypto.randomUUID()};
      busy.value=true;preview.busy=true;
      const result=await previewService.commitGisWorkspace({...content,requestId:request.id});
      if(token!==generation||session!==auth.generation)return false;
      preview.acceptResources(result);editor.acceptUnified(result);planning.acceptTaskSave(result);request=null;taskIssues.value=[];
      editor.error='';editor.issues=[];
      editor.message=result.changed?'资源与任务已整体保存到当前浏览器':'没有需要保存的修改';clearHistory();return true;
    }catch(e){if(token===generation&&session===auth.generation){editor.report(e);taskIssues.value=e instanceof ApiError && e.code==='VALIDATION_ERROR' ? gisIssues(e.data,'task') : [];}return false;}finally{if(token===generation){busy.value=false;preview.busy=false;}}
  }
  async function moveHistory(direction:'undo'|'redo'){
    if(busy.value||editor.busy||planning.locked||!(await editor.closeImport())||!(await planning.closeTaskImport())||!(await editor.settleForm()))return;
    if(planning.formDirty){try{planning.prepareTask();}catch(e){editor.report(e);return;}}
    const from=direction==='undo'?undoStack.value:redoStack.value,to=direction==='undo'?redoStack.value:undoStack.value;
    const next=from.at(-1);if(!next)return;
    const current=snapshot();
    if(resourceSignature(next.resources)!==resourceSignature(current.resources)&&!auth.can('resources.edit')||resourceSignature(next.input)!==resourceSignature(current.input)&&!auth.can('planning.execute'))return;
    restoring=true;from.pop();to.push(current);
    if(next.resources)editor.replaceGisDraft(clone(next.resources));
    planning.draft=next.input?clone(next.input):null;planning.taskId=next.taskId;planning.baselineTaskId=next.baselineTaskId;planning.baseline=next.baseline?clone(next.baseline):null;
    last=snapshot();restoring=false;
  }
  async function leave(defer=false,transfer=false){
    if(busy.value||editor.busy||planning.busy||planning.importing)return false;
    if(transfer&&!editor.dirty&&!planning.formDirty&&!planning.importRequest)return true;
    if(!dirty.value)return true;
    const pending=!!editor.importFile||!!planning.importRequest||planning.auxiliaryDirty;
    const choice=await editor.ask({title:'GIS 存在未保存修改',message:pending?'未确认文件不随离开自动提交；可以放弃本次输入或继续编辑。':'保存将包含资源表单、资源草稿和当前任务；失败时全部保留。',
      saveLabel:pending?undefined:'整体保存后继续',discardLabel:'放弃未保存修改',cancelLabel:'继续编辑'});
    if(choice==='cancel'||choice==='save'&&!(await save()))return false;
    if(!defer&&choice==='discard'){editor.clearSession();planning.discardTaskDraft();clearHistory();}
    return true;
  }
  // 分析沿用整体保存决策，成功后继续使用服务读取的已保存数据。
  const prepareAnalysis = () => leave();
  function clearForSession(){taskIssues.value=[];mapMode.value='resource';generation++;stop();busy.value=false;request=null;last=null;undoStack.value=[];redoStack.value=[];}
  return {taskIssues,validationIssues,mapMode,active,busy,dirty,undoStack,redoStack,start,stop,begin,save,changes,moveHistory,leave,prepareAnalysis,clearHistory,clearForSession};
});
