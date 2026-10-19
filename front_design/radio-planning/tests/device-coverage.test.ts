import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import GeoJSON from 'ol/format/GeoJSON';
import ImageLayer from 'ol/layer/Image';
import ImageStatic from 'ol/source/ImageStatic';
import VectorLayer from 'ol/layer/Vector';
import { Style } from 'ol/style';
import { ref } from 'vue';
import raw from '../src/mocks/device-coverage-v2.json';
import legacy from '../src/mocks/device-coverage.json';
import { loadDeviceCoverageCatalog } from '../src/services/device-coverage-mock';
import { createMockService } from '../src/services/mock';
import { createDeviceCoverageLayers } from '../src/maps/device-coverage-layers';
import { useDeviceCoverage } from '../src/composables/useDeviceCoverage';
import { TestStorage } from './helpers/storage';

// 教学 PNG 使用固定的无滤波 RGBA 行，直接核对每个像素而不依赖浏览器截图。
function pngPixels(png: Buffer) {
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const n = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + n));
    offset += n + 12;
  }
  return inflateSync(Buffer.concat(chunks));
}

describe('设备覆盖教学数据', () => {
  it('通过既有入口提供四台独立样例，原始缺失参数不补造且返回副本隔离', async () => {
    const storage = new TestStorage(), service = createMockService(() => storage);
    const first = await service.loadPreview(), samples = first.situation.deviceCoverage!.samples;
    expect(samples.map(s => [s.deviceId, s.deviceClass])).toEqual([['DV-0001', 'HF'], ['DV-0009', 'HF'], ['DV-0033', 'VUHF'], ['DV-0043', 'VUHF']]);
    expect(new Set(samples.map(s => s.snapshotId)).size).toBe(4);
    expect(samples.every(s => s.inputSnapshot.device.workFreqKhz === null)).toBe(true);
    samples[0].coverage.rasterPng!.url = '/changed.png';
    expect((await service.loadPreview()).situation.deviceCoverage!.samples[0].coverage.rasterPng!.url).toBe('/maps/coverage/device-v2-DV-0001.png');
    expect(storage.writes).toBe(0);
  });
  it('默认使用 v2，同时保留 v1 显式读取；仅资产身份、来源和色带变化', () => {
    expect(loadDeviceCoverageCatalog().version).toBe('device-v2');
    const old = loadDeviceCoverageCatalog(legacy);
    expect(old.version).toBe('device-v1');
    expect(old.samples.map(sample => sample.snapshotId)).toEqual(legacy.samples.map(sample => sample.snapshotId));
    expect(old.samples[0].coverage.rasterPng!.colormap[0].rgba).toEqual([219, 165, 91, 190]);
    const normalized = structuredClone(raw);
    normalized.version = legacy.version; normalized.source = legacy.source;
    normalized.samples.forEach((sample, i) => {
      expect(sample.snapshotId).toBe(`device-v2-${sample.deviceId}`);
      expect(sample.coverage.contour.features.map(feature => feature.id)).toEqual([sample.snapshotId]);
      expect(sample.coverage.raster_png.url).toBe(`/maps/coverage/${sample.snapshotId}.png`);
      expect(sample.coverage.raster_png.colormap).toEqual([
        { value_dbuvm: 20, rgba: [253, 216, 53, 190] },
        { value_dbuvm: 30, rgba: [156, 204, 101, 190] },
        { value_dbuvm: 40, rgba: [46, 125, 50, 190] },
      ]);
      sample.snapshotId = legacy.samples[i].snapshotId;
      sample.coverage.contour.features.forEach((feature, index) => { feature.id = legacy.samples[i].coverage.contour.features[index].id; });
      sample.coverage.raster_png.url = legacy.samples[i].coverage.raster_png.url;
      sample.coverage.raster_png.colormap.forEach((row, index) => { row.rgba = legacy.samples[i].coverage.raster_png.colormap[index].rgba; });
    });
    // 包括全部 patches、孔洞、归属色和盲区 ID，不只核对可见几何。
    expect(normalized).toEqual(legacy);
  });
  it.each([raw, legacy].flatMap(catalog => ['device', 'station', 'snapshot', 'url', 'input', 'duplicate', 'geometry', 'version', 'mixed-version'].map(target => ({ version: catalog.version, catalog, target }))))('拒绝 $version 的 $target 错配而非套用其他设备图片', ({ catalog, target }) => {
    const copy = structuredClone(catalog);
    if (target === 'device') copy.samples[0].deviceId = 'DV-0002';
    if (target === 'station') copy.samples[0].stationId = 'ND-0002';
    if (target === 'snapshot') copy.samples[0].snapshotId = copy.samples[1].snapshotId;
    if (target === 'url') copy.samples[0].coverage.raster_png.url = copy.samples[1].coverage.raster_png.url;
    if (target === 'input') copy.samples[0].inputSnapshot.device.workFreqKhz = 7000 as never;
    if (target === 'duplicate') copy.samples.push(copy.samples[0]);
    if (target === 'geometry') copy.samples[0].regions[0].rings[0].pop();
    if (target === 'version') copy.version = 'device-v3';
    if (target === 'mixed-version') copy.version = copy.version === 'device-v1' ? 'device-v2' : 'device-v1';
    expect(() => loadDeviceCoverageCatalog(copy)).toThrow();
  });
  it('历史设备目录与四张图片字节保留', () => {
    const hashes: Record<string, string> = {
      'src/mocks/device-coverage.json': '0e3c6061084aa6f1ee8dc9ec2093e8d692b725ba7e12f38b06334501164c22cd',
      'public/maps/coverage/device-v1-DV-0001.png': '34c074373c3751d235b1bc6b3f3263af0f987ff0337eb1bb85d7ed02947d3cd0',
      'public/maps/coverage/device-v1-DV-0009.png': 'b6878c49ecea902a7bf40faf889a7a1c23df9d2768c4301165cff4bb6d8a4db6',
      'public/maps/coverage/device-v1-DV-0033.png': '15413e01cca5b6709cef43c2ff22f7964f6747ecbedbb7ccad867deb51e0b837',
      'public/maps/coverage/device-v1-DV-0043.png': '85294e3b1514898ddbf44110447569d42671b1e383221a015cb783a7d36122ba',
    };
    for (const [path, hash] of Object.entries(hashes)) expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(hash);
  });
  it.each(raw.samples.map(s => s.deviceId))('%s PNG 与独立几何、盲区、未计算区域及图例逐像素一致', id => {
    const sample = loadDeviceCoverageCatalog().samples.find(s => s.deviceId === id)!;
    const raster = sample.coverage.rasterPng!, png = readFileSync(`public${raster.url}`);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([512, 640, 8, 6]);
    const pixels = pngPixels(png), stride = 1 + raster.width * 4;
    const oldSample = legacy.samples.find(row => row.deviceId === id)!;
    const oldPng = readFileSync(`public${oldSample.coverage.raster_png.url}`), oldPixels = pngPixels(oldPng);
    expect(png.subarray(16, 29)).toEqual(oldPng.subarray(16, 29));
    expect(pixels.length).toBe(oldPixels.length);
    const replacements = new Map(oldSample.coverage.raster_png.colormap.map(row => [row.rgba.join(','), raster.colormap.find(color => color.value_dbuvm === row.value_dbuvm)!.rgba]));
    const geometry = new GeoJSON().readGeometry(sample.coverage.contour!.features[0].geometry);
    const excluded = sample.regions.map(region => new GeoJSON().readGeometry({ type: 'Polygon', coordinates: region.rings }));
    expect(geometry.getType()).toBe(sample.deviceClass === 'HF' ? 'MultiPolygon' : 'Polygon');
    expect(geometry.intersectsCoordinate(sample.inputSnapshot.station.coordinate)).toBe(true);
    const colors = new Set<string>(); let outside = 0, missing = 0, coloredExcluded = 0, changedShapeOrLevel = 0;
    for (let y = 0; y < raster.height; y++) {
      expect(pixels[y * stride]).toBe(0);
      expect(oldPixels[y * stride]).toBe(0);
      for (let x = 0; x < raster.width; x++) {
        const point = [raster.bbox[0] + (x + 0.5) / raster.width * (raster.bbox[2] - raster.bbox[0]), raster.bbox[3] - (y + 0.5) / raster.height * (raster.bbox[3] - raster.bbox[1])];
        const rgba = pixels.subarray(y * stride + x * 4 + 1, y * stride + x * 4 + 5), colored = rgba[3] > 0;
        const oldRgba = oldPixels.subarray(y * stride + x * 4 + 1, y * stride + x * 4 + 5);
        const expected = oldRgba[3] === 0 ? [...oldRgba] : replacements.get([...oldRgba].join(','));
        if (!expected || rgba.some((channel, index) => channel !== expected[index])) changedShapeOrLevel++;
        if (colored) colors.add([...rgba].join(','));
        const inside = geometry.intersectsCoordinate(point);
        if (colored !== inside) {
          // 只放行恰落于边界的浮点差异，不放宽到半像素或整个孔洞。
          const closest = geometry.getClosestPoint(point);
          if (Math.hypot(point[0] - closest[0], point[1] - closest[1]) > 1e-10) { if (colored) outside++; else missing++; }
        }
        if (colored && excluded.some(g => {
          const q = g.getClosestPoint(point);
          return g.intersectsCoordinate(point) && Math.hypot(point[0] - q[0], point[1] - q[1]) > 1e-10;
        })) coloredExcluded++;
      }
    }
    expect([outside, missing, coloredExcluded, changedShapeOrLevel]).toEqual([0, 0, 0, 0]);
    expect(colors).toEqual(new Set(raster.colormap.map(c => c.rgba.join(','))));
  });
  it('共用绘制模块可重现新旧十四张 PNG 字节，原图片无需重写', () => {
    const script = `import {readFileSync} from 'node:fs';import {renderCoveragePng} from './scripts/lib/coverage-png.mjs';
      for(const suffix of ['', '-v2']){
        const plans=JSON.parse(readFileSync('src/mocks/planning-coverage'+suffix+'.json','utf8'));
        const devices=JSON.parse(readFileSync('src/mocks/device-coverage'+suffix+'.json','utf8'));
        for(const sample of [...Object.values(plans.assets),...devices.samples]){
          if(!renderCoveragePng(sample).equals(readFileSync('public'+sample.coverage.raster_png.url)))throw Error(sample.coverage.raster_png.url);
        }
      }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  });
});

describe('覆盖选择与独立图层', () => {
  it('默认整网，单台/多台/未知设备分支独立，暂停及返回保留选择但新页面不保留', () => {
    const catalog = loadDeviceCoverageCatalog(), paused = ref(''), c = useDeviceCoverage(() => catalog, () => paused.value);
    expect(c.state.mode).toBe('network'); expect(c.active.value).toBe(false);
    c.open('DV-0001'); expect(c.overlays.value).toHaveLength(1);
    c.setMode('multiple'); c.toggle('DV-0001', true); c.toggle('DV-0033', true); c.toggle('DV-0001', true); c.toggle('UNKNOWN', true);
    expect(c.overlays.value).toHaveLength(2); c.configure('DV-0001', { visible: false, opacity: 0.3 });
    paused.value = '监控网络'; expect(c.active.value).toBe(false); expect(c.overlays.value).toHaveLength(2);
    paused.value = ''; expect(c.active.value).toBe(true); expect(c.overlays.value[0]).toMatchObject({ visible: false, opacity: 0.3 });
    c.configure('DV-0001', { opacity: Number.NaN }); expect(c.overlays.value[0].opacity).toBe(0.3);
    c.open('DV-0002'); expect(c.active.value).toBe(true); expect(c.overlays.value).toEqual([]);
    expect(useDeviceCoverage(() => catalog, () => '').state.mode).toBe('network');
  });
  it('多图逐台显隐、调透明度及重试；迟到事件不串图，缩放不重建图片', () => {
    const samples = loadDeviceCoverageCatalog().samples.slice(0, 2), changed = vi.fn();
    const manager = createDeviceCoverageLayers(changed), rows = samples.map(sample => ({ sample, visible: true, opacity: 0.6 }));
    const layers = manager.update(rows, 'raster', 8, true, 0.5);
    const rasters = layers.filter(layer => layer instanceof ImageLayer) as ImageLayer<ImageStatic>[];
    expect(rasters).toHaveLength(2); expect(rasters[0].getOpacity()).toBe(0.3);
    const first = rasters[0].getSource()!, second = rasters[1].getSource()!;
    first.dispatchEvent('imageloaderror'); second.dispatchEvent('imageloadend');
    expect(rasters.map(layer => layer.getVisible())).toEqual([false, true]);
    manager.retry(samples[0].snapshotId); const retried = rasters[0].getSource()!;
    expect(retried).not.toBe(first); changed.mockClear(); first.dispatchEvent('imageloadend'); expect(changed).not.toHaveBeenCalled();
    retried.dispatchEvent('imageloadend'); expect(changed).toHaveBeenLastCalledWith(samples[0].snapshotId, 'ready');
    rows[0].visible = false;
    const next = manager.update(rows, 'auto', 12, true, 1);
    expect(next).toEqual(layers); expect(rasters.map(layer => layer.getVisible())).toEqual([false, true]); expect(rasters[1].getSource()).toBe(second);
    manager.update(rows.slice(1), 'contour', 16, true, 1); changed.mockClear(); retried.dispatchEvent('imageloaderror'); expect(changed).not.toHaveBeenCalled();
    manager.dispose(); changed.mockClear(); second.dispatchEvent('imageloaderror'); expect(changed).not.toHaveBeenCalled();
    expect(manager.update(rows, 'raster', 10, true, 1)).toEqual([]);
  });
  it('多台 PNG 均在边界、设备归属及独立区域之下，放大不二次填充场强', () => {
    const samples=loadDeviceCoverageCatalog().samples.slice(0,2),manager=createDeviceCoverageLayers(vi.fn());
    const rows=samples.map(sample=>({sample,visible:true,opacity:0.6}));
    const layers=manager.update(rows,'auto',9,true,0.5);
    const rasters=layers.filter(layer=>layer instanceof ImageLayer) as ImageLayer<ImageStatic>[];
    const vectors=layers.filter(layer=>layer instanceof VectorLayer) as VectorLayer[];
    const sources=rasters.map(layer=>layer.getSource()!);sources.forEach(source=>source.dispatchEvent('imageloadend'));
    const lastRaster=Math.max(...rasters.map(layer=>layers.indexOf(layer)));
    expect(vectors.every(layer=>layers.indexOf(layer)>lastRaster)).toBe(true);
    const contours=vectors.filter(layer=>typeof layer.getStyle()==='function' && layer.getSource()!.getFeatures().some(feature=>feature.get('level')));
    const regions=vectors.filter(layer=>layer.getSource()!.getFeatures().some(feature=>feature.get('region')));
    const outlines=vectors.filter(layer=>layer.getStyle() instanceof Style && (layer.getStyle() as Style).getText());
    expect(contours).toHaveLength(2);expect(regions).toHaveLength(2);expect(outlines).toHaveLength(2);
    expect(contours.every(layer=>!layer.getVisible())).toBe(true);
    expect([...regions,...outlines].every(layer=>layer.getVisible() && layer.getOpacity()===0.3)).toBe(true);
    expect(regions.flatMap(layer=>layer.getSource()!.getFeatures().map(feature=>feature.get('region').kind))).toEqual(expect.arrayContaining(['blind','uncalculated']));
    const next=manager.update(rows,'auto',13,true,0.5);expect(next).toEqual(layers);
    for(const contour of contours) {
      const style=contour.getStyleFunction()!(contour.getSource()!.getFeatures()[0],1) as Style;
      expect(contour.getVisible()).toBe(true);expect(style.getFill()).toBeNull();expect(style.getStroke()).not.toBeNull();
    }
    expect(rasters.every(layer=>layer.getVisible())).toBe(true);expect(rasters.map(layer=>layer.getSource())).toEqual(sources);
    manager.dispose();
  });
});
