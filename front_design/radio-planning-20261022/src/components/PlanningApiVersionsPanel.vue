<template>
  <section class="panel"
    ><div class="panel-head"
      ><h3>{{
        adjusting ? '保存调整为新版本' : planning.selectedPlan ? '方案版本与对比' : '保存方案'
      }}</h3></div
    ><div class="panel-body">
      <div
        v-if="showSave"
        class="save-fields"
        ><label
          >方案名称<input
            v-model="name"
            :disabled="planning.busy || !!planning.pending || !auth.can('planning.save')"
            maxlength="60" /></label
        ><label
          >保存说明<textarea
            v-model="note"
            :disabled="planning.busy || !!planning.pending || !auth.can('planning.save')"
            maxlength="500"
          /></label
        ><button
          class="btn primary"
          :disabled="!planning.canSave"
          @click="save"
          >{{ adjusting || planning.job?.adjustment ? '保存调整为新版本' : '保存为方案' }}</button
        ><p class="muted">{{ saveHint }}</p
        ><p class="muted">调整结果保存为新版本，原方案继续保留。覆盖计算不会自动保存方案；未达标结果保留为参考。</p></div
      >
      <div
        v-if="planning.selectedPlan && !adjusting"
        class="notice selected-plan"
        ><strong>{{ planning.selectedPlan.name }} · {{ planning.selectedPlan.version }}</strong
        ><p>{{
          planning.sourceChanged
            ? '历史参考 · 来源已变化'
            : planning.selectedPlan.current
              ? '已转正 · 当前方案'
              : planning.selectedPlan.state === 'REFERENCE'
                ? '参考方案'
                : planning.selectedPlan.state === 'CONFIRMED'
                  ? '已转正 · 历史版本'
                  : '已保存 · 待转正'
        }}</p>
        <details class="support-details"
          ><summary>方案来源</summary
          ><p v-if="planning.selectedPlan.solutionId"
            >{{ planning.selectedPlan.solutionLabel }} · {{ planning.selectedPlan.solutionId }} ·
            新增部署单元 {{ planning.selectedPlan.radioCount ?? '未提供' }}</p
          >
          <button
            v-if="planning.job?.solutions?.length"
            class="btn"
            :disabled="planning.busy || !!planning.pending"
            @click="
              planning.selectSolution(
                planning.selectedSolutionId || planning.job.defaultSolutionId!,
                3,
              )
            "
            >返回本次备选方案</button
          >
          <p v-if="planning.selectedPlan.adjustment"
            >设备参数与路由调整 · 父版本 {{ planning.selectedPlan.adjustment.sourcePlanId }} ·
            父快照 {{ planning.selectedPlan.adjustment.sourceSnapshotId }}</p
          >
          <p v-else-if="planning.selectedPlan.parentPlanId"
            >父版本 {{ planning.selectedPlan.parentPlanId }}</p
          >
          <p v-if="planning.selectedPlan.interferenceOrigin"
            >干扰措施采纳 · 分析 {{ planning.selectedPlan.interferenceOrigin.analysisId }} · 措施
            {{ planning.selectedPlan.interferenceOrigin.measureId }}</p
          > </details
        ><div class="toolbar"
          ><button
            class="btn"
            :disabled="!auth.can('planning.view')"
            @click="emit('viewConfiguration', planning.selectedPlan.id)"
            >查看完整配置</button
          ><button
            class="btn"
            :disabled="
              !auth.can('planning.execute') ||
              planning.busy ||
              planning.running ||
              !!planning.pending ||
              !!planning.adjustmentUnavailable()
            "
            @click="planning.openPlanAdjustment"
            >调整此方案</button
          ><button
            v-if="!planning.selectedPlan.current"
            class="btn primary"
            :disabled="!planning.canConfirm"
            @click="planning.confirm"
            >转正并设为当前方案</button
          ><button
            v-if="planning.selectedPlan.state === 'CONFIRMED'"
            class="btn"
            :disabled="!auth.can('planning.view') || !planning.selectedPlan.confirmedConfiguration"
            @click="emit('viewConfirmedConfiguration', planning.selectedPlan.id)"
            >查看转正配置</button
          ></div
        ><p
          v-if="planning.selectedPlan.confirmedAt"
          class="muted"
          >转正时间：{{ planning.selectedPlan.confirmedAt }}</p
        ><p
          v-if="
            planning.selectedPlan.state === 'CONFIRMED' &&
            !planning.selectedPlan.confirmedConfiguration
          "
          class="muted"
          >服务未返回正式配置快照，可通过“查看完整配置”核对原方案。</p
        ><p
          v-if="!planning.selectedPlan.current && !planning.canConfirm"
          class="muted"
          >{{ confirmHint }}</p
        >
        <details class="support-details"
          ><summary>导出与复制任务条件</summary
          ><div class="toolbar"
            ><button
              class="btn small"
              :disabled="!auth.can('planning.view')"
              @click="exporting = true"
              >导出</button
            ><button
              class="btn small"
              :disabled="!task.editable"
              @click="planning.adjust"
              >复制为任务条件</button
            ></div
          ></details
        >
        <p
          v-if="planning.adjustmentUnavailable()"
          class="muted"
          >{{ planning.adjustmentUnavailable() }}</p
        >
      </div>
      <p
        v-if="!showSave && !planning.selectedPlan"
        class="muted"
        >请先在第二步选择可查看的结果，或从历史版本中选择方案。</p
      ><p
        v-if="planning.notice && !adjusting"
        class="notice"
        >{{ planning.notice }}</p
      >
      <details class="version-library"
        ><summary>历史版本与对比 · {{ planning.plans?.total ?? 0 }} 个版本</summary
        ><p class="muted">查看已有版本，或勾选同任务的 2–4 个版本比较。</p
        ><button
          class="text-link"
          :disabled="planning.busy"
          @click="planning.loadPlans()"
          >刷新版本</button
        ><AppTable
          :sortable="false"
          compact
          :rows="planning.plans?.items ?? []"
          :columns="summaryColumns"
          :paginator="false"
          :page-size="10"
          ><template #name="{ row }"
            ><label class="plan-choice"
              ><input
                type="checkbox"
                :checked="selected.includes(row.id)"
                :disabled="
                  planning.busy ||
                  !!planning.pending ||
                  (!selected.includes(row.id) && selected.length >= 4)
                "
                @change="toggle(row.id, ($event.target as HTMLInputElement).checked)"
              /><span
                >{{ row.name }}<small class="cell-secondary">{{ row.version }}</small></span
              ></label
            ></template
          ><template #state="{ row }"
            >{{
              row.state === 'REFERENCE'
                ? '参考方案'
                : row.state === 'CONFIRMED'
                  ? '已转正'
                  : '待转正'
            }}{{ row.current ? ' · 当前' : ''
            }}<small class="cell-secondary">{{
              row.sourceChanged ? '历史参考' : '保存快照'
            }}</small></template
          ><template #sourceChanged="{ row }">{{
            row.sourceChanged ? '历史参考' : '保存快照'
          }}</template
          ><template #actions="{ row }"
            ><button
              class="text-link"
              :disabled="planning.busy || !!planning.pending"
              @click="planning.selectPlan(row.id, row.taskId, 3)"
              >查看</button
            ></template
          ></AppTable
        >
        <div class="toolbar section-gap"
          ><button
            class="btn small"
            :disabled="!planning.plans || planning.plans.pageNum <= 1"
            @click="planning.loadPlans(planning.page - 1)"
            >上页</button
          ><span
            >{{ planning.plans?.total ?? 0 }} 个版本 · 第
            {{ planning.plans?.pageNum ?? 1 }} 页</span
          ><button
            class="btn small"
            :disabled="
              !planning.plans ||
              planning.plans.pageNum * planning.plans.pageSize >= planning.plans.total
            "
            @click="planning.loadPlans(planning.page + 1)"
            >下页</button
          ><button
            class="btn"
            :disabled="selected.length < 2 || planning.busy || !!planning.pending"
            @click="planning.compare(selected)"
            >对比所选 {{ selected.length }} 个版本</button
          ><button
            class="text-link"
            @click="selected = []"
            >清空选择</button
          ></div
        > </details
      ><section
        v-if="comparisonRows.length && comparisonVisible"
        class="comparison-panel"
        aria-label="方案横向对比"
        ><div class="comparison-heading"
          ><h3>方案横向对比 · {{ comparisonRows.length }} 个版本</h3
          ><button
            class="btn small"
            @click="comparisonVisible = false"
            >收起方案对比</button
          ></div
        ><p
          v-if="costSortIssue"
          class="muted"
          role="status"
          >{{ costSortIssue }}</p
        ><AppTable
          controlled-sort
          :sort-field="comparisonSort === 'original' ? undefined : comparisonSort"
          :sort-order="comparisonDirection === 'desc' ? -1 : 1"
          @sort="sortComparison"
          compact
          :rows="sortedComparisonRows"
          :columns="compareSummaryColumns"
          :detail-columns="compareColumns"
          table-min-width="760px"
          :page-size="5"
          ><template #deploymentCost="{ row }"
            >{{ row.deploymentCost ?? '未提供'
            }}<small class="cell-secondary">{{ row.costUnit }}</small></template
          ></AppTable
        ><p class="muted"
          >功率差相对第一个所选版本，仅作展示；指标与成本直接读取保存结果。</p
        ></section
      >
      <PlanExportDrawer
        v-model:visible="exporting"
        :plan="planning.selectedPlan"
        :source-label="planning.selectedPlan?.source"
        :exporter="exporter"
      /> </div
  ></section>
