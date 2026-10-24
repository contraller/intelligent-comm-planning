<template>
  <section class="bandwidth-editor" aria-label="覆盖带宽选择">
    <div class="toolbar">
      <label>型号<select v-model="modelId" aria-label="筛选带宽型号" :disabled="busy || loading">
        <option value="">全部型号</option>
        <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }} · {{ model.id }}</option>
      </select></label>
      <label><input v-model="onlyUnselected" type="checkbox" :disabled="busy || loading" />仅未选设备</label>
      <button class="btn small" :disabled="locked || !modelId || !eligible.length" @click="checkModel">勾选该型号（{{ eligible.length }}）</button>
      <button class="btn small" :disabled="locked || !checked.length" @click="checked = []">清除勾选</button>
    </div>
    <div class="toolbar">
      <label>批量带宽（kHz）<select v-model="batchValue" aria-label="批量带宽" :disabled="locked || !modelId || !checked.length">
        <option value="">未选择</option>
        <option v-for="value in batchOptions" :key="value" :value="String(value)">{{ value }}</option>
      </select></label>
      <button class="btn small" :disabled="locked || !batchValue || !checked.length" @click="applyBatch">应用到勾选项（{{ checked.length }}）</button>
    </div>
    <p class="feedback" :role="localError || error ? 'alert' : 'status'">{{ localError || error || (loading ? '正在读取冻结选项与已保存选择' : `待确认 ${changesCount} 台；未确认内容尚未保存`) }}</p>
    <div class="bandwidth-table" tabindex="0" aria-label="设备带宽分页列表">
      <table>
        <colgroup><col class="check-column" /><col /><col /><col /><col /></colgroup>
        <thead><tr><th>勾选</th><th>设备 / 型号</th><th>已冻结 / 来源</th><th>本次选择（kHz）</th><th>状态</th></tr></thead>
        <tbody>
          <tr v-for="row in pageRows" :key="row.deviceId">
            <td><input type="checkbox" :aria-label="`勾选设备 ${row.deviceId}`" :checked="checked.includes(row.deviceId)" :disabled="locked || !selectable(row)" :onChange="rowActions(row).toggle" /></td>
            <td><strong>{{ row.deviceId }}</strong><span>{{ row.modelName || row.modelId }}</span></td>
            <td><strong>{{ row.frozenKhz === null ? '未选' : `${row.frozenKhz} kHz` }}</strong><span>{{ row.frozenSource || '来源未提供' }}</span></td>
            <td><select :aria-label="`设备 ${row.deviceId} 带宽`" :value="selection(row)" :disabled="locked || !selectable(row)" :onChange="rowActions(row).choose">
              <option value="" disabled>{{ row.optionsKhz?.length ? '未选择' : '无资料' }}</option>
              <option v-for="value in validOptions(row)" :key="value" :value="String(value)">{{ value }}</option>
            </select></td>
            <td><strong>{{ drafts[row.deviceId] ? '待确认' : bandwidthRowState(row) }}</strong><span>{{ row.unavailableReason }}</span></td>
          </tr>
          <tr v-if="!pageRows.length"><td colspan="5">{{ loading ? '正在读取' : '没有匹配设备' }}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="toolbar pager">
      <button class="btn small" :disabled="page <= 1" @click="page--">上一页</button>
      <span>{{ page }} / {{ pages }} · {{ filtered.length }} 台</span>
      <button class="btn small" :disabled="page >= pages" @click="page++">下一页</button>
    </div>
    <div class="bandwidth-review" aria-label="带宽选择待确认清单" tabindex="0">
      <template v-if="reviewing"><p v-for="change in preview" :key="change.deviceId">{{ change.deviceId }}：{{ change.before === null ? '未选' : `${change.before} kHz` }} → {{ change.bandwidthKhz }} kHz</p></template>
      <p v-else>{{ changesCount ? '存在待确认选择' : '没有待确认选择' }}</p>
    </div>
    <div class="toolbar">
      <button class="btn small" :disabled="locked || !changesCount" @click="review">预览选择</button>
      <button class="btn primary small" :disabled="locked || !reviewing || !changesCount" @click="confirm">确认并提交选择</button>
      <button class="btn small" :disabled="busy || !changesCount" @click="discard">放弃本次选择</button>
    </div>
  </section>
