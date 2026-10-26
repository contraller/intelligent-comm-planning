<template>
  <span
    class="status-badge"
    :class="tone"
    ><span class="dot" />{{ label }}</span
  >
  <span
    v-if="alert"
    class="alert-mark"
    title="告警为附加状态"
    ><i class="pi pi-exclamation-triangle" /> 告警</span
  >
</template>

<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ status: string; alert?: boolean }>();
const labels: Record<string, string> = {
  NORMAL: '正常',
  FAULT: '故障',
  OFFLINE: '离线',
  EXCELLENT: '优',
  GOOD: '良好',
  WARNING: '波动',
};
const label = computed(() => labels[props.status] ?? props.status);
const tone = computed(() =>
  props.status === 'FAULT'
    ? 'red'
    : ['OFFLINE', '停用', '草稿', '历史版本'].includes(props.status)
      ? 'grey'
      : props.alert || props.status === 'WARNING' || props.status === '待审核'
        ? 'amber'
        : 'green',
);
</script>

<style scoped>
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  white-space: nowrap;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.green {
  color: #57c8a8;
}
.red {
  color: #f17d8b;
}
.grey {
  color: #8797ad;
}
.amber {
  color: #eac179;
}
.alert-mark {
  font-size: 10px;
  color: #eac179;
  margin-left: 8px;
  white-space: nowrap;
}
.alert-mark .pi {
  font-size: 10px;
}
</style>
