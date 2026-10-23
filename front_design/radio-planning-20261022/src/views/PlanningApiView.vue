<template>
  <div class="page planning-api-page"
    ><div class="page-heading"
      ><h1>网络规划</h1
      ><div class="toolbar">
        <!-- 刷新只更新资源读取，保持原来仅在任务输入步骤提供的范围。 -->
        <button
          v-if="planning.step === 1"
          class="btn"
          :disabled="!resources.readable || resources.refreshing"
          @click="resources.refresh()"
          >{{ resources.refreshing ? '正在刷新' : '刷新资源' }}</button
        >
        <button
          class="btn"
          :disabled="planning.busy || !!planning.pending || !task.readable"
          @click="openHistory"
          >规划历史</button
        >
        <button
          v-if="auth.can('planning.reset')"
          class="btn"
          disabled
          title="当前 HTTP 环境不提供重置规划草稿能力；后台任务、作业、方案与回执历史均保留"
          aria-label="重置规划草稿不可用，后台历史保留"
          >重置规划草稿</button
        >
      </div></div
    >
    <p
      v-if="routeTaskError"
      class="notice warn"
      role="alert"
      >{{ routeTaskError }}</p
    >
    <div v-if="route.query.editTask === '1'" class="toolbar" aria-label="GIS任务编辑返回">
      <button class="btn primary" :disabled="gisTaskReturning || !task.editable || task.busy || !!task.pendingSave" @click="saveAndReturnToGis"><i class="pi pi-save" aria-hidden="true" />保存任务并返回 GIS</button>
      <button class="btn" :disabled="gisTaskReturning || !task.saved" @click="returnToGis"><i class="pi pi-arrow-left" aria-hidden="true" />返回 GIS 任务</button>
      <span v-if="gisTaskReturnError" role="alert">{{ gisTaskReturnError }}</span>
    </div>
    <div
      v-if="route.query.from === 'diagnosis' && !routeTaskError"
      class="notice"
      role="status"
    >
      诊断准备：保存任务 → 提交规划 → 保存方案 → 转正 → 返回诊断。
      <button
        v-if="auth.can('diagnosis.view')"
        class="text-link"
        :disabled="diagnosisReturning"
        @click="returnToDiagnosis"
        >返回故障诊断</button
      >
    </div>
    <div class="steps"
      ><button
        v-for="(label, i) in ['任务与约束输入', '规划计算与结果', '方案调整与对比']"
        :key="label"
        :class="{ active: planning.step === i + 1 }"
        @click="planning.step = i + 1"
        >{{ i + 1 }} · {{ label }}</button
      ></div
    >
    <ResourceReadStatus
      :refresh-hint="
        planning.step === 1 ? undefined : '请返回“任务与约束输入”刷新资源；当前规划结果保持原快照。'
      "
    />
    <p v-if="terrainMessage" class="notice warn" role="status">{{ terrainMessage }} 站点和链路仍可浏览。</p>
    <details
      v-if="planning.step !== 1 && planning.job?.solutions"
      class="solution-choices"
      ><summary
        >当前选择：{{ currentObjectLabel }} ·
        {{ planning.job.solutions.length }} 份结果可查看</summary
      ><PlanningSolutionsPanel
        :solutions="planning.job.solutions"
        :selected="planning.selectedPlan ? '' : planning.selectedSolutionId"
        :requested="planning.job.input.deploymentSolve?.solutionCount"
        :owner="JSON.stringify([auth.generation, task.taskId, planning.job.id, resultOwner])"
        :disabled="
          planning.busy || !!planning.pending || planning.adjustmentDirty || !task.readable
        "
        @select="planning.selectSolution"
    /></details>
    <div
      class="planning-layout"
      :class="{ input: planning.step === 1, collapsed: planning.step !== 1 && resultCollapsed }"
      ><div
        v-show="planning.step === 1"
        class="input-panel"
        ><TaskApiPanel @opened="opened"
          ><template #actions
            ><button
              class="btn primary submit"
              :disabled="!planning.canSubmit"
              @click="planning.submit"
              >提交规划</button
            ></template
          ><template #submit-hint
            ><span
              class="submit-hint"
              v-if="!planning.canSubmit"
              >{{ submitHint }}</span
            ></template
          ><template #feedback>
            <PlanningApiFeedback
              v-if="planning.step === 1"
              :feedback="planning.feedback"
              :pending="!!planning.pending"
              @reconcile="planning.reconcile"
            />
            <PlanningApiFeedback
              v-if="planning.step === 1"
              :feedback="planning.queryFeedback"
            /> </template></TaskApiPanel
      ></div>
      <section class="map-panel"
        ><MapCanvas
          :deployment-constraints="deploymentFrame"
          v-if="bounds"
          ref="map"
          :planning-candidates="candidates.frame.value"
          @select-planning-candidate="candidates.selectMap"
          :stations="[]"
          resource-read
          :terrain-basemap="terrainBasemap"
          :show-roads="false"
          :resource-frame="planning.step === 1 ? resources.frame : null"
          :resource-bounds="bounds"
          :planning-overlay="overlay"
          :show-coverage="planning.step === 3 && !!planning.adjustmentParent ? true : showCoverage"
          :coverage-display="coverageDisplay"
          :selected-id="planning.step === 1 ? inputFocused : focused"
          :frozen-coverage="frozenCoverageForMap"
          :selected-link-id="planning.step === 1 ? '' : focusedLink"
          :highlight-station-ids="planning.step === 1 ? [] : nodeHighlights"
          :highlight-link-ids="planning.step === 1 ? [] : linkHighlights"
          @viewport="viewport"
          @select="mapHandlers.node"
          @select-link="mapHandlers.link"
          @select-resource="mapHandlers.resource"
          @select-cluster="chooseCluster"
        />
        <p
          v-else
          class="empty-inline"
          >任务引用或结果加载后显示地图。</p
        ><div
          v-if="planning.step === 1 && inputFocused"
          class="map-selection"
          ><span>{{ focused }}</span
          ><button
            class="btn small"
            :disabled="!task.editable || !!task.draft?.stationIds.includes(inputFocused)"
            @click="addNode(inputFocused)"
            >{{
              task.draft?.stationIds.includes(inputFocused) ? '已加入任务' : '加入任务节点'
            }}</button
          ></div
        >
        <p
          v-if="planning.step === 1 && resources.errors.map"
          class="notice warn"
          >{{ resources.errors.map
          }}<button
            class="text-link"
              @click="resources.loadMap()"
            >重试</button
          ></p
        >
        <div
          v-if="planning.step !== 1"
          class="map-tools"
          ><button
            class="btn small"
            @click="resultCollapsed = !resultCollapsed"
            >{{ resultCollapsed ? '展开结果面板' : '收起结果面板' }}</button
          ><template v-if="previewMode"
            ><button
              class="btn small"
              :class="{ primary: previewSide === 'before' }"
              @click="previewSide = 'before'"
              >调整前</button
            ><button
              class="btn small"
              :class="{ primary: previewSide === 'after' }"
              :disabled="!planning.adjustmentResult"
              @click="previewSide = 'after'"
              >调整后</button
            ><span>{{
              planning.adjustmentResult ? '预览已更新' : '当前输入暂无新结果 · 显示父方案'
            }}</span></template
          ></div
        >
      </section>
      <div
        v-show="planning.step !== 1 && !resultCollapsed"
        class="result-column"
        :class="{ 'results-column': planning.step === 2 }"
      >
        <div
          class="workflow-summary"
          role="status"
        >
          <strong>{{
            planning.step === 2
              ? currentObjectLabel
              : editingAdjustment
                ? '调整方案'
                : planning.selectedPlan
                  ? '选用已保存的方案'
                  : '保存规划结果'
          }}</strong>
          <p>{{ workflowHint }}</p>
          <p
            v-if="planning.sourceChanged"
            class="warn"
            >来源已变化，当前结果仅供历史参考。</p
          >
          <p
            v-if="planning.selectedPlan?.state === 'REFERENCE'"
            class="warn"
            >此版本仅供参考，不能设为当前方案。</p
          >
        </div>
        <div
          class="result-content"
          :class="{ 'adjustment-content': planning.step === 3 }"
        >
          <PlanningApiProgressPanel
            v-if="
              !planning.selectedPlan ||
              planning.feedback ||
              planning.queryFeedback ||
              planning.pending
            "
            compact
            :show-job="!planning.selectedPlan"
          />
          <PlanningApiResultPanel
            v-show="planning.step === 2"
            ref="resultPanel"
            v-model:coverage-display="coverageDisplay"
            :candidates="candidates.view.value"
            @candidate-active="candidateTab = $event"
            :result="planning.result"
            :radio-count="resultRadioCount"
            :confirmed-configuration="planning.selectedPlan?.confirmedConfiguration"
            :owner-key="resultOwner"
            :active="resultActive"
            :historical="planning.sourceChanged"
            @focus="resultFocus"
            @coverage="showCoverage = $event"
          />
          <FrozenCoveragePanel v-if="planning.step !== 1 && frozenCoverageQuery" :query="frozenCoverageQuery"
            :services="collaborationHttp.frozenCoverage" @overlay="frozenCoverage=$event" />
          <PlanningAdjustmentDrawer
            v-if="
              planning.adjustmentContext && planning.adjustmentDraft && planning.adjustmentParent
            "
            v-show="planning.step === 3 && editingAdjustment"
            :visible="editingAdjustment"
            :parent="planning.adjustmentContext"
            :parent-label="`${planning.adjustmentParent.name} · ${planning.adjustmentParent.version}`"
            :model-value="planning.adjustmentDraft"
            :examples="task.adjustmentExamples"
            :disabled="adjustmentDisabled"
            :busy="adjustmentBusy"
            :error="planning.error"
            :issues="planning.adjustmentIssues"
            @update:model-value="planning.updateAdjustment"
            :pending="!!planning.pending"
            @reconcile="planning.reconcile"
            @close="planning.closeAdjustment"
            @submit="planning.submitAdjustment"
          />
          <PlanningAdjustmentPreview
            v-if="planning.step === 3 && editingAdjustment && planning.adjustmentParent"
            :before="planning.adjustmentParent"
            :after="planning.adjustmentResult"
            :status="planning.adjustmentStatus"
          />
          <PlanningApiVersionsPanel
            v-show="planning.step === 3"
            :adjusting="editingAdjustment"
            @view-configuration="
              (planId) =>
                planning.selectedPlan?.id === planId && resultPanel?.openConfiguration(resultOwner)
            "
            @view-confirmed-configuration="
              (planId) =>
                planning.selectedPlan?.id === planId &&
                resultPanel?.openConfiguration(resultOwner, 'confirmed')
            "
          />
          <button
            v-if="
              planning.step === 3 && hasAdjustmentWork && !editingAdjustment && !adjustmentSaved
            "
            class="btn"
            :disabled="planning.busy || !!planning.pending"
            @click="planning.adjustmentOpen = true"
            >继续编辑调整</button
          >
          <details
            v-if="
              planning.step === 3 &&
              !editingAdjustment &&
              planning.adjustmentParent &&
              hasAdjustmentWork
            "
            class="result-details"
            @toggle="previewReviewOpen = ($event.target as HTMLDetailsElement).open"
          >
            <summary>回看本次调整变化</summary>
            <PlanningAdjustmentPreview
              :before="planning.adjustmentParent"
              :after="planning.adjustmentResult"
              :status="
                adjustmentSaved
                  ? '本次调整已保存为方案版本，可回看前后变化。'
                  : planning.adjustmentStatus
              "
            />
          </details>
          <details class="result-details"
            ><summary>查看当前结果的输入条件</summary>
            <DeploymentConstraintsSummary
              v-if="planning.step !== 1"
              :value="deploymentFrame.constraints"
              label="当前结果的冻结部署筛选条件"
            />
            <PlanningOptionsSummary
              v-if="planning.step !== 1"
              :input="planning.selectedPlan?.input ?? planning.job?.input"
            />
          </details>
        </div>
        <div class="analysis-entry">
          <button
            class="btn small"
            :disabled="!!analysisEntryReason || analysisEntryBusy"
            :onClick="analysisEntry.open"
            >{{ analysisEntryBusy ? '正在核对分析方案…' : '进入干扰分析' }}</button
          >
          <p
            v-if="analysisEntryError || analysisEntryReason"
            :role="analysisEntryError ? 'alert' : 'status'"
            >{{ analysisEntryError || analysisEntryReason }}</p
          >
        </div>
        <div class="step-actions"
          ><button
            class="btn small"
            @click="planning.step = planning.step === 3 ? 2 : 1"
            >{{ planning.step === 3 ? '返回规划结果' : '返回任务输入' }}</button
          >
          <button
            v-if="planning.step === 2"
            class="btn primary small"
            @click="planning.step = 3"
            >下一步：保存或调整方案</button
          >
        </div>
      </div>
    </div>
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
          :disabled="!members || members.pageNum <= 1"
          @click="clusterPage(members!.pageNum - 1)"
          >上页</button
        ><span>{{ members?.total ?? 0 }} 项</span
        ><button
          class="btn"
          :disabled="!members || members.pageNum * 10 >= members.total"
          @click="clusterPage(members!.pageNum + 1)"
          >下页</button
        ></div
      ></AppDrawer
    >
    <DecisionDialog
      :request="task.decision"
      @answer="task.answer"
    />
    <PlanningHistoryDrawer
      v-model:visible="historyVisible"
      :initial-tab="historyInitialTab"
      :open-error="historyOpenError"
      :disabled="
        historyOpening ||
        planning.busy ||
        planning.running ||
        !!planning.pending ||
        !!task.pendingSave ||
        !task.readable
      "
      @open-job="openHistoricalJob"
      @open-plan="openHistoricalPlan"
    />
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, watch } from 'vue';
import { useTerrainBasemap } from '../composables/useTerrainBasemap';
import DeploymentConstraintsSummary from '../components/DeploymentConstraintsSummary.vue';
import PlanningOptionsSummary from '../components/PlanningOptionsSummary.vue';
import PlanningSolutionsPanel from '../components/PlanningSolutionsPanel.vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { useTaskInputStore } from '../stores/task-input';
import { usePlanningApiStore } from '../stores/planning-api';
import { useResourceReadStore } from '../stores/resource-read';
import { useAuthStore } from '../stores/auth';
import { usePlanningCandidates } from '../composables/usePlanningCandidates';
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
import PlanningHistoryDrawer from '../components/PlanningHistoryDrawer.vue';
import type { PlanningJobSummary, PlanningPlanSummary } from '../types/planning-api';
import { previewService } from '../services';
import { collaborationHttp } from '../services/http';
import FrozenCoveragePanel from '../components/FrozenCoveragePanel.vue';
import type { FrozenCoverageOverlay,FrozenCoverageQuery } from '../types/frozen-coverage';
import { verifyPlanningInterferenceEntry } from '../services/planning-interference-entry';
import { saveTaskForGis } from '../services/gis-task-edit-entry';

