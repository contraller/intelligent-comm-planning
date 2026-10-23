import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import { createResourceMaintenanceHttp } from '../src/services/resource-maintenance-http';
import { decodePage } from '../src/services/resource-read-validation';
import { ApiError } from '../src/services/types';

const old='resource-1111111111111111',next='resource-2222222222222222';
const query=()=>({context:'ledger' as const,revision:old,ids:['D1','D2']});
const input=()=>({baseRevision:old,requestId:'request-1',ids:['D1','D2'],availability:'OFF_SHELF' as const});
const preview=()=>({revision:old,base_revision:old,selected_ids:['D1','D2'],device:null,stations:[],models:[],antennas:[],impact:{plan_ids:['P1'],link_ids:[],description:'未提供链路级影响明细'}});
const receipt=()=>({object_id:'resource-device-availability',changed:true,revision:next,read_revision:next,updated:['D1'],unchanged:['D2'],affected_ids:['D1'],warnings:[]});
function fixture(data:unknown){const request=vi.fn<AuthenticatedRequest>().mockResolvedValue(data);return{request,api:createResourceMaintenanceHttp(request as AuthenticatedRequest)}}
describe('设备上下架 HTTP 边界',()=>{
  it('按明确设备清单预览，单条参数查询不改为批量读取',async()=>{
    const f=fixture(preview()),data=await f.api.loadResourceMaintenanceContext(query());
    expect(data).toMatchObject({device:null,selectedIds:['D1','D2'],revision:old,impact:{planIds:['P1'],linkIds:[]}});
    expect(f.request.mock.calls[0][0]).toBe('/resource/device-availability/preview');
    expect(JSON.parse(f.request.mock.calls[0][1]!.body as string)).toEqual({context:'ledger',revision:old,ids:['D1','D2']});
  });
  it('提交只携带上下架字段，响应按原清单完整分成更新与无变化两组',async()=>{
    const f=fixture(receipt()),data=await f.api.updateDeviceAvailability(input());
    expect(f.request.mock.calls[0][0]).toBe('/resource/device-availability');
    expect(JSON.parse(f.request.mock.calls[0][1]!.body as string)).toEqual({context:'ledger',base_revision:old,request_id:'request-1',ids:['D1','D2'],availability:'OFF_SHELF'});
    expect(data).toMatchObject({revision:next,updated:['D1'],unchanged:['D2'],affectedIds:['D1']});
  });
  it('无实际变化必须保留版本，不能凭空生成新版本或遗漏清单',async()=>{
    const noChange={...receipt(),changed:false,revision:old,read_revision:old,updated:[],unchanged:['D1','D2'],affected_ids:[]};
    expect((await fixture(noChange).api.updateDeviceAvailability(input())).changed).toBe(false);
    for(const patch of [{revision:next,read_revision:next},{unchanged:['D1']},{updated:['D1']},{affected_ids:['D1']}])
      await expect(fixture({...noChange,...patch}).api.updateDeviceAvailability(input())).rejects.toMatchObject({code:'INVALID_RESOURCE_RESPONSE'});
  });
  it.each([{ids:[]},{ids:['D1','D1']},{ids:Array.from({length:51},(_,i)=>'D'+i)},{ids:[1]},{availability:'FAULT'},
    {availability:false},{requestId:undefined},{context:'gis'},{actorId:'admin'},{devices:[]}])('非法或越权字段发送前拒绝 %j',async patch=>{
    const f=fixture(receipt());await expect(f.api.updateDeviceAvailability({...input(),...patch} as never)).rejects.toMatchObject({code:'VALIDATION_ERROR'});expect(f.request).not.toHaveBeenCalled();
  });
  it('拒绝错版预览、错设备、虚假链路影响及完整资源泄露',async()=>{
    for(const patch of [{revision:next},{base_revision:next},{selected_ids:['D1','other']},{selected_ids:['D1','D1']},
      {device:{}},{stations:[{}]},{impact:{...preview().impact,link_ids:['L1']}}])
      await expect(fixture({...preview(),...patch}).api.loadResourceMaintenanceContext(query())).rejects.toMatchObject({code:'INVALID_RESOURCE_RESPONSE'});
  });
  it('拒绝回执混入其他设备、重叠分组、假计数或版本回显错误',async()=>{
    for(const patch of [{object_id:'other'},{read_revision:old},{changed:false},{updated:['other']},{unchanged:['D1']},
      {affected_ids:[]},{updated:['D1','D1']},{warnings:[{}]}])
      await expect(fixture({...receipt(),...patch}).api.updateDeviceAvailability(input())).rejects.toMatchObject({code:'INVALID_RESOURCE_RESPONSE'});
  });
  it.each([[1205,'RESOURCE_VERSION_CHANGED'],[1206,'REQUEST_CONFLICT'],[1002,'RESOURCE_NOT_FOUND']])('错误 %s 显式反馈且不自动重发',async(code,expected)=>{
    const f=fixture(null);f.request.mockRejectedValue(new ApiError('明确失败',Number(code),null,'trace',409));
    await expect(f.api.updateDeviceAvailability(input())).rejects.toMatchObject({code:expected,requestId:'trace'});expect(f.request).toHaveBeenCalledOnce();
  });
  it('资源分页必须真正满足上下架筛选，前端不能补筛后伪报全库数量',()=>{
    const row={device_id:'D1',node_id:'N1',model_id:'M1',antenna_id:'A1',node_name:'节点',node_lon:114,node_lat:37,
      model_name:'型号',antenna_name:'天线',device_class:'HF',status:'NORMAL',availability:'OFF_SHELF'};
    const dto={revision:old,page:1,page_size:5,total:1,items:[row]};
    const q={context:'ledger' as const,revision:old,pageNum:1,pageSize:5,availability:'OFF_SHELF' as const};
    expect(decodePage('device',dto,q).total).toBe(1);
    expect(()=>decodePage('device',{...dto,items:[{...row,availability:'ACTIVE'}]},q)).toThrow('availability');
  });
});
