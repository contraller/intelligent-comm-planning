<template>
  <AppDrawer :visible="store.historyOpen" title="干扰分析历史" @update:visible="store.historyOpen = $event">
    <div class="toolbar"><input v-model="store.historySearch" type="search" aria-label="搜索运行或方案编号" />
      <select v-model="store.historyState" aria-label="运行状态"><option value="">全部状态</option><option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option></select>
      <button class="icon-button" title="查询历史" aria-label="查询历史" :disabled="store.locked" @click="store.loadHistory(1)"><i class="pi pi-search" aria-hidden="true" /></button>
    </div>
    <p v-if="!store.taskContext">请选择任务及确认方案。</p>
    <p v-else-if="!store.historyTotal">暂无分析记录。</p>
    <button v-for="row in store.history?.items ?? []" :key="row.run_id" class="history-row" :disabled="store.locked" @click="store.selectRun(row.run_id)">
      <strong>{{ row.plan_id }} · {{ row.plan_version }} · {{ labels[row.state] }}</strong>
      <span>{{ row.started_at }} · {{ row.run_id }}</span><small>{{ row.source_state.state === 'CURRENT' ? '当前来源' : '冻结历史 / 待核实' }} · 采纳记录 {{ row.adoption_count }} 项</small>
    </button>
    <div class="toolbar"><button class="icon-button" title="历史上一页" aria-label="历史上一页" :disabled="store.historyPage <= 1 || store.locked" @click="store.loadHistory(store.historyPage - 1)"><i class="pi pi-angle-left" aria-hidden="true" /></button><span>{{ store.historyPage }} · 共 {{ store.historyTotal }} 项</span><button class="icon-button" title="历史下一页" aria-label="历史下一页" :disabled="store.historyPage * 20 >= store.historyTotal || store.locked" @click="store.loadHistory(store.historyPage + 1)"><i class="pi pi-angle-right" aria-hidden="true" /></button></div>
    <p v-if="store.queryError" role="alert">{{ store.queryError }}</p>
    <p class="muted">场景版本、分析和采纳记录独立持久化；规划重置不清除这些历史。</p>
  </AppDrawer>
</template>
<script setup lang="ts">
import AppDrawer from './AppDrawer.vue';
import { useInterferenceStore } from '../stores/interference';
const store = useInterferenceStore();
const labels = { PENDING: '排队中', RUNNING: '分析中', CANCEL_REQUESTED: '取消请求中', SUCCESS: '分析完成', FAILED: '失败', CANCELLED: '已取消' };
</script>
<style scoped>
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}input{flex:1;min-width:120px}.icon-button{width:32px;height:32px;flex:0 0 32px}.history-row{display:grid;gap:6px;padding:12px 0;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:transparent;overflow-wrap:anywhere}.muted,small{color:var(--muted)}p{overflow-wrap:anywhere}
</style>
