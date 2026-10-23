<template>
  <section class="spectrum-monitor">
    <header class="toolbar"><h3>频谱观测</h3><span class="origin">SYNTHETIC_INTEGRATION · 构造资料，非实测</span>
      <button class="btn" :disabled="!canView || s.loading" aria-label="刷新观测集" title="刷新观测集" @click="store.load()"><i class="pi pi-refresh" /></button>
      <button class="btn primary" :disabled="!canView || !canImport || importBusy" @click="openImport()"><i class="pi pi-upload" /> 显式导入</button></header>
    <p v-if="!canView" role="alert">无权读取观测</p>
    <template v-else>
      <p v-if="s.loading" role="status">读取观测集中</p>
      <p v-if="s.error" role="alert" class="error">{{ s.error }}</p>
      <p v-if="s.stale" class="warning">读取失败，保留上次历史帧；回放已停止</p>
      <div class="table-scroll">
        <table aria-label="观测集"><thead><tr><th>观测集 / 来源</th><th>帧数</th><th>导入时间</th><th>操作</th></tr></thead><tbody>
          <tr v-for="row in s.rows" :key="row.datasetRevision"><td>{{ row.datasetId }}<small>{{ row.source.name }} · {{ row.source.configRevision }}</small></td><td>{{ row.frameCount }}</td><td>{{ row.importedAt }}</td>
            <td><button class="btn" :disabled="s.playback.busy || importBusy" @click="select(row)">选择</button></td></tr>
          <tr v-if="!s.loading && !s.rows.length"><td colspan="4">暂无已导入观测</td></tr>
        </tbody></table>
      </div>
      <div class="toolbar pager"><button class="btn" :disabled="s.page <= 1 || s.loading" title="上一页" aria-label="上一页" @click="store.load(s.page - 1)"><i class="pi pi-chevron-left" /></button><span>{{ s.page }} · {{ s.total }} 项</span><button class="btn" :disabled="s.page * s.pageSize >= s.total || s.loading" title="下一页" aria-label="下一页" @click="store.load(s.page + 1)"><i class="pi pi-chevron-right" /></button></div>
      <template v-if="s.selected">
        <dl class="identity"><dt>历史观测版本</dt><dd>{{ s.selected.datasetRevision }}</dd><dt>资源历史来源</dt><dd>{{ s.selected.resourceRevision }}</dd><dt>来源说明</dt><dd>{{ s.selected.provenanceNote }}</dd><dt>采样周期</dt><dd>{{ s.selected.source.intervalSeconds === null ? '未知' : s.selected.source.intervalSeconds + ' s' }}</dd><dt>设备状态快照</dt><dd>未关联</dd></dl>
        <div class="toolbar">
          <button class="btn" :disabled="!frame || s.playback.busy || s.playback.finished" :title="s.playback.active ? '暂停' : '播放'" :aria-label="s.playback.active ? '暂停' : '播放'" @click="s.playback.active ? store.pause() : store.play()"><i :class="s.playback.active ? 'pi pi-pause' : 'pi pi-play'" /></button>
          <button class="btn" :disabled="!frame || s.playback.busy || s.playback.index <= 0" title="上一帧" aria-label="上一帧" @click="store.seek(s.playback.index - 1)"><i class="pi pi-step-backward" /></button>
          <button class="btn" :disabled="!frame || s.playback.busy || s.playback.finished" title="下一帧" aria-label="下一帧" @click="store.next()"><i class="pi pi-step-forward" /></button>
          <button class="btn" :disabled="s.playback.busy" title="重播" aria-label="重播" @click="store.restart()"><i class="pi pi-replay" /></button>
          <label>回放间隔 / s<input :value="s.playback.intervalSeconds" type="number" min="1" max="30" step="1" @change="store.interval(Number(($event.target as HTMLInputElement).value))" /></label>
          <span role="status">{{ s.playback.finished ? '已到末帧' : s.playback.active ? '回放中' : '已暂停' }} · {{ s.playback.index + 1 }} / {{ s.selected.frameCount }}</span>
          <button class="btn" :disabled="exporting" title="导出观测" aria-label="导出观测" @click="download()"><i class="pi pi-download" /></button>
        </div>
      </template>
      <template v-if="frame">
        <p class="frame-label">{{ frame.label }} · {{ frame.observedAt ?? '观测时间未知' }}</p>
        <div class="stats"><span>占用率 <strong>{{ metric(frame.occupancyPercent, '%') }}</strong></span><span>异常频段 <strong>{{ frame.abnormalBandCount ?? '未知' }}</strong></span></div>
        <p v-for="reason in frame.unknownReasons" :key="reason" class="muted">{{ reason }}</p>
        <ChartCanvas :option="option" height="220px" label="构造观测频谱占用率和接收功率；未知值留空" />
        <div class="table-scroll"><table aria-label="频谱观测频段"><thead><tr><th>频段 / kHz</th><th>占用率</th><th>接收功率</th><th>异常</th><th>原因 / 未知来源</th></tr></thead><tbody><tr v-for="bin in frame.bins" :key="bin.binId">
          <td>{{ bin.minKhz }} ~ {{ bin.maxKhz }}</td><td>{{ metric(bin.occupancyPercent, '%') }}</td><td>{{ metric(bin.powerDbm, ' dBm') }}</td><td>{{ bin.abnormal === null ? '未知' : bin.abnormal ? '异常标记' : '无异常标记' }}</td><td>{{ [bin.reason, ...bin.unknownReasons].filter(Boolean).join('；') || '无' }}</td>
        </tr></tbody></table></div>
      </template>
      <template v-if="s.selected">
        <h4>已存帧</h4>
        <div class="toolbar"><button v-for="row in s.frameRows" :key="row.frameId" class="btn frame-choice" :disabled="s.playback.busy" :aria-pressed="s.playback.index === row.index" @click="store.seek(row.index)">{{ row.index + 1 }} · {{ row.label }}</button></div>
        <div class="toolbar"><button class="btn" :disabled="s.framePage <= 1 || s.frameLoading" title="前页帧" aria-label="前页帧" @click="store.frames(s.framePage - 1)"><i class="pi pi-chevron-left" /></button><span>{{ s.framePage }} · {{ s.frameTotal }} 帧</span><button class="btn" :disabled="s.framePage * s.framePageSize >= s.frameTotal || s.frameLoading" title="后页帧" aria-label="后页帧" @click="store.frames(s.framePage + 1)"><i class="pi pi-chevron-right" /></button></div>
      </template>
    </template>
    <SpectrumObservationImportDialog ref="importDialog" :visible="importVisible" :services="services" :resource-revision="s.selected?.resourceRevision ?? resourceRevision ?? ''" :source-selection="s.selected?.source ?? null" :can-import="canView && canImport" :session-generation="sessionGeneration" @update:visible="importVisible = $event" @dirty-change="importDirty = $event" @busy-change="importBusy = $event" @committed="imported" />
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import ChartCanvas from './ChartCanvas.vue';
import SpectrumObservationImportDialog from './SpectrumObservationImportDialog.vue';
import { createSpectrumObservationsStore } from '../stores/spectrum-observations';
import type { ObservationServices, ObservationSelection, ObservationImportReceipt } from '../types/observation';
const props = defineProps<{ services: ObservationServices; canView: boolean; canImport: boolean; sessionGeneration: string; initialSelection?: { datasetId: string; datasetRevision: string }; resourceRevision?: string }>();
const emit = defineEmits<{ 'select-dataset': [value: { datasetId: string; datasetRevision: string }]; 'select-frame': [value: { datasetId: string; datasetRevision: string; index: number }]; 'dirty-change': [value: boolean]; 'busy-change': [value: boolean]; imported: [value: ObservationImportReceipt] }>();
const store = createSpectrumObservationsStore(props.services, () => props.canView, value => emit('select-frame', { datasetId: value.datasetId, datasetRevision: value.datasetRevision, index: value.index })), s = store.state;
const importVisible = ref(false), importDirty = ref(false), importBusy = ref(false), exporting = ref(false);
const importDialog = ref<InstanceType<typeof SpectrumObservationImportDialog> | null>(null);
const frame = computed(() => s.result?.frame), metric = (value: number | null, unit: string) => value === null ? '未知' : String(value) + unit;
const option = computed(() => ({ animation: false, tooltip: { trigger: 'axis' }, legend: { data: ['占用率', '接收功率'] },
  grid: { left: 55, right: 55, top: 40, bottom: 40 }, xAxis: { type: 'category', data: frame.value?.bins.map(row => row.minKhz + '~' + row.maxKhz) ?? [] },
  yAxis: [{ type: 'value', min: 0, max: 100, name: '%' }, { type: 'value', name: 'dBm' }],
  series: [{ name: '占用率', type: 'bar', data: frame.value?.bins.map(row => ({ value: row.occupancyPercent, itemStyle: { color: row.abnormal === true ? '#df9b64' : '#4c9eb5' } })) ?? [] },
    { name: '接收功率', type: 'line', yAxisIndex: 1, connectNulls: false, data: frame.value?.bins.map(row => row.powerDbm) ?? [], itemStyle: { color: '#73b893' } }] }));
