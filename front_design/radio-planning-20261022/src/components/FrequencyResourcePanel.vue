<template>
  <section class="frequency-panel" aria-label="规划频点管理">
    <div class="frequency-heading">
      <h2>规划频点</h2>
      <div class="toolbar">
        <button v-if="session.canMaintain" class="btn" :disabled="!store.canMaintain || store.busy || !!store.editor" @click="store.openEditor('ADD')">
          <i class="pi pi-plus" aria-hidden="true" />新增构造频点</button>
        <button v-if="session.canMaintain" class="btn" :disabled="!store.canMaintain || store.busy || !store.selectedIds.length || !!store.editor"
          @click="store.prepareChanges(store.selectedIds.map(freqId => ({ kind: 'ENABLE', freqId })))"><i class="pi pi-play" aria-hidden="true" />启用所选</button>
        <button class="btn" :disabled="!session.readable || store.busy || !!store.pending || !!store.editor" @click="store.refresh()">
          <i class="pi pi-refresh" aria-hidden="true" />刷新</button>
        <button class="btn primary" :disabled="!session.canDisable || !store.canSelect || !store.selectedIds.length || store.busy" @click="store.prepareDisable()">
          <i class="pi pi-ban" aria-hidden="true" />停用所选</button>
      </div>
    </div>
    <p v-if="!session.readable" role="alert">无资源查看权限</p>
    <p v-if="store.page" class="frequency-source">{{ store.page.source }} · 版本 {{ store.page.revision }}</p>
    <p v-if="store.error" role="alert" class="frequency-error">{{ store.error }}</p>
    <p v-if="store.notice" role="status" class="notice">{{ store.notice }}</p>
    <p v-if="store.stale" role="alert">当前保留旧版内容，刷新后才能继续选择和停用。</p>
    <p v-else-if="store.listFailed && store.page" role="alert">当前显示上次成功列表，重新读取成功前不能停用。</p>
    <form class="frequency-filters" @submit.prevent="applyFilters">
      <fieldset :disabled="!session.readable || store.locked || !!store.editor || store.phase === 'SAVING'">
        <label>搜索<input v-model="filters.search" maxlength="120" aria-label="频点编号或备注" /></label>
        <label>类别<select v-model="filters.deviceClass"><option value="">全部</option><option value="HF">HF</option><option value="VUHF">VUHF</option></select></label>
        <label>可用性<select v-model="filters.availability"><option value="">全部</option><option value="AVAILABLE">可用</option><option value="DISABLED">已停用</option></select></label>
        <label>下限 / kHz<input v-model="filters.minKhz" type="number" min="0" step="any" /></label>
        <label>上限 / kHz<input v-model="filters.maxKhz" type="number" min="0" step="any" /></label>
        <button class="btn" type="submit"><i class="pi pi-search" aria-hidden="true" />筛选</button>
        <button class="btn icon" type="button" title="清空筛选" aria-label="清空筛选" @click="clearFilters"><i class="pi pi-filter-slash" aria-hidden="true" /></button>
      </fieldset>
    </form>
    <div class="frequency-selection">
      <label><input type="checkbox" :checked="pageSelected" :disabled="!store.canSelect || !rows.length"
        @change="store.selectPage(($event.target as HTMLInputElement).checked)" />选择当前页</label>
      <span>已选 {{ store.selectedIds.length }} / 50</span>
      <button class="text-link" :disabled="store.locked || !store.selectedIds.length" @click="store.clearSelection()">清空选择</button>
    </div>
    <AppTable :rows="rows" :columns="columns" :server="true" :sortable="false" :compact="true" table-min-width="760px"
      :loading="!!store.loading.list || !!store.loading.context" :total="store.page?.total ?? 0" :page-size="store.page?.pageSize ?? store.query.pageSize"
      :first="((store.page?.page ?? store.query.page) - 1) * (store.page?.pageSize ?? store.query.pageSize)" :details-key="store.page?.revision"
      @page="changePage" @select="store.detail = $event">
      <template #selected="{ row }"><input type="checkbox" :aria-label="'选择频点 ' + row.freqId"
        :disabled="!store.canSelect" :checked="store.selectedIds.includes(row.freqId)" @click.stop
        @change="store.select(row.freqId, ($event.target as HTMLInputElement).checked)" /></template>
      <template #isAvailable="{ row }"><span class="chip" :class="{ amber: !row.isAvailable }">{{ row.isAvailable ? '可用' : '已停用' }}</span></template>
      <template #actions="{ row }"><div class="toolbar"><button class="text-link" @click.stop="store.detail = row">详情</button>
        <button v-if="session.canMaintain" class="text-link" :disabled="!store.canMaintain || store.busy || !!store.editor" @click.stop="store.openEditor('PATCH', row)">编辑</button>
        <button v-if="session.canMaintain && !row.isAvailable" class="text-link" :disabled="!store.canMaintain || store.busy || !!store.editor"
          @click.stop="store.prepareChanges([{ kind: 'ENABLE', freqId: row.freqId }])">启用</button></div></template>
    </AppTable>
    <section v-if="store.pending" class="frequency-pending" aria-label="待核实请求">
      <h3>提交结果待核实</h3><p class="frequency-id">{{ store.pending.requestId }}</p>
      <div class="toolbar">
        <button class="btn" :disabled="store.busy || !session.readable" @click="store.inspectOperation(store.pending!.requestId)">核实原回执</button>
        <button class="btn" :disabled="store.busy || ('changes' in store.pending ? !session.canMaintain : !session.canDisable)" @click="store.retryPending()">重试原请求</button>
      </div>
    </section>
    <section v-if="store.receipt" class="frequency-receipt" aria-label="本次停用回执">
      <h3>{{ !store.receipt.changed ? '无变化回执' : store.receipt.objectId === 'resource-frequency-disable' ? '停用回执' : '构造维护回执' }}</h3>
      <p class="frequency-id">{{ store.receipt.requestId }}</p>
      <p>更新 {{ store.receipt.updated.length }} 项，无变化 {{ store.receipt.unchanged.length }} 项。</p>
      <p class="frequency-id">保存版本 {{ store.receipt.revision }}</p>
    </section>
    <section class="frequency-history" aria-label="本人频点操作历史">
      <h3>本人操作历史</h3>
      <form class="toolbar" @submit.prevent="store.loadHistory({ page: 1, search: historySearch })">
        <label>请求号<input v-model="historySearch" maxlength="120" /></label>
        <button class="btn" :disabled="!session.readable || !!store.loading.history"><i class="pi pi-search" aria-hidden="true" />查询历史</button>
      </form>
      <form class="toolbar" @submit.prevent="store.inspectOperation(lookupId)">
        <label>核实原请求<input v-model="lookupId" maxlength="120" /></label>
        <button class="btn" :disabled="!session.readable || !lookupId || store.busy" type="submit">读取回执</button>
      </form>
      <AppTable :rows="historyRows" :columns="historyColumns" :server="true" :sortable="false" :compact="true"
        :loading="!!store.loading.history" :total="store.history?.total ?? 0" :page-size="store.history?.pageSize ?? store.historyQuery.pageSize"
        :first="((store.history?.page ?? store.historyQuery.page) - 1) * (store.history?.pageSize ?? store.historyQuery.pageSize)" table-min-width="680px"
        @page="changeHistoryPage" @select="store.inspectOperation($event.requestId)">
        <template #operation="{ row }">{{ row.operation === 'FREQUENCY_CHANGES' ? '构造维护' : '停用' }}</template>
        <template #changed="{ row }">{{ row.changed ? '已变更' : '无变化' }}</template>
        <template #actions="{ row }"><button class="text-link" @click.stop="store.inspectOperation(row.requestId)">回读</button></template>
      </AppTable>
    </section>
    <AppDrawer :visible="!!store.detail" title="规划频点详情" @update:visible="!$event && (store.detail = null)">
      <dl v-if="store.detail" class="frequency-details">
        <template v-for="field in detailColumns" :key="field.field"><dt>{{ field.header }}</dt><dd>{{ store.detail[field.field] ?? '未提供' }}</dd></template>
      </dl>
    </AppDrawer>
    <AppDrawer :visible="!!store.operation" title="历史操作回执" @update:visible="!$event && (store.operation = null)">
      <template v-if="store.operation">
        <p class="frequency-id">{{ store.operation.requestId }}</p><p>{{ store.operation.createdAt }}</p>
        <p>{{ store.operation.receipt.source }}</p>
        <p class="frequency-id">原版本 {{ store.operation.receipt.baseRevision }}</p>
        <p class="frequency-id">保存版本 {{ store.operation.receipt.revision }}</p>
        <p>已更新：{{ store.operation.receipt.updated.join('、') || '无' }}</p>
        <p>无变化：{{ store.operation.receipt.unchanged.join('、') || '无' }}</p>
      </template>
    </AppDrawer>
    <section v-if="store.changesPreview" class="frequency-receipt" aria-label="构造维护预检">
      <h3>构造维护预检</h3>
      <dl v-for="entry in store.changesPreview.items" :key="entry.freqId" class="frequency-details">
        <dt>{{ entry.kind }} {{ entry.freqId }}</dt><dd>{{ !entry.before ? '未创建' : entry.before.isAvailable ? '可用' : '已停用' }} → {{ entry.after.isAvailable ? '可用' : '已停用' }}</dd>
        <template v-for="field in detailColumns" :key="field.field"><dt>{{ field.header }}</dt>
          <dd>{{ entry.before?.[field.field] ?? '未提供' }} → {{ entry.after[field.field] ?? '未提供' }}</dd></template>
      </dl>
    </section>
    <FrequencyResourceEditDrawer :visible="!!store.editor" :mode="store.editor?.kind ?? 'ADD'" :item="store.editor?.item ?? null"
      :busy="store.busy || !!store.changesPreview || !!store.pending || store.stale" :editable="session.canMaintain && session.readable"
      :error="store.error" @close="store.closeEditor()" @preview="store.prepareChanges([$event])" @dirty-change="store.editorDirty = $event" />
    <DecisionDialog :request="store.decision" @answer="store.answer" />
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import AppTable from './AppTable.vue';
import AppDrawer from './AppDrawer.vue';
import DecisionDialog from './DecisionDialog.vue';
import FrequencyResourceEditDrawer from './FrequencyResourceEditDrawer.vue';
import { useFrequencyResourceStore } from '../stores/frequency-resource';
import type { FrequencyResourceChange, FrequencyResourceHostContext, FrequencyResourceItem, FrequencyResourceServices } from '../types/frequency-resource';