</template>
<script lang="ts">
// 仅组件展示模型，不是后端 DTO；由宿主在正式契约解码后映射。
export interface CoverageBandwidthRow {
  deviceId: string; modelId: string; modelName: string;
  optionsKhz: readonly number[] | null; frozenKhz: number | null; frozenSource: string;
  editable: boolean; unavailableReason: string;
}
interface BandwidthDraft { before: number | null; value: number; modelId: string; options: string }
export interface CoverageBandwidthChange { deviceId: string; before: number | null; bandwidthKhz: number }
export function bandwidthOptionsValid(row: CoverageBandwidthRow) {
  return !!row.deviceId && !!row.modelId && Array.isArray(row.optionsKhz) && row.optionsKhz.length > 0
    && row.optionsKhz.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
    && new Set(row.optionsKhz).size === row.optionsKhz.length
    && (row.frozenKhz === null || row.optionsKhz.includes(row.frozenKhz));
}
export function bandwidthRowState(row: CoverageBandwidthRow) {
  if (!row.optionsKhz?.length) return '无资料';
  return !bandwidthOptionsValid(row) ? '资料待核验' : row.frozenKhz === null ? '未选' : '合法';
}
export function bandwidthConfirmation(rows: readonly CoverageBandwidthRow[], drafts: Readonly<Record<string, BandwidthDraft>>): CoverageBandwidthChange[] {
  const byId = new Map(rows.map(row => [row.deviceId, row]));
  if (byId.size !== rows.length) throw new Error('设备资料重复，请重新读取');
  return Object.entries(drafts).sort(([a], [b]) => a.localeCompare(b)).map(([deviceId, draft]) => {
    const row = byId.get(deviceId);
    if (!row || !row.editable || !bandwidthOptionsValid(row) || row.modelId !== draft.modelId
      || JSON.stringify(row.optionsKhz) !== draft.options || row.frozenKhz !== draft.before || !row.optionsKhz!.includes(draft.value))
      throw new Error('设备带宽资料或已冻结选择已变化，请重新读取并核对');
    return { deviceId, before: draft.before, bandwidthKhz: draft.value };
  });
}
</script>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
const props = withDefaults(defineProps<{ rows: readonly CoverageBandwidthRow[]; sourceKey: string; writable: boolean; loading?: boolean; busy?: boolean; error?: string }>(), { loading: false, busy: false, error: '' });
const emit = defineEmits<{ confirm: [value: { sourceKey: string; changes: CoverageBandwidthChange[] }]; dirtyChange: [dirty: boolean] }>();
const modelId = ref(''), onlyUnselected = ref(false), page = ref(1), checked = ref<string[]>([]), batchValue = ref('');
const emptyDrafts = () => Object.create(null) as Record<string, BandwidthDraft>;
const drafts = ref<Record<string, BandwidthDraft>>(emptyDrafts()), reviewing = ref(false), localError = ref('');
let sourceSerial = 0;
const preview = ref<CoverageBandwidthChange[]>([]), pageSize = 20;
const locked = computed(() => !props.sourceKey || !props.writable || props.loading || props.busy);
const selectable = (row: CoverageBandwidthRow) => row.editable && bandwidthOptionsValid(row);
const validOptions = (row: CoverageBandwidthRow) => bandwidthOptionsValid(row) ? row.optionsKhz! : [];
const models = computed(() => [...new Map(props.rows.map(row => [row.modelId, { id: row.modelId, name: row.modelName || row.modelId }])).values()]);
const filtered = computed(() => props.rows.filter(row => (!modelId.value || row.modelId === modelId.value) && (!onlyUnselected.value || row.frozenKhz === null)));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)));
const pageRows = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize));
const eligible = computed(() => modelId.value ? filtered.value.filter(selectable) : []);
const checkedRows = computed(() => props.rows.filter(row => checked.value.includes(row.deviceId) && row.modelId === modelId.value));
const batchOptions = computed(() => checkedRows.value.length ? validOptions(checkedRows.value[0]!).filter(value => checkedRows.value.every(row => selectable(row) && row.optionsKhz!.includes(value))) : []);
const changesCount = computed(() => Object.keys(drafts.value).length);
const selection = (row: CoverageBandwidthRow) => String(drafts.value[row.deviceId]?.value ?? row.frozenKhz ?? '');
function discard() { if (props.busy) return; drafts.value = emptyDrafts(); preview.value = []; reviewing.value = false; localError.value = ''; }
watch(() => props.sourceKey, () => {
  // 来源切换只清理本地意图，不向新来源回放旧确认。
  sourceSerial++; drafts.value = emptyDrafts(); preview.value = []; reviewing.value = false; localError.value = '';
  checked.value = []; batchValue.value = ''; modelId.value = ''; page.value = 1;
}, { flush: 'sync' });
watch([modelId, onlyUnselected], () => { page.value = 1; checked.value = []; batchValue.value = ''; });
watch(pages, value => { if (page.value > value) page.value = value; });
watch(drafts, () => { reviewing.value = false; preview.value = []; emit('dirtyChange', changesCount.value > 0); }, { deep: true, flush: 'sync' });
function checkModel() { if (!locked.value && modelId.value) { checked.value = eligible.value.map(row => row.deviceId); batchValue.value = ''; } }
function toggle(row: CoverageBandwidthRow, event: Event) {
  if (locked.value || !selectable(row)) return;
  const enabled = (event.target as HTMLInputElement).checked;
  checked.value = enabled ? [...new Set([...checked.value, row.deviceId])] : checked.value.filter(id => id !== row.deviceId);
  batchValue.value = '';
}
function rowActions(row: CoverageBandwidthRow) {
  const source = props.sourceKey, serial = sourceSerial;
  const current = () => source === props.sourceKey && serial === sourceSerial && props.rows.some(value => value === row);
  return {
    choose: (event: Event) => { if (current()) choose(row, event); },
    toggle: (event: Event) => { if (current()) toggle(row, event); },
  };
}
function apply(rows: readonly CoverageBandwidthRow[], raw: string) {
  if (locked.value) return;
  localError.value = '';
  const value = raw.trim() ? Number(raw) : NaN;
  if (!rows.length || !Number.isFinite(value) || rows.some(row => !selectable(row) || !row.optionsKhz!.includes(value))) { localError.value = '请选择设备对应的合法带宽'; return; }
  // 设备ID只是键，不能被解释为对象原型成员。
  const next = Object.assign(emptyDrafts(), drafts.value);
  for (const row of rows) {
    if (value === row.frozenKhz) delete next[row.deviceId];
    else next[row.deviceId] = { before: row.frozenKhz, value, modelId: row.modelId, options: JSON.stringify(row.optionsKhz) };
  }
  drafts.value = next;
}
function choose(row: CoverageBandwidthRow, event: Event) { apply([row], (event.target as HTMLSelectElement).value); }
function applyBatch() {
  if (locked.value || !modelId.value || checkedRows.value.length !== checked.value.length) return;
  apply(checkedRows.value, batchValue.value);
}
function review() {
  if (locked.value || !changesCount.value) return;
  try { preview.value = bandwidthConfirmation(props.rows, drafts.value); reviewing.value = true; localError.value = ''; }
  catch (reason) { reviewing.value = false; localError.value = reason instanceof Error ? reason.message : '选择资料无效'; }
}
function confirm() {
  if (locked.value || !reviewing.value || !changesCount.value) return;
  try {
    const changes = bandwidthConfirmation(props.rows, drafts.value);
    emit('confirm', { sourceKey: props.sourceKey, changes }); reviewing.value = false; localError.value = '';
  } catch (reason) { reviewing.value = false; localError.value = reason instanceof Error ? reason.message : '选择资料无效'; }
}
</script>
<style scoped>
.bandwidth-editor { min-width: 0; max-width: 100%; font-size: 12px; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; }
label { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
select { min-width: 0; max-width: 100%; }
.toolbar select { width: 160px; }
.feedback { min-height: 40px; margin: 8px 0; overflow-wrap: anywhere; }
.bandwidth-table { height: 356px; overflow: auto; scrollbar-gutter: stable; overflow-anchor: none; border: 1px solid var(--line); }
table { width: 100%; min-width: 640px; table-layout: fixed; border-collapse: collapse; }
.check-column { width: 44px; }
th, td { padding: 8px; border-bottom: 1px solid var(--line); text-align: left; overflow-wrap: anywhere; }
th { position: sticky; top: 0; background: #102136; z-index: 1; }
td strong, td span { display: block; }
td span { color: var(--muted); margin-top: 5px; }
td select { width: 100%; }
.pager { min-height: 36px; justify-content: space-between; }
.bandwidth-review { height: 144px; overflow: auto; scrollbar-gutter: stable; overflow-anchor: none; border: 1px solid var(--line); padding: 8px; }
.bandwidth-review p { margin: 4px 0; overflow-wrap: anywhere; }
</style>
