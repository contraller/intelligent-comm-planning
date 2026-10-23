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
let resizeFrame: number | undefined;
let lastWidth = 0, lastHeight = 0;
let pending = true,
  disposed = false;
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
// 隐藏页签保留实例和最新选项，容器有尺寸后才绘制，避免零尺寸初始化。
function draw(resize = false) {
  const element = host.value;
  if (disposed || !element || element.clientWidth <= 0 || element.clientHeight <= 0) return;
  const changed = lastWidth !== element.clientWidth || lastHeight !== element.clientHeight;
  if (!chart) {
    chart = init(element);
    lastWidth = element.clientWidth; lastHeight = element.clientHeight;
    chart.on('click', (event) => {
      const item = event.data as { id?: string };
      if (item?.id) emit('select', item.id);
    });
  } else if (resize && changed) {
    chart.resize();
    lastWidth = element.clientWidth; lastHeight = element.clientHeight;
  }
  if (pending) {
    update();
    pending = false;
  }
}
onMounted(() => {
  draw();
  // 延后尺寸写入，避免图表在 ResizeObserver 中反复触发布局。
  observer = new ResizeObserver(() => {
    if (disposed || resizeFrame !== undefined) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; draw(true); });
  });
  observer.observe(host.value!);
});
watch(
  () => props.option,
  () => {
    pending = true;
    draw();
  },
  { deep: true },
);
// 切换页面时释放画布及观察器，避免持续占用渲染资源。
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
  chart?.dispose();
});
</script>
<style scoped>
.chart-canvas {
  width: 100%;
  min-width: 0;
  overflow: hidden;
}
</style>
