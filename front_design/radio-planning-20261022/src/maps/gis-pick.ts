import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Circle, Fill, Stroke, Style } from 'ol/style';
import type { Coordinate } from '../types/domain';
import type { GisPickOwner, GisPickTarget } from '../types/gis-pick';
import { projectCoordinate } from './layers';

// CSS 像素仅用于鼠标交互，不能作为物理距离或部署约束。
export const GIS_PICK_RADIUS = 12;
export function validPickCoordinate(value: number[]): value is Coordinate {
  return value.length === 2 && value.every(Number.isFinite)
    && Math.abs(value[0]!) <= 180 && Math.abs(value[1]!) <= 90;
}
export function samePickCoordinate(a: Coordinate, b: Coordinate) { return a[0] === b[0] && a[1] === b[1]; }
export function pickTargetLabel(target: GisPickTarget) {
  return `${target.kind === 'station' ? '站点' : '干扰源'} ${target.name}（${target.id}）`;
}

// 只接收实际渲染的单点；聚合中心及其成员均不成为候选。
export function renderedPickTargets(targets: GisPickTarget[], clusters: Pick<Feature, 'get'>[],
  sources: Pick<Feature, 'get'>[], showStations: boolean, showSources: boolean) {
  const rendered = new Map<string, Coordinate>();
  if (showStations) for (const cluster of clusters) {
    const members = cluster.get('features') as Feature[] | undefined;
    const row = members?.length === 1 ? members[0]!.get('station') : undefined;
    if (row) rendered.set(`station/${row.id}`, row.coordinate);
  }
  if (showSources) for (const feature of sources) {
    const row = feature.get('kind') === 'interference-source' ? feature.get('source') : undefined;
    if (row) rendered.set(`interference/${row.id}`, row.coordinate);
  }
  return targets.filter(target => {
    const coordinate = rendered.get(`${target.kind}/${target.id}`);
    return coordinate && validPickCoordinate(coordinate) && samePickCoordinate(coordinate, target.coordinate);
  });
}

export function nearestPickTarget(pixel: number[], targets: GisPickTarget[], owner: GisPickOwner | null,
  pixelFor: (coordinate: Coordinate) => number[] | null, size: number[]) {
  if (pixel.length !== 2 || !pixel.every(Number.isFinite) || size.length !== 2 || !size.every(v => Number.isFinite(v) && v > 0)) return;
  let best: GisPickTarget | undefined, distance = GIS_PICK_RADIUS ** 2, order = '';
  for (const target of targets) {
    if (target.kind === owner?.kind && target.id === owner.id || !validPickCoordinate(target.coordinate)) continue;
    const point = pixelFor(target.coordinate);
    if (!point || !point.every(Number.isFinite) || point[0]! < 0 || point[1]! < 0 || point[0]! > size[0]! || point[1]! > size[1]!) continue;
    const next = (point[0]! - pixel[0]!) ** 2 + (point[1]! - pixel[1]!) ** 2;
    const key = `${target.kind}/${target.id}`;
    if (next < distance || next === distance && (!best || key < order)) { best = target; distance = next; order = key; }
  }
  return best;
}

export function createPickHighlight() {
  const source = new VectorSource<Feature<Point>>();
  const layer = new VectorLayer({ source, zIndex: 40, style: new Style({ image: new Circle({
    radius: 15, stroke: new Stroke({ color: '#ffffff', width: 3 }), fill: new Fill({ color: 'rgba(74,205,255,0.16)' }),
  }) }) });
  let signature = '';
  return { layer, update(target?: GisPickTarget) {
    const next = target ? JSON.stringify([target.kind, target.id, target.coordinate]) : '';
    if (next === signature) return;
    signature = next; source.clear();
    // 独立辅助圈不改原对象颜色，也不参与普通对象点选。
    if (target) source.addFeature(new Feature({ geometry: new Point(projectCoordinate(target.coordinate)), kind: 'gis-pick-highlight' }));
  } };
}
