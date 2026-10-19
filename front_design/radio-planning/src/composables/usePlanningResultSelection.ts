import { computed, ref, watch } from 'vue';
import { planningSelectionExists, resolvePlanningResultFocus } from '../services/planning-result-display';
import type { PlanningResultDisplayContext, PlanningResultFocus, PlanningResultSelection, PlanningSelectionKind } from '../services/planning-result-display';

type FrequencyRow = { id: string; selectionOwner: string; selectionEpoch: number };

export function usePlanningResultSelection(options: {
  context: () => PlanningResultDisplayContext;
  tab: () => string;
  readable: () => boolean;
  generation: () => number;
  active: () => boolean;
}) {
  const context = computed(options.context), selection = ref<PlanningResultSelection | null>(null);
  const epoch = ref(0), frequencyFeedback = ref<PlanningResultFocus | null>(null);
  let frequencySignature = '';
  const isFrequency = (kind: PlanningSelectionKind) => kind === 'frequency' || kind === 'assignment';
  const signature = (value: PlanningResultFocus) => JSON.stringify([[...value.stationIds].sort(), [...value.linkIds].sort()]);
  const focus = computed(() => !selection.value && options.readable() && options.tab() === '通信资源' && frequencyFeedback.value
    ? frequencyFeedback.value : resolvePlanningResultFocus(context.value, options.readable() ? options.tab() : '', options.readable() ? selection.value : null));
  const clear = () => { selection.value = null; frequencyFeedback.value = null; frequencySignature = ''; };
  // 身份、页签或结果所有者变化使已渲染的旧回调失效；取消业务切换不会触发此清理。
  watch([() => context.value.key, () => context.value.result?.snapshotId, options.tab, options.readable, options.generation],
    () => { epoch.value++; clear(); }, { flush: 'sync' });
  watch(options.active, () => { epoch.value++; }, { flush: 'sync' });
  watch(context, () => {
    if (selection.value && isFrequency(selection.value.kind)) {
      const current = resolvePlanningResultFocus(context.value, options.tab(), selection.value);
      // 清除失效选择仍保留原因；有效关联集合变化也不能悄悄沿用旧选择。
      if (current.state === 'invalid' || current.state === 'missing') { clear(); frequencyFeedback.value = current; }
      else if (frequencySignature && frequencySignature !== signature(current)) {
        clear(); frequencyFeedback.value = { state: 'missing', stationIds: [], linkIds: [], stationId: '', linkId: '', message: '所选频率关联已变化，已清除选择。' };
      }
      return;
    }
    if (selection.value && (!planningSelectionExists(context.value, selection.value)
      || resolvePlanningResultFocus(context.value, options.tab(), selection.value).state === 'invalid')) clear();
  }, { deep: true });

  const handlers = computed(() => {
    const current = epoch.value;
    function select(kind: PlanningSelectionKind, id: string) {
      if (current !== epoch.value || !options.active() || !options.readable()) return;
      // 坏频率行也替换旧选择，以展示关联错误并清空上次高亮。
      if (!['frequency', 'assignment'].includes(kind) && !planningSelectionExists(context.value, { kind, id })) return;
      frequencyFeedback.value = null;
      selection.value = { kind, id };
      frequencySignature = isFrequency(kind) ? signature(resolvePlanningResultFocus(context.value, options.tab(), selection.value)) : '';
    }
    const selectFrequency = (kind: 'frequency' | 'assignment', row: FrequencyRow) => {
      // 表格实例可被复用，迟到旧行必须同时通过其展示所有者和代次检查。
      if (row.selectionOwner !== context.value.key || row.selectionEpoch !== current || current !== epoch.value) return;
      select(kind, row.id);
    };
    return {
      route: (row: { id: string }) => select('route', row.id),
      link: (row: { id: string }) => select('link', row.id),
      deployment: (row: { id: string }) => select('deployment', row.id),
      device: (row: { id: string }) => select('device', row.id),
      inputDevice: (row: { id: string }) => select('input-device', row.id),
      frequency: (row: FrequencyRow) => selectFrequency('frequency', row),
      assignment: (row: FrequencyRow) => selectFrequency('assignment', row),
      stationRow: (row: { id: string }) => select('station', row.id),
      station: (id: string) => select('station', id),
      clear: () => { if (current === epoch.value && options.active() && options.readable()) clear(); },
    };
  });
  function selectedRow<T extends { id: string }>(kind: PlanningSelectionKind, rows: T[]) {
    return options.readable() && selection.value?.kind === kind ? rows.find(row => row.id === selection.value!.id) ?? null : null;
  }
  function bindFrequencyRows<T extends { id: string }>(rows: T[]) {
    return rows.map(row => ({ ...row, selectionOwner: context.value.key, selectionEpoch: epoch.value }));
  }
  return { selection, focus, handlers, selectedRow, bindFrequencyRows };
}
