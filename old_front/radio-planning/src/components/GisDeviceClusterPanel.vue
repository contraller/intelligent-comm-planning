<template>
  <section
    class="device-cluster-panel"
    aria-label="聚合设备清单"
  >
    <header
      ><h3>聚合设备 · {{ members.length }} 台</h3
      ><button
        class="text-link"
        @click="emit('close')"
        >收起设备清单</button
      ></header
    >
    <p class="muted">同站设备共用站点位置；选择设备查看详情，故障设备优先列出。</p>
    <p
      v-if="!members.length"
      class="notice"
      role="status"
      >当前聚合没有可显示的设备。</p
    >
    <div class="cluster-members">
      <button
        v-for="row in members"
        :key="row.id"
        class="cluster-device"
        :disabled="disabled"
        :aria-label="`查看聚合设备 ${row.id}`"
        @click="!disabled && emit('select', row.id)"
      >
        <strong
          >{{ row.deviceClass === 'HF' ? '◇' : '□' }} {{ row.id }} · {{ row.deviceClass }}</strong
        >
        <span>{{ row.stationName }} · {{ row.stationId }}</span>
        <span :class="['device-state', gisDeviceTone(row)]"
          >{{ gisDeviceStatus(row) }} · {{ row.offShelf ? '已下架' : '在架' }}</span
        >
        <template v-if="row.statusDisplay">
          <span
            >来源：{{ row.statusDisplay.sourceLabel }} · 采集：{{
              row.statusDisplay.observedAt || '未提供'
            }}</span
          >
          <span
            >{{ row.statusDisplay.note }} · 最近获取：{{
              row.statusDisplay.fetchedAt || '尚未获取'
            }}</span
          >
        </template>
        <span
          v-if="row.manualStation"
          class="manual"
          >人工标绘站点</span
        >
      </button>
    </div>
  </section>
</template>
<script setup lang="ts">
import { gisDeviceStatus, gisDeviceTone, type GisDevicePoint } from '../maps/gis-device-display';

defineProps<{ members: GisDevicePoint[]; disabled: boolean }>();
// 打开清单不会切换当前详情；只有用户选择成员才交给原未保存保护。
const emit = defineEmits<{ select: [id: string]; close: [] }>();
</script>
<style scoped>
.device-cluster-panel {
  padding: 16px;
  border-bottom: 1px solid #2a405a;
}
.device-cluster-panel header {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}
.device-cluster-panel h3 {
  font-size: 13px;
}
.device-cluster-panel p {
  margin: 10px 0;
  line-height: 1.7;
  font-size: 12px;
}
.cluster-members {
  display: grid;
  gap: 8px;
  max-height: 300px;
  overflow-y: auto;
}
.cluster-device {
  display: grid;
  gap: 6px;
  padding: 10px;
  text-align: left;
  color: #bad1e4;
  background: #0c1b2d;
  border: 1px solid #2a405a;
  border-radius: 4px;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.cluster-device:hover,
.cluster-device:focus-visible {
  border-color: #78bdec;
}
.cluster-device:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.device-state.NORMAL {
  color: #45c9af;
}
.device-state.FAULT {
  color: #f27887;
}
.device-state.OFFLINE {
  color: #8192a8;
}
.device-state.ALERT,
.manual {
  color: #f0bd67;
}
.device-state.UNKNOWN {
  color: #b8bed0;
}
</style>
