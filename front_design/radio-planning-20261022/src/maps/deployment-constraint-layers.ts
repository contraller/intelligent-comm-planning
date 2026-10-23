import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, RegularShape, Stroke, Style, Text } from 'ol/style';
import { projectCoordinate } from './layers';
import type { DeploymentConstraintFrame } from '../types/deployment-constraints';
import { deploymentPointValid, deploymentPolygonValid } from '../services/deployment-constraints';

// 独立输入层只投影合法几何，既不筛选候选，也不修补草稿或业务区域。
export function createDeploymentConstraintLayer() {
  const source = new VectorSource<Feature<Point | Polygon>>(), layer = new VectorLayer({ source, zIndex: 62 });
  function update(frame?: DeploymentConstraintFrame | null) {
    source.clear(); layer.setVisible(!!frame?.constraints);
    for (const [index, point] of (frame?.constraints?.forcedInclude ?? []).entries()) {
      if (!deploymentPointValid([point.lon, point.lat])) continue;
      const feature = new Feature({ kind: 'deployment-constraint', owner: frame!.owner, geometry: new Point(projectCoordinate([point.lon, point.lat])) });
      feature.setStyle(new Style({ image: new RegularShape({ points: 4, radius: 10, radius2: 3, angle: 0,
        fill: new Fill({ color: '#68e7ed' }), stroke: new Stroke({ color: '#123f51', width: 2 }) }),
        text: new Text({ text: `输入点 ${index+1}`, offsetY: -18, fill: new Fill({ color: '#68e7ed' }), stroke: new Stroke({ color: '#102235', width: 3 }) }) }));
      source.addFeature(feature);
    }
    for (const polygon of frame?.constraints?.forcedExcludePolygons ?? []) {
      if (!deploymentPolygonValid(polygon)) continue;
      const feature = new Feature({ kind: 'deployment-constraint', owner: frame!.owner,
        geometry: new Polygon(polygon.coordinates.map(ring => ring.map(projectCoordinate))) });
      feature.setStyle(new Style({ stroke: new Stroke({ color: '#ee94da', width: 2, lineDash: [6, 5] }), fill: new Fill({ color: 'rgba(238,148,218,0.12)' }) }));
      source.addFeature(feature);
    }
  }
  return { layer, update, extent: () => source.getFeatures().length ? source.getExtent() : undefined,
    dispose: () => { source.clear(); layer.setVisible(false); } };
}
