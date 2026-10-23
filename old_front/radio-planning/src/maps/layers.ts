import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import Polygon from 'ol/geom/Polygon';
import VectorSource from 'ol/source/Vector';
import Cluster from 'ol/source/Cluster';
import VectorLayer from 'ol/layer/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import { fromLonLat, toLonLat } from 'ol/proj';
import { Circle, Fill, Stroke, Style, Text } from 'ol/style';
import type { Coordinate, MapRegion, NetworkLink, Station } from '../types/domain';
import type { PlanningDemand } from '../types/planning';
import { LINK_STATUS_STYLES } from '../config/link-status';
import { shouldDisplayLink, type LinkDisplayState } from './link-display';

export const projectCoordinate = (point: Coordinate) => fromLonLat(point);
// 地图反投影也集中处理，对外始终保持经度在前。
export const unprojectCoordinate = (point:number[]) => toLonLat(point) as Coordinate;
const colors = { NORMAL: '#45c9af', FAULT: '#f27887', OFFLINE: '#8192a8' };
// 道路数量较多，复用样式避免平移时为每条道路反复分配对象。
const majorRoadStyle = new Style({ stroke: new Stroke({ color: '#35546b', width: 1.6 }) });
const minorRoadStyle = new Style({ stroke: new Stroke({ color: '#223b51', width: 0.7 }) });
export function roadLayer() {
  return new VectorLayer({
    source: new VectorSource({
      url: `${import.meta.env.BASE_URL}maps/demo-roads.geojson`,
      format: new GeoJSON(),
      attributions:
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · 本地道路 / ODbL',
    }),
    style: (feature) =>
      ['motorway', 'trunk'].includes(feature.get('fclass')) ? majorRoadStyle : minorRoadStyle,
  });
}
export function nodeLayer(stations: Station[], selectedId?: string, highlightIds: string[] = [], resourceMarkers=false) {
  const features = stations.map(
    (station) =>
      new Feature({ geometry: new Point(projectCoordinate(station.coordinate)), station }),
  );
  return new VectorLayer({
    source: new Cluster({ distance: 28, source: new VectorSource({ features }) }),
    style: (feature) => {
      const members = feature.get('features') as Feature[];
      if (members.length > 1)
        return new Style({
          image: new Circle({
            radius: 13,
            fill: new Fill({ color: '#143e63' }),
            stroke: new Stroke({ color: '#52a8db', width: 1.5 }),
          }),
          text: new Text({
            text: String(members.length),
            fill: new Fill({ color: '#d5efff' }),
            font: '11px sans-serif',
          }),
        });
      const station = members[0].get('station') as Station;
      const selected = station.id === selectedId || highlightIds.includes(station.id);
      const color =
        station.status === 'NORMAL' && station.alert ? '#f0bd67' : colors[station.status];
      return new Style({
        image: new Circle({
          radius: selected ? 8 : station.key ? 5.5 : 4,
          fill: new Fill({ color }),
          stroke: new Stroke({
            color: selected ? '#ffffff' : resourceMarkers&&station.origin==='MANUAL'?'#dcb976':'#102232',
            width: selected ? 3 : resourceMarkers&&station.origin==='MANUAL'?3:1.5,
          }),
        }),
        text:
          selected || station.key
            ? new Text({
                text: `${station.name}\n${station.classes.join(' / ')}${station.alert ? ' · 告警' : ''}`,
                font: '10px Microsoft YaHei',
                offsetY: -21,
                fill: new Fill({ color: '#b8d0e7' }),
                backgroundFill: new Fill({ color: '#0d1a2ce0' }),
                padding: [3, 5, 3, 5],
              })
            : undefined,
        zIndex: selected ? 10 : 1,
      });
    },
  });
}
export function linkLayer(
  links: NetworkLink[],
  stations: Station[],
  candidate = false,
  highlightIds: string[] = [],
  display?: LinkDisplayState,
) {
  const nodes = new Map(stations.map((station) => [station.id, station]));
  return new VectorLayer({
    source: new VectorSource({
      features: links.flatMap((link) => {
        const a = nodes.get(link.a);
        const b = nodes.get(link.b);
        if (!a || !b) return [];
        return [
          new Feature({
            geometry: new LineString([
              projectCoordinate(a.coordinate),
              projectCoordinate(b.coordinate),
            ]),
            link,
            kind: candidate ? 'candidate-link' : 'planned-link',
            objectId: link.id,
          }),
        ];
      }),
    }),
    style: (feature) => {
      const link = feature.get('link') as NetworkLink;
      const status = LINK_STATUS_STYLES[link.state];
      const selected = !candidate && highlightIds.includes(link.id);
      // 保留要素和端点，只改变绘制；无样式的简化链路不进入地图点选。
      if (!candidate && display && !shouldDisplayLink(link, display.zoom, selected || display.selectedLinkId === link.id)) return undefined;
      const lineDash = candidate || link.backup ? [6, 6] : undefined;
      const line = new Style({
        stroke: new Stroke({
          // 暗相仍有 40% 不透明度，故障红线不会消失或丢失点选目标。
          color: candidate ? '#8291ab' : link.state === 'FAULT' && display?.faultDimmed ? status.color + '66' : status.color,
          width: candidate ? 1 : status.width,
          lineDash,
          lineCap: lineDash ? 'butt' : undefined,
        }),
        zIndex: selected ? 2 : 0,
      });
      if (!selected) return line;
      // 外框置于状态线下方；虚线使用平端，避免加粗后填满备用链路的间隙。
      return [new Style({
        stroke: new Stroke({ color: '#c2edff', width: status.width + 4, lineDash, lineCap: lineDash ? 'butt' : undefined }),
        zIndex: 1,
      }), line];
    },
  });
}
// 通联需求独立于候选及规划链路；设备端点只作身份展示，不推导规划链路。
export function demandLayer(demands: PlanningDemand[], stations: Station[], selectedId='') {
  const nodes = new Map(stations.map((station) => [station.id, station]));
  return new VectorLayer({
    source: new VectorSource({
      features: demands.flatMap((demand) => {
        const a = nodes.get(demand.sourceId);
        const b = nodes.get(demand.targetId);
        if (!a || !b) return [];
        const feature = new Feature({
          geometry: new LineString([
            projectCoordinate(a.coordinate),
            projectCoordinate(b.coordinate),
          ]),
          demand,
          kind: 'task-demand',
          objectId: demand.id,
        });
        feature.setId(demand.id);
        return [feature];
      }),
    }),
    style: (feature) =>
      new Style({
        stroke: new Stroke({ color: '#b798e3', width: feature.getId()===selectedId?4:2, lineDash: [3, 7] }),
        text: new Text({
          text: `任务需求 · ${(feature.get('demand') as PlanningDemand).id}` + ((feature.get('demand') as PlanningDemand).endpointMode==='device'?` · ${(feature.get('demand') as PlanningDemand).sourceDeviceId} → ${(feature.get('demand') as PlanningDemand).targetDeviceId}`:' · 站点间'),
          font: '10px Microsoft YaHei',
          offsetY: -10,
          fill: new Fill({ color: '#dbbeff' }),
          backgroundFill: new Fill({ color: '#111d31db' }),
          padding: [3, 4, 3, 4],
        }),
      }),
  });
}
export function regionLayer(regions: MapRegion[]) {
  const palette = {
    coverage: ['#249db91c', '#469dba99'],
    blind: ['#d6a25223', '#b1935b'],
    uncalculated: ['#73839d16', '#667a96'],
    impact: ['#ed67883b', '#ef7e98'],
  };
  return new VectorLayer({
    source: new VectorSource({
      features: regions.map(
        (region) =>
          new Feature({
            geometry: new Polygon(region.rings.map((ring) => ring.map(projectCoordinate))),
            region,
          }),
      ),
    }),
    style: (feature) => {
      const region = feature.get('region') as MapRegion;
      const [fill, stroke] = palette[region.kind];
      return new Style({
        fill: new Fill({ color: fill }),
        stroke: new Stroke({
          color: stroke,
          width: 1.5,
          lineDash: region.kind === 'uncalculated' ? [5, 6] : undefined,
        }),
        text: new Text({
          text: region.label,
          font: '11px Microsoft YaHei',
          fill: new Fill({ color: stroke }),
          overflow: false,
        }),
      });
    },
  });
}
