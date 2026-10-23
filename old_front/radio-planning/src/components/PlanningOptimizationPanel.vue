<template>
  <section class="optimization-panel"
    ><h3>优化权衡与关键链路</h3><p v-if="!value">此结果未提供优化明细。</p
    ><template v-else
      ><p>{{ value.sourceLabel }}</p
      ><h4>抗毁性与总功率权衡</h4><p v-if="value.tradeoff === null">服务未提供权衡曲线。</p
      ><p v-else-if="!value.tradeoff.length">本次未返回权衡点。</p
      ><template v-else
        ><ChartCanvas
          :key="owner"
          :option="optimizationChart(value)"
          label="服务返回的抗毁性与总功率权衡点"
        /><AppTable
          :rows="points"
          :columns="pointColumns"
          :page-size="5"
        /><p class="muted"
          >点位和满足约束的结论均读取服务结果。权衡点不代表可保存的完整网络。</p
        ></template
      >
      <h4>关键链路影响</h4><p v-if="value.criticalBridges === null">服务未提供关键链路分析。</p
      ><p v-else-if="!value.criticalBridges.length">服务未列出关键链路。</p
      ><AppTable
        v-else
        :rows="bridges"
        :columns="bridgeColumns"
        :page-size="5"
        ><template #actions="{ row }"
          ><button
            class="text-link"
            :disabled="disabled"
            v-on="{ click: locate.bind(null, row.linkId) }"
            >定位链路</button
          ></template
        ></AppTable
      >
    </template></section
  >
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { PlanningOptimization } from '../types/planning-result-details';
import { optimizationChart, optimizationConclusion } from '../services/planning-optimization';
import ChartCanvas from './ChartCanvas.vue';
import AppTable from './AppTable.vue';
const props = defineProps<{
  value?: PlanningOptimization | null;
  owner: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ link: [id: string] }>();
let alive = true;
const epoch = ref(0);
watch(
  () => [props.owner, props.disabled],
  () => epoch.value++,
  { flush: 'sync' },
);
onBeforeUnmount(() => {
  alive = false;
  epoch.value++;
});
// 只定位接口声明的关键链路；不从曲线点推断或创建新方案。
const locate = computed(() => {
  const owner = props.owner,
    token = epoch.value,
    disabled = props.disabled,
    ids = props.value?.criticalBridges?.map((row) => row.linkId) ?? [];
  return (id: string) => {
    if (
      alive &&
      !disabled &&
      !props.disabled &&
      owner === props.owner &&
      token === epoch.value &&
      ids.includes(id) &&
      props.value?.criticalBridges?.some((row) => row.linkId === id)
    )
      emit('link', id);
  };
});
const points = computed(
  () =>
    props.value?.tradeoff?.map((row) => ({
      ...row,
      conclusion: optimizationConclusion(row.meetsConstraints),
    })) ?? [],
);
const bridges = computed(
  () =>
    props.value?.criticalBridges?.map((row) => ({
      ...row,
      id: row.linkId,
      demands: row.affectedDemandIds.join(' / ') || '无',
    })) ?? [],
);
const pointColumns = [
  { field: 'id', header: '权衡点' },
  { field: 'survivabilityPercent', header: '抗毁性 / %' },
  { field: 'totalRadiatedPowerW', header: '总功率 / W' },
  { field: 'conclusion', header: '服务结论' },
  { field: 'description', header: '说明' },
];
const bridgeColumns = [
  { field: 'linkId', header: '关键链路' },
  { field: 'demands', header: '受影响需求' },
  { field: 'survivabilityAfterFailurePercent', header: '故障后抗毁性 / %' },
  { field: 'explanation', header: '依据' },
];
</script>
<style scoped>
.optimization-panel {
  padding: 16px;
  font-size: 12px;
  line-height: 1.8;
}
.optimization-panel h4 {
  margin-top: 18px;
}
</style>
