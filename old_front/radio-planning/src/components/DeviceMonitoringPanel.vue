<template>
  <section class="device-monitor">
    <div class="monitor-stats">
      <span
        >监控设备 <strong>{{ frame.statistics.devices.total }}</strong></span
      >
      <span
        >在线 <strong>{{ frame.statistics.devices.online }}</strong></span
      >
      <span
        >离线 <strong>{{ frame.statistics.devices.offline }}</strong></span
      >
      <span
        >故障 <strong>{{ frame.statistics.devices.fault }}</strong></span
      >
      <span
        >告警 <strong>{{ frame.statistics.devices.alarms }}</strong></span
      >
    </div>
    <p class="muted">范围：本网络设备；告警独立统计，可与运行状态重叠。在线数读取观测结果。</p>
    <div class="monitor-charts">
      <div
        ><h4>运行状态占比</h4
        ><ChartCanvas
          :option="statusOption"
          height="150px"
          label="设备运行状态占比，告警不参与互斥分组"
          smooth-update
      /></div>
      <div
        ><h4>发射功率分布</h4
        ><ChartCanvas
          :option="distribution('power')"
          height="150px"
          label="设备观测功率分布"
          smooth-update
      /></div>
      <div
        ><h4>工作频率分布</h4
        ><ChartCanvas
          :option="distribution('frequency')"
          height="150px"
          label="设备观测频率分布"
          smooth-update
      /></div>
    </div>
    <div class="toolbar">
      <input
        v-model="query"
        aria-label="筛选监控设备"
        placeholder="设备 / 节点 ID"
      />
      <select
        v-model="status"
        aria-label="筛选设备观测状态"
        ><option value="all">全部状态</option
        ><option value="NORMAL">正常</option
        ><option value="FAULT">故障</option
        ><option value="OFFLINE">离线</option
        ><option value="alarm">有告警</option></select
      >
      <span class="muted">{{ rows.length }} 条；点击设备定位冻结网络</span>
    </div>
    <div class="monitor-table"
      ><table
        ><thead
          ><tr
            ><th>设备 / 节点</th><th>运行状态</th><th>功率 / dBm</th><th>频率 / kHz</th
            ><th>告警与越限</th></tr
          ></thead
        ><tbody>
          <tr
            v-for="row in rows"
            :key="row.deviceId"
            :class="{ selected: selectedId === row.deviceId }"
          >
            <td
              ><button
                class="text-link"
                @click="emit('select', row.deviceId)"
                >{{ row.deviceId }}</button
              ><small>{{ row.stationId }}</small></td
            >
            <!-- 运行状态和附加告警分别呈现，不由告警改写状态色。 -->
            <td><StatusBadge :status="row.status" /></td><td>{{ row.txPowerDbm ?? '未采集' }}</td
            ><td>{{ row.frequencyKhz ?? '未采集' }}</td>
            <td :class="{ warning: row.alarm }">{{
              row.violations.map((item) => item.message).join('；') ||
              (row.alarm ? '离线告警' : '无')
            }}</td> </tr
          ><tr v-if="!rows.length"><td colspan="5">没有匹配的设备</td></tr>
        </tbody></table
      ></div
    >
    <div
      v-if="frame.alerts.length"
      class="monitor-alerts"
    >
      <!-- 消息等级直接读取观测结果，故障红、预警黄。 -->
      <button
        v-for="alert in frame.alerts"
        :key="alert.id"
        @click="alert.deviceId && emit('select', alert.deviceId)"
        ><span :class="{ fault: alert.level === 'FAULT' }">{{
          alert.level === 'FAULT' ? '故障' : '预警'
        }}</span
        >{{ alert.message }}</button
      >
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import ChartCanvas from './ChartCanvas.vue';
import StatusBadge from './StatusBadge.vue';
import type { MonitoringNetwork, NetworkObservationFrame } from '../types/monitoring';
const props = defineProps<{
  network: MonitoringNetwork;
  frame: NetworkObservationFrame;
  selectedId: string;
}>();
const emit = defineEmits<{ select: [id: string] }>();
const query = ref(''),
  status = ref('all');
const rows = computed(() =>
  props.frame.devices.filter(
    (row) =>
      (status.value === 'all' ||
        (status.value === 'alarm' ? row.alarm : row.status === status.value)) &&
      (row.deviceId + ' ' + row.stationId).toLowerCase().includes(query.value.toLowerCase()),
  ),
);
const statusOption = computed(() => ({
  tooltip: { trigger: 'item' },
  series: [
    {
      id: 'device-status',
      type: 'pie',
      radius: ['40%', '70%'],
      label: { color: '#adc5dd', formatter: '{b} {c}' },
      data: [
        {
          name: '正常',
          value: props.frame.statistics.devices.normal,
          itemStyle: { color: '#45c9af' },
        },
        {
          name: '故障',
          value: props.frame.statistics.devices.fault,
          itemStyle: { color: '#ef7988' },
        },
        {
          name: '离线',
          value: props.frame.statistics.devices.offline,
          itemStyle: { color: '#8494ae' },
        },
      ],
    },
  ],
}));
// 分布直接读取观测帧，空采样不会补成零功率或零频率。
const distribution = (kind: 'power' | 'frequency') => ({
  tooltip: { trigger: 'axis' },
  grid: { left: 42, right: 10, top: 20, bottom: 38 },
  xAxis: {
    type: 'category',
    data: props.frame.statistics[kind].map((row) => row.label),
    axisLabel: { color: '#a9bdd3', fontSize: 10 },
  },
  yAxis: {
    type: 'value',
    minInterval: 1,
    axisLabel: { color: '#a9bdd3' },
    splitLine: { lineStyle: { color: '#223c55' } },
  },
  series: [
    {
      id: kind,
      type: 'bar',
      data: props.frame.statistics[kind].map((row) => row.count),
      barMaxWidth: 30,
      itemStyle: { color: '#5aaedf' },
    },
  ],
});
</script>
<style scoped>
.monitor-alerts span.fault {
  color: #f17d8b;
}
.device-monitor {
  display: grid;
  gap: 12px;
}
.monitor-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
}
.monitor-stats span {
  color: #9bb4ce;
  font-size: 12px;
}
.monitor-stats strong {
  color: #dfebf8;
  font-size: 22px;
  margin-left: 8px;
}
.muted {
  font-size: 11px;
}
.monitor-charts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.monitor-charts h4 {
  font-size: 12px;
  margin: 0;
  color: #bad0e6;
}
.monitor-table {
  overflow: auto;
}
.monitor-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.monitor-table th,
.monitor-table td {
  text-align: left;
  padding: 9px;
  border-bottom: 1px solid var(--line);
}
.monitor-table small {
  display: block;
  color: #88a2bd;
}
.selected {
  background: #193950;
}
.warning {
  color: #f0bd67;
}
.monitor-alerts {
  display: grid;
  gap: 6px;
}
.monitor-alerts button {
  text-align: left;
  border: 1px solid var(--line);
  background: #172a40;
  padding: 9px;
  color: #c6d9eb;
  font-size: 12px;
}
.monitor-alerts span {
  color: #f0bd67;
  margin-right: 10px;
}
@media (max-width: 1200px) {
  .monitor-charts {
    grid-template-columns: 1fr;
  }
  .toolbar {
    flex-wrap: wrap;
  }
}
</style>
