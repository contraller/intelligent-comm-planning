import type { GisNetwork } from '../types/gis-plan';
import type OlMap from 'ol/Map';
import { unByKey } from 'ol/Observable';
import { resolveDeviceStatusProjection, type FrozenDeviceStatusAnchor, type FrozenDeviceStatusProjection } from '../stores/monitoring';
import { createGisDeviceLayer } from './gis-device-layers';
import { defaultGisDeviceSettings, type GisDeviceMapFrame } from './gis-device-display';

export interface GisDeviceStatusOverlay {
  taskId: string; planId: string; networkSnapshotId: string;
  anchor: FrozenDeviceStatusAnchor;
  projections: Record<string, FrozenDeviceStatusProjection>;
  appliedAt: string;
  selectedDeviceId: string;
}
export interface GisDeviceStatusRender {
  key: string; snapshotId: string; snapshotRevision: string; resourceRevision: string;
  appliedAt: string; renderedAt: string; pointCount: number;
}

export function gisDeviceStatusFrame(network: GisNetwork | null | undefined, value: GisDeviceStatusOverlay | null | undefined): GisDeviceMapFrame | undefined {
  if (!network || !value || value.taskId !== network.identity.task_id || value.planId !== network.identity.plan_id
    || value.networkSnapshotId !== network.identity.snapshot_id || value.anchor.resourceRevision !== network.identity.resource_revision
    || !value.anchor.snapshotId || !value.anchor.snapshotRevision || !value.appliedAt) return;
  const nodes = new Map(network.nodes.map(node => [node.id, node]));
  const points: GisDeviceMapFrame['points'] = [];
  for (const device of network.devices) {
    const node = nodes.get(device.station_id);
    if (!node || !node.coordinate.every(Number.isFinite) || Math.abs(node.coordinate[0]) > 180 || Math.abs(node.coordinate[1]) > 90) continue;
    const status = resolveDeviceStatusProjection(value.projections[device.id], value.anchor, device.id);
    points.push({ id: device.id, stationId: node.id, stationName: node.name, modelId: device.model_id, deviceClass: device.device_class,
      coordinate: [...node.coordinate], status: status?.status ?? null, alert: status?.alert ?? null, offShelf: false, manualStation: false });
  }
  return { points, selectedDeviceId: value.selectedDeviceId, settings: defaultGisDeviceSettings(), version: 0 };
}

export function gisDeviceStatusKey(value: GisDeviceStatusOverlay): string {
  return JSON.stringify([value.taskId, value.planId, value.networkSnapshotId, value.anchor.resourceRevision,
    value.anchor.snapshotId, value.anchor.snapshotRevision, value.appliedAt]);
}

// 独立设备要素，不修改冻结节点或链路；原聚合样式只统计设备成员。
export function createGisDeviceStatusLayer() {
  const devices = createGisDeviceLayer();
  devices.layer.setZIndex(55);
  let key = '', version = 0, generation = 0;
  return {
    layer: devices.layer,
    pick: devices.pick,
    key: () => key,
    generation: () => generation,
    update(network: GisNetwork | null | undefined, value: GisDeviceStatusOverlay | null | undefined) {
      const frame = gisDeviceStatusFrame(network, value);
      const next = frame && value ? gisDeviceStatusKey(value) : '';
      if (next !== key) generation++;
      key = next;
      devices.update(frame ? { ...frame, version: ++version } : undefined);
      return frame;
    },
    dispose: devices.dispose,
  };
}

export function observeGisDeviceStatusRender(map: OlMap, devices: ReturnType<typeof createGisDeviceStatusLayer>,
  read: () => GisDeviceStatusOverlay | null | undefined, report: (value: GisDeviceStatusRender) => void) {
  let drawn: { key: string; time: number; generation: number } | null = null;
  const layerListener = devices.layer.on('postrender', event => {
    const value = read(), key = value ? gisDeviceStatusKey(value) : '';
    drawn = value && key === devices.key() && devices.layer.getVisible() && event.frameState ? { key, time: event.frameState.time, generation: devices.generation() } : null;
  });
  const mapListener = map.on('rendercomplete', event => {
    const value = read(), key = value ? gisDeviceStatusKey(value) : '', target = map.getTargetElement();
    if (!value || !key || devices.key() !== key || drawn?.key !== key || drawn.generation !== devices.generation() || drawn.time !== event.frameState?.time
      || !target?.isConnected || !target.getClientRects().length || target.clientWidth <= 0 || target.clientHeight <= 0
      || !devices.layer.getVisible() || !map.getLayers().getArray().includes(devices.layer) || document.hidden) return;
    const pointCount = devices.layer.getSource()?.getSource()?.getFeatures().length ?? 0;
    if (!pointCount) return;
    report({ key, ...value.anchor, appliedAt: value.appliedAt, renderedAt: new Date().toISOString(), pointCount });
  });
  return () => { unByKey(layerListener); unByKey(mapListener); };
}
