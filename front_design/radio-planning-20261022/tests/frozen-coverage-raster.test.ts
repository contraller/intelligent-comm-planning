import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromLonLat } from 'ol/proj';
import {
  attachCoverageRaster,
  buildCoverageRaster,
  cachedCoverageRaster,
  coverageScreenSize,
  COVERAGE_RASTER_LIMITS,
  type CoverageRaster,
} from '../src/maps/frozen-coverage-raster';
import { frozenCoverageLayer } from '../src/maps/frozen-coverage-layers';
import { coverageV5Case } from './helpers/frozen-coverage';
import type { FrozenCoverageFeature, FrozenCoverageOverlay } from '../src/types/frozen-coverage';
import type { FrameState } from 'ol/Map';
import { mkdir,readFile,writeFile } from 'node:fs/promises';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const dem: [number,number,number,number] = [113.9, 37.4, 114.3, 37.8];
function tile(
  x: number,
  y: number,
  grade: 'WEAK' | 'MEDIUM' | 'STRONG' = 'WEAK',
  field = 20,
): FrozenCoverageFeature {
  const w = 114 + x * 0.01,
    s = 37.5 + y * 0.01,
    e = w + 0.01,
    n = s + 0.01;
  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
    properties: {
      device_id: 'D1',
      node_id: 'N1',
      freq_khz: 30000,
      is_coverage: true,
      surface_kind: 'TERRAIN_CELL',
      strength_class: grade,
      field_strength_dbuvm: field,
    },
  };
}
function alphaAt(raster: CoverageRaster, lon: number, lat: number) {
  const [x, y] = fromLonLat([lon, lat]),
    [w, s, e, n] = raster.extent;
  const col = Math.floor(((x - w) / (e - w)) * raster.width),
    row = Math.floor(((n - y) / (n - s)) * raster.height);
  return col < 0 || col >= raster.width || row < 0 || row >= raster.height
    ? 0
    : raster.pixels[(row * raster.width + col) * 4 + 3];
}
function rgbaAt(raster: CoverageRaster, lon: number, lat: number) {
  const [x, y] = fromLonLat([lon, lat]),
    [w, s, e, n] = raster.extent;
  const i =
    (Math.floor(((n - y) / (n - s)) * raster.height) * raster.width +
      Math.floor(((x - w) / (e - w)) * raster.width)) *
    4;
  return [...raster.pixels.slice(i, i + 4)];
}

