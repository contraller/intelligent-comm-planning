<template>
  <div class="gis-resource-tree">
    <div class="tree-tools">
      <div class="search"
        ><i class="pi pi-search" /><input
          :value="query"
          aria-label="搜索资源"
          placeholder="节点 / 设备 / 型号 / 链路 / 干扰源"
          @input="emit('update:query', ($event.target as HTMLInputElement).value)"
      /></div>
      <div class="segments"
        ><button
          v-for="item in filters"
          :key="item"
          :class="{ active: filter === item }"
          @click="emit('update:filter', item)"
          >{{ item }}</button
        ></div
      >
    </div>
    <div class="tree-summary"
      ><i class="pi pi-folder-open" />区域通信网络
      <span>{{ tree.stations.length }} 节点 / {{ tree.devices.length }} 设备</span></div
    >
    <div class="tree-scroll">
      <template
        v-for="row in tree.stationRows"
        :key="row.station.id"
      >
        <button
          class="station-item"
          :class="{ selected: selectedId === row.station.id }"
          @click="emit('selectStation', row.station.id)"
        >
          <i
            class="pi pi-map-marker"
            :class="row.station.status"
          /><span class="station-copy">
            <strong>{{ row.station.name }}</strong
            ><small
              >{{ row.station.id
              }}<span>{{
                stationEquipmentLabel(resources, row.station.id) || row.station.classes.join(' / ')
              }}</span></small
            > </span
          ><i
            v-if="row.station.alert"
            class="pi pi-exclamation-triangle alert-icon"
          />
        </button>
        <!-- 设备命中自动展开归属节点，不自动切换右侧详情。 -->
        <div
          v-if="selectedId === row.station.id || row.expanded"
          class="device-children"
        >
          <small>{{ resourceOrigins[row.station.origin ?? 'SOURCE'] }}</small>
          <button
            v-for="device in row.devices"
            :key="device.id"
            :aria-label="'选择设备 ' + device.id"
            :disabled="disabled"
            :class="{ active: selectedDeviceId === device.id }"
            @click="emit('selectDevice', device.id)"
            >{{ device.id }} · {{ device.availability === 'OFF_SHELF' ? '已下架' : '在架' }}</button
          >
        </div>
      </template>
      <div
        v-if="!tree.stations.length"
        class="empty-inline"
        >未找到匹配节点或设备</div
      >
      <div class="tree-summary"
        >规划后链路 <span>{{ tree.linkRows.length }} 条</span></div
      >
      <button
        v-for="row in tree.linkRows"
        :key="row.link.id"
        class="link-item"
        :aria-label="'选择链路 ' + row.link.id"
        :class="{ selected: selectedLinkId === row.link.id }"
        :disabled="disabled || !row.available"
        @click="emit('selectLink', row.link.id)"
      >
        <strong
          >{{ row.link.id }} · {{ row.link.deviceClass }} · {{ linkStates[row.link.state] }}</strong
        >
        <span>{{ row.endpointLabel }}</span
        ><small v-if="row.reason">{{ row.reason }}</small>
      </button>
      <div
        v-if="!tree.linkRows.length"
        class="empty-inline"
        >未找到匹配规划链路</div
      >
      <!-- 候选与正式链路使用不同事件；参考质量不作为运行状态标签。 -->
      <div class="tree-summary"
        >候选链路 <span>{{ tree.candidateRows.length }} 条</span></div
      >
      <button
        v-for="row in tree.candidateRows"
        :key="row.link.id"
        class="link-item"
        :aria-label="'选择候选链路 ' + row.link.id"
        :class="{ selected: selectedCandidateLinkId === row.link.id }"
        :disabled="disabled || candidateDisabled"
        @click="emit('selectCandidateLink', row.link.id)"
      >
        <strong>{{ row.link.id }} · {{ row.link.deviceClass }} · 候选</strong>
        <span>{{ row.endpointLabel }}</span
        ><small>{{
          row.link.assessmentState === 'PENDING' ? '待评估' : '外部参考 · 非当前评估'
        }}</small>
        <small v-if="row.reason">{{ row.reason }}</small>
      </button>
      <div
        v-if="!tree.candidateRows.length"
        class="empty-inline"
        >未找到匹配候选链路</div
      >
      <div class="tree-summary"
        >干扰源 <span>{{ tree.interferences.length }} 个</span></div
      >
      <button
        v-for="source in tree.interferences"
        :key="source.id"
        class="station-item"
        :class="{ selected: selectedInterferenceId === source.id }"
        @click="emit('selectInterference', source.id)"
        ><i class="pi pi-bolt" />
        <span class="station-copy"
          ><strong>{{ source.name }}</strong
          ><small>{{ source.id }} · {{ source.active ? '生效' : '未生效' }}</small></span
        >
      </button>
      <div
        v-if="!tree.interferences.length"
        class="empty-inline"
        >未找到匹配干扰源</div
      >
    </div>
    <div class="tree-footer">全库 {{ totalNodes }} 个节点 / {{ totalDevices }} 台设备</div>
  </div>
