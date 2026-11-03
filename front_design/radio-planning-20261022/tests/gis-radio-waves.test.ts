import { describe, expect, it, vi } from 'vitest';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import LayerGroup from 'ol/layer/Group';
import VectorSource from 'ol/source/Vector';
import { Circle, Style } from 'ol/style';
import { fromLonLat, get as projection } from 'ol/proj';
import example from '../src/config/gis-situation-example.json';
import { readGisNetwork } from '../src/services/gis-plan-validation';
import { gisPlanLayer } from '../src/maps/gis-plan-layers';
import { interferenceLayer } from '../src/maps/resource-layers';
import { resourceReadLayer } from '../src/maps/resource-read-layers';
import { createGisDeviceLayer } from '../src/maps/gis-device-layers';
import { defaultGisDeviceSettings, type GisDeviceMapFrame } from '../src/maps/gis-device-display';
import {
  collectRadioWaveAnchors, createRadioWaveOverlay, visibleRadioWavePoints, RADIO_WAVE_LIMITS,
  type RadioWaveAnchor, type RadioWaveEnvironment, type RadioWavePoint,
} from '../src/maps/gis-radio-waves';
import type { ResourceMapFrame } from '../src/types/resource-read';
import type { InterferenceSource } from '../src/types/domain';

function network() {
  return readGisNetwork(example.network, { planId: example.network.identity.plan_id, taskId: example.network.identity.task_id });
}
const icon = () => new Style({ image: new Circle({ radius: 6 }) });

