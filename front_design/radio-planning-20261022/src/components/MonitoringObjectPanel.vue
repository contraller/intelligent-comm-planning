<template>
  <section class="monitor-detail">
    <p class="muted">冻结网络 · {{ store.network?.name ?? '未选择' }} · {{ store.network?.version }}</p>
    <template v-if="device">
      <h4>{{ device.id }}</h4>
      <dl><dt>所属节点</dt><dd>{{ device.stationId }}</dd><dt>冻结状态</dt><dd>{{ status?.status ?? '未知' }}</dd><dt>告警</dt><dd>{{ status?.alert === true ? '有告警标记' : status?.alert === false ? '无告警标记' : '未知' }}</dd><dt>观测时间</dt><dd>{{ status?.observedAt ?? '未知' }}</dd><dt>状态快照</dt><dd>{{ status?.ref?.snapshotId ?? '未关联' }}</dd><dt>快照版本</dt><dd>{{ status?.ref?.snapshotRevision ?? '未知' }}</dd><dt>资源历史来源</dt><dd>{{ status?.ref?.resourceRevision ?? '未知' }}</dd><dt>观测功率 / 频率</dt><dd>未提供</dd><dt>方案配置功率</dt><dd>{{ configured?.txPowerDbm ?? '未提供' }} dBm</dd><dt>方案配置频率</dt><dd>{{ configured?.frequencyKhz ?? '未提供' }} kHz</dd></dl>
      <p v-for="reason in status?.unknownReasons ?? ['未选择或未读取同版状态快照']" :key="reason" class="muted">{{ reason }}</p>
    </template>
    <template v-else-if="link">
      <h4>{{ link.id }}</h4><dl><dt>节点</dt><dd>{{ link.a }} → {{ link.b }}</dd><dt>设备</dt><dd>{{ link.deviceA }} → {{ link.deviceB }}</dd><dt>方案频率</dt><dd>{{ link.frequencyKhz }} kHz</dd><dt>方案等级</dt><dd>{{ LINK_STATUS_STYLES[link.state]?.label ?? '未知' }}</dd><dt>实测质量与指标</dt><dd>未提供链路观测，不从设备状态推导</dd></dl>
    </template>
    <template v-else-if="station">
      <h4>{{ station.name }} · {{ station.id }}</h4><p class="muted">方案坐标：{{ station.coordinate.join(', ') }} · WGS84</p>
      <button v-for="row in store.network?.devices.filter(item => item.stationId === station!.id)" :key="row.id" class="btn" @click="store.selectDevice(row.id)">{{ row.id }}</button>
    </template>
    <p v-else class="muted">未选择监控对象</p>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useMonitoringStore, resolveDeviceStatusProjection, type FrozenDeviceStatusAnchor, type FrozenDeviceStatusProjection } from '../stores/monitoring';
import { configuredStations } from '../services/planning-snapshot';
import { LINK_STATUS_STYLES } from '../config/link-status';
const props = defineProps<{ statusAnchor?: FrozenDeviceStatusAnchor | null; statusProjections?: Record<string, FrozenDeviceStatusProjection> }>();
const store = useMonitoringStore();
const device = computed(() => store.network?.devices.find(row => row.id === store.selectedDeviceId));
const configured = computed(() => store.network?.configuration.devices.find(row => row.deviceId === store.selectedDeviceId));
const status = computed(() => resolveDeviceStatusProjection((props.statusProjections ?? store.deviceStatusProjections)[store.selectedDeviceId], props.statusAnchor === undefined ? store.deviceStatusAnchor : props.statusAnchor, store.selectedDeviceId));
const link = computed(() => store.network?.links.find(row => row.id === store.selectedLinkId));
const station = computed(() => store.network ? configuredStations(store.network.stations, store.network.configuration).find(row => row.id === store.selectedStationId) : null);
</script>
<style scoped>
.monitor-detail{display:grid;gap:12px;padding:16px;min-width:0}h4{margin:0;font-size:14px}.muted{font-size:12px;line-height:1.7;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:8px;font-size:12px}dd{margin:0;overflow-wrap:anywhere}.btn{text-align:left;white-space:normal}
</style>
