import { describe, expect, it } from 'vitest';
import { get as projection } from 'ol/proj';
import RegularShape from 'ol/style/RegularShape';
import type { Style } from 'ol/style';
import { initialResources } from '../src/mocks/resource-presets';
import { defaultGisDeviceSettings, gisDevicePoints, type GisDeviceMapFrame } from '../src/maps/gis-device-display';
import { createGisDeviceLayer, gisDeviceStyles } from '../src/maps/gis-device-layers';
import { projectCoordinate } from '../src/maps/layers';

const frame = (): GisDeviceMapFrame => ({ points: gisDevicePoints(initialResources()).points.slice(0, 3), settings: defaultGisDeviceSettings(), version: 1, selectedDeviceId: '' });
const labels = (styles: Style[]) => styles.map(style => style.getText()?.getText() ?? '').join(' ');
describe('设备图标及真实 OpenLayers 聚合', () => {
  it('两类图形不同，四种状态文字和颜色独立于站点，下架不改运行状态', () => {
    const data = frame(), a = data.points[0], b = { ...a, deviceClass: 'VUHF' as const };
    const hf = gisDeviceStyles([a], data.settings, ''), vu = gisDeviceStyles([b], data.settings, '');
    expect((hf[0].getImage() as RegularShape).getAngle()).not.toBe((vu[0].getImage() as RegularShape).getAngle());
    for (const [status, alert, word] of [['NORMAL', false, '正常'], ['NORMAL', true, '告警'], ['FAULT', false, '故障'], ['OFFLINE', true, '离线 · 告警']] as const) {
      const styles = gisDeviceStyles([{ ...a, status, alert, offShelf: true }], data.settings, '');
      expect(labels(styles)).toContain(word); expect(labels(styles)).toContain('已下架');
    }
  });
  it('故障优先于选中普通设备，选中标识和人工站点外框不替换状态色', () => {
    const data = frame(), point = data.points[0];
    const normal = gisDeviceStyles([point], data.settings, point.id), fault = gisDeviceStyles([{ ...point, status: 'FAULT', manualStation: true }], data.settings, '');
    expect(Math.max(...fault.map(s => s.getZIndex()!))).toBeGreaterThan(Math.max(...normal.map(s => s.getZIndex()!)));
    expect(labels(normal)).toContain(point.id); expect(fault).toHaveLength(3);
    expect((fault[1].getImage() as RegularShape).getStroke()!.getColor()).toBe('#f27887');
  });
  it('逐类透明度作用于单设备图形及文字，混合聚合的类型标识各自透明', () => {
    const data = frame(); data.settings.HF.opacity = 0.4; data.settings.VUHF.opacity = 0.7;
    const single = gisDeviceStyles([data.points[0]], data.settings, ''); expect(single[0].getImage()!.getOpacity()).toBe(0.4);
    expect(String(single[1].getText()!.getFill()!.getColor()).endsWith('66')).toBe(true);
    const mixed = gisDeviceStyles([data.points[0], { ...data.points[1], deviceClass: 'VUHF', status: 'FAULT', alert: true }], data.settings, '');
    expect(labels(mixed)).toContain('HF 1'); expect(labels(mixed)).toContain('VUHF 1'); expect(labels(mixed)).toContain('故障 1 · 告警 1');
    expect(mixed[1].getText()!.getFill()!.getColor()).toBe('#c5e4fa66'); expect(mixed[2].getText()!.getFill()!.getColor()).toBe('#c5e4fab3');
  });
  it('同站设备保持原坐标与数量，放大不伪造位置；不同站可自然拆开', () => {
    const data = frame(), manager = createGisDeviceLayer();
    data.points[2].coordinate = [data.points[0].coordinate[0] + 0.01, data.points[0].coordinate[1]];
    const before = JSON.stringify(data); manager.update(data); const source = manager.layer.getSource()!;
    const raw = source.getSource()!.getFeatures();
    expect(raw[0].getGeometry()!.getCoordinates()).toEqual(projectCoordinate(data.points[0].coordinate));
    source.loadFeatures([-Infinity, -Infinity, Infinity, Infinity], 100, projection('EPSG:3857')!);
    expect(source.getFeatures()).toHaveLength(1); expect(manager.pick(source.getFeatures()[0])?.ids).toHaveLength(3);
    source.loadFeatures([-Infinity, -Infinity, Infinity, Infinity], 1, projection('EPSG:3857')!);
    expect(source.getFeatures()).toHaveLength(2); expect(source.getFeatures().map(f => f.get('features').length).sort()).toEqual([1, 2]);
    expect(JSON.stringify(data)).toBe(before); manager.dispose();
  });
  it('透明度和选中复用几何，过期要素/隐藏模式不可点选，释放后不再绘制', () => {
    const data = frame(), manager = createGisDeviceLayer(); manager.update(data); const source = manager.layer.getSource()!;
    source.loadFeatures([-Infinity, -Infinity, Infinity, Infinity], 1, projection('EPSG:3857')!);
    const member = source.getFeatures()[0], raw = source.getSource()!.getFeatures()[0];
    const style = () => manager.layer.getStyleFunction()!(member, 1) as Style[];
    expect(labels(style())).toContain('HF 3'); data.settings.HF.opacity = 0.2; data.version++; manager.update(data);
    expect(source.getSource()!.getFeatures()[0]).toBe(raw); expect(style()[1].getText()!.getFill()!.getColor()).toBe('#c5e4fa33');
    data.points = data.points.slice(1); data.version++; manager.update(data); expect(manager.pick(member)).toBeUndefined();
    manager.update(); expect(manager.layer.getVisible()).toBe(false); manager.dispose(); manager.update(data);
    expect(manager.pick(member)).toBeUndefined();
  });
});
