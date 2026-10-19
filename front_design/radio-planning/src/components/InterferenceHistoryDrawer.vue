<template>
  <AppDrawer
    :visible="store.historyOpen"
    title="干扰分析历史"
    subtitle="选择记录查看冻结方案、干扰源和措施；旧结果不会被覆盖。"
    @update:visible="store.historyOpen = $event"
  >
    <p v-if="!store.views.length">暂无已提交分析。</p>
    <button
      v-for="view in [...store.views].reverse()"
      :key="view.run.analysisId"
      class="history-row"
      :disabled="store.locked"
      @click="store.select(view.run.analysisId)"
    >
      <strong>{{ view.run.network.name }} · {{ view.run.network.version }}</strong>
      <span>{{ new Date(view.run.startedAt).toLocaleString() }} · {{ labels[view.state] }}</span>
      <small
        >{{ view.run.sources.map((source) => source.id).join(' / ') }} ·
        {{
          view.source.state === 'CURRENT'
            ? '当前来源'
            : view.source.state === 'UNKNOWN'
              ? '来源待核实'
              : '历史来源'
        }}</small
      >
      <small>已采纳 {{ view.adoptions.length }} 项 · {{ view.run.analysisId }}</small>
    </button>
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
