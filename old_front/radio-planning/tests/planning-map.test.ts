import { describe, expect, it } from 'vitest';
import { Style } from 'ol/style';
import { demandLayer, linkLayer, nodeLayer, projectCoordinate } from '../src/maps/layers';
import { planningPresets } from '../src/mocks/planning-presets';
import { LINK_STATUS_STYLES } from '../src/config/link-status';
import { resolvePlanningResultFocus } from '../src/services/planning-result-display';
import { configuredStations } from '../src/services/planning-snapshot';

// 数据层检查不能替代真实地图视觉/点击验收。
describe('规划地图要素', () => {
  const preset = planningPresets[0];
  it('完整备用路由的每段都高亮，保留质量颜色和虚线', () => {
    const result = { ...preset.result!, snapshotId: 'map-test', inputSnapshot: preset.baseline };
    const focus = resolvePlanningResultFocus({ key: 'map-test', result, configuration: result.configuration }, '路由结果', { kind: 'route', id: 'ROUTE-3' });
    const layer = linkLayer(result.links, preset.baseline.stations, false, focus.linkIds);
    for (const feature of layer.getSource()!.getFeatures()) {
      const row = feature.get('link'), style = layer.getStyleFunction()!(feature, 1);
      if (['LINK-B', 'LINK-C'].includes(row.id)) {
        expect(Array.isArray(style)).toBe(true);
        expect((style as Style[])[1].getStroke()!.getColor()).toBe(LINK_STATUS_STYLES.GOOD.color);
        if (row.backup) for (const item of style as Style[]) expect(item.getStroke()!.getLineDash()).toEqual([6, 6]);
      } else expect(style).toBeInstanceOf(Style);
    }
    expect(focus.stationIds).toEqual(['ND-0001', 'ND-0004', 'ND-0003']);
  });
  it('部署节点定位使用保存的输出坐标，输入坐标保留', () => {
    const configuration = structuredClone(preset.result!.configuration);
    const deployment = configuration.deployment[0], before = structuredClone(preset.baseline.stations);
    deployment.plannedCoordinate = [114.8, 37.8];
    const stations = configuredStations(preset.baseline.stations, configuration);
    const feature = nodeLayer(stations, deployment.stationId, [deployment.stationId]).getSource()!.getSource()!.getFeatures().find(row => row.get('station').id === deployment.stationId)!;
    expect(feature.getGeometry()!.getCoordinates()).toEqual(projectCoordinate([114.8, 37.8]));
    expect(preset.baseline.stations).toEqual(before);
  });
  it('需求与规划链路身份分开，需求使用稳定 ID 和投影后的真实端点', () => {
    const demands = demandLayer(preset.input.demands, preset.baseline.stations);
    const feature = demands.getSource()!.getFeatures()[0];
    expect(feature.getId()).toBe(preset.input.demands[0].id);
    expect(feature.get('kind')).toBe('task-demand');
    expect(feature.get('link')).toBeUndefined();
    expect(feature.getGeometry()!.getCoordinates()[0]).toEqual(
      projectCoordinate(preset.baseline.stations[0].coordinate),
    );
    const planned = linkLayer(preset.result!.links, preset.baseline.stations)
      .getSource()!
      .getFeatures()[0];
    expect(planned.get('kind')).toBe('planned-link');
    expect(planned.get('demand')).toBeUndefined();
    const candidate = linkLayer(preset.result!.links, preset.baseline.stations, true)
      .getSource()!
      .getFeatures()[0];
    expect(candidate.get('kind')).toBe('candidate-link');
  });
  it('缺失需求端点不生成错误线段；选中外框保留链路等级与备用虚线', () => {
    expect(demandLayer(preset.input.demands, []).getSource()!.getFeatures()).toEqual([]);
    const normal = linkLayer(preset.result!.links, preset.baseline.stations);
    const highlighted = linkLayer(preset.result!.links, preset.baseline.stations, false, [
      'LINK-A',
      'LINK-C',
    ]);
    const feature = normal.getSource()!.getFeatures()[0];
    const defaultStyle = normal.getStyleFunction()!(feature, 1) as Style;
    const selectedStyle = highlighted.getStyleFunction()!(feature, 1) as Style[];
    expect(defaultStyle.getStroke()!.getWidth()).toBe(3);
    expect(defaultStyle.getStroke()!.getColor()).toBe(LINK_STATUS_STYLES.EXCELLENT.color);
    // 高亮不能将故障等业务颜色覆盖为选中色，也不能填满备用线的虚线间隙。
    expect(selectedStyle).toHaveLength(2);
    expect(selectedStyle[0].getStroke()!.getWidth()).toBeGreaterThan(3);
    expect(selectedStyle[1].getStroke()!.getWidth()).toBe(3);
    expect(selectedStyle[1].getStroke()!.getColor()).toBe(defaultStyle.getStroke()!.getColor());
    const other = normal.getSource()!.getFeatures()[1];
    expect(highlighted.getStyleFunction()!(other, 1)).toBeInstanceOf(Style);
    const backup = normal.getSource()!.getFeatures().find(row => row.get('link').backup)!;
    const backupStyles = highlighted.getStyleFunction()!(backup, 1) as Style[];
    for (const style of backupStyles) {
      expect(style.getStroke()!.getLineDash()).toEqual([6, 6]);
      expect(style.getStroke()!.getLineCap()).toBe('butt');
    }
    const candidate = linkLayer(preset.result!.links, preset.baseline.stations, true, ['LINK-A']);
    const candidateStyle = candidate.getStyleFunction()!(feature, 1) as Style;
    expect(candidateStyle.getStroke()!.getColor()).toBe('#8291ab');
    expect(candidateStyle.getStroke()!.getWidth()).toBe(1);
    expect(candidateStyle.getStroke()!.getLineDash()).toEqual([6, 6]);
    expect(
      nodeLayer(preset.baseline.stations).getSource()!.getSource()!.getFeatures(),
    ).toHaveLength(3);
  });
});

describe('设备级通联图层',()=>{
  it('保留设备 ID、使用所属站点坐标，不伪造规划链路',()=>{
    const preset=planningPresets.find(p=>p.id==='device-balanced')!,layer=demandLayer(preset.input.demands,preset.baseline.stations,preset.input.demands[0].id);
    const feature=layer.getSource()!.getFeatures()[0];
    expect(feature.get('demand').sourceDeviceId).toBe('DV-0001');expect(feature.get('kind')).toBe('task-demand');expect(feature.get('link')).toBeUndefined();
    expect((layer.getStyleFunction()!(feature,1) as Style).getStroke()!.getWidth()).toBe(4);
  });
});
