<template>
  <div class="page planning-api-page"
    ><div class="page-heading"
      ><h1>网络规划</h1
      ><div class="toolbar">
        <!-- 刷新只更新资源读取，保持原来仅在任务输入步骤提供的范围。 -->
        <button
          v-if="planning.step === 1"
          class="btn"
          :disabled="!resources.readable || resources.refreshing || task.busy || task.running || !!task.pendingSave"
          @click="task.draft ? task.refreshResources() : resources.refresh()"
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
    <div v-if="planning.step === 1 && planning.adjustmentDirty" class="notice warn" role="status">已保留未完成的方案调整。提交新规划前，请继续调整或明确放弃。<button class="text-link" @click="enterAdjustmentWorkspace">继续方案调整</button><button class="text-link" :disabled="planning.busy || planning.running || !!planning.pending" @click="discardAdjustmentWorkspace">放弃本次调整</button></div>
    <div class="steps"
      ><button
        v-for="(label, i) in ['任务与约束输入', '规划计算与结果', '方案调整与对比']"
        :key="label"
        :class="{ active: planning.step === i + 1 }"
        @click="changePlanningStep(i + 1)"
        >{{ i + 1 }} · {{ label }}</button
      ></div
    >
    <ResourceReadStatus
      :refresh-hint="
        planning.step === 1 ? undefined : '请返回“任务与约束输入”刷新资源；当前规划结果保持原快照。'
      "
    />
    <div v-if="planning.jobStatus" class="notice planning-job-status" :class="{ warn: planning.jobStatus.warning }" :role="planning.jobStatus.warning ? 'alert' : 'status'" aria-live="polite">
      <span>{{ planning.jobStatus.message }}</span>
      <button v-if="planning.job" class="text-link" @click="planning.step = 2; resultCollapsed = false">查看当前作业</button>
      <button v-if="planning.queryError || planning.unverifiedActiveJobId" class="text-link" :disabled="planning.busy || !!planning.pending" @click="planning.refreshJob()">恢复查询</button>
    </div>
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
      :class="{ input: planning.step === 1, results: planning.step === 2, collapsed: planning.step !== 1 && resultCollapsed }"
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
          :show-coverage="editingAdjustment && !!planning.adjustmentParent ? true : showCoverage"
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
              : workspaceMode === 'manage' ? '方案管理'
                : workspaceMode === 'view' ? '只读查看方案'
                  : workspaceMode === 'adjust' ? '调整方案' : '保存方案与版本对比'
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
            >参考方案保留用于查看、对比和符合条件的干扰分析。</p
          >
        </div>
        <div
          ref="progressContent"
          class="result-content"
          :class="{ 'adjustment-content': planning.step === 3 }"
        >
          <section v-if="planning.step === 3" class="plan-management" aria-label="方案管理">
            <template v-if="workspaceMode === 'manage'">
              <h2>{{ currentObjectLabel }}</h2>
              <p role="status">{{ planSaveState }}</p>
              <dl v-if="planning.result" class="plan-metrics">
                <div><dt>网络连通率</dt><dd>{{ planning.result.metrics.connectivityPercent ?? '未提供' }}%</dd></div>
                <div><dt>总辐射功率</dt><dd>{{ planning.result.metrics.totalRadiatedPowerW ?? '未提供' }} W</dd></div>
                <div><dt>抗毁性</dt><dd>{{ planning.result.metrics.survivabilityPercent ?? '未提供' }}%</dd></div>
                <div><dt>部署节点</dt><dd>{{ planning.result.nodes.length }}</dd></div>
              </dl>
              <p v-if="hasAdjustmentWork || planning.adjustmentDirty" class="notice">调整草稿已保留，可继续调整、计算和对比。</p>
              <div class="toolbar" aria-label="方案操作入口">
                <button class="btn" :disabled="!planning.result" @click="switchWorkspaceMode('view')">查看方案</button>
                <button class="btn" :disabled="!planning.result || planning.busy || !!planning.pending" @click="enterAdjustmentWorkspace">调整方案</button>
                <button class="btn primary" :disabled="!planning.result" @click="switchWorkspaceMode('save')">保存方案</button>
              </div>
              <button class="text-link" @click="switchWorkspaceMode('save')">历史版本与方案对比</button>
              <button v-if="planning.adjustmentParent" class="text-link" :disabled="planning.busy || planning.running || !!planning.pending" @click="discardAdjustmentWorkspace">放弃本次调整</button>
            </template>
            <template v-else>
              <div class="toolbar"><button class="btn small" @click="returnToManagement">返回方案管理</button><span>{{ workspaceMode === 'view' ? '只读查看，不会修改已保存方案' : workspaceMode === 'adjust' ? '调整 → 计算覆盖 → 查看效果 → 对比 → 保存' : '保存新版本并保留原方案' }}</span></div>
              <p v-if="workspaceMode === 'adjust'" role="status">{{ planning.adjustmentStatus }}</p>
              <p v-if="workspaceMode === 'adjust' && !frozenCoverageQuery" class="notice warn" role="status">当前调整与已有覆盖来源不一致。请完成本次调整预览后重新计算覆盖；基准方案的旧结果不会用于当前候选方案。</p>
              <div v-if="workspaceMode === 'adjust'" class="toolbar">
                <button class="btn" @click="switchWorkspaceMode('save')">对比与保存调整结果</button>
              </div>
            </template>
          </section>
          <PlanningApiProgressPanel
            v-if="
              (planning.step === 2 || workspaceMode !== 'manage' || planning.feedback || planning.queryFeedback || planning.pending) && (
                planning.running || !planning.selectedPlan || planning.feedback || planning.queryFeedback || planning.pending
              )
            "
            compact
            :show-job="planning.running || !planning.selectedPlan"
          />
          <PlanningApiResultPanel
            v-show="planning.step === 2 || workspaceMode === 'view'"
            ref="resultPanel"
            v-model:coverage-display="coverageDisplay"
            :candidates="candidates.view.value"
            @candidate-active="candidateTab = $event"
            :result="planning.result"
            :outcome="planning.selectedPlan?.outcome"
            :radio-count="resultRadioCount"
            :confirmed-configuration="planning.selectedPlan?.confirmedConfiguration"
            :owner-key="resultOwner"
            :active="resultActive"
            :historical="planning.sourceChanged"
            @focus="resultFocus"
            @coverage="showCoverage = $event"
          />
          <section v-if="planning.step === 2 || workspaceMode === 'view'" class="coverage-summary" aria-label="方案覆盖结果摘要">
            <h3>覆盖结果</h3>
            <button v-if="planning.selectedPlan?.adjustment && planning.selectedPlan.jobId && planning.selectedPlan.resourceRevision" class="btn small" :disabled="planning.busy || !!planning.pending" @click="readSavedCandidateCoverage(!frozenCoverageQuery?.planId.startsWith('PREVIEW-'))">{{ frozenCoverageQuery?.planId.startsWith('PREVIEW-') ? '读取保存版本自身覆盖' : '读取该版本原候选覆盖' }}</button>
            <p v-if="planning.selectedPlan && frozenCoverageQuery?.planId.startsWith('PREVIEW-')" role="status">该覆盖来自此保存版本的原候选作业快照，仍保留实际候选来源标识。</p>
            <p>{{ frozenCoverageForMap ? '当前方案已有覆盖结果，可在地图查看选中设备的覆盖范围。' : '当前方案尚无已读取且匹配的覆盖结果，请进入调整工作区读取缓存或计算。' }}</p>
            <button class="btn small" :disabled="!planning.result || planning.busy || !!planning.pending" @click="enterAdjustmentWorkspace">{{ frozenCoverageForMap ? '查看覆盖详情' : '进入覆盖计算' }}</button>
          </section>
          <FrozenCoveragePanel v-if="lastCoverageQuery" v-show="planning.step === 2 || (planning.step === 3 && (workspaceMode === 'view' || workspaceMode === 'adjust') && (!!frozenCoverageQuery || coveragePanel?.hasProtectedSelection()))" ref="coveragePanel" :query="lastCoverageQuery" :readonly="planning.step !== 3 || workspaceMode !== 'adjust'" :active="(planning.step === 2 || planning.step === 3 && (workspaceMode === 'view' || workspaceMode === 'adjust')) && !!frozenCoverageQuery"
            :services="collaborationHttp.frozenCoverage" @overlay="acceptFrozenCoverage" />
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
            @close="returnToManagement"
            @submit="planning.submitAdjustment"
          />
          <PlanningAdjustmentPreview
            v-if="planning.step === 3 && editingAdjustment && planning.adjustmentParent"
            :before="planning.adjustmentParent"
            :after="planning.adjustmentResult"
            :status="planning.adjustmentStatus"
          />
          <PlanningApiVersionsPanel
            v-show="planning.step === 3 && workspaceMode === 'save'"
            :adjusting="!!planning.adjustmentParent && !adjustmentSaved && (planning.adjustmentOpen || planning.adjustmentDirty || planning.job?.parentPlanId === planning.adjustmentParent.id && !!planning.job?.adjustment)"
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
              planning.step === 3 && workspaceMode === 'adjust' && hasAdjustmentWork && !editingAdjustment && !adjustmentSaved
            "
            class="btn"
            :disabled="planning.busy || !!planning.pending"
            @click="planning.adjustmentOpen = true"
            >继续编辑调整</button
          >
          <details
            v-if="
              planning.step === 3 && workspaceMode !== 'manage' &&
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
          <details v-if="planning.step === 2 || workspaceMode === 'view' || workspaceMode === 'adjust'" class="result-details"
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
          <button v-if="planning.selectedPlan && !analysisPlanConfirmed" class="btn small" :disabled="!!analysisValidationReason || analysisEntryBusy" @click="confirmAnalysisPlan">{{ analysisEntryBusy ? '正在核对分析方案…' : '确认用于干扰分析' }}</button>
          <span v-if="analysisPlanConfirmed && planning.selectedPlan" role="status">已确认分析输入：{{ planning.selectedPlan.name }} · {{ planning.selectedPlan.version }}</span>
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
          <button v-if="!planning.selectedPlan && planning.result" class="text-link" @click="planning.step = 3; switchWorkspaceMode('save')">保存并选择分析方案</button>
          <button v-if="analysisEntryError" class="text-link" @click="planning.step = 3; switchWorkspaceMode('view')">核对所选方案配置</button>
        </div>
        <div class="step-actions"
          ><button
            class="btn small"
            @click="changePlanningStep(planning.step === 3 ? 2 : 1)"
            >{{ planning.step === 3 ? '返回规划结果' : '返回任务输入' }}</button
          >
          <button
            v-if="planning.step === 2"
            class="btn primary small"
            @click="changePlanningStep(3)"
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, toRaw, watch } from 'vue';
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
import { resolvePlanningCoverageQuery } from '../services/planning-coverage-query';
import { saveTaskForGis } from '../services/gis-task-edit-entry';

