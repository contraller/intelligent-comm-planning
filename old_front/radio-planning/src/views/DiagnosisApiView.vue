<template>
  <div class="fault-page">
    <header class="heading">
      <div><h1>故障诊断</h1><p>正式方案 · 故障场景 · 诊断与影响分析</p></div>
      <form class="task-picker" @submit.prevent="load"><label for="fault-task">规划任务</label><input id="fault-task" v-model.trim="taskId" placeholder="输入任务编号" /><button class="btn" :disabled="busy || !taskId">查询</button></form>
    </header>
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <p v-if="notice" class="feedback success">{{ notice }}</p>
    <div v-if="loading" class="feedback">正在读取故障诊断数据…</div>
    <div v-else-if="taskId && !source" class="feedback warning">
      {{ sourceReason || '该任务当前没有可用于故障诊断的已确认方案。' }}
      <RouterLink to="/planning">前往网络规划</RouterLink>
    </div>
    <div v-if="source" class="source-line"><strong>{{ source.name }}</strong><span>{{ source.version }} · {{ source.planId }}</span><span>方案修订 {{ source.revision }}</span><span>资源版本 {{ source.resourceRevision }}</span></div>

    <div class="work-grid">
      <aside class="scene-list">
        <div class="section-head"><h2>故障场景</h2><button v-if="canScenario" class="btn small" :disabled="busy || !plan" @click="newScenario">新建</button></div>
        <p v-if="!scenarios.length" class="muted">暂无已保存场景</p>
        <button v-for="item in scenarios" :key="item.scenarioId" class="scene" :class="{ selected: selected?.scenarioId === item.scenarioId }" @click="selectScenario(item)">
          <strong>{{ item.scenario_name }}</strong><span>v{{ item.versionNo }} · {{ item.faults.length }} 个故障</span><small>{{ item.archived ? '已归档' : '可用' }} · {{ item.savedAt }}</small>
        </button>
      </aside>

      <main class="editor">
        <div class="section-head"><h2>场景配置</h2><span v-if="selected" class="muted">{{ selected.scenarioId }} / v{{ selected.versionNo }}</span></div>
        <template v-if="source && plan">
          <label>场景名称<input v-model.trim="draft.scenario_name" :disabled="!editable" maxlength="100" /></label>
          <label>场景说明<textarea v-model="draft.description" :disabled="!editable" rows="2" /></label>
          <div class="section-head"><h3>故障对象</h3><button v-if="canScenario" class="btn small" :disabled="!editable" @click="addFault">添加故障</button></div>
          <div v-for="(fault, index) in draft.faults" :key="index" class="fault-row">
            <label>对象类型<select v-model="fault.object_type" :disabled="!editable" @change="fault.object_id = ''; fault.fault_type = fault.object_type === 'LINK' ? 'LINK_DOWN' : 'HW_FAILURE'">
              <option value="NODE">节点</option><option value="DEVICE">设备</option><option value="LINK">链路</option>
            </select></label>
            <label>对象<select v-model="fault.object_id" :disabled="!editable"><option value="">请选择</option><option v-for="objectId in objectIds(fault.object_type)" :key="objectId" :value="objectId">{{ objectId }}</option></select></label>
            <label>故障类型<select v-model="fault.fault_type" :disabled="!editable"><option v-for="kind in faultKinds(fault.object_type)" :key="kind" :value="kind">{{ faultNames[kind] }}</option></select></label>
            <label>现象编号（可选，逗号分隔）<input :value="fault.symptom_ids.join(', ')" :disabled="!editable" @change="fault.symptom_ids = ($event.target as HTMLInputElement).value.split(',').map(x => x.trim()).filter(Boolean)" /></label>
            <button v-if="canScenario" class="icon-btn" title="移除故障" aria-label="移除故障" :disabled="!editable" @click="draft.faults.splice(index, 1)"><i class="pi pi-times" /></button>
          </div>
          <div class="actions">
            <button v-if="canScenario" class="btn" :disabled="!editable || !draft.faults.length" @click="validate">校验场景</button>
            <button v-if="canScenario" class="btn primary" :disabled="!editable || !draft.faults.length" @click="save">保存场景版本</button>
            <button v-if="selected && canScenario" class="btn" :disabled="busy" @click="archive">{{ selected.archived ? '恢复场景' : '归档场景' }}</button>
          </div>
        </template>
        <p v-else class="muted">请选择一个有已确认方案的规划任务。</p>

        <div class="section-head stage-title"><h2>分析任务</h2><span v-if="analysis">{{ analysis.state }} · {{ Math.round(analysis.progress * 100) }}%</span></div>
        <div class="actions">
          <button v-if="canExecute" class="btn primary" :disabled="busy || !readyToDiagnose" @click="diagnose">提交诊断</button>
          <button v-if="canExecute" class="btn primary" :disabled="busy || !analysis?.diagnosisReady || !!analysis.impactTaskId || !sameSource" @click="impact">提交影响分析</button>
          <button class="btn" :disabled="busy || !diagnoseTaskId" @click="refresh">刷新结果</button>
        </div>
        <div v-if="diagnoseTaskId" class="task-ids"><span>诊断任务 {{ diagnoseTaskId }}</span><span v-if="impactTaskId">影响任务 {{ impactTaskId }}</span></div>
        <div v-if="analysis" class="phases"><div v-for="phase in analysis.phases" :key="phase.name"><strong>{{ phase.name }}</strong><span>{{ phase.status }} · {{ Math.round(phase.progress * 100) }}%</span></div></div>
        <p v-if="analysis?.error" class="feedback error">{{ analysis.error }}</p>
      </main>

      <aside class="results">
        <div class="section-head"><h2>计算结果</h2><span v-if="analysis?.reportReady">报告已就绪</span></div>
        <template v-if="analysis?.diagnosisReady && analysis.diagnosis">
          <p class="muted">{{ analysis.diagnosis.fusion_mode }} · 数据来源 {{ analysis.diagnosis.data_source }}</p>
          <article v-for="(row, index) in analysis.diagnosis.results" :key="index" class="result-item">
            <strong>{{ row.fault_object.object_type }} {{ row.fault_object.object_id }}</strong>
            <div>{{ row.fused.fault_type || '未能判断类型' }} · 置信度 {{ Math.round(row.fused.confidence * 100) }}%</div>
            <p>{{ row.fused.root_cause || '暂无明确根因' }}</p>
            <small v-if="row.fused.need_manual_review">需要人工研判</small>
            <details><summary>推理依据</summary><div v-for="branch in row.branches" :key="branch.source">{{ branch.source }}：{{ branch.disabled_reason || (branch.confidence === null ? '无结果' : `${Math.round(branch.confidence * 100)}%`) }}<pre>{{ JSON.stringify(branch.evidence, null, 2) }}</pre></div></details>
          </article>
        </template>
        <p v-else class="muted">诊断成功后显示结论与依据。</p>
        <template v-if="analysis?.impactReady && analysis.impact">
          <h3>影响范围</h3><div class="metrics"><span>节点 {{ analysis.impact.summary.affected_node_count }}</span><span>链路 {{ analysis.impact.summary.affected_link_count }}</span><span>损失 {{ analysis.impact.summary.total_bandwidth_loss_kbps }} kbps</span></div>
          <details><summary>受影响节点</summary><div v-for="row in analysis.impact.affected_nodes" :key="row.node_id">{{ row.node_id }} · {{ row.state }} · {{ row.reason }}</div></details>
          <details><summary>受影响链路</summary><div v-for="row in analysis.impact.affected_links" :key="row.link_id">{{ row.link_id }} · {{ row.state }} · {{ row.reason }}</div></details>
          <h3>处置建议</h3><p v-for="item in analysis.suggestions?.suggestions || []" :key="item.priority">{{ item.priority }}. {{ item.action }} <small>({{ item.source }})</small></p>
          <p v-if="analysis.reportReady" class="muted">报告数据来源：{{ analysis.report?.data_source }} · {{ analysis.report?.generated_at }}</p>
        </template>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useTaskInputStore } from '../stores/task-input';
