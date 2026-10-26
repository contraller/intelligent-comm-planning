import { describe, expect, it } from 'vitest';
import { createMockService } from '../src/services/mock';
import { initialResources } from '../src/mocks/resource-presets';
import { applyChanges, createNewForm, formChanges, validResourceTime } from '../src/services/resource-validation';
import { RESOURCE_STORAGE_KEY } from '../src/config/demo';
import { TestStorage } from './helpers/storage';

function fixture() {
  const storage = new TestStorage();
  return { storage, service: createMockService(() => storage) };
}
function newStation() {
  const form = createNewForm('station', initialResources());
  Object.assign(form.fields, { name:'手工固定站', longitude:'114.8', latitude:'37.5' });
  return formChanges(form);
}
describe('第七批资源维护事务', () => {
  it('空站点保存失败重试保持 ID，新增设备后更新同一站点版本', async () => {
    const { service, storage } = fixture(), changes = newStation();
    const request = { baseRevision:'initial', requestId:'new-station', ...changes };
    storage.failWrite = true;
    await expect(service.commitResources(request)).rejects.toMatchObject({code:'STORAGE_WRITE_FAILED'});
    expect(storage.entries.size).toBe(0);
    storage.failWrite = false;
    const saved = await service.commitResources(request), id = changes.newStations![0].id;
    expect(saved.resources.stations.find(s => s.id === id)).toMatchObject({origin:'MANUAL', status:'OFFLINE'});
    expect(saved.resources.devices.filter(d => d.stationId === id)).toEqual([]);
    // 新增测试设备不继承原实例的端口清单，仍验证原有站点版本更新。
    const device = {...saved.resources.devices[0], ports:undefined, id:'manual-device', stationId:id, origin:'MANUAL' as const, txPowerDbm:40};
    const second = await service.commitResources({baseRevision:saved.meta.revision,requestId:'new-device',stations:[],devices:[],newDevices:[device]});
    expect(second.meta.stationVersions[id]).toBe(second.meta.revision);
    expect((await service.loadPreview()).resources.devices.find(d=>d.id===device.id)?.stationId).toBe(id);
  });
  it('批量下架原子写入，重试返回原计数，恢复保留 ID 和历史变更标记', async () => {
    const {service,storage}=fixture();
    const request={baseRevision:'initial',requestId:'down',ids:['DV-0001','DV-0002'],availability:'OFF_SHELF' as const};
    const before=(await service.loadPreview()).resources.devices[0];
    const saved=await service.setDeviceAvailability(request);
    expect(saved.updated).toEqual(request.ids);expect(saved.unchanged).toEqual([]);
    expect(storage.writes).toBe(1);
    const retry=await service.setDeviceAvailability(request);
    expect(retry.updated).toEqual(saved.updated);expect(storage.writes).toBe(1);
    expect(retry.resources.devices[0]).toEqual({...before,availability:'OFF_SHELF'});
    const noChange=await service.setDeviceAvailability({...request,baseRevision:saved.meta.revision,requestId:'unchanged'});
    expect(noChange.changed).toBe(false);expect(noChange.unchanged).toEqual(request.ids);
    const restored=await service.setDeviceAvailability({...request,baseRevision:saved.meta.revision,requestId:'restore',availability:'ACTIVE'});
    expect(restored.resources.devices[0].id).toBe(before.id);
    expect(restored.meta.changedDeviceIds).toContain(before.id);
    expect(restored.meta.stationVersions[before.stationId]).toBe(restored.meta.revision);
  });
  it.each([[['DV-0001','missing']],[['DV-0001','DV-0001']]])('清单 %j 任一错误整批拒绝', async ids => {
    const {service,storage}=fixture();
    await expect(service.setDeviceAvailability({baseRevision:'initial',requestId:'bad',ids,availability:'OFF_SHELF'})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(storage.writes).toBe(0);
  });
  it('上下架失败、冲突、重复请求内容变化均不覆盖原记录',async()=>{
    const {service,storage}=fixture();
    const request={baseRevision:'initial',requestId:'down',ids:['DV-0001'],availability:'OFF_SHELF' as const};
    storage.failWrite=true;
    await expect(service.setDeviceAvailability(request)).rejects.toMatchObject({code:'STORAGE_WRITE_FAILED'});
    expect(storage.writes).toBe(0);storage.failWrite=false;
    await service.setDeviceAvailability(request);const saved=storage.getItem(RESOURCE_STORAGE_KEY);
    await expect(service.setDeviceAvailability({...request,requestId:'stale',availability:'ACTIVE'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    await expect(service.setDeviceAvailability({...request,availability:'ACTIVE'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
    expect(storage.getItem(RESOURCE_STORAGE_KEY)).toBe(saved);
  });
  it('普通编辑和新增入口不能旁路上下架或修改只读关联',async()=>{
    const {service,storage}=fixture(),source=initialResources();
    for(const patch of [{availability:'OFF_SHELF'},{stationId:'ND-0002'},{modelId:source.devices[1].modelId},{tiltDeg:5}])
      await expect(service.commitResources({baseRevision:'initial',stations:[],devices:[{id:'DV-0001',...patch}] as never})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    await expect(service.commitResources({baseRevision:'initial',stations:[],devices:[],newDevices:[{...source.devices[0],id:'bad',origin:'MANUAL',availability:'OFF_SHELF',txPowerDbm:40}]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    expect(storage.writes).toBe(0);
  });
  it('新设备不继承来源超限例外；手工新增仅允许固定站',async()=>{
    const {service}=fixture(),source=initialResources();
    await expect(service.commitResources({baseRevision:'initial',stations:[],devices:[],newDevices:[{...source.devices[0],id:'new-device',origin:'MANUAL'}]})).rejects.toMatchObject({code:'VALIDATION_ERROR'});
    const form=createNewForm('station',source);form.fields.subtype='I_MOBILE';
    expect(()=>formChanges(form)).toThrow('固定站');
  });
  it('重复干扰源变更不以最后一行覆盖，ID 作为不透明字符串',()=>{
    const source=initialResources(),id=source.interferences![0].id;
    expect(()=>applyChanges(source,{stations:[],devices:[],interferences:[{id,name:'A'},{id,name:'B'}]})).toThrow();
    const changes=newStation();changes.newStations![0].id='自建站 / A:1';
    expect(applyChanges(source,changes).stations.at(-1)?.id).toBe('自建站 / A:1');
  });
  it.each(['2026-02-30T12:00:00Z','2026-10-03T12:00:00','bad'])('安装日期拒绝归一化/无时区：%s',value=>{
    expect(validResourceTime(value)).toBe(false);
  });
});
