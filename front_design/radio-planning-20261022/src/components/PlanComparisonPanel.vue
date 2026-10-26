<template>
  <section class="panel comparison">
    <div class="panel-head">
      <h3>保存版本对比</h3>
      <span class="chip">同任务 · 2–4 个版本</span>
    </div>
    <div class="panel-body">
      <div class="choices">
        <label
          v-for="plan in plans"
          :key="plan.id"
          ><input
            type="checkbox"
            :checked="selected.includes(plan.id)"
            :disabled="disabled || (!selected.includes(plan.id) && selected.length >= 4)"
            @change="toggle(plan.id, ($event.target as HTMLInputElement).checked)"
          /><span
            >{{ plan.name }} · {{ plan.version
            }}<small
              >{{ plan.taskId }} ·
              {{ 'originLabel' in plan ? plan.originLabel : planOriginLabel(plan) }}
              {{ plan.sourceChanged ? '· 历史参考' : '' }}</small
            ></span
          ></label
        >
      </div>
      <div class="toolbar section-gap">
        <button
          class="btn primary"
          :disabled="disabled || selected.length < 2"
          @click="emit('compare', selected)"
        >
          对比所选 {{ selected.length }} 个版本</button
        ><span class="muted">展开行详情查看辅助指标与来源；差值相对首个选择版本，仅作展示。</span>
      </div>
      <p
        v-if="error"
        class="notice warn section-gap"
        role="alert"
        >{{ error }}</p
      >
    </div>
    <p
      v-if="rows.length && costSortIssue"
      class="muted cost-sort-note"
      role="status"
      >{{ costSortIssue }}</p
    >
    <AppTable
      controlled-sort
      :sort-field="comparisonSort === 'original' ? undefined : comparisonSort"
      :sort-order="comparisonDirection === 'desc' ? -1 : 1"
      @sort="sortComparison"
      compact
      v-if="rows.length"
      :rows="sortedRows"
      :columns="summaryColumns"
      :detail-columns="columns"
      table-min-width="760px"
      :page-size="5"
    >
      <template #name="{ row }"
        >{{ row.name }}<small>{{ row.version }}</small></template
      >
      <template #deploymentCost="{ row }"
        >{{ row.deploymentCost ?? '未提供' }}<small>{{ row.costUnit }}</small></template
      >
      <template #deploymentCount="{ row }">{{ row.deploymentCount ?? '未提供' }}</template>
      <template #actions="{ row }"
        ><button
          class="text-link"
          @click="emit('select', row.id)"
          >查看</button
        ></template
      >
    </AppTable>
    <p
      v-else
      class="empty-inline"
      >选择可比版本后显示指标；不同任务或资源输入不同会明确提示。</p
    >
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PlanVersion } from '../types/domain';
import { planOriginLabel } from '../services/planning-snapshot';
import { checksPass } from '../services/planning-validation';
import { usePlanningComparisonSort } from '../composables/usePlanningComparisonSort';
import AppTable from './AppTable.vue';
const props = defineProps<{
  plans: (PlanVersion | import('../types/planning-api').PlanningReferenceSummary)[];
  comparison: PlanVersion[];
  error: string;
  disabled: boolean;
}>();
const emit = defineEmits<{ compare: [ids: string[]]; select: [id: string] }>();
const selected = ref<string[]>([]);
watch(
  () => props.plans.map((p) => p.id),
  (ids) => {
    selected.value = selected.value.filter((id) => ids.includes(id));
  },
);
function toggle(id: string, checked: boolean) {
  selected.value = checked
    ? [...selected.value, id]
    : selected.value.filter((value) => value !== id);
}
const rows = computed(() =>
  props.comparison.map((plan) => ({
    id: plan.id,
    name: plan.name,
    version: plan.version,
    origin: planOriginLabel(plan),
    solutionId: plan.solutionId ?? '旧单结果',
    radioCount: plan.workflow?.solutionOrigin?.radioCount ?? null,
    costUnit: plan.workflow?.costUnit ?? '未提供',
    taskId: plan.taskId,
    ...plan.metrics,
    deploymentCount: plan.workflow?.configuration.deployment.length ?? null,
    deploymentCost: plan.workflow?.deploymentCost ?? null,
    deltaPower: plan.metrics.totalRadiatedPowerW === null || props.comparison[0].metrics.totalRadiatedPowerW === null ? null : plan.metrics.totalRadiatedPowerW - props.comparison[0].metrics.totalRadiatedPowerW,
    deltaConnectivity:
      plan.metrics.connectivityPercent === null || props.comparison[0].metrics.connectivityPercent === null ? null : plan.metrics.connectivityPercent - props.comparison[0].metrics.connectivityPercent,
    check: plan.workflow
      ? checksPass(plan.workflow.checks)
        ? '通过'
        : '未通过 / 未知'
      : '未提供校验结论',
    source: props.plans.find((p) => p.id === plan.id)?.sourceChanged
      ? '源已变化 · 历史参考'
      : '保存快照',
  })),
);
// 原数组保留所选顺序，排序只改变展示行，不重算差值或选用方案。
const { comparisonSort, comparisonDirection, costSortIssue, sortedRows, sortComparison } =
  usePlanningComparisonSort(
    () => rows.value,
    () => props.comparison.map((plan) => plan.id).join('\0'),
  );
const columns = [
  { field: 'name', header: '方案' },
  { field: 'version', header: '版本' },
  { field: 'origin', header: '方案来源' },
  { field: 'solutionId', header: '完整结果 ID' },
  { field: 'radioCount', header: '新增部署单元数' },
  { field: 'connectivityPercent', header: '连通率 / %' },
  { field: 'totalRadiatedPowerW', header: '总功率 / W' },
  { field: 'survivabilityPercent', header: '抗毁性 / %' },
  { field: 'coveragePercent', header: '覆盖率 / %' },
  { field: 'delayMs', header: '时延 / ms' },
  { field: 'deploymentCount', header: '部署节点数' },
  { field: 'deploymentCost', header: '部署成本' },
  { field: 'costUnit', header: '成本单位' },
  { field: 'deltaPower', header: 'Δ 功率 / W' },
  { field: 'deltaConnectivity', header: 'Δ 连通率 / 百分点' },
  { field: 'check', header: '校验' },
  { field: 'source', header: '来源状态' },
];
// 对比主表保留决策指标，全部原始展示字段仍可展开核查。
const summaryColumns = computed(() =>
  columns
    .filter((column) =>
      [
        'name',
        'connectivityPercent',
        'totalRadiatedPowerW',
        'survivabilityPercent',
        'deploymentCost',
      ].includes(column.field),
    )
    .map((column) => ({
      ...column,
      sortable:
        column.field !== 'name' && (column.field !== 'deploymentCost' || !costSortIssue.value),
    })),
);
</script>
<style scoped>
.choices {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
@media (max-width: 600px) {
  .choices {
    grid-template-columns: minmax(0, 1fr);
  }
}
label {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid #2a405a;
  border-radius: 5px;
  font-size: 12px;
}
input {
  width: auto;
  accent-color: #4caee6;
}
small {
  display: block;
  color: #6f8aa7;
  margin-top: 7px;
  overflow-wrap: anywhere;
}
.muted {
  font-size: 11px;
}
.cost-sort-note {
  margin: 0;
  padding: 0 18px 12px;
}
</style>