import { faultHttp, httpService } from '../services/http';
import type { ApiPlan } from '../types/planning-api';
import type { FaultAnalysis, FaultInputApi, FaultKind, FaultObjectKind, FaultScenario, FaultScenarioInput, FaultSource } from '../types/fault-api';

const auth = useAuthStore(), task = useTaskInputStore(), route = useRoute();
const taskId = ref(''), source = ref<FaultSource | null>(null), sourceReason = ref(''), plan = ref<ApiPlan | null>(null);
const scenarios = ref<FaultScenario[]>([]), selected = ref<FaultScenario | null>(null);
const emptyDraft = (): FaultScenarioInput => ({ scenario_name: '', description: '', faults: [] });
const draft = ref<FaultScenarioInput>(emptyDraft());
const analysis = ref<FaultAnalysis | null>(null), diagnoseTaskId = ref(''), impactTaskId = ref('');
const error = ref(''), notice = ref(''), loading = ref(false), busy = ref(false);
const canScenario = computed(() => auth.can('diagnosis.scenario'));
const canExecute = computed(() => auth.can('diagnosis.execute'));
const editable = computed(() => canScenario.value && !!source.value && !!plan.value && !selected.value?.archived && !busy.value);
const sameSource = computed(() => !!source.value && !!analysis.value && analysis.value.planId === source.value.planId
  && analysis.value.source.plan_revision === source.value.revision && analysis.value.source.resource_revision === source.value.resourceRevision);