const task = useTaskInputStore();
const planning = usePlanningApiStore();
const resources = useResourceReadStore();
const { basemap: terrainBasemap, message: terrainMessage } = useTerrainBasemap(() => resources.workspace?.terrain, {
  enabled: () => !!resources.workspace,
});
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const frozenCoverage=shallowRef<FrozenCoverageOverlay|null>(null);
const frozenCoverageQuery=computed<FrozenCoverageQuery|null>(()=>{
  const plan=planning.selectedPlan;
  return plan?.resourceRevision?{planId:plan.id,taskId:plan.taskId,snapshotId:plan.result.snapshotId,resourceRevision:plan.resourceRevision,context:'planning'}:null;
});
const frozenCoverageForMap=computed(()=>{
  const query=frozenCoverageQuery.value,value=frozenCoverage.value;
  return planning.step!==1&&query&&value&&value.anchor.plan_id===query.planId&&value.anchor.snapshot_id===query.snapshotId?value:null;
});
const routeTaskError = ref('');
const historyVisible = ref(false);
const historyInitialTab = ref<'saved' | undefined>();
const historyOpening = ref(false);
const historyOpenError = ref('');
let historyOpenController: AbortController | undefined;
const diagnosisReturning = ref(false);
// 原离页守卫完成保存期间不抢占导航；取消或失败后恢复内部身份同步。
async function returnToDiagnosis() {
  if (diagnosisReturning.value || !auth.can('diagnosis.view')) return;
  diagnosisReturning.value = true;
  try {
    await router.push('/diagnosis');
  } finally {
    diagnosisReturning.value = false;
    if (route.path === '/planning') void syncUrl();
  }
}
// 固定用途只负责打开历史；不替换当前任务或自动选择参考方案。
function openHistory() {
  historyInitialTab.value = undefined;
  historyVisible.value = true;
}
watch(historyVisible, async (visible) => {
  if (visible) historyOpenError.value = '';
  if (!visible) historyOpenController?.abort();
  if (visible || !['references', 'saved'].includes(String(route.query.history))) return;
  const target = '/planning';
  syncTargets.add(target);
  try {
    await router.replace(target);
  } finally {
    syncTargets.delete(target);
  }
});
const analysisEntryBusy = ref(false),
  analysisEntryError = ref('');
