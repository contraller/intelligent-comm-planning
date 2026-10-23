import { computed, ref, toRaw, watch } from 'vue';
import { defineStore } from 'pinia';
import type { Availability, Coordinate, ResourcesData } from '../types/domain';
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
import { usePreviewStore } from './preview';
import { useAuthStore } from './auth';
import { previewService } from '../services';
import { initialResources } from '../mocks/resource-presets';

const clone = (data: ResourcesData) => structuredClone(toRaw(data));

export const useResourceEditStore = defineStore('resource-edit', () => {
  const preview = usePreviewStore(),auth=useAuthStore();
  // 本地应用要求资源已加载且有当前权限；失权保留现有草稿。
  const canEdit=computed(()=>!!preview.data&&auth.can('resources.edit')&&(context.value!=='gis'||auth.can('situation.view')));
  const context = ref<'gis' | 'ledger' | null>(null);
  const base = ref<ResourcesData | null>(null);
  const baseRevision = ref('');
  const draft = ref<ResourcesData | null>(null);
  const undoStack = ref<ResourcesData[]>([]);
  const redoStack = ref<ResourcesData[]>([]);
  const form = ref<EditForm | null>(null);
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
  let generation=0,importSerial=0,importBaseline='',saveSignature='',saveId='',importId='';
  const error = ref('');
  const message = ref('');
  const decision = ref<DecisionRequest | null>(null);
  let resolveDecision: ((value: Decision) => void) | null = null;
  // 加载前及会话清理期间仅提供空的读取集合，不回退旧账号资源或演示预设。
  const emptyResources: ResourcesData = { stations: [], devices: [], models: [], antennas: [], source: '', version: '' };
  const resources = computed(() => !preview.data ? emptyResources
    : context.value === 'gis' && draft.value ? draft.value : preview.data.resources,
  );
  const formDirty = computed(
    () => !!form.value && (!!form.value.creating || JSON.stringify(form.value.fields) !== JSON.stringify(form.value.initial)),
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
  const busy = computed(() => preview.busy || importing.value);

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
  function begin(mode: 'gis' | 'ledger') {
    if (!canEdit.value || mode==='gis'&&!auth.can('situation.view') || busy.value || !preview.data || context.value) return;
    context.value = mode;
    base.value = clone(preview.data.resources);
    baseRevision.value = preview.data.resourceMeta.revision;
    draft.value = mode === 'gis' ? clone(base.value) : null;
    undoStack.value = [];
    redoStack.value = [];
    clearFeedback();
  }
  function clearSession() {
    generation++;
    answer('cancel');
    context.value = null;
    base.value = null;
    baseRevision.value = '';
    draft.value = null;
    undoStack.value = [];
    redoStack.value = [];
    form.value = null;
    picking.value=false;importOpen.value=false;importFile.value=null;importPreview.value=null;importing.value=false;importSerial++;importId='';saveId='';saveSignature='';
    clearFeedback();
  }
  function candidateWithForm() {
    if (!base.value) throw new Error('请先进入编辑模式');
    const source = clone(draft.value ?? base.value);
    const candidate = form.value ? applyChanges(source, formChanges(form.value)) : source;
    assertValid(candidate, clone(base.value), initialResources());
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
    if (!canEdit.value || busy.value || !base.value) return false;
    const session=auth.generation,token=generation;
    try {
      // 未应用表单只合入局部候选；提交失败不动草稿、表单或撤销历史。
      const candidate = candidateWithForm();
      const changes=diffResources(base.value,candidate),signature=resourceSignature([baseRevision.value,changes]);
      if(signature!==saveSignature){saveSignature=signature;saveId=crypto.randomUUID();}
      const request = { baseRevision: baseRevision.value, ...changes,requestId:changesPresent(changes)?saveId:undefined,context:context.value??'ledger' };
      const result = await preview.commit(request);
      if(session!==auth.generation||token!==generation)return false;
      base.value = clone(result.resources);
      baseRevision.value = result.meta.revision;
      if (context.value === 'gis') draft.value = clone(result.resources);
      undoStack.value = [];
      redoStack.value = [];
      refreshForm();
      clearFeedback();
      message.value = result.changed ? '资源已保存到当前浏览器' : '没有需要保存的修改';
      return true;
    } catch (reason) {
      if(session===auth.generation&&token===generation)report(reason);
      return false;
    }
  }
  async function settleForm(): Promise<boolean> {
    if (busy.value) return false;
    if (!formDirty.value) return true;
    const gis = context.value === 'gis';
    const choice = await ask({
      title: gis ? '表单输入尚未应用' : '设备参数尚未保存',
      message: gis
        ? '已应用的 GIS 草稿会保留。请选择如何处理当前输入。'
        : '保存仅修改当前设备；失败时保留输入。',
      saveLabel: gis ? '应用并继续' : '保存并继续',
      discardLabel: gis ? '放弃本次输入' : '放弃本次修改',
    });
    if (choice === 'cancel') return false;
    if (choice === 'save') return gis ? applyForm() : save();
    refreshForm();
    clearFeedback();
    return true;
  }
  async function openForm(kind: EditForm['kind'], id: string, mode: 'gis' | 'ledger', current=()=>true) {
    if(kind==='candidate' && mode!=='gis')return false;
    const session=auth.generation,token=generation;
    if(kind==='candidate' && !current())return false;
    if (!canEdit.value || (importFile.value && !(await closeImport())) || !(await settleForm())) return false;
    if(kind==='candidate' && (session!==auth.generation || token!==generation || !canEdit.value || !current()))return false;
    if (!context.value) begin(mode);
    if (context.value !== mode) return false;
    try {
      form.value = createForm(resources.value, kind, id);
      clearFeedback();
      return true;
    } catch (reason) {
      report(reason);
      return false;
    }
  }
  async function focusGisIssue(kind: EditForm['kind'], id: string, field: string, current=()=>true) {
    if(!current()||context.value!=='gis'||!canEdit.value||busy.value||importOpen.value||importFile.value)return false;
    const token=generation,session=auth.generation,revision=preview.data!.resourceMeta.revision;
    const identity=()=>{
      const rows=resources.value[kind==='station'?'stations':kind==='device'?'devices':kind==='candidate'?'candidateLinks':'interferences']??[];
      const row=rows.find(item=>item.id===id);
      return row ? JSON.stringify([row.id,...(kind==='device'?[('stationId' in row)&&row.stationId,('modelId' in row)&&row.modelId]:[])]) : null;
    };
    if(form.value?.kind!==kind||form.value.id!==id){
      const before=identity();
      if(!before||!(await settleForm()))return false;
      if(!current()||token!==generation||session!==auth.generation||revision!==preview.data!.resourceMeta.revision
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
    if (context.value === 'ledger') clearSession();
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

  async function newForm(kind:EditForm['kind'],mode:'gis'|'ledger',stationId='',current=()=>true) {
    if(kind==='candidate' && mode!=='gis')return false;
    const session=auth.generation,token=generation;
    if(kind==='candidate' && !current())return false;
    if(!canEdit.value||busy.value||!(await closeImport())||!(await settleForm()))return false;
    if(kind==='candidate' && (session!==auth.generation || token!==generation || !canEdit.value || !current()))return false;
    if(!context.value)begin(mode);
    if(context.value!==mode)return false;
    form.value=createNewForm(kind,resources.value,stationId);
    picking.value=mode==='gis'&&(kind==='station'||kind==='interference');clearFeedback();return true;
  }
  function pick(coordinate:Coordinate){
    if(!canEdit.value||busy.value||!picking.value||!form.value)return;
    form.value.fields.longitude=coordinate[0].toFixed(6);form.value.fields.latitude=coordinate[1].toFixed(6);picking.value=false;
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
  async function openImport(mode:'gis'|'ledger'){
    if(!canEdit.value||busy.value||!(await settleForm()))return;
    form.value=null;picking.value=false;
    if(!context.value)begin(mode);
    if(context.value!==mode)return;
    if(mode==='ledger' && importKind.value==='topology_links')importKind.value='nodes';
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
    if(!canEdit.value||busy.value||!base.value)return;
    const serial=++importSerial,session=auth.generation;
    importFile.value=file;importPreview.value=null;importing.value=true;importId=crypto.randomUUID();clearFeedback();
    importBaseline=resourceSignature(resources.value);
    try{
      const result=await previewService.previewResourceImport({file,kind:importKind.value,baseRevision:baseRevision.value,context:context.value??'ledger',
        ...(context.value==='gis'?{draftChanges:diffResources(base.value,clone(resources.value))}:{})});
      if(serial===importSerial&&session===auth.generation){importPreview.value=result;issues.value=result.issues;}
    }catch(e){if(serial===importSerial&&session===auth.generation)report(e);}
    finally{if(serial===importSerial)importing.value=false;}
  }
  async function confirmImport(){
    if(!canEdit.value||busy.value||!importPreview.value||!base.value)return false;
    const view=toRaw(importPreview.value),session=auth.generation,token=generation;
    if(view.issues.length){error.value='请修正全部错误后重新预检';return false;}
    if(preview.data!.resourceMeta.revision!==baseRevision.value||importBaseline!==resourceSignature(resources.value)){
      error.value='资源或草稿已变化，请重新预检';return false;
    }
    try{
      if(context.value==='gis'){
        const next=applyChanges(clone(resources.value),view.changes);
        assertValid(next,clone(resources.value),initialResources());
        if(changesPresent(diffResources(clone(resources.value),next))){undoStack.value.push(clone(resources.value));redoStack.value=[];draft.value=next;}
        message.value='整批导入已应用到 GIS 草稿，请统一保存';
      }else{
        importing.value=true;
        const result=await previewService.commitResourceImport({baseRevision:baseRevision.value,requestId:importId,preview:structuredClone(view)});
        if(session!==auth.generation||token!==generation)return false;
        preview.acceptResources(result);base.value=clone(result.resources);baseRevision.value=result.meta.revision;
        message.value=result.changed?'资源已整批保存':'全部记录无变化';
      }
      importOpen.value=false;importFile.value=null;importPreview.value=null;issues.value=[];return true;
    }catch(e){if(session===auth.generation&&token===generation)report(e);return false;}
    finally{if(token===generation)importing.value=false;}
  }
  async function setAvailability(ids:string[],availability:Availability){
    if(!canEdit.value||busy.value||!(await closeImport())||!(await closeForm()))return;
    // 仅统计当前已加载且明确到设备 ID 的引用，不从站点名称推断链路用机。
    const references=preview.data!.planning.plans.filter(p=>p.inputSnapshot.devices.some(d=>ids.includes(d.id))).map(p=>p.id);
    const links=preview.data!.situation.links.filter(l=>ids.includes(l.deviceA)||ids.includes(l.deviceB)).map(l=>l.id);
    const chosen=await ask({title:availability==='ACTIVE'?'恢复设备上架':'下架设备',
      message:'本次 '+ids.length+' 台设备。已加载的关联方案 '+references.length+' 个'+(references.length?'（'+references.join('、')+'）':'')+'；态势链路 '+links.length+' 条。保留 ID 与历史；下架后依赖设备的新规划不可提交，恢复后旧方案仍保留来源变更标记。仅站点级引用只提示本站状态。',saveLabel:'确认操作'});
    if(chosen!=='save'||!canEdit.value)return;
    const session=auth.generation,token=generation;
    importing.value=true;
    try{
      const result=await previewService.setDeviceAvailability({baseRevision:preview.data!.resourceMeta.revision,requestId:crypto.randomUUID(),ids,availability});
      if(session!==auth.generation||token!==generation)return;
      preview.acceptResources(result);message.value='变更 '+result.updated.length+' 台，无变化 '+result.unchanged.length+' 台';
    }catch(e){if(session===auth.generation&&token===generation)report(e);}
    finally{if(token===generation)importing.value=false;}
  }
  // 联合保存成功后才移动基线；失败不动当前表单和历史。
  function acceptUnified(result:import('../types/resource-edit').ResourceSaveResult){
    if(context.value!=='gis')return;
    base.value=clone(result.resources);baseRevision.value=result.meta.revision;draft.value=clone(result.resources);
    undoStack.value=[];redoStack.value=[];refreshForm();clearFeedback();
  }
  function replaceGisDraft(value:ResourcesData){if(context.value==='gis'){draft.value=clone(value);refreshForm();}}
  return {
    issueFocus,focusGisIssue,
    registerGisSave,candidateWithForm,acceptUnified,replaceGisDraft,
    newForm,picking,pick,pickGis,pickNotice,importOpen,importKind,importFile,importPreview,importing,openImport,closeImport,previewImport,confirmImport,setAvailability,
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
