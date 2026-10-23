<template>
  <section class="progress-panel"
    ><div class="title"
      ><strong>{{ labels[view.state] }} · {{ view.progress }}%</strong
      ><button
        v-if="['PENDING', 'RUNNING'].includes(view.state)"
        class="btn small"
        :disabled="!auth.can('diagnosis.execute') || busy"
        @click="$emit('cancel')"
        >取消任务</button
      ></div
    ><progress
      :value="view.progress"
      max="100"
    /><div class="phases"
      ><span
        v-for="phase in view.phases"
        :key="phase.name"
        :class="phase.state"
        >{{ phase.name }}</span
      ></div
    ><p
      v-if="queryError"
      class="error"
      >{{ queryError }}
      <button
        class="text-link"
        @click="$emit('retry')"
        >重试查询</button
      ></p
    ><p
      v-if="view.error"
      class="error"
      >{{ view.error }}</p
    ><p
      v-if="view.source.state !== 'CURRENT'"
      class="historical"
      >{{ view.source.reasons.join('；') }}。任务继续使用冻结快照。</p
    ></section
  >
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import type { DiagnosisRunView } from '../types/diagnosis';
defineProps<{ view: DiagnosisRunView; queryError: string; busy: boolean }>();
defineEmits<{ cancel: []; retry: [] }>();
const labels = {
  PENDING: '排队中',
  RUNNING: '运行中',
  SUCCESS: '已完成',
  FAILED: '执行失败',
  CANCELLED: '已取消',
};
</script>
<style scoped>
.progress-panel {
  padding: 14px;
  background: #14263d;
  border: 1px solid #315170;
  border-radius: 6px;
}
.title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}
progress {
  width: 100%;
  height: 7px;
  accent-color: #50b8e9;
  margin: 13px 0;
}
.phases {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: #71869f;
}
.phases .done {
  color: #6dd4ad;
}
.phases .running {
  color: #91d5ff;
}
.error {
  color: #ffafb9;
  font-size: 12px;
}
.historical {
  color: #eac486;
  font-size: 12px;
  line-height: 1.7;
}
</style>