let analysisEntrySerial = 0,
  analysisEntryAbort: AbortController | undefined;
let analysisNavigation: { path: string; current: () => boolean } | null = null;
const analysisEntryReason = computed(() =>
  auth.blocked || !auth.can('situation.view') || !auth.can('planning.view')
    ? '当前角色没有干扰分析查看权限'
    : !planning.selectedPlan
      ? '请先保存并选择已确认方案'
      : planning.selectedPlan.state !== 'CONFIRMED'
        ? '请先确认所选方案，再进入干扰分析'
        : planning.busy || planning.pending
          ? '请先完成当前规划操作'
          : '',
);
const analysisEntryOwner = computed(() =>
  JSON.stringify([
    auth.generation,
    auth.blocked,
    task.taskId,
    planning.selectedPlan?.id,
    planning.selectedPlan?.version,
    planning.selectedPlan?.state,
    planning.step,
  ]),
);
function cancelAnalysisEntry() {
  analysisEntrySerial++;
  analysisEntryAbort?.abort();
  analysisEntryBusy.value = false;
  analysisEntryError.value = '';
}
watch(analysisEntryOwner, cancelAnalysisEntry, { flush: 'sync' });
// 按渲染时的方案捕获入口；旧按钮和异步资格响应不能把用户带往另一方案。
const analysisEntry = computed(() => {
  const owner = analysisEntryOwner.value,
    target = planning.selectedPlan;
  return {
    open: async () => {
      if (
        !active ||
        owner !== analysisEntryOwner.value ||
        analysisEntryReason.value ||
        analysisEntryBusy.value ||
        !target
      )
        return;
      const serial = ++analysisEntrySerial;
      const current = () =>
        active &&
        route.path === '/planning' &&
        owner === analysisEntryOwner.value &&
        serial === analysisEntrySerial &&
        !analysisEntryReason.value;
      analysisEntryAbort?.abort();
      analysisEntryAbort = new AbortController();
      const signal = analysisEntryAbort.signal;
      analysisEntryBusy.value = true;
      analysisEntryError.value = '';
      try {
        if (!await verifyPlanningInterferenceEntry(collaborationHttp.interferenceWorkbench, { taskId: target.taskId, planId: target.id, planVersion: target.version }, signal) || !current()) return;
        const path = router.resolve({
          path: '/situation',
          query: { analysisTaskId: target.taskId, analysisPlanId: target.id },
        }).fullPath;
        const navigation = { path, current };
        analysisNavigation = navigation;
        try {
          await router.push(path);
        } finally {
          if (analysisNavigation === navigation) analysisNavigation = null;
        }
      } catch (reason) {
        if (current())
          analysisEntryError.value =
            reason instanceof Error ? reason.message : '分析入口读取失败，请重试';
      } finally {
        if (serial === analysisEntrySerial) analysisEntryBusy.value = false;
      }
    },
  };
});
const resultCollapsed = ref(false),
  previewSide = ref<'before' | 'after'>('after');