const props = defineProps<{ active: boolean; session: FrequencyResourceHostContext; services: FrequencyResourceServices;
  loadContext: (signal?: AbortSignal) => Promise<{ revision: string }> }>();
const emit = defineEmits<{ resourceChanged: [value: FrequencyResourceChange]; busyChange: [value: boolean]; pendingOperationChange: [value: boolean] }>();
const store = useFrequencyResourceStore();
const filters = reactive({ search: '', deviceClass: '', availability: '', minKhz: '', maxKhz: '' });
const historySearch = ref(''), lookupId = ref('');
let initialized = false;
const rows = computed(() => (store.page?.items ?? []).map(item => ({ ...item, id: item.freqId })));
const historyRows = computed(() => (store.history?.items ?? []).map(item => ({ ...item, id: item.requestId })));
const pageSelected = computed(() => rows.value.length > 0 && rows.value.every(row => store.selectedIds.includes(row.freqId)));
const columns = [{ field: 'selected', header: '选择', minWidth: '48px' }, { field: 'freqId', header: '频点编号' },
  { field: 'deviceClass', header: '类别' }, { field: 'centerFreqKhz', header: '中心频率 / kHz' },
  { field: 'bandwidthKhz', header: '带宽 / kHz' }, { field: 'isAvailable', header: '可用性' }];
