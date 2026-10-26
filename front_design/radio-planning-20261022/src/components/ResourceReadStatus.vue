<template>
  <div
    v-if="
      loading ||
      messages.length ||
      store.notice ||
      store.stale ||
      !store.readable ||
      !store.workspace
    "
    class="read-status"
    role="status"
    aria-live="polite"
  >
    <div
      ><span v-if="!store.workspace && !loading && store.readable">资源尚未加载</span>
      <span
        v-if="loading"
        class="loading"
      >
        正在读取{{ store.workspace ? '，当前保留上次成功结果' : '' }}…</span
      >
      <p
        v-if="store.notice"
        class="warning"
        >{{ store.notice }}</p
      >
      <p
        v-if="store.stale && !store.notice"
        class="warning"
        >资源版本已变化，当前保留上次成功内容。</p
      >
      <p
        v-if="store.stale && (refreshHint || !store.notice)"
        class="warning"
        >{{ refreshHint || '请刷新资源后继续浏览。' }}</p
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
      v-if="showRefresh"
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
// Mock 与 HTTP 共用状态提示；来源和技术版本不进入正常页面。
defineProps<{ showRefresh?: boolean; refreshHint?: string }>();
const messages = computed(() => [...new Set(Object.values(store.errors))]);
// 视口、目录与详情属于后台读取，不插入提示条改变地图高度；初载和手动刷新仍提示。
const loading = computed(() => store.refreshing || !store.workspace && Object.values(store.pending).some(Boolean));
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
