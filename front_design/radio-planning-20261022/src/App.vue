<template>
  <div :inert="auth.blocked || undefined"><RouterView :key="viewGeneration" /></div
  ><SessionAccessDialog />
</template>
<script setup lang="ts">
import { watch } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionAccess } from './composables/useSessionAccess';
import { useAuthStore } from './stores/auth';
import SessionAccessDialog from './components/SessionAccessDialog.vue';
const auth = useAuthStore(),
  { viewGeneration } = useSessionAccess();
const route = useRoute();
// PrimeVue浮层与原生控件使用同一页面配色，嵌入页保持浅色。
watch(() => route.meta.embedded === true, embedded => {
  if (typeof document !== 'undefined') document.documentElement?.classList?.toggle('app-dark', !embedded);
}, { immediate: true, flush: 'sync' });
// 冻结保留组件实例；只在明确结束会话/丢弃后重建业务视图。
</script>
