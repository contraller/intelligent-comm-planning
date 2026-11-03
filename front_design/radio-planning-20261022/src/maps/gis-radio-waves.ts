import type Feature from 'ol/Feature';
import type BaseLayer from 'ol/layer/Base';
import Point from 'ol/geom/Point';
import { fromLonLat } from 'ol/proj';
import type { Station, InterferenceSource, Coordinate } from '../types/domain';
import type { GisNetwork } from '../types/gis-plan';
import type { ResourceMapFrame } from '../types/resource-read';
import type { MapProjection } from '../types/interference-workbench';
import type { PlanningMapOverlay } from './planning-api-layers';
import type { GisDeviceMapFrame, GisDevicePoint } from './gis-device-display';

export interface RadioWaveAnchor {
  id: string;
  coordinate: number[];
  kind: 'radio' | 'interference';
  opacity: number;
}
export interface RadioWaveScene {
  frozenNetwork?: GisNetwork | null;
  interferenceProjection?: MapProjection | null;
  stations?: readonly Station[];
  deviceFrame?: GisDeviceMapFrame;
  resourceFrame?: ResourceMapFrame | null;
  planningOverlay?: PlanningMapOverlay | null;
  interferences?: readonly InterferenceSource[];
}
export const RADIO_WAVE_LIMITS = Object.freeze({
  maxPoints: 48, spacing: 80, minRadius: 12, radius: 60, fps: 24,
  periodMs: 2400, peakOpacity: 0.65, lineWidth: 1.8, glow: 5,
});

const sameCoordinate = (a: readonly number[], b: readonly number[], epsilon = 0.01) =>
  a.length >= 2 && b.length >= 2 && a.every(Number.isFinite) && b.every(Number.isFinite)
  && Math.abs(a[0] - b[0]) < epsilon && Math.abs(a[1] - b[1]) < epsilon;
function rawCoordinate(row: Record<string, unknown>): Coordinate | undefined {
  const number = (value: unknown) => typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  const lon = number(row.lon), lat = number(row.lat);
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : undefined;
}

