<template>
  <div class="page planning-api-page"
    ><div class="page-heading"
      ><div><p class="eyebrow">NETWORK PLANNING</p><h1>网络规划</h1></div
      ><span class="chip cyan">接口任务与方案</span></div
    >
    <div class="steps"
      ><button
        v-for="(label, i) in ['任务与约束输入', '规划计算与结果', '方案调整与对比']"
        :key="label"
        :class="{ active: planning.step === i + 1 }"
        @click="planning.step = i + 1"
        >{{ i + 1 }} · {{ label }}</button
      ></div
    >
    <ResourceReadStatus v-if="planning.step === 1" />
    <PlanningSolutionsPanel
      v-if="planning.step !== 1 && planning.job?.solutions"
      :solutions="planning.job.solutions"
      :selected="planning.selectedPlan ? '' : planning.selectedSolutionId"
      :requested="planning.job.input.deploymentSolve?.solutionCount"
      :owner="JSON.stringify([auth.generation, task.taskId, planning.job.id, resultOwner])"
      :disabled="planning.busy || !!planning.pending || planning.adjustmentDirty || !task.readable"
      @select="planning.selectSolution"
    />
    <div
      class="planning-layout"
      :class="{ input: planning.step === 1 }"
      ><div
        v-show="planning.step === 1"
        class="input-panel"
        ><TaskApiPanel @opened="opened" /><button
          class="btn primary submit"
          :disabled="!planning.canSubmit"
          @click="planning.submit"
          >提交规划</button
        ></div
      >
      <section class="map-panel"
        ><MapCanvas
          :deployment-constraints="deploymentFrame"
          v-if="bounds"
          ref="map"
          :planning-candidates="candidates.frame.value"
          @select-planning-candidate="candidates.selectMap"
          :stations="[]"
          resource-read
          :resource-frame="planning.step === 1 ? resources.frame : null"
          :resource-bounds="bounds"
          :planning-overlay="overlay"
          :show-coverage="showCoverage"
          :coverage-display="coverageDisplay"
          :selected-id="focused"
          :selected-link-id="focusedLink"
          :highlight-station-ids="nodeHighlights"
          :highlight-link-ids="linkHighlights"
          @viewport="viewport"
          @select="focusNode"
          @select-link="focusLink"
          @select-resource="focused = $event.id"
          @select-cluster="chooseCluster"
        />
        <p
          v-else
          class="empty-inline"
          >任务引用或结果加载后显示地图。</p
        ><div
          v-if="planning.step === 1 && focused"
          class="map-selection"
          ><span>{{ focused }}</span
          ><button
            class="btn small"
            :disabled="!task.editable || !!task.draft?.stationIds.includes(focused)"
            @click="addNode(focused)"
            >{{ task.draft?.stationIds.includes(focused) ? '已加入任务' : '加入任务节点' }}</button
          ></div
        >
        <p
          v-if="planning.step === 1 && resources.errors.map"
          class="notice warn"
          >{{ resources.errors.map
          }}<button
            class="text-link"
            @click="resources.loadMap"
            >重试</button
          ></p
        >
      </section>
      <div
        v-show="planning.step !== 1"
        class="result-column"
        ><PlanningApiProgressPanel /><PlanningApiResultPanel
          v-model:coverage-display="coverageDisplay"
          :candidates="candidates.view.value"
          @candidate-active="candidateTab = $event"
          :result="planning.result"
          :owner-key="resultOwner"
          :active="resultActive"
          :historical="planning.sourceChanged"
          @frequency="frequencySelection"
          @highlight="highlight"
          @select-node="focusNode"
          @select-link="focusLink"
          @coverage="showCoverage = $event"
      /></div>
    </div>
    <DeploymentConstraintsSummary
      v-if="planning.step !== 1"
      :value="deploymentFrame.constraints"
      label="当前结果的冻结部署筛选条件"
    />
    <PlanningOptionsSummary
      v-if="planning.step !== 1"
      :input="planning.selectedPlan?.input ?? planning.job?.input"
    />
    <PlanningApiVersionsPanel v-show="planning.step === 3" />
    <template v-if="planning.step === 3 && planning.adjustmentParent"
      ><div class="toolbar"
        ><button
          class="btn"
          :disabled="planning.busy || !!planning.pending"
          @click="planning.adjustmentOpen = true"
          >查看调整输入</button
        ></div
      ><PlanningAdjustmentPreview
        :before="planning.adjustmentParent"
        :after="planning.adjustmentResult"
        :status="planning.adjustmentStatus"
    /></template>
    <PlanningAdjustmentDrawer
      v-if="planning.adjustmentContext && planning.adjustmentDraft && planning.adjustmentParent"
      :visible="planning.adjustmentOpen"
      :parent="planning.adjustmentContext"
      :parent-label="`${planning.adjustmentParent.name} · ${planning.adjustmentParent.version}`"
      :model-value="planning.adjustmentDraft"
      :examples="task.catalog?.adjustmentExamples"
      :disabled="adjustmentDisabled"
      :busy="adjustmentBusy"
      :error="planning.error"
      :issues="planning.adjustmentIssues"
      :status="planning.adjustmentStatus"
      @update:model-value="planning.updateAdjustment"
      :pending="!!planning.pending"
      @reconcile="planning.reconcile"
      @close="planning.closeAdjustment"
      @submit="planning.submitAdjustment"
    />
    <!-- 第一步也展示同一条完整反馈，不必先进入结果步骤。 -->
    <template v-if="planning.step === 1"
      ><PlanningApiFeedback
        :feedback="planning.feedback"
        :pending="!!planning.pending"
        @reconcile="planning.reconcile" /><PlanningApiFeedback :feedback="planning.queryFeedback"
    /></template>
    <AppDrawer
      :visible="!!cluster"
      title="重叠节点成员"
      subtitle="按接口返回的成员分页浏览。"
      @update:visible="!$event && (cluster = null)"
      ><div
        v-for="node in members?.items"
        :key="node.id"
        class="member"
        ><span>{{ node.name }} · {{ node.id }}</span
        ><button
          class="btn small"
          :disabled="!task.editable || !!task.draft?.stationIds.includes(node.id)"
          @click="addNode(node.id)"
          >加入任务</button
        ></div
      ><p
        class="notice warn"
        v-if="resources.errors['planning-cluster']"
        >{{ resources.errors['planning-cluster'] }}</p
      ><div class="toolbar"
        ><button
          class="btn"
          :disabled="!members || members.page <= 1"
          @click="clusterPage(members!.page - 1)"
          >上页</button
        ><span>{{ members?.total ?? 0 }} 项</span
        ><button
          class="btn"
          :disabled="!members || members.page * 10 >= members.total"
          @click="clusterPage(members!.page + 1)"
          >下页</button
        ></div
      ></AppDrawer
    >
    <DecisionDialog
      :request="task.decision"
      @answer="task.answer"
    />
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import DeploymentConstraintsSummary from '../components/DeploymentConstraintsSummary.vue';
import PlanningOptionsSummary from '../components/PlanningOptionsSummary.vue';
import PlanningSolutionsPanel from '../components/PlanningSolutionsPanel.vue';
import { useRoute, useRouter } from 'vue-router';
import { useTaskInputStore } from '../stores/task-input';
import { usePlanningApiStore } from '../stores/planning-api';
import { useResourceReadStore } from '../stores/resource-read';
import { useAuthStore } from '../stores/auth';
import { usePlanningCandidates } from '../composables/usePlanningCandidates';
import {
  resolveFrequencyFocus,
  type FrequencySelection,
} from '../services/planning-result-details-display';
import { useTaskPlanningLeaveGuard } from '../composables/useTaskPlanningLeaveGuard';
import { safeReturnPath } from '../config/permissions';
import type { Bounds, ReadNode, ResourceMapCluster, ResourcePage } from '../types/resource-read';
import type { PlanningMapOverlay } from '../maps/planning-api-layers';
import type { CoverageDisplay } from '../types/coverage';
import TaskApiPanel from '../components/TaskApiPanel.vue';
import PlanningApiProgressPanel from '../components/PlanningApiProgressPanel.vue';
import PlanningApiFeedback from '../components/PlanningApiFeedback.vue';
import PlanningApiResultPanel from '../components/PlanningApiResultPanel.vue';
import PlanningApiVersionsPanel from '../components/PlanningApiVersionsPanel.vue';
import PlanningAdjustmentDrawer from '../components/PlanningAdjustmentDrawer.vue';
import PlanningAdjustmentPreview from '../components/PlanningAdjustmentPreview.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import ResourceReadStatus from '../components/ResourceReadStatus.vue';
import MapCanvas from '../components/MapCanvas.vue';
import AppDrawer from '../components/AppDrawer.vue';