async function select(value: ObservationSelection) { store.pause(); await store.select({ datasetId: value.datasetId, datasetRevision: value.datasetRevision }); if (s.selected) emit('select-dataset', { datasetId: s.selected.datasetId, datasetRevision: s.selected.datasetRevision }); }
function openImport() { store.pause(); importVisible.value = true; }
async function imported(value: ObservationImportReceipt) { emit('imported', value); await store.load(1); await select(value); }
async function download() {
  if (!s.selected || exporting.value) return; const selected = s.selected, generation = props.sessionGeneration; exporting.value = true;
  try { const blob = await props.services.exportObservationDataset({ datasetId: selected.datasetId, datasetRevision: selected.datasetRevision });
    if (generation !== props.sessionGeneration) return;
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'spectrum-observation-' + selected.datasetRevision + '.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (reason) { if (generation === props.sessionGeneration) s.error = reason instanceof Error ? reason.message : '导出失败'; }
  finally { if (generation === props.sessionGeneration) exporting.value = false; }
}
function stop() { store.stop(); }
function clearForSession() { store.clearForSession(); importDialog.value?.clearForSession(); importVisible.value = false; importDirty.value = false; importBusy.value = false; exporting.value = false; }
async function requestLeave() { if (importBusy.value) return false; if (importVisible.value && !await importDialog.value?.requestLeave()) return false; stop(); return true; }
function visibility() { if (document.hidden) stop(); }
watch(() => [props.sessionGeneration, props.canView, props.canImport], () => { clearForSession(); if (props.canView) { void store.load(1); if (props.initialSelection) void select(props.initialSelection); } }, { immediate: true });
watch(() => props.initialSelection, value => { if (value && props.canView) void select(value); }, { deep: true });
watch(importDirty, value => emit('dirty-change', value), { immediate: true });
watch(() => importBusy.value || exporting.value, value => emit('busy-change', value), { immediate: true });
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
onBeforeUnmount(() => { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); clearForSession(); });
defineExpose({ requestLeave, stop, clearForSession });
</script>
<style scoped>
.spectrum-monitor{display:grid;gap:12px;min-width:0}.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.toolbar h3{margin:0;font-size:16px}.origin,.muted{font-size:12px;color:var(--muted)}.origin{margin-right:auto}.error{color:#eeb0aa}.warning{color:#dfc270}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}small{display:block;font-size:11px;overflow-wrap:anywhere;color:var(--muted)}.identity{display:grid;grid-template-columns:110px minmax(0,1fr);gap:6px;font-size:12px}.identity dd{margin:0;overflow-wrap:anywhere}.toolbar label{display:flex;gap:6px;align-items:center;font-size:12px}.toolbar input{width:70px}.stats{display:flex;gap:24px;flex-wrap:wrap;font-size:12px}.stats strong{font-size:18px}.frame-label{font-size:12px;margin:0}.frame-choice{white-space:normal;text-align:left;min-height:34px;max-width:200px;overflow-wrap:anywhere}.frame-choice[aria-pressed=true]{border-color:#65b7a0}.pager{justify-content:flex-end}h4{margin:0;font-size:13px}@media(max-width:500px){.identity{grid-template-columns:1fr}.identity dd{margin-bottom:6px}}
</style>
