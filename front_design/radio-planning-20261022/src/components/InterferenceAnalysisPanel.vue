<template>
  <section class="analysis-panel" aria-label="干扰分析">
    <div class="toolbar"><h4>干扰分析</h4>
      <button class="icon-button" title="刷新干扰上下文" aria-label="刷新干扰上下文" :disabled="store.locked" @click="store.load()"><i class="pi pi-refresh" aria-hidden="true" /></button>
      <button class="btn small" :disabled="!store.taskContext" @click="openHistory">历史 {{ store.historyTotal }}</button>
    </div>
    <p v-if="!store.connected" role="status">干扰工作流尚未接入真实服务。</p>
    <p v-if="!store.readable">需要 GIS 态势和网络规划查看权限。</p>
    <template v-else>
      <details v-if="source"><summary>{{ source.name }} · {{ source.id }}</summary>
        <p>{{ source.coordinate.join(', ') }} · {{ source.active ? '生效' : '未生效' }}</p>
        <button class="icon-button" title="定位干扰源" aria-label="定位干扰源" @click="emit('selectSource', source.id)"><i class="pi pi-map-marker" aria-hidden="true" /></button>
        <button v-if="sourceEditable" class="btn small" @click="emit('editSource', source.id)">编辑主资源参数</button>
        <button class="btn small" :disabled="!store.executable || store.locked" @click="emit('analyzeSource', source.id)">选择此干扰源</button>
      </details>
      <details v-if="sourceRows.length"><summary>干扰源 {{ sourceRows.length }}</summary>
        <div v-for="row in sourceRows" :key="row.interference_id" class="source-row">
          <span>{{ row.name || row.interference_id }} · {{ row.interference_id }} · {{ row.active === 'true' ? '生效' : row.active === 'false' ? '未生效' : '状态未知' }}</span>
          <button class="icon-button" :aria-label="'定位干扰源 ' + row.interference_id" :title="canLocate(row) ? '定位干扰源 ' + row.interference_id : '缺少有效冻结坐标'" :disabled="!canLocate(row)" @click="emit('selectSource', row.interference_id)"><i class="pi pi-map-marker" aria-hidden="true" /></button>
        </div>
      </details>
      <label>当前确认方案<select :value="store.taskContext?.planId ?? ''" :disabled="store.locked" @change="choosePlan">
        <option value="">请选择方案</option>
        <option v-if="store.selectedSource && !store.sourceDirectory?.items.some(row => row.plan_id === store.selectedSource?.plan_id)" :value="store.selectedSource.plan_id">{{ store.selectedSource.name }} · {{ store.selectedSource.plan_version }}</option>
        <option v-for="row in store.sourceDirectory?.items ?? []" :key="row.plan_id" :value="row.plan_id" :disabled="!row.eligible">{{ row.name }} · {{ row.plan_version }}{{ row.eligible ? '' : '（不可分析）' }}</option>
      </select></label>
      <div class="toolbar"><input v-model="store.sourceSearch" type="search" aria-label="搜索确认方案" /><button class="icon-button" title="搜索确认方案" aria-label="搜索确认方案" @click="store.loadSourceOptions(1)"><i class="pi pi-search" aria-hidden="true" /></button><button class="icon-button" title="方案上一页" aria-label="方案上一页" :disabled="!store.sourceDirectory || store.sourceDirectory.page <= 1" @click="store.loadSourceOptions((store.sourceDirectory?.page ?? 1) - 1)"><i class="pi pi-angle-left" aria-hidden="true" /></button><span>{{ store.sourceDirectory?.page ?? 1 }} / {{ Math.max(1, Math.ceil((store.sourceDirectory?.total ?? 0) / 20)) }}</span><button class="icon-button" title="方案下一页" aria-label="方案下一页" :disabled="!store.sourceDirectory || store.sourceDirectory.page * 20 >= store.sourceDirectory.total" @click="store.loadSourceOptions((store.sourceDirectory?.page ?? 1) + 1)"><i class="pi pi-angle-right" aria-hidden="true" /></button></div>
      <p v-if="!store.sourceDirectory?.total">暂无匹配的当前确认方案。</p>
      <details v-if="store.sourceDirectory?.items.some(row => !row.eligible)"><summary>不可分析来源</summary><p v-for="row in store.sourceDirectory.items.filter(item => !item.eligible)" :key="row.plan_id">{{ row.name }} · {{ row.plan_version }}：{{ row.unavailable_reasons.join('；') }}</p></details>
      <ul v-if="store.selectedSource?.unavailable_reasons.length"><li v-for="reason in store.selectedSource.unavailable_reasons" :key="reason">{{ reason }}</li></ul>
      <div class="toolbar"><button class="btn" :disabled="!store.taskContext || store.locked" @click="store.sceneOpen = true">场景与版本</button>
        <span v-if="store.scene">{{ store.scene.version.name }} · v{{ store.scene.version.versionNo }} · {{ store.scene.version.sourceCount }} 源</span>
        <span v-else>尚未选择已保存场景</span>
      </div>
      <p v-if="store.dirty" role="status">场景草稿未保存，不能提交分析。</p>
      <p v-if="store.scene?.sourceState.state !== 'CURRENT' && store.scene">{{ store.scene.sourceState.reasons.join('；') }}。保留冻结历史。</p>
      <button class="btn primary" :disabled="!store.canAnalyze || store.locked" @click="store.submitAnalysis()"><i class="pi pi-play" aria-hidden="true" /> 提交干扰分析</button>
      <section v-if="store.taskContext && store.context?.active_run_ids.length" aria-label="活动分析"><p>已有活动分析</p><button v-for="id in store.context.active_run_ids" :key="id" class="text-link" :disabled="store.locked" @click="store.selectRun(id)">查看 {{ id }}</button></section>
      <section v-if="store.pendingWrites.length" aria-label="待核实写入">
        <div v-for="row in store.pendingWrites" :key="row.request_id"><p>受理状态待核实 · {{ row.request_id }}</p>
          <button class="btn small" :disabled="store.busy" @click="store.resolvePending(row.request_id)">查询回执</button>
          <button class="btn small" :disabled="store.busy" @click="store.resolvePending(row.request_id, true)">重试原请求</button>
        </div>
      </section>
      <p v-if="store.lastReceipt" class="muted">受理回执 {{ store.lastReceipt.request_id }} · {{ store.lastReceipt.object_id }}</p>
      <p v-if="store.error" role="alert">{{ store.error }}</p>
      <p v-if="store.queryError" role="alert">{{ store.queryError }} <button class="text-link" :disabled="store.locked" @click="store.query()">重试查询</button></p>
      <template v-if="store.selected">
        <h4>{{ store.selected.plan_version }} · {{ labels[store.selected.state] }}</h4>
        <p>{{ store.selected.phase }} · {{ store.selected.progress }}%</p><progress max="100" :value="store.selected.progress" />
        <p class="muted">{{ store.selected.run_id }} · {{ store.selected.data_origin }}</p>
        <p>冻结场景 {{ store.selected.source.name }} · v{{ store.selected.source.versionNo }}</p>
        <p v-if="store.selected.source_state.state !== 'CURRENT'" role="status">{{ store.selected.source_state.reasons.join('；') }}</p>
        <p v-if="store.selected.error" role="alert">{{ store.selected.error }}</p>
        <button v-if="['PENDING', 'RUNNING'].includes(store.selected.state)" class="btn" :disabled="!store.executable || store.locked" @click="store.cancelAnalysis()"><i class="pi pi-stop" aria-hidden="true" /> 请求取消分析</button>
        <p v-if="store.selected.state === 'CANCEL_REQUESTED'" role="status">取消已请求，等待算法检查点确认。</p>
        <template v-if="store.selected.result">
          <div class="toolbar" role="group" aria-label="影响状态"><button class="btn small" :aria-pressed="!store.effectiveAfter" @click="store.after = false">措施前</button><button class="btn small" :aria-pressed="store.effectiveAfter" :disabled="!store.canPreviewAfter" @click="store.after = true">措施后预测</button></div>
          <p v-if="store.impact">预测受扰节点 {{ store.impact.summary.affected_nodes }} · 链路 {{ store.impact.summary.affected_links }}</p>
          <fieldset class="levels"><legend>受扰等级</legend><label v-for="(label, key) in levelNames" :key="key"><input v-model="store.levels" type="checkbox" :value="key" />{{ label }}</label></fieldset>
          <div class="impact-list">
            <button v-for="row in store.filteredImpact?.affected_nodes ?? []" :key="String(row.node_id)" class="text-link" :aria-pressed="row.node_id === selectedNodeId" @click="emit('selectNode', String(row.node_id))">{{ row.node_id }} · {{ levelNames[row.level] }} · SNR {{ row.snr_before_db }} → SINR {{ row.sinr_after_db }} dB</button>
            <button v-for="row in store.filteredImpact?.affected_links ?? []" :key="String(row.link_id)" class="text-link" :aria-pressed="row.link_id === selectedLinkId" @click="emit('selectLink', String(row.link_id))">{{ row.link_id }} · {{ levelNames[row.level] }} · SNR {{ row.snr_before_db }} → SINR {{ row.sinr_after_db }} dB</button>
          </div>
          <p v-if="!store.selected.result.affected_nodes.length && !store.selected.result.affected_links.length">本次模型预测未发现受扰对象。</p>
          <h4>抗干扰措施</h4>
          <div v-for="row in store.selected.result.measures" :key="row.measure_id" class="measure-row" :data-measure-id="row.measure_id">
            <button class="text-link" @click="store.loadMeasurePreview(row.measure_id)"><strong>P{{ row.priority }} · {{ row.title }}</strong><span>{{ row.detail }}</span></button>
            <span v-if="!row.available">{{ row.unavailable_reasons.join('；') }}</span>
            <template v-for="target in measureTargets?.find(item => item.measureId === row.measure_id)?.targets ?? []" :key="target.kind"><button class="text-link" :disabled="!!target.reason" :title="target.reason" @click="target.locate()">{{ target.label }} · {{ target.id }}</button></template>
          </div>
          <p v-if="!store.selected.result.measures.length">未生成可采纳措施。</p>
          <details v-if="store.selected.result.measure_review.length"><summary>五类措施逐项结论</summary><pre>{{ JSON.stringify(store.selected.result.measure_review, null, 2) }}</pre></details>
          <details v-if="store.selected.result.unresolved.length"><summary>尚未解决的对象</summary><pre>{{ JSON.stringify(store.selected.result.unresolved, null, 2) }}</pre></details>
          <details v-if="store.selected.result.parameter_substitutions.length"><summary>计算参数推定与依据</summary><pre>{{ JSON.stringify(store.selected.result.parameter_substitutions, null, 2) }}</pre></details>
          <p class="muted">{{ store.selected.result.notes.join('；') }}</p>
        </template>
      </template>
      <p v-if="store.notice" role="status">{{ store.notice }}</p><p v-if="targetNotice" role="status">{{ targetNotice }}</p>
    </template>
    <InterferenceSceneDrawer :visible="store.sceneOpen" :task-context="store.taskContext" @update:visible="store.sceneOpen = $event" />
  </section>
