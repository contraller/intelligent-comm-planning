<template>
  <section class="panel result-panel"
    ><div class="panel-head"
      ><h3>规划结果</h3
      ><button
        v-if="result"
        class="text-link"
        :disabled="!active"
        @click="openConfiguration(ownerKey)"
        >查看完整配置</button
      ><span
        v-if="historical"
        class="chip"
        >历史参考 · 来源已变化</span
      ></div
    >
    <template v-if="result"
      ><div
        v-if="selection || selectionMessage"
        class="panel-body"
        role="status"
      >
        <span>{{ selectionMessage || (selection ? `已选择 ${selection.id}` : '') }}</span
        ><button
          class="btn small"
          @click="handlers.clear"
          >清除选择</button
        > </div
      ><details
        class="result-checks"
        :class="{ warn: checkWarning }"
        ><summary>{{ checkSummary }} · 查看约束依据</summary
        ><p
          v-for="check in result.checks"
          :key="check.id"
          >{{ check.label }} ·
          {{
            check.passed === true ? '通过' : check.passed === false ? '未通过' : '未提供结论'
          }}：{{ check.detail }}</p
        ></details
      ><div class="metrics"
        ><article
          v-for="m in metricCards"
          :key="m.id"
          :class="m.state"
          :title="m.note"
          ><span>{{ m.label }}</span
          ><strong
            >{{ m.value ?? '未提供' }}<small>{{ m.value === null ? '' : m.unit }}</small></strong
          ><small class="metric-status"
            >{{ m.status
            }}<template v-if="m.state === 'objective'"> · 未提供单项达标结论</template></small
          ><small v-if="m.state === 'failed' || m.state === 'unknown'">{{ m.note }}</small></article
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
      <div class="tab-guide">{{ tabGuides[tab] }}</div>
      <div
        ref="resultScroll"
        class="result-scroll"
        ><div
          v-if="outcome && (outcome.code !== 0 || outcome.gap.length || outcome.suggestions.length)"
          class="panel-body notice warn result-outcome"
          role="status"
          aria-label="当前方案服务结论"
        >
          <strong>{{ outcome.message }}</strong>
          <p v-for="(issue, index) in outcome.gap" :key="index">{{ planningIssueText(issue) }}</p>
          <p v-for="(suggestion, index) in outcome.suggestions" :key="index">{{ suggestion }}</p>
        </div>
        <p
          v-if="!details"
          class="panel-body muted"
          >此结果未提供补充明细。</p
        >
        <template v-if="tab === '部署点位'"
          ><div class="deployment-heading"
            ><h4>最终部署配置</h4
            ><p
              class="deployment-summary"
              aria-label="新增部署单元数"
              >新增部署单元数：{{ radioCount ?? '未提供' }}</p
            ></div
          ><div class="panel-body deployment-summary" aria-label="部署求解摘要">
            <p>求解模式：{{ deploymentSummary.mode }}</p>
            <p>新增部署单元（实际 / 请求）：{{ deploymentSummary.actualCount }} / {{ deploymentSummary.requestedCount }}</p>
            <p>完整结果份数（实际 / 请求）：{{ deploymentSummary.returnedSolutionCount }} / {{ deploymentSummary.requestedSolutionCount }}</p>
            <p>数量条件：{{ deploymentSummary.countSatisfied }}</p>
            <p>数量下界：{{ deploymentSummary.lowerBound }} · 最优性证明：{{ deploymentSummary.provedOptimal }}</p>
            <p>数量缺口原因：{{ deploymentSummary.shortfallReasons }}</p>
            <p>强制部署候选点：{{ deploymentSummary.forcedSiteIds }}</p>
          </div>
          <h4 class="panel-body">新增部署单元</h4>
          <p class="panel-body deployment-legend"><span class="new-deployment-dot"></span>橙色节点为本方案新增部署；点击定位可在地图中查看。</p>
          <AppTable
            v-if="newDeploymentRows.length"
            :sortable="false"
            compact
            :rows="newDeploymentRows"
            :columns="newDeploymentColumns"
            :page-size="10"
            :selected="selectedRow('deployment', newDeploymentRows)"
            @select="handlers.deployment"
          ><template #stationName="{ row }"><strong>{{ row.stationName }}</strong><small class="cell-secondary">{{ row.stationId }}</small></template>
            <template #plannedCoordinate="{ row }">{{ row.plannedCoordinate?.join(', ') ?? '未提供规划坐标' }}</template>
            <template #actions="{ row }"><button class="text-link" @click="handlers.deployment(row)">定位</button></template>
          </AppTable>
          <p v-else class="panel-body muted">{{ radioCount && !result.nodes.some(node => node.isNewDeployment !== undefined) ? '此历史结果未提供新增部署标识，请重新规划以查看新增单元明细。' : '此方案没有新增部署单元。' }}</p>
          <h4 class="panel-body">全部部署节点</h4>
          <AppTable
            :sortable="false"
            compact
            :rows="deploymentRows"
            :columns="deploymentSummaryColumns"
            :detail-columns="deploymentColumns"
            :details-key="ownerKey"
            :page-size="10"
            :selected="selectedRow('deployment', deploymentRows)"
            @select="handlers.deployment"
            ><template #stationId="{ row }"
              ><strong>{{ row.stationName }}</strong
              ><small class="cell-secondary">{{ row.stationId }} · {{ row.role }}{{ row.isNewDeployment ? ' · 新增部署' : '' }}</small></template
            ><template #deviceIds="{ row }">{{ row.deviceIds.join(' / ') }}</template
            ><template #detail-plannedCoordinate="{ row }">{{
              row.plannedCoordinate?.join(', ') ?? '未提供规划坐标'
            }}</template
            ><template #actions="{ row }"
              ><button
                class="text-link"
                @click="handlers.deployment(row)"
                >定位</button
              ></template
            ></AppTable
          ><details
            v-if="candidates"
            class="support-details"
            ><summary>候选筛选与依据</summary><PlanningCandidatePanel :view="candidates" /></details
          ><p v-if="candidateSources !== null" class="panel-body" aria-label="候选数据来源">
            候选数据来源：{{ candidateSources }}
          </p>
          <p v-if="candidateLimitations !== null" class="panel-body">
            候选数据限制：{{ candidateLimitations }}
          </p></template>
        <template v-else-if="tab === '路由路径'"
          ><p
            v-if="detailCollection(details?.routeQuality)"
            class="panel-body"
            >路由质量：{{ detailCollection(details?.routeQuality) }}</p
          ><AppTable
            :sortable="false"
            compact
            :rows="routeRows"
            :columns="routeSummaryColumns"
            :detail-columns="routeColumns"
            :details-key="ownerKey"
            table-min-width="440px"
            :page-size="10"
            :selected="selectedRow('route', routeRows)"
            @select="handlers.route"
            ><template #demandId="{ row }"
              ><strong class="cell-id">{{ row.demandId }}</strong
              ><small class="cell-secondary">{{
                row.backup ? '备用路由' : '主路由'
              }}</small></template
            >
            <template #path="{ row }"
              ><template
                v-for="(id, index) in row.nodeIds"
                :key="index"
                ><span class="cell-id">{{ id }}</span
                ><template v-if="index < row.nodeIds.length - 1"> → <wbr /></template></template
            ></template>
            <template #isFeasible="{ row }"
              >{{ row.isFeasible
              }}<small class="cell-secondary">{{ row.hopCount }} 跳</small></template
            >
            <template #actions="{ row }"
              ><button
                class="text-link"
                @click="handlers.route(row)"
                >高亮路径</button
              ></template
            ></AppTable
          ><p class="panel-body">不可达需求：{{ unreachableDemandText(details) }}</p>
          <h4 class="panel-body">结果链路</h4
          ><AppTable
            :sortable="false"
            compact
            :rows="linkRows"
            :columns="linkColumns"
            :page-size="10"
            :selected="selectedRow('link', linkRows)"
            @select="handlers.link"
          />
        </template>
        <template v-else-if="tab === '频率分配'">
          <div
            class="panel-body"
            role="status"
            ><span>{{
              frequencyFocus?.message ||
              frequencyMessage ||
              (frequencyOverview && defaultFrequencyFocus.linkIds.length
                ? '已高亮频率资源明确关联的链路；选择行查看明细。'
                : '当前频率资源未提供明确关联，可选择分配行查看。')
            }}</span></div
          >
          <AppTable
            :sortable="false"
            compact
            :rows="poolRows"
            :columns="frequencySummaryColumns"
            :detail-columns="frequencyColumns"
            :details-key="ownerKey"
            :page-size="10"
            :selected="
              frequencySelection?.kind === 'frequency'
                ? poolRows.find((row) => row.id === frequencySelection?.id)
                : null
            "
            @select="handlers.pool"
            ><template #range="{ row }">{{ row.minKhz }}–{{ row.maxKhz }}</template
            ><template #allocatedKhz="{ row }">{{
              row.allocatedKhz.join(' / ')
            }}</template></AppTable
          >
          <div class="panel-body"
            ><h4>逐链路频率分配</h4
            ><p>{{ detailCollection(details?.frequencyAssignments) }}</p></div
          >
          <AppTable
            :sortable="false"
            compact
            :rows="frequencyRows.assignments"
            :columns="assignmentSummaryColumns"
            :detail-columns="assignmentColumns"
            :details-key="ownerKey"
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
            :sortable="false"
            compact
            :rows="frequencyRows.conflicts"
            :columns="conflictSummaryColumns"
            :detail-columns="conflictColumns"
            :details-key="ownerKey"
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
          ><p class="panel-body muted"
            >倾角及是否参与计算以本次结果明细为准；未提供的倾角保留缺值。</p
          ><AppTable
            :sortable="false"
            compact
            :rows="deviceRows"
            :columns="deviceSummaryColumns"
            :detail-columns="deviceColumns"
            :details-key="ownerKey"
            table-min-width="430px"
            :page-size="10"
            :selected="selectedRow('device', deviceRows)"
            @select="handlers.device"
            ><template #deviceId="{ row }"
              ><strong>{{ row.deviceId }}</strong
              ><small class="cell-secondary">{{ row.stationId }}</small></template
            >
            <template #parameters="{ row }"
              >{{ row.txPowerDbm }} dBm<small class="cell-secondary"
                >高度 {{ row.antennaHeightM }} m</small
              ></template
            >
            <template #actions="{ row }"
              ><button
                class="text-link"
                @click="handlers.device(row)"
                >定位节点</button
              ></template
            ></AppTable
          ></template
        >
        <div class="panel-body"
          ><p>部署成本：{{ result.deploymentCost ?? '未提供' }} {{ result.costUnit }}</p
          ><details
            v-if="result.notes.length"
            class="support-details"
            ><summary>结果说明 · {{ result.notes.length }} 条</summary
            ><p
              v-for="note in result.notes"
              :key="note"
              class="muted"
              >{{ note }}</p
            ></details
          ></div
        >
      </div></template
    ><p
      v-else
      class="panel-body muted"
      >{{ planning.running ? '规划正在计算，结果生成后将在此显示。' : planning.job ? '本次规划已结束，未生成可用结果。请查看上方作业结论。' : '提交规划并取得结果后，在此查看各分项。' }}</p
    >
    <AppDrawer
      v-if="result"
      v-model:visible="configurationOpen"
      :title="configurationMode === 'confirmed' ? '正式配置快照' : '完整方案配置'"
      width="960px"
      :subtitle="
        configurationMode === 'confirmed'
          ? '查看转正时服务返回的部署、设备、路由和频率配置。'
          : '只读取当前结果冻结配置；不执行资源应用或设备下发。'
      "
    >
      <div
        v-if="configurationMode === 'confirmed' && confirmedConfiguration"
        class="configuration-origin"
      >
        <strong
          >来源方案 {{ confirmedConfiguration.sourcePlanId }} ·
          {{ confirmedConfiguration.sourcePlanVersion }}</strong
        >
        <p>转正时间：{{ confirmedConfiguration.confirmedAt }}</p>
        <p class="muted">来源快照：{{ confirmedConfiguration.sourceSnapshotId }}</p>
      </div>
      <h4>部署配置</h4
      ><AppTable
        :sortable="false"
        compact
        :rows="configurationDeploymentRows"
        :columns="deploymentColumns"
        table-min-width="600px"
        :page-size="10"
        ><template #plannedCoordinate="{ row }">{{
          row.plannedCoordinate?.join(', ') ?? '未提供规划坐标'
        }}</template></AppTable
      >
      <h4>设备参数</h4
      ><p
        v-if="configurationMode !== 'confirmed'"
        class="muted"
        >倾角及是否参与计算以本次结果明细为准；未提供的倾角保留缺值。</p
      ><AppTable
        :sortable="false"
        compact
        :rows="configurationDeviceRows"
        :columns="configurationMode === 'confirmed' ? deviceColumns.slice(0, 5) : deviceColumns"
        table-min-width="760px"
        :page-size="10"
      />
      <h4>主备路由</h4
      ><AppTable
        :sortable="false"
        compact
        :rows="configurationRouteRows"
        :columns="configurationMode === 'confirmed' ? routeColumns.slice(0, 3) : routeColumns"
        :table-min-width="configurationMode === 'confirmed' ? '600px' : '1100px'"
        :page-size="10"
      />
      <h4>频率资源</h4
      ><AppTable
        :sortable="false"
        compact
        :rows="
          configurationMode === 'confirmed' ? (configurationData?.frequencies ?? []) : poolRows
        "
        :columns="frequencyColumns"
        :page-size="10"
      />
    </AppDrawer>
  </section>
