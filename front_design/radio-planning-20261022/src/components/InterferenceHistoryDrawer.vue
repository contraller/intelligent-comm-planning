<template>
  <AppDrawer
    :visible="store.historyOpen"
    title="干扰分析历史"
    subtitle="选择记录查看冻结方案、干扰源和措施；旧结果不会被覆盖。"
    @update:visible="store.historyOpen = $event"
  >
    <p v-if="!store.historyTotal">暂无已提交分析。</p>
    <button
      v-for="view in store.history?.items ?? []"
      :key="view.id"
      class="history-row"
      :disabled="store.locked"
      @click="store.select(view.id)"
    >
      <strong>{{ view.name }} · {{ view.version }}</strong>
      <span>{{ new Date(view.startedAt).toLocaleString() }} · {{ labels[view.state] }}</span>
      <small
        >{{ view.sourceIds.join(' / ') }} ·
        {{
          view.source.state === 'CURRENT'
            ? '当前来源'
            : view.source.state === 'UNKNOWN'
              ? '来源待核实'
              : '历史来源'
        }}</small
      >
      <small>已采纳 {{ view.adoptionCount }} 项 · {{ view.id }}</small>
    </button>
    <div class="toolbar"
      ><button
        class="btn small"
        :disabled="store.historyPage <= 1"
        @click="store.loadHistory(store.historyPage - 1)"
        >上页</button
      ><span>{{ store.historyTotal }} 条 · 第 {{ store.historyPage }} 页</span
      ><button
        class="btn small"
        :disabled="store.historyPage * 20 >= store.historyTotal"
        @click="store.loadHistory(store.historyPage + 1)"
        >下页</button
      ></div
    >
    <template #footer><p>记录与规划工作区共同保留；重置规划会同时清空这些分析。</p></template>
  </AppDrawer>
</template>
<script setup lang="ts">
import { useInterferenceStore } from '../stores/interference';
import AppDrawer from './AppDrawer.vue';
const store = useInterferenceStore();
const labels = {
  PENDING: '排队中',
  RUNNING: '分析中',
  SUCCESS: '成功',
  FAILED: '失败',
  CANCELLED: '已取消',
};
</script>
<style scoped>
.history-row {
  display: grid;
  gap: 8px;
  width: 100%;
  padding: 16px;
  margin: 10px 0;
  background: #14283e;
  border: 1px solid #30506e;
  text-align: left;
  overflow-wrap: anywhere;
}
.history-row small {
  color: #94acc6;
}
</style>
