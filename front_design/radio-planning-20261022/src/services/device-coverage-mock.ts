import catalog from '../mocks/device-coverage-v2.json';
import baseline from '../mocks/resources.json';
import type { DeviceCoverageCatalog, DeviceCoverageSample } from '../types/device-coverage';
import { readCoverage, readCoverageRaster } from './coverage-validation';
import { sameValue } from './planning-validation';
import { ApiError } from './types';

// 数据只经 Mock 服务进入页面；校验设备归属，保留原始缺失参数。
export function loadDeviceCoverageCatalog(value: unknown = catalog): DeviceCoverageCatalog {
  const raw = value as typeof catalog;
  const fail = () => { throw new ApiError('设备覆盖教学样例结构或归属无效', 'INVALID_DEVICE_COVERAGE'); };
  // 仅接受当前目录，旧格式不做字段补齐或迁移。
  if (!raw || raw.version !== 'device-v2' || typeof raw.source !== 'string' || !Array.isArray(raw.samples)) return fail();
  const ids = new Set<string>();
  const samples = raw.samples.map(row => {
    const device = baseline.devices.find(d => d.id === row.deviceId);
    const station = baseline.stations.find(s => s.id === row.stationId);
    const model = baseline.models.find(m => m.id === device?.modelId);
    if (!device || !station || device.stationId !== station.id || model?.deviceClass !== row.deviceClass ||
      ids.has(row.deviceId) || row.snapshotId !== `${raw.version}-${row.deviceId}` ||
      !sameValue(row.inputSnapshot, { device, station }) || !/^#[0-9a-f]{6}$/i.test(row.color) || !row.label) return fail();
    ids.add(row.deviceId);
    const coverage = readCoverage(row.coverage);
    const heatmapPng = row.heatmap_png === null ? null : readCoverageRaster(row.heatmap_png);
    if (heatmapPng && (heatmapPng.url !== `/maps/coverage/${row.snapshotId}-heatmap.png` ||
      !sameValue(heatmapPng.bbox, coverage.rasterPng?.bbox))) return fail();
    if (!coverage.contour?.features.length || !coverage.rasterPng || coverage.rasterPng.url !== `/maps/coverage/${row.snapshotId}.png` || !Array.isArray(row.regions)) return fail();
    // 借用几何边界校验，盲区仍是各设备自己的区域，不合并为全网结论。
    for (const region of row.regions) {
      if (!['blind', 'uncalculated'].includes(region.kind) || !region.id || !region.label) return fail();
      readCoverage({ contour: { type: 'FeatureCollection', features: [{ type: 'Feature', id: region.id,
        properties: { level: region.kind, field_strength_dbuvm_min: null }, geometry: { type: 'Polygon', coordinates: region.rings } }] }, raster_png: null });
    }
    return structuredClone({ snapshotId: row.snapshotId, deviceId: row.deviceId, stationId: row.stationId,
      deviceClass: row.deviceClass, label: row.label, color: row.color, inputSnapshot: row.inputSnapshot,
      coverage, heatmapPng, regions: row.regions }) as DeviceCoverageSample;
  });
  return { version: raw.version, source: raw.source, samples };
}