</template>
<script setup lang="ts">
// 参数路径调整与复制任务条件各有独立入口，版本保存及确认规则保持。
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppTable from './AppTable.vue';
import PlanExportDrawer from './PlanExportDrawer.vue';
import { usePlanningApiStore } from '../stores/planning-api';
import { useTaskInputStore } from '../stores/task-input';
import { useAuthStore } from '../stores/auth';
import { previewService } from '../services';
import { usePlanningComparisonSort } from '../composables/usePlanningComparisonSort';
const planning = usePlanningApiStore(),
  task = useTaskInputStore(),
  auth = useAuthStore();
const props = withDefaults(defineProps<{ adjusting?: boolean }>(), { adjusting: false });
const emit = defineEmits<{
  viewConfiguration: [planId: string];
  viewConfirmedConfiguration: [planId: string];
}>();
// 仅解释现有条件，保存和确认仍由原状态层校验目标和版本。
const showSave = computed(
  () =>
    props.adjusting ||
    (!planning.selectedPlan && !!planning.result && !planning.currentSavedPlanId),
);
const saveHint = computed(() =>
  planning.pending
    ? '请先核实原请求，操作结果待确认。'
    : !auth.can('planning.save')
      ? '当前账号没有方案保存权限。'
      : planning.running || planning.busy
        ? '正在准备结果，请等待预览和当前操作完成。'
        : planning.queryError
          ? '查询中断，请恢复查询后保存。'
          : planning.currentExpired
            ? '结果已过期，请重新规划。'
            : props.adjusting && !planning.canSave
              ? '修改有效参数后自动预览，取得当前输入的成功结果后可保存新版。'
              : planning.canSave
                ? '核对名称后保存，保存不会自动选用此方案。'
                : '当前结果暂不可保存，请查看状态与约束提示。',
);
const confirmHint = computed(() =>
  planning.pending
    ? '请先核实原请求。'
    : !auth.can('planning.confirm')
      ? '当前账号没有方案确认权限。'
      : planning.sourceChanged
        ? '方案来源已变化，仅供历史参考。'
        : planning.selectedPlan?.state === 'REFERENCE'
          ? '此版本为参考方案，不能设为当前方案。'
          : planning.busy
            ? '请等待当前操作完成。'
            : '此版本暂不可选用，请查看约束结论与版本状态。',
);
const name = ref(''),
  note = ref(''),
  initial = ref(''),
  selected = ref<string[]>([]),
  exporting = ref(false);
