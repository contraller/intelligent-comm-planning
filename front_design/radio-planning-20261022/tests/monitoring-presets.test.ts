import { describe,it,expect } from 'vitest';
import { monitoringPresets } from '../src/mocks/monitoring-presets';
import { interferenceVariants } from '../src/mocks/interference-presets';
import { spectrumObservationPresets } from '../src/mocks/spectrum-observation-presets';
import { assertNetworkObservation,assertSpectrumObservation,monitoringPresetForPlan } from '../src/services/monitoring-validation';
import { monitoringFixture } from './helpers/monitoring';

// 验证关联与统计含义，避免为测试重新实现状态判断或传播算法。
describe('独立监控预设',()=>{
  it('覆盖三种可确认规划和全部九种抗干扰网络',()=>{
    expect(monitoringPresets.map(row=>row.id)).toEqual(['balanced','economical','device-balanced',...interferenceVariants.map(row=>row.id)]);
  });
  it.each(monitoringPresets.map(row=>[row.id,row] as const))('%s 四帧对象、缺失值和统计一致',(_id,preset)=>{
    expect(preset.frames).toHaveLength(4);
    expect(new Set(preset.frames.map(row=>row.id)).size).toBe(4);
    let previous=0;
    for(const frame of preset.frames){
      expect(()=>assertNetworkObservation(frame,preset)).not.toThrow();
      expect(Date.parse(frame.observedAt)).toBeGreaterThan(previous);previous=Date.parse(frame.observedAt);
      const stats=frame.statistics.devices;
      expect(stats.total).toBe(frame.devices.length);
      expect(stats.normal+stats.fault+stats.offline).toBe(stats.total);
      expect(stats.alarms).toBe(frame.devices.filter(row=>row.alarm).length);
      expect(stats.online).toBe(frame.devices.filter(row=>row.online).length);
      for(const grade of ['EXCELLENT','GOOD','WARNING','FAULT'] as const)
        expect(frame.statistics.links[grade]).toBe(frame.links.filter(row=>row.state===grade).length);
      expect(frame.statistics.power.reduce((sum,row)=>sum+row.count,0)).toBe(frame.devices.filter(row=>row.txPowerDbm!==null).length);
      expect(frame.statistics.frequency.reduce((sum,row)=>sum+row.count,0)).toBe(frame.devices.filter(row=>row.frequencyKhz!==null).length);
    }
    expect(preset.frames[1].devices.find(row=>row.deviceId==='DV-0002')).toMatchObject({status:'NORMAL',alarm:true});
    expect(preset.frames[2].devices.find(row=>row.deviceId==='DV-0038')).toMatchObject({status:'OFFLINE',txPowerDbm:null,frequencyKhz:null});
    expect(preset.frames[2].links.find(row=>row.linkId==='LINK-B')).toMatchObject({state:'FAULT',snrDb:null,throughputKbps:0});
    expect(preset.frames[3].alerts).toEqual([]);
  });
  it.each(spectrumObservationPresets.map(row=>[row.id,row] as const))('%s 频谱覆盖完整且异常来自标记',(_id,preset)=>{
    expect(preset.frames).toHaveLength(4);
    for(const frame of preset.frames)expect(()=>assertSpectrumObservation(frame,preset.minKhz,preset.maxKhz)).not.toThrow();
    expect(preset.frames.map(row=>row.abnormalBandCount)).toEqual([0,1,2,0]);
  });
  it('相同档位标签无法掩盖配置或输入被篡改',async()=>{
    const s=await monitoringFixture(),plan=structuredClone(s.plan);
    plan.workflow!.configuration.devices[0].frequencyKhz=9900;
    expect(()=>monitoringPresetForPlan(plan)).toThrow('不匹配');
    const input=structuredClone(s.plan);input.workflow!.input.demands[0].requiredRateKbps=9999;
    expect(()=>monitoringPresetForPlan(input)).toThrow('暂无监控预设');
  });
});
