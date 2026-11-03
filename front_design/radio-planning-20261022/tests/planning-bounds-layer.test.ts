import {describe,it,expect} from 'vitest';
import {toLonLat} from 'ol/proj';
import Polygon from 'ol/geom/Polygon';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import {planningBounds,planningBoundsLayer} from '../src/maps/planning-bounds-layer';

const box=[113.37497663855423,36.461013295002346,114.72474558374593,37.53898670499157];
describe('冻结规划区的直观尺度',()=>{
  it('120km量级显示适当精度并保留细值，其他范围不冒充120km',()=>{
    const before=[...box],value=planningBounds(box)!;
    expect(value.label).toBe('规划区域约 120 km × 120 km');expect(value.detailLabel).toContain('119.9 km');
    expect(value.gridStepKm).toBe(20);expect(box).toEqual(before);
    const smaller=planningBounds([113,37,113.5,37.5])!;
    expect(smaller.label).not.toContain('120');expect(smaller.widthKm).toBeLessThan(50);
    expect(planningBounds([113,37,113,38])).toBeNull();expect(planningBounds(null)).toBeNull();
  });
  it('横纵尺寸线绑定原边界，公里网格位于区内，文字不再盖住网络中央',()=>{
    const features=planningBoundsLayer(box).getSource()!.getFeatures();
    const boundary=features.find(f=>f.get('kind')==='planning-bounds')!.getGeometry() as Polygon;
    const corners=boundary.getCoordinates()[0].map(coordinate=>toLonLat(coordinate));
    expect(corners[0][0]).toBeCloseTo(box[0],8);expect(corners[2][1]).toBeCloseTo(box[3],8);
    const dimensions=features.filter(f=>f.get('kind')==='planning-dimension');
    expect(dimensions.map(f=>f.get('axis')).sort()).toEqual(['east-west','north-south']);
    expect(dimensions.every(f=>f.get('distanceKm')>119&&f.get('distanceKm')<121)).toBe(true);
    const grids=features.filter(f=>f.get('kind')==='planning-grid');expect(grids.length).toBeGreaterThan(0);
    for(const grid of grids)for(const coordinate of (grid.getGeometry() as LineString).getCoordinates().map(coordinate=>toLonLat(coordinate))){
      expect(coordinate[0]).toBeGreaterThanOrEqual(box[0]-1e-8);expect(coordinate[0]).toBeLessThanOrEqual(box[2]+1e-8);
      expect(coordinate[1]).toBeGreaterThanOrEqual(box[1]-1e-8);expect(coordinate[1]).toBeLessThanOrEqual(box[3]+1e-8);
    }
    const labels=features.filter(f=>f.get('kind')==='planning-dimension-label'&&f.get('distanceKm')===undefined);
    expect(labels).toHaveLength(2);
    for(const label of labels){const [lon,lat]=toLonLat((label.getGeometry() as Point).getCoordinates());expect(lon<box[0]||lat>box[3]).toBe(true);}
  });
});