const workspaceMode = ref<'manage' | 'view' | 'adjust' | 'save'>('manage');
const task = useTaskInputStore();
const planning = usePlanningApiStore();
const resources = useResourceReadStore();
const { basemap: terrainBasemap, message: terrainMessage } = useTerrainBasemap(() => resources.workspace?.terrain, {
  enabled: () => !!resources.workspace,
});
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const previewSide = ref<'before' | 'after'>('after');
const frozenCoverage=shallowRef<FrozenCoverageOverlay|null>(null);
const candidateCoverageOrigins=shallowRef<FrozenCoverageQuery[]>([]);
const coveragePanel=ref<InstanceType<typeof FrozenCoveragePanel>>();
let changingStep=false;
async function changePlanningStep(step:number){
  if(changingStep||step===planning.step)return;
  changingStep=true;const session=auth.generation,current=planning.step;
  try{if((!coveragePanel.value||await coveragePanel.value.requestLeave())&&session===auth.generation&&!auth.blocked&&planning.step===current){if(current===3&&step!==3){planning.setAutomaticPreview(false);planning.adjustmentOpen=false;}planning.step=step;}}
  finally{changingStep=false;}
}
const frozenCoverageQuery=computed<FrozenCoverageQuery|null>(()=>resolvePlanningCoverageQuery({
  selectedPlan:planning.selectedPlan, adjustmentParent:planning.adjustmentParent,
  adjustmentResult:planning.adjustmentResult, job:planning.job,
  inAdjustment:planning.step===3 && workspaceMode.value==='adjust', previewSide:previewSide.value,
  dirty:planning.adjustmentDirty, running:planning.running, pending:!!planning.pending, candidateOrigins:candidateCoverageOrigins.value,
}));
function acceptFrozenCoverage(value:FrozenCoverageOverlay|null) {
  frozenCoverage.value=value;const query=frozenCoverageQuery.value;
  if(value&&query&&query.planId.startsWith('PREVIEW-')&&value.anchor.plan_id===query.planId&&value.anchor.task_id===query.taskId&&value.anchor.snapshot_id===query.snapshotId&&value.anchor.resource_revision===query.resourceRevision){
    const origin={...query};if(!candidateCoverageOrigins.value.some(row=>JSON.stringify(row)===JSON.stringify(origin)))candidateCoverageOrigins.value=[...candidateCoverageOrigins.value.filter(row=>row.planId!==origin.planId||row.snapshotId!==origin.snapshotId),origin];
  }
}
watch(()=>[auth.generation,task.taskId],()=>{candidateCoverageOrigins.value=[];},{flush:'sync'});
async function readSavedCandidateCoverage(candidate = true) {
  const plan = planning.selectedPlan;
  if (!plan?.adjustment || !plan.jobId || !plan.resourceRevision) return;
  const owner = JSON.stringify([auth.generation,plan.taskId,plan.id,plan.version,plan.result.snapshotId,plan.resourceRevision]);
  if (coveragePanel.value && !await coveragePanel.value.requestLeave()) return;
  const selected = planning.selectedPlan;
  if (!selected || owner !== JSON.stringify([auth.generation,selected.taskId,selected.id,selected.version,selected.result.snapshotId,selected.resourceRevision])) return;
  const origin:FrozenCoverageQuery={planId:`PREVIEW-${plan.jobId}`,taskId:plan.taskId,snapshotId:plan.result.snapshotId,resourceRevision:plan.resourceRevision,context:'planning'};
  candidateCoverageOrigins.value=candidateCoverageOrigins.value.filter(row=>row.planId!==origin.planId||row.snapshotId!==origin.snapshotId);
  if(candidate)candidateCoverageOrigins.value=[...candidateCoverageOrigins.value,origin];
  await nextTick(); await coveragePanel.value?.readCache();
}
const lastCoverageQuery=shallowRef<FrozenCoverageQuery|null>(null);
watch(frozenCoverageQuery,query=>{if(query)lastCoverageQuery.value=query;},{immediate:true});
const frozenCoverageForMap=computed(()=>{
  const query=frozenCoverageQuery.value,value=frozenCoverage.value;
  return planning.step!==1&&query&&value&&value.anchor.plan_id===query.planId&&value.anchor.task_id===query.taskId&&value.anchor.snapshot_id===query.snapshotId&&value.anchor.resource_revision===query.resourceRevision?value:null;
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
const analysisConfirmedOwner = ref('');
const analysisValidationReason = computed(() =>
  auth.blocked || !auth.can('situation.view') || !auth.can('planning.view')
    ? '当前角色没有干扰分析查看权限'
    : !planning.selectedPlan
      ? '请先保存并选择分析方案'
      : planning.busy || planning.pending
        ? '请先完成当前规划操作'
        : planning.adjustmentDirty || planning.adjustmentOpen && !planning.selectedPlan
          ? '请先完成并保存调整结果，再确认分析输入'
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
    planning.selectedPlan?.result.snapshotId,
    planning.step,
  ]),
);
const analysisPlanConfirmed = computed(() => !!planning.selectedPlan && (planning.selectedPlan.state === 'CONFIRMED' || analysisConfirmedOwner.value === analysisEntryOwner.value));
const analysisEntryReason = computed(() => analysisValidationReason.value || (!analysisPlanConfirmed.value ? '请点击“确认用于干扰分析”，核对所选方案版本' : ''));
async function confirmAnalysisPlan() {
  if (analysisValidationReason.value || analysisEntryBusy.value || !planning.selectedPlan) return;
  const owner = analysisEntryOwner.value, target = planning.selectedPlan, serial = ++analysisEntrySerial;
  analysisEntryAbort?.abort(); analysisEntryAbort = new AbortController();
  analysisEntryBusy.value = true; analysisEntryError.value = '';
  try {
    const verified = await verifyPlanningInterferenceEntry(collaborationHttp.interferenceWorkbench, { taskId: target.taskId, planId: target.id, planVersion: target.version }, analysisEntryAbort.signal);
    if (verified && owner === analysisEntryOwner.value && serial === analysisEntrySerial && !analysisValidationReason.value) analysisConfirmedOwner.value = owner;
  } catch (reason) {
    if (owner === analysisEntryOwner.value && serial === analysisEntrySerial) analysisEntryError.value = reason instanceof Error ? reason.message : '分析方案核对失败，请重试';
  } finally { if (serial === analysisEntrySerial) analysisEntryBusy.value = false; }
}
function cancelAnalysisEntry() {
  analysisEntrySerial++;
  analysisConfirmedOwner.value = '';
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
const resultCollapsed = ref(false);
// 界面阶段只描述当前对象；不创建第二套保存状态或改变服务端确认条件。
const adjustmentSaved = computed(
  () =>
    !!planning.adjustmentParent &&
    !!planning.selectedPlan?.adjustment &&
    planning.selectedPlan.adjustment.sourcePlanId === planning.adjustmentParent.id &&
    planning.selectedPlan.result.snapshotId === planning.adjustmentResult?.snapshotId &&
    !planning.adjustmentDirty,
);
const editingAdjustment = computed(() => planning.step === 3 && workspaceMode.value === 'adjust' && planning.adjustmentOpen && !adjustmentSaved.value);
const planSaveState = computed(() => planning.adjustmentDirty || planning.adjustmentResult && !adjustmentSaved.value && !planning.selectedPlan ? '待保存：调整结果不会覆盖原始方案' : planning.selectedPlan ? `已保存版本 ${planning.selectedPlan.version}` : planning.currentSavedPlanId ? '本结果已有保存版本，请在历史版本中打开' : '当前规划结果尚未保存');
async function switchWorkspaceMode(mode: 'manage' | 'view' | 'adjust' | 'save') {
  if (mode === workspaceMode.value) return true;
  const previous = workspaceMode.value, session = auth.generation;
  if (coveragePanel.value && !await coveragePanel.value.requestLeave()) return false;
  if (session !== auth.generation || auth.blocked || workspaceMode.value !== previous) return false;
  if (previous === 'adjust' && mode !== 'adjust') { planning.setAutomaticPreview(false); planning.adjustmentOpen = false; }
  workspaceMode.value = mode; return true;
}
async function returnToManagement() { await switchWorkspaceMode('manage'); }
async function discardAdjustmentWorkspace() {
  if (planning.busy || planning.running || planning.pending || !planning.adjustmentParent) return;
  const parent = planning.adjustmentParent;
  const owner = JSON.stringify([auth.generation,task.taskId,parent.id,planning.adjustmentDraft]);
  const answer = await task.ask({title:'放弃方案调整',message:'放弃当前设备参数与路由草稿，原始方案和已有覆盖历史继续保留。',discardLabel:'放弃调整',cancelLabel:'继续保留'});
  if (answer !== 'discard' || owner !== JSON.stringify([auth.generation,task.taskId,planning.adjustmentParent?.id,planning.adjustmentDraft])) return;
  if (coveragePanel.value && !await coveragePanel.value.requestLeave()) return;
  if (owner !== JSON.stringify([auth.generation,task.taskId,planning.adjustmentParent?.id,planning.adjustmentDraft])) return;
  planning.discardAdjustment(); planning.selectedPlan = parent; workspaceMode.value = 'manage';
}
async function enterAdjustmentWorkspace() {
  if (planning.busy || planning.pending) return;
  if (!planning.selectedPlan && !planning.adjustmentParent) {
    planning.step = 3; workspaceMode.value = 'save';
    planning.notice = '请先保存规划结果作为基准版本，再进入调整与覆盖计算。';
    return;
  }
  if (planning.adjustmentParent && !adjustmentSaved.value && (!planning.selectedPlan || planning.selectedPlan.id === planning.adjustmentParent.id)) {
    planning.step = 3; planning.adjustmentOpen = true; workspaceMode.value = 'adjust'; return;
  }
  if (await planning.openPlanAdjustment()) workspaceMode.value = 'adjust';
}
watch(() => planning.step, (next, previous) => { if (next === 3 && previous !== 3) workspaceMode.value = 'manage'; }, { flush: 'sync' });
watch(() => planning.adjustmentOpen, (open) => { if (open) workspaceMode.value = 'adjust'; }, { flush: 'sync' });
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
    !!planning.adjustmentParent && workspaceMode.value === 'adjust' &&
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
// 新摘要的显式缺值保留；旧结果只读当前对象，不借用作业或父方案数量。
const resultRadioCount = computed(() => {
  const summary = planning.result?.resultDetails?.deploymentSummary;
  if (summary != null) return summary.actualCount;
  return planning.selectedPlan
    ? (planning.selectedPlan.radioCount ?? null)
    : (planning.currentSolution?.radioCount ?? null);
});
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
          ? '参考方案可查看、比较；确认用于分析后，可进入干扰分析。'
          : planning.selectedPlan?.current
            ? '此版本已是当前方案。可返回查看结果，或按需调整；无需重复确认。'
            : planning.selectedPlan
              ? '已保存版本。请选择查看、调整或保存操作；分析确认与设为当前方案分别处理。'
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
      : planning.unverifiedActiveJobId
        ? '已有作业状态待核实，请恢复查询后再提交'
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
      workspaceMode.value,
    ] as const,
  () =>
    planning.setAutomaticPreview(
      planning.step === 3 && workspaceMode.value === 'adjust' && task.readable && auth.can('planning.execute'),
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
const progressContent = ref<HTMLElement>();
// 仅切换作业时定位进度，常规轮询不改滚动位置，避免页面跳动。
watch(() => planning.job?.id, async (id, previous) => {
  if (!id || id === previous) return;
  await nextTick();
  if (planning.job?.id === id && progressContent.value) progressContent.value.scrollTop = 0;
}, { immediate: true });
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
      if (planning.unverifiedActiveJobId) await planning.refreshJob(planning.unverifiedActiveJobId);
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
.planning-layout.results {
  /* 沿用原左右栏宽度；纵向工作区从 480px 扩为两倍，不放大文字或行距。 */
  flex-basis: 960px;
  min-height: 960px;
}
.plan-management, .coverage-summary { padding: 12px; background: #14273b; border: 1px solid var(--line); }
.plan-management h2 { margin: 0 0 8px; font-size: 16px; }
.plan-management p, .coverage-summary p { font-size: 12px; line-height: 1.6; }
.plan-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.plan-metrics dt { color: var(--muted); font-size: 12px; }
.plan-metrics dd { margin: 5px 0; font-size: 19px; color: #9edaff; }
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
  /* 明细面板原最小高度为 440px，增加纵向展示空间到两倍。 */
  flex: 1 0 880px;
  min-height: 880px;
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
.planning-layout.results.collapsed {
  flex-basis: 480px;
  min-height: 480px;
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
  .planning-layout.results:not(.collapsed) {
    grid-template-columns: minmax(360px, 1fr) minmax(360px, 36%);
  }
  .planning-layout,
  .planning-layout.input {
    grid-template-columns: 360px minmax(360px, 1fr);
  }
}
@media (max-width: 950px) {
  /* 小屏上下排列仍给结果完整纵向空间，不把加高面板裁进半屏容器。 */
  .planning-layout.results:not(.collapsed) {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: 480px minmax(960px, auto);
  }
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