describe('V6覆盖格面展示平滑', () => {
  it('随包受控默认态势的现有V6格面可平滑，三个模式不改来源',async()=>{
    const value=JSON.parse(await readFile('src/config/gis-situation-coverage.json','utf-8'));
    const device=value.result.devices.find((row:{status:string})=>row.status==='COMPLETE');
    const features=device.computations.flatMap((part:{shape:string;geojson:{features:FrozenCoverageFeature[]}})=>part.shape==='CELLS'?part.geojson.features.filter(feature=>feature.properties.is_coverage):[]);
    const before=JSON.stringify(features),output=process.env.COVERAGE_VISUAL_OUTPUT;
    if(output)await mkdir(output,{recursive:true});
    for(const mode of ['strength','field','boundary'] as const){
      const raster=buildCoverageRaster(features,mode,value.result.provenance.dem_bbox)!;expect(raster).not.toBeNull();expect(raster.sourceCells).toBe(features.length);
      if(output){await writeFile(output+'/'+mode+'.rgba',raster.pixels);await writeFile(output+'/'+mode+'.json',JSON.stringify({...raster,pixels:undefined,deviceId:device.device_id,anchor:value.anchor},null,2));}
    }
    expect(JSON.stringify(features)).toBe(before);
  });
  it('一次合成后产生柔和边缘/色带，不改变原格面、数值或等级', () => {
    const rows = [tile(0, 0, 'WEAK', 20), tile(1, 0, 'MEDIUM', 35), tile(2, 0, 'STRONG', 50)],
      before = JSON.stringify(rows),
      raster = buildCoverageRaster(rows, 'strength', dem)!;
    expect(raster.sourceCells).toBe(3);
    expect(raster.blurPixels).toBeGreaterThan(0);
    expect(raster.blurPixels * raster.pixelMeters).toBeLessThan(1114 * 0.5);
    expect(rgbaAt(raster, 114.005, 37.505)[3]).toBe(148);
    expect(rgbaAt(raster, 114.025, 37.505)[1]).toBeGreaterThan(rgbaAt(raster, 114.025, 37.505)[0]);
    expect([...raster.pixels].filter((_, i) => i % 4 === 3).some((a) => a > 0 && a < 148)).toBe(
      true,
    );
    expect(rgbaAt(raster, 114.01, 37.505).slice(0, 3)).not.toEqual([224, 147, 74]);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it('保留不规则外形、缺少区域及大内孔，不用凸包连接离散格', () => {
    const rows: FrozenCoverageFeature[] = [];
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++)
        if (!(x >= 2 && x <= 4 && y >= 2 && y <= 4) && !(x === 6 && y >= 4)) rows.push(tile(x, y));
    rows.push(tile(12, 1));
    const raster = buildCoverageRaster(rows, 'strength', dem)!;
    expect(alphaAt(raster, 114.035, 37.535)).toBe(0);
    expect(alphaAt(raster, 114.065, 37.565)).toBe(0);
    expect(alphaAt(raster, 114.095, 37.515)).toBe(0);
    expect(alphaAt(raster, 114.005, 37.505)).toBeGreaterThan(100);
    expect(alphaAt(raster, 114.125, 37.515)).toBeGreaterThan(100);
    expect(alphaAt(raster, 113.994, 37.505)).toBe(0);
  });
  it('同一格多频重叠不会增加不透明度，热力仍按已有绝对场强着色', () => {
    const rows = [tile(0, 0, 'WEAK', 20), tile(1, 0, 'WEAK', 50)],
      one = buildCoverageRaster(rows, 'field', dem)!,
      twice = buildCoverageRaster([...rows, ...rows], 'field', dem)!;
    expect(twice.pixels).toEqual(one.pixels);
    expect(rgbaAt(one, 114.005, 37.505)).not.toEqual(rgbaAt(one, 114.015, 37.505));
    expect(Math.max(...[...one.pixels].filter((_, i) => i % 4 === 3))).toBe(148);
  });
  it('边界模式只绘制柔化外缘和孔边，内部不填色', () => {
    const rows = [];
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++) if (!(x === 2 && y === 2)) rows.push(tile(x, y));
    const raster = buildCoverageRaster(rows, 'boundary', dem)!;
    expect(alphaAt(raster, 114.005, 37.505)).toBe(0);
    expect(alphaAt(raster, 114.025, 37.525)).toBe(0);
    expect([...raster.pixels].filter((_, i) => i % 4 === 3).some((a) => a > 0)).toBe(true);
  });
  it.each(['triangle', 'hole', 'missing', 'point', 'field', 'outside'] as const)(
    '拒绝%s进入平滑合成，交原始图层处理',
    (kind) => {
      const value = tile(0, 0);
      if (kind === 'triangle' && value.geometry?.type === 'Polygon')
        value.geometry.coordinates[0].splice(2, 1);
      if (kind === 'hole' && value.geometry?.type === 'Polygon')
        value.geometry.coordinates.push([...value.geometry.coordinates[0]]);
      if (kind === 'missing') value.properties.strength_class = undefined;
      if (kind === 'point') value.geometry = { type: 'Point', coordinates: [114, 37.5] };
      if (kind === 'field') value.properties.field_strength_dbuvm = NaN;
      expect(
        buildCoverageRaster(
          [value],
          'strength',
          kind === 'outside' ? [114.001, 37.5, 114.01, 37.51] : dem,
        ),
      ).toBeNull();
    },
  );
  it('大范围显示与高DPI屏幕画布有明确尺寸上限，DEM外不晕染', () => {
    const raster = buildCoverageRaster(
      [tile(0, 0), tile(300, 300)],
      'strength',
      [113, 37, 118, 42],
    )!;
    expect(raster.width).toBeLessThanOrEqual(1024);
    expect(raster.height).toBeLessThanOrEqual(1024);
    expect(raster.width * raster.height).toBeLessThanOrEqual(COVERAGE_RASTER_LIMITS.pixels);
    const clipped = buildCoverageRaster([tile(0, 0)], 'strength', [114, 37.5, 114.01, 37.51])!;
    expect(clipped.extent).toEqual([...fromLonLat([114, 37.5]), ...fromLonLat([114.01, 37.51])]);
    const screen = coverageScreenSize([7680, 4320], 4)!;
    expect(screen.width).toBeLessThanOrEqual(3072);
    expect(screen.width * screen.height).toBeLessThanOrEqual(COVERAGE_RASTER_LIMITS.screenPixels);
    expect(coverageScreenSize([0, 400], 2)).toBeNull();
    expect(coverageScreenSize([NaN, 400], 2)).toBeNull();
  });
  it('缓存命中复用合成像素，来源、模式或原格面变化分别隔离', () => {
    const rows = [tile(0, 0)],
      a = cachedCoverageRaster('source-a', rows, 'strength', dem)!;
    expect(cachedCoverageRaster('source-a', rows, 'strength', dem)).toBe(a);
    expect(cachedCoverageRaster('source-b', rows, 'strength', dem)).not.toBe(a);
    expect(cachedCoverageRaster('source-a', rows, 'field', dem)).not.toBe(a);
    rows[0].properties.field_strength_dbuvm = 35;
    expect(cachedCoverageRaster('source-a', rows, 'strength', dem)).not.toBe(a);
  });
});

