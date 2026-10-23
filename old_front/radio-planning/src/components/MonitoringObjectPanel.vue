<template>
  <section class="monitor-detail"
    ><p class="notice">Mock 观测 · {{ store.network?.name }} · {{ store.network?.version }}</p
    ><p
      v-if="store.context?.source.state !== 'CURRENT'"
      class="notice"
      >历史 / 待核实快照，停止刷新。</p
    ><p class="muted">预设采集时间：{{ frame?.observedAt ?? '暂无观测' }}</p
    ><template v-if="device"
      ><h4>{{ device.deviceId }}</h4
      ><!-- 复用状态色，但告警仍是独立信息，不覆盖设备的运行状态。 --><dl class="kv"
        ><dt>所属节点</dt><dd>{{ device.stationId }}</dd
        ><dt>观测状态</dt
        ><dd
          ><StatusBadge :status="device.status" /> ·
          <span :class="{ 'alarm-mark': device.alarm }">{{
            device.alarm ? '有告警' : '无告警'
          }}</span></dd
        ><dt>观测功率</dt><dd>{{ device.txPowerDbm ?? '未采集' }} dBm</dd><dt>方案配置功率</dt
        ><dd>{{ configured?.txPowerDbm ?? '未提供' }} dBm</dd><dt>观测频率</dt
        ><dd>{{ device.frequencyKhz ?? '未采集' }} kHz</dd><dt>方案配置频率</dt
        ><dd>{{ configured?.frequencyKhz ?? '未提供' }} kHz</dd></dl
      ><p
        v-for="item in device.violations"
        :key="item.field"
        class="warning"
        >{{ item.message }}</p
      ></template
    ><template v-else-if="link"
      ><h4>{{ link.id }}</h4
      ><dl class="kv"
        ><dt>节点</dt><dd>{{ link.a }} → {{ link.b }}</dd
        ><dt>设备</dt><dd>{{ link.deviceA }} → {{ link.deviceB }}</dd
        ><!-- 与底部链路监控共用色表；缺观测保持中性。 --><dt>规划频率</dt
        ><dd>{{ link.frequencyKhz }} kHz</dd><dt>观测质量</dt
        ><dd
          :style="{
            color: observedLink ? LINK_STATUS_STYLES[observedLink.state].color : undefined,
          }"
          >{{ observedLink ? LINK_STATUS_STYLES[observedLink.state].label : '未采集' }}</dd
        ><dt>SNR</dt><dd>{{ observedLink?.snrDb ?? '未采集' }} dB</dd><dt>误码率</dt
        ><dd>{{ observedLink?.ber ?? '未采集' }}</dd
        ><dt>丢包率</dt
        ><dd>{{
          observedLink?.packetLossRate === null || observedLink?.packetLossRate === undefined
            ? '未采集'
            : (observedLink.packetLossRate * 100).toFixed(1) + '%'
        }}</dd
        ><dt>时延</dt><dd>{{ observedLink?.delayMs ?? '未采集' }} ms</dd><dt>吞吐率</dt
        ><dd>{{ observedLink?.throughputKbps ?? '未采集' }} kbps</dd></dl
      ><LinkAssessmentPanel
        :display="assessment.display"
        :owner="assessment.owner"
        :observed-state="observedLink?.state"
        monitoring /></template
    ><template v-if="station"
      ><h4>{{ station.name }} · {{ station.id }}</h4
      ><p class="muted">方案展示坐标：{{ station.coordinate.join(', ') }} · WGS84</p
      ><p class="muted">节点底图色标来自冻结站点信息，设备状态单独展示。</p
      ><button
        v-for="row in store.network?.devices.filter((item) => item.stationId === station!.id)"
        :key="row.id"
        class="device-choice"
        @click="store.selectDevice(row.id)"
        >{{ row.id }} · 查看观测</button
      ></template
    ><p
      v-if="!device && !link && !station"
      class="muted"
      >点击地图节点、链路或底部设备清单查看监控详情。</p
    ></section
  >
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useMonitoringStore } from '../stores/monitoring';
import { configuredStations } from '../services/planning-snapshot';
import { selectMonitoringAssessment } from '../services/monitoring-validation';
import LinkAssessmentPanel from './LinkAssessmentPanel.vue';
import StatusBadge from './StatusBadge.vue';
import { LINK_STATUS_STYLES } from '../config/link-status';
const store = useMonitoringStore();
const frame = computed(() => store.networkResult?.frame);
const device = computed(() =>
  frame.value?.devices.find((row) => row.deviceId === store.selectedDeviceId),
);
const configured = computed(() =>
  store.network?.configuration.devices.find((row) => row.deviceId === store.selectedDeviceId),
);
const link = computed(() => store.network?.links.find((row) => row.id === store.selectedLinkId));
const observedLink = computed(() =>
  frame.value?.links.find((row) => row.linkId === store.selectedLinkId),
);
// 右侧和底部使用同一观测帧，不从资源态势补解释。
const assessment = computed(() =>
  selectMonitoringAssessment(store.network, frame.value, store.selectedLinkId),
);
const station = computed(() =>
  store.network
    ? configuredStations(store.network.stations, store.network.configuration).find(
        (row) => row.id === store.selectedStationId,
      )
    : null,
);
// 详情使用与地图相同的冻结网络，禁止混入当前台账编辑值。
</script>
<style scoped>
.alarm-mark {
  color: #eac179;
}
.monitor-detail {
  display: grid;
  gap: 14px;
  padding: 16px;
}
.monitor-detail h4 {
  margin: 0;
  color: #d1e5f5;
  font-size: 13px;
}
.notice,
.muted,
.warning {
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.warning {
  color: #edb484;
}
.kv {
  font-size: 12px;
  gap: 8px;
}
dd {
  overflow-wrap: anywhere;
}
.device-choice {
  display: block;
  text-align: left;
  background: #182d43;
  border: 1px solid var(--line);
  color: #b8d5ed;
  padding: 9px;
}
</style>
