<template>
  <section class="link-monitor">
    <p class="origin">方案链路与观测分开 · 当前未提供链路实测快照</p>
    <div class="toolbar"><input v-model="query" aria-label="筛选监控链路" placeholder="链路 ID" /><label class="toggle"><input v-model="abnormalOnly" type="checkbox" />仅方案异常等级</label><span>{{ rows.length }} 条</span></div>
    <div class="table-scroll"><table><thead><tr><th>链路 / 节点</th><th>方案等级</th><th>实测质量</th><th>SNR / dB</th><th>误码率</th><th>丢包率</th><th>时延 / ms</th><th>吞吐 / kbps</th></tr></thead><tbody>
      <tr v-for="row in rows" :key="row.id" :class="{ selected: selectedId === row.id }"><td><button class="text-link" @click="$emit('select', row.id)">{{ row.id }}</button><small><button class="text-link" @click="$emit('selectStation', row.a)">{{ row.a }}</button> → <button class="text-link" @click="$emit('selectStation', row.b)">{{ row.b }}</button></small></td>
        <td>{{ row.state === null ? '未知' : LINK_STATUS_STYLES[row.state]?.label ?? '未知' }}</td><td>未提供</td><td>未知</td><td>未知</td><td>未知</td><td>未知</td><td>未知</td></tr>
      <tr v-if="!rows.length"><td colspan="8">没有匹配的链路</td></tr>
    </tbody></table></div>
    <dl v-if="selected"><dt>方案频率</dt><dd>{{ selected.frequencyKhz ?? '未提供' }} kHz</dd><dt>方案设备</dt><dd>{{ selected.deviceA }} → {{ selected.deviceB }}</dd><dt>实测来源</dt><dd>未提供链路观测，不从设备状态推导</dd></dl>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MonitoringNetwork, NetworkObservationFrame } from '../types/monitoring';
import type { GisNetwork } from '../types/gis-plan';
import type { FrozenDeviceStatusAnchor, FrozenDeviceStatusProjection } from '../stores/monitoring';
import { LINK_STATUS_STYLES } from '../config/link-status';
const props = defineProps<{ frozenNetwork?: GisNetwork | null; network?: MonitoringNetwork | null; frame?: NetworkObservationFrame | null; selectedId?: string; deviceStatusAnchor?: FrozenDeviceStatusAnchor | null; deviceStatusProjections?: Record<string, FrozenDeviceStatusProjection> }>();
defineEmits<{ select: [id: string]; selectStation: [id: string] }>();
const query = ref(''), abnormalOnly = ref(false);
const links = computed(() => props.frozenNetwork ? props.frozenNetwork.links.map(row => ({ id: row.id, a: row.a, b: row.b, deviceA: row.device_a, deviceB: row.device_b, frequencyKhz: row.frequency_khz, state: row.planned_state })) : props.network?.links ?? []);
const rows = computed(() => links.value.filter(row => row.id.toLowerCase().includes(query.value.toLowerCase()) && (!abnormalOnly.value || row.state !== null && ['WARNING', 'FAULT'].includes(row.state))));
const selected = computed(() => links.value.find(row => row.id === props.selectedId));
</script>
<style scoped>
.link-monitor{display:grid;gap:12px;min-width:0}.origin{color:var(--muted);font-size:12px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:12px}.toolbar>input{max-width:240px}.toggle{display:flex;gap:6px;align-items:center}.toggle input{width:auto}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:9px;border-bottom:1px solid var(--line);text-align:left;overflow-wrap:anywhere}small{display:block;color:var(--muted);font-size:11px}.selected{background:var(--surface-hover)}dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:8px;font-size:12px}dd{margin:0;overflow-wrap:anywhere}
</style>