</template>
<script setup lang="ts">
import type { GisResourceFilter, GisResourceTree } from '../services/gis-resource-tree';
import type { ResourcesData } from '../types/domain';
import { resourceOrigins, stationEquipmentLabel } from '../mocks/resource-presets';

defineProps<{
  tree: GisResourceTree;
  resources: ResourcesData;
  query: string;
  filter: GisResourceFilter;
  selectedId: string;
  selectedDeviceId: string;
  selectedLinkId: string;
  selectedInterferenceId: string;
  selectedCandidateLinkId?: string;
  candidateDisabled?: boolean;
  totalNodes: number;
  totalDevices: number;
  disabled: boolean;
}>();
const emit = defineEmits<{
  'update:query': [value: string];
  'update:filter': [value: GisResourceFilter];
  selectStation: [id: string];
  selectDevice: [id: string];
  selectLink: [id: string];
  selectInterference: [id: string];
  selectCandidateLink: [id: string];
}>();
const filters: GisResourceFilter[] = ['全部', 'HF', 'VUHF', '告警'];
const linkStates = { EXCELLENT: '优', GOOD: '良好', WARNING: '告警', FAULT: '故障' };
// 搜索只发出条件，选择与未保存确认由页面统一处理。
</script>
<style scoped>
.gis-resource-tree {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.tree-tools {
  padding: 15px 13px 10px;
}
.tree-tools .segments {
  margin-top: 12px;
  display: flex;
}
.tree-tools .segments button {
  flex: 1;
  padding: 6px 5px;
  font-size: 11px;
}
.tree-summary {
  color: #9eb4cf;
  background: #15243b;
  font-size: 11px;
  padding: 12px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.tree-summary span {
  margin-left: auto;
  color: #638eb9;
}
.tree-scroll {
  flex: 1;
  overflow: auto;
  padding: 7px;
}
.station-item {
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  display: flex;
  text-align: left;
  padding: 11px 9px;
  gap: 10px;
  align-items: center;
  border-radius: 4px;
}
.station-item:hover {
  background: #152c45;
}
.station-item.selected {
  background: #173653;
  border-color: #28547a;
}
.station-copy {
  flex: 1;
  min-width: 0;
}
.station-copy strong {
  display: block;
  font-size: 11px;
  margin-bottom: 7px;
}
.station-copy small {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
}
.station-copy small span {
  color: #5c9bbf;
}
.station-item > .pi {
  font-size: 13px;
}
.NORMAL {
  color: #57baab;
}
.FAULT {
  color: #f27887;
}
.OFFLINE {
  color: #8394ac;
}
.station-item .alert-icon {
  color: #d5ac68;
  font-size: 11px;
}
.tree-footer {
  padding: 13px;
  color: #758ca9;
  font-size: 10px;
  border-top: 1px solid var(--line);
}
.device-children {
  padding: 0 12px 8px 33px;
  display: grid;
  gap: 6px;
}
.device-children small {
  font-size: 10px;
  color: #89a4c3;
}
.device-children button {
  background: none;
  border: 0;
  text-align: left;
  font-size: 10px;
  color: #a7bbd5;
  overflow-wrap: anywhere;
}
.device-children button.active {
  color: #7dceff;
}
.link-item {
  display: grid;
  gap: 6px;
  width: 100%;
  text-align: left;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: #a7bbd5;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.link-item:hover {
  background: #152c45;
}
.link-item.selected {
  background: #173653;
  border-color: #28547a;
}
.link-item strong {
  font-size: 11px;
}
.link-item small {
  color: #d5ac68;
}
.link-item:disabled {
  opacity: 0.65;
  cursor: default;
}
</style>
