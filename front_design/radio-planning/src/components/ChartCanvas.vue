<template>
  <div
    ref="host"
    :style="{ height }"
    role="img"
    :aria-label="label"
    class="chart-canvas"
  />
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { use, init, type ECharts, type EChartsCoreOption } from 'echarts/core';
import { GraphChart, BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  TooltipComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
use([
  GraphChart,
  BarChart,
  LineChart,
  PieChart,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  CanvasRenderer,
]);
const props = withDefaults(
  defineProps<{
    option: EChartsCoreOption;
    height?: string;
    label?: string;
    smoothUpdate?: boolean;
  }>(),
  { height: '280px', label: '数据图表', smoothUpdate: false },
);
const emit = defineEmits<{ select: [id: string] }>();
const host = ref<HTMLDivElement>();
let chart: ECharts | undefined;
let observer: ResizeObserver | undefined;
function update() {
  chart?.setOption(
    {
      backgroundColor: 'transparent',
      textStyle: { color: '#9aafc9', fontFamily: 'Microsoft YaHei' },
      ...props.option,
    },
    // 监控图表按稳定系列更新，既有图表仍使用原完整替换行为。
    props.smoothUpdate
      ? { notMerge: false, replaceMerge: ['series'], lazyUpdate: true }
      : { notMerge: true },
  );
}
onMounted(() => {
  chart = init(host.value!);
  update();
  chart.on('click', (event) => {
    const item = event.data as { id?: string };
    if (item?.id) emit('select', item.id);
  });
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(host.value!);
});
watch(() => props.option, update, { deep: true });
// 切换页面时释放画布及观察器，避免持续占用渲染资源。
onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.dispose();
});
</script>
<style scoped>
.chart-canvas {
  width: 100%;
  min-width: 0;
}
</style>
