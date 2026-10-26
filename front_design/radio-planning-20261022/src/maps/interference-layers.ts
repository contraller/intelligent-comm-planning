import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import MultiPolygon from 'ol/geom/MultiPolygon';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Circle, Fill, Stroke, Style } from 'ol/style';
import type { NetworkLink, Station } from '../types/domain';
import type { InterferenceImpact, InterferenceLevel } from '../types/interference';
import { projectCoordinate } from './layers';

export const interferenceColors: Record<InterferenceLevel, string> = { SEVERE: '#ef8799', MODERATE: '#efc16b', MINOR: '#72c5df' };
// 干扰区域独用紫色系，与诊断区域区分；受扰对象仍沿原等级色高亮。
export const interferenceRegionColors: Record<InterferenceLevel, string> = { SEVERE: '#c084fc', MODERATE: '#a5a6ff', MINOR: '#cad5ff' };
// 仅转换预生成几何；保留多面及孔洞，严禁由功率推算半径。
export function interferenceImpactLayers(impact: InterferenceImpact | null, stations: Station[], links: NetworkLink[], selectedId = '', splitLinks = false) {
  const regions = new VectorLayer({ source: new VectorSource({ features: (impact?.regions ?? []).map(region =>
    new Feature({ geometry: new MultiPolygon(region.polygons.map(polygon => polygon.map(ring => ring.map(projectCoordinate)))),
      kind: 'interference-region', objectId: region.id, level: region.level })) }),
    style: feature => new Style({ fill: new Fill({ color: interferenceRegionColors[feature.get('level') as InterferenceLevel] + '40' }),
      stroke: new Stroke({ color: interferenceRegionColors[feature.get('level') as InterferenceLevel], width: 1.5, lineDash: [7, 4] }) }),
  });
  const nodes = (impact?.nodes ?? []).flatMap(row => {
    const station = stations.find(node => node.id === row.nodeId);
    return station ? [new Feature({ geometry: new Point(projectCoordinate(station.coordinate)), kind: 'interference-node', objectId: row.nodeId, level: row.level })] : [];
  });
  const affectedLinks = (impact?.links ?? []).flatMap(row => {
    const link = links.find(item => item.id === row.linkId);
    const a = stations.find(node => node.id === link?.a), b = stations.find(node => node.id === link?.b);
    return a && b ? [new Feature({ geometry: new LineString([a.coordinate, b.coordinate].map(projectCoordinate)), kind: 'interference-link', objectId: row.linkId, level: row.level })] : [];
  });
  const objects = new VectorLayer({ source: new VectorSource({ features: splitLinks ? nodes : [...nodes, ...affectedLinks] }),
    style: feature => {
      const color = interferenceColors[feature.get('level') as InterferenceLevel], selected = feature.get('objectId') === selectedId;
      return new Style({ image: new Circle({ radius: selected ? 13 : 10, fill: new Fill({ color: color + '40' }), stroke: new Stroke({ color, width: selected ? 4 : 2 }) }),
        stroke: new Stroke({ color, width: selected ? 6 : 4 }), zIndex: selected ? 50 : 40 });
    },
  });
  // 仅显式接入的 GIS 拆分线条；旧调用继续使用原节点、链路混合图层。
  const linkObjects = splitLinks ? new VectorLayer({ source: new VectorSource({ features: affectedLinks }), style: objects.getStyle()! }) : undefined;
  return { regions, objects, linkObjects };
}