// 界面阶段只描述当前对象；不创建第二套保存状态或改变服务端确认条件。
const adjustmentSaved = computed(
  () =>
    !!planning.adjustmentParent &&
    !!planning.selectedPlan?.adjustment &&
    planning.selectedPlan.adjustment.sourcePlanId === planning.adjustmentParent.id &&
    planning.selectedPlan.result.snapshotId === planning.adjustmentResult?.snapshotId &&
    !planning.adjustmentDirty,
);
const editingAdjustment = computed(() => planning.adjustmentOpen && !adjustmentSaved.value);
const previewReviewOpen = ref(false);
const hasAdjustmentWork = computed(
  () =>
    !!planning.adjustmentParent &&
    (!!planning.adjustmentDraft?.manualOverrides.length ||
      !!planning.adjustmentDraft?.manualPaths.length ||
      (!!planning.job?.adjustment && planning.job.parentPlanId === planning.adjustmentParent.id)),
);
const previewMode = computed(
  () =>
    planning.step === 3 &&
    !!planning.adjustmentParent &&
    (editingAdjustment.value ||
      previewReviewOpen.value ||
      (!planning.selectedPlan && hasAdjustmentWork.value)),
);
watch(
  () => [planning.step, planning.adjustmentParent?.id],
  () => {
    previewReviewOpen.value = false;
  },
);
watch(adjustmentSaved, (saved) => {
  if (saved) previewSide.value = 'after';
});
const currentObjectLabel = computed(() =>
  planning.selectedPlan
    ? `${planning.selectedPlan.name} · ${planning.selectedPlan.version}`
    : (planning.currentSolution?.label ?? planning.job?.input.name ?? '尚无规划结果'),
);
// 数量只属于当前显示对象；已保存方案缺失时不借用作业或父方案数量。
const resultRadioCount = computed(() =>
  planning.selectedPlan
    ? (planning.selectedPlan.radioCount ?? null)
    : (planning.currentSolution?.radioCount ?? null),
);
const workflowHint = computed(() =>
  planning.step === 2
    ? planning.result
      ? '先查看约束结论和三项指标，再按需查看分项；满意后进入下一步保存或调整。'
      : '等待规划结果；可查看阶段进度，异常时按提示恢复。'
    : editingAdjustment.value
      ? planning.adjustmentStatus
      : planning.sourceChanged
        ? '来源已变化，当前内容仅供回看；如需新方案，请返回任务输入核对条件后重新规划。'
        : planning.selectedPlan?.state === 'REFERENCE'
          ? '此版本仅供参考和比较，不能设为当前方案。'
          : planning.selectedPlan?.current
            ? '此版本已是当前方案。可返回查看结果，或按需调整；无需重复确认。'
            : planning.selectedPlan
              ? '已保存版本。可直接设为当前方案，或先调整参数；历史与对比按需查看。'
              : '先把所选结果保存为方案。保存后可直接选用，也可继续调整。',
);
watch(
  () => [adjustmentSaved.value, planning.busy, planning.pending, planning.adjustmentOpen] as const,
  ([saved, busy, pending, open]) => {
    if (saved && !busy && !pending && open) void planning.closeAdjustment();
  },
);
// 只解释既有提交条件，保存和执行仍沿用状态层的权限与版本保护。
const submitHint = computed(() =>
  !auth.can('planning.execute')
    ? '当前账号没有规划执行权限'
    : task.pendingSave || planning.pending
      ? '请先核实待确认的操作结果'
      : planning.busy || planning.running
        ? '请等待当前作业或操作完成'
        : planning.adjustmentOpen || planning.adjustmentDirty
          ? '请先处理方案调整输入'
          : !task.saved || task.dirty
            ? '请先保存任务与当前修改'
            : '请完善输入并等待当前操作完成',
);
watch(
  () =>
    [
      planning.step,
      task.taskId,
      auth.generation,
      auth.can('planning.execute'),
      task.readable,
    ] as const,
  () =>
    planning.setAutomaticPreview(
      planning.step === 3 && task.readable && auth.can('planning.execute'),
    ),
  { immediate: true },
);
watch(
  () => planning.adjustmentResult,
  (value) => {
    if (value) previewSide.value = 'after';
  },
);
async function openHistoricalJob(value: PlanningJobSummary) {
  if (await planning.openHistoricalJob(value.taskId, value.id)) {
    historyVisible.value = false;
    void syncUrl();
  }
}
async function openHistoricalPlan(value: PlanningPlanSummary) {
  historyOpenController?.abort();
  const controller = new AbortController(); historyOpenController = controller;
  historyOpening.value = true;
  historyOpenError.value = '';
  try {
    if (await planning.openHistoricalPlan(value.taskId, value.id, controller.signal)) {
      historyVisible.value = false;
      void syncUrl();
    } else if (!controller.signal.aborted) historyOpenError.value = planning.error || task.error || '未切换方案，当前输入和结果已保留。';
  } finally {
    if (historyOpenController === controller) { historyOpenController = undefined; historyOpening.value = false; }
  }
}
useTaskPlanningLeaveGuard();
// 原保存/放弃决定完成后再次核对目标；取消或保存失败仍由原守卫保留现场。
onBeforeRouteLeave((to) => {
  if (analysisNavigation?.path === to.fullPath) return analysisNavigation.current();
  cancelAnalysisEntry();
  return true;
});
const map = ref<InstanceType<typeof MapCanvas>>();
const focused = ref(''),
  inputFocused = ref('');
