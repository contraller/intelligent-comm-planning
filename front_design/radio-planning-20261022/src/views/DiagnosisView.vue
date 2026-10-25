<template>
  <!-- 标题与工作区统一复用公共页面留白，随窗口宽度调整边距。 -->
  <div class="page diagnosis-page">
    <div class="page-heading"
      ><h1>故障诊断</h1
      ><div class="page-actions">
        <button
          v-if="gisReady"
          class="btn"
          @click="openGis"
          >在 GIS 查看</button
        >
        <button
          class="btn primary"
          :disabled="diagnosis.locked || !diagnosis.workspace || !diagnosis.sources.plans.length"
          v-if="auth.can('diagnosis.scenario')"
          @click="openSource()"
          >新建场景</button
        >
        <button
          class="btn"
          :disabled="diagnosis.locked || !diagnosis.workspace || !diagnosis.sources.plans.length"
          v-if="auth.can('diagnosis.scenario')"
          @click="openImport"
          >导入场景</button
        >
        <button
          class="btn"
          :disabled="diagnosis.locked"
          @click="diagnosis.reload"
          >重新加载</button
        >
      </div></div
    >
    <div
      v-if="diagnosis.network?.workflow?.interferenceOrigin"
      class="feedback"
      >抗干扰网络：{{ diagnosis.network.preset }} · 来自分析
      {{ diagnosis.network.workflow.interferenceOrigin.analysisId }}。诊断绑定此完整配置。</div
    >
    <div
      v-if="diagnosis.loadError"
      class="feedback error"
      role="alert"
      >{{ diagnosis.loadError }}。请重新加载；已有历史记录不会被覆盖。</div
    >
    <div
      v-if="diagnosis.sources.error"
      class="feedback warning"
      >{{ diagnosis.sources.error }}。来源有效性无法核实，新任务已禁用。</div
    >
    <div
      v-else-if="!diagnosis.loading && !diagnosis.sources.plans.length"
      class="feedback warning"
      >当前没有有效的已确认方案。<RouterLink
        v-if="auth.can('planning.view')"
        to="/planning?from=diagnosis"
        >前往网络规划保存并转正方案</RouterLink
      >，随后可创建诊断。</div
    >
    <div
      v-if="diagnosis.error"
      class="feedback error"
      role="alert"
      >{{ diagnosis.error
      }}<span
        v-for="(issue, index) in diagnosis.issues"
        :key="index"
      >
        · {{ issue.objectId || issue.field }}：{{ issue.message }}</span
      ></div
    >
    <div
      v-if="diagnosis.notice"
      class="feedback success"
      >{{ diagnosis.notice }}</div
    >
    <!-- 来源属于当前记录；演示开关只控制辅助入口，不代表结果来源。 -->
    <div
      class="diagnosis-origin"
      role="status"
      >数据来源：{{ diagnosisOriginLabel(diagnosis.dataOrigin) }}</div
    >
    <details
      v-if="diagnosis.demoEnabled"
      class="demo-settings"
    >
      <summary
        >演示设置<span
          v-if="diagnosis.draft"
          :class="{ 'demo-non-default': diagnosis.demo !== 'normal' }"
        >
          · 当前：{{ demoLabels[diagnosis.demo]
          }}{{ diagnosis.demo !== 'normal' ? '（非默认）' : '' }}</span
        ></summary
      >
      <p
        >演示分支用于验证流程，不改变已提交任务。示例服务仅支持既定场景与参数组合，超出范围时暂无预生成结果。</p
      >
      <label v-if="diagnosis.draft"
        >演示分支<select
          v-model="diagnosis.demo"
          :disabled="!auth.can('diagnosis.execute') || diagnosis.locked"
        >
          <option value="normal">两路融合</option
          ><option value="three-way">三路正常态示例</option
          ><option value="low-confidence">候选分歧 / 低置信度</option
          ><option value="diagnosis-failed">诊断执行失败</option
          ><option value="impact-failed">影响分析失败</option>
        </select></label
      >
      <p v-if="diagnosis.draft">{{
        diagnosis.demo === 'three-way'
          ? '三路示例仅支持均衡网络＋功放故障模板，结果为固定预生成数据。'
          : '默认示例采用两路融合；分路缺项、权重与贡献按结果展示。'
      }}</p>
      <button
        v-if="diagnosis.demoEnabled && auth.can('diagnosis.reset')"
        class="btn small"
        :disabled="diagnosis.locked"
        @click="reset"
        >重置诊断演示数据</button
      >
    </details>
    <div
      class="diagnosis-workspace"
      :class="{ 'result-collapsed': resultCollapsed }"
    >
      <aside class="scenario-list">
        <div class="list-heading"
          ><strong>故障场景</strong
          ><label
            ><input
              v-model="showArchived"
              type="checkbox"
            />归档</label
          ></div
        >
        <!-- 目录错误就地恢复，不覆盖场景操作及另一目录的反馈。 -->
        <p
          v-if="diagnosis.scenarioQueryError"
          class="list-error"
          role="alert"
        >
          场景目录读取失败：{{ diagnosis.scenarioQueryError }}
          <button
            class="text-link"
            :disabled="diagnosis.locked"
            @click="diagnosis.queryScenarios(diagnosis.scenarioPage)"
            >重试场景目录</button
          >
        </p>
        <p
          v-if="!scenes.length"
          class="empty-copy"
          >{{ showArchived ? '暂无归档场景' : '暂无自建场景，选择上方“新建场景”开始。' }}</p
        >
        <div
          v-for="scene in scenes"
          :key="scene.id"
          class="scene-card"
          :class="{ active: diagnosis.scenarioId === scene.id }"
        >
          <button
            class="scene-select"
            @click="diagnosis.selectVersion(scene.versions.at(-1)!)"
            ><strong>{{ scene.versions.at(-1)!.name }}</strong
            ><small
              >版本 {{ scene.versions.length }} ·
              {{ faultCount(scene.versions.at(-1)!) }} 个故障对象</small
            ></button
          >
          <div class="scene-actions"
            ><select
              aria-label="查看场景版本"
              :value="
                diagnosis.scenarioId === scene.id ? diagnosis.versionId : scene.versions.at(-1)!.id
              "
              @change="selectScenarioVersion(scene, $event)"
              ><option
                v-for="version in scene.versions"
                :key="version.id"
                :value="version.id"
                >版本 {{ version.version }}</option
              ></select
            ><button
              class="text-link"
              v-if="auth.can('diagnosis.scenario')"
              @click="diagnosis.archive(scene.id, !scene.archived)"
              >{{ scene.archived ? '恢复' : '归档' }}</button
            ></div
          >
        </div>
        <div
          class="scene-actions"
          v-if="diagnosis.scenarioTotal > diagnosis.scenarioPageSize"
          ><button
            class="text-link"
            :disabled="diagnosis.scenarioPage <= 1"
            @click="diagnosis.queryScenarios(diagnosis.scenarioPage - 1)"
            >上页</button
          ><small>{{ diagnosis.scenarioPage }} 页 / {{ diagnosis.scenarioTotal }} 场景</small
          ><button
            class="text-link"
            :disabled="
              diagnosis.scenarioPage * diagnosis.scenarioPageSize >= diagnosis.scenarioTotal
            "
            @click="diagnosis.queryScenarios(diagnosis.scenarioPage + 1)"
            >下页</button
          ></div
        >
        <div class="list-heading"
          ><strong>诊断运行记录</strong><span>{{ diagnosis.historyTotal }}</span></div
        >
        <p
          v-if="diagnosis.historyQueryError"
          class="list-error"
          role="alert"
        >
          运行目录读取失败：{{ diagnosis.historyQueryError }}
          <button
            class="text-link"
            :disabled="diagnosis.locked"
            @click="diagnosis.queryHistory(diagnosis.historyPage)"
            >重试运行目录</button
          >
        </p>
        <button
          v-for="run in diagnosis.workspace?.runs ?? []"
          :key="run.id"
          class="history-card"
          :class="{ active: diagnosis.runId === run.id }"
          @click="diagnosis.selectRun(run.id)"
          ><strong>{{ 'scenario' in run ? run.scenario.name : run.name }}</strong
          ><small>{{ new Date(run.startedAt).toLocaleString() }}</small
          ><small
            >场景 v{{ 'scenario' in run ? run.scenario.version : run.scenarioVersion
            }}<template v-if="run.demo"> · 示例：{{ demoLabels[run.demo] }}</template></small
          ></button
        >
        <div
          class="scene-actions"
          v-if="diagnosis.historyTotal > diagnosis.historyPageSize"
          ><button
            class="text-link"
            :disabled="diagnosis.historyPage <= 1"
            @click="diagnosis.queryHistory(diagnosis.historyPage - 1)"
            >上页</button
          ><small>{{ diagnosis.historyPage }} 页 / {{ diagnosis.historyTotal }} 记录</small
          ><button
            class="text-link"
            :disabled="diagnosis.historyPage * diagnosis.historyPageSize >= diagnosis.historyTotal"
            @click="diagnosis.queryHistory(diagnosis.historyPage + 1)"
            >下页</button
          ></div
        >
        <div
          v-if="diagnosis.legacy.length"
          class="list-heading"
          ><strong>历史参考记录</strong></div
        >
        <button
          v-for="item in diagnosis.legacy"
          :key="item.id"
          class="history-card"
          :class="{ active: diagnosis.record?.id === item.id }"
          @click="diagnosis.selectLegacy(item.id)"
          ><strong>{{ item.name }}</strong
          ><small>{{ 'network' in item ? item.network.id : item.planId }} · 历史快照</small></button
        >
      </aside>
      <main class="diagnosis-main">
        <div
          v-if="diagnosis.loading"
          class="context-card"
          >正在加载诊断工作区…</div
        >
        <div
          v-if="diagnosis.network"
          class="context-card"
          ><div
            ><small>绑定网络 / 规划任务 {{ diagnosis.network.taskId }}</small
            ><strong>{{ diagnosis.network.name }} · {{ diagnosis.network.id }}</strong
            ><span
              v-if="currentSource"
              class="source-state"
              >{{ diagnosisLabel(currentSource.state) }}
              {{ currentSource.reasons.join('；') }}</span
            ></div
          ><button
            v-if="copySource && auth.can('diagnosis.scenario')"
            class="btn small"
            :disabled="diagnosis.locked || !diagnosis.sources.plans.length"
            @click="openSource(copySource)"
            >复制为新场景</button
          ></div
        >
        <div
          v-if="diagnosis.draft"
          class="draft-toolbar"
        >
          <label
            >当前有效网络<select
              :value="diagnosis.draft.planId"
              :disabled="!auth.can('diagnosis.scenario') || diagnosis.locked"
              @change="diagnosis.switchPlan(($event.target as HTMLSelectElement).value)"
              ><option
                v-if="!diagnosis.sources.plans.some((p) => p.id === diagnosis.draft?.planId)"
                :value="diagnosis.draft.planId"
                >历史版本 {{ diagnosis.draft.planId }} · 不可发起诊断</option
              ><option
                v-for="plan in diagnosis.sources.plans"
                :key="plan.id"
                :value="plan.id"
                :disabled="'canCreate' in plan && !plan.canCreate"
                >{{ plan.name }} / {{ plan.taskId }} / {{ plan.id.slice(0, 8)
                }}{{
                  'canCreate' in plan && !plan.canCreate
                    ? ' · ' + (plan.unavailableReason || '暂不可用')
                    : ''
                }}</option
              ></select
            ></label
          >
          <label v-if="diagnosis.availablePresets.length"
            >场景模板<select
              :disabled="!diagnosis.canEdit || diagnosis.locked"
              value=""
              @change="diagnosis.applyPreset(($event.target as HTMLSelectElement).value)"
              ><option value="">请选择场景模板（可选）</option
              ><option
                v-for="preset in diagnosis.availablePresets"
                :key="preset.id"
                :value="preset.id"
                >{{ preset.label }}</option
              ></select
            ></label
          >
          <small v-else>暂无可用场景模板，可在 GIS 标绘或导入故障场景。</small>
          <div class="buttons"
            ><button
              class="btn small"
              :disabled="!gisEditable"
              @click="openGisEditor"
              >在 GIS 标绘</button
            ><button
              class="btn small"
              :disabled="!diagnosis.undoStack.length || !diagnosis.canEdit"
              @click="diagnosis.undo"
              >撤销</button
            ><button
              class="btn small"
              :disabled="!diagnosis.redoStack.length || !diagnosis.canEdit"
              @click="diagnosis.redo"
              >重做</button
            ><button
              class="btn small"
              :disabled="!diagnosis.canEdit || diagnosis.locked"
              @click="diagnosis.save"
              >保存场景版本</button
            ></div
          >
          <!-- 核对当前场景输入；修改仍交给既有模板、GIS 标绘及导入流程。 -->
          <section
            class="input-summary"
            aria-label="当前故障输入"
          >
            <h3>故障输入 · {{ faults.length }} 个对象</h3>
            <p
              v-if="!faults.length"
              class="empty-copy"
              >尚未设置故障对象，请在 GIS 标绘或导入故障场景。</p
            >
            <ul v-else>
              <li
                v-for="(fault, index) in faults"
                :key="index"
              >
                <strong>{{ diagnosisLabel(fault.objectType) }} {{ fault.objectId }}</strong>
                <span>{{ diagnosisLabel(fault.faultType) }}</span>
                <p>现象：{{ faultSymptoms(fault.symptomIds) }}</p>
              </li>
            </ul>
          </section>
          <div class="submit-row"
            ><button
              class="btn primary"
              :disabled="!diagnosis.canExecute || diagnosis.locked"
              @click="diagnosis.submit"
              >{{ diagnosis.dirty ? '保存并开始诊断' : '开始诊断' }}</button
            ></div
          >
          <small v-if="diagnosis.dirty">当前有未保存输入。</small>
        </div>
        <DiagnosisProgressPanel
          v-if="diagnosis.view"
          :view="diagnosis.view"
          :query-error="diagnosis.queryError"
          :busy="diagnosis.busy"
          :cancel-awaiting-refresh="diagnosis.cancelAwaitingRefresh"
          @cancel="diagnosis.cancel"
          @retry="diagnosis.query"
        />
        <div
          v-else-if="diagnosis.queryError"
          class="feedback error"
          >{{ diagnosis.queryError }}
          <button
            class="text-link"
            @click="diagnosis.query"
            >重试</button
          ></div
        >
        <DiagnosisNetworkPanel
          v-if="diagnosis.network"
          :network="diagnosis.network"
          :faults="faults"
          :result="diagnosis.result"
          :impact-ready="diagnosis.impactReady"
          :focus="focus"
          @filters="filters = $event"
        />
        <div
          v-else
          class="empty-panel"
          ><h2>创建故障诊断场景</h2><p>选择有效确认网络 → 设置或导入故障场景 → 保存并开始诊断。</p
          ><p>当前没有自建运行记录，历史参考记录可从左侧手动查看。</p
          ><button
            v-if="auth.can('diagnosis.scenario')"
            class="btn primary"
            :disabled="diagnosis.locked || !diagnosis.workspace || !diagnosis.sources.plans.length"
            @click="openSource()"
            >选择网络并创建场景</button
          ><p v-if="auth.can('planning.view')"
            ><RouterLink to="/planning?from=diagnosis">前往网络规划准备并转正方案</RouterLink></p
          ></div
        >
      </main>
      <div
        v-if="diagnosis.result"
        class="result-workspace"
        ><button
          v-if="resultCollapsed"
          class="result-restore btn small"
          aria-label="展开诊断结果"
          :aria-expanded="false"
          title="展开诊断结果"
          @click="resultCollapsed = !resultCollapsed"
          ><i
            class="pi pi-angle-double-left"
            aria-hidden="true"
          /><span>诊断</span></button
        ><DiagnosisResultPanel
          v-if="!resultCollapsed"
          :result="diagnosis.result"
          :symptoms="diagnosis.symptoms"
          :context-key="resultContext"
          :impact-ready="diagnosis.impactReady"
          :report-ready="!!diagnosis.record"
          :exporting="diagnosis.exporting"
          :impact-exporting="diagnosis.exporting && diagnosis.exportTarget === 'impact'"
          :export-error="diagnosis.impactExportError"
          :legacy="diagnosis.record?.legacy ?? false"
          @locate="locate"
          @report="reportDrawer = true"
          @export-impact="diagnosis.download($event, filters)"
        >
          <!-- 收起入口放入标题行，避免面板外占行造成顶边错位。 -->
          <template #heading-actions>
            <button v-if="auth.can('knowledge.edit') && diagnosis.view?.diagnosisReady" class="text-link" :disabled="diagnosis.locked" @click="feedbackDrawer=true">知识反馈</button>
            <button
              class="text-link result-toggle result-collapse"
              title="收起诊断结果"
              @click="resultCollapsed = !resultCollapsed"
              >收起<i
                class="pi pi-angle-double-right"
                aria-hidden="true"
            /></button>
          </template> </DiagnosisResultPanel
      ></div>
      <aside
        v-else
        class="empty-panel"
        ><i class="pi pi-wave-pulse" /><h3>诊断结果</h3
        ><p>开始诊断后分阶段展示融合结论、依据、根因和影响。</p
        ><p>故障场景设置不会改变实际资源状态。</p></aside
      >
    </div>
    <DiagnosisImportDrawer
      :visible="importDrawer"
      @close="closeImport"
    />
    <DiagnosisFeedbackDrawer v-if="diagnosis.result && diagnosis.runId" :visible="feedbackDrawer" :run-id="diagnosis.runId" :result="diagnosis.result" @close="feedbackDrawer=false" />
    <DiagnosisReportDrawer
      v-if="diagnosis.record"
      :visible="reportDrawer"
      :record="diagnosis.record"
      :exporting="diagnosis.exporting"
      :error="diagnosis.exportError"
      @close="reportDrawer = false"
      @download="diagnosis.download($event)"
    />
    <DiagnosisSourceDrawer
      :visible="sourceDrawer"
      :plans="sourceOptions"
      :preferred-id="sourceCopy?.planId ?? ''"
      :copy="!!sourceCopy"
      :busy="sourceBusy || diagnosis.locked"
      :error="sourceError"
      @close="sourceDrawer = false"
      @confirm="createSource"
    />
    <DecisionDialog
      :request="diagnosis.decision"
      @answer="diagnosis.answer"
    />
  </div>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDiagnosisStore } from '../stores/diagnosis';
