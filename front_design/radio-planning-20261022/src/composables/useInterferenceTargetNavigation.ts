import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useInterferenceStore } from '../stores/interference';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import type { Measure } from '../types/interference-workbench';
import type { SceneJsonObject } from '../types/interference-scene';

export interface InterferenceTargetAction { kind: 'node' | 'link'; id: string; label: string; reason: string; locate: () => Promise<void> }
export interface InterferenceTargetEntry { measureId: string; stateLabel: string; targets: InterferenceTargetAction[] }
interface Navigation { blockedReason: () => string; show: (kind: 'node' | 'link', id: string) => void; locate: () => void; hidden: () => boolean }

// 定位只用所选运行的冻结对象；不回查当前资源台账，也不提交分析或采纳。
export function useInterferenceTargetNavigation(navigation: Navigation) {
  const auth = useAuthStore(), store = useInterferenceStore(), gis = useGisWorkspaceStore();
  const epoch = ref(0), notice = ref(''); let serial = 0, active = true;
  const blockedReason = computed(() => auth.blocked || !store.readable ? '需要有效会话及查看权限'
    : store.locked ? '请先等待当前操作完成' : navigation.blockedReason());
  watch([() => store.selected, () => store.measureId, () => store.after, () => gis.mapMode, () => auth.generation,
    () => auth.blocked, blockedReason], () => { epoch.value++; notice.value = ''; }, { deep: true, flush: 'sync' });
  onBeforeUnmount(() => { active = false; serial++; });
  function coordinates(row: SceneJsonObject) {
    return ['lon', 'lat'].every(key => row[key] !== null && row[key] !== undefined && row[key] !== ''
      && (typeof row[key] === 'string' || typeof row[key] === 'number') && Number.isFinite(Number(row[key])))
      && Math.abs(Number(row.lon)) <= 180 && Math.abs(Number(row.lat)) <= 90;
  }
  function entry(measure: Measure, after: boolean, drawer: boolean): InterferenceTargetEntry {
    const version = epoch.value, selected = store.selected;
    const stateLabel = after ? '措施后预测' : '措施前';
    const raw = selected?.source.planSnapshot.rawSnapshot.detail as SceneJsonObject | undefined;
    const nodes = raw && Array.isArray(raw.nodes) ? JSON.parse(JSON.stringify(raw.nodes)) as SceneJsonObject[] : [];
    const links = raw && Array.isArray(raw.links) ? raw.links as SceneJsonObject[] : [];
    if (after && measure.type === 'NODE_REDEPLOY' && store.canPreviewAfter) {
      const target = measure.change_set.target as SceneJsonObject, detail = measure.change_set.detail as SceneJsonObject;
      const node = nodes.find(row => row.node_id === target.node_id);
      if (node) { node.lon = detail.to_lon ?? null; node.lat = detail.to_lat ?? null; }
    }
    const targets: InterferenceTargetAction[] = [];
    for (const kind of ['node', 'link'] as const) {
      const id = kind === 'node' ? measure.target_node_id : measure.target_link_id; if (!id) continue;
      const matches = kind === 'node' ? nodes.filter(row => row.node_id === id) : links.filter(row => row.link_id === id);
      let objectReason = matches.length !== 1 ? '冻结来源缺少唯一目标' : '';
      const coordinatesToCheck = kind === 'node' ? matches : matches.length === 1
        ? [matches[0]!.node_a_id, matches[0]!.node_b_id].flatMap(sid => nodes.filter(row => row.node_id === sid)) : [];
      if (!objectReason && (coordinatesToCheck.length !== (kind === 'node' ? 1 : 2) || !coordinatesToCheck.every(coordinates))) objectReason = '冻结目标坐标或端点无效';
      const reason = blockedReason.value || objectReason || (after && !store.canPreviewAfter ? '缺少同源措施预览' : '');
      targets.push({ kind, id, label: '定位' + (kind === 'node' ? '节点' : '链路') + '（' + stateLabel + '）', reason, async locate() {
        if (!active || version !== epoch.value || reason || blockedReason.value || selected !== store.selected || drawer && !store.measureOpen) return;
        const request = ++serial;
        store.measureId = measure.measure_id; store.after = after; gis.mapMode = 'analysis'; navigation.show(kind, id);
        if (drawer) store.measureOpen = false;
        const displayed = epoch.value; await nextTick();
        if (!active || request !== serial || displayed !== epoch.value || blockedReason.value) return;
        navigation.locate(); notice.value = kind === 'link' && navigation.hidden() ? '已定位链路，拓扑图层当前隐藏' : '已定位 ' + id + '（' + stateLabel + '）';
      } });
    }
    return { measureId: measure.measure_id, stateLabel, targets };
  }
  const list = computed(() => { epoch.value; return store.selected?.result?.measures.map(measure => entry(measure, false, false)) ?? []; });
  const drawer = computed(() => { epoch.value; return store.measure ? entry(store.measure, store.effectiveAfter, true) : null; });
  return { list, drawer, notice };
}
