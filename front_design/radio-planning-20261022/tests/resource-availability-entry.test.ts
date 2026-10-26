import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { useResourceLedgerEditStore } from '../src/stores/resource-ledger-edit';
import { useResourceReadStore } from '../src/stores/resource-read';
import { useAuthStore } from '../src/stores/auth';
import { previewService } from '../src/services';
import { createAccessService } from '../src/services/access';
import { ApiError, type PreviewService } from '../src/services/types';
import type { AuthIdentity } from '../src/types/system';

const old='resource-1111111111111111',next='resource-2222222222222222';
const identity=():AuthIdentity=>({sessionId:'session',id:'editor',username:'editor',name:'编辑者',roleId:'editor',roleName:'编辑者',epoch:'e1',revision:'r1',permissions:['resources.view','resources.device.availability']});
const context=()=>({revision:old,baseRevision:old,selectedIds:['D1','D2'],device:null,stations:[],models:[],antennas:[],impact:{planIds:['P1'],linkIds:[],description:'保留历史，不自动重算'}});
let pinia:ReturnType<typeof createPinia>|undefined;
afterEach(()=>{if(pinia)disposePinia(pinia);pinia=undefined;vi.restoreAllMocks();});
function fixture(){
  pinia=createPinia();setActivePinia(pinia);const auth=useAuthStore();auth.accept(identity());
  const read=useResourceReadStore();read.workspace={revision:old,bounds:[113,36,115,38],updatedAt:'2026-10-23T00:00:00Z',source:'构造联调',terrain:null,stats:{} as never};
  read.ledger={revision:old,pageNum:1,pageSize:5,total:2,items:[{kind:'device',id:'D1'},{kind:'device',id:'D2'}] as never};
  const load=vi.spyOn(previewService,'loadResourceMaintenanceContext').mockResolvedValue(context());
  const save=vi.spyOn(previewService,'updateDeviceAvailability').mockResolvedValue({objectId:'resource-device-availability',changed:true,revision:next,readRevision:next,affectedIds:['D1'],updated:['D1'],unchanged:['D2'],warnings:[]});
  const refresh=vi.spyOn(read,'refresh').mockImplementation(async()=>{read.workspace!.revision=next;return true;});
  return{auth,read,load,save,refresh,editor:useResourceLedgerEditStore()};
}
async function decide(f:ReturnType<typeof fixture>,choice:'save'|'cancel'){
  await vi.waitFor(()=>expect(f.editor.decision).not.toBeNull());f.editor.answer(choice);
}
describe('台账上下架确认与反馈状态',()=>{
  it('专门权限支持上下架但不支持参数、新增或整库维护，确认后回显真实分组计数',async()=>{
    const f=fixture();expect(f.editor.canEdit).toBe(false);expect(f.editor.canMaintainAll).toBe(false);expect(f.editor.canChangeAvailability).toBe(true);
    const pending=f.editor.setAvailability(['D1','D2'],'OFF_SHELF');await vi.waitFor(()=>expect(f.editor.decision).not.toBeNull());
    expect(f.editor.decision!.message).toContain('未提供链路级影响明细');expect(f.editor.decision!.message).not.toContain('链路 0 条');
    f.editor.answer('save');expect(await pending).toBe(true);
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({baseRevision:old,ids:['D1','D2'],availability:'OFF_SHELF'}));
    expect(f.editor.message).toContain('成功变更 1 台，失败 0 台，无变化 1 台');expect(f.refresh).toHaveBeenCalledOnce();
    expect(await f.editor.openForm('D1')).toBe(false);expect(await f.editor.openImport()).toBe(false);
  });
  it('取消只读预览后不发送上下架请求，保留列表',async()=>{
    const f=fixture(),pending=f.editor.setAvailability(['D1','D2'],'OFF_SHELF');await decide(f,'cancel');
    expect(await pending).toBe(false);expect(f.load).toHaveBeenCalledOnce();expect(f.save).not.toHaveBeenCalled();expect(f.read.ledger!.total).toBe(2);
  });
  it('拒绝当前页之外、重复、超限清单，不读取预览或提交',async()=>{
    const f=fixture();for(const ids of [['other'],['D1','D1'],Array.from({length:51},(_,i)=>'D'+i)])expect(await f.editor.setAvailability(ids,'OFF_SHELF')).toBe(false);
    expect(f.load).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();
  });
  it('响应丢失时复用原回执请求，不能让新资源预览挡住重放',async()=>{
    const f=fixture();f.save.mockRejectedValueOnce(new ApiError('响应丢失','NETWORK_ERROR'));
    let pending=f.editor.setAvailability(['D1','D2'],'OFF_SHELF');await decide(f,'save');expect(await pending).toBe(false);
    const request=f.save.mock.calls[0][0];expect(f.editor.error).toContain('结果未确认');
    pending=f.editor.setAvailability(['D1','D2'],'OFF_SHELF');await decide(f,'save');expect(await pending).toBe(true);
    expect(f.save.mock.calls[1][0]).toEqual(request);expect(f.load).toHaveBeenCalledOnce();
  });
  it('已确认版本冲突不当成未知成功；再次操作重新预览并生成新请求',async()=>{
    const f=fixture();f.save.mockRejectedValueOnce(new ApiError('资源已变化','RESOURCE_VERSION_CHANGED'));
    let pending=f.editor.setAvailability(['D1','D2'],'OFF_SHELF');await decide(f,'save');expect(await pending).toBe(false);
    expect(f.editor.error).toContain('整批未保存');const requestId=f.save.mock.calls[0][0].requestId;
    pending=f.editor.setAvailability(['D1','D2'],'OFF_SHELF');await decide(f,'save');expect(await pending).toBe(true);
    expect(f.load).toHaveBeenCalledTimes(2);expect(f.save.mock.calls[1][0].requestId).not.toBe(requestId);
  });
  it('保存成功而列表刷新失败时明确区分，不撤销保存成功',async()=>{
    const f=fixture();f.refresh.mockResolvedValueOnce(false);const pending=f.editor.setAvailability(['D1','D2'],'OFF_SHELF');await decide(f,'save');
    expect(await pending).toBe(true);expect(f.editor.message).toContain('保存已成功，列表刷新失败');
  });
  it('预览期间换页或撤销权限不能提交迟到结果',async()=>{
    const f=fixture();let finish!:(value:ReturnType<typeof context>)=>void;
    f.load.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}));
    const pending=f.editor.setAvailability(['D1','D2'],'OFF_SHELF');await vi.waitFor(()=>expect(f.load).toHaveBeenCalledOnce());
    f.read.ledger!.items=[];finish(context());expect(await pending).toBe(false);expect(f.save).not.toHaveBeenCalled();
    f.auth.accept({...identity(),permissions:['resources.view']});expect(f.editor.canChangeAvailability).toBe(false);
  });
  it('公开服务按预览种类分权，上下架权限不能借维护上下文修改参数',async()=>{
    const raw={getSession:async()=>identity(),loadResourceMaintenanceContext:vi.fn(async()=>context()),updateDeviceAvailability:vi.fn(async()=>({changed:false})),saveResourceChanges:vi.fn()};
    const service=createAccessService(()=>raw as unknown as PreviewService,null,()=>{});
    await service.loadResourceMaintenanceContext({context:'ledger',revision:old,ids:['D1','D2']});
    await service.updateDeviceAvailability({baseRevision:old,requestId:'R1',ids:['D1'],availability:'OFF_SHELF'});
    await expect(service.loadResourceMaintenanceContext({context:'ledger',revision:old,deviceId:'D1'})).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(service.saveResourceChanges({context:'ledger',baseRevision:old,requestId:'R1',stations:[],devices:[{id:'D1',antennaHeightM:3}]})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(raw.updateDeviceAvailability).toHaveBeenCalledOnce();expect(raw.saveResourceChanges).not.toHaveBeenCalled();
  });
});