const resultPanel = ref<InstanceType<typeof PlanningApiResultPanel>>();
const selectionEpoch = ref(0);
const focusedLink = ref('');
const nodeHighlights = ref<string[]>([]);
const linkHighlights = ref<string[]>([]);
const showCoverage = ref(false);
// 显示偏好只在本页面实例保留，不参与规划输入、保存或接口请求。
const coverageDisplay = ref<CoverageDisplay>('auto');
const cluster = ref<ResourceMapCluster | null>(null);
const members = ref<ResourcePage<ReadNode> | null>(null);
// 忙碌状态与编辑权限分别表达，保持原有判断的短路顺序。
const adjustmentBusy = computed(() => planning.adjustmentLocked);
const adjustmentDisabled = computed(
  () => !auth.can('planning.execute') || !task.readable || adjustmentBusy.value,
);
// 结果身份包含所属任务、版本和快照，避免复用节点 ID 时沿用旧定位。
const resultOwner = computed(() =>
  !planning.result
    ? ''
    : JSON.stringify([
        auth.generation,
        task.taskId,
        ...(planning.selectedPlan
          ? ['plan', planning.selectedPlan.id, planning.selectedPlan.version]
          : ['job', planning.job?.id, planning.selectedSolutionId]),
        planning.result.snapshotId,
      ]),
);
const resultActive = computed(() => planning.step !== 1 && auth.can('planning.view'));
// 草稿、作业与方案只使用各自保存的输入，与数据来源无关。
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
watch(resultOwner, clearResultFocus, { flush: 'sync' });
// 步骤变化只隔离地图输入；结果区自身保留有效选择，旧地图回调仍失效。
watch(
  resultActive,
  () => {
    selectionEpoch.value++;
  },
  { flush: 'sync' },
);
const mapHandlers = computed(() => {
  const owner = resultOwner.value,
    epoch = selectionEpoch.value,
    step = planning.step;
  const valid = () =>
    owner === resultOwner.value &&
    epoch === selectionEpoch.value &&
    step === planning.step &&
    auth.can('planning.view');
  const node = (id: string) => {
    if (valid()) {
      if (step === 1) inputFocused.value = id;
      else resultPanel.value?.selectNode(id);
    }
  };
  return {
    node,
    resource: (value: { id: string }) => node(value.id),
    link: (id: string) => {
      if (valid() && step !== 1) resultPanel.value?.selectLink(id);
    },
  };
});
// 内部同步定位参数不再次恢复作业，避免覆盖刚进入的调整草稿。
// 按完整目标区分内部同步与外部定位，并合并同一目标的重复导航。
let active = false;
let restoring = false;
const syncTargets = new Set<string>();
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
  if (!planning.result && !previewMode.value) return { nodes: [], links: [] };
  // 当前输入尚无结果时展示有明确标记的父方案，不冒用上一次预览。
  const result =
    previewMode.value && planning.adjustmentParent
      ? previewSide.value === 'after' && planning.adjustmentResult
        ? planning.adjustmentResult
        : planning.adjustmentParent.result
      : planning.result;
  if (!result) return { nodes: [], links: [] };
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
function resultFocus(
  owner: string,
  value: { stationId: string; linkId: string; stationIds: string[]; linkIds: string[] },
) {
  if (owner !== resultOwner.value || !resultActive.value || !planning.result) return;
  focused.value = value.stationId;
  focusedLink.value = value.linkId;
  nodeHighlights.value = value.stationIds;
  linkHighlights.value = value.linkIds;
  const nodeId = value.stationId || planning.result.links.find((row) => row.id === value.linkId)?.a;
  const point = overlay.value.nodes.find((row) => row.id === nodeId)?.coordinate;
  if (point) map.value?.locateResource(point);
}
async function clusterPage(page = 1) {
  const id = cluster.value?.id;
  if (!id) return;
  const value = await resources.fetchNodes(
    { clusterId: id, pageNum: page, pageSize: 10, sort: 'id' },
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
const gisTaskReturning = ref(false), gisTaskReturnError = ref('');
async function saveAndReturnToGis() {
  if (gisTaskReturning.value || !task.editable || route.query.editTask !== '1') return;
  const owner = auth.generation, path = route.fullPath;
  const current = () => active && owner === auth.generation && !auth.blocked && path === route.fullPath;
  gisTaskReturning.value = true; gisTaskReturnError.value = '';
  try {
    const saved = await saveTaskForGis(task, current);
    if (!saved || !current()) { if (current()) gisTaskReturnError.value = task.error || '任务尚未确认保存，当前输入已保留。'; return; }
    await router.push({ path: '/situation', query: { taskId: saved.taskId } });
  } catch (reason) { if (current()) gisTaskReturnError.value = reason instanceof Error ? reason.message : '任务保存失败'; }
  finally { gisTaskReturning.value = false; }
}
async function returnToGis() {
  if (gisTaskReturning.value || !task.saved || route.query.editTask !== '1') return;
  await router.push({ path: '/situation', query: { taskId: task.saved.taskId } });
}
async function syncUrl() {
  if (
    !active ||
    diagnosisReturning.value || gisTaskReturning.value ||
    route.path !== '/planning' ||
    restoring ||
    (!task.saved && !planning.selectedPlan && !planning.job) ||
    routeTaskError.value
  )
    return;
  const query: Record<string, string> = {
    taskId: route.query.editTask === '1' && planning.step === 1 ? task.taskId : planning.selectedPlan?.taskId ?? planning.job?.taskId ?? task.taskId,
  };
  // 内部身份同步保留诊断准备来源，返回入口不随保存动作丢失。
  if (route.query.from === 'diagnosis') query.from = 'diagnosis';
  // 编辑入口不附带历史作业或方案，避免自动跳回结果步骤。
  if (route.query.editTask === '1' && planning.step === 1) query.editTask = '1';
  else if (planning.selectedPlan) query.planId = planning.selectedPlan.id;
  else if (planning.job) query.jobId = planning.job.id;
  const target = router.resolve({ path: '/planning', query }).fullPath;
  if (route.fullPath !== target && !syncTargets.has(target)) {
    syncTargets.add(target);
    try {
      await router.replace(target);
    } finally {
      syncTargets.delete(target);
    }
  }
}
async function restoreRoute() {
  if (!active) return;
  const token = ++routeTicket;
  restoring = true;
  routeTaskError.value = '';
  try {
    if (!safeReturnPath(route.fullPath)) {
      routeTaskError.value = '任务或方案定位参数无效，当前输入已保留。';
      planning.localError('任务或方案定位参数无效', 'route');
      return;
    }
    if (['references', 'saved'].includes(String(route.query.history))) {
      historyInitialTab.value = 'saved';
      historyVisible.value = true;
      return;
    }
    const taskId = typeof route.query.taskId === 'string' ? route.query.taskId : null,
      jobId = typeof route.query.jobId === 'string' ? route.query.jobId : null,
      planId = typeof route.query.planId === 'string' ? route.query.planId : null;
    // 方案可以来自尚无独立任务记录的采纳历史，查看不伪造已保存任务。
    if (planId && taskId) {
      if (task.saved?.taskId !== taskId && !(await task.openPlanTask(taskId))) return;
      if (!active || token !== routeTicket) return;
      if (await planning.selectPlan(planId, taskId)) await planning.loadPlans(1);
      if (active && token === routeTicket) planning.start();
      return;
    }
    if (taskId && task.taskId !== taskId && !(await task.open(taskId))) {
      if (active && token === routeTicket)
        routeTaskError.value = '尚未切换到目标任务，当前输入已保留。';
      return;
    }
    if (!active || token !== routeTicket) return;
    if (route.query.editTask === '1') {
      planning.step = 1;
      if (task.saved) await planning.loadPlans(1);
      planning.start();
      return;
    }
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
  (path) => {
    // 只跳过本次内部目标，等待同步时到达的外部定位仍须立即恢复。
    if (active && route.path === '/planning' && !syncTargets.has(path)) void restoreRoute();
  },
  // 路由提交时即核对目标，不能等导航完成后清理标记再判断。
  { flush: 'sync' },
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
  historyOpenController?.abort();
  cancelAnalysisEntry();
  active = false;
  routeTicket++;
  clearTimeout(viewportTimer);
  resources.stop();
});
</script>
<style scoped>
.analysis-entry p {
  margin: 6px 0;
  color: var(--muted);
  font-size: 12px;
}
.workflow-summary {
  padding: 10px 12px;
  background: #142b40;
  border: 1px solid var(--line);
  font-size: 12px;
  flex: none;
}
.workflow-summary p {
  margin: 6px 0 0;
  line-height: 1.6;
  color: var(--muted);
}
.workflow-summary p.warn {
  color: #efbb64;
}
.solution-choices {
  flex: none;
  font-size: 12px;
}
.solution-choices > summary {
  cursor: pointer;
  padding: 8px 12px;
  background: #14273b;
}
.planning-api-page {
  /* 由页面容器分配剩余空间，页头换行或状态出现时同步收缩工作区。 */
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.planning-api-page > * {
  flex-shrink: 0;
}
.planning-api-page > .page-heading {
  margin-bottom: 0;
}
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
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
  flex: 1 0 480px;
  min-height: 480px;
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(460px, 36%);
  grid-template-rows: minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
}
.planning-layout.input {
  grid-template-columns: 410px minmax(400px, 1fr);
}
.input-panel {
  min-height: 0;
  overflow: hidden;
}
.submit {
  width: 100%;
}
.map-panel {
  min-height: 480px;
  position: relative;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow: hidden;
}
/* 地图脱离内容高度计算，避免父栅格与画布百分比高度互相撑开。 */
.map-panel > :deep(.map-wrap) {
  position: absolute;
  inset: 0;
  min-height: 0;
}
.result-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
  overflow: hidden;
}
/* 右侧标题按内容自然撑高，避免继承全局最小高度额外占位。 */
.result-column :deep(.panel > .panel-head) {
  min-height: 0;
  padding-top: 8px;
  padding-bottom: 8px;
}
.result-content {
  min-height: 0;
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.result-column > .notice {
  margin: 0;
  font-size: 12px;
}
.result-content > :deep(.result-panel) {
  flex: 1 1 300px;
  min-height: 240px;
}
/* 第二步压缩外围留白；低窗口或警示展开时，明细不再被压成零高。 */
.results-column {
  gap: 8px;
}
.results-column .workflow-summary {
  padding: 8px 10px;
}
.results-column .workflow-summary p {
  margin-top: 4px;
}
.results-column .result-content {
  gap: 8px;
}
.results-column .result-content > :deep(.result-panel) {
  flex: 1 0 440px;
  min-height: 440px;
}
.results-column .result-details {
  padding: 4px 0;
}
.results-column .result-details summary {
  padding: 6px 8px;
}
/* 第三步按内容高度排列，避免面板被压成标题条；统一由右侧容器滚动。 */
.adjustment-content > * {
  flex: none;
}
.planning-layout.collapsed {
  grid-template-columns: minmax(0, 1fr);
}
.map-tools {
  position: absolute;
  bottom: 65px;
  left: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  max-width: calc(100% - 80px);
}
.progress-details {
  flex: none;
  font-size: 12px;
}
.progress-details > summary {
  padding: 10px 12px;
  background: #14273b;
  border: 1px solid var(--line);
  cursor: pointer;
  color: var(--muted);
}
.map-tools span {
  background: #102035ed;
  padding: 8px;
  font-size: 11px;
}
.result-details {
  padding: 10px 0;
  font-size: 12px;
}
.result-details summary {
  cursor: pointer;
  color: var(--muted);
  padding: 8px;
}
.result-details[open] {
  max-height: 360px;
  overflow: auto;
  flex-shrink: 0;
}
.adjustment-content > .result-details[open] {
  max-height: none;
  overflow: visible;
}
.step-actions {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex: none;
}
.submit-hint {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
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
  .planning-api-page {
    height: auto;
  }
  .planning-layout,
  .planning-layout.input {
    flex: none;
    grid-template-columns: 1fr;
    grid-template-rows: auto;
  }
  .input-panel {
    max-height: none;
  }
  .map-panel {
    height: 480px;
  }
}
</style>
