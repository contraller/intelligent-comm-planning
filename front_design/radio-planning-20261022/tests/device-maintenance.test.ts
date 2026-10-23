import {describe,it,expect,vi} from 'vitest';
import {createMockService} from '../src/services/mock';
import {TestStorage} from './helpers/storage';
import {authFixture} from './helpers/auth';
import {createAccessService} from '../src/services/access';
import {httpService} from '../src/services/http';

// 验证公开服务的原子保存边界，不复制组件实现来制造通过。
describe('实例端口维护与模式契约',()=>{
  async function setup(){const storage=new TestStorage(),api=createMockService(()=>storage),workspace=await api.loadResourceReadContext({context:'ledger'}),query={context:'ledger' as const,deviceId:'DV-0001',revision:workspace.revision};return {storage,api,query};}
  it('按需返回实例端口和观测，列表不运输端口全文',async()=>{
    const {api,query}=await setup(),detail=await api.getDeviceMaintenance(query);
    expect(detail.device.ports).toHaveLength(2);expect(detail.observations[0].observedAt).toBeTruthy();
    const page=await api.queryResourceDevices({...query,pageNum:1,pageSize:20});expect(page.items.every(row=>!Object.hasOwn(row,'ports'))).toBe(true);
    expect((await api.getDeviceMaintenance({...query,deviceId:'DV-0003'})).device.ports).toBeUndefined();
  });
  it('单设备批量任何一项无效均不写入，端口身份和观测不能编辑',async()=>{
    const {storage,api,query}=await setup(),detail=await api.getDeviceMaintenance(query),ports=structuredClone(detail.device.ports!);
    ports[0].rateKbps=12;ports[1].rateKbps=-1;
    await expect(api.saveResourceChanges({baseRevision:'initial',stations:[],devices:[{id:query.deviceId,ports}],context:'ledger',requestId:'invalid-batch'})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(storage.writes).toBe(0);ports[1].rateKbps=64;ports[0].id='foreign';
    await expect(api.saveResourceChanges({baseRevision:'initial',stations:[],devices:[{id:query.deviceId,ports}]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(storage.writes).toBe(0);
  });
  it('保存模式和端口生成设备新版本，观测保持不变且不自动下发',async()=>{
    const {api,query}=await setup(),detail=await api.getDeviceMaintenance(query),ports=structuredClone(detail.device.ports!);ports[0].rateKbps=12;
    const result=await api.saveResourceChanges({baseRevision:'initial',stations:[],devices:[{id:query.deviceId,currentWorkMode:'MOCK_FIXED',ports}],context:'ledger',requestId:'maintenance-save'});
    const saved=await api.getDeviceMaintenance({...query,revision:result.readRevision});expect(saved.device.currentWorkMode).toBe('MOCK_FIXED');expect(saved.device.ports![0].rateKbps).toBe(12);expect(saved.observations).toEqual(detail.observations);
    expect((await api.queryDeviceConfigurationHistory({context:'ledger',deviceId:query.deviceId,pageNum:1,pageSize:20})).total).toBe(0);
  });
  it('拒绝无清单设备新增端口、未知模式和过期读取',async()=>{
    const {api,query}=await setup(),detail=await api.getDeviceMaintenance(query);
    await expect(api.saveResourceChanges({baseRevision:'initial',stations:[],devices:[{id:'DV-0003',ports:detail.device.ports}]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await expect(api.saveResourceChanges({baseRevision:'initial',stations:[],devices:[{id:query.deviceId,currentWorkMode:'SDR'}]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await expect(api.getDeviceMaintenance({...query,revision:'old'})).rejects.toMatchObject({code:'RESOURCE_VERSION_CHANGED'});
  });
});

describe('维护服务权限和 HTTP 边界',()=>{
  const methods=['getDeviceMaintenance','queryDeviceHistory','getDeviceHistory','previewDeviceRestore','getDeviceNetworkDetail'] as const;
  it.each(methods)('%s 未登录先拒绝，不发未确认的 HTTP 请求',async name=>{
    const s=authFixture();await expect((s.service[name] as Function)()).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    const fetch=vi.spyOn(globalThis,'fetch');try{await expect((httpService[name] as Function)()).rejects.toMatchObject({code:'NOT_IMPLEMENTED'});expect(fetch).not.toHaveBeenCalled();}finally{fetch.mockRestore();}
  });
  it('资源只读账号可以看端口和链路，不可借 GIS 上下文或恢复入口扩大权限',async()=>{
    const s=authFixture(),actor=await s.login('viewer'),raw={...s.raw,getSession:async()=>({...actor,permissions:['resources.view'] as typeof actor.permissions})},api=createAccessService(()=>raw,null,()=>{});
    const workspace=await api.loadResourceReadContext({context:'ledger'}),query={context:'ledger' as const,deviceId:'DV-0001',revision:workspace.revision};
    expect((await api.getDeviceMaintenance(query)).device.id).toBe(query.deviceId);
    expect((await api.getDeviceNetworkDetail({...query,snapshotId:'NET-DEMO-03',kind:'link',id:'PL-001'})).link?.id).toBe('PL-001');
    await expect(api.getDeviceMaintenance({...query,context:'gis'})).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(api.previewDeviceRestore({...query,historyId:'unknown'})).rejects.toMatchObject({code:'FORBIDDEN'});
  });
});
