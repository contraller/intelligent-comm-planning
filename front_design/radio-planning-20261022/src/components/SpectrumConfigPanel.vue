<template>
  <section class="source-panel">
    <h3>频谱采集源</h3>
    <p class="muted">SYNTHETIC_INTEGRATION · 配置声明 · 未核实真实采集</p>
    <p v-if="!canView" role="alert">无权读取采集源</p>
    <template v-else>
      <form class="toolbar" @submit.prevent="store.load(1)">
        <input v-model="s.search" aria-label="搜索采集源" maxlength="120" placeholder="来源编号或名称" />
        <select v-model="s.enabled" aria-label="启停筛选"><option :value="undefined">全部</option><option :value="true">启用</option><option :value="false">停用</option></select>
        <button class="btn" :disabled="s.loading || locked" title="搜索" aria-label="搜索"><i class="pi pi-search" /></button>
        <button class="btn" type="button" :disabled="s.loading || locked" title="刷新" aria-label="刷新" @click="store.load()"><i class="pi pi-refresh" /></button>
        <button class="btn primary" type="button" :disabled="!canEdit || locked" @click="open()"><i class="pi pi-plus" /> 新增来源</button>
        <label class="config-file">配置 JSON<input type="file" accept=".json,application/json" :disabled="!canEdit || locked" @change="readConfiguration" /></label>
      </form>
      <p v-if="configReading || s.fileLoading" role="status">读取配置文件来源中</p>
      <p v-if="s.loading" role="status">读取中</p>
      <p v-if="s.error" class="error" role="alert">{{ s.error }}</p>
      <p v-if="s.notice" role="status">{{ s.notice }}</p>
      <p v-if="s.stale" class="error">保留上次列表，当前刷新未成功</p>
      <div v-if="s.pending" class="pending" role="status">
        <p>待核实请求：{{ s.pending.requestId }}</p>
        <button class="btn" :disabled="s.busy" @click="store.verify()">核实回执</button>
        <button class="btn" :disabled="s.busy || !canEdit" @click="store.retry()">原号重试</button>
      </div>
      <div class="table-scroll">
        <table><thead><tr><th>来源</th><th>声明地址 / 协议</th><th>频段 / kHz</th><th>周期 / s</th><th>状态</th><th>离线校验</th><th>操作</th></tr></thead>
          <tbody><tr v-for="row in s.rows" :key="row.sourceId">
            <td>{{ row.draft.name }}<small>{{ row.sourceId }}<br />{{ row.configRevision }}</small></td>
            <td>{{ row.draft.endpoint ?? '未知' }}<small>{{ row.draft.protocolHint ?? '未知' }}</small></td>
            <td>{{ row.draft.minKhz ?? '未知' }} ~ {{ row.draft.maxKhz ?? '未知' }}</td><td>{{ row.draft.intervalSeconds ?? '未知' }}</td>
            <td>{{ row.draft.enabled ? '启用声明' : '停用声明' }}<small>连接未尝试</small></td>
            <td>{{ row.latestOfflineCheck ? row.latestOfflineCheck.validation === 'VALID' ? '格式有效' : '资料不完整' : '未校验' }}<small>{{ row.latestOfflineCheck?.checkedAt }}</small></td>
            <td><div class="toolbar">
              <button class="btn" :disabled="locked" title="查看或编辑" aria-label="查看或编辑" @click="open(row)"><i class="pi pi-pencil" /></button>
              <button class="btn" :disabled="!canEdit || locked || store.dirty" @click="store.check(row)">离线校验</button>
              <button class="btn" :disabled="locked" title="导出" aria-label="导出" @click="download(row)"><i class="pi pi-download" /></button>
              <button class="btn" :disabled="locked" @click="$emit('select-source', { sourceId: row.sourceId, configRevision: row.configRevision })">选择</button>
            </div></td>
          </tr><tr v-if="!s.loading && !s.rows.length"><td colspan="7">暂无采集源</td></tr></tbody>
        </table>
      </div>
      <div class="toolbar pager"><button class="btn" :disabled="s.page <= 1 || s.loading || locked" aria-label="上一页" title="上一页" @click="store.load(s.page - 1)"><i class="pi pi-chevron-left" /></button>
        <span>{{ s.page }} / {{ Math.max(1, Math.ceil(s.total / s.pageSize)) }} · {{ s.total }} 项</span>
        <button class="btn" :disabled="s.page * s.pageSize >= s.total || s.loading || locked" aria-label="下一页" title="下一页" @click="store.load(s.page + 1)"><i class="pi pi-chevron-right" /></button></div>
    </template>
    <AppDrawer :visible="!!s.draft" title="采集源配置" @update:visible="!$event && close()">
      <form v-if="s.draft" class="fields" @submit.prevent="store.save()">
        <fieldset :disabled="!canEdit || locked">
          <label>来源编号<input v-model="s.sourceId" :disabled="s.baseRevision !== null" maxlength="120" required /></label>
          <label>名称<input v-model="s.draft.name" maxlength="60" required /></label>
          <label>协议声明<select v-model="s.draft.protocolHint"><option :value="null">未知</option><option value="HTTP_JSON">HTTP JSON</option><option value="WEBSOCKET_JSON">WebSocket JSON</option></select></label>
          <label>地址声明<input :value="s.draft.endpoint ?? ''" maxlength="500" @input="s.draft.endpoint = ($event.target as HTMLInputElement).value || null" /></label>
          <label v-for="field in numericFields" :key="field.key">{{ field.label }}<input :value="s.draft[field.key] ?? ''" type="number" :min="field.key === 'intervalSeconds' ? 1 : 0" :max="field.key === 'intervalSeconds' ? 3600 : undefined" :step="field.key === 'intervalSeconds' ? 1 : 'any'" @input="s.draft[field.key] = numeric($event)" /></label>
          <label>来源说明<textarea v-model="s.draft.provenanceNote" maxlength="500" required /></label>
          <label class="toggle"><input v-model="s.draft.enabled" type="checkbox" />启用声明</label>
        </fieldset>
        <p class="muted">SYNTHETIC_INTEGRATION · 连接未尝试</p>
        <p v-if="s.error" role="alert" class="error">{{ s.error }}</p>
        <button class="btn primary" :disabled="!canEdit || locked || !store.dirty"><i class="pi pi-save" /> 保存</button>
      </form>
      <template v-if="s.baseRevision">
        <p class="revision">{{ s.baseRevision }}</p>
        <div class="toolbar"><button class="btn" :disabled="locked" @click="store.history()">版本记录</button><button class="btn" :disabled="locked" @click="store.checks()">本版本校验记录</button></div>
        <ul><li v-for="row in s.history" :key="row.configRevision"><button class="btn version" @click="historical = row">{{ row.createdAt }} · {{ row.configRevision }}</button><button class="btn" title="导出历史版本" aria-label="导出历史版本" @click="download(row)"><i class="pi pi-download" /></button></li></ul>
        <div v-if="s.historyTotal" class="toolbar"><button class="btn" :disabled="s.historyPage <= 1" @click="store.history(s.historyPage - 1)">上一页</button><span>{{ s.historyPage }} · {{ s.historyTotal }} 项</span><button class="btn" :disabled="s.historyPage * 10 >= s.historyTotal" @click="store.history(s.historyPage + 1)">下一页</button></div>
        <ul><li v-for="row in s.checks" :key="row.checkId">{{ row.checkedAt }} · {{ row.validation }} · 连接未尝试<ul><li v-for="issue in row.issues" :key="issue.field + issue.code">{{ issue.field }}：{{ issue.message }}</li></ul></li></ul>
        <div v-if="s.checkTotal" class="toolbar"><button class="btn" :disabled="s.checkPage <= 1" @click="store.checks(s.checkPage - 1)">上一页</button><span>{{ s.checkPage }} · {{ s.checkTotal }} 项</span><button class="btn" :disabled="s.checkPage * 10 >= s.checkTotal" @click="store.checks(s.checkPage + 1)">下一页</button></div>
        <dl v-if="historical" class="history"><dt>历史版本</dt><dd>{{ historical.configRevision }}</dd><template v-for="(value, key) in historical.draft" :key="key"><dt>{{ key }}</dt><dd>{{ value ?? '未知' }}</dd></template></dl>
      </template>
      <p v-if="s.importedFrom" class="revision">文件声明版本：{{ s.importedFrom.configRevision }}</p>
      <template #footer><button class="btn" :disabled="locked" @click="close()">关闭</button></template>
    </AppDrawer>
    <DecisionDialog :request="decision" @answer="answer" />
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import DecisionDialog from './DecisionDialog.vue';
import { createSpectrumSourcesStore } from '../stores/spectrum-sources';
import { decodeSpectrumSourceConfigFile } from '../services/spectrum-source-validation';
import type { SpectrumSourceServices, SpectrumSourceVersion } from '../types/spectrum-source';
import type { Decision, DecisionRequest } from '../types/resource-edit';
const props = defineProps<{ services: SpectrumSourceServices; canView: boolean; canEdit: boolean; sessionGeneration: string }>();
const emit = defineEmits<{ 'dirty-change': [value: boolean]; 'busy-change': [value: boolean]; saved: [value: { sourceId: string; configRevision: string }]; 'select-source': [value: { sourceId: string; configRevision: string }] }>();
const store = createSpectrumSourcesStore(props.services, () => props), s = store.state;
const configReading = ref(false);
const locked = computed(() => s.busy || !!s.pending || s.fileLoading || configReading.value);
const historical = ref<SpectrumSourceVersion | null>(null), decision = ref<DecisionRequest | null>(null);
let resolve: ((value: Decision) => void) | undefined, configFileSerial = 0;
function answer(value: Decision) { decision.value = null; resolve?.(value); resolve = undefined; }
const numericFields = [{ key: 'intervalSeconds', label: '声明周期 / s' }, { key: 'minKhz', label: '下限 / kHz' }, { key: 'maxKhz', label: '上限 / kHz' }] as const;
function numeric(event: Event) { const raw = (event.target as HTMLInputElement).value; return raw === '' ? null : Number(raw); }
async function requestLeave() {
  if (locked.value || decision.value) return false;
  if (!store.dirty) return true;
  const value = await new Promise<Decision>(done => { resolve = done; decision.value = { title: '未保存配置', message: '采集源配置尚未保存', saveLabel: props.canEdit ? '保存并离开' : undefined, discardLabel: '放弃草稿', cancelLabel: '继续编辑' }; });
  if (value === 'cancel') return false;
  if (value === 'save') { await store.save(); return !store.dirty && !locked.value; }
  store.discard(); return true;
}
async function open(row?: SpectrumSourceVersion) { if (await requestLeave()) { historical.value = null; store.edit(row); } }
async function close() { if (await requestLeave()) store.discard(); }
async function readConfiguration(event: Event) {
  if (!props.canView || !props.canEdit || locked.value) return;
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
  if (!file) return;
  const serial = ++configFileSerial, generation = props.sessionGeneration;
  const current = () => serial === configFileSerial && generation === props.sessionGeneration && props.canView && props.canEdit;
  configReading.value = true; s.error = '';
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('配置JSON超过2MiB，未读取或截断');
    const text = await file.text(); if (!current()) return;
    const parsed = decodeSpectrumSourceConfigFile(JSON.parse(text.replace(/^\uFEFF/, '')));
    configReading.value = false;
    if (!await requestLeave() || !current()) return;
    historical.value = null; await store.fillConfig(parsed);
  } catch (reason) { if (current()) s.error = reason instanceof Error ? reason.message : '配置文件无效'; }
  finally { if (serial === configFileSerial) configReading.value = false; }
}
async function download(row: SpectrumSourceVersion) {
  const generation = props.sessionGeneration;
  try { const blob = await props.services.exportSource({ sourceId: row.sourceId, configRevision: row.configRevision });
    if (generation !== props.sessionGeneration || !props.canView) return;
    const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'spectrum-source-' + row.configRevision + '.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (reason) { if (generation === props.sessionGeneration) s.error = reason instanceof Error ? reason.message : '导出失败'; }
}
function stop() { configFileSerial++; configReading.value = false; store.stop(); }
function clearForSession() { stop(); answer('cancel'); historical.value = null; store.clearForSession(); }
watch(() => [props.sessionGeneration, props.canView, props.canEdit], () => { clearForSession(); if (props.canView) void store.load(1); }, { immediate: true });
watch(() => store.dirty, value => emit('dirty-change', value), { immediate: true });
watch(locked, value => emit('busy-change', value), { immediate: true });
watch(() => s.receipt?.requestId, () => { if (s.receipt?.operationType === 'SOURCE_SAVE') emit('saved', { sourceId: s.receipt.sourceId, configRevision: s.receipt.configRevision }); });
onBeforeUnmount(clearForSession);
defineExpose({ requestLeave, stop, clearForSession });
</script>
<style scoped>
.source-panel{padding:16px;min-width:0}.source-panel h3{font-size:16px;margin:0 0 8px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}.toolbar input{max-width:260px}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:10px;vertical-align:top;overflow-wrap:anywhere}td{max-width:260px}small{display:block;color:var(--muted);font-size:11px;margin-top:5px;overflow-wrap:anywhere}.muted{color:var(--muted);font-size:12px}.error{color:#eeb0aa}.fields,fieldset{display:grid;gap:12px}fieldset{border:0;padding:0;min-width:0}.fields label{display:grid;gap:6px}.fields .toggle{display:flex;align-items:center}.toggle input{width:auto}.pending{border-left:3px solid #cfb568;padding:8px;overflow-wrap:anywhere}.revision,.history{font-size:12px;overflow-wrap:anywhere}.history dd{margin:0 0 8px}.version{white-space:normal;text-align:left;overflow-wrap:anywhere}ul{padding-left:18px;font-size:12px;overflow-wrap:anywhere}.pager{justify-content:flex-end}@media(max-width:700px){.source-panel{padding:10px}th,td{padding:8px}.toolbar input{max-width:100%}}
.config-file{display:flex;align-items:center;gap:8px;font-size:12px}.config-file input{max-width:220px}
</style>
