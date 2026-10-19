import { describe,it,expect,vi } from 'vitest';
import { monitoringFixture } from './helpers/monitoring';
import { createMonitoringMock } from '../src/services/monitoring-mock';
import { createResourceMock } from '../src/services/resource-mock';
import { createMockService } from '../src/services/mock';
import { TestStorage } from './helpers/storage';
import { RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY,SPECTRUM_STORAGE_KEY,SYSTEM_STORAGE_KEY } from '../src/config/demo';
import { interferenceVariants } from '../src/mocks/interference-presets';

describe('监控数据来源',()=>{
  it('无确认网络时使用独立演示；纯读取不初始化业务存储',async()=>{
    const storage=new TestStorage(),resource=createResourceMock(()=>storage),service=createMonitoringMock(()=>storage,resource.read);
    const context=await service.loadMonitoringContext(null);
    expect(context.network).toMatchObject({kind:'DEMO',planId:null,taskId:null});
    expect(context.intervalSeconds).toBe(30);
    const frame=await service.getMonitoringFrame({taskId:null,networkKey:context.network!.key,index:0});
    expect(frame.frame.devices).toHaveLength(6);expect(storage.writes).toBe(0);
    expect((await service.loadMonitoringContext('missing')).network).toBeNull();
  });
  it.each(['balanced','economical','device-balanced'])('%s 绑定具体确认版本且不改写方案/资源',async id=>{
    const s=await monitoringFixture(id),before=[...s.storage.entries],context=await s.monitoring.loadMonitoringContext(s.plan.taskId);
    expect(context.errorCode).toBeNull();expect(context.network?.planId).toBe(s.plan.id);
    for(let index=0;index<4;index++){
      const value=await s.monitoring.getMonitoringFrame({taskId:s.plan.taskId,networkKey:context.network!.key,index});
      expect(value.frame.id).toContain(context.network!.key);expect(value.index).toBe(index);
    }
    for(const index of [-1,4,1.5,NaN])await expect(s.monitoring.getMonitoringFrame({taskId:s.plan.taskId,networkKey:context.network!.key,index})).rejects.toMatchObject({code:'INVALID_FRAME'});
    expect([...s.storage.entries]).toEqual(before);
  });
  it.each(interferenceVariants.map(row=>[row.id,row] as const))('%s 新确认后切到匹配观测并拒绝旧网络请求',async(_id,variant)=>{
    const s=await monitoringFixture(variant.networkPresetId),old=await s.monitoring.loadMonitoringContext(s.plan.taskId);
    const run=await s.submit();s.advance();const adopted=await s.adopt(run.view.run.analysisId,variant.type);
    expect((await s.monitoring.loadMonitoringContext(s.plan.taskId)).network?.planId).toBe(s.plan.id);
    await s.confirm(adopted.plan.id);
    const next=await s.monitoring.loadMonitoringContext(s.plan.taskId);
    expect(next.network?.presetId).toBe(variant.id);expect(next.network?.planId).toBe(adopted.plan.id);
    await expect(s.monitoring.getMonitoringFrame({taskId:s.plan.taskId,networkKey:old.network!.key,index:1})).rejects.toMatchObject({code:'MONITORING_SOURCE_CHANGED'});
    expect((await s.monitoring.getMonitoringFrame({taskId:s.plan.taskId,networkKey:next.network!.key,index:0})).frame.devices).toHaveLength(6);
  });
  it('保存相关资源后历史化，无关修改不误伤；改回值不恢复资格',async()=>{
    const s=await monitoringFixture(),source=s.resource.read(),service=createMockService(()=>s.storage);
    await service.commitResources({baseRevision:source.meta.revision,requestId:'unrelated',stations:[{id:'ND-0100',name:'无关站点'}],devices:[]});
    expect((await s.monitoring.loadMonitoringContext(s.plan.taskId)).source.state).toBe('CURRENT');
    await service.commitResources({baseRevision:s.resource.read().meta.revision,requestId:'related',stations:[],devices:[{id:'DV-0001',antennaHeightM:17}]});
    const stale=await s.monitoring.loadMonitoringContext(s.plan.taskId);
    expect(stale.network?.planId).toBe(s.plan.id);expect(stale.source.state).toBe('HISTORICAL');
    await service.commitResources({baseRevision:s.resource.read().meta.revision,requestId:'restore',stations:[],devices:[{id:'DV-0001',antennaHeightM:source.resources.devices.find(row=>row.id==='DV-0001')!.antennaHeightM}]});
    expect((await s.monitoring.loadMonitoringContext(s.plan.taskId)).source.state).toBe('HISTORICAL');
  });
  it.each([RESOURCE_STORAGE_KEY,PLANNING_STORAGE_KEY,SYSTEM_STORAGE_KEY])('%s 不可读时来源未知，不伪造演示成功',async key=>{
    const s=await monitoringFixture();s.storage.failReadKeys.add(key);
    const context=await s.monitoring.loadMonitoringContext(s.plan.taskId);
    expect(context.source.state).toBe('UNKNOWN');expect(context.network?.kind).not.toBe('DEMO');
  });
});
describe('频谱观测资格',()=>{
  it('初始空频段需补全和检查，不改配置、不请求地址',async()=>{
    const s=await monitoringFixture(),fetcher=vi.spyOn(globalThis,'fetch');
    try{
      const initial=await s.monitoring.loadSpectrumMonitoringContext();
      expect(initial.sources.every(row=>!row.eligible)).toBe(true);expect(initial.sources[0]).not.toHaveProperty('endpoint');
      expect(s.storage.getItem(SPECTRUM_STORAGE_KEY)).toBeNull();
      await s.enableSpectrum();const sources=await s.monitoring.loadSpectrumMonitoringContext(),source=sources.sources[0],before=[...s.storage.entries];
      for(let index=0;index<4;index++)expect((await s.monitoring.getSpectrumObservationFrame({sourceId:source.id,configRevision:source.revision,index})).frame.bins).toHaveLength(4);
      expect([...s.storage.entries]).toEqual(before);expect(fetcher).not.toHaveBeenCalled();
    }finally{fetcher.mockRestore();}
  });
  it.each(['connection-failed','format-invalid'] as const)('最新 %s 检查不能被旧成功记录覆盖',async demo=>{
    const s=await monitoringFixture();await s.enableSpectrum();await s.checkSpectrum(demo);
    const source=(await s.monitoring.loadSpectrumMonitoringContext()).sources[0];expect(source.eligible).toBe(false);
    await expect(s.monitoring.getSpectrumObservationFrame({sourceId:source.id,configRevision:source.revision,index:0})).rejects.toMatchObject({code:'SPECTRUM_SOURCE_CHANGED'});
  });
  it('配置改变/停用后旧帧请求拒绝；无变化保存保持检查有效',async()=>{
    const s=await monitoringFixture();const checked=await s.enableSpectrum(),source=checked.workspace.sources[0];
    const same=await s.spectrum.saveSpectrumSource({baseRevision:checked.workspace.revision,requestId:'same',source});
    expect((await s.monitoring.loadSpectrumMonitoringContext()).sources[0].eligible).toBe(true);
    await s.spectrum.saveSpectrumSource({baseRevision:same.workspace.revision,requestId:'disable',source:{...source,enabled:false}});
    await expect(s.monitoring.getSpectrumObservationFrame({sourceId:source.id,configRevision:source.revision,index:1})).rejects.toMatchObject({code:'SPECTRUM_SOURCE_CHANGED'});
  });
  it('检查通过不代表任意频段有预设；损坏配置明确失败',async()=>{
    const s=await monitoringFixture();await s.enableSpectrum(2000,30000);
    expect((await s.monitoring.loadSpectrumMonitoringContext()).sources[0]).toMatchObject({eligible:false,reason:'该频段暂无预生成数据'});
    s.storage.entries.set(SPECTRUM_STORAGE_KEY,'bad');
    await expect(s.monitoring.loadSpectrumMonitoringContext()).rejects.toMatchObject({code:'SPECTRUM_CORRUPT'});
  });
});
