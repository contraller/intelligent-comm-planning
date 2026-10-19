import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { Fill, Stroke, Style, Text } from 'ol/style';
import type BaseLayer from 'ol/layer/Base';
import type { DeviceCoverageOverlay, DeviceCoverageSample } from '../types/device-coverage';
import type { MapRegion } from '../types/domain';
import { createMockCoverageLayers, type MockCoverageDisplay, type MockCoverageState } from './mock-coverage-layers';
import { regionLayer } from './layers';

function createEntry(sample: DeviceCoverageSample, changed: (state: MockCoverageState) => void) {
  const coverage = createMockCoverageLayers(sample.coverage, changed);
  const regions = regionLayer(sample.regions);
  const labels = new Map(sample.regions.map(region => [region.id, new Style({
    fill: new Fill({ color: region.kind === 'blind' ? '#b26aa844' : '#79839633' }),
    stroke: new Stroke({ color: sample.color, width: 1, lineDash: region.kind === 'blind' ? [3, 3] : [7, 5] }),
    text: new Text({ text: region.label, font: '11px Microsoft YaHei', fill: new Fill({ color: sample.color }),
      stroke: new Stroke({ color: '#0b182b', width: 3 }) }),
  })]));
  regions.setStyle(feature => labels.get((feature.get('region') as MapRegion).id));
  // 独立外框标明设备归属，不改强中弱配色，也不合并多个设备的结果。
  const outline = new VectorLayer({ source: new VectorSource({ features: coverage.vector.getSource()!.getFeatures().map(f => f.clone()) }),
    style: new Style({ stroke: new Stroke({ color: sample.color, width: 2 }),
      text: new Text({ text: sample.deviceId, font: 'bold 12px Microsoft YaHei', fill: new Fill({ color: sample.color }), stroke: new Stroke({ color: '#0b182b', width: 3 }) }) }) });
  return { sample, coverage, regions, outline,
    dispose() { coverage.dispose(); regions.getSource()?.dispose(); outline.getSource()?.dispose(); } };
}

// 集合只负责增删及显示已有图层；状态切换不发业务请求。
export function createDeviceCoverageLayers(onState: (snapshotId: string, state: MockCoverageState) => void) {
  const entries = new Map<string, ReturnType<typeof createEntry>>();
  let disposed = false;
  return {
    update(rows: DeviceCoverageOverlay[], mode: MockCoverageDisplay, zoom: number, enabled: boolean, opacity: number): BaseLayer[] {
      if (disposed) return [];
      const wanted = new Set(rows.map(row => row.sample.snapshotId));
      for (const [id, entry] of entries) if (!wanted.has(id)) { entry.dispose(); entries.delete(id); }
      const rasters: BaseLayer[] = [], details: BaseLayer[] = [];
      for (const row of rows) {
        const id = row.sample.snapshotId;
        let entry = entries.get(id);
        if (!entry || entry.sample !== row.sample) {
          entry?.dispose();
          const next = createEntry(row.sample, status => { if (entries.get(id) === next) onState(id, status); });
          entries.set(id, next); entry = next;
        }
        const visible = enabled && row.visible, alpha = opacity * row.opacity;
        entry.coverage.setDisplay(mode, zoom, visible, alpha);
        entry.regions.setVisible(visible); entry.regions.setOpacity(alpha);
        entry.outline.setVisible(visible); entry.outline.setOpacity(alpha);
        if (entry.coverage.raster) rasters.push(entry.coverage.raster);
        details.push(entry.coverage.vector, entry.regions, entry.outline);
      }
      // 所有设备 PNG 在下，后加入的图片也不能遮住前一设备的边线与归属标记。
      return [...rasters, ...details];
    },
    retry(snapshotId: string) { entries.get(snapshotId)?.coverage.retry(); },
    dispose() { disposed = true; for (const entry of entries.values()) entry.dispose(); entries.clear(); },
  };
}
