import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, Stroke, Style, Text } from 'ol/style';
import type { CandidateLink } from '../types/candidate-link';
import type { Coordinate, Station } from '../types/domain';
import { projectCoordinate } from './layers';

const validPoint = (point: Coordinate) => point?.length === 2 && point.every(Number.isFinite)
  && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90;

// 只连接已有端点坐标，不计算距离、可通性或候选质量。
export function candidateEndpoints(link: CandidateLink, stations: Station[]): Coordinate[] {
  const a = stations.find(row => row.id === link.nodeAId), b = stations.find(row => row.id === link.nodeBId);
  return a && b && a.id !== b.id && validPoint(a.coordinate) && validPoint(b.coordinate) ? [a.coordinate, b.coordinate] : [];
}

export function candidateLinkLayer(links: CandidateLink[], stations: Station[], selectedId = '') {
  const normal = new Style({ stroke: new Stroke({ color: '#aab8c7', width: 1.5, lineDash: [5, 5], lineCap: 'butt' }) });
  return new VectorLayer({
    source: new VectorSource({ features: links.flatMap(link => {
      const points = candidateEndpoints(link, stations);
      if (!points.length) return [];
      const feature = new Feature({ geometry: new LineString(points.map(projectCoordinate)),
        kind: 'candidate-workset-link', objectId: link.id, candidate: link });
      feature.setId(`candidate:${link.id}`);
      return [feature];
    }) }),
    // 所有状态使用同一中性虚线，选中加粗只表达交互身份。
    style: feature => feature.get('objectId') === selectedId ? new Style({
      stroke: new Stroke({ color: '#e1e8ef', width: 3, lineDash: [5, 5], lineCap: 'butt' }),
      text: new Text({ text: `候选 · ${selectedId}`, font: '11px Microsoft YaHei',
        fill: new Fill({ color: '#e1e8ef' }), backgroundFill: new Fill({ color: '#0d1a2ce0' }), padding: [3, 5, 3, 5] }),
      zIndex: 5,
    }) : normal,
  });
}