import { usePreviewStore } from '../stores/preview';
import { usePlanningStore } from '../stores/planning';
import { useDiagnosisLeaveGuard } from '../composables/useDiagnosisLeaveGuard';
import type {
  DiagnosisScenario,
  DiagnosisScenarioSummary,
  DiagnosisScenarioVersion,
  DiagnosisVersionSummary,
  FaultInput,
} from '../types/diagnosis';
import DiagnosisImportDrawer from '../components/DiagnosisImportDrawer.vue';
import DiagnosisNetworkPanel from '../components/DiagnosisNetworkPanel.vue';
import DiagnosisProgressPanel from '../components/DiagnosisProgressPanel.vue';
import DiagnosisResultPanel from '../components/DiagnosisResultPanel.vue';
import DiagnosisReportDrawer from '../components/DiagnosisReportDrawer.vue';
import DiagnosisSourceDrawer from '../components/DiagnosisSourceDrawer.vue';
import DiagnosisFeedbackDrawer from '../components/DiagnosisFeedbackDrawer.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import { diagnosisLabel } from '../reports/diagnosis-report';
import { diagnosisOriginLabel } from '../services/diagnosis-presentation';

// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
const diagnosis = useDiagnosisStore();
// 运行目录使用中文分支名称，枚举只用于服务契约。
const demoLabels = {
  normal: '两路融合',
  'three-way': '三路融合',
  'low-confidence': '低置信度',
  'diagnosis-failed': '诊断失败',
  'impact-failed': '影响失败',
};
const preview = usePreviewStore();
const planning = usePlanningStore();
const router = useRouter(),
  route = useRoute();
