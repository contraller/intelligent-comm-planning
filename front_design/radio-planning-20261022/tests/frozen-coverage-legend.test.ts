import { describe, expect, it } from 'vitest';
import { gisExampleFrame } from '../src/composables/useGisSituation';
import { frozenCoverageLegend } from '../src/services/frozen-coverage-legend';
import type { FrozenCoverageOverlay } from '../src/types/frozen-coverage';

function example(): FrozenCoverageOverlay {
  const frame = gisExampleFrame(), cache = structuredClone(frame.coverage!);
  return { anchor: cache.anchor, result: cache.result!, deviceId: 'EXAMPLE-ND-0036-VUHF', display: 'field',
    bandwidthSelection: { selectionId: cache.bandwidth_selection_id!, selectionHash: cache.bandwidth_selection_hash! } };
}

describe('首页场强图例的实际显示范围', () => {
  it('未显示覆盖或设备不可计算时不提供图例', () => {
    expect(frozenCoverageLegend(null)).toBeNull();
    const overlay = example(); overlay.deviceId = 'not-in-this-result';
    expect(frozenCoverageLegend(overlay)).toBeNull();
  });
  it('只统计当前设备真正绘制的同版达标局地格面，不混入其他设备和解释数据', () => {
    const overlay = example(), device = overlay.result.devices.find(d => d.device_id === overlay.deviceId)!;
    const part = device.computations.find(p => p.shape === 'CELLS')!;
    const valid = part.geojson.features.find(f => f.geometry && f.properties.is_coverage)!;
    const first = structuredClone(valid), second = structuredClone(valid), uncovered = structuredClone(valid), wrongDevice = structuredClone(valid);
    first.properties.field_strength_dbuvm = -5; second.properties.field_strength_dbuvm = 0;
    uncovered.properties.is_coverage = false; uncovered.properties.field_strength_dbuvm = -999;
    wrongDevice.properties.device_id = 'another-device'; wrongDevice.properties.field_strength_dbuvm = 999;
    part.geojson.features = [first, second, uncovered, wrongDevice]; device.computations = [part];
    expect(frozenCoverageLegend(overlay)).toMatchObject({ range: '-5.0–0.0', cells: 2, deviceId: overlay.deviceId, local: true });
    expect(overlay.result.devices.find(d => d.device_id === overlay.deviceId)?.computations[0]?.geojson.features).toHaveLength(4);
  });
  it('没有达标格面时明确无范围，不补零场强', () => {
    const overlay = example(), device = overlay.result.devices.find(d => d.device_id === overlay.deviceId)!;
    device.computations.forEach(part => { part.geojson.features = []; });
    expect(frozenCoverageLegend(overlay)).toMatchObject({ range: null, cells: 0 });
  });
});
