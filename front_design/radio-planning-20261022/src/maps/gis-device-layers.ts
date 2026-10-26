import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import VectorSource from 'ol/source/Vector';
import Cluster from 'ol/source/Cluster';
import VectorLayer from 'ol/layer/Vector';
import { Circle, Fill, RegularShape, Stroke, Style, Text } from 'ol/style';
import { projectCoordinate } from './layers';
import { GIS_DEVICE_COLORS, GIS_DEVICE_TYPES, gisDeviceStatus, gisDeviceSummary, gisDeviceTone } from './gis-device-display';
import type { GisDeviceMapFrame, GisDevicePoint, GisDeviceSettings } from './gis-device-display';

const alphaColor = (color: string, opacity: number) => color + Math.round(opacity * 255).toString(16).padStart(2, '0');
function caption(text: string, color: string, offsetY: number, zIndex: number, offsetX = 0, opacity = 1) {
  return new Style({ text: new Text({ text, offsetY, offsetX, font: '11px Microsoft YaHei', declutterMode: 'declutter',
    fill: new Fill({ color: alphaColor(color, opacity) }), backgroundFill: new Fill({ color: alphaColor('#0c1b2d', opacity * 0.91) }), padding: [3, 4, 3, 4] }), zIndex });
}
// 每种设备使用不同轮廓和文字，颜色只表示它自己的运行状态。
export function gisDeviceStyles(points: readonly GisDevicePoint[], settings: GisDeviceSettings, selectedId: string): Style[] {
  if (!points.length) return [];
  const summary = gisDeviceSummary(points), selected = points.some(row => row.id === selectedId);
  const zIndex = summary.faults ? (selected ? 60 : 50) : selected ? 40 : summary.alerts ? 30 : 20;
  const manual = points.some(row => row.manualStation), styles: Style[] = [];
  if (points.length === 1) {
    const row = points[0], opacity = settings[row.deviceClass].opacity, color = GIS_DEVICE_COLORS[gisDeviceTone(row)];
    const icon = new RegularShape({ points: 4, radius: selected ? 12 : 10, angle: row.deviceClass === 'HF' ? 0 : Math.PI / 4, declutterMode: 'none',
      fill: new Fill({ color: '#10283d' }), stroke: new Stroke({ color, width: row.status === 'FAULT' ? 3 : 2 }) });
    icon.setOpacity(opacity);
    styles.push(new Style({ image: icon, zIndex }));
    styles.push(caption(`${row.deviceClass} · ${gisDeviceStatus(row)}${row.offShelf ? ' · 已下架' : ''}`, color, -24, zIndex, 0, opacity));
    if (selected) styles.push(caption(row.id, '#e4f3ff', 25, zIndex, 0, opacity));
    if (manual || selected) {
      const ring = new Circle({ radius: selected ? 17 : 15, declutterMode: 'none', stroke: new Stroke({ color: manual ? '#dcb976' : '#ffffff', width: 2 }) });
      ring.setOpacity(opacity); styles.unshift(new Style({ image: ring, zIndex: zIndex - 1 }));
    }
    return styles;
  }
  // 混合聚合的公共圆点只作选择入口；类别数量各自遵守所属图层透明度。
  const statusColor = summary.faults ? GIS_DEVICE_COLORS.FAULT : summary.alerts ? GIS_DEVICE_COLORS.ALERT : undefined;
  styles.push(new Style({ image: new Circle({ radius: selected ? 19 : 16, declutterMode: 'none', fill: new Fill({ color: '#143e63' }),
    stroke: new Stroke({ color: statusColor ?? (selected ? '#ffffff' : manual ? '#dcb976' : '#52a8db'), width: statusColor || selected || manual ? 3 : 1.5 }) }),
    text: new Text({ text: String(summary.count), declutterMode: 'none', font: 'bold 12px Microsoft YaHei', fill: new Fill({ color: '#e1f2ff' }) }), zIndex }));
  if (statusColor && (selected || manual)) styles.push(new Style({
    image: new Circle({ radius: selected ? 24 : 21, declutterMode: 'none', stroke: new Stroke({ color: selected ? '#ffffff' : '#dcb976', width: 2 }) }), zIndex: zIndex - 1,
  }));
  for (const type of GIS_DEVICE_TYPES) if (summary[type]) styles.push(caption(`${type === 'HF' ? '◇' : '□'} ${type} ${summary[type]}`,
    '#c5e4fa', 29, zIndex, summary.HF && summary.VUHF ? (type === 'HF' ? -36 : 36) : 0, settings[type].opacity));
  const warning = [summary.faults ? `故障 ${summary.faults}` : '', summary.alerts ? `告警 ${summary.alerts}` : ''].filter(Boolean).join(' · ');
  if (warning) styles.push(caption(warning, summary.faults ? GIS_DEVICE_COLORS.FAULT : GIS_DEVICE_COLORS.ALERT, -29, zIndex));
  // 聚合仍按原几何分组，缺省观测数量单独提示，不归入正常。
  const unknown = points.filter(row => row.status === null || row.alert === null).length;
  if (unknown) styles.push(caption(`状态/告警未提供 ${unknown}`, GIS_DEVICE_COLORS.UNKNOWN, warning ? -48 : -29, zIndex));
  if (manual) styles.push(caption('含人工站点', '#dcb976', 48, zIndex));
  return styles;
}

export function createGisDeviceLayer() {
  const source = new VectorSource<Feature<Point>>();
  const clusters = new Cluster({ distance: 36, source, createCluster: (geometry, features) =>
    new Feature({ geometry, features, kind: 'gis-device-cluster' }) });
  let current: GisDeviceMapFrame | undefined, signature = '', disposed = false, styleVersion = 0;
  const styles = new WeakMap<Feature, { version: number; selected: string; value: Style[] }>();
  const layer = new VectorLayer({ source: clusters, declutter: 'gis-device-captions', style: feature => {
    if (!current) return [];
    const item = feature as Feature, cached = styles.get(item);
    if (cached?.version === styleVersion && cached.selected === current.selectedDeviceId) return cached.value;
    const rows = (item.get('features') as Feature[]).map(member => member.get('devicePoint') as GisDevicePoint);
    const value = gisDeviceStyles(rows, current.settings, current.selectedDeviceId);
    styles.set(item, { version: styleVersion, selected: current.selectedDeviceId, value }); return value;
  } });
  return {
    layer,
    update(frame?: GisDeviceMapFrame) {
      if (disposed) return;
      current = frame; styleVersion++; layer.setVisible(!!frame);
      // 显隐/透明度/选择变化不重建已有设备几何；缩放由 OpenLayers 原聚合源处理。
      const next = frame ? JSON.stringify(frame.points) : '';
      if (next !== signature) {
        signature = next; source.clear();
        source.addFeatures((frame?.points ?? []).map(row => new Feature({ geometry: new Point(projectCoordinate(row.coordinate)), devicePoint: row })));
      }
      layer.changed();
    },
    pick(feature: Feature) {
      if (!current || !layer.getVisible() || !clusters.getFeatures().includes(feature)) return;
      const ids = (feature.get('features') as Feature[]).map(member => (member.get('devicePoint') as GisDevicePoint).id);
      if (!ids.length || ids.some(id => !current!.points.some(row => row.id === id))) return;
      return { ids, version: current.version };
    },
    dispose() { disposed = true; current = undefined; clusters.setSource(null); clusters.dispose(); source.dispose(); layer.dispose(); },
  };
}
