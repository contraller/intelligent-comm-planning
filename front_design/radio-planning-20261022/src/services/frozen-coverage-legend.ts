import { isLocalTerrainCell } from './frozen-coverage-decode';
import type { FrozenCoverageOverlay } from '../types/frozen-coverage';

// 与地图使用同一设备、频点和有效格面，远域解释数据不进入局地色标。
export function frozenCoverageLegend(overlay: FrozenCoverageOverlay | null) {
  if (!overlay) return null;
  const device = overlay.result.devices.find(row => row.device_id === overlay.deviceId && row.status === 'COMPLETE');
  if (!device) return null;
  const local = overlay.anchor.engine_version === 'V01-6';
  const provenance = overlay.result.provenance;
  let min = Infinity, max = -Infinity, cells = 0;
  for (const part of device.computations) {
    if (local && part.shape !== 'CELLS') continue;
    for (const feature of part.geojson.features) {
      if (!feature.geometry || !feature.properties.is_coverage) continue;
      if (local && (feature.properties.device_id !== device.device_id || feature.properties.node_id !== device.node_id
        || feature.properties.freq_khz !== part.freq_khz
        || !isLocalTerrainCell(feature, device, provenance.parameters, provenance.dem_bbox))) continue;
      cells++;
      const field = feature.properties.field_strength_dbuvm;
      if (typeof field === 'number' && Number.isFinite(field)) { min = Math.min(min, field); max = Math.max(max, field); }
    }
  }
  return { deviceId: device.device_id, display: overlay.display ?? 'strength', local, cells,
    range: Number.isFinite(min) ? `${min.toFixed(1)}–${max.toFixed(1)}` : null,
    resolutionM: provenance.parameters.cell_m };
}
