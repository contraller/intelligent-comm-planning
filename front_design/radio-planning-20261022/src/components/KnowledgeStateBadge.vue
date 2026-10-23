<template>
  <span
    class="knowledge-state"
    :class="tone"
    ><i
      class="pi"
      :class="
        state === 'REJECTED'
          ? 'pi-times-circle'
          : state === 'PENDING'
            ? 'pi-clock'
            : state === 'PUBLISHED'
              ? 'pi-check-circle'
              : 'pi-file'
      "
    />{{ labels[state] ?? state }}</span
  ><span
    v-if="stale"
    class="stale"
    ><i class="pi pi-exclamation-triangle" />基线已过期</span
  >
</template>
<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ state: string; stale?: boolean }>();
const labels: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '待审核',
  APPROVED: '审核通过 · 待发布',
  REJECTED: '已驳回',
  PUBLISHED: '已发布',
  WITHDRAWN: '已撤回',
};
const tone = computed(() =>
  props.state === 'REJECTED'
    ? 'red'
    : props.state === 'PENDING'
      ? 'amber'
      : ['PUBLISHED', 'APPROVED'].includes(props.state)
        ? 'green'
        : 'muted',
);
</script>
<style scoped>
.knowledge-state,
.stale {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 12px;
}
.green {
  color: #64cfab;
}
.red {
  color: #f0999f;
}
.amber,
.stale {
  color: #edc475;
}
.stale {
  margin-left: 9px;
}
</style>
