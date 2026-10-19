<template>
  <section
    class="panel progress-panel"
    aria-live="polite"
  >
    <div class="panel-head">
      <h3>{{ view ? labels[view.state] : '尚未提交任务' }}</h3>
      <span class="chip cyan">Mock 时间轴</span>
    </div>
    <div class="panel-body">
      <template v-if="view">
        <div class="progress-summary">
          <span>{{ view.job.input.name }}</span
          ><strong>{{ view.progress }}%</strong>
        </div>
        <progress
          :value="view.progress"
          max="100"
          aria-label="演示任务进度"
        />
        <ol class="phases">
          <li
            v-for="phase in view.phases"
            :key="phase.name"
            :class="phase.state"
          >
            <i :class="['pi', phase.state === 'done' ? 'pi-check-circle' : 'pi-circle']" />{{
              phase.name
            }}<small>{{
              phase.state === 'done' ? '完成' : phase.state === 'running' ? '进行中' : '等待'
            }}</small>
          </li>
        </ol>
        <p class="muted">此进度来自预设时间轴，不执行真实算法。任务 ID：{{ view.job.id }}</p>
        <!-- 进度属于整次作业，业务结论属于当前选中的完整结果。 -->
        <p v-if="view.solutions && view.outcome"
          >作业整体结论：{{ view.outcome.message }} · {{ view.outcome.code }}</p
        >
        <p v-if="solutionLabel"
          >当前结果：{{ solutionLabel }}{{ selectedExpired ? ' · 未保存结果已过期' : '' }}</p
        >
        <div
          v-if="selectedOutcome ?? view.outcome"
          class="notice"
          :class="{ warn: (selectedOutcome ?? view.outcome)!.code !== 0 }"
        >
          <strong
            >{{ (selectedOutcome ?? view.outcome)!.message }} ·
            {{ (selectedOutcome ?? view.outcome)!.code }}</strong
          >
          <p
            v-for="item in (selectedOutcome ?? view.outcome)!.gap"
            :key="item.objectId + item.field"
          >
            {{ item.objectId }} / {{ item.field }}：{{ item.message }}
          </p>
          <p
            v-for="suggestion in (selectedOutcome ?? view.outcome)!.suggestions"
            :key="suggestion"
            >{{ suggestion }}</p
          >
        </div>
        <p
          v-if="view.error"
          class="notice warn"
          role="alert"
          >{{ view.error }}</p
        >
        <div class="toolbar section-gap">
          <button
            v-if="['PENDING', 'RUNNING'].includes(view.state)"
            class="btn"
            :disabled="!auth.can('planning.execute') || busy"
            @click="$emit('cancel')"
          >
            取消任务</button
          ><button
            v-else
            class="btn"
            :disabled="!auth.can('planning.execute') || busy"
            @click="$emit('resubmit')"
          >
            使用输入重新提交
          </button>
        </div>
      </template>
      <p
        v-else
        class="muted"
        >填写任务后开始规划，或从保存记录中选择已提交任务。</p
      >
      <div
        v-if="queryError"
        class="notice warn section-gap"
        role="alert"
      >
        {{ queryError
        }}<button
          class="btn small"
          :disabled="busy"
          @click="$emit('retry')"
          >重试查询</button
        >
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import type { PlanningJobView } from '../types/planning';
defineProps<{
  view: PlanningJobView | null;
  queryError: string;
  busy: boolean;
  selectedOutcome?: PlanningJobView['outcome'];
  solutionLabel?: string;
  selectedExpired?: boolean;
}>();
defineEmits<{ cancel: []; retry: []; resubmit: [] }>();
const labels = {
  PENDING: '等待开始',
  RUNNING: '规划进行中',
  SUCCESS: '执行完成',
  FAILED: '执行失败',
  CANCELLED: '已取消',
};
</script>
<style scoped>
.progress-summary {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 13px;
}
progress {
  width: 100%;
  height: 6px;
  accent-color: #4caee6;
  margin: 14px 0;
}
.phases {
  padding: 0;
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
  list-style: none;
}
.phases li {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 6px;
  padding: 10px;
  color: #6f89a6;
  border: 1px solid #25384f;
  font-size: 12px;
}
.phases small {
  grid-column: 2;
}
.phases .running {
  color: #82c3ff;
  border-color: #3b83b5;
}
.phases .done {
  color: #64cdb4;
}
.muted {
  font-size: 11px;
  overflow-wrap: anywhere;
  margin: 12px 0;
}
.notice p {
  margin-top: 8px;
}
@media (max-width: 1300px) {
  .phases {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
