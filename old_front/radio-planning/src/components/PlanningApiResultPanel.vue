<template>
  <section class="panel result-panel"
    ><div class="panel-head"
      ><h3>规划结果</h3
      ><span
        v-if="historical"
        class="chip"
        >历史参考 · 来源已变化</span
      ></div
    >
    <template v-if="result"
      ><div class="metrics"
        ><article
          v-for="m in metricCards"
          :key="m.id"
          :class="m.state"
          ><span>{{ m.label }}</span
          ><strong
            >{{ m.value ?? '未提供' }}<small>{{ m.value === null ? '' : m.unit }}</small></strong
          ><small class="metric-status">{{ m.status }}</small
          ><small>{{ m.note }}</small></article
        ></div
      >
      <div class="tabs"
        ><button
          v-for="name in tabs"
          :key="name"
          :class="{ active: tab === name }"
          @click="tab = name"
          >{{ name }}</button
        ></div
      >
      <p
        v-if="!details"
        class="panel-body muted"
        >此结果未提供补充明细。</p
      >
      <template v-if="tab === '部署点位'"
        ><PlanningCandidatePanel
          v-if="candidates"
          :view="candidates"
        /><h4 class="panel-body">最终部署配置</h4
        ><AppTable
          :rows="result.configuration.deployment.map((d) => ({ id: d.stationId, ...d }))"
          :columns="deploymentColumns"
          :page-size="10"
          ><template #deviceIds="{ row }">{{ row.deviceIds.join(' / ') }}</template
          ><template #plannedCoordinate="{ row }">{{
            row.plannedCoordinate?.join(', ') ?? '沿用输入位置'
          }}</template
          ><template #actions="{ row }"
            ><button
              class="text-link"
              @click="handlers.node(row.stationId)"
              >定位</button
            ></template
          ></AppTable
        ></template
      >
      <div
        v-else-if="tab === '覆盖与场强'"
        class="panel-body"
      >
        <label
          >覆盖显示
          <select
            :value="coverageDisplay"
            aria-label="覆盖显示方式"
            @change="
              emit(
                'update:coverageDisplay',
                ($event.target as HTMLSelectElement).value as CoverageDisplay,
              )
            "
            ><option value="auto">自动</option
            ><option value="raster">场强图</option
            ><option value="contour">覆盖轮廓</option></select
          ></label
        >
        <p
          >覆盖率：{{ result.metrics.coveragePercent ?? '未提供'
          }}{{ result.metrics.coveragePercent === null ? '' : '%' }}</p
        ><p
          >{{ result.coverage.contour?.features.length ?? 0 }} 个覆盖轮廓 ·
          {{ result.coverage.rasterPng ? '已提供 PNG 场强图' : '未提供 PNG' }}</p
        >
        <p
          v-if="coverageDisplay === 'contour' && !result.coverage.contour?.features.length"
          class="notice warn"
          >此结果未提供覆盖轮廓。</p
        >
        <p
          v-else-if="!result.coverage.contour?.features.length && !result.coverage.rasterPng"
          class="notice warn"
          >此结果未提供覆盖数据。</p
        >
        <p
          v-else-if="coverageDisplay === 'raster' && !result.coverage.rasterPng"
          class="notice warn"
          >此结果未提供场强图，显示已有覆盖轮廓。</p
        >
        <p class="muted"
          >自动：全域显示场强图，放大保留场强并叠加已有边界；手动选择不随缩放改变。场强单位：dBμV/m。</p
        >
      </div>
      <template v-else-if="tab === '路由路径'"
        ><p
          v-if="detailCollection(details?.routeQuality)"
          class="panel-body"
          >路由质量：{{ detailCollection(details?.routeQuality) }}</p
        ><AppTable
          :rows="routeRows"
          :columns="routeColumns"
          :page-size="10"
          ><template #backup="{ row }">{{ row.backup ? '是' : '否' }}</template
          ><template #actions="{ row }"
            ><button
              class="text-link"
              @click="handlers.route(row)"
              >高亮路径</button
            ></template
          ></AppTable
        ><p class="panel-body">不可达需求：{{ unreachableDemandText(details) }}</p></template
      >
      <template v-else-if="tab === '频率分配'">
        <div
          class="panel-body"
          role="status"
          ><span>{{
            frequencyFocus?.message || frequencyMessage || '选择频率池或分配行查看明确关联。'
          }}</span
          ><button
            v-if="frequencySelection"
            class="btn small"
            @click="handlers.clear"
            >清除选择</button
          ></div
        >
        <AppTable
          :rows="poolRows"
          :columns="frequencyColumns"
          :page-size="10"
          :selected="
            frequencySelection?.kind === 'frequency'
              ? poolRows.find((row) => row.id === frequencySelection?.id)
              : null
          "
          @select="handlers.pool"
          ><template #allocatedKhz="{ row }">{{ row.allocatedKhz.join(' / ') }}</template></AppTable
        >
        <div class="panel-body"
          ><h4>逐链路频率分配</h4><p>{{ detailCollection(details?.frequencyAssignments) }}</p></div
        >
        <AppTable
          :rows="frequencyRows.assignments"
          :columns="assignmentColumns"
          :page-size="10"
          :selected="
            frequencySelection?.kind === 'assignment'
              ? frequencyRows.assignments.find((row) => row.id === frequencySelection?.id)
              : null
          "
          @select="handlers.assignment"
        />
        <div class="panel-body"
          ><h4>频率冲突记录</h4><p>{{ detailCollection(details?.frequencyConflicts) }}</p
          ><p>{{ frequencyDetailSummary(details) }}</p></div
        >
        <AppTable
          :rows="frequencyRows.conflicts"
          :columns="conflictColumns"
          :page-size="10"
        />
      </template>
      <PlanningOptimizationPanel
        v-else-if="tab === '优化权衡'"
        :value="details?.optimization"
        :owner="ownerKey"
        :disabled="!active"
        @link="handlers.critical"
      />
      <template v-else
        ><p
          v-if="detailCollection(details?.deviceParameters)"
          class="panel-body"
          >设备参数补充：{{ detailCollection(details?.deviceParameters) }}</p
        ><AppTable
          :rows="deviceRows"
          :columns="deviceColumns"
          :page-size="10"
          ><template #actions="{ row }"
            ><button
              class="text-link"
              @click="handlers.node(row.stationId)"
              >定位节点</button
            ></template
          ></AppTable
        ></template
      >
      <div class="panel-body"
        ><p>部署成本：{{ result.deploymentCost ?? '未提供' }} {{ result.costUnit }}</p
        ><p
          v-for="check in result.checks"
          :key="check.id"
          :class="{ warn: check.passed !== true }"
          >{{ check.label }} ·
          {{
            check.passed === true ? '通过' : check.passed === false ? '未通过' : '未提供结论'
          }}：{{ check.detail }}</p
        ><p
          v-for="note in result.notes"
          :key="note"
          class="muted"
          >{{ note }}</p
        ></div
      > </template
    ><p
      v-else
      class="panel-body muted"
      >提交规划并取得结果后，在此查看各分项。</p
    >
  </section>
