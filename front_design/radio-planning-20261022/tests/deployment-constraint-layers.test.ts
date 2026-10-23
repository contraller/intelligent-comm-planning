import { describe,expect,it } from 'vitest';
import Polygon from 'ol/geom/Polygon';
import { createDeploymentConstraintLayer } from '../src/maps/deployment-constraint-layers';
import { emptyDeploymentConstraints } from '../src/services/deployment-constraints';
import { projectCoordinate } from '../src/maps/layers';
// 真实 OpenLayers 几何保留内环；错误草稿不生成替代点。
describe('部署输入独立地图层',()=>{
  it('合法点与含内环禁区投影，换任务和释放时清理',()=>{
    const layer=createDeploymentConstraintLayer(),constraints=emptyDeploymentConstraints();constraints.forcedInclude=[{lon:170,lat:-70},{lon:NaN,lat:0}];
    constraints.forcedExcludePolygons=[{type:'Polygon',coordinates:[[[114,37],[115,37],[115,38],[114,37]],[[114.2,37.1],[114.3,37.1],[114.3,37.2],[114.2,37.1]]]}];
    layer.update({owner:'one',label:'草稿',constraints});const features=layer.layer.getSource()!.getFeatures();expect(features).toHaveLength(2);expect(features[0].getGeometry()!.getCoordinates()).toEqual(projectCoordinate([170,-70]));
    expect((features[1].getGeometry() as Polygon).getLinearRingCount()).toBe(2);expect(features.every(f=>f.get('kind')==='deployment-constraint')).toBe(true);expect(layer.extent()).toBeDefined();
    layer.update({owner:'two',label:'历史',constraints:undefined});expect(layer.layer.getSource()!.getFeatures()).toEqual([]);expect(layer.extent()).toBeUndefined();layer.dispose();expect(layer.layer.getVisible()).toBe(false);
  });
  it('未闭合禁区不被自动闭合或当结果绘制',()=>{
    const layer=createDeploymentConstraintLayer(),constraints=emptyDeploymentConstraints();constraints.forcedExcludePolygons=[{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1]]]}];
    const before=structuredClone(constraints);layer.update({owner:'one',label:'草稿',constraints});expect(layer.extent()).toBeUndefined();expect(constraints).toEqual(before);
  });
});