</template>
<script setup lang="ts">
// 所有结果页签读取同一冻结快照，选择结果仅联动地图高亮。
import { computed, ref, watch } from 'vue';
import { usePlanningApiStore } from '../stores/planning-api';
import AppTable from './AppTable.vue';
import AppDrawer from './AppDrawer.vue';
import PlanningCandidatePanel from './PlanningCandidatePanel.vue';
import PlanningOptimizationPanel from './PlanningOptimizationPanel.vue';
import type { PlanningCandidatesView } from '../types/planning-candidates';
import { planningMetricCards } from '../services/planning-result-display';
import type { ApiPlan, ApiPlanningResult, PlanningConfirmedConfiguration } from '../types/planning-api';
import type { CoverageDisplay } from '../types/coverage';
import { deploymentDisplayRows } from '../services/planning-deployment-display';
import { planningIssueText } from '../services/planning-issue-display';
import {
  deploymentDetailCells,
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
const planning = usePlanningApiStore();
const props = withDefaults(
  defineProps<{
    result: ApiPlanningResult | null;
    outcome?: ApiPlan['outcome'] | null;
    radioCount?: number | null;
    confirmedConfiguration?: PlanningConfirmedConfiguration | null;
    historical: boolean;
    coverageDisplay?: CoverageDisplay;
    ownerKey?: string;
    active?: boolean;
    candidates?: PlanningCandidatesView;
  }>(),
  { coverageDisplay: 'auto', ownerKey: '', active: true, radioCount: null },
);
// 偏好由页面持有，查看另一结果或切回此页签不恢复默认值。
const emit = defineEmits<{
  candidateActive: [active: boolean];
  focus: [
    ownerKey: string,
    value: { stationId: string; linkId: string; stationIds: string[]; linkIds: string[] },
  ];
  coverage: [visible: boolean];
  'update:coverageDisplay': [mode: CoverageDisplay];
}>();
const tab = ref('部署点位'),
  tabs = ['部署点位', '路由路径', '频率分配', '设备参数', '优化权衡'];
const resultScroll = ref<HTMLElement>();
// 仅复位分项明细，保留整页位置、地图视野与已有联动规则。
watch(
  tab,
  () => {
    if (resultScroll.value) resultScroll.value.scrollTop = 0;
  },
  { flush: 'post' },
);
const tabGuides: Record<string, string> = {
  部署点位: '查看最终部署的节点与设备；点击“定位”在地图中找到它。',
  路由路径: '查看通联需求经过的路径；点击“高亮路径”在地图中查看。',
  频率分配: '查看链路使用的频率及冲突；选择记录查看明确关联的链路。',
  设备参数: '查看规划采用的频率、功率和天线高度，展开详情查看辅助参数。',
  优化权衡: '查看服务给出的功率与抗毁性权衡，辅助判断调整方向。',
};
// 只归纳服务已给出的逐项结论，不以数值推算业务达标。
const checkWarning = computed(
  () => !props.result?.checks.length || props.result.checks.some((row) => row.passed !== true),
);
const checkSummary = computed(() =>
  !props.result?.checks.length
    ? '未提供约束校验结论'
    : props.result.checks.some((row) => row.passed === false)
      ? '存在未通过的约束'
      : checkWarning.value
        ? '部分约束未提供结论'
        : '已提供的约束均通过',
);
const frequencyOverview = ref(false);
const details = computed(() => props.result?.resultDetails);
const deploymentSummary = computed(() => deploymentDetailCells(details.value));
const candidateSources = computed(() => {
  const sources = details.value?.candidateScreening?.dataSources;
  return sources === undefined ? null : sources === null ? '未提供' : sources.join('；') || '服务未列出数据来源';
});
const candidateLimitations = computed(() => {
  const reasons = details.value?.candidateScreening?.unavailableReasons;
  return reasons === undefined ? null : reasons === null ? '未提供' : reasons.join('；') || '服务未列出限制原因';
});
// 切换结果即关闭配置，避免把上一快照的抽屉当作当前配置。
const configurationOpen = ref(false);
const configurationMode = ref<'result' | 'confirmed'>('result');
// 正式配置只读取服务返回的确认产物，不混用规划明细或当前编辑值。
const configurationData = computed(() =>
  configurationMode.value === 'confirmed'
    ? props.confirmedConfiguration?.configuration
    : props.result?.configuration,
);
const configurationDeviceRows = computed(() =>
  configurationMode.value === 'confirmed'
    ? (configurationData.value?.devices.map((d) => ({ ...d, id: d.deviceId })) ?? [])
    : deviceRows.value,
);
const configurationRouteRows = computed(() =>
  configurationMode.value === 'confirmed'
    ? (configurationData.value?.routes.map((r) => ({ ...r, path: r.nodeIds.join(' → ') })) ?? [])
    : routeRows.value,
);
// 两个步骤复用同一冻结配置；拒绝失效对象或失去查看权限后的打开请求。
function openConfiguration(owner: string, mode: 'result' | 'confirmed' = 'result') {
  if (!props.active || !props.result || owner !== props.ownerKey) return;
  if (
    mode === 'confirmed' &&
    (!props.confirmedConfiguration ||
      props.confirmedConfiguration.sourceSnapshotId !== props.result.snapshotId)
  )
    return;
  configurationMode.value = mode;
  configurationOpen.value = true;
}
watch(
  () => [
    props.ownerKey,
    props.result?.snapshotId,
    props.active,
    props.confirmedConfiguration,
    props.confirmedConfiguration?.sourceSnapshotId,
    props.confirmedConfiguration?.confirmedAt,
  ],
  () => {
    configurationOpen.value = false;
  },
);
type ObjectKind = 'route' | 'device' | 'deployment' | 'link' | 'station';
type ResultSelection = { kind: ObjectKind; id: string } | FrequencySelection;
const selection = ref<ResultSelection | null>(null),
  selectionMessage = ref('');
// 每类可选择行都携带展示身份，复用表格不能把旧行转交给新结果。
const epoch = ref(0);
const bindRows = <T extends { id: string }>(rows: T[]) =>
  rows.map((row) => ({ ...row, selectionOwner: props.ownerKey, selectionEpoch: epoch.value }));
const deploymentRows = computed(() =>
  bindRows(deploymentDisplayRows(props.result)),
);
const newDeploymentRows = computed(() => deploymentRows.value.filter(row => row.isNewDeployment));
const configurationDeploymentRows = computed(() => deploymentDisplayRows(props.result, configurationData.value?.deployment));
const newDeploymentColumns = [
  { field: 'stationName', header: '新增节点名称', minWidth: '140px' },
  { field: 'deviceLabels', header: '部署设备 / 型号', minWidth: '220px' },
  { field: 'plannedCoordinate', header: '规划位置', minWidth: '160px' },
];
const linkRows = computed(() => bindRows(props.result?.links ?? []));
const linkColumns = [
  { field: 'id', header: '链路' },
  { field: 'a', header: '起点' },
  { field: 'b', header: '终点' },
];
const deviceRows = computed(() =>
  bindRows(
    props.result?.configuration.devices.map((row) => ({
      ...row,
      id: row.deviceId,
      ...deviceDetailCells(details.value, row.deviceId),
    })) ?? [],
  ),
);
const routeRows = computed(() =>
  bindRows(
    props.result?.configuration.routes.map((row) => ({
      ...row,
      path: row.nodeIds.join(' → '),
      ...routeDetailCells(details.value, row.id),
    })) ?? [],
  ),
);
const frequencySelection = computed(() =>
  selection.value && ['frequency', 'assignment'].includes(selection.value.kind)
    ? (selection.value as FrequencySelection)
    : null,
);
const frequencyMessage = selectionMessage;
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
// 定位只解析当前冻结结果中的显式关联，不从任务草稿或其他版本补值。
const emptyFocus = () => ({
  stationId: '',
  linkId: '',
  stationIds: [] as string[],
  linkIds: [] as string[],
});
// 汇总服务返回的显式关联；不按端点或同名 ID 猜测频率关系。
const defaultFrequencyFocus = computed(() => {
  if (!props.result) return emptyFocus();
  const rows = props.result.configuration.frequencies.map((row) =>
    resolveFrequencyFocus(props.result!, { kind: 'frequency', id: row.id }),
  );
  return {
    ...emptyFocus(),
    stationIds: [...new Set(rows.flatMap((row) => row.stationIds))],
    linkIds: [...new Set(rows.flatMap((row) => row.linkIds))],
  };
});
function objectFocus(value: ResultSelection) {
  const result = props.result;
  if (!result) return null;
  const node = (id: string) => result.nodes.some((row) => row.id === id);
  if (value.kind === 'station' || value.kind === 'deployment' || value.kind === 'device') {
    const id =
      value.kind === 'device'
        ? result.configuration.devices.find((row) => row.deviceId === value.id)?.stationId
        : value.id;
    if (
      value.kind === 'deployment' &&
      !result.configuration.deployment.some((row) => row.stationId === value.id)
    )
      return null;
    if (
      value.kind === 'device' &&
      !result.devices.some((row) => row.id === value.id && row.stationId === id)
    )
      return null;
    if (!id || !node(id)) return null;
    return {
      stationId: id,
      linkId: '',
      stationIds: [id],
      linkIds:
        value.kind === 'device'
          ? result.links
              .filter((row) => row.deviceA === value.id || row.deviceB === value.id)
              .map((row) => row.id)
          : [],
    };
  }
  if (value.kind === 'link') {
    const link = result.links.find((row) => row.id === value.id);
    return link && node(link.a) && node(link.b)
      ? { stationId: '', linkId: link.id, stationIds: [link.a, link.b], linkIds: [link.id] }
      : null;
  }
  const route = result.configuration.routes.find((row) => row.id === value.id);
  return route &&
    route.nodeIds.every(node) &&
    route.linkIds.every((id) => result.links.some((row) => row.id === id))
    ? {
        stationId: route.nodeIds[0] ?? '',
        linkId: '',
        stationIds: route.nodeIds,
        linkIds: route.linkIds,
      }
    : null;
}
const focus = computed(() => {
  if (!props.active || !props.result) return emptyFocus();
  if (selection.value)
    return frequencySelection.value
      ? (frequencyFocus.value ?? emptyFocus())
      : (objectFocus(selection.value) ?? emptyFocus());
  if (selectionMessage.value) return emptyFocus();
  if (tab.value === '频率分配')
    return frequencyOverview.value ? defaultFrequencyFocus.value : emptyFocus();
  return {
    ...emptyFocus(),
    stationIds: ['部署点位', '设备参数'].includes(tab.value)
      ? props.result.configuration.deployment.map((row) => row.stationId)
      : [],
    linkIds: tab.value === '路由路径' ? props.result.links.map((row) => row.id) : [],
  };
});
function selectedRow<T extends { id: string }>(kind: ResultSelection['kind'], rows: T[]) {
  return props.active && selection.value?.kind === kind
    ? (rows.find((row) => row.id === selection.value?.id) ?? null)
    : null;
}
// 回调与行同时校验所有者和代次；隐藏再恢复也不能接受旧事件。
const handlers = computed(() => {
  const owner = props.ownerKey,
    generation = epoch.value;
  const valid = () =>
    owner === props.ownerKey && generation === epoch.value && props.active && !!props.result;
  const choose = (kind: ResultSelection['kind'], row: FrequencyRow) => {
    if (!valid() || row.selectionOwner !== owner || row.selectionEpoch !== generation) return;
    const rows =
      kind === 'route'
        ? routeRows.value
        : kind === 'device'
          ? deviceRows.value
          : kind === 'deployment'
            ? deploymentRows.value
            : kind === 'link'
              ? linkRows.value
              : kind === 'frequency'
                ? poolRows.value
                : frequencyRows.value.assignments;
    if (!rows.some((item) => item.id === row.id)) return;
    selectionMessage.value = '';
    selection.value = { kind, id: row.id } as ResultSelection;
  };
  const selectId = (kind: 'station' | 'link', id: string) => {
    if (
      !valid() ||
      !props.result?.[kind === 'station' ? 'nodes' : 'links'].some((row) => row.id === id)
    )
      return;
    selectionMessage.value = '';
    selection.value = { kind, id };
  };
  return {
    pool: (row: FrequencyRow) => {
      if (tab.value === '频率分配') choose('frequency', row);
    },
    assignment: (row: FrequencyRow) => {
      if (tab.value === '频率分配') choose('assignment', row);
    },
    route: (row: FrequencyRow) => choose('route', row),
    device: (row: FrequencyRow) => choose('device', row),
    deployment: (row: FrequencyRow) => choose('deployment', row),
    link: (row: FrequencyRow) => choose('link', row),
    node: (id: string) => selectId('station', id),
    mapLink: (id: string) => selectId('link', id),
    critical: (id: string) => selectId('link', id),
    clear: () => {
      if (valid()) {
        selection.value = null;
        frequencyOverview.value = false;
        selectionMessage.value = '';
      }
    },
  };
});
watch(
  [() => props.ownerKey, () => props.result?.snapshotId, () => !!props.result],
  () => {
    epoch.value++;
    frequencyOverview.value = false;
    selection.value = null;
    selectionMessage.value = '';
  },
  { flush: 'sync' },
);
watch(
  () => props.active,
  () => {
    epoch.value++;
  },
  { flush: 'sync' },
);
watch(
  () => ({
    selection: selection.value,
    focus: frequencySelection.value
      ? frequencyFocus.value
      : selection.value
        ? objectFocus(selection.value)
        : null,
  }),
  ({ selection: value, focus: current }, previous) => {
    if (!value) return;
    const signature = (item: NonNullable<typeof current>) =>
      JSON.stringify([[...item.stationIds].sort(), [...item.linkIds].sort()]);
    if (
      value === previous?.selection &&
      current &&
      previous.focus &&
      (!('state' in current) || current.state === 'ready') &&
      (!('state' in previous.focus) || previous.focus.state === 'ready') &&
      signature(current) !== signature(previous.focus)
    ) {
      selectionMessage.value = frequencySelection.value
        ? '所选频率关联已变化，已清除选择。'
        : '所选结果关联已变化，已清除选择。';
      selection.value = null;
    } else if (!current || ('state' in current && current.state !== 'ready')) {
      selectionMessage.value =
        current && 'message' in current
          ? String(current.message)
          : '所选结果关联不完整，无法定位。';
      selection.value = null;
    }
  },
  { deep: true, flush: 'sync' },
);
watch(focus, (value) => emit('focus', props.ownerKey, value), { immediate: true, deep: true });
// 地图调用同一选择入口，表格和地图不会分别保留旧选择。
defineExpose({
  openConfiguration,
  selectNode: (id: string) => handlers.value.node(id),
  selectLink: (id: string) => handlers.value.mapLink(id),
});
// 与 Mock 共用显式校验结论；缺失或重复结论保持中性，不从数值推算。
const metricCards = computed(() =>
  props.result ? planningMetricCards(props.result.metrics, props.result.checks) : [],
);
watch(
  tab,
  () => {
    frequencyOverview.value = tab.value === '频率分配';
    emit('candidateActive', tab.value === '部署点位');
    epoch.value++;
    selection.value = null;
    selectionMessage.value = '';
    emit('coverage', false);
  },
  { immediate: true, flush: 'sync' },
);
const deploymentColumns = [
  { field: 'stationId', header: '节点' },
  { field: 'stationName', header: '节点名称' },
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
// 主表承担快速浏览；展开明细和完整配置均保留同一快照的全部字段。
const deploymentSummaryColumns = [
  { field: 'stationId', header: '节点 / 角色', minWidth: '100px' },
  { field: 'deviceIds', header: '设备', minWidth: '120px' },
];
const routeSummaryColumns = [
  { field: 'demandId', header: '需求 / 主备', minWidth: '96px' },
  { field: 'path', header: '路由路径', minWidth: '130px' },
  { field: 'isFeasible', header: '可行性 / 跳数', minWidth: '90px' },
];
const frequencySummaryColumns = [
  { field: 'id', header: '频率资源', minWidth: '95px' },
  { field: 'range', header: '范围 / kHz', minWidth: '105px' },
  { field: 'allocatedKhz', header: '已分配 / kHz', minWidth: '110px' },
];
const assignmentSummaryColumns = assignmentColumns.filter((column) =>
  ['linkId', 'frequencyKhz', 'bandwidthKhz'].includes(column.field),
);
const conflictSummaryColumns = conflictColumns.filter((column) =>
  ['type', 'linkIds', 'severity'].includes(column.field),
);
const deviceSummaryColumns = [
  { field: 'deviceId', header: '设备 / 节点', minWidth: '100px' },
  { field: 'frequencyKhz', header: '频率 / kHz', minWidth: '85px' },
  { field: 'parameters', header: '功率 / 高度', minWidth: '95px' },
];
</script>
<style scoped>
.deployment-legend { display: flex; align-items: center; gap: 8px; }
.new-deployment-dot { width: 10px; height: 10px; border-radius: 50%; background: #ff9f43; flex: none; }
.configuration-origin {
  display: grid;
  gap: 8px;
  padding: 12px;
  background: #142b3d;
  overflow-wrap: anywhere;
}
.result-outcome {
  display: block;
  margin: 8px 12px;
  overflow-wrap: anywhere;
}
.configuration-origin p {
  margin: 0;
}
.deployment-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 12px;
  padding: 10px 12px;
}
.deployment-heading h4,
.deployment-summary {
  margin: 0;
}
.deployment-summary p {
  margin: 4px 0;
  overflow-wrap: anywhere;
}
.deployment-summary {
  font-size: 12px;
}
.tab-guide {
  padding: 6px 12px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
  flex: none;
}
.result-checks {
  margin: 8px 12px 0;
  padding: 8px 10px;
  background: #142b3d;
  font-size: 12px;
  flex: none;
}
.result-checks summary,
.support-details summary {
  cursor: pointer;
}
.result-checks[open] {
  max-height: 180px;
  overflow: auto;
}
.result-checks p {
  margin: 8px 0;
}
.support-details {
  margin: 10px 12px;
  font-size: 12px;
}
.cell-id {
  white-space: nowrap;
  font-size: 12px;
}
.cell-secondary {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 11px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 8px 12px;
}
.metrics article {
  --metric-status: var(--muted);
  background: #152b40;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
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
  /* 分项共用一行导航，窄屏横向滚动。覆盖计算统一进入调整工作区。 */
  flex-wrap: nowrap;
  gap: 12px;
  padding: 0 12px;
  overflow-x: auto;
}
.tabs button {
  flex: none;
  padding: 8px 0;
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
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 指标及标签留在固定区域，只有分项明细滚动。 */
.result-panel > .panel-head,
.metrics,
.tabs {
  flex: none;
}
.result-scroll {
  min-height: 0;
  overflow: auto;
  flex: 1;
}
</style>
