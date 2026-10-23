// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
import { computed, ref, toRaw, watch } from 'vue';
import { defineStore } from 'pinia';
import type { Coordinate, ResourcesData } from '../types/domain';
import type { GisPickTarget } from '../types/gis-pick';
import type { Decision, DecisionRequest, EditForm, ResourceIssue, ResourceImportPreview, ResourceKind } from '../types/resource-edit';
import {
  changesPresent, createNewForm, resourceSignature, resourceResultsChanged,
  applyChanges,
  assertValid,
  createForm,
  diffResources,
  formChanges,
} from '../services/resource-validation';
import type { GisFieldFocus } from '../services/gis-validation';
import { ApiError } from '../services/types';
import { coordinateInBounds } from '../services/resource-geography';
import { usePreviewStore } from './preview';
import { useAuthStore } from './auth';
import { previewService } from '../services';
import type { GisResourceEditContext } from '../types/gis-workspace';
import { useResourceReadStore } from './resource-read';
import { validateGisScene } from '../services/gis-workspace';
import { maintenanceFields, maintenanceEqual } from '../services/device-maintenance';
import type { DeviceRestorePreview } from '../types/device-maintenance';

const clone = (data: ResourcesData) => structuredClone(toRaw(data));

export const useResourceEditStore = defineStore('resource-edit', () => {
  const preview = usePreviewStore(),auth=useAuthStore();
  const baselinePending = ref(false);
  // 本地应用要求资源已加载且有当前权限；失权保留现有草稿。
  const canEdit=computed(()=>!baselinePending.value&&(auth.can('resources.edit')||auth.can('resources.workspace.edit'))&&auth.can('situation.view'));
  // 本 Store 只持有 GIS 完整编辑基线与草稿，台账维护由独立 Store 负责。
  const saved = ref<GisResourceEditContext | null>(null), saving = ref(false);
  const savedMeta = computed(() => saved.value?.resourceMeta);
  function acceptGisContext(value: GisResourceEditContext) { saved.value = structuredClone(toRaw(value)); baselinePending.value=false; }
  // 浏览目录和地图不能认证完整编辑基线；维护入口独立读取完整上下文。
  const context = ref<'gis' | null>(null);
  const base = ref<ResourcesData | null>(null);
  const baseRevision = ref('');
  const draft = ref<ResourcesData | null>(null);
  const undoStack = ref<ResourcesData[]>([]);
  const redoStack = ref<ResourcesData[]>([]);
  const form = ref<EditForm | null>(null);
  const portsEditing=ref(false),restoreMarkers=ref<Record<string,{historyId:string;values:DeviceRestorePreview['values']}>>({});
  const issues = ref<ResourceIssue[]>([]);
  const issueFocus = ref<GisFieldFocus | null>(null);
  let issueSerial=0;
  // 定位请求只属于当前 GIS 表单，关闭、换对象或换身份后不能继续抢焦点。
  watch([()=>form.value?.id,()=>form.value?.kind,()=>context.value,()=>auth.generation],
    ()=>{issueFocus.value=null;},{flush:'sync'});

  const picking=ref(false),importOpen=ref(false),importKind=ref<ResourceKind>('nodes');
  const pickNotice=ref('');
  // 来源提示只属于当前表单坐标；修改、重取点或会话变化后立即清除。
  watch([()=>form.value,()=>form.value?.fields.longitude,()=>form.value?.fields.latitude,
    ()=>context.value,()=>auth.identity?.sessionId,()=>auth.identity?.id],()=>{pickNotice.value='';},{flush:'sync'});
  watch(picking,value=>{if(value)pickNotice.value='';},{flush:'sync'});
  const importFile=ref<{name:string;bytes:Uint8Array}|null>(null),importPreview=ref<ResourceImportPreview|null>(null);
  const importing=ref(false);
  let gisSave:(()=>Promise<boolean>)|null=null;
  function registerGisSave(fn:(()=>Promise<boolean>)|null){gisSave=fn;}
  let generation=0,importSerial=0,importBaseline='',saveSignature='',saveId='';
  const error = ref('');
  const message = ref('');
  const decision = ref<DecisionRequest | null>(null);
  let resolveDecision: ((value: Decision) => void) | null = null;
  // 加载前及会话清理期间仅提供空的读取集合，不回退旧账号资源或演示预设。
  const emptyResources: ResourcesData = { stations: [], devices: [], models: [], antennas: [], source: '', version: '' };
  const resources = computed(() => draft.value ?? saved.value?.resources ?? emptyResources);
  // 新增身份与输入变化分别判断；初始预填值和恢复原值不触发未应用保护。
  const formDirty = computed(
    () => !!form.value && JSON.stringify(form.value.fields) !== JSON.stringify(form.value.initial),
  );
  const draftDirty = computed(() => {
    if (!base.value || !draft.value) return false;
    const changes = diffResources(base.value, draft.value);
    return changesPresent(changes);
  });
  const dirty = computed(() => formDirty.value || draftDirty.value || !!importFile.value);
  // 候选资料草稿不属于正式网络输入；保留旧结果的原资源保护规则。
  const resultsDirty = computed(() =>
    (formDirty.value && form.value?.kind !== 'candidate') ||
    (!!importFile.value && importKind.value !== 'topology_links') ||
    (!!base.value && !!draft.value && resourceResultsChanged(diffResources(base.value, draft.value))),
  );
  // 编辑忙态由当前保存与导入过程维护。
  const busy = computed(() => saving.value || importing.value);

  function ask(request: DecisionRequest): Promise<Decision> {
    if (decision.value || busy.value) return Promise.resolve('cancel');
    decision.value = request;
    return new Promise((resolve) => {
      resolveDecision = resolve;
    });
  }
  function answer(value: Decision) {
    const resolve = resolveDecision;
    decision.value = null;
    resolveDecision = null;
    resolve?.(value);
  }
  function clearFeedback() {
    error.value = '';
    issues.value = [];
    message.value = '';
  }
  function report(reason: unknown) {
    message.value = '';
    error.value = reason instanceof Error ? reason.message : '操作失败，当前输入已保留';
    issues.value =
      reason instanceof ApiError
        ? ((reason.data as { issues?: ResourceIssue[] } | undefined)?.issues ?? [])
        : [];
  }
  function begin() {
    const source = saved.value?.resources;
    if (!canEdit.value || busy.value || !source || context.value) return;
    context.value = 'gis';
    base.value = clone(source);
    baseRevision.value = saved.value!.baseRevision;
    draft.value = clone(base.value);
    undoStack.value = [];
    redoStack.value = [];
    clearFeedback();
  }
  async function prepare() {
    if (context.value) return true;
    if (!saved.value) {
      const read = useResourceReadStore(), revision = read.workspace?.revision;
      if (!revision || read.frozen || !auth.can('situation.view')) { report(new Error('请先读取有效的 GIS 资源版本')); return false; }
      const token = generation, owner = auth.generation;
      saving.value = true;
      try {
        const value = validateGisScene(await previewService.loadGisResourceEditContext({ context: 'gis', revision }), revision);
        if (token !== generation || owner !== auth.generation || read.workspace?.revision !== revision || read.frozen) return false;
        if (!value.validationSource) throw new Error('编辑校验基线未提供');
        acceptGisContext(value);
      } catch (e) { if (token === generation && owner === auth.generation) report(e); return false; }
      finally { if (token === generation) saving.value = false; }
    }
    begin(); return context.value === 'gis';
  }
  function clearSession() {
    portsEditing.value=false;restoreMarkers.value={};
    generation++;
    baselinePending.value=false;
    answer('cancel');
    context.value = null;
    saved.value = null; saving.value = false;
    base.value = null;
    baseRevision.value = '';
    draft.value = null;
    undoStack.value = [];
    redoStack.value = [];
    form.value = null;
    picking.value=false;importOpen.value=false;importFile.value=null;importPreview.value=null;importing.value=false;importSerial++;saveId='';saveSignature='';
    clearFeedback();
  }
  function candidateWithForm() {
    if (!base.value) throw new Error('请先进入编辑模式');
    const source = clone(draft.value ?? base.value);
    const candidate = form.value ? applyChanges(source, formChanges(form.value)) : source;
    assertValid(candidate, clone(base.value), clone(saved.value!.validationSource));
    return candidate;
  }
  function refreshForm() {
    if (form.value) {
      const collection=resources.value[form.value.kind==='station'?'stations':form.value.kind==='device'?'devices':form.value.kind==='candidate'?'candidateLinks':'interferences']??[];
      form.value=collection.some(row=>row.id===form.value!.id)?createForm(resources.value,form.value.kind,form.value.id):null;
    }
  }
  function applyForm(): boolean {
    if (!canEdit.value || busy.value || context.value !== 'gis' || !draft.value) return false;
    try {
      const candidate = candidateWithForm();
      const diff = diffResources(draft.value, candidate);
      if(form.value?.restoreFrom)restoreMarkers.value[form.value.id]={historyId:form.value.restoreFrom,values:Object.fromEntries(maintenanceFields.map(key=>[key,candidate.devices.find(d=>d.id===form.value!.id)?.[key]]))};
      if (changesPresent(diff)) {
        undoStack.value.push(clone(draft.value));
        redoStack.value = [];
        draft.value = candidate;
        clearFeedback();
        message.value = '已应用到 GIS 草稿，尚未保存';
      } else {
        clearFeedback();
        message.value = '没有需要应用的修改';
      }
      refreshForm();
      return true;
    } catch (reason) {
      report(reason);
      return false;
    }
  }
  async function save(): Promise<boolean> {
    if(context.value==='gis'&&gisSave)return gisSave();
    if (!canEdit.value || busy.value || context.value !== 'gis' || !base.value) return false;
    const session=auth.generation,token=generation;
    try {
      // 未应用表单只合入局部候选；提交失败不动草稿、表单或撤销历史。
      const candidate = candidateWithForm();
      const changes=diffResources(base.value,candidate),signature=resourceSignature([baseRevision.value,changes]);
      if(signature!==saveSignature){saveSignature=signature;saveId=randomUuid();}
      const request = { baseRevision: baseRevision.value, ...changes,requestId:changesPresent(changes)?saveId:undefined,context:'gis' as const };
      saving.value = true;
      const result = await previewService.commitResources(request);
      if(session!==auth.generation||token!==generation)return false;
      preview.acceptResources(result); acceptUnified(result);
      base.value = clone(result.resources);
      baseRevision.value = result.meta.revision;
      draft.value = clone(result.resources);
      undoStack.value = [];
      redoStack.value = [];
      refreshForm();
      clearFeedback();
      message.value = result.changed ? '资源已保存到当前浏览器' : '没有需要保存的修改';
      return true;
    } catch (reason) {
      if(session===auth.generation&&token===generation)report(reason);
      return false;
    } finally {
      if (token === generation) saving.value = false;
    }
  }
  async function settleForm(): Promise<boolean> {
    if (busy.value) return false;
    if (!formDirty.value) return true;
    const choice = await ask({
      title: '表单输入尚未应用',
      message: '已应用的 GIS 草稿会保留。请选择如何处理当前输入。',
      saveLabel: '应用并继续',
      discardLabel: '放弃本次输入',
    });
    if (choice === 'cancel') return false;
    if (choice === 'save') return applyForm();
    refreshForm();
    clearFeedback();
    return true;
  }
  async function openForm(kind: EditForm['kind'], id: string, current=()=>true, portEntry=false) {
    const session=auth.generation,token=generation;
    if(kind==='candidate' && !current())return false;
    if (!canEdit.value || (importFile.value && !(await closeImport())) || !(await settleForm())) return false;
    if(kind==='candidate' && (session!==auth.generation || token!==generation || !canEdit.value || !current()))return false;
    if (!(await prepare())) return false;
    try {
      form.value = createForm(resources.value, kind, id);
      portsEditing.value=portEntry;
      clearFeedback();
      return true;
    } catch (reason) {
      report(reason);
      return false;
    }
  }
  async function focusGisIssue(kind: EditForm['kind'], id: string, field: string, current=()=>true) {
    if(!current()||context.value!=='gis'||!canEdit.value||busy.value||importOpen.value||importFile.value)return false;
    const token=generation,session=auth.generation,revision=savedMeta.value?.revision;
    const identity=()=>{
      const rows=resources.value[kind==='station'?'stations':kind==='device'?'devices':kind==='candidate'?'candidateLinks':'interferences']??[];
      const row=rows.find(item=>item.id===id);
      return row ? JSON.stringify([row.id,...(kind==='device'?[('stationId' in row)&&row.stationId,('modelId' in row)&&row.modelId]:[])]) : null;
    };
    if(form.value?.kind!==kind||form.value.id!==id){
      const before=identity();
      if(!before||!(await settleForm()))return false;
      if(!current()||token!==generation||session!==auth.generation||revision!==savedMeta.value?.revision
        ||context.value!=='gis'||!canEdit.value||busy.value||before!==identity())return false;
      // 不调用普通 openForm 清空反馈，保留上次校验清单；不会自动应用新表单。
      form.value=createForm(resources.value,kind,id);
    }
    picking.value=false;
    issueFocus.value={id,field,serial:++issueSerial};
    return true;
  }
  async function closeForm() {
    if (!(await settleForm())) return false;
    form.value = null;picking.value=false;
    portsEditing.value=false;
    return true;
  }
  async function moveHistory(direction: 'undo' | 'redo') {
    if (!canEdit.value || !(await settleForm()) || !draft.value) return;
    const from = direction === 'undo' ? undoStack.value : redoStack.value;
    const to = direction === 'undo' ? redoStack.value : undoStack.value;
    const next = from.pop();
    if (!next) return;
    to.push(clone(draft.value));
    draft.value = clone(next);
    refreshForm();
    clearFeedback();
  }
  async function leave(deferDiscard=false): Promise<boolean> {
    if (busy.value) return false;
    if (importFile.value && !(await closeImport(deferDiscard)))return false;
    if (formDirty.value||draftDirty.value) {
      const choice = await ask({
        title: '存在未保存修改',
        message: '保存将包含当前表单输入；放弃将清除本次未保存修改及草稿历史。',
        saveLabel: '保存并离开',
        discardLabel: '放弃全部修改',
      });
      if (choice === 'cancel' || (choice === 'save' && !(await save()))) return false;
    }
    // 主动退出先确认，再等会话标记写入成功后统一清理。
    if(!deferDiscard)clearSession();
    return true;
  }

  async function newForm(kind:EditForm['kind'],stationId='',current=()=>true) {
    const session=auth.generation,token=generation;
    if(kind==='candidate' && !current())return false;
    if(!canEdit.value||busy.value||!(await closeImport())||!(await settleForm()))return false;
    if(kind==='candidate' && (session!==auth.generation || token!==generation || !canEdit.value || !current()))return false;
    if(!(await prepare()))return false;
    form.value=createNewForm(kind,resources.value,stationId);
    picking.value=kind==='station'||kind==='interference';clearFeedback();return true;
  }
  function pick(coordinate:Coordinate){
    if(!canEdit.value||busy.value||!picking.value||!form.value)return;
    const fields=form.value.fields,keys=['longitude','latitude'] as const;
    const previous=keys.map(key=>fields[key]);
    keys.forEach((key,index)=>{fields[key]=String(coordinate[index]);});
    const rounded=coordinate.map(value=>Number(value.toFixed(6))) as Coordinate;
    const bounds=saved.value?.validationSource?.planningBounds;
    // 不让舍入掩盖越界，也不把精确边界推到范围外。
    const safe=rounded.every((value,index)=>value===coordinate[index])
      ||coordinateInBounds(coordinate,bounds)&&coordinateInBounds(rounded,bounds);
    keys.forEach((key,index)=>{
      if(previous[index]?.trim()&&Number(previous[index])===coordinate[index])fields[key]=previous[index]!;
      else if(safe)fields[key]=coordinate[index]!.toFixed(6);
    });
    picking.value=false;
  }
  function pickGis(coordinate:Coordinate,owner:EditForm,target?:GisPickTarget){
    // 新入口按表单实例核对，旧入口继续保持既有取点行为。
    if(form.value!==owner||context.value!=='gis'||!canEdit.value||busy.value||!picking.value
      ||!['station','interference'].includes(owner.kind)||coordinate.length!==2||!coordinate.every(Number.isFinite)
      ||Math.abs(coordinate[0])>180||Math.abs(coordinate[1])>90)return;
    pick(coordinate);
    // Store 只做字段回填，不引入地图运行时依赖。
    pickNotice.value=target?`已采用${target.kind==='station'?'站点':'干扰源'} ${target.name}（${target.id}）的位置，尚未应用。`:'';
  }
  async function openImport(){
    if(!canEdit.value||busy.value||!(await settleForm()))return;
    form.value=null;picking.value=false;
    if(!(await prepare()))return;
    importOpen.value=true;clearFeedback();
  }
  async function closeImport(defer=false){
    if(!importFile.value){if(!defer)importOpen.value=false;return true;}
    if(busy.value)return false;
    const decision=await ask({title:'导入尚未确认',message:'离开不会自动提交导入，已应用的草稿仍会保留。',discardLabel:'放弃本次导入',cancelLabel:'继续查看'});
    if(decision!=='discard')return false;
    if(!defer){importOpen.value=false;importFile.value=null;importPreview.value=null;importSerial++;}
    return true;
  }
  async function previewImport(file:{name:string;bytes:Uint8Array}){
    if(!canEdit.value||busy.value||context.value!=='gis'||!base.value)return;
    if(draftDirty.value){error.value='请先保存或放弃资源草稿，再预检导入文件';return;}
    const serial=++importSerial,session=auth.generation;
    importFile.value=file;importPreview.value=null;importing.value=true;clearFeedback();
    importBaseline=resourceSignature(resources.value);
    try{
      // 导入绑定已保存资源，提交时后端按原文件重验，不借手工草稿绕过校验。
      const result=await previewService.previewResourceImport({file,kind:importKind.value,baseRevision:baseRevision.value,context:'gis'});
      if(serial===importSerial&&session===auth.generation){importPreview.value=result;issues.value=result.issues;}
    }catch(e){if(serial===importSerial&&session===auth.generation)report(e);}
    finally{if(serial===importSerial)importing.value=false;}
  }
  async function confirmImport(){
    if(!canEdit.value||busy.value||context.value!=='gis'||!importPreview.value||!base.value)return false;
    const view=toRaw(importPreview.value),session=auth.generation,token=generation;
    if(view.issues.length){error.value='请修正全部错误后重新预检';return false;}
    const read = useResourceReadStore();
    if(savedMeta.value?.revision!==baseRevision.value||read.workspace&&(read.stale||read.workspace.revision!==saved.value?.revision)||importBaseline!==resourceSignature(resources.value)){
      error.value='资源或草稿已变化，请重新预检';return false;
    }
    importing.value=true;
    try{
      const key='gis-import:'+view.signature;
      if(saveSignature!==key){saveSignature=key;saveId=randomUuid();}
      const result=await previewService.commitResourceImport({baseRevision:baseRevision.value,requestId:saveId,preview:structuredClone(view)});
      if(session!==auth.generation||token!==generation)return false;
      acceptUnified(result);
      if(result.changed)preview.invalidateResources();
      importOpen.value=false;importFile.value=null;importPreview.value=null;issues.value=[];
      message.value=result.changed?'资源已整批保存':'全部记录无变化';
      let refreshed=false;
      try{refreshed=await read.refresh();}catch{/* 保存成功与页面刷新失败分别报告。 */}
      if(session===auth.generation&&token===generation&&!refreshed)message.value+='；保存成功，列表刷新失败，请刷新资源';
      return true;
    }catch(e){if(session===auth.generation&&token===generation)report(e);return false;}
    finally{if(token===generation)importing.value=false;}
  }
  // 联合保存成功后才移动基线；失败不动当前表单和历史。
  function acceptUnified(result:import('../types/resource-edit').ResourceSaveResult){
    if(context.value!=='gis')return;
    if (saved.value) saved.value = { ...saved.value, revision: result.meta.revision, resources: clone(result.resources),
      validationSource: clone(result.resources), resourceMeta: structuredClone(toRaw(result.meta)), baseRevision: result.meta.revision,
      situation: {...saved.value.situation,snapshotId:result.meta.revision,updatedAt:result.meta.savedAt??saved.value.situation.updatedAt} };
    base.value=clone(result.resources);baseRevision.value=result.meta.revision;draft.value=clone(result.resources);
    undoStack.value=[];redoStack.value=[];refreshForm();clearFeedback();
  }
  // 已保存内容不再标为未保存；服务规范化基线重读前禁止再次编辑提交。
  function acceptReceipt(revision: string, candidate: ResourcesData) {
    restoreMarkers.value={};
    baselinePending.value=true; baseRevision.value=revision;
    base.value=clone(candidate); draft.value=clone(candidate);
    undoStack.value=[]; redoStack.value=[];
    if(form.value)form.value={...form.value,creating:false,initial:{...form.value.fields}};
  }
  function replaceGisDraft(value:ResourcesData){if(context.value==='gis'){draft.value=clone(value);refreshForm();}}
  // 共用原表单所有者，端口输入也受现有离页、失权和会话保护。
  async function openPorts(id:string){return openForm('device',id,()=>true,true);}
  async function applyRestore(id:string,value:DeviceRestorePreview){
    const session=auth.generation,token=generation;
    if(!value.compatible||saved.value?.revision!==value.revision||!await openForm('device',id))return false;
    if(session!==auth.generation||token!==generation||!canEdit.value||form.value?.id!==id||context.value!=='gis'||saved.value?.revision!==value.revision)return false;
    for(const key of maintenanceFields)if(Object.hasOwn(value.values,key))form.value!.fields[key]=key==='ports'?JSON.stringify(value.values.ports):String(value.values[key]??'');
    form.value!.restoreFrom=value.historyId;
    const result=applyForm();if(result){form.value=null;portsEditing.value=false;}return result;
  }
  function restoreSources(candidate:ResourcesData){
    return Object.fromEntries(Object.entries(restoreMarkers.value).filter(([id,marker])=>{
      const row=candidate.devices.find(d=>d.id===id);return row&&maintenanceFields.every(key=>maintenanceEqual(row[key],marker.values[key]));
    }).map(([id,marker])=>[id,marker.historyId]));
  }
  return {
    portsEditing,openPorts,applyRestore,restoreSources,
    saved, savedMeta, saving, acceptGisContext, baselinePending, acceptReceipt,
    issueFocus,focusGisIssue,
    registerGisSave,candidateWithForm,acceptUnified,replaceGisDraft,
    newForm,picking,pick,pickGis,pickNotice,importOpen,importKind,importFile,importPreview,importing,openImport,closeImport,previewImport,confirmImport,
    canEdit,
    context,
    base,
    baseRevision,
    draft,
    undoStack,
    redoStack,
    form,
    issues,
    error,
    message,
    decision,
    resources,
    formDirty,
    draftDirty,
    dirty,
    resultsDirty,
    busy,
    ask,
    answer,
    report,
    begin,
    clearSession,
    applyForm,
    save,
    settleForm,
    openForm,
    closeForm,
    moveHistory,
    leave,
  };
});
