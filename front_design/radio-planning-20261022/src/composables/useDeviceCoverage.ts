import { computed, reactive } from 'vue';
import type { DeviceCoverageCatalog, DeviceCoverageMode, DeviceCoverageOverlay, DeviceCoverageRepresentation } from '../types/device-coverage';
import type { MockCoverageDisplay, MockCoverageState } from '../maps/mock-coverage-layers';

// 仅维护本页显示偏好；不写资源、方案、localStorage 或规划任务。
export function useDeviceCoverage(catalog: () => DeviceCoverageCatalog | undefined, paused: () => string) {
  const state = reactive({ mode: 'network' as DeviceCoverageMode, display: 'auto' as MockCoverageDisplay,
    representation: 'field' as DeviceCoverageRepresentation,
    singleId: '', selectedIds: [] as string[], settings: {} as Record<string, { visible: boolean; opacity: number }>,
    loads: {} as Record<string, MockCoverageState> });
  const samples = computed(() => catalog()?.samples ?? []);
  const pausedReason = computed(paused);
  const active = computed(() => state.mode !== 'network' && !pausedReason.value);
  const overlays = computed<DeviceCoverageOverlay[]>(() => samples.value
    .filter(sample => state.mode === 'single' ? sample.deviceId === state.singleId : state.mode === 'multiple' && state.selectedIds.includes(sample.deviceId))
    .map(sample => ({ sample, representation: state.representation, ...(state.settings[sample.deviceId] ?? { visible: true, opacity: 0.7 }) })));
  function setMode(mode: DeviceCoverageMode) {
    state.mode = mode;
    if (mode === 'single' && !state.singleId) state.singleId = samples.value[0]?.deviceId ?? '';
  }
  function open(deviceId: string) { state.singleId = deviceId; state.mode = 'single'; }
  function toggle(deviceId: string, selected: boolean) {
    if (!samples.value.some(s => s.deviceId === deviceId)) return;
    state.selectedIds = selected ? [...new Set([...state.selectedIds, deviceId])] : state.selectedIds.filter(id => id !== deviceId);
  }
  function configure(deviceId: string, change: { visible?: boolean; opacity?: number }) {
    if (!samples.value.some(s => s.deviceId === deviceId)) return;
    if (change.opacity !== undefined && (!Number.isFinite(change.opacity) || change.opacity < 0 || change.opacity > 1)) return;
    state.settings[deviceId] = { ...(state.settings[deviceId] ?? { visible: true, opacity: 0.7 }), ...change };
  }
  function loaded(snapshotId: string, status: MockCoverageState) { state.loads[snapshotId] = status; }
  return { state, samples, overlays, pausedReason, active, setMode, open, toggle, configure, loaded };
}