const gisReady = computed(
  () => auth.can('diagnosis.view') && auth.can('situation.view') && !!diagnosis.record,
);
// 只跳转完整报告身份，离页是否放弃输入仍由原守卫决定。
function openGis() {
  if (gisReady.value && diagnosis.record)
    void router.push({ path: '/situation', query: { diagnosisId: diagnosis.record.id } });
}
const gisEditable = computed(
  () =>
    auth.can('situation.view') &&
    auth.can('diagnosis.view') &&
    diagnosis.canEdit &&
    !diagnosis.locked,
);
// 场景草稿交给 GIS 继续编辑，交接目标以外的导航仍由原离页守卫处理。
async function openGisEditor() {
  if (!gisEditable.value || !diagnosis.prepareGisEditing()) return;
  const query =
    diagnosis.scenarioId && diagnosis.versionId
      ? { faultEdit: '1', scenarioId: diagnosis.scenarioId, versionId: diagnosis.versionId }
      : { faultEdit: '1' };
  if (await router.push({ path: '/situation', query })) diagnosis.clearGisTransfer();
}
useDiagnosisLeaveGuard();
// 抽屉显示与地图筛选状态分别声明，便于独立维护。
const importDrawer = ref(false);
const feedbackDrawer = ref(false);
const reportDrawer = ref(false);
const resultCollapsed = ref(false),
  sourceDrawer = ref(false),
  sourceBusy = ref(false),
  sourceError = ref('');