// Read actual visible singleton point features, then verify their current source.
// The effect has no range, RF calculation, operating-status or coverage meaning.
export function collectRadioWaveAnchors(layers: readonly BaseLayer[], scene: RadioWaveScene, resolution = 1, zoom = 0): RadioWaveAnchor[] {
  const result: RadioWaveAnchor[] = [];
  const network = scene.frozenNetwork, projection = scene.interferenceProjection;
  const nodes = new Map(network?.nodes.map(row => [row.id, row]));
  const frozenDevices = new Map(network?.devices.map(row => [row.id, row]));
  const radioStations = new Set(network?.devices.map(row => row.station_id));
  const stations = new Map(scene.stations?.map(row => [row.id, row]));
  const devices = new Map(scene.deviceFrame?.points.map(row => [row.id, row]));
  const resources = new Map(scene.resourceFrame?.points.map(row => [`${row.kind}:${row.id}`, row]));
  const sources = new Map(scene.interferences?.map(row => [row.id, row]));
  const planned = new Map(scene.planningOverlay?.nodes.map(row => [row.id, row]));
  const workNodes = new Map(projection?.nodes.map(row => [String(row.node_id), row]));
  const workSources = new Map(projection?.sources.map(row => [row.interference_id, row]));
  const owner = projection && `${projection.taskId}:${projection.planId}:${projection.runId}:${projection.sourceHash}:${projection.phase}`;
  let inspected = 0;
  function classify(feature: Feature): { id: string; coordinate: Coordinate; kind: RadioWaveAnchor['kind'] } | undefined {
    const kind = feature.get('kind'), id = feature.get('objectId');
    if (kind === 'frozen-plan-node') {
      const node = nodes.get(id);
      if (node && radioStations.has(id) && feature.get('snapshot') === network?.identity.snapshot_id)
        return { id: `frozen:${network!.identity.snapshot_id}:${id}`, coordinate: node.coordinate, kind: 'radio' };
    } else if ((kind === 'workbench-node' || kind === 'workbench-source') && owner && feature.get('owner') === owner) {
      const row = kind === 'workbench-node' ? workNodes.get(id) : workSources.get(id);
      const coordinate = row && rawCoordinate(row);
      if (coordinate && (kind === 'workbench-node' || row!.active === 'true'))
        return { id: `${owner}:${kind}:${id}`, coordinate, kind: kind === 'workbench-node' ? 'radio' : 'interference' };
    } else if (kind === 'api-planning-node') {
      const row = planned.get(id);
      if (row) return { id: `planning:${scene.planningOverlay?.snapshotId}:${id}`, coordinate: row.coordinate, kind: 'radio' };
    } else if (kind === 'resource-read-point') {
      const row = feature.get('object'), current = row && resources.get(`${row.kind}:${row.id}`);
      if (row && row === current && (row.kind === 'node' || row.active === true))
        return { id: `resource:${scene.resourceFrame!.revision}:${row.kind}:${row.id}`, coordinate: row.coordinate, kind: row.kind === 'node' ? 'radio' : 'interference' };
    } else if (kind === 'interference-source') {
      const row = feature.get('source');
      if (row && sources.get(id) === row && row.active === true)
        return { id: `interference:${network?.identity.snapshot_id ?? scene.resourceFrame?.revision ?? 'resource'}:${id}`, coordinate: row.coordinate, kind: 'interference' };
    } else {
      const station = feature.get('station') as Station | undefined;
      if (station && stations.get(station.id) === station && station.classes.length)
        return { id: `station:${station.id}`, coordinate: station.coordinate, kind: 'radio' };
      const device = feature.get('devicePoint') as GisDevicePoint | undefined;
      if (device) {
        const row = devices.get(device.id), frozen = frozenDevices.get(device.id), node = frozen && nodes.get(frozen.station_id);
        const setting = scene.deviceFrame?.settings[device.deviceClass];
        if (row && row.stationId === device.stationId && row.modelId === device.modelId && row.deviceClass === device.deviceClass
          && setting?.visible && setting.opacity > 0 && sameCoordinate(row.coordinate, device.coordinate, 1e-9))
          return { id: `device:${device.id}`, coordinate: row.coordinate, kind: 'radio' };
        if (frozen && node && frozen.station_id === device.stationId && frozen.model_id === device.modelId
          && frozen.device_class === device.deviceClass && sameCoordinate(node.coordinate, device.coordinate, 1e-9))
          return { id: `frozen:${network!.identity.snapshot_id}:${device.id}`, coordinate: node.coordinate, kind: 'radio' };
      }
    }
  }
  function visit(layer: BaseLayer, parentOpacity: number) {
    if (!layer.getVisible() || inspected >= 12000) return;
    const opacity = parentOpacity * layer.getOpacity();
    const min = layer.getMinResolution(), max = layer.getMaxResolution();
    if (opacity <= 0 || resolution < min || resolution >= max || zoom <= layer.getMinZoom() || zoom > layer.getMaxZoom()) return;
    const vector = layer as import('ol/layer/Vector').default;
    const children = (layer as import('ol/layer/Group').default).getLayers?.();
    if (children) { children.getArray().forEach(child => visit(child, opacity)); return; }
    const source = vector.getSource?.();
    if (!source || typeof source.getFeatures !== 'function') return;
    for (const rendered of source.getFeatures()) {
      if (++inspected > 12000) break;
      const members = rendered.get('features') as Feature[] | undefined;
      if (members && members.length !== 1) continue;
      const feature = members ? members[0] : rendered;
      const point = rendered.getGeometry();
      if (!(point instanceof Point)) continue;
      const value = classify(feature as Feature);
      if (!value || !sameCoordinate(point.getCoordinates(), fromLonLat(value.coordinate))) continue;
      const style = rendered.getStyleFunction?.() ?? vector.getStyleFunction?.();
      const styles = style?.(rendered, resolution);
      const images = (Array.isArray(styles) ? styles : styles ? [styles] : []).map(row => row.getImage()).filter(image => image && image.getOpacity() > 0);
      if (!images.length) continue;
      result.push({ id: value.id, coordinate: [...point.getCoordinates()], kind: value.kind,
        opacity: opacity * Math.max(...images.map(image => image!.getOpacity())) });
    }
  }
  layers.forEach(layer => visit(layer, 1));
  return result;
}

export interface RadioWavePoint extends Omit<RadioWaveAnchor, 'coordinate'> { pixel: number[] }
// A fixed pixel separation and a small global budget keep dense areas legible.
export function visibleRadioWavePoints(anchors: readonly RadioWaveAnchor[], project: (coordinate: number[]) => number[] | null, size: readonly number[]): RadioWavePoint[] {
  const points: RadioWavePoint[] = [], grid = new Map<string, RadioWavePoint[]>();
  const { spacing, radius, maxPoints } = RADIO_WAVE_LIMITS;
  // Keep the few displayed interference sources from being lost behind a much
  // larger radio layer; coincident symbols still produce only one decoration.
  const ordered = [...anchors.filter(row => row.kind === 'interference'), ...anchors.filter(row => row.kind === 'radio')];
  for (const anchor of ordered) {
    const pixel = project(anchor.coordinate);
    if (!pixel || !pixel.every(Number.isFinite) || pixel[0] < -radius || pixel[1] < -radius
      || pixel[0] > size[0] + radius || pixel[1] > size[1] + radius || anchor.opacity <= 0) continue;
    const gx = Math.floor(pixel[0] / spacing), gy = Math.floor(pixel[1] / spacing);
    let crowded = false;
    for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++)
      if (grid.get(`${x}:${y}`)?.some(row => Math.hypot(row.pixel[0] - pixel[0], row.pixel[1] - pixel[1]) < spacing)) crowded = true;
    if (crowded) continue;
    const point = { id: anchor.id, kind: anchor.kind, opacity: anchor.opacity, pixel: [...pixel] };
    points.push(point);
    const key = `${gx}:${gy}`;
    grid.set(key, [...(grid.get(key) ?? []), point]);
    if (points.length >= maxPoints) break;
  }
  return points;
}

