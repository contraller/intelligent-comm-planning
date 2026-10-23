<template>
  <section class="spectrum-monitor">
    <div class="toolbar"
      ><label
        >采集源
        <select
          :value="store.sourceId"
          :disabled="store.spectrumLoading"
          @change="store.selectSource(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-if="!store.spectrumContext?.sources.length"
            value=""
            >暂无采集源</option
          >
          <option
            v-for="source in store.spectrumContext?.sources"
            :key="source.id"
            :value="source.id"
            >{{ source.name }} · {{ source.id }}{{ source.eligible ? '' : '（未就绪）' }}</option
          >
        </select></label
      ><RouterLink
        class="text-link"
        to="/resources"
        >查看频谱接口配置</RouterLink
      ></div
    >
    <p
      v-if="store.source"
      class="muted"
      >配置版本 {{ store.source.revision }} · {{ store.source.protocol }} ·
      {{ store.source.intervalSeconds }} 秒 · {{ store.source.minKhz ?? '未填写' }}–{{
        store.source.maxKhz ?? '未填写'
      }}
      kHz</p
    >
    <p
      v-if="store.source && !store.source.eligible"
      class="notice"
      >{{ store.source.reason }}。支持频段：{{
        SPECTRUM_MONITORING_BANDS.map((row) => row.minKhz + '–' + row.maxKhz + ' kHz').join('、')
      }}。</p
    >
    <p
      v-if="store.spectrumStale"
      class="notice"
      role="status"
      >历史频谱快照 · 已停止刷新。下方数据仍属于配置版本
      {{ store.spectrumResult?.source.revision }}。</p
    >
    <template v-if="frame">
      <div class="spectrum-stats"
        ><span
          >频段占用率 <strong>{{ frame.occupancyPercent }}%</strong></span
        ><span
          >异常频段 <strong>{{ frame.abnormalBandCount }}</strong></span
        ><span>{{ frame.label }}</span></div
      >
      <ChartCanvas
        :option="option"
        height="220px"
        label="频谱占用率与接收功率，异常频段橙色高亮"
        smooth-update
      />
      <ul v-if="frame.abnormalBandCount"
        ><li
          v-for="bin in frame.bins.filter((row) => row.abnormal)"
          :key="bin.id"
          >{{ bin.minKhz }}–{{ bin.maxKhz }} kHz · {{ bin.occupancyPercent }}% ·
          {{ bin.reason }}</li
        ></ul
      >
      <p
        v-else
        class="muted"
        >该帧未标记异常频段。</p
      >
    </template>
    <p
      v-else
      class="muted"
      >{{
        store.spectrumLoading
          ? '读取采集源中…'
          : '暂无可展示的频谱观测。请补齐配置、执行当前版本接入检查并选择支持频段。'
      }}</p
    >
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import ChartCanvas from './ChartCanvas.vue';
import { useMonitoringStore } from '../stores/monitoring';
import { SPECTRUM_MONITORING_BANDS } from '../config/demo';
const store = useMonitoringStore();
const frame = computed(() => store.spectrumResult?.frame);
const labels = computed(() => frame.value?.bins.map((row) => row.minKhz + '–' + row.maxKhz) ?? []);
const option = computed(() => ({
  animationDurationUpdate: 350,
  tooltip: { trigger: 'axis' },
  legend: { data: ['占用率', '接收功率'], textStyle: { color: '#b7cde1' } },
  grid: { left: 55, right: 55, top: 40, bottom: 40 },
  xAxis: {
    type: 'category',
    data: labels.value,
    axisLabel: { color: '#aabfd5', fontSize: 10 },
    name: 'kHz',
  },
  yAxis: [
    {
      type: 'value',
      min: 0,
      max: 100,
      name: '占用率 / %',
      axisLabel: { color: '#aabfd5' },
      splitLine: { lineStyle: { color: '#233b52' } },
    },
    {
      type: 'value',
      name: '功率 / dBm',
      axisLabel: { color: '#aabfd5' },
      splitLine: { show: false },
    },
  ],
  series: [
    {
      id: 'occupancy',
      name: '占用率',
      type: 'bar',
      barMaxWidth: 70,
      data:
        frame.value?.bins.map((row) => ({
          id: row.id,
          value: row.occupancyPercent,
          itemStyle: { color: row.abnormal ? '#eb9b67' : '#4d9ed0' },
        })) ?? [],
      markArea: {
        silent: true,
        itemStyle: { color: '#db704d22' },
        data:
          frame.value?.bins.flatMap((row, i) =>
            row.abnormal ? [[{ xAxis: i - 0.5 }, { xAxis: i + 0.5 }]] : [],
          ) ?? [],
      },
    },
    {
      id: 'power',
      name: '接收功率',
      type: 'line',
      yAxisIndex: 1,
      data: frame.value?.bins.map((row) => row.powerDbm) ?? [],
      itemStyle: { color: '#65d1be' },
      smooth: false,
    },
  ],
}));
// 配置和观测的时间各自展示，读到旧帧时不能伪装成当前采样。
</script>
<style scoped>
.spectrum-monitor {
  display: grid;
  gap: 12px;
}
.toolbar {
  flex-wrap: wrap;
  font-size: 12px;
}
.toolbar select {
  max-width: 360px;
}
.muted {
  font-size: 11px;
  overflow-wrap: anywhere;
}
.notice {
  font-size: 12px;
  padding: 10px;
  line-height: 1.7;
}
.spectrum-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 22px;
  color: #abc4dc;
  font-size: 12px;
}
.spectrum-stats strong {
  font-size: 21px;
  color: #d3e7f6;
  margin-left: 8px;
}
ul {
  padding-left: 20px;
  color: #edb484;
  font-size: 12px;
  line-height: 1.8;
}
</style>
