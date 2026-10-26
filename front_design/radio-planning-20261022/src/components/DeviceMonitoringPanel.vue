<template>
  <section class="device-monitor">
    <p class="origin">设备冻结状态 · SYNTHETIC_INTEGRATION · 构造导入，非实测</p>
    <div class="stats"><span v-for="(count, name) in counts" :key="name">{{ name }} <strong>{{ count }}</strong></span></div>
    <p v-if="!deviceStatusAnchor" class="muted">未选择或未读取同版状态快照；设备状态与告警未知</p>
    <div class="toolbar"><input v-model="query" aria-label="筛选监控设备" placeholder="设备 / 节点 ID" /><select v-model="filter" aria-label="筛选设备状态"><option value="all">全部状态</option><option value="NORMAL">正常</option><option value="FAULT">故障</option><option value="OFFLINE">离线</option><option value="unknown">未知</option><option value="alarm">有告警标记</option></select></div>
    <div class="table-scroll"><table><thead><tr><th>设备 / 节点</th><th>方案配置频率 / kHz</th><th>方案配置功率 / dBm</th><th>冻结状态</th><th>告警</th><th>观测时间</th><th>来源 / 未知说明</th></tr></thead><tbody>
      <tr v-for="row in rows" :key="row.device.id" :class="{ selected: selectedId === row.device.id }">
        <td><button class="text-link" @click="$emit('select', row.device.id)">{{ row.device.id }}</button><small>{{ row.device.stationId }}</small></td>
        <td>{{ row.device.frequencyKhz ?? '未提供' }}</td><td>{{ row.device.txPowerDbm ?? '未提供' }}</td>
        <td><StatusBadge v-if="row.status?.status" :status="row.status.status" /><span v-else>未知</span></td>
        <td>{{ row.status?.alert === true ? '有告警标记' : row.status?.alert === false ? '无告警标记' : '未知' }}</td><td>{{ row.status?.observedAt ?? '未知' }}</td>
        <td>{{ row.status?.unknownReasons.join('；') || (row.status ? '冻结构造状态' : '未选择或未读取同版状态快照') }}<small>{{ row.status?.ref?.snapshotId }} · {{ row.status?.ref?.snapshotRevision }}</small></td>
      </tr><tr v-if="!rows.length"><td colspan="7">没有匹配的设备</td></tr>
    </tbody></table></div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import StatusBadge from './StatusBadge.vue';
import type { MonitoringNetwork, NetworkObservationFrame } from '../types/monitoring';
import type { GisNetwork } from '../types/gis-plan';
import { resolveDeviceStatusProjection, type FrozenDeviceStatusAnchor, type FrozenDeviceStatusProjection } from '../stores/monitoring';
const props = defineProps<{ frozenNetwork?: GisNetwork | null; network?: MonitoringNetwork | null; frame?: NetworkObservationFrame | null; selectedId?: string; deviceStatusAnchor?: FrozenDeviceStatusAnchor | null; deviceStatusProjections?: Record<string, FrozenDeviceStatusProjection> }>();
defineEmits<{ select: [id: string] }>();
const query = ref(''), filter = ref('all');
const devices = computed(() => props.frozenNetwork ? props.frozenNetwork.devices.map(row => ({ id: row.id, stationId: row.station_id, frequencyKhz: row.frequency_khz, txPowerDbm: row.tx_power_dbm })) :
  (props.network?.devices ?? []).map(row => { const configured = props.network?.configuration.devices.find(item => item.deviceId === row.id); return { id: row.id, stationId: row.stationId, frequencyKhz: configured?.frequencyKhz ?? null, txPowerDbm: configured?.txPowerDbm ?? null }; }));
const all = computed(() => devices.value.map(device => ({ device, status: resolveDeviceStatusProjection(props.deviceStatusProjections?.[device.id],
  props.frozenNetwork && props.deviceStatusAnchor?.resourceRevision !== props.frozenNetwork.identity.resource_revision ? null : props.deviceStatusAnchor, device.id) })));
const rows = computed(() => all.value.filter(row => (row.device.id + ' ' + row.device.stationId).toLowerCase().includes(query.value.toLowerCase()) && (filter.value === 'all' || filter.value === 'alarm' && row.status?.alert === true || filter.value === 'unknown' && !row.status?.status || row.status?.status === filter.value)));
const counts = computed(() => ({ 正常: all.value.filter(row => row.status?.status === 'NORMAL').length, 故障: all.value.filter(row => row.status?.status === 'FAULT').length, 离线: all.value.filter(row => row.status?.status === 'OFFLINE').length, 未知: all.value.filter(row => !row.status?.status).length }));
</script>
<style scoped>
.device-monitor{display:grid;gap:12px;min-width:0}.origin,.muted{color:var(--muted);font-size:12px}.stats,.toolbar{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.stats{font-size:12px}.stats strong{font-size:18px;margin-left:6px}.toolbar input{max-width:240px}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:9px;overflow-wrap:anywhere;max-width:260px}small{display:block;color:var(--muted);font-size:11px;overflow-wrap:anywhere}.selected{background:var(--surface-hover)}
</style>
