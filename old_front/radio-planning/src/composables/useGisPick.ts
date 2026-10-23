import { computed, onScopeDispose, ref, watch } from 'vue';
import type { InterferenceSource, Station } from '../types/domain';
import type { GisPickContext, GisPickResult, GisPickTarget, GisPickToggle } from '../types/gis-pick';
import { samePickCoordinate, validPickCoordinate } from '../maps/gis-pick';
import { useAuthStore } from '../stores/auth';
import { useResourceEditStore } from '../stores/resource-edit';

let pageSerial = 0;
interface PickSource {
  mode: string; stations: Station[]; interferences: InterferenceSource[];
  showStations: boolean; showInterferences: boolean; filterKey: string;
}
export function useGisPick(source: () => PickSource) {
  const editor = useResourceEditStore(), auth = useAuthStore();
  const enabled = ref(true), generation = ref(0), page = ++pageSerial;
  let alive = true;
  // 权限代次保护事件；仅实际会话变化复位显示偏好。
  watch([() => auth.identity?.sessionId, () => auth.identity?.id], () => { enabled.value = true; generation.value++; }, { flush: 'sync' });
  watch([source, () => editor.form, () => editor.resources, () => editor.picking, () => editor.context,
    () => editor.canEdit, () => editor.busy, () => auth.generation, enabled],
  () => { generation.value++; }, { deep: true, flush: 'sync' });
  const context = computed<GisPickContext>(() => {
    const input = source(), form = editor.form;
    const owner = form && (form.kind === 'station' || form.kind === 'interference') ? { kind: form.kind, id: form.id } : null;
    const active = alive && input.mode === 'resource' && editor.context === 'gis'
      && editor.picking && editor.canEdit && !editor.busy && !!owner;
    const targets: GisPickTarget[] = active ? [
      ...(input.showStations ? input.stations.map(row => ({ kind: 'station' as const, id: row.id, name: row.name, coordinate: row.coordinate })) : []),
      ...(input.showInterferences ? input.interferences.map(row => ({ kind: 'interference' as const, id: row.id, name: row.name, coordinate: row.coordinate })) : []),
    ].filter(row => validPickCoordinate(row.coordinate) && !(row.kind === owner?.kind && row.id === owner.id))
      .map(row => ({ ...row, coordinate: [...row.coordinate] })) : [];
    return { key: `${page}/${generation.value}`, active, enabled: enabled.value, owner, targets };
  });
  const actions = computed(() => {
    const current = context.value, form = editor.form;
    const valid = (key: string) => alive && current.active && key === current.key
      && context.value.active && context.value.key === key && editor.form === form;
    return {
      pick(result: GisPickResult) {
        if (!valid(result.key) || !form || !validPickCoordinate(result.coordinate)) return;
        const target = result.target && current.targets.find(row => row.kind === result.target!.kind && row.id === result.target!.id);
        if (result.target && (!current.enabled || !target || !samePickCoordinate(target.coordinate, result.coordinate)
          || !samePickCoordinate(target.coordinate, result.target.coordinate))) return;
        editor.pickGis(result.coordinate, form, target);
      },
      cancel(key: string) { if (valid(key)) editor.picking = false; },
      toggle(event: GisPickToggle) { if (valid(event.key)) enabled.value = event.enabled; },
    };
  });
  onScopeDispose(() => { alive = false; generation.value++; });
  return { context, actions };
}