function overlayFixture() {
  const f = coverageV5Case();
  f.anchor.engine_version = 'V01-6';
  f.result.provenance.engine_version = 'V01-6';
  f.result.provenance.dem_bbox = dem;
  f.result.devices[0].computations[0].geojson.features = [
    tile(0, 0),
    tile(1, 0, 'MEDIUM', 35),
    tile(2, 0, 'STRONG', 50),
  ];
  return {
    f,
    overlay: { anchor: f.anchor, result: f.result, deviceId: 'D1' } as FrozenCoverageOverlay,
  };
}
describe('覆盖图层接口与生命周期', () => {
  it('保留原VectorLayer格面/source及定位范围，只更换显示渲染', () => {
    const { f, overlay } = overlayFixture(),
      before = JSON.stringify(overlay),
      layer = frozenCoverageLayer(overlay, f.query.snapshotId, f.query.planId);
    expect(layer.getSource()!.getFeatures()).toHaveLength(3);
    expect(layer.getSource()!.getFeatures()[0].getGeometry()!.getType()).toBe('Polygon');
    expect(layer.get('coverageDisplaySmoothing')).toMatchObject({
      kind: 'CACHED_CELL_RASTER',
      sourceCells: 3,
    });
    expect(layer.get('frozenCoverageSnapshot')).toBe(f.query.snapshotId);
    expect(JSON.stringify(overlay)).toBe(before);
  });
  it.each(['snapshot', 'plan', 'raw', 'tables', 'terrain', 'device', 'node', 'frequency'] as const)(
    '错%s来源不能显示或复用已合成覆盖',
    (kind) => {
      const { f, overlay } = overlayFixture();
      frozenCoverageLayer(overlay, f.query.snapshotId, f.query.planId);
      if (kind === 'raw') f.result.provenance.raw_snapshot_sha256 = '0'.repeat(64);
      if (kind === 'tables') f.result.provenance.frozen_tables_sha256 = '0'.repeat(64);
      if (kind === 'terrain') f.result.provenance.terrain_fingerprint = '0'.repeat(64);
      const p = f.result.devices[0].computations[0].geojson.features[0].properties;
      if (kind === 'device')
        for (const x of f.result.devices[0].computations[0].geojson.features)
          x.properties.device_id = 'other';
      if (kind === 'node')
        for (const x of f.result.devices[0].computations[0].geojson.features)
          x.properties.node_id = 'other';
      if (kind === 'frequency')
        for (const x of f.result.devices[0].computations[0].geojson.features)
          x.properties.freq_khz = p.freq_khz + 1;
      const layer = frozenCoverageLayer(
        overlay,
        kind === 'snapshot' ? 'SNP-other' : f.query.snapshotId,
        kind === 'plan' ? 'PLAN-other' : f.query.planId,
      );
      expect(layer.getSource()!.getFeatures()).toHaveLength(0);
      expect(layer.get('coverageDisplaySmoothing')).toBeUndefined();
    },
  );
  it('历史V5保持原显示；V6边界source仍为外缘线，无原格子内边', () => {
    const { f, overlay } = overlayFixture();
    overlay.anchor.engine_version = 'V01-5';
    overlay.result.provenance.engine_version = 'V01-5';
    expect(
      frozenCoverageLayer(overlay, f.query.snapshotId).get('coverageDisplaySmoothing'),
    ).toBeUndefined();
    overlay.anchor.engine_version = 'V01-6';
    overlay.result.provenance.engine_version = 'V01-6';
    overlay.display = 'boundary';
    const layer = frozenCoverageLayer(overlay, f.query.snapshotId);
    expect(
      layer
        .getSource()!
        .getFeatures()
        .every((feature) => feature.getGeometry()!.getType() === 'LineString'),
    ).toBe(true);
    expect(layer.get('coverageDisplaySmoothing')).toBeDefined();
  });
  it('平移缩放只贴缓存图，不重复合成，dispose释放画布并阻止迟到绘制', () => {
    const contexts: any[] = [],
      canvases: any[] = [];
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        if (tag === 'div') return {
          tagName: 'DIV', className: '', style: {}, firstElementChild: null as unknown,
          appendChild(child: unknown) { this.firstElementChild = child; }, remove: vi.fn(),
        };
        const context = {
            createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData: vi.fn(),
            setTransform: vi.fn(),
            clearRect: vi.fn(),
            drawImage: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
          },
          canvas = {
            width: 0,
            height: 0,
            style: {},
            className: '',
            getContext: () => context,
            remove: vi.fn(),
          };
        contexts.push(context);
        canvases.push(canvas);
        return canvas;
      },
    });
    const layer = {
        render: vi.fn(() => null),
        dispose: vi.fn(),
        getOpacity: () => 0.5,
        set: vi.fn(),
      },
      raster: CoverageRaster = {
        width: 10,
        height: 10,
        extent: [10, 20, 30, 40],
        pixels: new Uint8ClampedArray(400),
        blurPixels: 1,
        pixelMeters: 2,
        sourceCells: 1,
      };
    attachCoverageRaster(layer as any, raster);
    const frame = {
      size: [400, 300],
      pixelRatio: 2,
      coordinateToPixelTransform: [2, 0, 0, -2, 7, 9],
    } as unknown as FrameState;
    const render = layer.render as any;
    const container = render(frame, {});
    expect(container.tagName).toBe('DIV');
    expect(container.getContext).toBeUndefined();
    expect(container.className).not.toBe('ol-layer');
    expect(container.firstElementChild).toBe(canvases[1]);
    expect(render(frame, {})).toBe(container);
    expect(contexts[0].putImageData).toHaveBeenCalledOnce();
    expect(contexts[1].drawImage).toHaveBeenCalledTimes(2);
    expect(contexts[1].save).toHaveBeenCalledTimes(2);
    expect(contexts[1].restore).toHaveBeenCalledTimes(2);
    const transform = contexts[1].setTransform.mock.lastCall as number[];
    expect(transform.every(Number.isFinite)).toBe(true);
    expect(transform.map(value => value === 0 ? 0 : value)).toEqual([8, 0, 0, 8, 54, -142]);
    layer.dispose();
    expect(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    expect(render(frame, {})).toBeNull();
    expect(contexts[1].drawImage).toHaveBeenCalledTimes(2);
  });
});