</template>
<script setup lang="ts">
// 所有结果页签读取同一冻结快照，选择结果仅联动地图高亮。
import { computed, ref, watch } from 'vue';
import AppTable from './AppTable.vue';
import PlanningCandidatePanel from './PlanningCandidatePanel.vue';
import PlanningOptimizationPanel from './PlanningOptimizationPanel.vue';
import type { PlanningCandidatesView } from '../types/planning-candidates';
import { planningMetricCards } from '../services/planning-result-display';
import type { ApiPlanningResult } from '../types/planning-api';
import type { CoverageDisplay } from '../types/coverage';
import {
  deviceDetailCells,
  routeDetailCells,
  deviceDetailColumns,
  routeDetailColumns,
  assignmentColumns,
  conflictColumns,
  frequencyDetailRows,
  frequencyDetailSummary,
  detailCollection,
  unreachableDemandText,
  resolveFrequencyFocus,
} from '../services/planning-result-details-display';
import type { FrequencySelection } from '../services/planning-result-details-display';
const props = withDefaults(
  defineProps<{
    result: ApiPlanningResult | null;
    historical: boolean;
    coverageDisplay?: CoverageDisplay;
    ownerKey?: string;
    active?: boolean;
    candidates?: PlanningCandidatesView;
  }>(),
  { coverageDisplay: 'auto', ownerKey: '', active: true },
);
// 偏好由页面持有，查看另一结果或切回此页签不恢复默认值。
const emit = defineEmits<{
  candidateActive: [active: boolean];
  highlight: [nodes: string[], links: string[]];
  selectNode: [id: string];
  selectLink: [id: string];
  coverage: [visible: boolean];
  frequency: [ownerKey: string, selection: FrequencySelection | null];
  'update:coverageDisplay': [mode: CoverageDisplay];
}>();
const tab = ref('部署点位'),
  tabs = ['部署点位', '覆盖与场强', '路由路径', '频率分配', '设备参数', '优化权衡'];
