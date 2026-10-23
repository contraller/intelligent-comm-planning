<template>
  <AppDrawer
    :visible="store.measureOpen"
    title="抗干扰措施与预评估"
    :subtitle="store.measure?.title"
    @update:visible="!store.busy && (store.measureOpen = $event)"
  >
    <template v-if="store.measure">
      <p>{{ store.measure.detail }}</p
      ><p class="notice">风险与条件：{{ store.measure.risk }}</p>
      <!-- 抽屉定位随实际前后态，入口能力由 GIS 冻结上下文提供。 -->
      <section
        v-if="targetEntry"
        aria-label="措施定位对象"
      >
        <p>关联对象 · {{ targetEntry.stateLabel }}</p>
        <div
          v-for="target in targetEntry.targets"
          :key="target.kind"
          ><p>{{ target.kind === 'node' ? '节点' : '链路' }} {{ target.id }}</p>
          <button
            class="btn small"
            :disabled="!!target.reason"
            :onClick="target.locate"
            >{{ target.label }}</button
          ><p
            v-if="target.reason"
            class="muted"
            >{{ target.reason }}</p
          > </div
        ><p
          v-if="!targetEntry.targets.length"
          class="muted"
          >未提供定位对象</p
        >
      </section>
      <p
        v-if="store.previewUnavailableReason"
        role="alert"
        >{{ store.previewUnavailableReason }}</p
      >
      <div class="toolbar"
        ><button
          class="btn small"
          :class="{ primary: !store.effectiveAfter }"
          @click="
            gis.mapMode = 'analysis';
            store.after = false;
          "
          >地图查看措施前</button
        ><button
          class="btn small"
          :class="{ primary: store.effectiveAfter }"
          :disabled="!store.canPreviewAfter"
          @click="
            gis.mapMode = 'analysis';
            store.after = true;
          "
          >地图查看措施后</button
        ></div
      >
      <template v-if="result">
        <p
          >预评估信噪比：{{ store.measure.snrAfterDb }} dB；连通率
          {{ result.metrics.connectivityPercent }}%；覆盖 {{ result.metrics.coveragePercent }}%。</p
        >
        <p>采纳生成同任务待确认版本。确认后切换当前网络；原资源与输入快照保留。</p>
        <section
          v-for="change in changes"
          :key="change.label"
          class="change"
        >
          <h4>{{ change.label }}</h4
          ><details
            ><summary>原配置</summary><pre>{{ JSON.stringify(change.before, null, 2) }}</pre>
          </details>
          <details open
            ><summary>措施后配置</summary><pre>{{ JSON.stringify(change.after, null, 2) }}</pre>
          </details>
        </section>
        <h4>预生成校验</h4
        ><p
          v-for="check in result.checks"
          :key="check.id"
          >{{ check.passed ? '通过' : '未通过' }} · {{ check.label }} · {{ check.detail }}</p
        >
      </template>
      <p
        v-if="store.error"
        role="alert"
        >{{ store.error }}</p
      ><p
        v-if="store.notice"
        role="status"
        >{{ store.notice }}</p
      >
    </template>
    <template #footer>
      <button
        v-if="adopted"
        class="btn primary"
        :disabled="store.busy"
        @click="emit('openPlan', adopted.planId)"
        >查看已生成方案</button
      >
      <button
        v-else
        class="btn primary"
        :disabled="
          !store.adoptable ||
          store.locked ||
          !result ||
          store.selected?.source.state !== 'CURRENT' ||
          !!store.queryError
        "
        @click="adopt"
        >采纳此项并生成待确认方案</button
      >
    </template>
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { useInterferenceStore } from '../stores/interference';
import { sameValue } from '../services/planning-validation';
import type { PlanningConfiguration } from '../types/planning';
import type { InterferenceTargetEntry } from '../composables/useInterferenceTargetNavigation';
import AppDrawer from './AppDrawer.vue';
defineProps<{ targetEntry?: InterferenceTargetEntry | null }>();
const emit = defineEmits<{ openPlan: [id: string] }>();
// 地图上下文由 GIS 统一管理，分析仅请求切换。
const store = useInterferenceStore(),
  gis = useGisWorkspaceStore();
const adopted = computed(() =>
  store.selected?.adoptions.find((row) => row.measureId === store.measureId),
);
// 配置、指标与地图共用服务提供的完整措施快照。
const result = computed(() =>
  store.canPreviewAfter ? store.selectedMeasurePreview?.result : null,
);
// 仅展示完整配置中的差异项，不把预评估值重新计算为业务指标。
const changes = computed(() => {
  const before = store.selected?.run.network.workflow?.configuration,
    after = result.value?.configuration;
  if (!before || !after) return [];
  const names: Record<keyof PlanningConfiguration, string> = {
    deployment: '部署',
    devices: '设备参数',
    routes: '路由',
    frequencies: '频率资源',
  };
  return (Object.keys(names) as (keyof PlanningConfiguration)[])
    .filter((key) => !sameValue(before[key], after[key]))
    .map((key) => ({ label: names[key], before: before[key], after: after[key] }));
});
async function adopt() {
  const id = await store.adopt();
  if (id) store.measureOpen = true;
}
</script>
<style scoped>
.change {
  margin: 18px 0;
  border-top: 1px solid #314965;
}
.change pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
  color: #abc2db;
}
p {
  line-height: 1.8;
}
</style>
