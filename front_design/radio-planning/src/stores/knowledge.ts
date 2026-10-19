import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { useAuthStore } from './auth';
import { knowledgeClone, knowledgeDiff, knowledgeEqual, knowledgeSignature } from '../services/knowledge-validation';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import type { KnowledgeCatalog, KnowledgeCategory, KnowledgeChange, KnowledgeDetail, KnowledgeDraft, KnowledgeEntity, KnowledgeGraph, KnowledgeIssue, KnowledgeMutation, KnowledgeMutationResult, KnowledgeRelation, KnowledgeSearch, KnowledgeVersion, KnowledgeWorkspace } from '../types/knowledge';

export const useKnowledgeStore = defineStore('knowledge',() => {
  const auth=useAuthStore();
  const workspace = ref<KnowledgeWorkspace | null>(null);
  const catalog = ref<KnowledgeCatalog>({actors:[],types:[],relationTypes:[],models:[],legacy:{entities:[],relations:[],versions:[]}});
  const actorId = computed(()=>auth.identity?.id??''), loading = ref(false), busy = ref(false), loadError = ref(''), error = ref(''), notice = ref('');
  const draft = ref<KnowledgeDraft | null>(null), baseline = ref<KnowledgeDraft | null>(null), changeId = ref(''), drawerOpen = ref(false), opinion = ref('');
  const issues = ref<KnowledgeIssue[]>([]), decision = ref<DecisionRequest | null>(null);
  const categories = ref<KnowledgeCategory[]>(['设备知识','网络态势知识','故障运维知识']), query = ref(''), type = ref(''), page = ref(1);
  const selectedId = ref(''), relationId = ref(''), focusId = ref(''), expandedIds = ref<string[]>([]);
  const search = ref<KnowledgeSearch | null>(null), graph = ref<KnowledgeGraph | null>(null), detail = ref<KnowledgeDetail | null>(null), queryError = ref(''), querying = ref(false);
  // 命中高亮只用于检索概览；自动聚焦只执行一次，避免翻页或重置时重新选中。
  const highlightMatches = ref(false);
  const matchedIds = computed(() => highlightMatches.value && !querying.value && !focusId.value && search.value && graph.value
    ? graph.value.entities.map(entity => entity.id) : []);
  let autoFocusPending = false;
  const historyVersionId = ref(''), legacyOpen = ref(false), rollbackReason = ref('');
  let resolver: ((v: Decision) => void) | undefined, queryGeneration = 0, loadGeneration = 0;
  let loadFlight: Promise<void> | null = null;
  let pending: {signature:string;request:KnowledgeMutation} | null = null;
  // 当前权限用于操作，历史身份从记录快照显示，二者分开。
  const actor = computed(() => auth.identity?{id:auth.identity.id,name:auth.identity.name,role:auth.can('knowledge.edit')?'EDITOR':auth.can('knowledge.review')?'REVIEWER':'VIEWER'}:undefined);
  const actorName=(id:string,key?:string)=>workspace.value?.identitySnapshots?.find(s=>s.id===id&&(!key||s.key===key))?.name??catalog.value.actors.find(a=>a.id===id)?.name??id;
  const current = computed(() => workspace.value?.versions.find(v => v.id === workspace.value!.currentVersionId) ?? null);
  const change = computed(() => workspace.value?.changes.find(c => c.id === changeId.value) ?? null);
  const historyVersion = computed(() => workspace.value?.versions.find(v => v.id === historyVersionId.value) ?? null);
  const dirtyDraft = computed(() => !!draft.value && !knowledgeEqual(draft.value,baseline.value));
  const dirty = computed(() => dirtyDraft.value || !!opinion.value || !!rollbackReason.value);
  const locked = computed(() => loading.value || busy.value);
  const stale = computed(() => !!draft.value && draft.value.baseVersionId !== workspace.value?.currentVersionId);
  const canEdit = computed(() => !!workspace.value && !!draft.value && !stale.value && actor.value?.role === 'EDITOR' && (!change.value || (change.value.authorId === actorId.value && ['DRAFT','REJECTED'].includes(change.value.state))));
  const base = computed(() => workspace.value?.versions.find(v => v.id === draft.value?.baseVersionId) ?? null);
  function report(e:unknown) { error.value = e instanceof Error ? e.message : '知识操作失败'; issues.value = e instanceof ApiError && Array.isArray(e.data) ? e.data : []; }
  function ask(request: DecisionRequest): Promise<Decision> { if (resolver) return Promise.resolve('cancel'); decision.value = request; return new Promise(resolve => {resolver=resolve;}); }
  function answer(value: Decision) { const done = resolver; resolver=undefined; decision.value=null; done?.(value); }
  function setDraft(content: KnowledgeDraft | null) { draft.value=content?knowledgeClone(content):null; baseline.value=content?knowledgeClone(content):null; opinion.value=''; issues.value=[]; }
  async function allowLeave(executingRollback = false,deferDiscard=false) {
    if (locked.value) { error.value='操作未完成，请稍候'; return false; }
    if (dirtyDraft.value) {
      const choice = await ask({title:'未保存的知识草稿',message:'保存当前草稿后继续，或放弃本次未保存输入？已保存版本和审核记录会保留。',saveLabel:'保存草稿后继续',discardLabel:'放弃输入',cancelLabel:'继续编辑'});
      if (choice === 'cancel' || (choice === 'save' && !(await saveDraft()))) return false;
      if (choice === 'discard'&&!deferDiscard) setDraft(baseline.value);
    }
    if (opinion.value) {
      if (await ask({title:'尚未提交的审核意见',message:'放弃当前意见并继续？此操作不会执行审核。',saveLabel:'放弃意见并继续',cancelLabel:'继续填写'}) !== 'save') return false;
      if(!deferDiscard)opinion.value='';
    }
    if (rollbackReason.value && !executingRollback) {
      if (await ask({title:'尚未提交的回滚原因',message:'放弃当前原因并继续？此操作不会执行回滚。',saveLabel:'放弃原因并继续',cancelLabel:'继续填写'}) !== 'save') return false;
      if(!deferDiscard)rollbackReason.value='';
    }
    return true;
  }
  async function load() {
    if (!auth.can('knowledge.view'))return;
    if (loadFlight) return loadFlight;
    const generation = ++loadGeneration; loading.value=true;
    loadFlight=(async () => {
      try {
        const loaded = await previewService.loadKnowledgeWorkspace(); if (generation !== loadGeneration) return;
        const {workspace:next,error:failure,...c} = loaded; catalog.value=c;
        if (failure || !next) { loadError.value=failure ?? '知识工作区不可用'; if (!dirty.value) workspace.value=null; return; }
        loadError.value='';
        if (workspace.value && workspace.value.revision !== next.revision && (dirty.value || busy.value)) { notice.value='知识版本已变化，当前输入已保留；旧基线提交将被拒绝，请放弃或另行记录后重新加载。'; return; }
        workspace.value=next;
        if (drawerOpen.value && changeId.value && !dirty.value) setDraft(change.value?.content ?? null);
        await refreshBrowse();
      } catch (e) { if (generation === loadGeneration) { loadError.value=e instanceof Error?e.message:'知识加载失败'; if (!dirty.value) workspace.value=null; } }
      finally { if (generation === loadGeneration){loading.value=false;loadFlight=null;} }
    })(); return loadFlight;
  }
  function clearBrowseSelection() {
    selectedId.value='';relationId.value='';focusId.value='';expandedIds.value=[];detail.value=null;
  }
  async function applyFilters(keyword = query.value) {
    if (!auth.can('knowledge.view')) return;
    query.value=keyword.trim();page.value=1;clearBrowseSelection();
    search.value=null;graph.value=null;highlightMatches.value=true;autoFocusPending=true;
    await refreshBrowse();
  }
  async function refreshBrowse() {
    if(!auth.can('knowledge.view'))return;
    const generation=++queryGeneration;
    if (!current.value) { search.value=null;graph.value=null;detail.value=null;querying.value=false;return; }
    const versionId=current.value.id, selected=selectedId.value;
    const q={versionId,categories:[...categories.value],type:type.value,query:query.value,page:page.value};
    querying.value=true;queryError.value='';
    const values=await Promise.allSettled([previewService.searchKnowledge(q),previewService.queryKnowledgeGraph({...q,focusId:focusId.value || undefined,expandedIds:[...expandedIds.value]}),selected?previewService.getKnowledgeEntity({versionId,entityId:selected}):Promise.resolve(null)]);
    if (generation !== queryGeneration) return;
    search.value=values[0].status==='fulfilled'?values[0].value:null;
    graph.value=values[1].status==='fulfilled'?values[1].value:null;
    detail.value=values[2].status==='fulfilled'?values[2].value:null;
    const failed=values.find(v=>v.status==='rejected');
    if (failed?.status==='rejected') queryError.value=failed.reason instanceof Error?failed.reason.message:'知识查询失败';
    if (search.value) page.value=search.value.page;
    if (!failed && autoFocusPending && search.value) {
      // 看总命中数，不能把多页结果的最后一条误当作唯一命中。
      autoFocusPending=false;
      if (search.value.total===1) {
        const entity=search.value.items[0];
        if (!entity) {
          queryError.value='检索结果缺少唯一命中的实体，请重试';autoFocusPending=true;
        } else {
          selectedId.value=entity.id;relationId.value='';focusId.value=entity.id;expandedIds.value=[entity.id];
          graph.value=null;detail.value=null;
          const focused=await Promise.allSettled([
            previewService.queryKnowledgeGraph({...q,focusId:entity.id,expandedIds:[entity.id]}),
            previewService.getKnowledgeEntity({versionId,entityId:entity.id}),
          ]);
          // 自动聚焦的第二次读取也受同一代次保护，不能覆盖新检索或明确点选。
          if (generation !== queryGeneration) return;
          graph.value=focused[0].status==='fulfilled'?focused[0].value:null;
          detail.value=focused[1].status==='fulfilled'?focused[1].value:null;
          const failure=focused.find(v=>v.status==='rejected');
          if (failure?.status==='rejected') queryError.value=failure.reason instanceof Error?failure.reason.message:'知识聚焦失败';
        }
      }
    }
    querying.value=false;
  }
  function stopQueries() { queryGeneration++;autoFocusPending=false;loadGeneration++;loadFlight=null;loading.value=false;querying.value=false;answer('cancel'); }
  async function selectEntity(id:string,revealCategory=false,keepGraph=false) {
    const e=current.value?.entities.find(e=>e.id===id);
    if (e && !categories.value.includes(e.category)) {
      if (!revealCategory) {queryError.value='请先选择该实体所属图谱';return;}
      categories.value=[...categories.value,e.category];
    }
    autoFocusPending=false;selectedId.value=id;relationId.value='';detail.value=null;
    if (!keepGraph || !focusId.value) {focusId.value=id;expandedIds.value=[id];}
    await refreshBrowse();
  }
  function selectRelation(id:string) { relationId.value=id; }
  async function resetGraph() {
    // 返回当前条件的概览，不再次自动选择，也不清空用户已提交的筛选条件。
    autoFocusPending=false;clearBrowseSelection();await refreshBrowse();
  }
  async function expand() { if (!selectedId.value) return; if (!focusId.value) focusId.value=selectedId.value; if (!expandedIds.value.includes(selectedId.value)) expandedIds.value=[...expandedIds.value,selectedId.value]; await refreshBrowse(); }
  async function collapse() {expandedIds.value=expandedIds.value.slice(0,-1);await refreshBrowse();}
  async function openChange(c:KnowledgeChange) { if (!(await allowLeave())) return;changeId.value=c.id;setDraft(c.content);drawerOpen.value=true;error.value=''; }
  async function newChange(entity?:KnowledgeEntity,relation?:KnowledgeRelation) {
    if (!current.value || actor.value?.role!=='EDITOR' || !(await allowLeave())) return;
    changeId.value='';setDraft({summary:'',baseVersionId:current.value.id,entities:entity?[knowledgeClone(entity)]:[],relations:relation?[knowledgeClone(relation)]:[]});drawerOpen.value=true;error.value='';
  }
  async function closeDrawer() { if (await allowLeave()) {drawerOpen.value=false;changeId.value='';setDraft(null);} }
  function request(kind:string,payload:unknown): KnowledgeMutation {
    const signature=knowledgeSignature({kind,payload,actorId:actorId.value,revision:workspace.value?.revision??null});
    if (!pending || pending.signature!==signature) pending={signature,request:{actorId:actorId.value,baseRevision:workspace.value?.revision??null,requestId:crypto.randomUUID()}};
    return {...pending.request};
  }
  async function mutate(action:()=>Promise<KnowledgeMutationResult>,message:string) {
    if (locked.value) return false; busy.value=true;error.value='';issues.value=[];loadGeneration++;
    try {
      const result=await action(); workspace.value=result.workspace;pending=null;loadError.value='';notice.value=result.changed?message:'没有需要保存的修改';
      if (drawerOpen.value) { const c=result.workspace.changes.find(c=>c.id===result.entityId);if(c){changeId.value=c.id;setDraft(c.content);} }
      await refreshBrowse();return true;
    } catch(e){report(e);return false;} finally {busy.value=false;}
  }
  async function saveDraft() {
    if (!draft.value || !canEdit.value) {error.value='当前内容只读，不能保存';return false;}
    const payload={changeId:changeId.value||null,revision:change.value?.revision??null,draft:knowledgeClone(draft.value)};
    return mutate(()=>previewService.saveKnowledgeChange({...request('SAVE',payload),...payload}),'知识草稿已保存');
  }
  async function submit() {
    if(!auth.can('knowledge.edit'))return;
    if (dirtyDraft.value && !(await saveDraft())) return;
    if (!change.value) {if (!(await saveDraft())) return;}
    const c=change.value;if(!c)return;
    if(await ask({title:'提交审核',message:'将冻结当前修订供审核人审阅，送审后不可直接修改。',saveLabel:'确认送审'})!=='save')return;
    const p={changeId:c.id,revision:c.revision};await mutate(()=>previewService.submitKnowledgeChange({...request('SUBMIT',p),...p}),'已提交审核');
  }
  async function withdraw() {
    if(!auth.can('knowledge.edit'))return;
    const c=change.value;if(!c)return;
    if(await ask({title:'撤回待审核变更',message:'撤回后恢复草稿，之前的送审记录仍保留。',saveLabel:'确认撤回'})!=='save')return;
    const p={changeId:c.id,revision:c.revision};await mutate(()=>previewService.withdrawKnowledgeChange({...request('WITHDRAW',p),...p}),'已撤回为草稿');
  }
  async function review(approved:boolean) {
    if(!auth.can('knowledge.review'))return;
    const c=change.value;if(!c)return;
    const p={changeId:c.id,revision:c.revision,submission:c.submissions.at(-1)?.number??0,approved,opinion:opinion.value};
    await mutate(()=>previewService.reviewKnowledgeChange({...request('REVIEW',p),...p}),approved?'审核通过，尚未发布':'已驳回，作者可修改重提');
  }
  async function publish() {
    if(!auth.can('knowledge.publish'))return;
    const c=change.value;if(!c)return;
    if(await ask({title:'发布知识版本',message:`${c.content.summary}；基于 ${c.content.baseVersionId}，${c.content.entities.length} 项实体、${c.content.relations.length} 项关系。仅发布本单；其他旧基线变更将过期，需重新新建并送审。`,saveLabel:'确认发布'})!=='save')return;
    const p={changeId:c.id,revision:c.revision};await mutate(()=>previewService.publishKnowledgeChange({...request('PUBLISH',p),...p}),'已发布新版本，图谱和设备知识已更新');
  }
  async function rollback(reason:string) {
    if (!auth.can('knowledge.rollback') || !(await allowLeave(true)) || !current.value) return false;
    const target=workspace.value!.versions.find(v=>v.id===current.value!.parentId);if(!target){error.value='没有上一版';return false;}
    if(await ask({title:'恢复上一版知识',message:`当前 v${current.value.number} → 恢复 v${target.number}，共 ${knowledgeDiff(current.value,target).length} 项差异。将创建新的已发布版本，其他未发布单会因旧基线而过期；既有诊断不变。原因：${reason}`,saveLabel:'确认回滚并生效'})!=='save')return false;
    const p={versionId:current.value.id,reason};const success=await mutate(()=>previewService.rollbackKnowledgeVersion({...request('ROLLBACK',p),...p}),'已恢复上一版内容并生成新发布记录');if(success)rollbackReason.value='';return success;
  }
  async function reset() {
    if (!auth.can('knowledge.reset') || locked.value) return;
    if(await ask({title:'重置知识演示数据',message:'恢复初始两个完整版本和演示变更单，清理后来产生的知识记录及未保存输入，并记录本次重置。资源、规划、诊断不变。',saveLabel:'确认重置知识'})!=='save')return;
    if(await mutate(()=>previewService.resetKnowledgeWorkspace(request('RESET',null)),'知识演示数据已重置')) {drawerOpen.value=false;changeId.value='';setDraft(null);historyVersionId.value='';rollbackReason.value='';}
  }
  async function showVersion(v:KnowledgeVersion) {if(await allowLeave()){historyVersionId.value=v.id;legacyOpen.value=false;}}
  async function closeVersion() {if(await allowLeave()){historyVersionId.value='';legacyOpen.value=false;}}
  async function showLegacy() {if(await allowLeave()){legacyOpen.value=true;historyVersionId.value='';}}
  function clearForSession(){stopQueries();workspace.value=null;catalog.value={actors:[],types:[],relationTypes:[],models:[],legacy:{entities:[],relations:[],versions:[]}};draft.value=null;baseline.value=null;changeId.value='';drawerOpen.value=false;opinion.value='';issues.value=[];categories.value=['设备知识','网络态势知识','故障运维知识'];query.value='';type.value='';page.value=1;selectedId.value='';relationId.value='';focusId.value='';expandedIds.value=[];search.value=null;graph.value=null;detail.value=null;queryError.value='';historyVersionId.value='';legacyOpen.value=false;rollbackReason.value='';loadError.value='';error.value='';notice.value='';pending=null;highlightMatches.value=false;}
  return {clearForSession,actorName,workspace,catalog,actorId,actor,loading,busy,loadError,error,notice,draft,baseline,changeId,change,drawerOpen,opinion,issues,decision,categories,query,type,page,selectedId,relationId,focusId,expandedIds,matchedIds,search,graph,detail,queryError,querying,current,historyVersionId,historyVersion,legacyOpen,rollbackReason,dirtyDraft,dirty,locked,stale,canEdit,base,ask,answer,allowLeave,load,applyFilters,refreshBrowse,stopQueries,selectEntity,selectRelation,resetGraph,expand,collapse,openChange,newChange,closeDrawer,saveDraft,submit,withdraw,review,publish,rollback,reset,showVersion,closeVersion,showLegacy};
});
