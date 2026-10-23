import { describe, expect, it } from 'vitest';
import {
  interferenceWorkbenchLayer,
  workbenchCoordinates,
  workbenchMapKey,
} from '../src/maps/interference-workbench-layers';
import type { MapProjection } from '../src/types/interference-workbench';
function sample(): MapProjection {
  return {
    taskId: 'T',
    planId: 'P',
    sceneVersionId: 'SC',
    runId: 'RUN',
    sourceHash: 'hash',
    phase: 'BEFORE',
    nodes: [
      { node_id: 'A', lon: 114, lat: 37 },
      { node_id: 'B', lon: 114.1, lat: 37 },
    ],
    links: [{ link_id: 'L', node_a_id: 'A', node_b_id: 'B' }],
    sources: [{ interference_id: 'IF', lon: '114.05', lat: '37', name: '冻结干扰源' }],
    impact: {
      affected_nodes: [{ node_id: 'A', level: 'SEVERE', snr_before_db: 20, sinr_after_db: 4 }],
      affected_links: [],
      affected_area: { type: 'FeatureCollection', features: [] },
      summary: {
        links: 1,
        jammers: 1,
        affected_nodes: 1,
        affected_links: 0,
        by_level: { SEVERE: 1, MODERATE: 0, MINOR: 0 },
      },
    },
  };
}
describe('干扰工作台冻结几何', () => {
  it('使用后端节点链路源几何，保留输入及来源身份', () => {
    const value = sample(),
      copy = structuredClone(value),
      features = interferenceWorkbenchLayer(value).getSource()!.getFeatures();
    expect(features.map((row) => row.get('kind'))).toEqual([
      'workbench-link',
      'workbench-node',
      'workbench-node',
      'workbench-source',
    ]);
    expect(features.every((row) => row.get('owner') === workbenchMapKey(value))).toBe(true);
    expect(value).toEqual(copy);
  });
  it('预览与原始显示有不同所有权，缺失坐标不补零', () => {
    const value = sample();
    expect(workbenchMapKey({ ...value, phase: 'PREVIEW' })).not.toBe(workbenchMapKey(value));
    value.nodes[0].lon = null;
    expect(workbenchCoordinates(value)).toEqual([[114.1, 37]]);
    expect(
      interferenceWorkbenchLayer(value)
        .getSource()!
        .getFeatures()
        .some((row) => row.get('kind') === 'workbench-link'),
    ).toBe(false);
  });
  it('GeoJSON影响面由标准读取器投影，不代替网络覆盖', () => {
    const value = sample();
    value.impact.affected_area = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [114, 37],
                [114.1, 37],
                [114.1, 37.1],
                [114, 37],
              ],
            ],
          },
        },
      ],
    };
    const feature = interferenceWorkbenchLayer(value)
      .getSource()!
      .getFeatures()
      .find((row) => row.get('kind') === 'workbench-area');
    expect(feature?.getGeometry()?.getType()).toBe('Polygon');
    expect(feature?.getGeometry()?.getExtent()[0]).toBeGreaterThan(1000000);
  });
});
