import { describe, expect, it } from 'vitest';
import { initialResources } from '../src/mocks/resource-presets';
import { validateGisScene, matchesGisClassification, projectGisTree } from '../src/services/gis-workspace';
import type { GisClassification } from '../src/types/gis-workspace';

const noClass: GisClassification = { mobility: '', role: '', relay: '' };
describe('GIS 分类与能力边界', () => {
  it('设备按型号频段归类，部署、角色与中继能力独立筛选', () => {
    const resources = initialResources();
    const hf = projectGisTree(resources, [], '', 'HF', false, 'devices', noClass);
    expect(hf.devices).toHaveLength(174);
    expect(hf.candidateRows.every(row => row.link.deviceClass === 'HF')).toBe(true);
    expect(new Set(hf.deviceIds).size).toBe(hf.devices.length);
    expect(hf.devices.every(d => resources.models.find(m => m.id === d.modelId)?.deviceClass === 'HF')).toBe(true);
    const counts = ['FIXED', 'VEHICLE', 'MANPACK'].map(mobility => projectGisTree(resources, [], '', 'HF', false, 'devices', { ...noClass, mobility: mobility as GisClassification['mobility'] }).devices.length);
    expect(counts).toEqual([32, 118, 24]);
    const relay = { ...resources.stations[0]!, mobility: 'VEHICLE' as const, role: 'TASK' as const, relayCapable: true };
    expect(matchesGisClassification(relay, { ...noClass, relay: 'YES' })).toBe(true);
    expect(matchesGisClassification(relay, { ...noClass, role: 'RELAY' })).toBe(false);
    expect(projectGisTree(resources, [], '', '全部', false, 'stations', noClass).stations).toHaveLength(132);
  });
  it('分页响应不能冒充完整 GIS 上下文', () => {
    // 两种来源都必须提供同一完整上下文及匹配版本。
    expect(() => validateGisScene({ revision: 'R1', items: [] } as never, 'R1')).toThrow('不完整');
    expect(() => validateGisScene({ revision: 'R2' } as never, 'R1')).toThrow('版本');
  });
});
