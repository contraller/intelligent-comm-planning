<template>
  <section class="panel"
    ><div class="panel-head"
      ><h3>方案版本与对比</h3
      ><button
        class="text-link"
        :disabled="planning.busy"
        @click="planning.loadPlans()"
        >刷新版本</button
      ></div
    ><div class="panel-body">
      <div
        v-if="planning.canSave"
        class="save-fields"
        ><label
          >方案名称<input
            v-model="name"
            maxlength="60" /></label
        ><label
          >保存说明<textarea
            v-model="note"
            maxlength="500"
          /></label
        ><button
          class="btn primary"
          @click="save"
          >保存当前结果</button
        ><p class="muted">完整但未达标的结果保存为参考方案，不能确认配置。</p></div
      >
      <div
        v-if="planning.selectedPlan"
        class="notice"
        ><strong>{{ planning.selectedPlan.name }} · {{ planning.selectedPlan.version }}</strong
        ><p>{{
          planning.sourceChanged
            ? '历史参考 · 来源已变化'
            : planning.selectedPlan.current
              ? '当前确认方案'
              : planning.selectedPlan.state === 'REFERENCE'
                ? '参考方案'
                : planning.selectedPlan.state === 'CONFIRMED'
                  ? '已确认的历史版本'
                  : '待确认方案'
        }}</p>
        <p v-if="planning.selectedPlan.solutionId"
          >{{ planning.selectedPlan.solutionLabel }} · {{ planning.selectedPlan.solutionId }} ·
          新增部署单元 {{ planning.selectedPlan.radioCount ?? '未提供' }}</p
        >
        <button
          v-if="planning.job?.solutions?.length"
          class="btn"
          :disabled="planning.busy || !!planning.pending"
          @click="
            planning.selectSolution(planning.selectedSolutionId || planning.job.defaultSolutionId!)
          "
          >返回本次备选方案</button
        >
        <p v-if="planning.selectedPlan.adjustment"
          >设备参数与路由调整 · 父版本 {{ planning.selectedPlan.adjustment.sourcePlanId }} · 父快照
          {{ planning.selectedPlan.adjustment.sourceSnapshotId }}</p
        >
        <p v-else-if="planning.selectedPlan.parentPlanId"
          >父版本 {{ planning.selectedPlan.parentPlanId }}</p
        >
        <div class="toolbar"
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
            >调整设备参数与路由</button
          ><button
            class="btn"
            :disabled="!task.editable"
            @click="planning.adjust"
            >复制为任务条件</button
          ><button
            class="btn primary"
            :disabled="!planning.canConfirm"
            @click="planning.confirm"
            >确认方案配置</button
          ><button
            class="btn"
            :disabled="!auth.can('planning.view')"
            @click="exporting = true"
            >导出</button
          ></div
        >
        <p
          v-if="planning.adjustmentUnavailable()"
          class="muted"
          >{{ planning.adjustmentUnavailable() }}</p
        >
      </div>
      <p
        v-if="planning.error"
        class="notice warn"
        >{{ planning.error
        }}<button
          v-if="planning.pending"
          class="btn small"
          @click="planning.reconcile"
          >核实原请求</button
        ></p
      ><p
        v-if="planning.notice"
        class="notice"
        >{{ planning.notice }}</p
      >
      <AppTable
        :rows="planning.plans?.items ?? []"
        :columns="columns"
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
            />{{ row.name }}</label
          ></template
        ><template #state="{ row }"
          >{{
            row.state === 'REFERENCE'
              ? '参考方案'
              : row.state === 'CONFIRMED'
                ? '已确认'
                : '待确认'
          }}{{ row.current ? ' · 当前' : '' }}</template
        ><template #sourceChanged="{ row }">{{
          row.sourceChanged ? '历史参考' : '保存快照'
        }}</template
        ><template #actions="{ row }"
          ><button
            class="text-link"
            :disabled="planning.busy || !!planning.pending"
            @click="planning.selectPlan(row.id)"
            >查看</button
          ></template
        ></AppTable
      >
      <div class="toolbar section-gap"
        ><button
          class="btn small"
          :disabled="!planning.plans || planning.plans.page <= 1"
          @click="planning.loadPlans(planning.page - 1)"
          >上页</button
        ><span>{{ planning.plans?.total ?? 0 }} 个版本 · 第 {{ planning.plans?.page ?? 1 }} 页</span
        ><button
          class="btn small"
          :disabled="
            !planning.plans || planning.plans.page * planning.plans.pageSize >= planning.plans.total
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
      >
      <AppTable
        v-if="comparisonRows.length"
        :rows="comparisonRows"
        :columns="compareColumns"
        :page-size="5"
      /><p
        v-if="comparisonRows.length"
        class="muted"
        >功率差相对第一个所选版本，仅作展示；指标与成本直接读取保存结果。</p
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
const planning = usePlanningApiStore(),
  task = useTaskInputStore(),
  auth = useAuthStore();
const name = ref(''),
  note = ref(''),
  initial = ref(''),
  selected = ref<string[]>([]),
  exporting = ref(false);
const drafts = ref<Record<string, { name: string; note: string; initial: string }>>({});
const saveKey = computed(() => JSON.stringify([planning.job?.id, planning.selectedSolutionId]));
let restoring = false;
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
const exporter = (planId: string, format: 'json' | 'xlsx') =>
  previewService.exportPlanningPlan({ context: task.context, taskId: task.taskId, planId, format });
onBeforeUnmount(() => {
  delete task.auxiliary.planSave;
});
</script>
<style scoped>
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
  gap: 8px;
  align-items: center;
}
.plan-choice input {
  width: auto;
}
.notice {
  margin: 12px 0;
}
.muted {
  font-size: 11px;
}
</style>
