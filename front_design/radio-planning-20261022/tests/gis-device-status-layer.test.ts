import { afterEach, describe, expect, it, vi } from 'vitest';
import Observable from 'ol/Observable';
import Collection from 'ol/Collection';
import RenderEvent from 'ol/render/Event';
import type OlMap from 'ol/Map';
import type { FrameState } from 'ol/Map';
import type { GisNetwork } from '../src/types/gis-plan';
import { createGisDeviceStatusLayer, gisDeviceStatusFrame, gisDeviceStatusKey, observeGisDeviceStatusRender, type GisDeviceStatusOverlay } from '../src/maps/gis-device-status-layer';

function fixture() {
  const network: GisNetwork = { identity: { task_id: 'T', plan_id: 'P', snapshot_id: 'N', input_version: 'I', condition_version: 'C', resource_revision: 'R', state: 'CONFIRMED', source_changed: false, data_origin: 'SYNTHETIC_INTEGRATION', source: 'SR4' },
    nodes: [{ id: 'A', name: 'A', coordinate: [114, 37], status: 'NORMAL', alert: false }],
    devices: [{ id: 'D1', station_id: 'A', model_id: 'M1', device_class: 'HF', frequency_khz: null, tx_power_dbm: null, antenna_height_m: null },
      { id: 'D2', station_id: 'A', model_id: 'M2', device_class: 'VUHF', frequency_khz: null, tx_power_dbm: null, antenna_height_m: null }],
    links: [], demands: [], routes: [], paths_state: 'missing', paths_message: '' };
  const anchor = { snapshotId: 'S', snapshotRevision: 'V', resourceRevision: 'R' };
  const value: GisDeviceStatusOverlay = { taskId: 'T', planId: 'P', networkSnapshotId: 'N', anchor, appliedAt: '2026-10-24T00:00:00.000Z', selectedDeviceId: '',
    projections: { D1: { ref: { ...anchor, deviceId: 'D1' }, status: 'FAULT', alert: false, observedAt: null, unknownReasons: ['构造采集时间未知'], dataOrigin: 'SYNTHETIC_INTEGRATION' } } };
  return { network, value };
}
afterEach(() => { vi.unstubAllGlobals(); });
describe('independent frozen-network device status layer', () => {
  it('renders actual OL device features without changing frozen node or link state', () => {
    const { network, value } = fixture(), before = JSON.stringify(network), devices = createGisDeviceStatusLayer();
    const frame = devices.update(network, value)!;
    expect(frame.points).toMatchObject([{ id: 'D1', status: 'FAULT', alert: false }, { id: 'D2', status: null, alert: null }]);
    const features = devices.layer.getSource()!.getSource()!.getFeatures();
    expect(features).toHaveLength(2); expect(features[0].get('devicePoint')).toMatchObject({ id: 'D1', status: 'FAULT', stationId: 'A' });
    expect(features[0].getGeometry()!.getCoordinates()).toHaveLength(2); expect(JSON.stringify(network)).toBe(before);
    devices.update(network, null); expect(devices.layer.getVisible()).toBe(false); expect(devices.layer.getSource()!.getSource()!.getFeatures()).toHaveLength(0); devices.dispose();
  });
  it.each(['taskId', 'planId', 'networkSnapshotId'] as const)('rejects a cross-%s overlay', key => {
    const { network, value } = fixture(); value[key] = 'other'; expect(gisDeviceStatusFrame(network, value)).toBeUndefined();
  });
  it('rejects a foreign resource, preserves unknowns on a wrong status anchor and excludes non-network members', () => {
    const { network, value } = fixture(); value.anchor.resourceRevision = 'other'; expect(gisDeviceStatusFrame(network, value)).toBeUndefined();
    value.anchor.resourceRevision = 'R'; value.projections.D1.ref!.snapshotRevision = 'other'; value.projections.unrelated = value.projections.D1;
    expect(gisDeviceStatusFrame(network, value)?.points).toMatchObject([{ id: 'D1', status: null }, { id: 'D2', status: null }]);
  });
  it('updates the same OL layer and geometry values for the new same-resource state', () => {
    const { network, value } = fixture(), devices = createGisDeviceStatusLayer(), layer = devices.layer;
    devices.update(network, value); const before = devices.key();
    value.projections.D1.status = 'OFFLINE'; value.anchor.snapshotRevision = 'V2'; value.projections.D1.ref!.snapshotRevision = 'V2';
    devices.update(network, value); expect(devices.layer).toBe(layer); expect(devices.key()).not.toBe(before);
    expect(layer.getSource()!.getSource()!.getFeatures()[0].get('devicePoint').status).toBe('OFFLINE'); devices.dispose();
  });
});
describe('map completion evidence', () => {
  it('requires an actual layer postrender and matching map rendercomplete frame, rejects stale/hidden draws, and releases listeners', () => {
    const visibility = { hidden: false }; vi.stubGlobal('document', visibility);
    const { network, value } = fixture(), devices = createGisDeviceStatusLayer(); devices.update(network, value);
    const target = { isConnected: true, clientWidth: 100, clientHeight: 100, getClientRects: () => [{}] };
    const layers = new Collection([devices.layer]), events = Object.assign(new Observable(), { getLayers: () => layers, getTargetElement: () => target });
    let current: GisDeviceStatusOverlay | null = value;
    const report = vi.fn(), stop = observeGisDeviceStatusRender(events as unknown as OlMap, devices, () => current, report);
    const draw = (time: number) => devices.layer.dispatchEvent(new RenderEvent('postrender', undefined, { time } as FrameState));
    const complete = (time: number) => events.dispatchEvent(new RenderEvent('rendercomplete', undefined, { time } as FrameState));
    complete(1); expect(report).not.toHaveBeenCalled(); draw(1); complete(2); expect(report).not.toHaveBeenCalled();
    complete(1); expect(report).toHaveBeenCalledTimes(1); expect(report.mock.calls[0][0]).toMatchObject({ key: gisDeviceStatusKey(value), snapshotId: 'S', snapshotRevision: 'V', pointCount: 2 });
    expect(report.mock.calls[0][0].renderedAt).toBeTruthy();
    current = { ...value, anchor: { ...value.anchor, snapshotRevision: 'V2' }, appliedAt: '2026-10-24T00:01:00.000Z' };
    devices.update(network, current); complete(1); expect(report).toHaveBeenCalledTimes(1);
    draw(3); visibility.hidden = true; complete(3); expect(report).toHaveBeenCalledTimes(1);
    visibility.hidden = false; target.clientWidth = 0; complete(3); expect(report).toHaveBeenCalledTimes(1);
    target.clientWidth = 100; layers.remove(devices.layer); complete(3); expect(report).toHaveBeenCalledTimes(1);
    layers.push(devices.layer); complete(3); expect(report).toHaveBeenCalledTimes(2);
    current = null; devices.update(network, null); current = value; devices.update(network, current); draw(4); complete(4);
    expect(report).toHaveBeenCalledTimes(3); stop(); draw(5); complete(5); expect(report).toHaveBeenCalledTimes(3); devices.dispose();
  });
});