describe('GIS decorative radio point selection', () => {
  it('only uses the displayed frozen snapshot, never current same-name nodes or coverage geometry', () => {
    const value = network(), layer = gisPlanLayer(value);
    const anchors = collectRadioWaveAnchors([layer], { frozenNetwork: value });
    expect(anchors.length).toBe(new Set(value.devices.map(row => row.station_id)).size);
    expect(anchors.every(row => row.id.startsWith(`frozen:${value.identity.snapshot_id}:`))).toBe(true);
    const changed = structuredClone(value);
    changed.identity.snapshot_id = 'SNP-NEW';
    expect(collectRadioWaveAnchors([layer], { frozenNetwork: changed })).toEqual([]);
    const node = value.nodes[0];
    layer.getSource()!.getFeatures().find(row => row.get('objectId') === node.id && row.get('kind') === 'frozen-plan-node')!
      .setGeometry(new Point(fromLonLat([node.coordinate[0] + 0.02, node.coordinate[1]])));
    expect(collectRadioWaveAnchors([layer], { frozenNetwork: value })).toHaveLength(anchors.length - 1);
  });

  it('respects actual layer, parent, zoom and symbol visibility', () => {
    const value = network(), layer = gisPlanLayer(value);
    layer.setVisible(false); expect(collectRadioWaveAnchors([layer], { frozenNetwork: value })).toEqual([]);
    layer.setVisible(true); layer.setOpacity(0); expect(collectRadioWaveAnchors([layer], { frozenNetwork: value })).toEqual([]);
    layer.setOpacity(0.5);
    const group = new LayerGroup({ layers: [layer], opacity: 0.4 });
    expect(collectRadioWaveAnchors([group], { frozenNetwork: value })[0].opacity).toBeCloseTo(0.2);
    group.setVisible(false); expect(collectRadioWaveAnchors([group], { frozenNetwork: value })).toEqual([]);
    layer.setMinZoom(9); expect(collectRadioWaveAnchors([layer], { frozenNetwork: value }, 1, 8)).toEqual([]);
    layer.setMinZoom(-Infinity);
    layer.getSource()!.getFeatures().forEach(row => row.setStyle([]));
    expect(collectRadioWaveAnchors([layer], { frozenNetwork: value })).toEqual([]);
  });

  it('does not turn a multi-radio aggregate into a transmitter; singleton honors device settings', () => {
    const value = network(), node = value.nodes[0], device = value.devices.find(row => row.station_id === node.id)!;
    const point = { id: device.id, stationId: node.id, stationName: node.name, modelId: device.model_id,
      deviceClass: device.device_class, coordinate: node.coordinate, status: null, alert: null, offShelf: false, manualStation: false };
    const frame: GisDeviceMapFrame = { points: [point, { ...point, id: 'OTHER' }], version: 1, settings: defaultGisDeviceSettings(), selectedDeviceId: '' };
    const devices = createGisDeviceLayer(); devices.update(frame);
    devices.layer.getSource()!.loadFeatures([], 100, projection('EPSG:3857')!);
    expect(devices.layer.getSource()!.getFeatures()).toHaveLength(1);
    expect(collectRadioWaveAnchors([devices.layer], { deviceFrame: frame })).toEqual([]);
    frame.points = [point]; devices.update(frame);
    expect(collectRadioWaveAnchors([devices.layer], { deviceFrame: frame })).toHaveLength(1);
    frame.settings[point.deviceClass].visible = false;
    expect(collectRadioWaveAnchors([devices.layer], { deviceFrame: frame })).toEqual([]);
    devices.dispose();
  });

  it('keeps same-frame interference points and ignores inactive sources and server clusters', () => {
    const source: InterferenceSource = { id: 'J1', name: '干扰源', coordinate: [114.2, 37.4], elevationM: null,
      antennaHeightM: 10, centerFreqKhz: 6000, bandwidthKhz: 3, txPowerDbm: 25, antennaGainDbi: null,
      interferenceType: 'NARROWBAND', patternType: null, azimuthDeg: null, dutyCycle: null, active: true, origin: 'SOURCE' };
    const layer = interferenceLayer([source]);
    expect(collectRadioWaveAnchors([layer], { interferences: [source] })[0].kind).toBe('interference');
    expect(collectRadioWaveAnchors([layer], { interferences: [{ ...source }] })).toEqual([]);
    source.active = false; expect(collectRadioWaveAnchors([layer], { interferences: [source] })).toEqual([]);
    const frame: ResourceMapFrame = { revision: 'resource-123', bbox: [113, 36, 116, 39], zoom: 9,
      points: [{ kind: 'node', id: 'N1', name: 'node', coordinate: [114, 37], status: null, alert: null, active: null }],
      clusters: [{ kind: 'node', id: 'CL1', coordinate: [115, 37], count: 30, bounds: [114, 36, 116, 38], expansionZoom: 10 }],
      totalNodes: 31, totalInterferences: 0 };
    const resource = resourceReadLayer(frame);
    expect(collectRadioWaveAnchors([resource], { resourceFrame: frame })).toHaveLength(1);
    expect(collectRadioWaveAnchors([resource], { resourceFrame: structuredClone(frame) })).toEqual([]);
  });

  it('rejects a stale workbench owner even when object ids and coordinates match', () => {
    const value = { taskId: 'T1', planId: 'P1', runId: 'R1', sourceHash: 'hash', phase: 'BEFORE',
      nodes: [{ node_id: 'N1', lon: '114', lat: '37' }], sources: [] };
    const point = new Feature({ geometry: new Point(fromLonLat([114, 37])), kind: 'workbench-node', objectId: 'N1', owner: 'T1:P1:R1:hash:BEFORE' });
    const layer = new VectorLayer({ source: new VectorSource({ features: [point] }), style: icon() });
    const scene = { interferenceProjection: value as unknown as import('../src/types/interference-workbench').MapProjection };
    expect(collectRadioWaveAnchors([layer], scene)).toHaveLength(1);
    point.set('owner', 'T1:P1:R0:hash:BEFORE');
    expect(collectRadioWaveAnchors([layer], scene)).toEqual([]);
  });

  it('thins overlapping points, caps the visible budget, and reprojects pan/zoom accurately', () => {
    const anchors: RadioWaveAnchor[] = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, kind: 'radio', coordinate: [(i % 100) * 60, Math.floor(i / 100) * 60], opacity: 1 }));
    const crowded = [...anchors, ...anchors];
    const points = visibleRadioWavePoints(crowded, coordinate => coordinate, [6000, 600]);
    expect(points).toHaveLength(RADIO_WAVE_LIMITS.maxPoints);
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++)
      expect(Math.hypot(points[i].pixel[0] - points[j].pixel[0], points[i].pixel[1] - points[j].pixel[1])).toBeGreaterThanOrEqual(80);
    expect(visibleRadioWavePoints(anchors.slice(0, 1), xy => [xy[0] + 80, xy[1] + 90], [960, 640])[0].pixel).toEqual([80, 90]);
    expect(visibleRadioWavePoints(anchors, () => [-100, -100], [960, 640])).toEqual([]);
    const samePoint: RadioWaveAnchor = { id: 'J1', kind: 'interference', coordinate: anchors[0].coordinate, opacity: 1 };
    expect(visibleRadioWavePoints([...anchors, samePoint], coordinate => coordinate, [6000, 600])[0].id).toBe('J1');
  });
});

