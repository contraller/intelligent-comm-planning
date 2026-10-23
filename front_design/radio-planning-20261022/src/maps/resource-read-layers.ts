import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style';
import type { Bounds, ResourceMapFrame } from '../types/resource-read';
import { projectCoordinate, unprojectCoordinate } from './layers';

// 服务端聚合点直接渲染，不再按浏览器像素聚合或重新计算其数量。
export function resourceReadLayer(frame: ResourceMapFrame | null, selectedId = '', selectedKind = '') {
  const features: Feature<Point>[] = [];
  for (const point of frame?.points ?? []) features.push(new Feature({ geometry: new Point(projectCoordinate(point.coordinate)), kind: 'resource-read-point', object: point }));
  for (const cluster of frame?.clusters ?? []) features.push(new Feature({ geometry: new Point(projectCoordinate(cluster.coordinate)), kind: 'resource-read-cluster', cluster }));
  return new VectorLayer({ source: new VectorSource({ features }), style: feature => {
    const cluster = feature.get('cluster'), point = feature.get('object');
    const selected = point?.id === selectedId && point?.kind === selectedKind;
    const unknown = point?.kind === 'node' && point.alert === null;
    const color = cluster ? '#4f99c4' : point.kind === 'interference' ? point.active ? '#e4a859' : '#8192a8' : point.status === 'FAULT' ? '#f27887' : point.status === 'OFFLINE' ? '#8192a8' : point.alert ? '#f0bd67' : '#45c9af';
    return new Style({ image: new Circle({ radius: cluster ? 15 : selected ? 9 : 6, fill: new Fill({ color: cluster ? '#173c58' : color }), stroke: new Stroke({ color: selected ? '#fff' : color, width: selected ? 3 : 1.5 }) }),
      text: new Text({ text: cluster ? String(cluster.count) : selected ? point.name + (unknown ? ' · 告警未提供' : '') : unknown ? '?' : '', offsetY: cluster ? 0 : -19, fill: new Fill({ color: '#e2f0fa' }), font: '12px Microsoft YaHei', backgroundFill: cluster ? undefined : new Fill({ color: '#0b182be0' }), padding: [3, 4, 3, 4] }), zIndex: selected ? 30 : 10 });
  } });
}
// 视野事件统一转换回 WGS84；与原有业务坐标和接口顺序保持一致。
export function resourceViewport(extent: number[]): Bounds | null {
  const a = unprojectCoordinate([extent[0], extent[1]]), b = unprojectCoordinate([extent[2], extent[3]]);
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const bounds: Bounds = [round(Math.max(-180, a[0])), round(Math.max(-90, a[1])), round(Math.min(180, b[0])), round(Math.min(90, b[1]))];
  return bounds.every(Number.isFinite) && bounds[0] < bounds[2] && bounds[1] < bounds[3] ? bounds : null;
}
