import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { useResourceReadStore } from '../src/stores/resource-read';
import { previewService } from '../src/services';
import { resourceReadMethods } from '../src/types/resource-read';
import type { ReadDevice, ResourcePage } from '../src/types/resource-read';
import { ApiError } from '../src/services/types';
import { authFixture, authorizeStore } from './helpers/auth';

let pinia:ReturnType<typeof createPinia>;
beforeEach(()=>{pinia=createPinia();setActivePinia(pinia);});
afterEach(()=>{disposePinia(pinia);vi.restoreAllMocks();});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
async function fixture(){
  const auth=authorizeStore(),s=authFixture();
  // 真实读取适配替代传输，保留 Pinia 的请求取消、版本及身份检查。
  for(const key of resourceReadMethods)vi.spyOn(previewService,key).mockImplementation(s.raw[key] as never);
  const store=useResourceReadStore();await store.activate('ledger');return{store,auth,s};
}
describe('资源读取状态隔离',()=>{
  it('规划上下文不需要台账权限，切换后地图不请求干扰源',async()=>{
    const {store,auth}=await fixture();auth.accept({...auth.identity!,permissions:['planning.view']});
    await store.activate('planning');expect(store.readable).toBe(true);expect(store.context).toBe('planning');
    expect(vi.mocked(previewService.queryResourceMap).mock.calls.at(-1)![0]).toMatchObject({context:'planning',showInterferences:false});
  });
  it('快速翻页取消前一次请求，迟到结果不覆盖最新页',async()=>{
    const {store}=await fixture(),initial=store.ledger!,one=deferred<ResourcePage<ReadDevice>>(),two=deferred<ResourcePage<ReadDevice>>();
    const query=vi.mocked(previewService.queryResourceDevices);query.mockImplementationOnce(()=>one.promise).mockImplementationOnce(()=>two.promise);
    const old=store.loadLedger({page:2}),latest=store.loadLedger({page:3});
    expect(query.mock.calls.at(-2)![0].signal?.aborted).toBe(true);
    two.resolve({...initial,page:3});await latest;one.resolve({...initial,page:2});await old;
    expect(store.ledger?.page).toBe(3);expect(store.ledgerApplied?.page).toBe(3);
  });
  it('查询失败保留上次成功页，用户重试后清除错误',async()=>{
    const {store}=await fixture(),initial=store.ledger;
    vi.mocked(previewService.queryResourceDevices).mockRejectedValueOnce(new ApiError('断网','NETWORK_ERROR'));
    await store.loadLedger({page:2});expect(store.ledger).toBe(initial);expect(store.errors.ledger).toBe('断网');expect(store.ledgerApplied?.page).toBe(1);
    await store.loadLedger({page:2});expect(store.errors.ledger).toBeUndefined();expect(store.ledger?.page).toBe(2);
  });
  it('版本冲突冻结所有读取，只有手动刷新才接纳新版本',async()=>{
    const {store}=await fixture(),old=store.ledger;
    vi.mocked(previewService.queryResourceDevices).mockRejectedValueOnce(new ApiError('版本过期','RESOURCE_VERSION_CHANGED'));
    await store.loadLedger({search:'DV',sort:'id',order:'desc',page:2});expect(store.stale).toBe(true);expect(store.ledger).toBe(old);
    const count=vi.mocked(previewService.queryResourceDevices).mock.calls.length;
    await store.loadLedger({page:3});await store.selectObject('device','DV-0001');expect(vi.mocked(previewService.queryResourceDevices)).toHaveBeenCalledTimes(count);
    expect(await store.refresh()).toBe(true);expect(store.stale).toBe(false);expect(store.ledgerQuery).toMatchObject({search:'DV',order:'desc',page:1});
  });
  it('刷新新上下文成功但分页失败时，统计与列表仍属于旧版本',async()=>{
    const {store}=await fixture(),old=store.workspace;
    vi.mocked(previewService.loadResourceReadContext).mockResolvedValueOnce({...old!,revision:'v2',stats:{...old!.stats,devices:999}});
    vi.mocked(previewService.queryResourceDevices).mockRejectedValueOnce(new ApiError('读取失败','NETWORK_ERROR'));
    expect(await store.refresh()).toBe(false);expect(store.workspace).toBe(old);expect(store.ledger?.revision).toBe(old?.revision);expect(store.refreshing).toBe(false);
  });
  it('刷新发现选中对象删除则关闭旧详情并明确通知',async()=>{
    const {store}=await fixture();await store.selectObject('device',store.ledger!.items[0].id);
    vi.mocked(previewService.getResourceObject).mockRejectedValueOnce(new ApiError('不存在','RESOURCE_NOT_FOUND'));
    expect(await store.refresh()).toBe(true);expect(store.detail).toBeNull();expect(store.selected).toBeNull();expect(store.notice).toContain('已不存在');
  });
  it('刷新期间用户关闭详情，迟到响应不会重新显示',async()=>{
    const {store}=await fixture();await store.selectObject('device',store.ledger!.items[0].id);
    const detail=store.detail!,pending=deferred<typeof detail>();vi.mocked(previewService.getResourceObject).mockReturnValueOnce(pending.promise);
    const refresh=store.refresh();await Promise.resolve();store.closeDetail();pending.resolve(detail);await refresh;expect(store.detail).toBeNull();
  });
  it('选择切换只接纳当前对象，详情关联设备通道可单独取消',async()=>{
    const {store}=await fixture();await store.selectObject('device',store.ledger!.items[0].id);const detail=store.detail!,pending=deferred<typeof detail>();
    vi.mocked(previewService.getResourceObject).mockReturnValueOnce(pending.promise);
    const old=store.selectObject('device',detail.object.id);await store.selectObject('device',store.ledger!.items[1].id);pending.resolve(detail);await old;
    expect(store.detail?.object.id).toBe(store.ledger!.items[1].id);
  });
  it('退出/清理后旧请求不能回填，工作区和筛选同时清空',async()=>{
    const {store}=await fixture(),pending=deferred<ResourcePage<ReadDevice>>(),old=store.ledger!;
    vi.mocked(previewService.queryResourceDevices).mockReturnValueOnce(pending.promise);const task=store.loadLedger({search:'旧身份'});
    store.clearForSession();pending.resolve(old);await task;expect(store.workspace).toBeNull();expect(store.ledger).toBeNull();expect(store.ledgerQuery.search).toBeUndefined();
  });
  it('权限回收保留结果并丢弃在途响应，不能继续发查询',async()=>{
    const {store,auth}=await fixture(),old=store.ledger!,pending=deferred<ResourcePage<ReadDevice>>();
    const query=vi.mocked(previewService.queryResourceDevices).mockReturnValueOnce(pending.promise),task=store.loadLedger({page:2});
    auth.accept({...auth.identity!,permissions:[]});pending.resolve({...old,page:2});await task;
    expect(store.frozen).toBe(true);expect(store.ledger?.page).toBe(1);const count=query.mock.calls.length;await store.loadLedger();expect(query).toHaveBeenCalledTimes(count);
  });
  it('地图保持当前视野，旧范围响应不能覆盖新范围，刷新不重置视野',async()=>{
    const {store}=await fixture();await store.activate('gis');const frame=store.frame!;
    const pending=deferred<typeof frame>();vi.mocked(previewService.queryResourceMap).mockReturnValueOnce(pending.promise);
    const old=store.loadMap();store.setViewport([0,0,1,1],12);await store.loadMap();pending.resolve(frame);await old;
    expect(store.frame?.bbox).toEqual([0,0,1,1]);await store.refresh();expect(store.frame?.bbox).toEqual([0,0,1,1]);expect(store.viewport?.zoom).toBe(12);
  });
});
