<template>
  <div :inert="auth.blocked || undefined"><RouterView :key="viewGeneration" /></div
  ><SessionAccessDialog />
</template>
<script setup lang="ts">
import { useSessionAccess } from './composables/useSessionAccess';
import { useAuthStore } from './stores/auth';
import SessionAccessDialog from './components/SessionAccessDialog.vue';
const auth = useAuthStore(),
  { viewGeneration } = useSessionAccess();
// 冻结保留组件实例；只在明确结束会话/丢弃后重建业务视图。
</script>
