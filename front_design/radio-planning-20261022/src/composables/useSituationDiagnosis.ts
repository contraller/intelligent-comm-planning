import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { previewService } from '../services';
import { useAuthStore } from '../stores/auth';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { usePlanningStore } from '../stores/planning';
import { useResourceReadStore } from '../stores/resource-read';
import { DIAGNOSIS_STORAGE_KEY, PLANNING_STORAGE_KEY, RESOURCE_STORAGE_KEY } from '../config/demo';
import {
  GIS_DIAGNOSIS_LEVELS, filterGisDiagnosisImpact, gisDiagnosisObject,
  parseGisDiagnosisTarget, projectGisDiagnosisReport,
} from '../services/gis-diagnosis-display';
import type { GisDiagnosisDisplay, GisDiagnosisTarget } from '../services/gis-diagnosis-display';
import type { Coordinate } from '../types/domain';
import type { ImpactLevel } from '../types/diagnosis';

type DiagnosisStatus = 'idle' | 'loading' | 'ready' | 'forbidden' | 'invalid' | 'error';
type SelectionOrigin = 'object' | 'impact' | 'fault';
interface DiagnosisSelection extends GisDiagnosisTarget { origin: SelectionOrigin }

/** GIS 独立读取完整报告，不借用诊断工作区的选择、草稿或运行轮询。 */
export function useSituationDiagnosis(query: () => Record<string, unknown>, enabled: () => boolean = () => true) {
  const auth = useAuthStore(), gis = useGisWorkspaceStore();
  const planning = usePlanningStore(), preview = useResourceReadStore();
  const target = computed(() => parseGisDiagnosisTarget(query()));
  const active = computed(() => enabled() && gis.mapMode === 'diagnosis');
  const display = ref<GisDiagnosisDisplay | null>(null);
  const status = ref<DiagnosisStatus>('idle'), error = ref(''), refreshing = ref(false);
  const levels = ref<ImpactLevel[]>([...GIS_DIAGNOSIS_LEVELS]);
  const selection = ref<DiagnosisSelection | null>(null);
  const focus = ref<{ coordinates: Coordinate[]; serial: number } | null>(null);
  const epoch = ref(0);
  let attached = false, disposed = false, ownsMode = false, requestSerial = 0, focusSerial = 0;
  const readable = () => auth.can('situation.view') && auth.can('diagnosis.view');
  const queryKey = computed(() => JSON.stringify(['diagnosisId', 'stationId', 'deviceId', 'interferenceId', 'taskId']
    .map(key => [key, Object.prototype.hasOwnProperty.call(query(), key), query()[key]])));
  const identity = () => JSON.stringify([queryKey.value, auth.generation, auth.identity?.sessionId, auth.identity?.id,
    auth.can('situation.view'), auth.can('diagnosis.view'), gis.mapMode]);
  const contextKey = computed(() => `diagnosis:${epoch.value}:${target.value.id ?? ''}`);
  const impact = computed(() => display.value ? filterGisDiagnosisImpact(display.value, levels.value)
    : { nodes: [], links: [], regions: [], paths: undefined });
  const selected = computed(() => display.value && selection.value ? gisDiagnosisObject(display.value, selection.value) : null);

  function clearDisplay() {
    // 代次属于显示上下文；相同 ID 离开再返回也不能接受原地图事件。
    epoch.value++; display.value = null; selection.value = null; focus.value = null;
    levels.value = [...GIS_DIAGNOSIS_LEVELS]; refreshing.value = false;
  }
  function invalidate() {
    requestSerial++; clearDisplay(); error.value = ''; status.value = 'idle';
  }
  async function read(keepVerified = true) {
    const serial = ++requestSerial, owner = identity();
    if (!attached || disposed || !active.value) return;
    error.value = '';
    if (!readable()) { clearDisplay(); status.value = 'forbidden'; error.value = '需要 GIS 态势和故障诊断查看权限'; return; }
    if (target.value.error || !target.value.id) {
      clearDisplay(); status.value = 'invalid'; error.value = target.value.error ?? '请从故障诊断页选择完整报告'; return;
    }
    const id = target.value.id;
    const preserving = keepVerified && display.value?.record.id === id;
    if (preserving) { refreshing.value = true; status.value = 'ready'; }
    else { clearDisplay(); status.value = 'loading'; }
    const current = () => attached && !disposed && active.value && serial === requestSerial && owner === identity() && readable();
    // 同一轮多个版本／窗口事件合并到最后一次，只读报告服务，无定时重试。
    await Promise.resolve();
    if (!current()) return;
    try {
      const record = await previewService.getDiagnosisReport(id);
      if (!current()) return;
      const next = projectGisDiagnosisReport(record, id);
      if (display.value?.contentKey === next.contentKey) {
        // 仅来源更新保留数组、筛选、选择及定位序号，避免地图重绘后重新适配视角。
        display.value.record.source = next.record.source;
      } else {
        clearDisplay(); display.value = next;
      }
      refreshing.value = false; status.value = 'ready';
    } catch (reason) {
      if (!current()) return;
      clearDisplay(); status.value = 'error';
      error.value = reason instanceof Error ? reason.message : '诊断快照读取失败，请重试';
    }
  }

  function visibleImpact(targetObject: GisDiagnosisTarget) {
    return targetObject.objectType === 'NODE' ? impact.value.nodes.some(row => row.nodeId === targetObject.objectId)
      : targetObject.objectType === 'LINK' && impact.value.links.some(row => row.linkId === targetObject.objectId);
  }
  const actions = computed(() => {
    const currentEpoch = epoch.value, owner = identity();
    const current = () => attached && !disposed && currentEpoch === epoch.value && owner === identity() && active.value && readable();
    return {
      select(targetObject: GisDiagnosisTarget, origin: SelectionOrigin = 'object') {
        if (!current() || !display.value || status.value !== 'ready') return;
        if (origin === 'impact' && !visibleImpact(targetObject)) return;
        if (origin === 'fault' && !display.value.faults.some(row => row.objectType === targetObject.objectType && row.objectId === targetObject.objectId)) return;
        const object = gisDiagnosisObject(display.value, targetObject);
        if (!object) return;
        selection.value = { ...object.target, origin };
        focus.value = { coordinates: object.coordinates.map(coordinate => [...coordinate] as Coordinate), serial: ++focusSerial };
      },
      setLevel(level: ImpactLevel, visible: boolean) {
        if (!current() || !display.value || !GIS_DIAGNOSIS_LEVELS.includes(level) || typeof visible !== 'boolean') return;
        levels.value = GIS_DIAGNOSIS_LEVELS.filter(value => value === level ? visible : levels.value.includes(value));
        if (selection.value?.origin === 'impact' && !visibleImpact(selection.value)) { selection.value = null; focus.value = null; }
      },
      retry() { return current() ? read() : Promise.resolve(); },
    };
  });

  function open() {
    if (!enabled()) return false;
    if (!attached || disposed || !target.value.present) return false;
    ownsMode = true;
    if (!active.value) gis.mapMode = 'diagnosis';
    else void read();
    return true;
  }
  function leave() { if (attached && active.value) gis.mapMode = 'resource'; }
  const refreshSource = () => {
    if (attached && active.value && readable() && !document.hidden) void read();
  };
  const storage = (event: StorageEvent) => {
    if (event.key === null || [RESOURCE_STORAGE_KEY, PLANNING_STORAGE_KEY, DIAGNOSIS_STORAGE_KEY].includes(event.key)) refreshSource();
  };
  watch(queryKey, () => {
    invalidate();
    if (!attached) return;
    if (target.value.present) open();
    else if (ownsMode && active.value) gis.mapMode = 'resource';
  }, { flush: 'sync' });
  watch(() => gis.mapMode, () => {
    invalidate();
    if (attached && active.value) { ownsMode = true; void read(false); }
  }, { flush: 'sync' });
  // 逐项比较身份值，同一会话的服务复核不能因对象引用更新而使当前点选失效。
  watch([() => auth.generation, () => auth.identity?.sessionId, () => auth.identity?.id, () => auth.can('situation.view'), () => auth.can('diagnosis.view')], () => {
    invalidate();
    if (attached && active.value) void read(false);
  }, { flush: 'sync' });
  watch(() => [preview.workspace?.revision, planning.readRevision || planning.workspace?.revision], refreshSource);
  onMounted(() => {
    attached = true;
    if (target.value.present) open();
    window.addEventListener('focus', refreshSource); window.addEventListener('storage', storage);
  });
  onBeforeUnmount(() => {
    attached = false; disposed = true; invalidate();
    window.removeEventListener('focus', refreshSource); window.removeEventListener('storage', storage);
    // 报告只属于本页；下一次普通入口不能继承没有报告的 diagnosis 模式。
    if (ownsMode && active.value) gis.mapMode = 'resource';
  });
  return { target, active, display, impact, status, error, refreshing, levels, selection, selected, focus, contextKey, actions, open, leave };
}
