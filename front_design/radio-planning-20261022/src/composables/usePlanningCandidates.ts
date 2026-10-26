import { computed, onScopeDispose, ref, watch } from 'vue';
import { filterCandidates } from '../services/planning-candidates-display';
import type { Coordinate } from '../types/domain';
import type { CandidateFilter, CandidateMapFrame, CandidateSelection, PlanningCandidateScreening, PlanningCandidatesView } from '../types/planning-candidates';

export function usePlanningCandidates(options: {
  screening: () => PlanningCandidateScreening | null | undefined;
  owner: () => string; active: () => boolean; readable: () => boolean; generation: () => number;
  locate: (coordinate: Coordinate) => void;
}) {
  // 候选点默认隐藏，避免密集标记遮挡覆盖图层；用户可手动开启，点集与筛选结果保持。
  const search = ref(''), filter = ref<CandidateFilter>('all'), visible = ref(false), selectedId = ref(''), notice = ref(''), epoch = ref(0);
  let disposed = false;
  const enabled = computed(() => !disposed && options.active() && options.readable() && !!options.owner());
  const filtered = computed(() => filterCandidates(options.screening()?.candidates ?? [], search.value, filter.value));
  const rows = computed(() => filtered.value.map(row => ({ ...row, id: row.siteId, owner: options.owner(), epoch: epoch.value })));
  const selected = computed(() => rows.value.find(row => row.siteId === selectedId.value) ?? null);
  // 数据和显示代次分开；缩放与点选不会更换结果所有者。
  watch([options.owner, options.active, options.readable, options.generation, () => JSON.stringify(options.screening())], () => {
    epoch.value++; selectedId.value = ''; notice.value = '';
  }, { flush: 'sync' });
  watch(options.owner, () => { search.value = ''; filter.value = 'all'; }, { flush: 'sync' });
  watch([search, filter, visible], () => {
    epoch.value++;
    if (selectedId.value && !filtered.value.some(row => row.siteId === selectedId.value)) {
      selectedId.value = ''; notice.value = '所选候选点已被当前筛选隐藏，已清除选择。';
    }
  }, { flush: 'sync' });
  const actions = computed(() => {
    const owner = options.owner(), current = epoch.value;
    const valid = () => enabled.value && !disposed && owner === options.owner() && current === epoch.value;
    const resolve = (event: CandidateSelection) => valid() && event.owner === owner && event.epoch === current
      ? rows.value.find(row => row.siteId === event.siteId) : undefined;
    return {
      search: (event: Event) => { if (valid()) search.value = (event.target as HTMLInputElement).value; },
      filter: (event: Event) => { const next = (event.target as HTMLSelectElement).value; if (valid() && ['all', 'yes', 'no', 'unknown'].includes(next)) filter.value = next as CandidateFilter; },
      visible: (event: Event) => { if (valid()) visible.value = (event.target as HTMLInputElement).checked; },
      select: (event: CandidateSelection) => { const row = resolve(event); if (row) { selectedId.value = row.siteId; notice.value = ''; } },
      locate: (event: CandidateSelection) => { const row = resolve(event); if (row?.coordinate) { selectedId.value = row.siteId; notice.value = visible.value ? '' : '候选图层已隐藏，定位保留隐藏设置。'; options.locate([...row.coordinate]); } },
      clear: () => { if (valid()) { selectedId.value = ''; notice.value = ''; } },
    };
  });
  const view = computed<PlanningCandidatesView>(() => ({ screening: options.screening(), rows: rows.value, selected: selected.value,
    search: search.value, filter: filter.value, visible: visible.value, enabled: enabled.value, notice: notice.value, actions: actions.value }));
  const frame = computed<CandidateMapFrame>(() => ({ owner: options.owner(), epoch: epoch.value, visible: enabled.value && visible.value,
    points: enabled.value ? filtered.value : [], selectedId: selectedId.value }));
  const selectMap = (event: CandidateSelection) => { if (frame.value.visible) actions.value.select(event); };
  onScopeDispose(() => { disposed = true; epoch.value++; });
  return { view, frame, selectMap };
}
