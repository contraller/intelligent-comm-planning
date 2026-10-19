<template>
  <div class="diagnosis-page">
    <div class="page-heading"
      ><div><h1>故障诊断</h1><p>场景配置、推理依据与影响分析 · 结果绑定确定的网络快照</p></div
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
          @click="diagnosis.newScenario()"
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
        <button
          class="btn"
          :disabled="diagnosis.locked"
          v-if="auth.can('diagnosis.reset')"
          @click="reset"
          >重置诊断数据</button
        >
      </div></div
    >
    <div
      v-if="diagnosis.network?.workflow?.interferenceOrigin"
      class="feedback"
      >抗干扰网络：{{ diagnosis.network.preset }} · 来自分析
      {{
        diagnosis.network.workflow.interferenceOrigin.analysisId
      }}。仅使用此完整配置对应的诊断预设。</div
    >
    <div
      v-if="diagnosis.loadError"
      class="feedback error"
      role="alert"
      >{{ diagnosis.loadError }}。内置历史记录仍可查看，恢复写入需重新加载或显式重置。</div
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
        to="/planning"
        >前往网络规划保存并确认方案</RouterLink
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
    <div class="diagnosis-workspace">
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
              {{ scene.versions.at(-1)!.faults.length }} 个故障对象</small
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
        <div class="list-heading"
          ><strong>诊断运行记录</strong
          ><span>{{ diagnosis.workspace?.runs.length ?? 0 }}</span></div
        >
        <button
          v-for="run in [...(diagnosis.workspace?.runs ?? [])].reverse()"
          :key="run.id"
          class="history-card"
          :class="{ active: diagnosis.runId === run.id }"
          @click="diagnosis.selectRun(run.id)"
          ><strong>{{ run.scenario.name }}</strong
          ><small>{{ new Date(run.startedAt).toLocaleString() }}</small
          ><small>场景 v{{ run.scenario.version }} · {{ run.demo }}</small></button
        >
        <div class="list-heading"><strong>内置历史诊断</strong></div>
        <button
          v-for="item in diagnosis.legacy"
          :key="item.id"
          class="history-card"
          :class="{ active: diagnosis.record?.id === item.id }"
          @click="diagnosis.selectLegacy(item.id)"
          ><strong>{{ item.name }}</strong
          ><small>{{ item.network.id }} · 历史快照</small></button
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
            @click="diagnosis.copyVersion(copySource)"
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
                >{{ plan.name }} / {{ plan.taskId }} / {{ plan.id.slice(0, 8) }}</option
              ></select
            ></label
          >
          <label
            >教学模板<select
              :disabled="!diagnosis.canEdit || diagnosis.locked"
              value=""
              @change="diagnosis.applyPreset(($event.target as HTMLSelectElement).value)"
              ><option value="">选择预设，完整演示诊断流程</option
              ><option
                v-for="preset in diagnosis.availablePresets"
                :key="preset.id"
                :value="preset.id"
                >{{ preset.label }}</option
              ></select
            ></label
          >
          <div class="buttons"
            ><button
              class="btn small"
              :disabled="!diagnosis.canEdit || diagnosis.locked"
              @click="openEditor"
              >编辑场景</button
            ><button
              class="btn small"
              :class="{ primary: drawing }"
              :disabled="!diagnosis.canEdit || diagnosis.locked"
              @click="drawing = !drawing"
              >连续标绘</button
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
          <div class="submit-row"
            ><label
              >演示分支<select
                v-model="diagnosis.demo"
                :disabled="!auth.can('diagnosis.execute') || diagnosis.locked"
                ><option value="normal">两路融合</option
                ><option value="low-confidence">候选分歧 / 低置信度</option
                ><option value="diagnosis-failed">诊断执行失败</option
                ><option value="impact-failed">影响分析失败</option></select
              ></label
            ><button
              class="btn primary"
              :disabled="!diagnosis.canExecute || diagnosis.locked"
              @click="diagnosis.submit"
              >{{ diagnosis.dirty ? '保存并开始诊断' : '开始诊断' }}</button
            ></div
          >
          <small
            >规则 / 图谱 / ML 权重：0.5 / 0.5 / 0；阈值 0.6；考虑备份路由。{{
              diagnosis.dirty ? '当前有未保存输入。' : ''
            }}</small
          >
        </div>
        <DiagnosisProgressPanel
          v-if="diagnosis.view"
          :view="diagnosis.view"
          :query-error="diagnosis.queryError"
          :busy="diagnosis.busy"
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
          :drawing="drawing"
          :selected="selected"
          :focus="focus"
          @pick="pick"
          @configure="openEditor"
          @drawing="drawing = $event"
          @clear="selected = []"
          @filters="filters = $event"
        />
        <div
          v-else
          class="empty-panel"
          >选择场景或历史记录查看网络。新任务需要当前有效、已确认的规划方案。</div
        >
      </main>
      <DiagnosisResultPanel
        v-if="diagnosis.result"
        :result="diagnosis.result"
        :symptoms="diagnosis.symptoms"
        :context-key="resultContext"
        :impact-ready="diagnosis.impactReady"
        :report-ready="!!diagnosis.record"
        :exporting="diagnosis.exporting"
        @locate="locate"
        @report="reportDrawer = true"
        @export-impact="diagnosis.download($event, filters)"
      />
      <aside
        v-else
        class="empty-panel"
        ><i class="pi pi-wave-pulse" /><h3>诊断结果</h3
        ><p>开始诊断后分阶段展示融合结论、依据、根因和影响。</p
        ><p>当前输入必须匹配预生成结果；故障注入不会改变实际资源状态。</p></aside
      >
    </div>
    <DiagnosisScenarioDrawer
      v-if="diagnosis.draft && diagnosis.network"
      :visible="scenarioDrawer"
      :draft="diagnosis.draft"
      :network="diagnosis.network"
      :symptoms="diagnosis.symptoms"
      :interference-ids="diagnosis.interferenceIds"
      :selected="selected"
      @close="closeEditor"
      @apply="apply"
      @dirty="diagnosis.formDirty = $event"
    />
    <DiagnosisImportDrawer
      :visible="importDrawer"
      @close="closeImport"
    />
    <DiagnosisReportDrawer
      v-if="diagnosis.record"
      :visible="reportDrawer"
      :record="diagnosis.record"
      :exporting="diagnosis.exporting"
      :error="diagnosis.error"
      @close="reportDrawer = false"
      @download="diagnosis.download($event)"
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
import { useRouter } from 'vue-router';
import { env } from '../config/env';
import { useDiagnosisStore } from '../stores/diagnosis';
import { usePreviewStore } from '../stores/preview';
import { usePlanningStore } from '../stores/planning';
import { useDiagnosisLeaveGuard } from '../composables/useDiagnosisLeaveGuard';
import type { DiagnosisDraft, DiagnosisScenario, FaultInput } from '../types/diagnosis';
import DiagnosisScenarioDrawer from '../components/DiagnosisScenarioDrawer.vue';
import DiagnosisImportDrawer from '../components/DiagnosisImportDrawer.vue';
import DiagnosisNetworkPanel from '../components/DiagnosisNetworkPanel.vue';
import DiagnosisProgressPanel from '../components/DiagnosisProgressPanel.vue';
import DiagnosisResultPanel from '../components/DiagnosisResultPanel.vue';
import DiagnosisReportDrawer from '../components/DiagnosisReportDrawer.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import { diagnosisLabel } from '../reports/diagnosis-report';

// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
const diagnosis = useDiagnosisStore();
const preview = usePreviewStore();
const planning = usePlanningStore();
const router = useRouter();
const gisReady = computed(
  () =>
    env.mode === 'mock' &&
    auth.can('diagnosis.view') &&
    auth.can('situation.view') &&
    !!diagnosis.record,
);
// 只跳转完整报告身份，离页是否放弃输入仍由原守卫决定。
function openGis() {
  if (gisReady.value && diagnosis.record)
    void router.push({ path: '/situation', query: { diagnosisId: diagnosis.record.id } });
}
useDiagnosisLeaveGuard();
// 抽屉显示与地图筛选状态分别声明，便于独立维护。
const scenarioDrawer = ref(false);
const importDrawer = ref(false);
const reportDrawer = ref(false);
const drawing = ref(false);
const showArchived = ref(false);
const filters = ref('全部');
const selected = ref<{ objectType: FaultInput['objectType']; objectId: string }[]>([]);
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
const currentSource = computed(() => diagnosis.record?.source ?? diagnosis.view?.source);
const copySource = computed(() => diagnosis.selectedVersion ?? diagnosis.view?.run.scenario);
// 展示上下文只引用当前诊断身份，现象字典仍由原服务提供。
const resultContext = computed(
  () => diagnosis.record?.id ?? diagnosis.view?.run.id ?? diagnosis.versionId,
);
watch(
  () => [preview.data?.resourceMeta.revision, planning.workspace?.revision],
  () => {
    void diagnosis.refreshSources();
  },
);
watch(
  () => diagnosis.network?.id,
  () => {
    selected.value = [];
    focus.value = null;
    drawing.value = false;
  },
);
watch(
  () => diagnosis.canEdit,
  (editable) => {
    if (!editable) drawing.value = false;
  },
);
// 沿用原版本查找与未保存确认，返回原 Promise 供事件调用方等待。
function selectScenarioVersion(scene: DiagnosisScenario, event: Event) {
  return diagnosis.selectVersion(
    scene.versions.find((v) => v.id === (event.target as HTMLSelectElement).value)!,
  );
}
function pick(objectType: FaultInput['objectType'], objectId: string) {
  const index = selected.value.findIndex(
    (t) => t.objectType === objectType && t.objectId === objectId,
  );
  if (index >= 0) selected.value.splice(index, 1);
  else selected.value.push({ objectType, objectId });
}
function locate(type: FaultInput['objectType'], id: string) {
  focus.value = { type, id, nonce: Date.now() };
}
function openEditor() {
  if (diagnosis.canEdit) scenarioDrawer.value = true;
}
function apply(draft: DiagnosisDraft) {
  diagnosis.updateDraft(draft);
  diagnosis.formDirty = false;
  scenarioDrawer.value = false;
  selected.value = [];
}
async function closeEditor() {
  if (
    diagnosis.formDirty &&
    (await diagnosis.ask({
      title: '未应用的表单',
      message: '放弃抽屉内尚未应用的修改？已经应用到场景草稿的内容会保留。',
      saveLabel: '放弃表单修改',
      cancelLabel: '继续编辑',
    })) !== 'save'
  )
    return;
  diagnosis.formDirty = false;
  scenarioDrawer.value = false;
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
    scenarioDrawer.value = false;
    importDrawer.value = false;
    reportDrawer.value = false;
    drawing.value = false;
    selected.value = [];
  }
}
</script>
<style scoped>
.diagnosis-page {
  padding-bottom: 20px;
}
.page-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  margin-bottom: 17px;
}
.page-heading h1 {
  font-size: 24px;
  margin: 0 0 8px;
}
.page-heading p {
  color: #8ca5c0;
  font-size: 12px;
}
.page-actions,
.buttons {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.diagnosis-workspace {
  display: grid;
  grid-template-columns: 235px minmax(440px, 1fr) 350px;
  gap: 15px;
  align-items: start;
}
.scenario-list {
  background: #101e33;
  border: 1px solid #29425f;
  border-radius: 6px;
  padding: 12px;
  max-height: calc(100vh - 250px);
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
  .page-heading {
    align-items: start;
  }
  .page-actions {
    max-width: 440px;
    justify-content: flex-end;
  }
  .draft-toolbar {
    grid-template-columns: 1fr;
  }
}
</style>
