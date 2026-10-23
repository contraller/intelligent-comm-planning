<template>
  <section
    class="panel"
    :class="{ 'compact-progress': compact }"
    ><div
      v-if="showJob"
      class="panel-head"
      ><h3>{{ planning.job ? labels[planning.job.state] : '尚未提交规划' }}</h3></div
    ><div class="panel-body">
      <template v-if="showJob && planning.job"
        ><p v-if="!compact || planning.running"
          >{{ planning.job.input.name }} · {{ planning.job.progress.toFixed(0) }}%</p
        ><progress
          v-if="planning.running || !compact"
          :value="planning.job.progress"
          max="100"
          aria-label="规划任务进度"
        /><details :open="planning.running || !compact"
          ><summary>阶段记录与作业详情</summary><p class="muted">作业编号：{{ planning.job.id }}</p>
          <ol class="phases"
            ><li
              v-for="phase in planning.job.phases"
              :key="phase.name"
              :class="phase.state"
              >{{ phase.name }} ·
              {{
                phase.state === 'done' ? '完成' : phase.state === 'running' ? '进行中' : '等待'
              }}</li
            ></ol
          >
          <p v-if="planning.job.solutions && planning.job.outcome"
            >作业整体结论：{{ planning.job.outcome.message }} · {{ planning.job.outcome.code }}</p
          >
          <p v-if="planning.currentSolution">当前结果：{{ planning.currentSolution.label }}</p
          ><button
            v-if="compact && !planning.running"
            class="text-link"
            :disabled="planning.busy || !!planning.pending"
            @click="planning.refreshJob()"
            >刷新状态</button
          ></details
        >
        <p
          v-if="planning.currentExpired || planning.job.sourceChanged"
          class="notice warn"
          >{{ planning.currentExpired ? '未保存结果已过期。' : ''
          }}{{ planning.job.sourceChanged ? '来源已变化，结果仅供历史参考。' : '' }}</p
        ><p
          v-if="planning.job.error"
          class="notice warn"
          >{{ planning.job.error }}</p
        >
        <div
          v-if="planning.currentOutcome && (!compact || planning.currentOutcome.code !== 0)"
          class="notice"
          :class="{ warn: planning.currentOutcome.code !== 0 }"
          ><strong>{{ planning.currentOutcome.message }}</strong
          ><p
            v-for="(gap, i) in planning.currentOutcome.gap"
            :key="i"
            >{{ gap.objectId }} / {{ gap.field }}：{{ gap.message }}</p
          ><p
            v-for="s in planning.currentOutcome.suggestions"
            :key="s"
            >{{ s }}</p
          ></div
        >
        <div
          v-if="planning.running || planning.queryError || !compact"
          class="toolbar"
          ><button
            v-if="planning.running"
            class="btn"
            :disabled="!auth.can('planning.execute') || planning.busy || !!planning.pending"
            @click="planning.cancel"
            >取消规划</button
          ><button
            class="btn"
            :disabled="planning.busy || !!planning.pending"
            @click="planning.refreshJob()"
            >{{ planning.queryError ? '恢复查询' : '刷新状态' }}</button
          ></div
        ></template
      >
      <p v-else-if="showJob">请返回第一步保存任务并提交规划。</p>
      <!-- 查询失败与写入失败各自携带完整详情，保留原来的恢复及核对入口。 -->
      <PlanningApiFeedback :feedback="planning.queryFeedback" />
      <PlanningApiFeedback
        :feedback="planning.feedback"
        :pending="!!planning.pending"
        @reconcile="planning.reconcile"
      /> </div
  ></section>
</template>
<script setup lang="ts">
// 作业进度与业务建议直接展示服务端结果，不在页面推算。
import { usePlanningApiStore } from '../stores/planning-api';
import { useAuthStore } from '../stores/auth';
import PlanningApiFeedback from './PlanningApiFeedback.vue';
// 完成阶段可以收拢，当前业务警示和恢复操作始终留在折叠区外。
withDefaults(defineProps<{ compact?: boolean; showJob?: boolean }>(), {
  compact: false,
  showJob: true,
});
const planning = usePlanningApiStore(),
  auth = useAuthStore();
const labels = {
  PENDING: '等待开始',
  RUNNING: '规划进行中',
  SUCCESS: '执行完成',
  FAILED: '执行失败',
  CANCELLED: '已取消',
};
</script>
<style scoped>
.compact-progress .panel-head {
  padding: 8px 12px;
}
.compact-progress .panel-body {
  padding: 8px 12px;
  font-size: 12px;
}
.compact-progress details {
  margin-bottom: 8px;
}
.compact-progress summary {
  cursor: pointer;
  color: var(--muted);
}
.compact-progress .toolbar {
  margin-top: 8px;
}
progress {
  width: 100%;
  height: 8px;
  accent-color: #58b5df;
}
.phases {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.phases li {
  padding: 8px;
  border: 1px solid var(--line);
}
.done {
  color: #69cfb8;
}
.running {
  color: #7bc7f0;
}
.muted {
  font-size: 11px;
  overflow-wrap: anywhere;
}
.toolbar {
  display: flex;
  gap: 8px;
}
.notice {
  margin: 12px 0;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  max-height: 220px;
  overflow: auto;
}
</style>