const task = useTaskInputStore();
const planning = usePlanningApiStore();
const resources = useResourceReadStore();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
useTaskPlanningLeaveGuard();
const map = ref<InstanceType<typeof MapCanvas>>();
const focused = ref('');
const focusedLink = ref('');
const nodeHighlights = ref<string[]>([]);
const linkHighlights = ref<string[]>([]);
const showCoverage = ref(false);
// 显示偏好只在本页面实例保留，不参与规划输入、保存或接口请求。
const coverageDisplay = ref<CoverageDisplay>('auto');
const cluster = ref<ResourceMapCluster | null>(null);
const members = ref<ResourcePage<ReadNode> | null>(null);
// 忙碌状态与编辑权限分别表达，保持原有判断的短路顺序。
const adjustmentBusy = computed(() => planning.busy || planning.running || !!planning.pending);
const adjustmentDisabled = computed(
  () => !auth.can('planning.execute') || !task.readable || adjustmentBusy.value,
);
// 结果身份包含所属任务、版本和快照，避免复用节点 ID 时沿用旧定位。
const resultOwner = computed(() =>
  !planning.result
    ? ''
    : JSON.stringify([
        task.taskId,
        ...(planning.selectedPlan
          ? ['plan', planning.selectedPlan.id, planning.selectedPlan.version]
          : ['job', planning.job?.id]),
        planning.result.snapshotId,
      ]),
);
const resultActive = computed(() => planning.step !== 1 && auth.can('planning.view'));
// HTTP 草稿、作业与方案只使用各自保存的输入。
const deploymentFrame = computed(() => ({
  owner: JSON.stringify([auth.generation, task.taskId, planning.step, resultOwner.value]),
  label: planning.step === 1 ? '任务草稿' : '冻结输入',
  constraints: (planning.step === 1
    ? task.draft
    : planning.selectedPlan
      ? planning.selectedPlan.input
      : planning.job?.input
  )?.deploymentConstraints,
}));
// 候选层只接当前结果，不查询或合并独立候选CSV。
const candidateTab = ref(true);
const candidates = usePlanningCandidates({
  screening: () => planning.result?.resultDetails?.candidateScreening,
  owner: () => resultOwner.value,
  active: () => planning.step === 2 && candidateTab.value,
  readable: () => auth.can('planning.view'),
  generation: () => auth.generation,
  locate: (coordinate) => map.value?.locateResource(coordinate),
});
function clearResultFocus() {
  focused.value = '';
  focusedLink.value = '';
  nodeHighlights.value = [];
  linkHighlights.value = [];
}
watch([resultOwner, resultActive, () => auth.generation], clearResultFocus, { flush: 'sync' });
// 内部同步定位参数不再次恢复作业，避免覆盖刚进入的调整草稿。
// 存活标志、恢复/同步标志及请求票据共同阻止迟到的路由操作回写。
let active = false;
let restoring = false;
let syncing = false;
let routeTicket = 0;
// 地图视口变化延迟读取，计时器在页面卸载时清理。
let viewportTimer: ReturnType<typeof setTimeout> | undefined;
const overlay = computed<PlanningMapOverlay>(() => {
  if (planning.step === 1)
    return {
      nodes: task.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        coordinate: n.coordinate,
        status: n.status,
        alert: n.alert,
      })),
      demands: task.draft?.demands ?? [],
    };
  // 已过期结果保持空图，不能用正在编辑的任务节点冒充冻结网络。
  if (!planning.result) return { nodes: [], links: [] };
  const result = planning.result;
  return {
    nodes: result.nodes.map((n) => ({
      ...n,
      coordinate:
        result.configuration.deployment.find((d) => d.stationId === n.id)?.plannedCoordinate ??
        n.coordinate,
    })),
    links: result.links,
    coverage: result.coverage,
    snapshotId: result.snapshotId,
  };
});
const bounds = computed<Bounds | undefined>(() => {
  if (planning.step === 1 && resources.workspace) return resources.workspace.bounds;
  const points = overlay.value.nodes.map((n) => n.coordinate);
  if (!points.length) return resources.workspace?.bounds;
  return [
    Math.min(...points.map((p) => p[0])) - 0.02,
    Math.min(...points.map((p) => p[1])) - 0.02,
    Math.max(...points.map((p) => p[0])) + 0.02,
    Math.max(...points.map((p) => p[1])) + 0.02,
  ];
});
function viewport(bbox: Bounds, zoom: number) {
  if (planning.step !== 1) return;
  resources.setViewport(bbox, zoom);
  clearTimeout(viewportTimer);
  resources.cancelGroup('map');
  viewportTimer = setTimeout(() => {
    if (active && planning.step === 1) void resources.loadMap();
  }, 250);
}
function focusNode(id: string) {
  focused.value = id;
  const point =
    overlay.value.nodes.find((n) => n.id === id)?.coordinate ??
    resources.frame?.points.find((n) => n.kind === 'node' && n.id === id)?.coordinate;
  if (point) map.value?.locateResource(point);
}
function focusLink(id: string) {
  focusedLink.value = id;
  const link = overlay.value.links?.find((l) => l.id === id);
  if (link) focusNode(link.a);
}
function highlight(nodes: string[], links: string[]) {
  nodeHighlights.value = nodes;
  linkHighlights.value = links;
}
function frequencySelection(owner: string, selection: FrequencySelection | null) {
  if (owner !== resultOwner.value || !resultActive.value || !planning.result) return;
  clearResultFocus();
  if (!selection) return;
  const focus = resolveFrequencyFocus(planning.result, selection);
  if (focus.state === 'ready') highlight(focus.stationIds, focus.linkIds);
}
async function clusterPage(page = 1) {
  const id = cluster.value?.id;
  if (!id) return;
  const value = await resources.fetchNodes(
    { clusterId: id, page, pageSize: 10, sort: 'id' },
    'planning-cluster',
  );
  if (value && cluster.value?.id === id) members.value = value;
}
function chooseCluster(value: ResourceMapCluster) {
  if (value.expansionZoom !== null) map.value?.expandResource(value);
  else {
    cluster.value = value;
    void clusterPage();
  }
}
function addNode(id: string) {
  if (!task.draft || !task.editable || task.draft.stationIds.includes(id)) return;
  const next = structuredClone(toRaw(task.draft));
  next.stationIds.push(id);
  task.updateInput(next);
  void task.refreshReferences(false);
}
async function syncUrl() {
  if (!active || restoring || !task.saved) return;
  const query: Record<string, string> = { taskId: task.taskId };
  if (planning.selectedPlan) query.planId = planning.selectedPlan.id;
  else if (planning.job) query.jobId = planning.job.id;
  if (JSON.stringify(route.query) !== JSON.stringify(query)) {
    syncing = true;
    try {
      await router.replace({ path: '/planning', query });
    } finally {
      syncing = false;
    }
  }
}
async function restoreRoute() {
  if (!active) return;
  const token = ++routeTicket;
  restoring = true;
  try {
    if (!safeReturnPath(route.fullPath)) {
      planning.localError('任务或方案定位参数无效', 'route');
      return;
    }
    const taskId = typeof route.query.taskId === 'string' ? route.query.taskId : null,
      jobId = typeof route.query.jobId === 'string' ? route.query.jobId : null,
      planId = typeof route.query.planId === 'string' ? route.query.planId : null;
    if (taskId && task.taskId !== taskId && !(await task.open(taskId))) return;
    if (!active || token !== routeTicket) return;
    if (task.saved) await planning.loadPlans(1);
    if (planId) await planning.selectPlan(planId);
    else if (jobId || task.saved?.activeJobId) {
      planning.step = 2;
      await planning.refreshJob(jobId ?? task.saved!.activeJobId!);
    }
    if (active && token === routeTicket) planning.start();
  } finally {
    if (token === routeTicket) restoring = false;
  }
}
async function opened() {
  await planning.loadPlans(1);
  if (task.saved?.activeJobId) await planning.refreshJob(task.saved.activeJobId);
  planning.start();
  void syncUrl();
}
onMounted(async () => {
  active = true;
  await resources.activate('planning');
  if (!active) return;
  await task.initialize('planning');
  if (active) await restoreRoute();
});
watch(
  () => route.fullPath,
  () => {
    if (active && !restoring && !syncing) void restoreRoute();
  },
);
watch(
  () => [task.saved?.taskId, planning.job?.id, planning.selectedPlan?.id],
  () => {
    void syncUrl();
  },
);
watch(
  () => planning.step,
  (value) => {
    if (value === 1 && active) void resources.loadMap();
  },
);
onBeforeUnmount(() => {
  active = false;
  routeTicket++;
  clearTimeout(viewportTimer);
  resources.stop();
});
</script>
<style scoped>
.planning-api-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.steps {
  display: flex;
  gap: 12px;
}
.steps button {
  flex: 1;
  background: #14273b;
  border: 1px solid var(--line);
  color: var(--muted);
  padding: 13px;
}
.steps .active {
  color: #9edaff;
  border-color: #429ac9;
}
.planning-layout {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(480px, 1fr);
  gap: 16px;
  align-items: start;
}
.planning-layout.input {
  grid-template-columns: 410px minmax(400px, 1fr);
}
.input-panel {
  max-height: calc(100vh - 310px);
  min-height: 480px;
  overflow: auto;
}
.submit {
  width: 100%;
  margin-top: 12px;
}
.map-panel {
  height: 630px;
  position: relative;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
}
.result-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 800px;
  overflow: auto;
}
.map-selection {
  position: absolute;
  bottom: 80px;
  left: 16px;
  background: #102034ee;
  padding: 10px;
  display: flex;
  gap: 10px;
  font-size: 12px;
}
.member {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid var(--line);
}
@media (max-width: 1250px) {
  .planning-layout,
  .planning-layout.input {
    grid-template-columns: 360px minmax(360px, 1fr);
  }
}
@media (max-width: 950px) {
  .planning-layout,
  .planning-layout.input {
    grid-template-columns: 1fr;
  }
  .input-panel {
    max-height: none;
  }
  .map-panel {
    height: 480px;
  }
}
</style>