const details = computed(() => props.result?.resultDetails);
const deviceRows = computed(
  () =>
    props.result?.configuration.devices.map((row) => ({
      ...row,
      id: row.deviceId,
      ...deviceDetailCells(details.value, row.deviceId),
    })) ?? [],
);
const routeRows = computed(
  () =>
    props.result?.configuration.routes.map((row) => ({
      ...row,
      path: row.nodeIds.join(' → '),
      ...routeDetailCells(details.value, row.id),
    })) ?? [],
);
const frequencySelection = ref<FrequencySelection | null>(null),
  frequencyMessage = ref(''),
  epoch = ref(0);
// 行携带展示身份，覆盖 AppTable 复用实例后转发迟到旧行的情形。
type FrequencyRow = { id: string; selectionOwner: string; selectionEpoch: number };
const poolRows = computed(
  () =>
    props.result?.configuration.frequencies.map((row) => ({
      ...row,
      selectionOwner: props.ownerKey,
      selectionEpoch: epoch.value,
    })) ?? [],
);
const frequencyRows = computed(() => {
  const rows = frequencyDetailRows(details.value);
  return {
    ...rows,
    assignments: rows.assignments.map((row) => ({
      ...row,
      selectionOwner: props.ownerKey,
      selectionEpoch: epoch.value,
    })),
  };
});
const frequencyFocus = computed(() =>
  props.result && frequencySelection.value
    ? resolveFrequencyFocus(props.result, frequencySelection.value)
    : null,
);
// 回调捕获渲染时的所有者和代次；相同对象 ID 的旧版本事件也不能定位新结果。
const handlers = computed(() => {
  const owner = props.ownerKey,
    generation = epoch.value;
  const valid = () =>
    owner === props.ownerKey && generation === epoch.value && props.active && !!props.result;
  const choose = (kind: FrequencySelection['kind'], row: FrequencyRow) => {
    if (
      !valid() ||
      tab.value !== '频率分配' ||
      row.selectionOwner !== owner ||
      row.selectionEpoch !== generation
    )
      return;
    frequencyMessage.value = '';
    frequencySelection.value = { kind, id: row.id };
    emit('frequency', owner, frequencySelection.value);
  };
  return {
    pool: (row: FrequencyRow) => choose('frequency', row),
    assignment: (row: FrequencyRow) => choose('assignment', row),
    clear: () => {
      if (valid()) {
        frequencyMessage.value = '';
        frequencySelection.value = null;
        emit('frequency', owner, null);
      }
    },
    node: (id: string) => {
      if (valid()) emit('selectNode', id);
    },
    // 子面板已校验结果身份，这里再次确认链路属于当前冻结网络。
    critical: (id: string) => {
      if (valid() && props.result?.links.some((row) => row.id === id)) {
        emit('highlight', [], [id]);
        emit('selectLink', id);
      }
    },
    route: (row: { nodeIds: string[]; linkIds: string[] }) => {
      if (valid()) {
        emit('highlight', row.nodeIds, row.linkIds);
        emit('selectLink', row.linkIds[0]);
      }
    },
  };
});
watch(
  [() => props.ownerKey, () => props.result?.snapshotId, () => !!props.result, () => props.active],
  () => {
    epoch.value++;
    frequencySelection.value = null;
    frequencyMessage.value = '';
  },
  { flush: 'sync' },
);
watch(
  () => ({ selection: frequencySelection.value, focus: frequencyFocus.value }),
  ({ selection, focus }, previous) => {
    if (!selection) return;
    // 同一选择仍有效但关联集合缩小，也不能继续保留父页面上一次的高亮。
    const signature = (value: NonNullable<typeof focus>) =>
      JSON.stringify([[...value.stationIds].sort(), [...value.linkIds].sort()]);
    if (
      selection === previous?.selection &&
      focus?.state === 'ready' &&
      previous.focus?.state === 'ready' &&
      signature(focus) !== signature(previous.focus)
    ) {
      frequencySelection.value = null;
      frequencyMessage.value = '所选频率关联已变化，已清除选择。';
      emit('frequency', props.ownerKey, null);
    } else if (focus?.state !== 'ready') {
      // 缺失或损坏的关系也结束旧选择；随后恢复数据不能让旧行自动复活。
      frequencyMessage.value = focus?.message ?? '未提供明确分配关系';
      frequencySelection.value = null;
      emit('frequency', props.ownerKey, null);
    }
  },
  { deep: true },
);
// 与 Mock 共用显式校验结论；缺失或重复结论保持中性，不从数值推算。
const metricCards = computed(() =>
  props.result ? planningMetricCards(props.result.metrics, props.result.checks) : [],
);
watch(
  tab,
  (value, previous) => {
    // 父页面持有候选状态，离开部署标签即停用地图层和旧选择事件。
    emit('candidateActive', value === '部署点位');
    epoch.value++;
    if (previous === '频率分配') {
      frequencySelection.value = null;
      frequencyMessage.value = '';
      emit('frequency', props.ownerKey, null);
    }
    emit('coverage', tab.value === '覆盖与场强');
    if (!props.active) return;
    emit(
      'highlight',
      ['部署点位', '设备参数'].includes(tab.value)
        ? (props.result?.configuration.deployment.map((d) => d.stationId) ?? [])
        : [],
      tab.value === '路由路径' ? (props.result?.links.map((l) => l.id) ?? []) : [],
    );
  },
  { immediate: true },
);
const deploymentColumns = [
  { field: 'stationId', header: '节点' },
  { field: 'role', header: '角色' },
  { field: 'deviceIds', header: '设备' },
  { field: 'plannedCoordinate', header: '规划位置' },
];
const routeColumns = [
  { field: 'demandId', header: '需求' },
  { field: 'path', header: '路由路径' },
  { field: 'backup', header: '备份路由' },
  ...routeDetailColumns,
];
const frequencyColumns = [
  { field: 'id', header: '频率资源' },
  { field: 'minKhz', header: '下限 / kHz' },
  { field: 'maxKhz', header: '上限 / kHz' },
  { field: 'allocatedKhz', header: '已分配 / kHz' },
];
const deviceColumns = [
  { field: 'deviceId', header: '设备' },
  { field: 'stationId', header: '节点' },
  { field: 'frequencyKhz', header: '频率 / kHz' },
  { field: 'txPowerDbm', header: '功率 / dBm' },
  { field: 'antennaHeightM', header: '天线高度 / m' },
  ...deviceDetailColumns,
];
</script>
<style scoped>
.metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 16px;
}
.metrics article {
  --metric-status: var(--muted);
  background: #152b40;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.metrics article.passed {
  --metric-status: #8ed66b;
}
.metrics article.failed {
  --metric-status: #ef5f64;
}
.metrics span {
  font-size: 12px;
}
.metrics strong {
  font-size: 24px;
  color: var(--metric-status);
}
.metrics small {
  font-size: 11px;
  color: var(--muted);
  margin-left: 4px;
}
.metrics .metric-status {
  color: var(--metric-status);
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  padding: 0 10px;
}
.panel-body {
  font-size: 12px;
  line-height: 1.8;
}
.warn {
  color: #e8b677;
}
.result-panel {
  min-width: 0;
}
</style>
