<template>
  <AppDrawer :visible="visible" title="设备资源追溯" width="620px" @update:visible="!$event && $emit('close')">
    <p v-if="busy" role="status">正在读取留存历史…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="toolbar"><button class="btn" :disabled="busy" @click="$emit('refresh')">读取维护历史</button></div>
    <p v-if="history?.total === 0">该设备没有留存历史</p>
    <ul class="history">
      <li v-for="item in history?.items ?? []" :key="item.request_id ?? item.revision">
        <button class="btn" :disabled="busy" @click="$emit('select', item)">{{ item.kind === 'RETAINED_BASELINE' ? '留存基线（不是修改）' : item.request_id }}</button>
        <p>{{ item.created_at }} · {{ item.actor_id ?? '操作者未知／不适用' }}</p>
        <p class="identifier">{{ item.revision }}</p>
        <p v-if="item.changed_fields.length">修改字段 {{ item.changed_fields.join('、') }}</p>
      </li>
    </ul>
    <div v-if="history" class="toolbar">
      <button class="btn" :disabled="busy || history.page <= 1" @click="$emit('page', history.page - 1)">上一页</button>
      <span>{{ history.page }} · 共 {{ history.total }} 条</span>
      <button class="btn" :disabled="busy || history.page * history.page_size >= history.total" @click="$emit('page', history.page + 1)">下一页</button>
    </div>
    <section v-if="selected">
      <h3>选定来源 · {{ selected.kind === 'RETAINED_BASELINE' ? '留存基线' : selected.request_id }}</h3>
      <p v-if="selected.kind === 'RETAINED_BASELINE'">时间为资源入库留存时间，不是设备采集或修改时间。</p>
      <dl v-if="record"><template v-for="diff in record.diffs" :key="diff.field">
        <dt>{{ diff.field }}</dt><dd>{{ diff.before || '未知' }} → {{ diff.after || '未知' }}</dd>
      </template></dl>
      <button class="btn" :disabled="busy || !editable" @click="$emit('preview')">生成三参数恢复候选</button>
    </section>
    <DeviceRestorePreview :preview="restore" :editable="editable" :busy="busy" @apply="$emit('restore', $event)" />
    <section v-if="configurations" aria-label="独立配置受理历史">
      <h3>配置受理记录 · 不代表参数已生效</h3>
      <button v-for="item in configurations.items" :key="item.request_id" class="btn" :disabled="busy" @click="$emit('configuration', item.request_id)">{{ item.request_id }} · 未下发</button>
      <div class="toolbar">
        <button class="btn" :disabled="busy || configurations.page <= 1" @click="$emit('configuration-page', configurations.page - 1)">上一受理页</button>
        <button class="btn" :disabled="busy || configurations.page * configurations.page_size >= configurations.total" @click="$emit('configuration-page', configurations.page + 1)">下一受理页</button>
      </div>
      <p v-if="configuration">{{ configuration.message }}</p>
    </section>
  </AppDrawer>
</template>
<script setup lang="ts">
import AppDrawer from './AppDrawer.vue';
import DeviceRestorePreview from './DeviceRestorePreview.vue';
import type { TracePage, TraceSummary, TraceDetail, RestoreProposal } from '../types/device-trace';
import type { ConfigurationAcceptanceHistory, ConfigurationSystemAcceptance } from '../services/device-configuration-decode';
withDefaults(defineProps<{
  visible: boolean; busy: boolean; error: string; editable: boolean; history: TracePage | null; record: TraceDetail | null;
  selected?: TraceSummary | null; restore: RestoreProposal | null; configurations?: ConfigurationAcceptanceHistory | null; configuration?: ConfigurationSystemAcceptance | null;
}>(), { selected: null, configurations: null, configuration: null });
defineEmits<{
  close: []; refresh: []; select: [value: TraceSummary]; page: [value: number]; preview: []; restore: [value: RestoreProposal];
  configuration: [requestId: string]; 'configuration-page': [page: number];
}>();
</script>
<style scoped>
.history { list-style: none; padding: 0; }
.history li, section { border-top: 1px solid var(--line, #d5d9de); padding: 12px 0; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }
h3 { font-size: 14px; } p, dd { overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr); gap: 8px; }
dd { margin: 0; }
</style>
