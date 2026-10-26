import { computed, ref, watch } from 'vue';
import {
  nextPlanningComparisonSort,
  planningComparisonCostSortIssue,
  sortPlanningComparisonRows,
  type PlanningComparisonSort,
  type PlanningComparisonDirection,
  type PlanningComparisonValues,
} from '../services/planning-result-display';

// 每个入口独立维护排序状态，仅重排展示副本，保留原比较顺序和差值基准。
export function usePlanningComparisonSort<T extends PlanningComparisonValues>(
  rowsGetter: () => readonly T[],
  identityGetter: () => string,
) {
  const comparisonSort = ref<PlanningComparisonSort>('original');
  const comparisonDirection = ref<PlanningComparisonDirection>('asc');
  const costSortIssue = computed(() => planningComparisonCostSortIssue(rowsGetter()));
  const sortedRows = computed(() =>
    sortPlanningComparisonRows(rowsGetter(), comparisonSort.value, comparisonDirection.value),
  );
  function sortComparison(event: { sortField?: string }) {
    if (event.sortField === 'deploymentCost' && costSortIssue.value) return;
    const next = nextPlanningComparisonSort(
      comparisonSort.value,
      comparisonDirection.value,
      event.sortField,
    );
    if (next) {
      comparisonSort.value = next.key;
      comparisonDirection.value = next.direction;
    }
  }
  // 更换比较对象只恢复原序，保持既有排序方向和默认监听时机。
  watch(identityGetter, () => {
    comparisonSort.value = 'original';
  });
  watch(costSortIssue, (issue) => {
    if (issue && comparisonSort.value === 'deploymentCost') comparisonSort.value = 'original';
  });
  return { comparisonSort, comparisonDirection, costSortIssue, sortedRows, sortComparison };
}
