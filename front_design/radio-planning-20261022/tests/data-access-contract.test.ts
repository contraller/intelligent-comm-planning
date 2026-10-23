import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { createMockService } from '../src/services/mock';
import { createTaskHttp } from '../src/services/task-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import type { PageQuery, PageResult } from '../src/types/data-access';
import type { KnowledgeFilter } from '../src/types/knowledge';
import { previewService } from '../src/services';
import { useKnowledgeStore } from '../src/stores/knowledge';
import { authorizeStore, authFixture } from './helpers/auth';
import { TestStorage } from './helpers/storage';
import { initialResources } from '../src/mocks/resource-presets';
import { applyChanges, validateResources } from '../src/services/resource-validation';
import { parseResourceImport, resourceTemplate } from '../src/services/resource-files';

let pinia: ReturnType<typeof createPinia> | undefined;
afterEach(() => { if (pinia) disposePinia(pinia); pinia=undefined; vi.restoreAllMocks(); });
function knowledgeFixture() {
  pinia=createPinia();setActivePinia(pinia);authorizeStore('kg_editor');
  const storage=new TestStorage(),raw=createMockService(()=>storage);
  const target=previewService as unknown as Record<string,(...args:any[])=>Promise<any>>;
  for(const [name,method] of Object.entries(raw))vi.spyOn(target,name).mockImplementation(method);
  return {raw,storage,store:useKnowledgeStore()};
}
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;

