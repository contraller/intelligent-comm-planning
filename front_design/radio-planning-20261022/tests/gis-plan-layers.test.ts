import { describe, expect, it } from 'vitest';
import { gisPlanLayer } from '../src/maps/gis-plan-layers';
import { Icon, Style } from 'ol/style';
import type { GisNetwork } from '../src/types/gis-plan';
function sample(): GisNetwork {
  return {
    identity: {
      plan_id: 'P',
      task_id: 'T',
      snapshot_id: 'S',
      input_version: 'I',
      condition_version: 'C',
      resource_revision: 'R',
      state: 'SAVED',
      source_changed: false,
      source: 'SR4',
      data_origin: 'SYNTHETIC_INTEGRATION',
    },
    nodes: [
      { id: 'A', name: 'A', coordinate: [114, 37], status: null, alert: null },
      { id: 'B', name: 'B', coordinate: [114.1, 37], status: 'NORMAL', alert: false },
    ],
    devices: [],
    links: [
      {
        id: 'L',
        a: 'A',
        b: 'B',
        device_a: 'EA',
        device_b: 'EB',
        device_class: 'HF',
        frequency_khz: null,
        backup: true,
        planned_state: null,
      },
    ],
    demands: [
      {
        id: 'D',
        source_id: 'A',
        target_id: 'B',
        source_device_id: null,
        target_device_id: null,
        service: null,
        mandatory: null,
        required_rate_kbps: null,
        min_reliability: null,
      },
    ],
    routes: [{ id: 'R', demand_id: 'D', node_ids: ['A', 'B'], link_ids: ['L'], backup: true }],
    paths_state: 'ready',
    paths_message: '',
  };
}
describe('GIS冻结图层', () => {
  it('点线独立身份携带快照，不修改未知状态', () => {
    const input = sample(),
      before = structuredClone(input),
      layer = gisPlanLayer(input),
      features = layer.getSource()!.getFeatures();
    expect(features.map((row) => row.get('kind'))).toEqual([
      'frozen-plan-link',
      'frozen-plan-node',
      'frozen-plan-node',
    ]);
    expect(features.every((row) => row.get('snapshot') === 'S')).toBe(true);
    expect(input).toEqual(before);
  });
  it('仅选中需求显示需求线，路径关联同冻结链路', () => {
    const layer = gisPlanLayer(sample(), { demand: 'D' }),
      features = layer.getSource()!.getFeatures();
    expect(features.find((row) => row.get('kind') === 'frozen-plan-demand')?.get('objectId')).toBe(
      'D',
    );
    expect(features.every((row) => !!row.getGeometry())).toBe(true);
  });
  it('空网络与缺失几何不创造零坐标', () => {
    const input = sample();
    input.nodes = [];
    expect(gisPlanLayer(input).getSource()!.getFeatures()).toEqual([]);
  });
  it.each([
    ['FIXED', 'fixed-station'], ['VEHICLE', 'communication-vehicle'], ['MANPACK', 'manpack'],
    [null, 'node-generic'], [undefined, 'node-generic'],
  ] as const)('只按明确冻结 mobility %s 选择 %s 图标', (mobility, symbol) => {
    const input = sample();
    input.nodes[0] = { ...input.nodes[0], name: '通信车名称不代表平台来源', node_role: 'VEHICLE', node_subtype: 'VEHICLE_A', ...(mobility === undefined ? {} : { mobility }) };
    const before = structuredClone(input);
    const feature = gisPlanLayer(input).getSource()!.getFeatures().find(row => row.get('kind') === 'frozen-plan-node' && row.get('objectId') === 'A')!;
    const style = feature.getStyle(); expect(style).toBeInstanceOf(Style);
    if (!(style instanceof Style)) throw new Error('节点样式未提供');
    const icon = style.getImage(); expect(icon).toBeInstanceOf(Icon);
    if (!(icon instanceof Icon)) throw new Error('节点图标未提供');
    expect(icon.getSrc()).toContain(`/icons/gis/${symbol}.svg`);
    expect(feature.get('snapshot')).toBe(input.identity.snapshot_id);
    expect(input).toEqual(before);
  });
  it('尚无分析运行时同样遵循冻结拓扑显隐，不清除节点', () => {
    for (const display of [{ linksVisible: false }, { topologyOpacity: 0 }]) {
      const features = gisPlanLayer(sample(), {}, display).getSource()!.getFeatures();
      expect(features.map((row) => row.get('kind'))).toEqual([
        'frozen-plan-node',
        'frozen-plan-node',
      ]);
    }
  });
});
