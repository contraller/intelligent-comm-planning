import Feature from 'ol/Feature';
import GeoJSON from 'ol/format/GeoJSON';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import { asArray } from 'ol/color';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style';
import type { MapProjection } from '../types/interference-workbench';
import type { Coordinate } from '../types/domain';
import { projectCoordinate } from './layers';

const levelColors: Record<string, string> = {
  SEVERE: '#ee7585',
  MODERATE: '#edb363',
  MINOR: '#82ccbb',
};
function coordinate(row: Record<string, unknown>): Coordinate | null {
  const parse = (value: unknown) =>
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  const lon = parse(row.lon),
    lat = parse(row.lat);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
    ? [lon, lat]
    : null;
}
export function workbenchMapKey(value: MapProjection) {
  return `${value.taskId}:${value.planId}:${value.runId}:${value.sourceHash}:${value.phase}`;
}
export function workbenchCoordinates(value: MapProjection): Coordinate[] {
  return value.nodes.map((row) => coordinate(row)).filter((row): row is Coordinate => row !== null);
}
// 原始冻结输入只负责几何显示；SNR/SINR、等级及影响面都由后端返回。
export function interferenceWorkbenchLayer(
  value: MapProjection,
  selectedId = '',
  selectedLink = '',
  selectedSource = '',
  display: {
    areaVisible?: boolean;
    areaOpacity?: number;
    linksVisible?: boolean;
    topologyOpacity?: number;
  } = {},
) {
  const opacity = (value: number | undefined) =>
    Number.isFinite(value) && value! >= 0 && value! <= 1 ? value! : 1;
  const areaOpacity = opacity(display.areaOpacity),
    topologyOpacity = opacity(display.topologyOpacity);
  const features: Feature[] = [],
    positions = new Map<string, Coordinate>(),
    owner = workbenchMapKey(value);
  const nodes = new Map(value.impact.affected_nodes.map((row) => [String(row.node_id), row.level]));
  const links = new Map(value.impact.affected_links.map((row) => [String(row.link_id), row.level]));
  const area = value.impact.affected_area;
  let geometryNotice = '';
  if (
    display.areaVisible !== false &&
    areaOpacity > 0 &&
    area.type === 'FeatureCollection' &&
    Array.isArray(area.features)
  ) {
    try {
      const polygons = new GeoJSON().readFeatures(area, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      for (const feature of polygons) {
        if (!['Polygon', 'MultiPolygon'].includes(feature.getGeometry()?.getType() ?? '')) continue;
        feature.set('kind', 'workbench-area');
        feature.set('owner', owner);
        feature.setStyle(
          new Style({
            fill: new Fill({ color: [220, 139, 94, 0.14 * areaOpacity] }),
            stroke: new Stroke({ color: [220, 139, 94, areaOpacity], width: 1 }),
          }),
        );
        features.push(feature);
      }
    } catch {
      geometryNotice = '干扰影响区图形无效，冻结节点和链路仍保留。';
    }
  }
  for (const row of value.nodes) {
    const point = coordinate(row);
    if (typeof row.node_id === 'string' && point) positions.set(row.node_id, point);
  }
  for (const row of value.links) {
    if (display.linksVisible === false || topologyOpacity === 0) continue;
    if (typeof row.link_id !== 'string') continue;
    const a = positions.get(String(row.node_a_id)),
      b = positions.get(String(row.node_b_id));
    if (!a || !b) continue;
    const active = selectedLink === row.link_id;
    const color = asArray(
      active ? '#ffe08a' : (levelColors[links.get(row.link_id) ?? ''] ?? '#5eadd1'),
    );
    const feature = new Feature({
      geometry: new LineString([projectCoordinate(a), projectCoordinate(b)]),
      kind: 'workbench-link',
      objectId: row.link_id,
      owner,
    });
    feature.setStyle(
      new Style({
        stroke: new Stroke({
          color: [color[0], color[1], color[2], (color[3] ?? 1) * topologyOpacity],
          width: active ? 4 : 2,
        }),
      }),
    );
    features.push(feature);
  }
  for (const [id, point] of positions) {
    const feature = new Feature({
      geometry: new Point(projectCoordinate(point)),
      kind: 'workbench-node',
      objectId: id,
      owner,
    });
    feature.setStyle(
      new Style({
        image: new Circle({
          radius: selectedId === id ? 8 : 5,
          fill: new Fill({
            color: selectedId === id ? '#ffe08a' : (levelColors[nodes.get(id) ?? ''] ?? '#b0bdcd'),
          }),
          stroke: new Stroke({ color: '#183044', width: 2 }),
        }),
      }),
    );
    features.push(feature);
  }
  for (const source of value.sources) {
    const point = coordinate(source),
      id = source.interference_id;
    if (!point || !id) continue;
    const feature = new Feature({
      geometry: new Point(projectCoordinate(point)),
      kind: 'workbench-source',
      objectId: id,
      owner,
    });
    feature.setStyle(
      new Style({
        image: new Circle({
          radius: id === selectedSource ? 10 : 7,
          fill: new Fill({ color: '#e9a74e' }),
          stroke: new Stroke({ color: '#fff0bb', width: 2 }),
        }),
        text:
          id === selectedSource
            ? new Text({
                text: source.name || id,
                offsetY: -18,
                fill: new Fill({ color: '#fff' }),
                stroke: new Stroke({ color: '#183044', width: 3 }),
              })
            : undefined,
      }),
    );
    features.push(feature);
  }
  const layer = new VectorLayer({ source: new VectorSource({ features }), zIndex: 50 });
  layer.set('geometryNotice', geometryNotice);
  return layer;
}