const comparisonVisible = ref(false);
// 宽表按需铺开到页面底部，避免挤在地图旁的窄操作栏。
watch(
  () => planning.comparison,
  (rows) => {
    comparisonVisible.value = rows.length > 0;
  },
);
const drafts = ref<Record<string, { name: string; note: string; initial: string }>>({});
const saveKey = computed(() => JSON.stringify([planning.job?.id, planning.selectedSolutionId]));
let restoring = false;
// 明确放弃会清理辅助输入标记；同时丢弃缓存，避免切换结果后恢复已放弃的说明。
watch(
  () => task.auxiliary.planSave,
  (value, previous) => {
    if (previous && !value) {
      restoring = true;
      drafts.value = {};
      name.value = planning.job?.input.name ?? '';
      note.value = '';
      initial.value = JSON.stringify([name.value, note.value]);
      restoring = false;
    }
  },
  { flush: 'sync' },
);
// 切换结果只切换对应保存草稿，未保存说明仍受原离开保护。
watch(
  () => [planning.job?.id, auth.generation],
  () => {
    drafts.value = {};
  },
  { flush: 'sync' },
);
watch(
  saveKey,
  () => {
    restoring = true;
    const cached = drafts.value[saveKey.value];
    name.value = cached?.name ?? planning.job?.input.name ?? '';
    note.value = cached?.note ?? '';
    initial.value = cached?.initial ?? JSON.stringify([name.value, note.value]);
    restoring = false;
  },
  { immediate: true, flush: 'sync' },
);
watch(
  [name, note],
  () => {
    if (!restoring)
      drafts.value[saveKey.value] = { name: name.value, note: note.value, initial: initial.value };
  },
  { flush: 'sync' },
);
watch(
  drafts,
  () => {
    task.auxiliary.planSave = Object.values(drafts.value).some(
      (row) => JSON.stringify([row.name, row.note]) !== row.initial,
    );
  },
  { deep: true, flush: 'sync' },
);
watch(
  () => task.taskId,
  () => {
    selected.value = [];
    comparisonVisible.value = false;
  },
);
function toggle(id: string, checked: boolean) {
  selected.value = checked
    ? [...new Set([...selected.value, id])]
    : selected.value.filter((x) => x !== id);
}
async function save() {
  const key = saveKey.value;
  if (await planning.savePlan(name.value, note.value)) {
    initial.value = JSON.stringify([name.value, note.value]);
    delete drafts.value[key];
    // 保存完成后结束当前编辑展示，后续确认只针对刚保存的新版本。
    if (
      planning.adjustmentParent &&
      planning.selectedPlan &&
      planning.selectedPlan.id !== planning.adjustmentParent.id &&
      planning.adjustmentOpen
    )
      await planning.closeAdjustment();
  }
}
const columns = [
  { field: 'name', header: '方案' },
  { field: 'version', header: '版本' },
  { field: 'state', header: '状态' },
  { field: 'sourceChanged', header: '来源状态' },
];
const compareColumns = [
  { field: 'name', header: '方案' },
  { field: 'solutionId', header: '完整结果 ID' },
  { field: 'origin', header: '结果来源' },
  { field: 'radioCount', header: '新增部署单元数' },
  { field: 'connectivityPercent', header: '连通率 / %' },
  { field: 'totalRadiatedPowerW', header: '总功率 / W' },
  { field: 'survivabilityPercent', header: '抗毁性 / %' },
  { field: 'cost', header: '部署成本' },
  { field: 'costUnit', header: '成本单位' },
  { field: 'deltaPower', header: '功率差 / W' },
];
// 身份与来源留在行详情，对比第一层集中展示三指标及部署成本。
const summaryColumns = columns.filter((column) => ['name', 'state'].includes(column.field));
const compareSummaryColumns = computed(() =>
  compareColumns
    .filter((column) =>
      [
        'name',
        'connectivityPercent',
        'totalRadiatedPowerW',
        'survivabilityPercent',
        'cost',
      ].includes(column.field),
    )
    .map((column) => ({
      ...column,
      field: column.field === 'cost' ? 'deploymentCost' : column.field,
      sortable: column.field !== 'name' && (column.field !== 'cost' || !costSortIssue.value),
    })),
);
const comparisonRows = computed(() =>
  planning.comparison.map((p) => ({
    id: p.id,
    name: p.name,
    solutionId: p.solutionId ?? '旧单结果',
    origin: p.solutionLabel ?? p.source,
    radioCount: p.radioCount ?? null,
    ...p.result.metrics,
    cost: p.result.deploymentCost,
    costUnit: p.result.costUnit,
    deltaPower:
      p.result.metrics.totalRadiatedPowerW === null ||
      planning.comparison[0].result.metrics.totalRadiatedPowerW === null
        ? null
        : p.result.metrics.totalRadiatedPowerW -
          planning.comparison[0].result.metrics.totalRadiatedPowerW,
  })),
);
// 排序在差值生成后进行，第一项所选版本始终是原比较基准。
const comparisonValues = computed(() =>
  comparisonRows.value.map((row) => ({ ...row, deploymentCost: row.cost })),
);
const {
  comparisonSort,
  comparisonDirection,
  costSortIssue,
  sortedRows: sortedComparisonRows,
  sortComparison,
} = usePlanningComparisonSort(
  () => comparisonValues.value,
  () => planning.comparison.map((plan) => plan.id).join('\0'),
);
const exporter = (planId: string, format: 'json' | 'xlsx') =>
  previewService.exportPlanningPlan({
    context: task.context,
    taskId: planning.selectedPlan?.taskId ?? task.taskId,
    planId,
    format,
  });