</template>
<script setup lang="ts">
import { computed, watch } from 'vue';
import { useInterferenceStore } from '../stores/interference';
import InterferenceSceneDrawer from './InterferenceSceneDrawer.vue';
import type { InterferenceSource } from '../types/domain';
import type { InterferenceTargetEntry } from '../composables/useInterferenceTargetNavigation';
import type { TaskContext } from '../types/interference-workbench';
const props = defineProps<{ source?: InterferenceSource; sourceEditable: boolean; selectedNodeId: string; selectedLinkId: string;
  measureTargets?: InterferenceTargetEntry[]; targetNotice?: string; taskContext?: TaskContext | null }>();
const emit = defineEmits<{ selectSource: [id: string]; editSource: [id: string]; analyzeSource: [id: string]; selectNode: [id: string]; selectLink: [id: string] }>();
const store = useInterferenceStore();
// 已有运行/场景只列其冻结选源；空选源不能回退成当前资源目录。
const sourceRows = computed(() => store.selected ? store.selected.source.interferenceSources.map(row => row.sourceRow)
  : store.scene ? store.scene.version.interferenceSources.map(row => row.sourceRow) : store.context?.interference_sources ?? []);
function canLocate(row: Record<string, string>) {
  if (!row.lon?.trim() || !row.lat?.trim()) return false;
  const lon = Number(row.lon), lat = Number(row.lat);
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}
const labels = { PENDING: '等待计算', RUNNING: '分析中', CANCEL_REQUESTED: '取消请求中', SUCCESS: '分析完成', FAILED: '分析失败', CANCELLED: '已取消' };
const levelNames = { SEVERE: '严重', MODERATE: '中等', MINOR: '轻微' };
watch(() => props.taskContext, value => { if (value && (value.planId !== store.taskContext?.planId || value.taskId !== store.taskContext?.taskId || value.planVersion !== store.taskContext?.planVersion)) void store.enterPlan(value); }, { immediate: true });
async function choosePlan(event: Event) { const control = event.target as HTMLSelectElement; const row = store.sourceDirectory?.items.find(item => item.plan_id === control.value); if (!row || !await store.chooseSource(row)) control.value = store.taskContext?.planId ?? ''; }
function openHistory() { store.historyOpen = true; void store.loadHistory(1); }
</script>
<style scoped>
.analysis-panel{display:grid;gap:12px;padding:14px;font-size:12px;min-width:0}h4,p{margin:0;overflow-wrap:anywhere}p{line-height:1.7}label{display:grid;gap:6px}select{width:100%;min-width:0}.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.toolbar h4{flex:1}.icon-button{width:32px;height:32px;flex:0 0 32px}.levels{display:flex;flex-wrap:wrap;gap:10px;border:0;padding:0;min-width:0}.levels label{display:flex;align-items:center;gap:5px}.impact-list,.measure-row{display:grid;gap:8px}.measure-row{padding:10px 0;border-bottom:1px solid var(--line)}.measure-row span,.measure-row strong{display:block;text-align:left;overflow-wrap:anywhere}.source-row{display:grid;grid-template-columns:minmax(0,1fr) 32px;align-items:center;gap:8px;padding:6px 0}.source-row span{overflow-wrap:anywhere}.text-link{text-align:left;white-space:normal}progress{width:100%;height:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;max-height:260px;overflow:auto}.muted{color:var(--muted)}
</style>
