// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
import { computed,ref,toRaw,watch } from 'vue';
import { defineStore } from 'pinia';
import { useResourceEditStore } from './resource-edit';
import { usePreviewStore } from './preview';
import { useAuthStore } from './auth';
import { previewService } from '../services';
import { env } from '../config/env';
import { diffResources,resourceSignature,changesPresent } from '../services/resource-validation';
import type { ResourcesData } from '../types/domain';
import { ApiError } from '../services/types';
import { gisIssues } from '../services/gis-validation';
import { useResourceReadStore } from './resource-read';
import { validateGisScene } from '../services/gis-workspace';
import type { GisResourceScene } from '../types/gis-workspace';
import type { LinkDetailContext } from '../types/link-detail';

interface EditSnapshot{resources:ResourcesData|null}
const clone=<T>(v:T):T=>structuredClone(toRaw(v));
export const useGisWorkspaceStore=defineStore('gis-workspace',()=>{
  const editor=useResourceEditStore(),preview=usePreviewStore(),auth=useAuthStore();
  const read = useResourceReadStore();
  const canEditResources = () => !auth.blocked && (env.mode === 'http'
    ? !!auth.identity?.permissions.some(value => String(value) === 'resources.workspace.edit')
    : auth.can('resources.edit'));
  const scene = ref<GisResourceScene | null>(null), sceneLoading = ref(false), sceneError = ref('');
  const linkDetails=ref<LinkDetailContext|null>(null);
  let linkAbort:AbortController|undefined,linkSerial=0;
  async function loadLinkDetails(id:string){
    const serial=++linkSerial;linkAbort?.abort();linkDetails.value=null;
    if(!id||!scene.value||read.frozen)return;
    const revision=scene.value.revision,snapshotId=scene.value.situation.snapshotId,session=auth.generation;
    linkAbort=new AbortController();
    try{
      const value=await previewService.getGisLinkDetails({context:'gis',revision,snapshotId,id,signal:linkAbort.signal});
      if(serial===linkSerial&&session===auth.generation&&revision===scene.value?.revision&&value.snapshotId===snapshotId)linkDetails.value=value;
    }catch(e){if(serial===linkSerial&&session===auth.generation&&!linkAbort.signal.aborted)linkDetails.value={state:'missing',message:e instanceof Error?e.message:'链路读取失败',snapshotId,source:'',records:[]};}
  }
  let sceneSerial = 0, sceneAbort: AbortController | undefined;
  async function loadScene() {
    const revision = read.workspace?.revision;
    if (!revision || !auth.can('situation.view') || read.frozen) return;
    const token = ++sceneSerial, session = auth.generation;
    sceneAbort?.abort(); sceneAbort = new AbortController(); sceneLoading.value = true; sceneError.value = '';
    try {
      const value = validateGisScene(await previewService.loadGisResourceScene({ context: 'gis', revision, signal: sceneAbort.signal }), revision);
      if (token === sceneSerial && session === auth.generation && revision === read.workspace?.revision && !read.frozen) {
        scene.value = value;
        if(editor.baselinePending && editor.context==='gis') {
          const baseline=validateGisScene(await previewService.loadGisResourceEditContext({context:'gis',revision,signal:sceneAbort.signal}),revision);
          if(token===sceneSerial&&session===auth.generation){editor.acceptGisContext(baseline);editor.acceptUnified({resources:baseline.resources,meta:baseline.resourceMeta,changed:false,warnings:[]});}
        }
      }
    } catch (e) {
      if (token === sceneSerial && session === auth.generation) {
        sceneError.value = e instanceof Error ? e.message : 'GIS 展示资料读取失败';
        if (e instanceof ApiError && e.code === 'RESOURCE_VERSION_CHANGED') read.stale = true;
      }
    } finally { if (token === sceneSerial) sceneLoading.value = false; }
  }
  // 保存态版本变化使旧显示资料失效，不能拼接旧目录或冻结网络。
  watch(() => read.workspace?.revision, () => { scene.value = null; if (active.value) void loadScene(); });
  // 四种地图上下文只有一个所有者，诊断只读快照与资源草稿分别保留。
  const mapMode=ref<'resource'|'analysis'|'monitoring'|'diagnosis'>('resource');
  const active=ref(false),busy=ref(false),undoStack=ref<EditSnapshot[]>([]),redoStack=ref<EditSnapshot[]>([]);
  let restoring=false,request:{signature:string;id:string}|null=null,generation=0;
  // 保存反馈由操作结果决定，避免从提示文案推断成功或失败。
  const saveState=ref<'idle'|'saving'|'succeeded'|'validation-failed'|'failed'>('idle');
  watch([()=>editor.resources,()=>editor.form,()=>auth.generation],()=>{
    if(!busy.value)saveState.value='idle';
  },{deep:true,flush:'sync'});
  // GIS 清单只使用本页资源错误，规划任务由规划工作区独立校验。
  const validationIssues=computed(()=>!editor.importOpen ? gisIssues(editor.issues,'resource') : []);
  const dirty=computed(()=>editor.dirty);
  const snapshot=():EditSnapshot=>({resources:editor.base?clone(editor.resources):null});
  // 资源历史独立于任务，撤销不会改写网络规划的编辑现场。
  function track(store:typeof editor,names:string[]){
    store.$onAction(({name,after})=>{
      if(!active.value||restoring||busy.value||!names.includes(name))return;
      const before=snapshot(),token=generation;
      after(()=>{
        if(!active.value||restoring||busy.value||token!==generation)return;
        const next=snapshot();
        if(resourceSignature(before)!==resourceSignature(next)){undoStack.value.push(before);redoStack.value=[];}
      });
    });
  }
  // 恢复内部沿用局部函数应用表单，需按外层恢复动作记录一次资源撤销。
  track(editor,['applyForm','applyRestore','confirmImport','settleForm','openForm','closeForm','newForm']);
  function start(){active.value=true;clearHistory();editor.registerGisSave(save);if (read.workspace && !scene.value) void loadScene();}
  function stop(){active.value=false;editor.registerGisSave(null);sceneSerial++;sceneAbort?.abort();sceneLoading.value=false;linkSerial++;linkAbort?.abort();linkDetails.value=null;}
  function clearHistory(){undoStack.value=[];redoStack.value=[];}
  async function begin(){
    if (busy.value || editor.busy || !canEditResources() || !auth.can('situation.view') || read.frozen) return false;
    if (editor.context === 'gis') { mapMode.value = 'resource'; return true; }
    const revision = read.workspace?.revision, token = generation, session = auth.generation;
    if (!revision) { editor.report(new Error('请先读取资源版本')); return false; }
    busy.value = true; editor.saving = true;
    try {
      const value = validateGisScene(await previewService.loadGisResourceEditContext({ context: 'gis', revision }), revision);
      if (token !== generation || session !== auth.generation || read.workspace?.revision !== revision || read.frozen) return false;
      if (!value.validationSource) throw new Error('编辑校验基线未提供');
      editor.acceptGisContext(value);
    } catch (e) { if (token === generation && session === auth.generation) editor.report(e); return false; }
    finally { if (token === generation) { busy.value = false; editor.saving = false; } }
    saveState.value='idle';mapMode.value='resource';editor.begin();clearHistory();return !!editor.base;
  }
  async function save(){
    if(busy.value||editor.busy||editor.context!=='gis'||!editor.base)return false;
    if(editor.baselinePending){await loadScene();return !editor.baselinePending;}
    const token=generation,session=auth.generation;
    saveState.value='saving';
    try{
      if(editor.importFile)throw new Error('请先明确确认或取消资源文件导入');
      const candidate=editor.candidateWithForm();
      const resourceChanges=diffResources(editor.base,candidate);
      if(changesPresent(resourceChanges)&&!canEditResources()||!auth.can('situation.view'))throw new Error('缺少本次资源保存所需权限');
      const content={baseRevision:editor.baseRevision,...resourceChanges,restoreFrom:editor.restoreSources(candidate),context:'gis' as const};
      const signature=resourceSignature(content);if(request?.signature!==signature)request={signature,id:randomUuid()};
      busy.value=true;editor.saving=true;
      const result=await previewService.saveResourceChanges({...content,requestId:request.id});
      if(token!==generation||session!==auth.generation)return false;
      preview.invalidateResources();editor.acceptReceipt(result.revision,candidate);request=null;
      scene.value = null;
      editor.error='';editor.issues=[];
      editor.message=result.changed?'资源已保存':'没有需要保存的修改';clearHistory();saveState.value='succeeded';
      // 刷新期间可能换号或离页，旧保存不能继续批准新会话的离开决定。
      if (await read.refresh()) await loadScene();
      editor.message=(result.changed?'资源已保存':'没有需要保存的修改')+(editor.baselinePending?'；已保存，编辑基线刷新失败，请刷新资源重试':'');
      return token===generation&&session===auth.generation;
    }catch(e){if(token===generation&&session===auth.generation){editor.report(e);saveState.value=e instanceof ApiError&&e.code==='VALIDATION_ERROR'||editor.issues.length>0?'validation-failed':'failed';}return false;}finally{if(token===generation){busy.value=false;editor.saving=false;}}
  }
  async function moveHistory(direction:'undo'|'redo'){
    if(busy.value||editor.busy||!(await editor.closeImport())||!(await editor.settleForm()))return;
    const from=direction==='undo'?undoStack.value:redoStack.value,to=direction==='undo'?redoStack.value:undoStack.value;
    const next=from.at(-1);if(!next)return;
    const current=snapshot();
    if(resourceSignature(next.resources)!==resourceSignature(current.resources)&&!canEditResources())return;
    restoring=true;from.pop();to.push(current);
    if(next.resources)editor.replaceGisDraft(clone(next.resources));
    restoring=false;
  }
  async function leave(defer=false){
    if(busy.value||editor.busy)return false;
    if(!dirty.value)return true;
    const pending=!!editor.importFile;
    const choice=await editor.ask({title:'GIS 存在未保存资源',message:pending?'未确认资源文件不随离开自动提交；可以放弃本次输入或继续编辑。':'保存将包含资源表单与资源草稿；失败时全部保留。',
      saveLabel:pending?undefined:'保存资源后继续',discardLabel:'放弃未保存资源',cancelLabel:'继续编辑'});
    if(choice==='cancel'||choice==='save'&&!(await save()))return false;
    if(!defer&&choice==='discard'){editor.clearSession();clearHistory();}
    return true;
  }
  // 分析先处理资源草稿，始终读取已经保存的网络和干扰源。
  const prepareAnalysis = () => leave();
  function clearForSession(){saveState.value='idle';mapMode.value='resource';generation++;stop();scene.value=null;sceneError.value='';busy.value=false;request=null;undoStack.value=[];redoStack.value=[];}
  return {scene,sceneLoading,sceneError,loadScene,linkDetails,loadLinkDetails,saveState,validationIssues,mapMode,active,busy,dirty,undoStack,redoStack,start,stop,begin,save,moveHistory,leave,prepareAnalysis,clearHistory,clearForSession};
});
