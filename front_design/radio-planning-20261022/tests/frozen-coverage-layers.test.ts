import { describe,expect,it } from 'vitest';
import { frozenCoverageLayer } from '../src/maps/frozen-coverage-layers';
import Polygon from 'ol/geom/Polygon';
import type { FrozenCoverageFeature,FrozenCoverageOverlay } from '../src/types/frozen-coverage';
import { coverageCase } from './helpers/frozen-coverage';
describe('冻结覆盖原生几何层',()=>{
  it('VUHF是余量采样点，属性不冒充场强或连续覆盖面',()=>{
    const f=coverageCase(),overlay:FrozenCoverageOverlay={anchor:f.anchor,result:f.result,deviceId:'D1'},layer=frozenCoverageLayer(overlay,f.query.snapshotId,f.query.planId);
    const feature=layer.getSource()!.getFeatures()[0];expect(feature.getGeometry()!.getType()).toBe('Point');expect(feature.get('margin_db')).toBe(12);expect(feature.get('field_strength_dbuvm_min')).toBeUndefined();expect(layer.getZIndex()).toBe(25);
  });
  it('HF内孔保留；静区和不可显示跨日期线环不填覆盖',()=>{
    const f=coverageCase(),properties={device_id:'D1',node_id:'N1',freq_khz:7000,is_coverage:true};
    const ring:FrozenCoverageFeature={type:'Feature',properties,geometry:{type:'Polygon',coordinates:[[[113,37],[115,37],[115,38],[113,38],[113,37]],[[114,37.2],[114,37.6],[114.2,37.6],[114,37.2]]]}};
    f.result.devices[0].computations=[{freq_khz:7000,link_ids:['L1'],shape:'RINGS',geojson:{type:'FeatureCollection',features:[ring,{...ring,properties:{...properties,is_coverage:false}},{...ring,geometry:null}]}}];
    const features=frozenCoverageLayer({anchor:f.anchor,result:f.result,deviceId:'D1'},f.query.snapshotId).getSource()!.getFeatures();expect(features).toHaveLength(1);
    const geometry=features[0].getGeometry();expect(geometry).toBeInstanceOf(Polygon);expect((geometry as Polygon).getCoordinates()).toHaveLength(2);
  });
  it.each(['plan','snapshot','device'] as const)('错%s不在当前地图绘制',kind=>{
    const f=coverageCase(),overlay={anchor:f.anchor,result:f.result,deviceId:kind==='device'?'absent':'D1'};
    const layer=frozenCoverageLayer(overlay,kind==='snapshot'?'SNP-other':f.query.snapshotId,kind==='plan'?'PLAN-other':f.query.planId);
    expect(layer.getSource()!.getFeatures()).toHaveLength(0);
  });
});
