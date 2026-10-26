import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import GeoJSON from 'ol/format/GeoJSON';
import ImageLayer from 'ol/layer/Image';
import ImageStatic from 'ol/source/ImageStatic';
import VectorLayer from 'ol/layer/Vector';
import { Style } from 'ol/style';
import { ref } from 'vue';
import raw from '../src/mocks/device-coverage-v2.json';
import { loadDeviceCoverageCatalog } from '../src/services/device-coverage-mock';
import * as coverageSource from '../src/services/device-coverage-mock';
import { createMockService } from '../src/services/mock';
import { createDeviceCoverageLayers } from '../src/maps/device-coverage-layers';
import { useDeviceCoverage } from '../src/composables/useDeviceCoverage';
import { TestStorage } from './helpers/storage';
import { pngPixels } from './helpers/coverage-png';

describe('设备覆盖教学数据', () => {
  it('覆盖只经专用入口按需组装，普通预览、地图和编辑不运输覆盖，副本保持隔离', async () => {
    const storage = new TestStorage(), service = createMockService(() => storage);
    const load = vi.spyOn(coverageSource, 'loadDeviceCoverageCatalog');
    const first = await service.loadPreview(), context = await service.loadResourceReadContext({ context: 'gis' });
    const input = { context: 'gis' as const, revision: context.revision };
    try {
    expect(first.situation).not.toHaveProperty('deviceCoverage');
    expect((await service.loadGisResourceScene(input)).situation).not.toHaveProperty('deviceCoverage');
    expect((await service.loadGisResourceEditContext(input)).situation).not.toHaveProperty('deviceCoverage');
    expect(load).not.toHaveBeenCalled();
    const samples = (await service.getGisCoverageCatalog(input))!.samples;
    expect(samples.map(s => [s.deviceId, s.deviceClass])).toEqual([['DV-0001', 'HF'], ['DV-0009', 'HF'], ['DV-0033', 'VUHF'], ['DV-0043', 'VUHF']]);
    expect(new Set(samples.map(s => s.snapshotId)).size).toBe(4);
    expect(samples.every(s => s.inputSnapshot.device.workFreqKhz === null)).toBe(true);
    samples[0].coverage.rasterPng!.url = '/changed.png';
    expect((await service.getGisCoverageCatalog(input))!.samples[0].coverage.rasterPng!.url).toBe('/maps/coverage/device-v2-DV-0001.png');
    expect(load).toHaveBeenCalledTimes(2);
    expect(storage.writes).toBe(0);
    } finally { load.mockRestore(); }
  });
  it('仅支持当前目录，热力与场强资产独立且透明边界一致', () => {
    const catalog=loadDeviceCoverageCatalog();
    expect(catalog.version).toBe('device-v2');
    for(const sample of catalog.samples){
      const field=sample.coverage.rasterPng!,heat=sample.heatmapPng!;
      expect(heat.url).not.toBe(field.url);expect(heat.bbox).toEqual(field.bbox);
      const fieldPng=readFileSync('public'+field.url),heatPng=readFileSync('public'+heat.url);
      expect(heatPng.equals(fieldPng)).toBe(false);expect(heatPng.subarray(16,29)).toEqual(fieldPng.subarray(16,29));
      const fieldPixels=pngPixels(fieldPng),heatPixels=pngPixels(heatPng),stride=1+field.width*4;
      let maskMismatch=0;
      for(let y=0;y<field.height;y++)for(let x=0;x<field.width;x++){
        const alpha=y*stride+1+x*4+3;if(fieldPixels[alpha]!==heatPixels[alpha])maskMismatch++;
      }
      expect(maskMismatch).toBe(0);
    }
  });
  // 每次只改当前目录的一项数据，避免旧目录的版本拒读掩盖其他字段校验。
  it.each(['device', 'station', 'snapshot', 'url', 'input', 'duplicate', 'geometry', 'version', 'old-version'])('拒绝当前目录的 %s 错配而非套用其他设备图片', target => {
    const copy = structuredClone(raw);
    if (target === 'device') copy.samples[0].deviceId = 'DV-0002';
    if (target === 'station') copy.samples[0].stationId = 'ND-0002';
    if (target === 'snapshot') copy.samples[0].snapshotId = copy.samples[1].snapshotId;
    if (target === 'url') copy.samples[0].coverage.raster_png.url = copy.samples[1].coverage.raster_png.url;
    if (target === 'input') copy.samples[0].inputSnapshot.device.workFreqKhz = 7000 as never;
    if (target === 'duplicate') copy.samples.push(copy.samples[0]);
    if (target === 'geometry') copy.samples[0].regions[0].rings[0].pop();
    if (target === 'version') copy.version = 'device-v3';
    if (target === 'old-version') copy.version = 'device-v1';
    expect(() => loadDeviceCoverageCatalog(copy)).toThrow();
  });
  it.each(raw.samples.map(s => s.deviceId))('%s PNG 与独立几何、盲区、未计算区域及图例逐像素一致', id => {
    const sample = loadDeviceCoverageCatalog().samples.find(s => s.deviceId === id)!;
    const raster = sample.coverage.rasterPng!, png = readFileSync(`public${raster.url}`);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([512, 640, 8, 6]);
    const pixels = pngPixels(png), stride = 1 + raster.width * 4;
    // 直接核对当前图片与独立几何、色表，不依赖退役图片作为预期。
    expect(pixels.length).toBe(raster.height * stride);
    const geometry = new GeoJSON().readGeometry(sample.coverage.contour!.features[0].geometry);
    const excluded = sample.regions.map(region => new GeoJSON().readGeometry({ type: 'Polygon', coordinates: region.rings }));
    expect(geometry.getType()).toBe(sample.deviceClass === 'HF' ? 'MultiPolygon' : 'Polygon');
    expect(geometry.intersectsCoordinate(sample.inputSnapshot.station.coordinate)).toBe(true);
    const colors = new Set<string>(); let outside = 0, missing = 0, coloredExcluded = 0;
    for (let y = 0; y < raster.height; y++) {
      expect(pixels[y * stride]).toBe(0);
      for (let x = 0; x < raster.width; x++) {
        const point = [raster.bbox[0] + (x + 0.5) / raster.width * (raster.bbox[2] - raster.bbox[0]), raster.bbox[3] - (y + 0.5) / raster.height * (raster.bbox[3] - raster.bbox[1])];
        const rgba = pixels.subarray(y * stride + x * 4 + 1, y * stride + x * 4 + 5), colored = rgba[3] > 0;
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
    expect([outside, missing, coloredExcluded]).toEqual([0, 0, 0]);
    expect(colors).toEqual(new Set(raster.colormap.map(c => c.rgba.join(','))));
  });
  it('共用绘制模块可重现当前七张场强 PNG 字节，原图片无需重写', () => {
    const script = `import {readFileSync} from 'node:fs';import {renderCoveragePng} from './scripts/lib/coverage-png.mjs';
      const plans=JSON.parse(readFileSync('src/mocks/planning-coverage-v2.json','utf8'));
      const devices=JSON.parse(readFileSync('src/mocks/device-coverage-v2.json','utf8'));
      for(const sample of [...Object.values(plans.assets),...devices.samples]){
        if(!renderCoveragePng(sample).equals(readFileSync('public'+sample.coverage.raster_png.url)))throw Error(sample.coverage.raster_png.url);
      }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
  });
  it('切换图形不改设备选择，迟到图片事件不覆盖新形式；缺图仅保留轮廓', () => {
    const sample=loadDeviceCoverageCatalog().samples[0],changed=vi.fn(),manager=createDeviceCoverageLayers(changed);
    const rows=[{sample,representation:'field' as const,visible:true,opacity:0.6}];
    const old=manager.update(rows,'auto',14,true,1).find(layer=>layer instanceof ImageLayer) as ImageLayer<ImageStatic>;
    const heatRows=[{...rows[0],representation:'heatmap' as const}];
    const layers=manager.update(heatRows,'auto',14,true,1),heat=layers.find(layer=>layer instanceof ImageLayer) as ImageLayer<ImageStatic>;
    expect(heat.getSource()!.getUrl()).toContain('-heatmap.png');changed.mockClear();
    old.getSource()!.dispatchEvent('imageloaderror');expect(changed).not.toHaveBeenCalled();
    heat.getSource()!.dispatchEvent('imageloadend');expect(changed).toHaveBeenLastCalledWith(sample.snapshotId,'ready');
    expect(manager.update([{...heatRows[0],sample:{...sample,heatmapPng:null}}],'auto',14,true,1).some(layer=>layer instanceof ImageLayer)).toBe(false);
    manager.dispose();
    const controller=useDeviceCoverage(()=>loadDeviceCoverageCatalog(),()=> '');
    controller.open(sample.deviceId);controller.configure(sample.deviceId,{opacity:0.4});controller.state.representation='heatmap';
    expect(controller.overlays.value[0]).toMatchObject({representation:'heatmap',opacity:0.4,sample:{deviceId:sample.deviceId}});
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
    const manager = createDeviceCoverageLayers(changed), rows = samples.map(sample => ({ sample, representation: 'field' as const, visible: true, opacity: 0.6 }));
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
    expect(next).toEqual(layers); expect(rasters.map(layer => layer.getVisible())).toEqual([false, false]); expect(rasters[1].getSource()).toBe(second);
    manager.update(rows.slice(1), 'contour', 16, true, 1); changed.mockClear(); retried.dispatchEvent('imageloaderror'); expect(changed).not.toHaveBeenCalled();
    manager.dispose(); changed.mockClear(); second.dispatchEvent('imageloaderror'); expect(changed).not.toHaveBeenCalled();
    expect(manager.update(rows, 'raster', 10, true, 1)).toEqual([]);
  });
  it('多台 PNG 均在边界、设备归属及独立区域之下，放大不二次填充场强', () => {
    const samples=loadDeviceCoverageCatalog().samples.slice(0,2),manager=createDeviceCoverageLayers(vi.fn());
    const rows=samples.map(sample=>({sample,representation:'field' as const,visible:true,opacity:0.6}));
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
    // 放大后显示已有图片，边界由独立描边提供，不二次填充覆盖面。
    expect(contours.every(layer=>!layer.getVisible())).toBe(true);
    expect(rasters.every(layer=>layer.getVisible())).toBe(true);expect(rasters.map(layer=>layer.getSource())).toEqual(sources);
    manager.dispose();
  });
});
