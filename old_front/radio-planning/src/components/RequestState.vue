<template>
  <div
    class="request-state"
    role="status"
  >
    <i
      class="pi"
      :class="icons[state]"
    />
    <h3>{{ labels[state] }}</h3>
    <p>{{ message }}</p>
    <button
      v-if="state === 'error'"
      class="btn"
      @click="$emit('retry')"
      >重新加载</button
    >
  </div>
</template>
<script setup lang="ts">
withDefaults(
  defineProps<{ state: 'loading' | 'empty' | 'error' | 'forbidden'; message?: string }>(),
  { message: '' },
);
defineEmits<{ retry: [] }>();
const labels = {
  // 数据来源由页面说明，共用状态不预判 Mock 或 HTTP。
  loading: '正在加载数据',
  empty: '暂无符合条件的数据',
  error: '数据加载失败',
  forbidden: '暂无访问权限',
};
const icons = {
  loading: 'pi-spin pi-spinner',
  empty: 'pi-inbox',
  error: 'pi-exclamation-circle',
  forbidden: 'pi-lock',
};
</script>
<style scoped>
.request-state {
  display: flex;
  min-height: 240px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 35px;
  text-align: center;
}
.pi {
  font-size: 30px;
  color: var(--blue);
}
p {
  color: var(--muted);
  max-width: 580px;
  line-height: 1.7;
}
</style>