const readyToDiagnose = computed(() => !!source.value && !!selected.value && !selected.value.archived && !['PENDING', 'RUNNING'].includes(analysis.value?.state ?? '') && selected.value.planId === source.value.planId
  && selected.value.planRevision === source.value.revision && selected.value.resourceRevision === source.value.resourceRevision
  && JSON.stringify(draft.value) === JSON.stringify({ scenario_name: selected.value.scenario_name, description: selected.value.description, faults: selected.value.faults }));
const faultNames: Record<FaultKind, string> = { HW_FAILURE: '硬件故障', LINK_DOWN: '链路中断', SW_CONFIG: '配置故障', EMI: '电磁干扰' };
const faultKinds = (kind: FaultObjectKind): FaultKind[] => kind === 'LINK' ? ['LINK_DOWN', 'EMI'] : kind === 'DEVICE' ? ['HW_FAILURE', 'SW_CONFIG'] : ['HW_FAILURE', 'SW_CONFIG', 'EMI'];
function objectIds(kind: FaultObjectKind) { return kind === 'NODE' ? plan.value?.result.nodes.map(x => x.id) ?? [] : kind === 'DEVICE' ? plan.value?.result.devices.map(x => x.id) ?? [] : plan.value?.result.links.map(x => x.id) ?? []; }
function selectScenario(item: FaultScenario) { selected.value = item; draft.value = { scenario_name: item.scenario_name, description: item.description, faults: structuredClone(item.faults) }; notice.value = ''; }
function newScenario() { selected.value = null; draft.value = emptyDraft(); notice.value = ''; }
function addFault() { draft.value.faults.push({ object_type: 'NODE', object_id: '', fault_type: 'HW_FAILURE', symptom_ids: [] }); }
function message(reason: unknown) { error.value = reason instanceof Error ? reason.message : '请求失败'; }
let timer: ReturnType<typeof setTimeout> | undefined, generation = 0, loadSerial = 0;
function stopPolling() { if (timer) clearTimeout(timer); timer = undefined; generation++; }
function storageKey() { return `sr5-analysis:${taskId.value}`; }
function remember() {
  try { sessionStorage.setItem(storageKey(), JSON.stringify({ diagnoseTaskId: diagnoseTaskId.value, impactTaskId: impactTaskId.value,
    diagnosisRequest, diagnosisSignature, impactRequest, impactSignature })); } catch { /* 浏览器禁用会话存储时仍可手动刷新当前页面。 */ }
}
function restore() {
  try { const saved = JSON.parse(sessionStorage.getItem(storageKey()) || '{}');
    diagnoseTaskId.value = typeof saved.diagnoseTaskId === 'string' ? saved.diagnoseTaskId : '';
    impactTaskId.value = typeof saved.impactTaskId === 'string' ? saved.impactTaskId : '';
    diagnosisRequest = typeof saved.diagnosisRequest === 'string' ? saved.diagnosisRequest : '';
    diagnosisSignature = typeof saved.diagnosisSignature === 'string' ? saved.diagnosisSignature : '';
    impactRequest = typeof saved.impactRequest === 'string' ? saved.impactRequest : '';
    impactSignature = typeof saved.impactSignature === 'string' ? saved.impactSignature : '';
  } catch { diagnoseTaskId.value = ''; impactTaskId.value = ''; diagnosisRequest = ''; diagnosisSignature = ''; impactRequest = ''; impactSignature = ''; }
}
async function load() {
  if (!taskId.value || busy.value) return;
  stopPolling(); const token = generation, serial = ++loadSerial; loading.value = true; error.value = ''; notice.value = '';
  source.value = null; plan.value = null; scenarios.value = []; selected.value = null; draft.value = emptyDraft(); analysis.value = null;
  try {
    const currentTask = taskId.value;
    const [sources, rows] = await Promise.all([faultHttp.sources(currentTask), faultHttp.scenarios(currentTask)]);
    if (token !== generation || currentTask !== taskId.value) return;
    source.value = sources.items[0] ?? null; sourceReason.value = sources.reason ?? ''; scenarios.value = rows;
    if (source.value) {
      const currentPlan = await httpService.getPlanningPlan({ context: 'planning', taskId: currentTask, planId: source.value.planId });
      if (token !== generation || currentTask !== taskId.value) return;
      if (currentPlan.state !== 'CONFIRMED' || !currentPlan.current || currentPlan.sourceChanged || currentPlan.revision !== source.value.revision || currentPlan.resourceRevision !== source.value.resourceRevision) throw new Error('规划方案快照与诊断来源不一致，请重新确认方案');
      plan.value = currentPlan;
    }
    restore(); if (diagnoseTaskId.value) void refresh();
  } catch (reason) { message(reason); }
  finally { if (serial === loadSerial) loading.value = false; }
}
async function validate() {
  if (!source.value || !editable.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await faultHttp.validate(taskId.value, source.value.planId, draft.value); notice.value = '场景校验通过'; }
  catch (reason) { message(reason); } finally { busy.value = false; }
}
async function save() {
  if (!source.value || !editable.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const current = source.value;
    await faultHttp.validate(taskId.value, current.planId, draft.value);
    const saved = await faultHttp.save(taskId.value, current.planId, draft.value, selected.value?.scenarioId);
    scenarios.value = await faultHttp.scenarios(taskId.value); selectScenario(scenarios.value.find(x => x.scenarioId === saved.scenarioId) ?? saved);
    notice.value = `场景版本 v${saved.versionNo} 已保存`;
  } catch (reason) { message(reason); } finally { busy.value = false; }
}
async function archive() {
  if (!selected.value || busy.value || !canScenario.value) return;
  busy.value = true; error.value = '';
  try { const saved = await faultHttp.archive(taskId.value, selected.value.scenarioId, !selected.value.archived); scenarios.value = await faultHttp.scenarios(taskId.value); selectScenario(scenarios.value.find(x => x.scenarioId === saved.scenarioId) ?? saved); notice.value = saved.archived ? '场景已归档' : '场景已恢复'; }
  catch (reason) { message(reason); } finally { busy.value = false; }
}
// 请求标识先保存在页面内；提交超时后重试沿用同一编号，避免重复创建任务。
let diagnosisRequest = '', diagnosisSignature = '', impactRequest = '', impactSignature = '';
async function diagnose() {
  if (!source.value || !selected.value || !readyToDiagnose.value || busy.value || !canExecute.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  const signature = JSON.stringify([taskId.value, source.value.planId, selected.value.scenarioId, selected.value.versionId]);
  if (diagnosisSignature !== signature) { diagnosisRequest = crypto.randomUUID(); diagnosisSignature = signature; }
  remember();
  try {
    const saved = await faultHttp.diagnose(taskId.value, source.value.planId, selected.value.scenarioId, selected.value.versionId, diagnosisRequest);
    diagnoseTaskId.value = saved.taskId; impactTaskId.value = ''; diagnosisRequest = ''; diagnosisSignature = ''; analysis.value = null; remember(); await refresh();
  } catch (reason) { message(reason); } finally { busy.value = false; }
}
async function impact() {
  if (!source.value || !analysis.value?.diagnosisReady || !sameSource.value || impactTaskId.value || busy.value || !canExecute.value) return;
  busy.value = true; error.value = '';
  const signature = JSON.stringify([taskId.value, source.value.planId, diagnoseTaskId.value]);
  if (impactSignature !== signature) { impactRequest = crypto.randomUUID(); impactSignature = signature; }
  remember();
  try { const saved = await faultHttp.impact(taskId.value, source.value.planId, diagnoseTaskId.value, impactRequest); impactTaskId.value = saved.taskId; impactRequest = ''; impactSignature = ''; remember(); await refresh(); }
  catch (reason) { message(reason); } finally { busy.value = false; }
}
async function refresh() {
  if (!diagnoseTaskId.value) return;
  stopPolling(); const token = generation, currentTask = taskId.value, currentDiagnosis = diagnoseTaskId.value, currentImpact = impactTaskId.value;
  try {
    const next = await faultHttp.analysis(currentTask, currentDiagnosis, currentImpact || undefined);
    if (token !== generation || currentTask !== taskId.value || currentDiagnosis !== diagnoseTaskId.value || currentImpact !== impactTaskId.value) return;
    analysis.value = next; error.value = '';
    if (next.state === 'PENDING' || next.state === 'RUNNING') timer = setTimeout(() => void refresh(), 2000);
  } catch (reason) { if (token === generation) message(reason); }
}
watch(() => task.saved?.taskId, value => { if (!taskId.value && value) taskId.value = value; });
onMounted(() => { const queryTask = route.query.task_id; taskId.value = typeof queryTask === 'string' && queryTask || task.saved?.taskId || ''; if (taskId.value) void load(); });
onBeforeUnmount(stopPolling);
</script>

<style scoped>
.fault-page { padding: 20px; color: #dce8f3; }
.heading, .section-head, .source-line, .actions, .task-picker { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.heading, .section-head { justify-content: space-between; }
.heading h1 { font-size: 24px; margin: 0 0 4px; }.heading p, .muted, small { color: #9bb0c2; }
.task-picker input { min-width: 220px; }.source-line { padding: 12px 0; border-block: 1px solid #29425f; margin: 12px 0; }
.work-grid { display: grid; grid-template-columns: minmax(180px, 240px) minmax(330px, 1fr) minmax(250px, 360px); gap: 14px; }
.scene-list, .editor, .results { min-width: 0; padding: 14px; border: 1px solid #29425f; background: #101e33; border-radius: 6px; }
h2 { font-size: 16px; margin: 0 0 12px; } h3 { font-size: 14px; margin: 14px 0 8px; }
.scene { width: 100%; display: flex; flex-direction: column; gap: 4px; text-align: left; border: 0; border-bottom: 1px solid #29425f; background: transparent; color: inherit; padding: 10px 4px; cursor: pointer; overflow-wrap: anywhere; }.scene.selected { background: #183755; }
label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #a9bfd0; margin-bottom: 10px; }
input, select, textarea { box-sizing: border-box; width: 100%; min-width: 0; background: #0b1728; color: #e7f0f7; border: 1px solid #37536f; border-radius: 4px; padding: 8px; font: inherit; }
.fault-row { display: grid; grid-template-columns: minmax(80px, .8fr) minmax(100px, 1.2fr) minmax(105px, 1fr) minmax(145px, 1.3fr) 32px; gap: 8px; align-items: end; border-top: 1px solid #29425f; padding-top: 10px; }.fault-row label { min-width: 0; }
.btn, .icon-btn { background: #173c5d; border: 1px solid #40627f; color: #eaf4fc; border-radius: 4px; min-height: 34px; padding: 5px 10px; cursor: pointer; }.btn.primary { background: #2879bd; border-color: #2879bd; }.btn:disabled, .icon-btn:disabled { opacity: .45; cursor: not-allowed; }.btn.small { min-height: 29px; }
.stage-title { margin-top: 22px; border-top: 1px solid #29425f; padding-top: 14px; }.task-ids { display: flex; flex-direction: column; gap: 4px; color: #9bb0c2; font-size: 12px; overflow-wrap: anywhere; margin-top: 10px; }
.phases { margin-top: 12px; }.phases div, .metrics { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid #29425f; }
.result-item { border-top: 1px solid #29425f; padding: 10px 0; }.result-item p { margin: 5px 0; }.result-item small { color: #f5bd68; } details { margin-top: 8px; font-size: 12px; overflow-wrap: anywhere; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }.feedback { padding: 10px; margin: 10px 0; background: #1b354a; border-left: 3px solid #53a5cc; }.feedback.error { border-color: #f17175; }.feedback.warning { border-color: #e7ac55; }.feedback.success { border-color: #50b988; }
@media (max-width: 1100px) { .work-grid { grid-template-columns: 220px minmax(0, 1fr); }.results { grid-column: 1 / -1; } }
@media (max-width: 700px) { .fault-page { padding: 12px; }.work-grid { grid-template-columns: minmax(0, 1fr); }.results { grid-column: auto; }.fault-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }.fault-row label:nth-child(4) { grid-column: 1 / -1; } }
</style>
