import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import VectorSource from 'ol/source/Vector';
import VectorLayer from 'ol/layer/Vector';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style';
import type { GisNetwork } from '../types/gis-plan';
import { projectCoordinate } from './layers';
import { LINK_STATUS_STYLES } from '../config/link-status';
import { gisNodeSymbol, gisSymbol } from './gis-symbols';

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
    const quality=link.planned_state?LINK_STATUS_STYLES[link.planned_state]:null;
    const feature = new Feature({
      geometry: new LineString([projectCoordinate(a), projectCoordinate(b)]),
      kind: 'frozen-plan-link',
      objectId: link.id,
      snapshot,
    });
    feature.setStyle(
      new Style({
        stroke: new Stroke({
          color: active ? [255, 224, 138, opacity] : quality?quality.color+Math.round(opacity*255).toString(16).padStart(2,'0'):[149,162,176,opacity],
          width: active ? 4 : quality?.width??1.5,
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
        image: gisSymbol(gisNodeSymbol(node),active,color),
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
    const devices=network.devices.filter(device=>device.station_id===node.id),hf=devices.filter(device=>device.device_class==='HF').length,vu=devices.length-hf;
    if(devices.length)feature.setStyle([...(Array.isArray(feature.getStyle())?feature.getStyle() as Style[]:[feature.getStyle() as Style]),new Style({text:new Text({text:`HF ${hf} · VUHF ${vu}`,offsetY:23,font:'10px Microsoft YaHei',fill:new Fill({color:'#d6e9f4'}),backgroundFill:new Fill({color:'#102638d9'}),padding:[2,4,2,4]})})]);
    features.push(feature);
  }
  return new VectorLayer({ source: new VectorSource({ features }), zIndex: 45, declutter:'frozen-plan-captions' });
}
