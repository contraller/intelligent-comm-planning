<template>
  <section class="ports-panel">
    <h5>实例端口台账</h5>
    <button
      class="btn small"
      :disabled="busy || httpMode"
      :title="httpMode ? '端口台账协议待确认，当前只读' : undefined"
      @click="load"
      >{{ !httpMode && loaded ? '刷新端口资料' : '查看端口台账' }}</button
    >
    <p v-if="httpMode" class="note" role="status">实例端口、端口状态与采集时间未知，端口／模式协议待确认；当前只读，未读取端口或下发配置。</p>
    <button
      v-if="!httpMode && editable && ports?.length"
      class="btn small"
      :disabled="busy"
      @click="$emit('edit')"
      >维护端口／批量编辑</button
    >
    <p
      v-if="!httpMode && error"
      role="alert"
      >{{ error }}</p
    ><p v-if="!httpMode && busy">读取中…</p>
    <template v-if="!httpMode && loaded"
      ><p class="note">{{ source }}；状态只读，维护属性与观测分别保存。</p>
      <div
        v-if="ports?.length"
        class="table-scroll"
        ><table
          ><thead
            ><tr
              ><th>编号／类型</th><th>频段 kHz</th><th>速率 kbps</th><th>状态／观测时间</th
              ><th>天线参数</th></tr
            ></thead
          >
          <tbody
            ><tr
              v-for="port in ports"
              :key="port.id"
              ><td>{{ port.number }}<br />{{ port.type === 'RF' ? '射频' : '业务' }}</td
              ><td>{{ port.freqMinKhz ?? '未提供' }}–{{ port.freqMaxKhz ?? '未提供' }}</td
              ><td>{{ port.rateKbps ?? '未提供' }}</td
              ><td
                >{{ status(port.id) }}<br />{{
                  observations.find((o) => o.portId === port.id)?.observedAt ?? '未提供'
                }}</td
              ><td
                >增益 {{ port.gainDbi ?? '未提供' }} dBi<br />高度
                {{ port.heightM ?? '未提供' }} m<br />方位 {{ port.azimuthDeg ?? '未提供' }}°／俯仰
                {{ port.tiltDeg ?? '未提供' }}°</td
              ></tr
            ></tbody
          >
        </table></div
      ><p v-else>此设备未提供实例端口资料。</p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { env } from '../config/env';
import type { DevicePort, PortObservation } from '../types/device-maintenance';
// 不根据型号接口生成实例，不把缺失状态当正常。
const props = defineProps<{
  ports?: DevicePort[] | null;
  observations: PortObservation[];
  source: string;
  loaded: boolean;
  busy: boolean;
  error: string;
  editable: boolean;
}>();
const emit = defineEmits<{ load: []; edit: [] }>();
const httpMode = env.mode === 'http';
function load() { if (!httpMode && !props.busy) emit('load'); }
function status(id: string) {
  const value = props.observations.find((o) => o.portId === id)?.status;
  return value ? { NORMAL: '正常', FAULT: '故障', OFFLINE: '离线' }[value] : '未提供';
}
</script>
<style scoped>
.ports-panel {
  margin: 12px 0;
  font-size: 12px;
}
.note {
  color: var(--muted);
}
.table-scroll {
  overflow: auto;
}
table {
  border-collapse: collapse;
  min-width: 590px;
  width: 100%;
}
th,
td {
  padding: 8px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  overflow-wrap: anywhere;
}
button {
  margin: 0 6px 6px 0;
}
</style>
