import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style';
import type { GisNetwork } from '../types/gis-plan';
import { projectCoordinate } from './layers';

// 冻结计划使用独立要素身份，点击不能落到当前资源同名对象。
export function gisPlanLayer(
  network: GisNetwork,
  selected: { node?: string; link?: string; demand?: string } = {},
  display: { linksVisible?: boolean; topologyOpacity?: number } = {},
) {
  const positions = new Map(network.nodes.map((node) => [node.id, node.coordinate]));
  const features: Feature[] = [],
    snapshot = network.identity.snapshot_id;
  const routeLinks = new Set(
    network.routes
      .filter((row) => row.demand_id === selected.demand)
      .flatMap((row) => row.link_ids),
  );
  const opacity =
    typeof display.topologyOpacity === 'number' &&
    Number.isFinite(display.topologyOpacity) &&
    display.topologyOpacity >= 0 &&
    display.topologyOpacity <= 1
      ? display.topologyOpacity
      : 1;
  for (const link of network.links) {
    if (display.linksVisible === false || opacity === 0) continue;
    const a = positions.get(link.a),
      b = positions.get(link.b);
    if (!a || !b) continue;
    const active = link.id === selected.link || routeLinks.has(link.id);
    const feature = new Feature({
      geometry: new LineString([projectCoordinate(a), projectCoordinate(b)]),
      kind: 'frozen-plan-link',
      objectId: link.id,
      snapshot,
    });
    feature.setStyle(
      new Style({
        stroke: new Stroke({
          color: active ? [255, 224, 138, opacity] : [80, 182, 219, opacity],
          width: active ? 4 : 2,
          lineDash: link.backup ? [7, 5] : undefined,
        }),
      }),
    );
    features.push(feature);
  }
  for (const demand of network.demands) {
    if (demand.id !== selected.demand) continue;
    const a = positions.get(demand.source_id),
      b = positions.get(demand.target_id);
    if (!a || !b) continue;
    const feature = new Feature({
      geometry: new LineString([projectCoordinate(a), projectCoordinate(b)]),
      kind: 'frozen-plan-demand',
      objectId: demand.id,
      snapshot,
    });
    feature.setStyle(
      new Style({ stroke: new Stroke({ color: '#c79bef', width: 2, lineDash: [4, 8] }) }),
    );
    features.push(feature);
  }
  for (const node of network.nodes) {
    const active = selected.node === node.id;
    const unknown = node.status === null || node.alert === null;
    const color = active
      ? '#ffe08a'
      : node.status === 'FAULT'
        ? '#ed7184'
        : node.status === 'OFFLINE'
          ? '#8093a9'
          : unknown
            ? '#bac4cf'
            : node.alert
              ? '#efa84c'
              : '#60ccbb';
    const feature = new Feature({
      geometry: new Point(projectCoordinate(node.coordinate)),
      kind: 'frozen-plan-node',
      objectId: node.id,
      snapshot,
    });
    feature.setStyle(
      new Style({
        image: new Circle({
          radius: active ? 8 : 5,
          fill: new Fill({ color }),
          stroke: new Stroke({ color: '#152d40', width: 2 }),
        }),
        text: active
          ? new Text({
              text: node.name,
              offsetY: -18,
              fill: new Fill({ color: '#fff' }),
              stroke: new Stroke({ color: '#152d40', width: 3 }),
            })
          : undefined,
      }),
    );
    features.push(feature);
  }
  return new VectorLayer({ source: new VectorSource({ features }), zIndex: 45 });
}