const detailColumns: { field: keyof FrequencyResourceItem; header: string }[] = [
  { field: 'freqId', header: '编号' }, { field: 'deviceClass', header: '类别' }, { field: 'centerFreqKhz', header: '中心频率 / kHz' },
  { field: 'bandwidthKhz', header: '带宽 / kHz' }, { field: 'channelNo', header: '信道号' }, { field: 'occupiedBy', header: '占用方' },
  { field: 'reuseMinDistanceM', header: '复用间距 / m' }, { field: 'adjacentGuardKhz', header: '邻道间隔 / kHz' }, { field: 'note', header: '备注' }];
const historyColumns = [{ field: 'requestId', header: '请求号', minWidth: '180px' }, { field: 'operation', header: '操作' }, { field: 'createdAt', header: '时间' },
  { field: 'changed', header: '结果' }, { field: 'selectedCount', header: '所选' }, { field: 'updatedCount', header: '更新' }, { field: 'unchangedCount', header: '无变化' }];
async function applyFilters() {
  await store.applyFilters({ search: filters.search,
    deviceClass: (filters.deviceClass || undefined) as 'HF' | 'VUHF' | undefined,
    availability: (filters.availability || undefined) as 'AVAILABLE' | 'DISABLED' | undefined,
    minKhz: filters.minKhz === '' ? undefined : Number(filters.minKhz), maxKhz: filters.maxKhz === '' ? undefined : Number(filters.maxKhz) });
}
async function clearFilters() { Object.assign(filters, { search: '', deviceClass: '', availability: '', minKhz: '', maxKhz: '' }); await applyFilters(); }
function changePage(value: { first: number; rows: number }) {
  if (!store.locked && !store.editor) void store.loadPage({ page: Math.floor(value.first / value.rows) + 1, pageSize: value.rows as 5 | 10 | 20 | 50 });
}
function changeHistoryPage(value: { first: number; rows: number }) {
  void store.loadHistory({ page: Math.floor(value.first / value.rows) + 1, pageSize: value.rows as 5 | 10 | 20 | 50 });
}
watch(() => [props.active, props.session.accountId, props.session.generation, props.session.readable,
  props.session.canDisable, props.session.canMaintain, props.services, props.loadContext], () => {
  const restoreFilters = !initialized || store.session?.accountId !== props.session.accountId
    || store.session?.generation !== props.session.generation;
  store.configure({ services: props.services, loadContext: props.loadContext, session: props.session,
    onResourceChanged: value => emit('resourceChanged', value) });
  if (restoreFilters) {
    Object.assign(filters, { search: store.query.search ?? '', deviceClass: store.query.deviceClass ?? '',
      availability: store.query.availability ?? '', minKhz: store.query.minKhz === undefined ? '' : String(store.query.minKhz),
      maxKhz: store.query.maxKhz === undefined ? '' : String(store.query.maxKhz) });
    historySearch.value = store.historyQuery.search ?? ''; lookupId.value = ''; initialized = true;
  }
  if (props.active && props.session.readable) {
    if (store.pending) void store.loadHistory(); else void store.refresh();
  } else store.stopReading();
}, { immediate: true });
watch(() => store.busy, value => emit('busyChange', value), { immediate: true });
watch(() => !!store.pending, value => emit('pendingOperationChange', value), { immediate: true });
onBeforeUnmount(store.stopReading);
defineExpose({ requestLeave: () => store.requestLeave(), stopReading: () => store.stopReading(), refresh: () => store.refresh() });
</script>
<style scoped>
.frequency-panel { min-width: 0; }
.frequency-heading, .frequency-selection { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.frequency-heading h2 { font-size: 20px; margin: 0; }
.frequency-panel h3 { font-size: 16px; margin: 0 0 12px; }
.frequency-source { color: var(--muted); overflow-wrap: anywhere; }
.frequency-error { color: var(--danger, #f29b9b); }
.frequency-filters fieldset { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; border: 0; padding: 12px 0; margin: 0; }
.frequency-panel label { display: grid; gap: 5px; font-size: 13px; min-width: 0; }
.frequency-panel input:not([type='checkbox']), .frequency-panel select { width: 100%; max-width: 220px; min-width: 0; }
.frequency-selection { justify-content: flex-start; padding: 10px 0; }
.frequency-selection label { display: flex; align-items: center; }
.frequency-history, .frequency-pending, .frequency-receipt { border-top: 1px solid var(--line, #526168); margin-top: 20px; padding-top: 16px; }
.frequency-history .toolbar { flex-wrap: wrap; align-items: end; margin-bottom: 12px; }
.frequency-details { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr); gap: 12px; }
.frequency-details dd { margin: 0; overflow-wrap: anywhere; }
.frequency-id { overflow-wrap: anywhere; }
@media (max-width: 600px) { .frequency-filters fieldset > label { flex: 1 1 140px; } .frequency-panel input:not([type='checkbox']), .frequency-panel select { max-width: none; } }
</style>