const sourceCopy = ref<DiagnosisScenarioVersion | null>(null);
const sourceOptions = computed(() =>
  diagnosis.sources.plans.map((plan) => ({
    ...plan,
    canCreate: 'canCreate' in plan ? plan.canCreate : true,
    unavailableReason: 'unavailableReason' in plan ? plan.unavailableReason : null,
  })),
);
// 确认目标网络后才创建草稿；失败保留原工作区和抽屉选择。
async function openSource(copy: DiagnosisScenarioVersion | null = null) {
  sourceCopy.value = copy;
  sourceError.value = '';
  await diagnosis.refreshSources();
  sourceDrawer.value = true;
}
async function createSource(planId: string) {
  sourceBusy.value = true;
  sourceError.value = '';
  try {
    const success = sourceCopy.value
      ? await diagnosis.copyVersion(sourceCopy.value, planId)
      : await diagnosis.newScenario(planId);
    if (success) sourceDrawer.value = false;
    else sourceError.value = diagnosis.error || '场景创建未完成，当前输入已保留';
  } finally {
    sourceBusy.value = false;
  }
}
const showArchived = computed({
  get: () => diagnosis.showArchived,
  set: (value: boolean) => {
    void diagnosis.queryScenarios(1, value);
  },
});
const filters = ref('全部');
const focus = ref<{ type: FaultInput['objectType']; id: string; nonce: number } | null>(null);
const scenes = computed(
  () => diagnosis.workspace?.scenarios.filter((s) => s.archived === showArchived.value) ?? [],
);
const faults = computed(
  () =>
    diagnosis.view?.run.scenario.faults ??
    diagnosis.record?.faults ??
    diagnosis.draft?.faults ??
    [],
);
// 现象名称只读当前字典；缺项保留 ID，便于提交前核对而不猜测业务含义。
function faultSymptoms(ids: string[]) {
  return ids.length
    ? ids
        .map(
          (id) =>
            `${diagnosis.symptoms.find((item) => item.id === id)?.label || '名称未提供'}（${id}）`,
        )
        .join('；')
    : '未提供';
}
const currentSource = computed(() => diagnosis.record?.source ?? diagnosis.view?.source);
const copySource = computed(() => diagnosis.selectedVersion ?? diagnosis.view?.run.scenario);
// 展示上下文只引用当前诊断身份，现象字典仍由原服务提供。
const resultContext = computed(
  () => diagnosis.record?.id ?? diagnosis.view?.run.id ?? diagnosis.versionId,
);
watch(
  () => [
    preview.data?.resourceMeta.revision,
    planning.readRevision || planning.workspace?.revision,
  ],
  () => {
    void diagnosis.refreshSources();
  },
);
watch(
  () => diagnosis.network?.id,
  () => {
    focus.value = null;
  },
);
// 保存后返回或直接访问时，只按明确的场景与版本定位，不启动诊断。
let handledReturn = '';
watch(
  () => [route.query.scenarioId, route.query.versionId, !!diagnosis.workspace, diagnosis.locked, auth.generation],
  async () => {
    const { scenarioId, versionId } = route.query;
    if (scenarioId === undefined && versionId === undefined) { handledReturn = ''; return; }
    if (!diagnosis.workspace || diagnosis.locked) return;
    const target = JSON.stringify([auth.generation, scenarioId, versionId]);
    if (target === handledReturn) return;
    handledReturn = target;
    if (
      typeof scenarioId !== 'string' ||
      typeof versionId !== 'string' ||
      !scenarioId ||
      !versionId
    ) {
      diagnosis.error = '场景返回参数无效';
      return;
    }
    if (
      diagnosis.scenarioId !== scenarioId ||
      diagnosis.versionId !== versionId ||
      !diagnosis.draft
    )
      await diagnosis.selectVersion({ scenarioId, id: versionId });
  },
  { immediate: true },
);
// 沿用原版本查找与未保存确认，返回原 Promise 供事件调用方等待。
function selectScenarioVersion(
  scene: { versions: Pick<DiagnosisScenarioVersion, 'id' | 'scenarioId'>[] },
  event: Event,
) {
  return diagnosis.selectVersion(
    scene.versions.find((v) => v.id === (event.target as HTMLSelectElement).value)!,
  );
}
function faultCount(v: DiagnosisScenarioVersion | DiagnosisVersionSummary) {
  return 'faultCount' in v ? v.faultCount : v.faults.length;
}
function locate(type: FaultInput['objectType'], id: string) {
  focus.value = { type, id, nonce: Date.now() };
}
async function openImport() {
  if (!(await diagnosis.allowDiscard())) return;
  await diagnosis.refreshSources();
  importDrawer.value = true;
}
async function closeImport() {
  if (diagnosis.importing || diagnosis.busy) return;
  if (
    diagnosis.importPreview &&
    (await diagnosis.ask({
      title: '关闭导入预览',
      message: '放弃本次尚未提交的导入预览？已保存记录不变。',
      saveLabel: '放弃预览',
    })) !== 'save'
  )
    return;
  diagnosis.importPreview = null;
  importDrawer.value = false;
}
async function reset() {
  await diagnosis.reset();
  if (!diagnosis.error) {
    importDrawer.value = false;
    reportDrawer.value = false;
  }
}
</script>
<style scoped>
.list-error {
  color: #ffafb9;
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.demo-non-default {
  color: #f0c775;
  font-weight: 600;
}
.input-summary {
  grid-column: 1/-1;
  border-top: 1px solid #2c4563;
  padding-top: 10px;
  color: #acc9e2;
  font-size: 12px;
}
.input-summary h3 {
  margin: 0 0 8px;
  font-size: 12px;
}
.input-summary ul {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 160px;
  overflow-y: auto;
}
.input-summary li {
  padding: 8px 0;
  border-bottom: 1px solid #253e58;
  overflow-wrap: anywhere;
}
.input-summary li:last-child {
  border-bottom: 0;
}
.input-summary li > span {
  margin-left: 12px;
  color: #8fc3de;
}
.input-summary p {
  margin: 5px 0 0;
  line-height: 1.7;
}
.diagnosis-origin {
  color: #9db8cf;
  font-size: 12px;
  margin-bottom: 8px;
}
.demo-settings {
  flex-shrink: 0;
  padding: 10px 14px;
  margin-bottom: 12px;
  border: 1px solid #2c4563;
  border-radius: 6px;
  color: #acc9e2;
  font-size: 12px;
}
.demo-settings summary {
  cursor: pointer;
}
.demo-settings p {
  margin: 10px 0;
}
.demo-settings label {
  max-width: 340px;
}
.page-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.page-heading h1 {
  font-size: 22px;
  margin: 0;
}
.page-actions,
.buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.diagnosis-workspace {
  position: relative;
  display: grid;
  grid-template-columns: 235px minmax(440px, 1fr) 350px;
  gap: 15px;
  align-items: stretch;
  flex: 1;
  min-height: 0;
}
.diagnosis-page {
  height: 100%;
  min-height: 640px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 提示和轮询状态保留自身高度，工作区在剩余空间内滚动。 */
.diagnosis-page > :not(.diagnosis-workspace) {
  flex-shrink: 0;
}
.diagnosis-workspace.result-collapsed {
  grid-template-columns: 235px minmax(440px, 1fr);
}
.result-workspace {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 收起后释放结果列，把手借用右侧留白，不挤占或覆盖地图内容。 */
.diagnosis-workspace.result-collapsed .result-workspace {
  position: absolute;
  top: 50%;
  right: -15px;
  transform: translateY(-50%);
  z-index: 4;
  overflow: visible;
}
.result-restore {
  flex-direction: column;
  gap: 7px;
  width: 30px;
  min-height: 84px;
  padding: 8px 4px;
  background: #132b41f2;
  border-color: #3d6382;
  border-radius: 6px 0 0 6px;
  box-shadow: 0 2px 8px #07111b66;
}
.result-restore span {
  writing-mode: vertical-rl;
  letter-spacing: 2px;
}
.result-restore:focus-visible {
  outline: 2px solid #6bbfee;
  outline-offset: -3px;
}
.result-toggle {
  flex-shrink: 0;
  padding: 7px;
  text-align: right;
}
.result-collapse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  white-space: nowrap;
}
.scenario-list {
  background: #101e33;
  border: 1px solid #29425f;
  border-radius: 6px;
  padding: 12px;
  min-height: 0;
  overflow: auto;
}
.list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  padding: 11px 2px;
  color: #98bbd7;
  gap: 10px;
}
/* 分组标题与归档开关各占一行内的位置，不继承表单标签的纵排。 */
.list-heading:not(:first-child) {
  margin-top: 12px;
  border-top: 1px solid #29425f;
}
.list-heading label {
  flex-direction: row;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
  font-size: 11px;
}
.list-heading input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: #62b5ed;
}
.list-heading > span {
  min-width: 22px;
  padding: 2px 6px;
  border-radius: 4px;
  background: #1a3048;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.scenario-list > p {
  padding: 4px 2px;
  font-size: 12px;
  line-height: 1.7;
}
.scene-card {
  background: #142840;
  border: 1px solid #2b4763;
  border-radius: 5px;
  margin-bottom: 9px;
}
.scene-select {
  display: grid;
  gap: 8px;
  padding: 11px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  color: #bfd5eb;
}
.scene-select strong,
.history-card strong {
  font-size: 12px;
}
.scene-select small,
.history-card small {
  font-size: 10px;
  color: #8facc7;
}
.scene-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 0 10px 9px;
}
.scene-actions select {
  width: 115px;
}
.history-card {
  display: grid;
  gap: 7px;
  text-align: left;
  width: 100%;
  padding: 11px;
  background: #122239;
  border: 1px solid #2c425d;
  border-radius: 5px;
  color: #b8d0e7;
  margin-bottom: 8px;
}
.active {
  border-color: #63b3e4;
  background: #193653;
}
.diagnosis-main {
  display: grid;
  gap: 13px;
  min-width: 0;
  min-height: 0;
  grid-template-rows: auto;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-anchor: none;
  scrollbar-gutter: stable;
}
.context-card {
  padding: 13px 16px;
  border: 1px solid #2c4563;
  background: #14263b;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
  border-radius: 6px;
}
.context-card > div {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.context-card small {
  color: #8aa7c1;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.context-card strong {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.source-state {
  font-size: 11px;
  color: #e7c089;
}
.draft-toolbar {
  padding: 15px;
  background: #102239;
  border: 1px solid #2a4866;
  border-radius: 6px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 13px;
}
.draft-toolbar label {
  display: grid;
  gap: 7px;
  font-size: 12px;
  color: #a7c0d7;
}
.draft-toolbar .buttons,
.draft-toolbar > small,
.submit-row {
  grid-column: 1/-1;
}
.draft-toolbar > small {
  color: #829cb9;
  font-size: 11px;
  line-height: 1.8;
}
.submit-row {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 15px;
}
.submit-row label {
  flex: 1;
}
select {
  width: 100%;
  padding: 8px;
  background: #11243c;
  border: 1px solid #355675;
  color: #c2d9ee;
  border-radius: 4px;
  font-size: 12px;
}
.feedback {
  padding: 11px 15px;
  font-size: 12px;
  line-height: 1.8;
  margin-bottom: 13px;
  border-radius: 4px;
}
.feedback a {
  color: #a0dcff;
}
.error {
  background: #4a2435;
  color: #ffb2bf;
}
.warning {
  background: #463b25;
  color: #ecd39b;
}
.success {
  background: #173d3a;
  color: #99d7c1;
}
.empty-panel {
  padding: 27px;
  background: #102137;
  border: 1px solid #2b4661;
  color: #8ba7c3;
  font-size: 13px;
  line-height: 1.9;
  border-radius: 6px;
  min-height: 240px;
}
.empty-panel i {
  font-size: 30px;
  color: #6bb4de;
}
.empty-copy {
  font-size: 12px;
  color: #7e99b4;
  line-height: 1.8;
}
@media (max-width: 1450px) {
  .diagnosis-workspace {
    grid-template-columns: 210px minmax(360px, 1fr) 310px;
  }
  .diagnosis-workspace.result-collapsed {
    grid-template-columns: 210px minmax(360px, 1fr);
  }
  .page-actions {
    justify-content: flex-end;
  }
  .draft-toolbar {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 1100px) {
  .diagnosis-page {
    height: auto;
    overflow: visible;
  }
  .diagnosis-workspace,
  .diagnosis-workspace.result-collapsed {
    grid-template-columns: 210px minmax(0, 1fr);
  }
  .result-workspace {
    grid-column: 1/-1;
    max-height: 750px;
  }
  .diagnosis-main {
    min-height: 650px;
  }
  .scenario-list {
    max-height: 750px;
  }
}
@media (max-width: 760px) {
  .diagnosis-page {
    min-width: 0;
    min-height: 0;
  }
  .diagnosis-workspace,
  .diagnosis-workspace.result-collapsed {
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
    flex: none;
  }
  .scenario-list {
    min-width: 0;
    max-height: 240px;
  }
  .diagnosis-main {
    min-height: 0;
    overflow-y: visible;
    scrollbar-gutter: auto;
  }
  .result-workspace {
    grid-column: auto;
    max-height: none;
    min-width: 0;
    overflow: visible;
  }
  .diagnosis-workspace.result-collapsed .result-workspace {
    position: static;
    transform: none;
  }
  .result-restore {
    width: auto;
    min-height: 36px;
    flex-direction: row;
  }
  .result-restore span {
    writing-mode: horizontal-tb;
    letter-spacing: 0;
  }
  .page-heading,
  .context-card,
  .submit-row {
    flex-direction: column;
    align-items: stretch;
  }
  .page-actions {
    justify-content: flex-start;
  }
  .scene-actions {
    flex-wrap: wrap;
  }
}
@media (max-width: 600px) {
  .scenario-list {
    max-height: 220px;
  }
  .page-actions,
  .buttons {
    width: 100%;
  }
  .diagnosis-page .btn {
    max-width: 100%;
    white-space: normal;
  }
  .empty-panel {
    min-height: 0;
    padding: 16px;
  }
}
</style>