function canvasHarness() {
  const context = { clearRect: vi.fn(), setTransform: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), strokeStyle: '', shadowColor: '', shadowBlur: 0, lineWidth: 0 };
  const canvas = { getContext: () => context, width: 0, height: 0 } as unknown as HTMLCanvasElement;
  const frames = new Map<number, FrameRequestCallback>(), visibility = new Set<() => void>(), motion = new Set<() => void>();
  let nextId = 0, hidden = false, reduced = false, visible = true;
  const env: RadioWaveEnvironment = {
    requestFrame: fn => { const id = ++nextId; frames.set(id, fn); return id; }, cancelFrame: id => { frames.delete(id); },
    hidden: () => hidden, reducedMotion: () => reduced, visible: () => visible, pixelRatio: () => 3,
    onVisibility: fn => { visibility.add(fn); return () => { visibility.delete(fn); }; },
    onMotion: fn => { motion.add(fn); return () => { motion.delete(fn); }; },
  };
  const tick = (time: number) => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(time)); };
  return { context, canvas, frames, visibility, motion, env, tick,
    setHidden(value: boolean) { hidden = value; visibility.forEach(fn => fn()); },
    setReduced(value: boolean) { reduced = value; motion.forEach(fn => fn()); },
    setVisible(value: boolean) { visible = value; } };
}
const wavePoints: RadioWavePoint[] = [{ id: 'radio1', pixel: [100, 120], opacity: 1, kind: 'radio' }, { id: 'jammer1', pixel: [250, 120], opacity: 0.5, kind: 'interference' }];

