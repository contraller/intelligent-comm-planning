// 统一生成 UUID，兼容局域网 HTTP 访问。
import { randomUuid } from '../services/random-uuid';
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { previewService } from '../services';
import { ApiError } from '../services/types';
import { createReadCancellation } from '../services/data-access';
import { useAuthStore } from './auth';
import type { KnowledgeReadWorkspace, KnowledgeVersionSummary, KnowledgeChangeSummary, KnowledgeLog, KnowledgeReceipt, KnowledgeState } from '../types/knowledge';
import { knowledgeClone, knowledgeDiff, knowledgeEqual, knowledgeSignature } from '../services/knowledge-validation';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import type { KnowledgeCatalog, KnowledgeCategory, KnowledgeChange, KnowledgeDetail, KnowledgeDraft, KnowledgeEntity, KnowledgeGraph, KnowledgeIssue, KnowledgeMutation, KnowledgeMutationResult, KnowledgeRelation, KnowledgeSearch, KnowledgeVersion, KnowledgeWorkspace } from '../types/knowledge';

export const useKnowledgeStore = defineStore('knowledge',() => {
  const auth=useAuthStore(),requests=createReadCancellation();
  const workspace = ref<{revision:string;currentVersionId:string;current?:KnowledgeVersionSummary;counts?:Record<KnowledgeCategory,number>;identitySnapshots?:KnowledgeReadWorkspace['identitySnapshots'];versions:(KnowledgeVersionSummary|KnowledgeVersion)[];changes:(KnowledgeChangeSummary|KnowledgeChange)[];logs:KnowledgeLog[]} | null>(null);
  const activeTab=ref<'browse'|'changes'|'versions'|'logs'>('browse'),historyPage=ref(1),historyTotal=ref(0),changeState=ref<KnowledgeState|undefined>();
  const selectedChange=ref<KnowledgeChange|null>(null),editBase=ref<KnowledgeVersion|null>(null),versionDetail=ref<KnowledgeVersion|null>(null),historyParent=ref<KnowledgeVersion|null>(null),versionChange=ref<KnowledgeChange|null>(null);
  // 受理后的重读保护只属于当前变更，关闭或成功切换上下文后不再阻塞其他单据。
  const receiptChangeId=ref(''),receiptPending=computed(()=>!!receiptChangeId.value&&receiptChangeId.value===changeId.value);
  let historySerial=0,detailSerial=0,selectionSerial=0,mutationSerial=0,logSerial=0,logKey='';
  const logPage=ref(1),logTotal=ref(0);
  const catalog = ref<KnowledgeCatalog>({actors:[],types:[],relationTypes:[],models:[]});
  const actorId = computed(()=>auth.identity?.id??''), loading = ref(false), busy = ref(false), loadError = ref(''), error = ref(''), notice = ref('');
  const draft = ref<KnowledgeDraft | null>(null), baseline = ref<KnowledgeDraft | null>(null), changeId = ref(''), drawerOpen = ref(false), opinion = ref('');
  // 打开详情分两步读取；重复点击复用当前读取，不把正常等待显示为操作失败。
  const openingChangeId = ref(''), openingChangeStage = ref<'detail' | 'base' | ''>('');
  const issues = ref<KnowledgeIssue[]>([]), decision = ref<DecisionRequest | null>(null);
  const categories = ref<KnowledgeCategory[]>(['设备知识','网络态势知识','故障运维知识']), query = ref(''), type = ref(''), page = ref(1);
  const selectedId = ref(''), relationId = ref(''), focusId = ref(''), expandedIds = ref<string[]>([]);
  const search = ref<KnowledgeSearch | null>(null), graph = ref<KnowledgeGraph | null>(null), detail = ref<KnowledgeDetail | null>(null), queryError = ref(''), querying = ref(false);
  // 命中高亮只用于检索概览；自动聚焦只执行一次，避免翻页或重置时重新选中。
  const highlightMatches = ref(false);
  // 翻页只更新列表；稳定的命中引用避免读取状态切换重置画布视角。
  const noMatches: string[] = [];
  const matchedIds = computed(() => highlightMatches.value && !focusId.value && search.value && graph.value && query.value.trim()
    ? graph.value.matchedIds : noMatches);
  let autoFocusPending = false;
  // 只记住失败的定向动作，重试沿用它；新操作或会话清理立即作废。
  let retrySelection: {id:string;revealCategory:boolean;keepGraph:boolean;versionId:string;session:number} | null = null;
  let browseVersionId='';
  let searchKey='',graphKey='',detailKey='';
  const historyVersionId = ref(''), rollbackReason = ref('');
  let resolver: ((v: Decision) => void) | undefined, queryGeneration = 0, loadGeneration = 0;
  let loadFlight: Promise<void> | null = null;
  let pending: {signature:string;request:KnowledgeMutation} | null = null;
  // 当前权限用于操作，历史身份从记录快照显示，二者分开。
  const actor = computed(() => auth.identity?{id:auth.identity.id,name:auth.identity.name,role:auth.can('knowledge.edit')?'EDITOR':auth.can('knowledge.review')?'REVIEWER':'VIEWER'}:undefined);
  const actorName=(id:string,key?:string)=>workspace.value?.identitySnapshots?.find(s=>s.id===id&&(!key||s.key===key))?.name??catalog.value.actors.find(a=>a.id===id)?.name??id;
  const current = computed(() => (workspace.value?.current?.id===workspace.value?.currentVersionId?workspace.value?.current:undefined) ?? workspace.value?.versions.find(v => v.id === workspace.value!.currentVersionId) ?? null);
  const counts=computed(()=>workspace.value?.counts?workspace.value.counts:Object.fromEntries(['设备知识','网络态势知识','故障运维知识'].map(c=>[c,workspace.value?.versions.find((v):v is KnowledgeVersion=>v.id===workspace.value!.currentVersionId&&'entities' in v)?.entities.filter(e=>e.category===c).length??0])));
  const change = computed<KnowledgeChange|null>(() => selectedChange.value ?? workspace.value?.changes.find((c):c is KnowledgeChange => c.id === changeId.value && 'content' in c) ?? null);
  const historyChange=computed(()=>versionChange.value??workspace.value?.changes.find((c):c is KnowledgeChange=>c.id===historyVersion.value?.changeId&&'submissions' in c)??null);
  const historyVersion = computed<KnowledgeVersion|null>(() => versionDetail.value?.id===historyVersionId.value?versionDetail.value:workspace.value?.versions.find((v):v is KnowledgeVersion=>v.id===historyVersionId.value&&'entities' in v)??null);
  const dirtyDraft = computed(() => !!draft.value && !knowledgeEqual(draft.value,baseline.value));
  const dirty = computed(() => dirtyDraft.value || !!opinion.value || !!rollbackReason.value);
  const locked = computed(() => loading.value || busy.value);
  // 已发布单用于追溯，不再提示重新创建；未发布单仍按原基线限制操作。
  const stale = computed(() => !!draft.value && change.value?.state !== 'PUBLISHED' && draft.value.baseVersionId !== workspace.value?.currentVersionId);
  const canEdit = computed(() => !receiptPending.value && !!workspace.value && !!draft.value && !stale.value && actor.value?.role === 'EDITOR' && (!change.value || (change.value.authorId === actorId.value && ['DRAFT','REJECTED'].includes(change.value.state))));
  const base = computed<KnowledgeVersion|null>(() => editBase.value?.id===draft.value?.baseVersionId?editBase.value:workspace.value?.versions.find((v):v is KnowledgeVersion => v.id === draft.value?.baseVersionId && 'entities' in v) ?? null);
  function report(e:unknown) { error.value = e instanceof Error ? e.message : '知识操作失败'; issues.value = e instanceof ApiError && Array.isArray(e.data) ? e.data : []; }
  function ask(request: DecisionRequest): Promise<Decision> { if (resolver) return Promise.resolve('cancel'); decision.value = request; return new Promise(resolve => {resolver=resolve;}); }
  function answer(value: Decision) { const done = resolver; resolver=undefined; decision.value=null; done?.(value); }
  function setDraft(content: KnowledgeDraft | null) { draft.value=content?knowledgeClone(content):null; baseline.value=content?knowledgeClone(content):null; opinion.value=''; issues.value=[]; }
  async function allowLeave(executingRollback = false,deferDiscard=false) {
    if (locked.value) { error.value='操作未完成，请稍候'; return false; }
    if (dirtyDraft.value) {
      const choice = await ask({title:'未保存的知识草稿',message:'保存当前草稿后继续，或放弃本次未保存输入？已保存版本和审核记录会保留。关闭此提示仅取消离开；保存失败时会保留输入并显示原因。',saveLabel:'保存草稿后继续',discardLabel:'放弃输入',cancelLabel:'继续编辑'});
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
  // 元信息可跨设备页共享；普通设备知识读取不启动检索、图谱或历史查询。
  async function ensureMetadata(accepted=false) {
    if(!auth.can('knowledge.view'))return;
    if(loadFlight)return loadFlight;
    const generation=++loadGeneration,session=auth.generation;loading.value=true;
    loadFlight=(async()=>{
      try {
        const {workspace:next,error:failure,...c}=await previewService.loadKnowledgeMetadata({signal:requests.signal('metadata')});
        if(generation!==loadGeneration||session!==auth.generation)return;
        catalog.value=c;
        if(failure||!next){loadError.value=failure??'知识工作区不可用';if(!dirty.value)workspace.value=null;return;}
        loadError.value='';
        if(!accepted&&workspace.value&&workspace.value.revision!==next.revision&&(dirty.value||busy.value)){notice.value='知识版本已变化，当前输入已保留；旧基线提交将被拒绝，请放弃或另行记录后重新加载。';return;}
        const before=workspace.value;
        workspace.value={...next,versions:before?.versions??[],changes:before?.changes??[],logs:before?.logs??[]};
        if(receiptPending.value){const id=receiptChangeId.value,detail=await previewService.getKnowledgeChange({id});if(generation!==loadGeneration||session!==auth.generation||receiptChangeId.value!==id||changeId.value!==id||!drawerOpen.value)return;selectedChange.value=detail;setDraft(detail.content);receiptChangeId.value='';}
      }catch(e){if(generation===loadGeneration){loadError.value=e instanceof Error?e.message:'知识加载失败';if(!dirty.value)workspace.value=null;}}
      finally{if(generation===loadGeneration){loading.value=false;loadFlight=null;}}
    })();return loadFlight;
  }
  async function load(){await ensureMetadata();await refreshTab();}
  async function refreshTab(){
    if(activeTab.value==='browse')return retryBrowse();
    const serial=++historySerial,session=auth.generation,q={pageNum:historyPage.value,pageSize:20,signal:requests.signal('history')};
    try{
      const value=activeTab.value==='changes'?await previewService.queryKnowledgeChanges({...q,state:changeState.value}):activeTab.value==='versions'?await previewService.queryKnowledgeVersions(q):await previewService.queryKnowledgeLogs(q);
      if(serial!==historySerial||session!==auth.generation||!workspace.value)return;
      const w=workspace.value;
      if(w.current){
        if(activeTab.value==='changes')w.changes=value.items as KnowledgeChangeSummary[];
        if(activeTab.value==='versions')w.versions=value.items as KnowledgeVersionSummary[];
        if(activeTab.value==='logs')w.logs=value.items as KnowledgeLog[];
      }
      historyTotal.value=value.total;
      if(activeTab.value==='versions'&&logKey!==workspace.value.revision+':'+logPage.value)await queryLogs(logPage.value);
    }catch(e){if(serial===historySerial&&session===auth.generation)report(e);}
  }
  async function queryLogs(page=1){
    if(!workspace.value)return;const serial=++logSerial,session=auth.generation,revision=workspace.value.revision;
    try{const value=await previewService.queryKnowledgeLogs({pageNum:page,pageSize:20,signal:requests.signal('logs')});if(serial!==logSerial||session!==auth.generation||workspace.value?.revision!==revision)return;workspace.value.logs=value.items;logPage.value=page;logTotal.value=value.total;logKey=revision+':'+page;}catch(e){if(session===auth.generation)report(e);}
  }
  async function changeTab(tab:typeof activeTab.value){activeTab.value=tab;historyPage.value=1;await refreshTab();}
  function clearBrowseSelection() {
    selectionSerial++;retrySelection=null;browseVersionId='';
    selectedId.value='';relationId.value='';focusId.value='';expandedIds.value=[];detail.value=null;
  }
  async function applyFilters(keyword = query.value) {
    if (!auth.can('knowledge.view')) return;
    query.value=keyword.trim();page.value=1;clearBrowseSelection();
    search.value=null;graph.value=null;highlightMatches.value=true;autoFocusPending=true;
    await refreshBrowse();
  }
  async function refreshBrowse():Promise<void> {
    if(!auth.can('knowledge.view'))return;
    selectionSerial++;
    const generation=++queryGeneration;
    if (!current.value) { search.value=null;graph.value=null;detail.value=null;querying.value=false;return; }
    const versionId=current.value.id, selected=selectedId.value;
    const versionChanged=!!browseVersionId&&browseVersionId!==versionId;
    if(versionChanged){
      // 换版后按当前选择重新取一跳，旧根和展开记录不带入新快照。
      autoFocusPending=false;retrySelection=null;relationId.value='';focusId.value=selected;expandedIds.value=selected?[selected]:[];graph.value=null;detail.value=null;
    }
    const q={versionId,categories:[...categories.value],type:type.value,search:query.value,pageNum:page.value,pageSize:20};
    querying.value=true;queryError.value='';
    const sk=JSON.stringify(q),gq={versionId,categories:q.categories,type:q.type,search:q.search,focusId:focusId.value||undefined,expandedIds:[...expandedIds.value]},gk=JSON.stringify(gq),dk=JSON.stringify([versionId,selected]);
    const values=await Promise.allSettled([sk===searchKey&&search.value?Promise.resolve(search.value):previewService.searchKnowledgeSummaries({...q,signal:requests.signal('search')}),gk===graphKey&&graph.value?Promise.resolve(graph.value):previewService.getKnowledgeGraph({...gq,signal:requests.signal('graph')}),selected?(dk===detailKey&&detail.value?Promise.resolve(detail.value):previewService.getKnowledgeEntity({versionId,entityId:selected,signal:requests.signal('entity')})):Promise.resolve(null)]);
    if (generation !== queryGeneration || versionId!==current.value?.id) {if(generation===queryGeneration)querying.value=false;return;}
    const detailResult=values[2];
    if(versionChanged&&detailResult.status==='rejected'&&detailResult.reason instanceof ApiError&&detailResult.reason.code==='KNOWLEDGE_ENTITY_MISSING'){
      // 只有服务明确说明旧选择已移除才返回概览；临时失败和新失效入口仍可重试。
      clearBrowseSelection();autoFocusPending=false;notice.value='知识版本已更新，当前实体已不在此版本，已返回概览。';await refreshBrowse();return;
    }
    if(values[0].status==='fulfilled')searchKey=sk;if(values[1].status==='fulfilled')graphKey=gk;if(values[2].status==='fulfilled')detailKey=dk;
    search.value=values[0].status==='fulfilled'?values[0].value:null;
    graph.value=values[1].status==='fulfilled'?values[1].value:null;
    detail.value=values[2].status==='fulfilled'?values[2].value:null;
    const failed=values.find(v=>v.status==='rejected');
    if (failed?.status==='rejected') queryError.value=failed.reason instanceof Error?failed.reason.message:'知识查询失败';
    if (search.value) page.value=search.value.pageNum;
    if(!failed&&selected&&graph.value&&!graph.value.entities.some(entity=>entity.id===selected)){
      // 同时用于正常收起和失败后的重试，保证详情指向仍可见的对象。
      selectedId.value=graph.value.entities.some(entity=>entity.id===focusId.value)?focusId.value:'';relationId.value='';detail.value=null;autoFocusPending=false;await refreshBrowse();return;
    }
    if (!failed && autoFocusPending && search.value) {
      // 看总命中数，不能把多页结果的最后一条误当作唯一命中。
      autoFocusPending=false;
      if (search.value.total===1) {
        const entity=search.value.items[0];
        if (!entity) {
          queryError.value='检索结果缺少唯一命中的实体，请重试';autoFocusPending=true;searchKey='';search.value=null;
        } else {
          selectedId.value=entity.id;relationId.value='';focusId.value=entity.id;expandedIds.value=[entity.id];
          graph.value=null;detail.value=null;
          const focused=await Promise.allSettled([
            previewService.getKnowledgeGraph({...gq,focusId:entity.id,expandedIds:[entity.id],signal:requests.signal('graph')}),
            previewService.getKnowledgeEntity({versionId,entityId:entity.id,signal:requests.signal('entity')}),
          ]);
          // 自动聚焦的第二次读取也受同一代次保护，不能覆盖新检索或明确点选。
          if (generation !== queryGeneration || versionId!==current.value?.id) {if(generation===queryGeneration)querying.value=false;return;}
          if(focused[0].status==='fulfilled')graphKey=JSON.stringify({...gq,focusId:entity.id,expandedIds:[entity.id]});if(focused[1].status==='fulfilled')detailKey=JSON.stringify([versionId,entity.id]);
          graph.value=focused[0].status==='fulfilled'?focused[0].value:null;
          detail.value=focused[1].status==='fulfilled'?focused[1].value:null;
          const failure=focused.find(v=>v.status==='rejected');
          if (failure?.status==='rejected') queryError.value=failure.reason instanceof Error?failure.reason.message:'知识聚焦失败';
        }
      }
    }
    if(!queryError.value&&graph.value)browseVersionId=versionId;
    querying.value=false;
  }
  async function retryBrowse():Promise<void> {
    const retry=retrySelection;
    if(retry&&retry.versionId===current.value?.id&&retry.session===auth.generation)return selectEntity(retry.id,retry.revealCategory,retry.keepGraph);
    retrySelection=null;await refreshBrowse();
  }
  function stopQueries() { requests.stop();logSerial++;historySerial++;detailSerial++;selectionSerial++;queryGeneration++;autoFocusPending=false;retrySelection=null;loadGeneration++;loadFlight=null;loading.value=false;openingChangeId.value='';openingChangeStage.value='';querying.value=false;answer('cancel'); }
  async function selectEntity(id:string,revealCategory=false,keepGraph=false) {
    // 定向入口的前置详情与后续检索共用“最新意图优先”，迟到成功和失败均不得回写。
    const token=++selectionSerial,session=auth.generation,versionId=current.value?.id;
    const active=()=>token===selectionSerial&&session===auth.generation&&versionId===current.value?.id;
    autoFocusPending=false;retrySelection=null;browseVersionId=versionId??'';queryGeneration++;querying.value=false;
    let e=graph.value?.entities.find(e=>e.id===id)??search.value?.items.find(e=>e.id===id)??detail.value?.neighbors.find(e=>e.id===id);
    if(!e&&revealCategory&&versionId){
      querying.value=true;
      try{const d=await previewService.getKnowledgeEntity({versionId,entityId:id,signal:requests.signal('selection')});if(!active())return;e=d.entity;}
      catch(reason){if(!active())return;retrySelection={id,revealCategory,keepGraph,versionId,session};selectedId.value=id;relationId.value='';detail.value=null;graph.value=null;queryError.value=reason instanceof Error?reason.message:'实体读取失败';return;}
      finally{if(token===selectionSerial)querying.value=false;}
    }
    if(!active())return;
    if (e && !categories.value.includes(e.category)) {
      if (!revealCategory) {queryError.value='请先选择该实体所属图谱';return;}
      categories.value=[...categories.value,e.category];
    }
    autoFocusPending=false;selectedId.value=id;relationId.value='';detail.value=null;
    if (!keepGraph || !focusId.value || graph.value?.versionId!==versionId) {focusId.value=id;expandedIds.value=[id];}
    await refreshBrowse();
  }
  function selectRelation(id:string) { selectionSerial++;queryGeneration++;autoFocusPending=false;retrySelection=null;querying.value=false;relationId.value=id; }
  async function resetGraph() {
    // 返回当前条件的概览，不再次自动选择，也不清空用户已提交的筛选条件。
    autoFocusPending=false;clearBrowseSelection();await refreshBrowse();
  }
  async function expand() { if (!selectedId.value) return; if (!focusId.value) focusId.value=selectedId.value; if (!expandedIds.value.includes(selectedId.value)) expandedIds.value=[...expandedIds.value,selectedId.value]; await refreshBrowse(); }
  async function collapse() {
    expandedIds.value=expandedIds.value.slice(0,-1);const generation=queryGeneration+1;await refreshBrowse();
    if(generation!==queryGeneration||!graph.value||graph.value.versionId!==current.value?.id)return;
    if(relationId.value&&!graph.value.relations.some(r=>r.id===relationId.value))relationId.value='';
  }
  async function openChange(c:Pick<KnowledgeChange,'id'>) {
    if(locked.value||!(await allowLeave())||locked.value)return;
    const token=++detailSerial,session=auth.generation;loading.value=true;openingChangeId.value=c.id;openingChangeStage.value='detail';error.value='';
    try{const detail=await previewService.getKnowledgeChange({id:c.id,signal:requests.signal('change')});
      if(token!==detailSerial||session!==auth.generation)return;
      openingChangeStage.value='base';
      const base=await previewService.getKnowledgeVersion({id:detail.content.baseVersionId,signal:requests.signal('edit-base')});
      if(token!==detailSerial||session!==auth.generation)return;selectedChange.value=detail;editBase.value=base;changeId.value=detail.id;receiptChangeId.value='';setDraft(detail.content);drawerOpen.value=true;error.value='';
    }catch(e){if(token===detailSerial&&session===auth.generation)report(e);}finally{if(token===detailSerial){loading.value=false;openingChangeId.value='';openingChangeStage.value='';}}
  }
  async function newChange(entity?:KnowledgeEntity,relation?:KnowledgeRelation) {
    if(!current.value||actor.value?.role!=='EDITOR'||!(await allowLeave()))return;
    const id=current.value.id,token=++detailSerial,session=auth.generation;loading.value=true;
    try{const base=await previewService.getKnowledgeVersion({id,signal:requests.signal('edit-base')});if(token!==detailSerial||session!==auth.generation||id!==current.value?.id)return;
      editBase.value=base;selectedChange.value=null;changeId.value='';receiptChangeId.value='';setDraft({summary:'',baseVersionId:id,entities:entity?[knowledgeClone(entity)]:[],relations:relation?[knowledgeClone(relation)]:[]});drawerOpen.value=true;error.value='';
    }catch(e){if(token===detailSerial&&session===auth.generation)report(e);}finally{if(token===detailSerial)loading.value=false;}
  }
  async function closeDrawer() { if (await allowLeave()) {const reread=receiptPending.value;drawerOpen.value=false;selectedChange.value=null;editBase.value=null;changeId.value='';receiptChangeId.value='';setDraft(null);
    // 用户已完成保存或明确放弃本次输入，关闭后不再显示该表单的旧校验错误。
    if(!reread)error.value='';if(reread)await refreshTab();} }
  function request(kind:string,payload:unknown): KnowledgeMutation {
    const signature=knowledgeSignature({kind,payload,actorId:actorId.value,revision:workspace.value?.revision??null});
    if (!pending || pending.signature!==signature) pending={signature,request:{actorId:actorId.value,baseRevision:workspace.value?.revision??null,requestId:randomUuid()}};
    return {...pending.request};
  }
  async function mutate(action:()=>Promise<KnowledgeReceipt>,message:string) {
    if(locked.value||receiptPending.value)return false;busy.value=true;error.value='';issues.value=[];loadGeneration++;
    // 写操作自行释放忙状态；身份代次仅决定能否回写页面，不能抹掉已受理结果。
    const operation=++mutationSerial,session=auth.generation,ownerSession=auth.identity?.sessionId,ownerId=actorId.value,editing=draft.value;
    const sameOwner=()=>operation===mutationSerial&&ownerSession===auth.identity?.sessionId&&ownerId===actorId.value;
    let accepted=false;
    try{
      const result=await action();accepted=true;if(operation!==mutationSerial)return true;pending=null;
      if(session!==auth.generation){
        if(sameOwner()&&editing&&draft.value===editing&&drawerOpen.value&&result.entityId!==result.currentVersionId){
          receiptChangeId.value=result.entityId;changeId.value=result.entityId;baseline.value=knowledgeClone(editing);
        }
        return true;
      }
      loadError.value='';notice.value=result.changed?message:'没有需要保存的修改';
      if(workspace.value){workspace.value.revision=result.revision;workspace.value.currentVersionId=result.currentVersionId;}
      if(drawerOpen.value&&changeId.value!==result.currentVersionId){
        receiptChangeId.value=result.entityId;changeId.value=result.entityId;
        // 已提交输入先标记已保存；规范化详情失败时禁止再次提交并保留重读入口。
        baseline.value=draft.value?knowledgeClone(draft.value):null;
        const c=await previewService.getKnowledgeChange({id:result.entityId});
        if(session!==auth.generation)return true;selectedChange.value=c;setDraft(c.content);receiptChangeId.value='';
      }
      await ensureMetadata(true);if(session!==auth.generation)return true;await refreshTab();return true;
    }catch(e){if(sameOwner()){report(e);if(accepted)notice.value=message+'；后续读取失败，请重新加载，无需重复提交';}return accepted;}
    finally{if(operation===mutationSerial){busy.value=false;if(accepted&&session!==auth.generation&&sameOwner())notice.value=message+'；当前权限已变化，请重新加载核对，无需重复提交';}}
  }
  async function saveDraft() {
    if (!draft.value || !canEdit.value) {error.value='当前内容只读，不能保存';return false;}
    const payload={changeId:changeId.value||null,revision:change.value?.revision??null,draft:knowledgeClone(draft.value)};
    return mutate(()=>previewService.saveKnowledgeReceipt({...request('SAVE',payload),...payload}),'知识草稿已保存');
  }
  async function submit() {
    if(!auth.can('knowledge.edit'))return;
    const session=auth.generation;
    if (dirtyDraft.value && !(await saveDraft())) return;
    if (!change.value) {if (!(await saveDraft())) return;}
    if(session!==auth.generation||!canEdit.value)return;
    const c=change.value;if(!c)return;
    if(await ask({title:'提交审核',message:'将冻结当前修订供审核人审阅，送审后不可直接修改。',saveLabel:'确认送审'})!=='save')return;
    if(session!==auth.generation||!canEdit.value||change.value?.id!==c.id)return;
    const p={changeId:c.id,revision:c.revision};await mutate(()=>previewService.submitKnowledgeReceipt({...request('SUBMIT',p),...p}),'已提交审核');
  }
  async function withdraw() {
    if(!auth.can('knowledge.edit'))return;
    const c=change.value;if(!c)return;
    if(await ask({title:'撤回待审核变更',message:'撤回后恢复草稿，之前的送审记录仍保留。',saveLabel:'确认撤回'})!=='save')return;
    const p={changeId:c.id,revision:c.revision};await mutate(()=>previewService.withdrawKnowledgeReceipt({...request('WITHDRAW',p),...p}),'已撤回为草稿');
  }
  async function review(approved:boolean) {
    if(!auth.can('knowledge.review'))return;
    const c=change.value;if(!c)return;
    const p={changeId:c.id,revision:c.revision,submission:c.submissions.at(-1)?.number??0,approved,opinion:opinion.value};
    await mutate(()=>previewService.reviewKnowledgeReceipt({...request('REVIEW',p),...p}),approved?'审核通过，尚未发布':'已驳回，作者可修改重提');
  }
  async function publish() {
    if(!auth.can('knowledge.publish'))return;
    const c=change.value;if(!c)return;
    if(await ask({title:'发布知识版本',message:`${c.content.summary}；基于 ${c.content.baseVersionId}，${c.content.entities.length} 项实体、${c.content.relations.length} 项关系。仅发布本单；其他旧基线变更将过期，需重新新建并送审。`,saveLabel:'确认发布'})!=='save')return;
    const p={changeId:c.id,revision:c.revision};await mutate(()=>previewService.publishKnowledgeReceipt({...request('PUBLISH',p),...p}),'已发布新版本，图谱和设备知识已更新');
  }
  async function rollback(reason:string) {
    const session=auth.generation;
    if (!auth.can('knowledge.rollback') || !(await allowLeave(true)) || !current.value) return false;
    if(!current.value.parentId){error.value='没有上一版';return false;}
    let before:KnowledgeVersion,target:KnowledgeVersion;try{[before,target]=await Promise.all([previewService.getKnowledgeVersion({id:current.value.id}),previewService.getKnowledgeVersion({id:current.value.parentId})]);}catch(e){report(e);return false;}
    if(await ask({title:'恢复上一版知识',message:`当前 v${current.value.number} → 恢复 v${target.number}，共 ${knowledgeDiff(before,target).length} 项差异。将创建新的已发布版本，其他未发布单会因旧基线而过期；既有诊断不变。原因：${reason}`,saveLabel:'确认回滚并生效'})!=='save')return false;
    const p={versionId:current.value.id,reason};const success=await mutate(()=>previewService.rollbackKnowledgeReceipt({...request('ROLLBACK',p),...p}),'已恢复上一版内容并生成新发布记录');if(success&&session===auth.generation)rollbackReason.value='';return success;
  }
  async function reset() {
    if (!auth.can('knowledge.reset') || locked.value) return;
    const session=auth.generation;
    if(await ask({title:'重置知识数据',message:'恢复初始两个完整版本和变更单，清理后来产生的知识记录及未保存输入，并记录本次重置。资源、规划、诊断不变。',saveLabel:'确认重置知识'})!=='save')return;
    if(await mutate(()=>previewService.resetKnowledgeReceipt(request('RESET',null)),'知识数据已重置')&&session===auth.generation) {drawerOpen.value=false;selectedChange.value=null;editBase.value=null;changeId.value='';setDraft(null);historyVersionId.value='';rollbackReason.value='';}
  }
  async function showVersion(v:Pick<KnowledgeVersion,'id'>) {
    if(!(await allowLeave()))return;const token=++detailSerial,session=auth.generation;loading.value=true;
    try{
      const detail=await previewService.getKnowledgeVersion({id:v.id,signal:requests.signal('version')});
      const [parent,change]=await Promise.all([detail.parentId?previewService.getKnowledgeVersion({id:detail.parentId,signal:requests.signal('parent')}):Promise.resolve(null),detail.changeId?previewService.getKnowledgeChange({id:detail.changeId}):Promise.resolve(null)]);
      if(token!==detailSerial||session!==auth.generation)return;versionDetail.value=detail;historyParent.value=parent;versionChange.value=change;historyVersionId.value=v.id;
    }catch(e){if(token===detailSerial&&session===auth.generation)report(e);}finally{if(token===detailSerial)loading.value=false;}
  }
  async function closeVersion(){if(await allowLeave()){historyVersionId.value='';versionDetail.value=null;historyParent.value=null;versionChange.value=null;}}

  function clearForSession(){mutationSerial++;busy.value=false;browseVersionId='';stopQueries();logKey='';logPage.value=1;logTotal.value=0;selectedChange.value=null;editBase.value=null;versionDetail.value=null;historyParent.value=null;versionChange.value=null;receiptChangeId.value='';activeTab.value='browse';historyPage.value=1;historyTotal.value=0;changeState.value=undefined;searchKey='';graphKey='';detailKey='';workspace.value=null;catalog.value={actors:[],types:[],relationTypes:[],models:[]};draft.value=null;baseline.value=null;changeId.value='';drawerOpen.value=false;opinion.value='';issues.value=[];categories.value=['设备知识','网络态势知识','故障运维知识'];query.value='';type.value='';page.value=1;selectedId.value='';relationId.value='';focusId.value='';expandedIds.value=[];search.value=null;graph.value=null;detail.value=null;queryError.value='';historyVersionId.value='';rollbackReason.value='';loadError.value='';error.value='';notice.value='';pending=null;highlightMatches.value=false;}
  return {openingChangeId,openingChangeStage,historyChange,logPage,logTotal,queryLogs,ensureMetadata,counts,activeTab,historyPage,historyTotal,changeState,changeTab,refreshTab,historyParent,versionChange,receiptPending,clearForSession,actorName,workspace,catalog,actorId,actor,loading,busy,loadError,error,notice,draft,baseline,changeId,change,drawerOpen,opinion,issues,decision,categories,query,type,page,selectedId,relationId,focusId,expandedIds,matchedIds,search,graph,detail,queryError,querying,current,historyVersionId,historyVersion,rollbackReason,dirtyDraft,dirty,locked,stale,canEdit,base,ask,answer,allowLeave,load,applyFilters,refreshBrowse,retryBrowse,stopQueries,selectEntity,selectRelation,resetGraph,expand,collapse,openChange,newChange,closeDrawer,saveDraft,submit,withdraw,review,publish,rollback,reset,showVersion,closeVersion};
});
