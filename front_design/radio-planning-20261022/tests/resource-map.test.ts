import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature';
import { initialResources } from '../src/mocks/resource-presets';
import { projectCoordinate, unprojectCoordinate, nodeLayer } from '../src/maps/layers';
import { interferenceLayer, resourcePickLayer } from '../src/maps/resource-layers';

describe('GIS 资源图层契约（不代替浏览器点选验收）',()=>{
  it('WGS84 取点往返保持经度在前，地图转换集中处理',()=>{
    const point=unprojectCoordinate(projectCoordinate([114.65,37.5]));
    expect(point[0]).toBeCloseTo(114.65,8);expect(point[1]).toBeCloseTo(37.5,8);
  });
  it('干扰源只产生点，选择身份不与站点混淆，生效配置不生成区域',()=>{
    const sources=initialResources().interferences!,features=interferenceLayer(sources,sources[0].id).getSource()!.getFeatures();
    expect(features).toHaveLength(16);
    for(const feature of features){expect(feature.getGeometry()!.getType()).toBe('Point');expect(feature.get('kind')).toBe('interference-source');}
    expect(features.map(f=>f.get('objectId')).sort()).toEqual(sources.map(s=>s.id).sort());
    expect(resourcePickLayer([114.6,37.5]).getSource()!.getFeatures()).toHaveLength(1);
    expect(resourcePickLayer().getSource()!.getFeatures()).toEqual([]);
  });
  it('资源来源标识保留站点状态，不改变其他页面默认图层',()=>{
    const station={...initialResources().stations[0],origin:'MANUAL' as const};
    const plain=nodeLayer([station]),marked=nodeLayer([station],'',[],true);
    const a=plain.getSource()!.getSource()!.getFeatures()[0],b=marked.getSource()!.getSource()!.getFeatures()[0];
    expect(a.getGeometry()!.getCoordinates()).toEqual(b.getGeometry()!.getCoordinates());
    const normal=plain.getStyleFunction()!(new Feature({features:[a]}),1),highlight=marked.getStyleFunction()!(new Feature({features:[b]}),1);
    expect(normal).not.toEqual(highlight);expect(station.status).toBe('NORMAL');
  });
});
