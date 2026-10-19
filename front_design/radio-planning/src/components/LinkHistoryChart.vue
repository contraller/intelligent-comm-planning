<template>
  <section
    class="link-history"
    aria-label="链路历史趋势"
  >
    <button
      class="btn small"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
      >{{ expanded ? '收起历史趋势' : '展开历史趋势' }}</button
    >
    <template v-if="expanded">
      <p class="history-note"
        >固定历史采样 · {{ samples.length }} 个时刻 · UTC+8<br />{{
          formatLinkTime(samples[0].timestamp)
        }}
        — {{ formatLinkTime(samples.at(-1)!.timestamp) }}</p
      >
      <div
        class="metric-tabs"
        role="group"
        aria-label="选择趋势指标"
      >
        <button
          v-for="item in LINK_METRICS"
          :key="item.key"
          class="btn small"
          :class="{ primary: metric === item.key }"
          :aria-pressed="metric === item.key"
          @click="metric = item.key"
          >{{ item.label }}</button
        >
      </div>
      <ChartCanvas
        :option="option"
        height="220px"
        :label="`${linkId} ${current.label}历史趋势，单位 ${current.unit}`"
      />
      <p class="history-note"
        >缺失采样不连线；点的颜色按预设状态显示：绿为正常、黄为预警越限、红为故障越限。</p
      >
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ChartCanvas from './ChartCanvas.vue';
import {
  formatLinkMetric,
  formatLinkTime,
  LINK_METRICS,
  LINK_METRIC_STYLES,
  linkMetricValue,
} from '../services/link-detail';
import type { LinkHistorySample, LinkMetricKey } from '../types/link-detail';

const props = defineProps<{ linkId: string; samples: LinkHistorySample[] }>();
const expanded = ref(false),
  metric = ref<LinkMetricKey>('snrDb');
const current = computed(() => LINK_METRICS.find((row) => row.key === metric.value)!);
// 换对象时不沿用上条链路的展开状态或指标选择。
watch(
  () => props.linkId,
  () => {
    expanded.value = false;
    metric.value = 'snrDb';
  },
);
function tooltip(params: unknown) {
  const point = Array.isArray(params) ? params[0] : params;
  if (
    !point ||
    typeof point !== 'object' ||
    !('dataIndex' in point) ||
    typeof point.dataIndex !== 'number'
  )
    return '';
  const sample = props.samples[point.dataIndex];
  if (!sample) return '';
  const value = sample.metrics[metric.value];
  return `${formatLinkTime(sample.timestamp)} (UTC+8)\n${current.value.label}：${formatLinkMetric(metric.value, value.value)}${value.value === null ? '' : ' ' + current.value.unit}\n${LINK_METRIC_STYLES[value.status].label}${value.reason ? ' · ' + value.reason : ''}`;
}
const option = computed(() => ({
  animation: false,
  tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, formatter: tooltip },
  grid: { left: 12, right: 14, top: 30, bottom: 10, containLabel: true },
  xAxis: {
    type: 'time',
    splitNumber: 2,
    axisLabel: {
      color: '#a9bdd3',
      fontSize: 10,
      formatter: (value: number) => formatLinkTime(value).split(' ').at(-1),
    },
  },
  yAxis: {
    type: 'value',
    name: current.value.unit,
    nameTextStyle: { color: '#a9bdd3' },
    axisLabel: { color: '#a9bdd3', fontSize: 10 },
    splitLine: { lineStyle: { color: '#223c55' } },
  },
  // 时间轴使用原始采样时刻；null 留空断线，绝不插值补零或推算状态。
  series: [
    {
      id: 'link-history',
      type: 'line',
      smooth: false,
      connectNulls: false,
      showSymbol: true,
      symbolSize: 7,
      lineStyle: { color: '#5aaedf' },
      data: props.samples.map((sample) => ({
        value: [
          Date.parse(sample.timestamp),
          linkMetricValue(metric.value, sample.metrics[metric.value].value),
        ],
        itemStyle: { color: LINK_METRIC_STYLES[sample.metrics[metric.value].status].color },
      })),
    },
  ],
}));
</script>

<style scoped>
.link-history {
  margin-top: 16px;
  min-width: 0;
}
.metric-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.history-note {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
</style>
