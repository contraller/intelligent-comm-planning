import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { previewService } from '../src/services';
import { createKnowledgeMock } from '../src/services/knowledge-mock';
import { queryKnowledgeSnapshot, searchKnowledgeSnapshot } from '../src/services/knowledge-query';
import { useKnowledgeStore } from '../src/stores/knowledge';
import type { KnowledgeDetail, KnowledgeGraph, KnowledgeSearch } from '../src/types/knowledge';
import { authorizeStore } from './helpers/auth';
import { TestStorage } from './helpers/storage';

let pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { if (pinia) disposePinia(pinia); pinia=undefined;vi.restoreAllMocks(); });
async function start() {
  pinia=createPinia();setActivePinia(pinia);authorizeStore('kg_editor');
  const storage=new TestStorage(),service=createKnowledgeMock(()=>storage);
  for (const key of Object.keys(service) as (keyof typeof service)[]) vi.spyOn(previewService,key).mockImplementation(service[key] as never);
  const store=useKnowledgeStore();await store.load();
  return {store,service,storage};
}
// 显式控制响应顺序，覆盖检索与聚焦两阶段，而不是用时间等待碰运气。
function deferred<T>() {
  let resolve!: (value:T)=>void, reject!: (reason:Error)=>void;
  const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});
  return {promise,resolve,reject};
}

