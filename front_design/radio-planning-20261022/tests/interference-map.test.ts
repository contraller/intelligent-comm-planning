import { describe, expect, it } from 'vitest';
import { Style } from 'ol/style';
import { interferenceImpactLayers } from '../src/maps/interference-layers';
import { interferenceDemoResult, interferenceScenarios, interferenceVariants } from '../src/mocks/interference-presets';
import { planningPresets } from '../src/mocks/planning-presets';
import { configuredStations } from '../src/services/planning-snapshot';
import { projectCoordinate } from '../src/maps/layers';

describe('干扰地图冻结图层', () => {
  const base=planningPresets[0], impact=interferenceDemoResult(interferenceScenarios[0],'balanced').impact;
  it('多面及内环保持原形状，选择命中稳定对象 ID', () => {
    const original=structuredClone(impact), layers=interferenceImpactLayers(impact,base.baseline.stations,base.result!.links,'LINK-B');
    const region=layers.regions.getSource()!.getFeatures()[0];
    expect(region.getGeometry()!.getCoordinates()).toEqual(impact.regions[0].polygons.map(p=>p.map(r=>r.map(projectCoordinate))));
    const link=layers.objects.getSource()!.getFeatures().find(row=>row.get('objectId')==='LINK-B')!;
    expect(link.get('kind')).toBe('interference-link');
    expect((layers.objects.getStyleFunction()!(link,1) as Style).getStroke()!.getWidth()).toBe(6);
    expect(impact).toEqual(original);
  });
  it('重部署展示输出坐标且输入不变，空影响不产生假区域', () => {
    const variant=interferenceVariants.find(row=>row.id==='balanced:NODE_REDEPLOY')!;
    const original=structuredClone(base.baseline.stations), stations=configuredStations(original,variant.result.configuration);
    expect(stations.find(row=>row.id==='ND-0004')!.coordinate).toEqual([114.31,37.26]);
    expect(original).toEqual(base.baseline.stations);
    const layers=interferenceImpactLayers(null,stations,variant.result.links);
    expect(layers.regions.getSource()!.getFeatures()).toEqual([]);expect(layers.objects.getSource()!.getFeatures()).toEqual([]);
  });
});
