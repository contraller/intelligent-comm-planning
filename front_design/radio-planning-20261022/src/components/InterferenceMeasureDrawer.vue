<template>
  <AppDrawer :visible="store.measureOpen" title="抗干扰措施与预评估" :subtitle="store.measure?.title" @update:visible="store.measureOpen = $event">
    <template v-if="store.measure">
      <p>{{ store.measure.detail }}</p><p>风险与条件：{{ store.measure.risk }}</p>
      <p v-if="store.previewUnavailableReason" role="status">{{ store.previewUnavailableReason }}</p>
      <button v-if="!store.preview && !store.previewLoading" class="btn" @click="store.loadMeasurePreview(store.measure.measure_id)">重试预览</button>
      <div class="toolbar" role="group" aria-label="措施影响状态"><button class="btn" :aria-pressed="!store.effectiveAfter" @click="store.after = false">措施前</button><button class="btn" :aria-pressed="store.effectiveAfter" :disabled="!store.canPreviewAfter" @click="store.after = true">措施后预测</button></div>
      <section v-if="targetEntry" aria-label="措施定位对象"><p>{{ targetEntry.stateLabel }}</p><div v-for="target in targetEntry.targets" :key="target.kind"><button class="text-link" :disabled="!!target.reason" @click="target.locate()">{{ target.label }} · {{ target.id }}</button><p v-if="target.reason">{{ target.reason }}</p></div></section>
      <template v-if="store.preview">
        <h4>拟应用变更</h4><pre>{{ JSON.stringify(store.preview.proposed_changes, null, 2) }}</pre>
        <details><summary>冻结的变更前配置</summary><pre>{{ JSON.stringify(store.preview.before_configuration, null, 2) }}</pre></details>
        <p v-if="store.preview.impact_after">措施后预测受扰节点 {{ store.preview.impact_after.summary.affected_nodes }} · 链路 {{ store.preview.impact_after.summary.affected_links }}</p>
        <p v-if="store.preview.metrics === null">全网覆盖、连通与时延指标尚未重算。</p>
        <pre v-else>{{ JSON.stringify(store.preview.metrics, null, 2) }}</pre>
      </template>
      <ul v-if="capability && !capability.enabled"><li v-for="reason in capability.reasons" :key="reason">{{ reason }}</li></ul>
      <button class="btn primary" :disabled="!store.adoptable || !store.measure.available || !capability?.enabled || store.locked || !!store.pendingWrites.length || !!adopted" @click="store.adoptMeasure(store.measure.measure_id)">采纳措施并提交规划重算</button>
      <section v-if="adopted" aria-label="措施重算状态">
        <h4>{{ labels[adopted.state] }}</h4><p>{{ adopted.adoption_id }}</p>
        <p v-if="adopted.planning_state">{{ adopted.planning_state }} · {{ adopted.planning_progress }}%</p>
        <p v-if="adopted.state === 'CANCEL_REQUESTED'">取消已请求，尚未确认停止。</p>
        <p v-if="adopted.error" role="alert">{{ adopted.error }}</p>
        <button v-if="adopted.planning_job_id" class="btn" @click="emit('openPlanningJob', { taskId: adopted.task_id, jobId: adopted.planning_job_id! })">查看规划作业</button>
        <button class="text-link" @click="emit('openAdoption', { adoptionId: adopted.adoption_id })">采纳详情</button>
        <button v-if="['PENDING', 'RUNNING'].includes(adopted.state)" class="btn" :disabled="store.locked || !store.adoptable" @click="store.cancelAdoption(adopted.adoption_id)">请求取消重算</button>
        <template v-if="adopted.state === 'SUCCESS' && adopted.result_plan_id">
          <p>{{ adopted.result_plan_state === 'CONFIRMED' ? '重算方案此后已被显式确认' : adopted.result_plan_state === 'REFERENCE' ? '已保存未达标参考方案；采纳未改变原确认方案' : '已保存重算方案；采纳未改变原确认方案' }}。</p>
          <button class="btn primary" @click="emit('openPlan', adopted.result_plan_id!)">打开重算方案</button>
        </template>
        <button v-if="['PENDING', 'RUNNING', 'CANCEL_REQUESTED'].includes(adopted.state)" class="text-link" @click="store.query()">刷新状态</button>
      </section>
    </template>
    <p v-if="store.error || store.queryError" role="alert">{{ store.error || store.queryError }}</p>
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { useInterferenceStore } from '../stores/interference';
import type { InterferenceTargetEntry } from '../composables/useInterferenceTargetNavigation';
defineProps<{ targetEntry?: InterferenceTargetEntry | null }>();
const emit = defineEmits<{ openPlan: [id: string]; openPlanningJob: [value: { taskId: string; jobId: string }]; openAdoption: [value: { adoptionId: string }] }>();
const store = useInterferenceStore();
const adopted = computed(() => store.adoptions.find(row => row.measure_id === store.measureId && row.run_id === store.selected?.run_id));
const capability = computed(() => store.measure ? store.selected?.adoption_capabilities[store.measure.type] : null);
const labels = { PENDING: '等待重算', RUNNING: '规划重算中', CANCEL_REQUESTED: '取消请求中', SUCCESS: '重算结果已保存', FAILED: '重算失败', CANCELLED: '重算已取消' };
</script>
<style scoped>
p{line-height:1.7;overflow-wrap:anywhere}pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto}.toolbar{display:flex;flex-wrap:wrap;gap:8px}section{padding:14px 0;border-top:1px solid var(--line)}button{max-width:100%;white-space:normal;margin:4px 4px 4px 0}
</style>