onBeforeUnmount(() => {
  delete task.auxiliary.planSave;
});
</script>
<style scoped>
.support-details,
.version-library {
  margin: 14px 0;
  font-size: 12px;
}
.support-details summary,
.version-library summary {
  cursor: pointer;
  color: var(--muted);
  padding: 6px 0;
}
.support-details p {
  overflow-wrap: anywhere;
}
.cell-secondary {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-top: 4px;
}
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
}
.save-fields {
  display: grid;
  gap: 12px;
  max-width: 650px;
  margin-bottom: 16px;
}
.save-fields label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
}
.plan-choice {
  display: flex;
  flex-direction: row;
  gap: 8px;
  align-items: center;
}
.plan-choice input {
  width: auto;
}
.notice {
  margin: 12px 0;
}
/* 保存方案按阅读顺序纵向排列，避免继承通知条的横向布局挤压内容。 */
.selected-plan {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.selected-plan > strong {
  overflow-wrap: anywhere;
}
.selected-plan > p,
.selected-plan > details {
  margin: 0;
}
.muted {
  font-size: 11px;
}
.comparison-panel {
  position: fixed;
  z-index: 8;
  left: 20px;
  right: 20px;
  bottom: 38px;
  max-height: 45vh;
  overflow: auto;
  padding: 16px;
  border: 1px solid #429ac9;
  border-radius: 8px;
  background: #102035;
  box-shadow: 0 -8px 32px #0008;
}
.comparison-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.comparison-heading h3 {
  margin: 0;
}
</style>
