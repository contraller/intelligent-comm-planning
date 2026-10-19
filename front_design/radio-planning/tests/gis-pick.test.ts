import { describe, expect, it } from 'vitest';
import Feature from 'ol/Feature';
import { createPickHighlight, nearestPickTarget, renderedPickTargets, validPickCoordinate } from '../src/maps/gis-pick';
import { projectCoordinate } from '../src/maps/layers';
import type { GisPickTarget } from '../src/types/gis-pick';

const target = (id: string, coordinate: [number, number], kind: GisPickTarget['kind'] = 'station'): GisPickTarget => ({ id, name: id, kind, coordinate });
const nearest = (rows: GisPickTarget[], owner: GisPickTarget | null = null) => nearestPickTarget([50, 50], rows, owner, p => p, [100, 100]);
describe('GIS 取点像素与坐标边界', () => {
  it('12 CSS 像素包含边界，超出则自由取点，不按经纬度距离近似', () => {
    expect(nearest([target('edge', [62, 50])])?.id).toBe('edge');
    expect(nearest([target('outside', [62.001, 50])])).toBeUndefined();
    expect(nearest([target('diagonal', [60, 60])])).toBeUndefined();
    expect(nearest([])).toBeUndefined();
  });
  it('最近点优先，同距按类型和 ID 固定排序，与数组顺序无关', () => {
    const a = target('A', [49, 50]), b = target('B', [51, 50]), other = target('A', [51, 50], 'interference');
    expect(nearest([b, a])?.id).toBe('A'); expect(nearest([a, b])?.id).toBe('A');
    expect(nearest([a, other])).toBe(other); expect(nearest([other, a])).toBe(other);
    expect(nearest([a, target('near', [50, 50])])?.id).toBe('near');
  });
  it('自身按类型加 ID 排除，同 ID 的另一种对象保留', () => {
    const own = target('A', [50, 50]), other = target('A', [51, 50], 'interference');
    expect(nearest([own, other], own)).toBe(other);
  });
  it.each([[NaN, 0], [Infinity, 0], [181, 0], [0, -91], [1], []].map(coordinate => ({ coordinate })))('拒绝非法坐标 $coordinate', ({ coordinate }) => {
    expect(validPickCoordinate(coordinate)).toBe(false);
  });
  it('视口外、投影失败、非法鼠标和空尺寸都不产生目标', () => {
    const rows = [target('A', [114, 37])];
    for (const point of [[-1, 50], [101, 50], [50, -1], [50, 101], [NaN, 50], null])
      expect(nearestPickTarget([50, 50], rows, null, () => point, [100, 100])).toBeUndefined();
    expect(nearestPickTarget([NaN, 0], rows, null, () => [50, 50], [100, 100])).toBeUndefined();
    expect(nearestPickTarget([50, 50], rows, null, () => [50, 50], [0, 100])).toBeUndefined();
  });
  it('使用目标 WGS84 原坐标，投影像素只用于命中', () => {
    const row = target('A', [114.123456, 37.654321]);
    expect(nearestPickTarget([10, 10], [row], null, () => [11, 10], [100, 100])).toBe(row);
    expect(row.coordinate).toEqual([114.123456, 37.654321]);
  });
  it('只接纳当前渲染单点，排除聚合成员、其他图标、隐藏层和旧坐标', () => {
    const a = target('A', [114, 37]), b = target('B', [115, 38]), source = target('S', [116, 39], 'interference');
    const fa = new Feature({ station: a }), fb = new Feature({ station: b });
    const cluster = new Feature({ features: [fa, fb] }), single = new Feature({ features: [fa] });
    const fs = new Feature({ kind: 'interference-source', source: { ...source, active: false } });
    const rows = [a, b, source];
    expect(renderedPickTargets(rows, [cluster], [fs], true, true)).toEqual([source]);
    expect(renderedPickTargets(rows, [single], [fs], true, false)).toEqual([a]);
    expect(renderedPickTargets(rows, [single], [fs], false, false)).toEqual([]);
    expect(renderedPickTargets([{ ...a, coordinate: [113, 37] }], [single], [], true, true)).toEqual([]);
    expect(renderedPickTargets(rows, [new Feature({ kind: 'gis-device-cluster', features: [new Feature({ device: a })] })], [], true, true)).toEqual([]);
  });
  it('辅助圈复用图层且不改业务对象，清空后不残留', () => {
    const row = target('A', [114, 37]), original = structuredClone(row), highlight = createPickHighlight();
    const layer = highlight.layer; highlight.update(row);
    const feature = layer.getSource()!.getFeatures()[0]!;
    expect(feature.getGeometry()!.getCoordinates()).toEqual(projectCoordinate(row.coordinate));
    highlight.update(row); expect(layer.getSource()!.getFeatures()[0]).toBe(feature);
    highlight.update(); expect(layer.getSource()!.getFeatures()).toEqual([]); expect(row).toEqual(original);
  });
});