export interface RadioWaveEnvironment {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
  hidden: () => boolean;
  reducedMotion: () => boolean;
  visible: () => boolean;
  pixelRatio: () => number;
  onVisibility: (callback: () => void) => () => void;
  onMotion: (callback: () => void) => () => void;
}
function browserEnvironment(canvas: HTMLCanvasElement): RadioWaveEnvironment {
  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  return {
    requestFrame: callback => window.requestAnimationFrame(callback), cancelFrame: id => window.cancelAnimationFrame(id),
    hidden: () => document.hidden, reducedMotion: () => motion?.matches ?? false,
    visible: () => canvas.isConnected && canvas.getClientRects().length > 0,
    pixelRatio: () => window.devicePixelRatio || 1,
    onVisibility: callback => { document.addEventListener('visibilitychange', callback); return () => document.removeEventListener('visibilitychange', callback); },
    onMotion: callback => { motion?.addEventListener?.('change', callback); return () => motion?.removeEventListener?.('change', callback); },
  };
}
function phase(id: string) {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return (hash % RADIO_WAVE_LIMITS.periodMs) / RADIO_WAVE_LIMITS.periodMs;
}
// This canvas never asks OpenLayers to redraw. Map render/size events supply pixels.
export function createRadioWaveOverlay(canvas: HTMLCanvasElement, environment?: RadioWaveEnvironment) {
  const context = (() => { try { return canvas.getContext?.('2d'); } catch { return null; } })();
  if (!context) return { update(_points: readonly RadioWavePoint[], _size: readonly number[]) {}, dispose() {} };
  const env = environment ?? browserEnvironment(canvas);
  let points: readonly (RadioWavePoint & { phase: number })[] = [], size: readonly number[] = [0, 0];
  let pending: number | undefined, lastDraw = -Infinity, disposed = false;
  function clear() { context!.clearRect(0, 0, size[0], size[1]); }
  function stop() {
    if (pending !== undefined) env.cancelFrame(pending);
    pending = undefined; lastDraw = -Infinity; clear();
  }
  function allowed() { return !disposed && points.length > 0 && size[0] > 0 && size[1] > 0 && !env.hidden() && !env.reducedMotion() && env.visible(); }
  function frame(time: number) {
    pending = undefined;
    if (!allowed()) { stop(); return; }
    if (time - lastDraw >= 1000 / RADIO_WAVE_LIMITS.fps) {
      lastDraw = time; clear();
      for (const point of points) for (const offset of [0, 0.5]) {
        const progress = (time / RADIO_WAVE_LIMITS.periodMs + point.phase + offset) % 1;
        const radius = RADIO_WAVE_LIMITS.minRadius + (RADIO_WAVE_LIMITS.radius - RADIO_WAVE_LIMITS.minRadius) * progress;
        const alpha = RADIO_WAVE_LIMITS.peakOpacity * (1 - progress) ** 1.2 * Math.min(1, point.opacity);
        const color = point.kind === 'interference' ? `rgba(245,180,81,${alpha})` : `rgba(78,220,220,${alpha})`;
        context!.strokeStyle = color; context!.shadowColor = color; context!.shadowBlur = RADIO_WAVE_LIMITS.glow; context!.lineWidth = RADIO_WAVE_LIMITS.lineWidth;
        // Side arcs leave the marker and the HF/VUHF captions above/below clear.
        context!.beginPath(); context!.arc(point.pixel[0], point.pixel[1], radius, -0.55, 0.55); context!.stroke();
        context!.beginPath(); context!.arc(point.pixel[0], point.pixel[1], radius, Math.PI - 0.55, Math.PI + 0.55); context!.stroke();
      }
    }
    pending = env.requestFrame(frame);
  }
  function resume() {
    if (!allowed()) { stop(); return; }
    if (pending === undefined) pending = env.requestFrame(frame);
  }
  const removeVisibility = env.onVisibility(resume), removeMotion = env.onMotion(resume);
  return {
    update(next: readonly RadioWavePoint[], nextSize: readonly number[]) {
      if (disposed) return;
      const ratio = Math.min(2, Math.max(1, env.pixelRatio()));
      const changed = size[0] !== nextSize[0] || size[1] !== nextSize[1] || points.length !== next.length
        || next.some((point, index) => point.id !== points[index]?.id || point.kind !== points[index]?.kind);
      size = [Math.max(0, nextSize[0] || 0), Math.max(0, nextSize[1] || 0)];
      const width = Math.round(size[0] * ratio), height = Math.round(size[1] * ratio);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      points = next.map(point => ({ ...point, pixel: [...point.pixel], phase: phase(point.id) }));
      // Clear on source replacement, not every normal OL render; otherwise
      // panning or an unrelated layer render would intermittently erase waves.
      if (changed) clear();
      resume();
    },
    dispose() { if (disposed) return; disposed = true; points = []; stop(); removeVisibility(); removeMotion(); },
  };
}