describe('按用途的数据读取契约',()=>{
  it('外部数据命中样例 ID 也不补字段，Mock 工厂仍生成完整资料',async()=>{
    const source=initialResources(),external=structuredClone(source);
    // 保留样例 ID 并省略字段，暴露按 ID 补值或注入集合的隐式依赖。
    delete external.stations[0].subtype;delete external.devices[0].availability;delete external.interferences;
    const before=structuredClone(external);
    const draft=applyChanges(external,{stations:[{id:external.stations[0].id,name:'外部节点'}],devices:[]});
    const imported=await parseResourceImport({file:await resourceTemplate('csv','interference_sources'),kind:'interference_sources',baseRevision:'external',context:'ledger'},external,external);
    for(const candidate of [draft,imported.candidate]){
      expect(candidate.stations[0]).not.toHaveProperty('subtype');
      expect(candidate.devices[0]).not.toHaveProperty('availability');expect(candidate).not.toHaveProperty('interferences');
      expect(validateResources(candidate,external,external).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({objectId:external.stations[0].id,field:'subtype'}),
        expect.objectContaining({objectId:external.devices[0].id,field:'availability'}),
        expect.objectContaining({objectId:'interferences',field:'structure'}),
      ]));
    }
    expect(imported.issues).toContainEqual(expect.objectContaining({objectId:'interferences',field:'structure'}));expect(external).toEqual(before);
    expect(initialResources()).toEqual(source);expect(source.interferences!.length).toBeGreaterThan(0);
    expect(validateResources(source,source,source).issues).toEqual([]);
  });
  it('代表性业务共用分页字段、页大小和越界空页规则',async()=>{
    const f=authFixture();await f.login();
    const resource=await f.raw.loadResourceReadContext({context:'ledger'});
    const metadata=await f.raw.loadKnowledgeMetadata();
    const readers:((query:PageQuery)=>Promise<PageResult<unknown>>)[]=[
      q=>f.raw.queryResourceDevices({...q,context:'ledger',revision:resource.revision}),
      q=>f.raw.queryTaskSummaries({...q,context:'planning'}),
      q=>f.raw.searchKnowledgeSummaries({...q,versionId:metadata.workspace!.currentVersionId,categories:['设备知识','网络态势知识','故障运维知识']}),
      q=>f.raw.queryAccountSummaries(q),
    ];
    // 同一组边界验证覆盖各域，避免逐接口复制分页测试。
    for(const read of readers){
      const first=await read({pageNum:1,pageSize:2}),second=await read({pageNum:2,pageSize:2});
      expect(first).toMatchObject({pageNum:1,pageSize:2});expect(first).not.toHaveProperty('page');
      expect(first.items).toHaveLength(Math.min(2,first.total));
      expect(second).toMatchObject({pageNum:2,pageSize:2,total:first.total});
      expect(second.items).toHaveLength(Math.min(2,Math.max(0,first.total-2)));
      expect(await read({pageNum:first.total+1,pageSize:2})).toMatchObject({items:[],total:first.total,pageNum:first.total+1,pageSize:2});
      for(const query of [{pageNum:0,pageSize:2},{pageNum:1,pageSize:101},{pageNum:1,pageSize:1.5}])await expect(read(query)).rejects.toThrow();
    }
  });
  it('首屏元信息和绘制不携带历史全文，Mock 序列化体积小于完整响应',async()=>{
    const storage=new TestStorage(),raw=createMockService(()=>storage),workspace=await raw.loadResourceReadContext({context:'gis'});
    const [knowledge,metadata,diagnosis,context,preview,scene]=await Promise.all([
      raw.loadKnowledgeWorkspace(),raw.loadKnowledgeMetadata(),raw.loadDiagnosisWorkspace(),raw.loadDiagnosisContext(),raw.loadPreview(),
      raw.loadGisResourceScene({context:'gis',revision:workspace.revision}),
    ]);
    expect(metadata.workspace).not.toHaveProperty('versions');expect(metadata.workspace).not.toHaveProperty('changes');
    expect(context.presets.every(p=>!('result' in p)&&!('faults' in p))).toBe(true);
    expect(context.legacy.every(r=>!('network' in r)&&!('result' in r))).toBe(true);
    expect(scene.situation).not.toHaveProperty('deviceNetwork');expect(scene.situation).not.toHaveProperty('deviceCoverage');
    expect(scene.linkDetails.records).toEqual([]);
    // 先核对三个公共摘要出口均非空，避免空集合使字段边界断言虚通过。
    const query:KnowledgeFilter={versionId:metadata.workspace!.currentVersionId,categories:['设备知识','网络态势知识','故障运维知识']};
    const [hits,recommended,graph]=await Promise.all([
      raw.searchKnowledgeSummaries({...query,search:'KGE-MODEL'}),
      raw.searchKnowledgeSummaries({...query,search:'发烫'}),
      raw.getKnowledgeGraph(query),
    ]);
    for(const items of [hits.items,recommended.similar,graph.entities]){
      expect(items.length).toBeGreaterThan(0);
      for(const item of items)expect(Object.keys(item).sort()).toEqual(['category','id','name','type']);
    }
    const measurements=[['knowledge',knowledge,metadata],['diagnosis',diagnosis,context],['gis',preview,scene]].map(([purpose,before,after])=>({purpose,beforeBytes:bytes(before),afterBytes:bytes(after)}));
    // 只在内存核对载荷边界，不生成验证文件或将体积解释为 HTTP 延迟。
    expect(measurements.every(r=>r.afterBytes<r.beforeBytes)).toBe(true);
  });
  it('翻页只重读搜索，选中才读详情，设备共享元信息不启动图谱',async()=>{
    const {store}=knowledgeFixture();await store.ensureMetadata();
    expect(previewService.searchKnowledgeSummaries).not.toHaveBeenCalled();expect(previewService.getKnowledgeGraph).not.toHaveBeenCalled();
    await store.load();store.page=2;await store.refreshBrowse();
    expect(previewService.searchKnowledgeSummaries).toHaveBeenCalledTimes(2);expect(previewService.getKnowledgeGraph).toHaveBeenCalledTimes(1);
    expect(previewService.getKnowledgeEntity).not.toHaveBeenCalled();
    await store.selectEntity('KGE-MODEL');expect(store.detail?.entity.id).toBe('KGE-MODEL');
    expect(previewService.searchKnowledgeSummaries).toHaveBeenCalledTimes(2);expect(previewService.getKnowledgeEntity).toHaveBeenCalledTimes(1);
  });
  it('同一任务查询参数在 Mock 和 HTTP 适配后得到同一摘要',async()=>{
    const storage=new TestStorage(),raw=createMockService(()=>storage),options={context:'planning' as const};
    const catalog=await raw.loadPlanningOptions(options),preset=await raw.getPlanningPreset({...options,presetId:catalog.presets[0].id});
    const resource=await raw.loadResourceReadContext(options);
    const saved=await raw.saveTaskInput({...options,taskId:'CONTRACT-TASK',revision:null,resourceRevision:resource.revision,requestId:'contract-save',input:preset.defaults});
    const query={...options,search:'CONTRACT',pageNum:1,pageSize:10},expected=await raw.queryTaskSummaries(query);
    const wire={task_id:saved.taskId,revision:saved.revision,input_version:saved.inputVersion,condition_version:saved.conditionVersion,resource_revision:saved.resourceRevision,input:saved.input,updated_at:saved.updatedAt,active_job_id:saved.activeJobId};
    const request=vi.fn(async(_path:string)=>({items:[wire],total:1,page:1,page_size:10}));
    const actual=await createTaskHttp(request as AuthenticatedRequest).queryTaskSummaries(query);
    expect(actual).toEqual(expected);expect(actual.items[0]).not.toHaveProperty('input');
    expect(request.mock.calls[0]?.[0]).toBe('/task-inputs?context=planning&page=1&page_size=10&search=CONTRACT');
  });
  it('写入已成功而详情读取失败时保留受理状态，重读前不能再次提交',async()=>{
    const {raw,store}=knowledgeFixture();await store.load();
    const entity=(await raw.getKnowledgeEntity({versionId:store.current!.id,entityId:'KGE-OPERATION'})).entity;
    await store.newChange(entity);store.draft!.summary='契约回归';store.draft!.entities[0].description+='；补充记录。';
    vi.mocked(previewService.getKnowledgeChange).mockRejectedValueOnce(new Error('详情暂不可读'));
    expect(await store.saveDraft()).toBe(true);expect(store.notice).toContain('读取失败');expect(store.dirtyDraft).toBe(false);
    expect(await store.saveDraft()).toBe(false);expect(previewService.saveKnowledgeReceipt).toHaveBeenCalledTimes(1);
    await store.load();expect(store.receiptPending).toBe(false);expect(store.change?.content.summary).toBe('契约回归');
    // 重读恢复后再次保存无改动的同一单据，不新增修订或重复创建。
    const id=store.changeId,revision=store.change!.revision;
    expect(await store.saveDraft()).toBe(true);expect(store.changeId).toBe(id);expect(store.change!.revision).toBe(revision);
  });
});