describe('知识检索与聚焦联动', () => {
  it('首次进入保持分类概览；唯一命中按同一发布版聚焦并读取一跳和详情', async () => {
    const {store,storage}=await start(),before=JSON.stringify(store.workspace);
    expect(store.selectedId).toBe('');expect(store.matchedIds).toEqual([]);
    await store.applyFilters('  KGE-POWER  ');
    expect(store.query).toBe('KGE-POWER');expect(store.search!.total).toBe(1);
    expect(store.selectedId).toBe('KGE-POWER');expect(store.focusId).toBe('KGE-POWER');
    expect(store.detail!.entity.id).toBe('KGE-POWER');expect(store.detail!.versionId).toBe(store.current!.id);
    expect(store.graph!.entities[0].id).toBe('KGE-POWER');expect(store.graph!.entities.length).toBeGreaterThan(1);
    expect(store.matchedIds).toEqual([]);expect(store.queryError).toBe('');
    expect(JSON.stringify(store.workspace)).toBe(before);expect(storage.writes).toBe(0);
  });
  it('多命中先展示命中子图，清理上次实体和关系，点击后才显示详情', async () => {
    const {store}=await start();await store.selectEntity('KGE-MODEL');store.selectRelation(store.detail!.relations[0].id);
    const pending=store.applyFilters('KGE-STATE-');
    expect(store.detail).toBeNull();expect(store.selectedId).toBe('');expect(store.relationId).toBe('');
    expect(store.expandedIds).toEqual([]);expect(store.matchedIds).toEqual([]);
    await pending;
    expect(store.search!.total).toBe(4);expect(store.selectedId).toBe('');expect(store.detail).toBeNull();
    expect(store.matchedIds).toEqual(store.graph!.entities.map(e=>e.id));
    expect(store.graph!.entities.every(e=>e.id.startsWith('KGE-STATE-'))).toBe(true);
    await store.selectEntity('KGE-STATE-GOOD');
    expect(store.detail!.entity.id).toBe('KGE-STATE-GOOD');expect(store.matchedIds).toEqual([]);
    expect(store.graph!.entities.some(e=>e.id==='KGE-RULE')).toBe(true);
  });
  it('零命中保留预设推荐但不自动选择；没有分类时也是空结果', async () => {
    const {store}=await start();await store.applyFilters('KGE-POWER');await store.applyFilters('发烫');
    expect(store.search!.code).toBe(4001);expect(store.search!.similar.map(e=>e.id)).toEqual(['KGE-SYMPTOM','KGE-SOLUTION']);
    expect(store.selectedId).toBe('');expect(store.detail).toBeNull();expect(store.graph!.entities).toEqual([]);
    await store.selectEntity(store.search!.similar[0].id);expect(store.detail!.entity.id).toBe('KGE-SYMPTOM');
    store.categories=[];await store.applyFilters();
    expect(store.search!.total).toBe(0);expect(store.search!.similar).toEqual([]);expect(store.matchedIds).toEqual([]);
    expect(store.detail).toBeNull();expect(store.queryError).toBe('');
  });
  it('分类和类型筛选按已提交词执行，移除所属分类清理旧详情', async () => {
    const {store}=await start();store.type='Component';await store.applyFilters();
    expect(store.selectedId).toBe('KGE-POWER');
    store.categories=['网络态势知识'];store.type='';await store.applyFilters('KGE-LINK');
    expect(store.selectedId).toBe('KGE-LINK');expect(store.detail!.entity.category).toBe('网络态势知识');
    store.categories=['设备知识'];await store.applyFilters();
    expect(store.query).toBe('KGE-LINK');expect(store.search!.total).toBe(0);expect(store.detail).toBeNull();
  });
  it('返回概览保留条件，单命中也不重选；清空检索可回到全分类结果', async () => {
    const {store}=await start();store.categories=['设备知识'];store.type='Component';await store.applyFilters('KGE-POWER');
    await store.resetGraph();await store.refreshBrowse();
    expect(store.query).toBe('KGE-POWER');expect(store.type).toBe('Component');expect(store.categories).toEqual(['设备知识']);
    expect(store.selectedId).toBe('');expect(store.detail).toBeNull();expect(store.focusId).toBe('');expect(store.expandedIds).toEqual([]);
    expect(store.matchedIds).toEqual(['KGE-POWER']);
    store.type='';await store.applyFilters('');expect(store.search!.total).toBeGreaterThan(1);expect(store.selectedId).toBe('');
  });
  it('总数二十一的末页只有一项仍保留概览；翻页不改变人工聚焦对象', async () => {
    const {store}=await start();await store.applyFilters('');
    expect(store.search!.total).toBe(21);store.page=2;await store.refreshBrowse();
    expect(store.search!.items).toHaveLength(1);expect(store.selectedId).toBe('');expect(store.matchedIds).toHaveLength(21);
    await store.selectEntity(store.search!.items[0].id);const selected=store.selectedId;
    store.page=1;await store.refreshBrowse();
    expect(store.selectedId).toBe(selected);expect(store.detail!.entity.id).toBe(selected);
  });
  it('七十五个命中不遍历所有分页，只高亮图谱实际返回的六十个节点', async () => {
    const {store}=await start(),workspace=JSON.parse(JSON.stringify(store.workspace));
    const version=workspace.versions.find((v:{id:string})=>v.id===workspace.currentVersionId);
    version.entities=Array.from({length:75},(_,i)=>({...version.entities[0],id:'test-'+i}));version.relations=[];
    const search=vi.spyOn(previewService,'searchKnowledge').mockImplementation(async q=>searchKnowledgeSnapshot(workspace,q));
    const graph=vi.spyOn(previewService,'queryKnowledgeGraph').mockImplementation(async q=>queryKnowledgeSnapshot(workspace,q));
    search.mockClear();graph.mockClear();await store.applyFilters('');
    expect(store.search!.total).toBe(75);expect(store.search!.items).toHaveLength(20);expect(store.graph!.totalNodes).toBe(75);
    expect(store.matchedIds).toHaveLength(60);expect(search).toHaveBeenCalledTimes(1);expect(graph).toHaveBeenCalledTimes(1);
  });
  it('新检索优先于迟到的唯一命中，不发起旧实体聚焦', async () => {
    const {store,service}=await start(),late=deferred<KnowledgeSearch>();
    const oldResult=await service.searchKnowledge({versionId:store.current!.id,categories:store.categories,query:'KGE-POWER'});
    vi.spyOn(previewService,'searchKnowledge').mockImplementationOnce(()=>late.promise);
    const detail=vi.mocked(previewService.getKnowledgeEntity);detail.mockClear();
    const old=store.applyFilters('KGE-POWER');await store.applyFilters('KGE-STATE-');late.resolve(oldResult);await old;
    expect(store.search!.total).toBe(4);expect(store.selectedId).toBe('');expect(detail).not.toHaveBeenCalled();
  });
  it.each(['新检索','明确实体','返回概览','会话清理'] as const)('自动聚焦第二阶段迟到时，%s 优先', async action => {
    const {store,service}=await start(),late=deferred<KnowledgeDetail>(),entered=deferred<void>();
    const oldDetail=await service.getKnowledgeEntity({versionId:store.current!.id,entityId:'KGE-POWER'});
    vi.spyOn(previewService,'getKnowledgeEntity').mockImplementationOnce(()=>{entered.resolve();return late.promise;});
    const old=store.applyFilters('KGE-POWER');await entered.promise;
    if(action==='新检索')await store.applyFilters('KGE-STATE-');
    else if(action==='明确实体')await store.selectEntity('KGE-LINK',true);
    else if(action==='返回概览')await store.resetGraph();
    else store.clearForSession();
    const before=JSON.stringify({selected:store.selectedId,graph:store.graph,detail:store.detail,search:store.search});
    late.resolve(oldDetail);await old;
    expect(JSON.stringify({selected:store.selectedId,graph:store.graph,detail:store.detail,search:store.search})).toBe(before);
    expect(store.querying).toBe(false);
    if(action==='会话清理')expect(store.matchedIds).toEqual([]);
  });
  it.each(['检索','概览图谱'] as const)('首阶段%s 失败显示错误，重试仍按唯一命中聚焦', async failure => {
    const {store}=await start();await store.selectEntity('KGE-MODEL');
    if(failure==='检索')vi.mocked(previewService.searchKnowledge).mockRejectedValueOnce(new Error('检索暂不可用'));
    else vi.mocked(previewService.queryKnowledgeGraph).mockRejectedValueOnce(new Error('概览图谱暂不可用'));
    await store.applyFilters('KGE-POWER');
    expect(store.queryError).toContain('暂不可用');expect(store.detail).toBeNull();
    if(failure==='检索')expect(store.search).toBeNull();else expect(store.search!.total).toBe(1);
    expect(store.selectedId).toBe('');expect(store.matchedIds).toEqual([]);
    await store.refreshBrowse();expect(store.selectedId).toBe('KGE-POWER');expect(store.detail!.entity.id).toBe('KGE-POWER');
    expect(store.queryError).toBe('');
  });
  it.each(['图谱','详情'] as const)('单命中%s 失败保留明确错误，重试同一对象而不回退', async failure => {
    const {store}=await start();
    if(failure==='图谱') {
      vi.mocked(previewService.queryKnowledgeGraph).mockResolvedValueOnce({versionId:store.current!.id,entities:[],relations:[],totalNodes:1,totalEdges:0} as KnowledgeGraph)
        .mockRejectedValueOnce(new Error('聚焦图谱失败'));
    } else vi.mocked(previewService.getKnowledgeEntity).mockRejectedValueOnce(new Error('详情读取失败'));
    await store.applyFilters('KGE-POWER');
    expect(store.selectedId).toBe('KGE-POWER');expect(store.queryError).toContain('失败');
    if(failure==='图谱')expect(store.graph).toBeNull();else expect(store.detail).toBeNull();
    await store.refreshBrowse();expect(store.detail!.entity.id).toBe('KGE-POWER');expect(store.graph!.entities[0].id).toBe('KGE-POWER');
    expect(store.queryError).toBe('');
  });
  it('旧请求失败不能污染新结果；缺失唯一实体时明确报错并支持重试', async () => {
    const {store}=await start(),late=deferred<KnowledgeSearch>();
    vi.mocked(previewService.searchKnowledge).mockImplementationOnce(()=>late.promise);
    const old=store.applyFilters('旧条件');await store.applyFilters('KGE-LINK');
    late.reject(new Error('旧检索失败'));await old;
    expect(store.selectedId).toBe('KGE-LINK');expect(store.queryError).toBe('');
    vi.mocked(previewService.searchKnowledge).mockResolvedValueOnce({versionId:store.current!.id,items:[],total:1,page:1,code:0,similar:[]});
    await store.applyFilters('KGE-POWER');expect(store.queryError).toContain('缺少');expect(store.selectedId).toBe('');
    await store.refreshBrowse();expect(store.detail!.entity.id).toBe('KGE-POWER');
  });
  it('明确跨类实体按原规则展示，失效 ID 报错且不自动替换', async () => {
    const {store}=await start();store.categories=['设备知识'];await store.applyFilters('KGE-POWER');
    await store.selectEntity('KGE-LINK',true);
    expect(store.categories).toContain('网络态势知识');expect(store.selectedId).toBe('KGE-LINK');
    await store.selectEntity('missing',true);
    expect(store.selectedId).toBe('missing');expect(store.queryError).toBeTruthy();expect(store.detail).toBeNull();
    expect(store.graph).toBeNull();
  });
  it('会话清理后恢复首次概览，不遗留检索高亮与自动聚焦意图', async () => {
    const {store,storage}=await start();await store.applyFilters('KGE-STATE-');store.clearForSession();await store.load();
    expect(store.query).toBe('');expect(store.selectedId).toBe('');expect(store.matchedIds).toEqual([]);
    expect(store.search!.total).toBe(21);expect(storage.writes).toBe(0);
  });
});
