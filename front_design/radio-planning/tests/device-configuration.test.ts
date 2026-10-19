import { describe, expect, it } from 'vitest';
import { initialResources } from '../src/mocks/resource-presets';
import details from '../src/mocks/device-details.json';
import { initialMeta } from '../src/services/resource-storage';
import { createDeviceConfigurationMock } from '../src/services/device-configuration-mock';
import type { ConfigurationSubmit } from '../src/types/device-configuration';
import { TestStorage } from './helpers/storage';

// 使用既有型号资料核对独立预设，不改原始数据或旧 fixture。
async function setup(modelId='DM-0004'){
  const resources=initialResources(),storage=new TestStorage();resources.devices[0]!.modelId=modelId;
  const api=createDeviceConfigurationMock(()=>storage,()=>({resources,meta:initialMeta()}),details),context=await api.loadDeviceConfigurationContext({context:'ledger',deviceId:resources.devices[0]!.id});
  const request:ConfigurationSubmit={context:'ledger',deviceId:context.deviceId,modelId:context.modelId,resourceEpoch:context.resourceEpoch,deviceVersion:context.deviceVersion,presetVersion:context.presets[0]!.version,values:context.presets[0]!.values,scenario:'success',requestId:'test'};
  return {resources,storage,api,context,request};
}
describe('设备配置契约与固定组合',()=>{
  it.each(Array.from({length:16},(_,i)=>'DM-'+String(i+1).padStart(4,'0')))('%s 两套预设符合型号资料，校验零写入',async id=>{
    const s=await setup(id);expect(s.context.presets).toHaveLength(2);
    for(const p of s.context.presets){expect(s.context.powerLevels).toContain(p.values.txPowerDbm);expect(p.values.workFreqKhz).toBeGreaterThanOrEqual(s.context.model.freqMinKhz);expect(p.values.workFreqKhz).toBeLessThanOrEqual(s.context.model.freqMaxKhz);expect((await s.api.validateDeviceConfiguration({...s.request,values:p.values})).valid).toBe(true);}
    expect(s.storage.writes).toBe(0);expect(s.context.source).toContain('非出厂');
  });
  it.each([null,undefined,NaN,Infinity,-Infinity,'51.76'])('非法功率 %s 在复制前拒绝',async value=>{
    const s=await setup();await expect(s.api.validateDeviceConfiguration({...s.request,values:{...s.request.values,txPowerDbm:value as number}})).rejects.toMatchObject({code:'INVALID_CONFIGURATION'});expect(s.storage.writes).toBe(0);
  });
  it('0 和负功率是数值而非缺失，按型号档位拒绝；频率越界有字段问题',async()=>{
    const s=await setup();for(const power of [0,-1,999]){const r=await s.api.validateDeviceConfiguration({...s.request,values:{...s.request.values,txPowerDbm:power}});expect(r.valid).toBe(false);expect(r.issues.some(i=>i.field==='txPowerDbm')).toBe(true);}
    const r=await s.api.validateDeviceConfiguration({...s.request,values:{...s.request.values,workFreqKhz:0}});expect(r.issues.some(i=>i.field==='workFreqKhz')).toBe(true);
  });
  it('非预设不自动成功，旧台账 51.8 不取整，恢复默认值与实例值分离',async()=>{
    const s=await setup(),before=JSON.stringify(s.resources);expect(s.context.device.txPowerDbm).toBe(51.8);expect(s.context.presets[0]!.values.txPowerDbm).toBe(51.76);
    await expect(s.api.validateDeviceConfiguration({...s.request,values:{...s.request.values,workFreqKhz:12345}})).rejects.toMatchObject({code:'NO_PRESET'});expect(JSON.stringify(s.resources)).toBe(before);
  });
  it('未知型号没有默认值，不存在设备或非法上下文拒绝',async()=>{
    const s=await setup();s.resources.models.push({...s.resources.models[0]!,id:'CUSTOM'});s.resources.devices[0]!.modelId='CUSTOM';
    const c=await s.api.loadDeviceConfigurationContext({context:'gis',deviceId:s.context.deviceId});expect(c.defaultPresetId).toBeNull();expect(c.presets).toEqual([]);
    await expect(s.api.loadDeviceConfigurationContext({context:'gis',deviceId:'missing'})).rejects.toMatchObject({code:'CONFIGURATION_DEVICE_MISSING'});
    await expect(s.api.validateDeviceConfiguration({...s.request,context:'planning' as never})).rejects.toMatchObject({code:'INVALID_CONFIGURATION'});
  });
});