describe('independent radio wave canvas lifecycle', () => {
  it('draws larger fading side arcs at <=24fps without any map redraw API', () => {
    const h = canvasHarness(), overlay = createRadioWaveOverlay(h.canvas, h.env);
    overlay.update(wavePoints, [960, 640]);
    expect([h.canvas.width, h.canvas.height]).toEqual([1920, 1280]);
    h.tick(0); expect(h.context.arc).toHaveBeenCalledTimes(8);
    const firstRadius = h.context.arc.mock.calls[0][2];
    h.tick(16); h.tick(32); expect(h.context.arc).toHaveBeenCalledTimes(8);
    h.tick(48); expect(h.context.arc).toHaveBeenCalledTimes(16);
    const clears = h.context.clearRect.mock.calls.length;
    overlay.update(wavePoints, [960, 640]);
    expect(h.context.clearRect).toHaveBeenCalledTimes(clears);
    expect(h.context.arc.mock.calls[8][2]).toBeGreaterThan(firstRadius);
    for (const args of h.context.arc.mock.calls) { expect(args[2]).toBeGreaterThanOrEqual(12); expect(args[2]).toBeLessThanOrEqual(60); }
    expect(h.context.strokeStyle).toContain('245,180,81');
    expect(h.frames.size).toBe(1);
    overlay.dispose(); expect(h.frames.size).toBe(0);
  });

  it('makes the larger two wavefronts conspicuous while leaving the center and caption directions empty', () => {
    const h = canvasHarness(), overlay = createRadioWaveOverlay(h.canvas, h.env), colors: string[] = [];
    h.context.stroke.mockImplementation(() => { colors.push(h.context.strokeStyle); });
    overlay.update([{ id: 'A', pixel: [100, 120], opacity: 1, kind: 'radio' }], [960, 640]);
    h.tick(0);
    expect(h.context.arc).toHaveBeenCalledTimes(4);
    expect(h.context.arc.mock.calls[2][2] - h.context.arc.mock.calls[0][2]).toBeCloseTo(24);
    const opacity = (color: string) => Number(color.slice(color.lastIndexOf(',') + 1, -1));
    expect(opacity(colors[0])).toBeGreaterThan(0.6);
    expect(h.context.lineWidth).toBe(1.8); expect(h.context.shadowBlur).toBe(5);
    h.tick(1090);
    expect(Math.max(...h.context.arc.mock.calls.map(args => args[2]))).toBeGreaterThan(58);
    expect(opacity(colors[4])).toBeLessThan(opacity(colors[0]));
    for (const args of h.context.arc.mock.calls) {
      expect(args[2]).toBeGreaterThanOrEqual(12); expect(args[2]).toBeLessThanOrEqual(60);
      expect(args[4] - args[3]).toBeCloseTo(1.1);
      expect(Math.abs(Math.sin((args[3] + args[4]) / 2))).toBeLessThan(0.001);
    }
    overlay.dispose();
  });

  it('cancels hidden/reduced-motion loops, clears old pixels and resumes exactly one loop', () => {
    const h = canvasHarness(), overlay = createRadioWaveOverlay(h.canvas, h.env);
    overlay.update(wavePoints, [960, 640]); h.tick(0);
    const draws = h.context.arc.mock.calls.length;
    h.setHidden(true); expect(h.frames.size).toBe(0);
    h.setHidden(false); h.setHidden(false); expect(h.frames.size).toBe(1);
    h.setReduced(true); expect(h.frames.size).toBe(0);
    overlay.update(wavePoints, [960, 640]); expect(h.frames.size).toBe(0);
    h.tick(500); expect(h.context.arc.mock.calls.length).toBe(draws);
    h.setReduced(false); expect(h.frames.size).toBe(1);
    overlay.update([], [960, 640]); expect(h.frames.size).toBe(0);
    expect(h.context.clearRect).toHaveBeenLastCalledWith(0, 0, 960, 640);
    overlay.update(wavePoints, [960, 640]); h.setVisible(false); h.tick(600); expect(h.frames.size).toBe(0);
    h.setVisible(true); overlay.update(wavePoints, [960, 640]); expect(h.frames.size).toBe(1);
    const stale = [...h.frames.values()][0]; overlay.dispose(); stale(700);
    expect(h.frames.size).toBe(0); expect(h.visibility.size).toBe(0); expect(h.motion.size).toBe(0);
    overlay.update(wavePoints, [960, 640]); expect(h.frames.size).toBe(0);
  });

  it('replaces the previous source and position before another frame and disposes without canvas support', () => {
    const h = canvasHarness(), overlay = createRadioWaveOverlay(h.canvas, h.env);
    overlay.update(wavePoints, [960, 640]); h.tick(0);
    overlay.update([{ ...wavePoints[0], id: 'new-snapshot', pixel: [330, 400] }], [960, 640]);
    expect(h.context.clearRect).toHaveBeenLastCalledWith(0, 0, 960, 640);
    h.context.arc.mockClear(); h.tick(48);
    expect(h.context.arc.mock.calls.every(args => args[0] === 330 && args[1] === 400)).toBe(true);
    overlay.dispose();
    expect(() => createRadioWaveOverlay({} as HTMLCanvasElement).dispose()).not.toThrow();
    expect(() => createRadioWaveOverlay({ getContext() { throw new Error('canvas unavailable'); } } as unknown as HTMLCanvasElement).dispose()).not.toThrow();
  });
});
