<template>
  <div
    class="read-status"
    role="status"
    aria-live="polite"
  >
    <div
      ><span v-if="store.workspace"
        >{{ store.workspace.source }} · 资源版本 {{ store.workspace.revision }}</span
      ><span v-else>资源尚未加载</span>
      <span
        v-if="loading"
        class="loading"
      >
        · 正在读取{{ store.workspace ? '，当前保留上次成功结果' : '' }}…</span
      >
      <p
        v-if="store.notice"
        class="warning"
        >{{ store.notice }}</p
      >
      <p
        v-for="message in messages"
        :key="message"
        class="warning"
        >{{ message }}{{ store.workspace ? '；当前内容属于上次成功查询，尚未更新。' : '' }}</p
      >
      <p
        v-if="!store.readable"
        class="warning"
        >当前页面读取权限不可用，已停止更新。</p
      >
    </div>
    <button
      class="btn small"
      :disabled="!store.readable || store.refreshing"
      @click="store.refresh()"
      >{{ store.refreshing ? '正在刷新' : '刷新资源' }}</button
    >
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useResourceReadStore } from '../stores/resource-read';
const store = useResourceReadStore();
const messages = computed(() => [...new Set(Object.values(store.errors))]);
const loading = computed(() => store.refreshing || Object.values(store.pending).some(Boolean));
// 版本与来源属于业务可核实信息，通道名称及传输细节不进入页面文案。
</script>
<style scoped>
.read-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 14px;
  border: 1px solid var(--line);
  background: var(--panel);
  font-size: 12px;
  line-height: 1.7;
}
.read-status p {
  margin: 4px 0 0;
}
.warning {
  color: #edc17a;
}
.loading {
  color: #88a9c4;
}
</style>
