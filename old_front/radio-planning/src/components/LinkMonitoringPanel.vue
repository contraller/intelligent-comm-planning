<template>
  <section class="link-monitor">
    <div class="quality-stats"
      ><span
        v-for="(status, key) in LINK_STATUS_STYLES"
        :key="key"
        :style="{ borderColor: status.color }"
        >{{ status.label }} <strong>{{ frame.statistics.links[key] }}</strong></span
      ></div
    >
    <ChartCanvas
      :option="option"
      height="170px"
      label="当前监控网络拓扑，可选择节点或链路"
      smooth-update
      @select="select"
    />
    <div class="toolbar"
      ><input
        v-model="query"
        aria-label="筛选监控链路"
        placeholder="链路 ID"
      /><label
        ><input
          v-model="abnormalOnly"
          type="checkbox"
        />仅异常链路</label
      ><span class="muted">规划后链路 {{ frame.links.length }} 条；候选链路不参与统计</span></div
    >
    <div class="monitor-table"
      ><table
        ><thead
          ><tr
            ><th>链路</th><th>质量</th><th>SNR / dB</th><th>误码率</th><th>丢包率</th
            ><th>时延 / ms</th><th>吞吐率 / kbps</th></tr
          ></thead
        ><tbody>
          <tr
            v-for="row in rows"
            :key="row.linkId"
            :class="{ selected: selectedId === row.linkId }"
          >
            <td
              ><button
                class="text-link"
                @click="emit('select', row.linkId)"
                >{{ row.linkId }}</button
              ></td
            ><td :style="{ color: LINK_STATUS_STYLES[row.state].color }">{{
              LINK_STATUS_STYLES[row.state].label
            }}</td>
            <td>{{ row.snrDb ?? '未采集' }}</td
            ><td>{{ row.ber === null ? '未采集' : row.ber.toExponential(2) }}</td
            ><td>{{
              row.packetLossRate === null ? '未采集' : (row.packetLossRate * 100).toFixed(1) + '%'
            }}</td>
            <td>{{ row.delayMs ?? '未采集' }}</td
            ><td>{{ row.throughputKbps ?? '未采集' }}</td> </tr
          ><tr v-if="!rows.length"><td colspan="7">没有匹配的链路</td></tr>
        </tbody></table
      ></div
    >
    <LinkAssessmentPanel
      v-if="selected"
      :display="assessment.display"
      :owner="assessment.owner"
      :observed-state="selected.state"
      monitoring
    />
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import ChartCanvas from './ChartCanvas.vue';
import { LINK_STATUS_STYLES } from '../config/link-status';
import type { MonitoringNetwork, NetworkObservationFrame } from '../types/monitoring';
import { selectMonitoringAssessment } from '../services/monitoring-validation';
import LinkAssessmentPanel from './LinkAssessmentPanel.vue';
const props = defineProps<{
  network: MonitoringNetwork;
  frame: NetworkObservationFrame;
  selectedId: string;
}>();
const emit = defineEmits<{ select: [id: string]; selectStation: [id: string] }>();
const abnormalOnly = ref(false),
  query = ref('');
// 选择和刷新只读取当前帧的解释，不提交评估请求。
const assessment = computed(() =>
  selectMonitoringAssessment(props.network, props.frame, props.selectedId),
);
const selected = computed(() => props.frame.links.find((row) => row.linkId === props.selectedId));
const rows = computed(() =>
  props.frame.links.filter(
    (row) =>
      (!abnormalOnly.value || ['WARNING', 'FAULT'].includes(row.state)) &&
      row.linkId.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
const option = computed(() => ({
  tooltip: {},
  series: [
    {
      id: 'monitor-topology',
      type: 'graph',
      layout: 'circular',
      roam: true,
      symbolSize: 24,
      label: { show: true, color: '#cee0f0', position: 'right' },
      edgeLabel: { show: true, color: '#a8bdd3', formatter: '{c}' },
      data: props.network.stations.map((row) => ({
        id: row.id,
        name: row.id,
        itemStyle: { color: '#58abdc' },
      })),
      links: props.network.links.map((link) => {
        const state = props.frame.links.find((row) => row.linkId === link.id)!.state;
        const status = LINK_STATUS_STYLES[state];
        // 选中只增加外部光晕，状态颜色和等级线宽与地图、图例保持一致。
        return {
          id: link.id,
          source: link.a,
          target: link.b,
          value: link.id,
          lineStyle: {
            color: status.color,
            width: status.width,
            type: link.backup ? 'dashed' : 'solid',
            shadowColor: '#c2edff',
            shadowBlur: props.selectedId === link.id ? 8 : 0,
          },
        };
      }),
    },
  ],
}));
// 拓扑事件只按确切的稳定 ID 分派，不把节点 ID 当成链路 ID。
function select(id: string) {
  if (props.network.links.some((row) => row.id === id)) emit('select', id);
  else emit('selectStation', id);
}
</script>
<style scoped>
.link-monitor {
  display: grid;
  gap: 12px;
}
.quality-stats {
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
}
.quality-stats span {
  border-left: 3px solid;
  padding: 4px 12px;
  color: #adc6df;
  font-size: 12px;
}
.quality-stats strong {
  font-size: 22px;
  color: #d9e8f7;
  margin-left: 8px;
}
.toolbar {
  flex-wrap: wrap;
  font-size: 12px;
}
.muted {
  font-size: 11px;
}
.monitor-table {
  overflow: auto;
}
.monitor-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  white-space: nowrap;
}
.monitor-table th,
.monitor-table td {
  text-align: left;
  padding: 10px;
  border-bottom: 1px solid var(--line);
}
.selected {
  background: #193950;
}
</style>
