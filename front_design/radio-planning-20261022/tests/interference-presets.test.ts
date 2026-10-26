import { describe, expect, it } from 'vitest';
import { interferenceVariants, interferenceScenarios, interferenceDemoResult } from '../src/mocks/interference-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import { interferenceDiagnosisPresets } from '../src/mocks/interference-diagnosis-presets';
import { assertResult } from '../src/services/planning-validation';
import { initialResources } from '../src/mocks/resource-presets';

// 核对独立预设的业务关联；只检查常量，不生成算法结果。
describe('干扰预设一致性', () => {
  it.each(interferenceVariants.map(row=>[row.id,row] as const))('%s 设备、频率、路由和部署均完整', (_id,variant) => {
    const preset=planningPresets.find(row=>row.id===variant.networkPresetId)!;
    expect(()=>assertResult({...variant.result,snapshotId:'test',inputSnapshot:preset.baseline},preset.input)).not.toThrow();
    const config=variant.result.configuration, resources=initialResources();
    for(const link of variant.result.links)for(const id of [link.deviceA,link.deviceB]){
      const device=config.devices.find(row=>row.deviceId===id)!;
      expect(device.frequencyKhz).toBe(link.frequencyKhz);
      expect(config.frequencies.some(pool=>pool.allocatedKhz.includes(link.frequencyKhz)&&pool.minKhz<=link.frequencyKhz&&pool.maxKhz>=link.frequencyKhz)).toBe(true);
      expect(resources.devices.some(row=>row.id===id)).toBe(true);
    }
    expect(interferenceDiagnosisPresets.filter(row=>row.networkPresetId==='interference:'+variant.id)).toHaveLength(5);
  });
  it('所有场景的引用、统计、多源关系及三级区域一致，五类措施有完整可用实例', () => {
    const base=planningPresets[0];
    for(const scenario of interferenceScenarios){
      const result=interferenceDemoResult(scenario,base.id),impact=result.impact;
      expect(impact.summary.affectedNodeCount).toBe(impact.nodes.length);
      expect(impact.summary.affectedLinkCount).toBe(impact.links.length);
      expect(impact.summary.severeLinkCount).toBe(impact.links.filter(row=>row.level==='SEVERE').length);
      for(const row of impact.nodes)expect(base.input.stationIds).toContain(row.nodeId);
      for(const row of impact.links){expect(base.result!.links.some(link=>link.id===row.linkId)).toBe(true);expect(row.interferenceIds).toEqual(scenario.sources.map(source=>source.id));}
      if(impact.regions.length)expect(new Set(impact.regions.map(row=>row.level)).size).toBe(3);
      for(const region of impact.regions)for(const polygon of region.polygons)for(const ring of polygon){
        expect(ring.length).toBeGreaterThanOrEqual(4);expect(ring.at(-1)).toEqual(ring[0]);
        expect(ring.every(([x,y])=>Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x)<=180&&Math.abs(y)<=90)).toBe(true);
      }
    }
    const available=interferenceDemoResult(interferenceScenarios[0],'balanced').measures;
    const economical=interferenceDemoResult(interferenceScenarios[0],'economical').measures.find(row=>row.type==='ROUTE_REBUILD')!;
    expect(economical.variantId).toBeNull();expect(economical.unavailableReason).toContain('已采用');
    expect(available).toHaveLength(5);
    expect(available.every(row=>row.variantId&&row.after&&!row.unavailableReason&&interferenceVariants.some(v=>v.id===row.variantId))).toBe(true);
  });
});
