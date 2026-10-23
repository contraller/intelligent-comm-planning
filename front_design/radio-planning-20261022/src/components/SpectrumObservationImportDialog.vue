<template>
  <AppDrawer :visible="visible" title="显式导入观测" width="620px" @update:visible="!$event && close()">
    <p class="origin">SYNTHETIC_INTEGRATION · 构造资料，非实测 · 不建立采集连接</p>
    <fieldset :disabled="locked || !canImport">
      <label>观测 JSON<input type="file" accept=".json,application/json" @change="upload" /></label>
      <details><summary>选择仓库既有构造预设</summary>
        <div class="fields">
          <label>预设<select v-model="presetId"><option v-for="row in spectrumObservationPresets" :key="row.id" :value="row.id">{{ row.label }}</option></select></label>
          <label>观测集编号<input v-model="datasetId" maxlength="120" /></label>
          <label>资源来源版本<input v-model="resourceInput" maxlength="120" /></label>
          <label>导入来源说明<textarea v-model="note" maxlength="500" /></label>
          <button class="btn" type="button" @click="choosePreset">选择该构造预设</button>
        </div>
      </details>
    </fieldset>
    <p v-if="store.state.error" class="error" role="alert">{{ store.state.error }}</p>
    <p v-if="store.state.notice" role="status">{{ store.state.notice }}</p>
    <dl v-if="store.state.file" class="summary">
      <dt>观测集</dt><dd>{{ store.state.file.dataset.datasetId }}</dd>
      <dt>来源</dt><dd>{{ store.state.file.dataset.source.name }} · {{ store.state.file.dataset.source.configRevision }}</dd>
      <dt>资源历史来源</dt><dd>{{ store.state.file.dataset.resourceRevision }}</dd>
      <dt>帧数</dt><dd>{{ store.state.file.dataset.frames.length }}</dd>
      <dt>标源说明</dt><dd>{{ store.state.file.dataset.provenanceNote }}</dd>
    </dl>
    <div v-if="store.state.preview && !store.state.receipt" class="preview">
      <strong>预检通过 · 尚未写入</strong>
      <p>{{ store.state.preview.sourceBinding === 'REGISTERED_VERSION' ? '登记版本身份匹配' : '仅导入来源声明' }}</p>
      <p v-for="warning in store.state.preview.warnings" :key="warning">{{ warning }}</p>
      <small>{{ store.state.preview.previewHash }}</small>
    </div>
    <div v-if="store.state.pending" class="pending">
      <p>请求号：{{ store.state.pending.requestId }}</p>
      <button class="btn" :disabled="store.state.busy" @click="store.verify()">核实回执</button>
      <button class="btn" :disabled="store.state.busy || !canImport" @click="store.retry()">原号重试</button>
    </div>
    <dl v-if="store.state.receipt" class="summary"><dt>持久化回执</dt><dd>{{ store.state.receipt.requestId }}</dd><dt>观测版本</dt><dd>{{ store.state.receipt.datasetRevision }}</dd><dt>导入时间</dt><dd>{{ store.state.receipt.importedAt }}</dd></dl>
    <template #footer><div class="actions">
      <button class="btn" :disabled="locked" @click="close()">{{ store.state.receipt ? '关闭' : '取消' }}</button>
      <button class="btn" :disabled="!canImport || locked || !store.state.file || !!store.state.receipt" @click="store.preview()">预检</button>
      <button class="btn primary" :disabled="!canImport || locked || !store.state.preview || !!store.state.receipt" @click="store.submit()">确认导入</button>
    </div></template>
    <DecisionDialog :request="decision" @answer="answer" />
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import DecisionDialog from './DecisionDialog.vue';
import { spectrumObservationPresets } from '../mocks/spectrum-observation-presets';
import { createObservationImportStore } from '../stores/spectrum-observations';
import type { ObservationServices, ObservationSource, ObservationImportReceipt } from '../types/observation';
import type { Decision, DecisionRequest } from '../types/resource-edit';
const props = defineProps<{ visible: boolean; services: ObservationServices; resourceRevision: string; sourceSelection: ObservationSource | null; canImport: boolean; sessionGeneration: string }>();
const emit = defineEmits<{ 'update:visible': [value: boolean]; 'dirty-change': [value: boolean]; 'busy-change': [value: boolean]; committed: [value: ObservationImportReceipt] }>();
const store = createObservationImportStore(props.services, () => props.canImport, value => emit('committed', value));
const presetId = ref(spectrumObservationPresets[0].id), datasetId = ref(''), resourceInput = ref(props.resourceRevision), note = ref('仓库既有频谱观测预设，显式构造导入，非实测');
const locked = computed(() => store.state.busy || !!store.state.pending), decision = ref<DecisionRequest | null>(null);
let resolve: ((value: Decision) => void) | undefined, uploadSerial = 0;
function answer(value: Decision) { decision.value = null; resolve?.(value); resolve = undefined; }
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0], serial = ++uploadSerial;
  if (!file || locked.value) return;
  if (file.size > 2 * 1024 * 1024) { store.state.error = '文件超过2MiB，未读取或截断'; return; }
  try { const text = await file.text(); if (serial !== uploadSerial || !props.visible) return; store.choose(JSON.parse(text.replace(/^\uFEFF/, ''))); }
  catch { if (serial === uploadSerial) store.state.error = 'JSON文件编码或结构无效'; }
}
function choosePreset() {
  const preset = spectrumObservationPresets.find(row => row.id === presetId.value)!;
  const selection = props.sourceSelection;
  const source = selection && selection.minKhz === preset.minKhz && selection.maxKhz === preset.maxKhz ? { ...selection } :
    { sourceId: preset.id, name: preset.label, configRevision: 'existing-preset-v1', minKhz: preset.minKhz, maxKhz: preset.maxKhz, intervalSeconds: null };
  store.choose({ schemaVersion: 1, fileKind: 'SPECTRUM_OBSERVATION_DATASET', dataOrigin: 'SYNTHETIC_INTEGRATION',
    dataset: { datasetId: datasetId.value, provenanceNote: note.value, resourceRevision: resourceInput.value, deviceStatusSnapshotId: null, source,
      frames: preset.frames.map((frame, index) => ({ frameId: frame.id, index, observedAt: frame.observedAt, label: frame.label,
        occupancyPercent: frame.occupancyPercent, abnormalBandCount: frame.abnormalBandCount, unknownReasons: [],
        bins: frame.bins.map(bin => ({ binId: bin.id, minKhz: bin.minKhz, maxKhz: bin.maxKhz, occupancyPercent: bin.occupancyPercent,
          powerDbm: bin.powerDbm, abnormal: bin.abnormal, reason: bin.reason, unknownReasons: [] })) })) } });
}
async function requestLeave() {
  if (locked.value || decision.value) return false;
  if (!store.dirty) return true;
  const answer = await new Promise<Decision>(done => { resolve = done; decision.value = { title: '未提交的导入', message: '放弃当前文件和预检结果？数据库历史不受影响。', discardLabel: '放弃输入', cancelLabel: '继续导入' }; });
  return answer === 'discard';
}
async function close() { if (await requestLeave()) { clearForSession(); emit('update:visible', false); } }
function clearForSession() { uploadSerial++; answer('cancel'); store.clearForSession(); }
watch(() => [props.sessionGeneration, props.canImport], () => { clearForSession(); });
watch(() => props.visible, visible => { if (visible && !store.state.file) resourceInput.value = props.resourceRevision; });
watch(() => store.dirty, value => emit('dirty-change', value), { immediate: true });
watch(locked, value => emit('busy-change', value), { immediate: true });
onBeforeUnmount(clearForSession);
defineExpose({ requestLeave, clearForSession });
</script>
<style scoped>
.origin{color:var(--muted);font-size:12px;line-height:1.7}fieldset{border:0;padding:0;min-width:0}label,.fields{display:grid;gap:8px}.fields{padding:12px 0}.summary{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px;font-size:12px}.summary dd{margin:0;overflow-wrap:anywhere}.preview,.pending{border-left:3px solid #65b7a0;padding:12px;font-size:12px;overflow-wrap:anywhere}.pending{border-color:#cfb568}.actions{display:flex;flex-wrap:wrap;gap:8px}.error{color:#eeb0aa}details{margin:16px 0}small{overflow-wrap:anywhere}@media(max-width:500px){.summary{grid-template-columns:1fr;gap:4px}.summary dd{margin-bottom:8px}}
</style>
