import { describe, expect, it, vi } from 'vitest';
import { createResourceMaintenanceHttp } from '../src/services/resource-maintenance-http';
import type { AuthenticatedRequest } from '../src/services/auth-http';
import type { ResourceCommit } from '../src/types/resource-edit';
import { ApiError } from '../src/services/types';

const old = 'resource-1111111111111111', next = 'resource-2222222222222222';
const device = () => ({ device_id:'D1',node_id:'N1',model_id:'M1',antenna_id:'A1',node_name:'节点一',node_lon:114,node_lat:37,
  model_name:'短波型号',antenna_name:'天线一',device_class:'HF',status:'NORMAL',alert:false,origin:'SOURCE',availability:'ACTIVE',
  antenna_height_m:8,tx_power_dbm:30,work_freq_khz:null,install_time:'' });
function context() {
  return {revision:old,base_revision:old,device:device(),stations:[{node_id:'N1',node_name:'节点一',lon:114,lat:37,parent_node_id:'',echelon:'I',mobility:'FIXED',device_class:'HF',status:'NORMAL',alert:false,relay_capable:true,is_key:false,child_count:0,device_count:1}],
    models:[{model_id:'M1',model_name:'短波型号',device_class:'HF',freq_min_khz:2000,freq_max_khz:30000,tx_power_max_dbm:50,modulation:'AM',work_mode:'SIMPLEX'}],
    antennas:[{antenna_id:'A1',antenna_name:'天线一'}],impact:{plan_ids:[],link_ids:[],description:'旧方案保留历史，不自动重算'}};
}
const input = (): ResourceCommit => ({context:'ledger',baseRevision:old,requestId:'request-1',stations:[],devices:[{id:'D1',antennaHeightM:9,txPowerDbm:30,workFreqKhz:null}]});
const receipt = () => ({object_id:'D1',changed:true,revision:next,read_revision:next,device:{...device(),antenna_height_m:9},affected_ids:['D1'],warnings:[]});
function service(value: unknown) {
  const request = vi.fn<AuthenticatedRequest>().mockResolvedValue(value);
  return { request, api:createResourceMaintenanceHttp(request as AuthenticatedRequest) };
}
describe('单设备维护 HTTP 契约', () => {
  it('上下文按设备和版本查询，只解码关联记录，保留空工作频率', async () => {
    const s = service(context());
    const result = await s.api.loadResourceMaintenanceContext({context:'ledger',revision:old,deviceId:'D1',ids:undefined});
    expect(result.device).toMatchObject({id:'D1',stationId:'N1',antennaHeightM:8,workFreqKhz:null});
    expect(result.models[0].txPowerMaxDbm).toBe(50);
    expect(result.stations).toHaveLength(1);
    const query = new URL(String(s.request.mock.calls[0][0]), 'http://local').searchParams;
    expect(Object.fromEntries(query)).toEqual({context:'ledger',revision:old,device_id:'D1'});
  });
  it('提交地址和字段精确映射，不把 dBm 或 kHz 转换为其他单位', async () => {
    const s = service(receipt()), result = await s.api.saveResourceChanges(input());
    expect(s.request.mock.calls[0][0]).toBe('/resource/changes');
    expect(JSON.parse(s.request.mock.calls[0][1]!.body as string)).toEqual({context:'ledger',base_revision:old,request_id:'request-1',stations:[],devices:[{id:'D1',antenna_height_m:9,tx_power_dbm:30,work_freq_khz:null}]});
    expect(result).toMatchObject({changed:true,revision:next,readRevision:next,affectedIds:['D1'],device:{antennaHeightM:9}});
  });
  it('无变化必须回原版本；警告不能关联其他设备或只读字段', async () => {
    const data = {...receipt(),changed:false,revision:old,read_revision:old,affected_ids:[]};
    expect((await service(data).api.saveResourceChanges(input())).changed).toBe(false);
    for (const patch of [{revision:next,read_revision:next},{affected_ids:['D1']},{warnings:[{object_id:'other',field:'txPowerDbm',message:'bad'}]}])
      await expect(service({...data,...patch}).api.saveResourceChanges(input())).rejects.toMatchObject({code:'INVALID_RESOURCE_RESPONSE'});
  });
  it('拒绝旧版本、错误关联、错误数字类型和缺少字典的成功包络', async () => {
    for (const patch of [{revision:next},{base_revision:next},{device:{...device(),device_id:'other'}},{models:[]},
      {device:{...device(),node_id:'other'}},{device:{...device(),tx_power_dbm:'30'}}])
      await expect(service({...context(),...patch}).api.loadResourceMaintenanceContext({context:'ledger',revision:old,deviceId:'D1'})).rejects.toMatchObject({code:'INVALID_RESOURCE_RESPONSE'});
    for (const patch of [{device:{...device(),antenna_height_m:7}},{object_id:'other'},{read_revision:old},{changed:'true'},{affected_ids:['other']}])
      await expect(service({...receipt(),...patch}).api.saveResourceChanges(input())).rejects.toMatchObject({code:'INVALID_RESOURCE_RESPONSE'});
  });
  it('只允许单设备三个字段，其他操作和非法数字在发送前拒绝', async () => {
    const s = service(receipt());
    for (const patch of [{context:'gis'},{requestId:undefined},{devices:[]},{devices:[...input().devices,...input().devices]},
      {devices:[{id:'D1',antennaHeightM:NaN}]},{devices:[{id:'D1',antennaHeightM:-1}]},{devices:[{id:'D1',txPowerDbm:true}]},
      {devices:[{id:'D1',workFreqKhz:0}]},{devices:[{id:'D1',currentWorkMode:'AM'}]},{restoreFrom:{}},{newDevices:[]}])
      await expect(s.api.saveResourceChanges({...input(),...patch} as ResourceCommit)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    for (const patch of [{deviceId:undefined},{ids:['D1']},{context:'gis'}])
      await expect(s.api.loadResourceMaintenanceContext({context:'ledger',revision:old,deviceId:'D1',...patch} as never)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(s.request).not.toHaveBeenCalled();
  });
  it.each([[1205,'RESOURCE_VERSION_CHANGED'],[1206,'REQUEST_CONFLICT'],[1001,'VALIDATION_ERROR'],[1002,'RESOURCE_NOT_FOUND']])('映射拒绝码 %s，不自动重发', async (code, expected) => {
    const s = service(null);
    s.request.mockRejectedValue(new ApiError('明确失败', Number(code), null, 'trace', 409));
    await expect(s.api.saveResourceChanges(input())).rejects.toMatchObject({code:expected,requestId:'trace'});
    expect(s.request).toHaveBeenCalledTimes(1);
  });
});
