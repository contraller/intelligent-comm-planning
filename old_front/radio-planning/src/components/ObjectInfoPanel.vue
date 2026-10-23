<template>
  <div
    v-if="station"
    class="object-info"
  >
    <div class="object-icon"><i class="pi pi-map-marker" /></div>
    <h3>{{ station.name }}</h3
    ><p
      v-if="stationEquipmentLabel(resources, station.id)"
      class="notice"
      >{{ stationEquipmentLabel(resources, station.id) }}</p
    >
    <p class="object-id">
      {{ station.id }}
      <span
        class="chip"
        v-for="item in station.classes"
        :key="item"
        >{{ item }}</span
      >
    </p>
    <div class="object-status"
      ><StatusBadge
        :status="station.status"
        :alert="station.alert"
    /></div>
    <p
      v-if="statusDisplays"
      class="readonly-note"
      >节点状态来源：台账基线；与设备同步观测分别显示。</p
    >
    <hr />
    <dl class="kv">
      <dt>来源</dt><dd>{{ resourceOrigins[station.origin ?? 'SOURCE'] }}</dd
      ><dt>备注</dt><dd>{{ station.remark || '—' }}</dd>
      <dt>对象类型</dt>
      <dd>站点 / 节点</dd>
      <dt>所属区域</dt>
      <dd>{{ station.region }}</dd>
      <dt>节点子类型</dt><dd>{{ station.subtype ?? '—' }}</dd
      ><dt>角色 / 移动类型</dt><dd>{{ station.role ?? '—' }} / {{ station.mobility }}</dd>
      <dt>节点层级</dt>
      <dd>{{ station.echelon }} 级</dd>
      <dt>经度</dt>
      <dd>{{ station.coordinate[0].toFixed(6) }}° E</dd>
      <dt>纬度</dt>
      <dd>{{ station.coordinate[1].toFixed(6) }}° N</dd>
      <dt>高程</dt>
      <dd>{{ station.elevationM ?? '—' }} m</dd>
      <dt>中继能力</dt>
      <dd>{{ station.relayCapable ? '支持' : '不支持' }}</dd>
    </dl>
    <button
      v-if="editable && auth.can('resources.edit')"
      class="btn small section-gap"
      @click="$emit('edit-station', station.id)"
    >
      编辑节点
    </button>
    <div class="subsection">
      <h3>关联设备</h3
      ><button
        v-if="editable && auth.can('resources.edit')"
        class="btn small"
        @click="$emit('new-device', station.id)"
        >添加设备</button
      >
      <span class="chip">{{ devices.length }} 台</span>
    </div>
    <label
      >查看设备实例<select
        :value="deviceId"
        aria-label="选择节点设备"
        @change="chooseDevice"
      >
        <option value="">请选择设备</option>
        <option
          v-for="item in devices"
          :key="item.id"
          :value="item.id"
        >
          {{ item.id }} · {{ resources.models.find((m) => m.id === item.modelId)?.deviceClass }} ·
          {{ item.availability === 'OFF_SHELF' ? '已下架' : '在架' }}
        </option>
      </select></label
    >
    <div
      v-if="device"
      class="device-detail"
    >
      <h4>{{ model?.name }}</h4>
      <small>{{ device.id }}</small>
      <hr />
      <!-- 网络关联由父级提供；型号知识仍读取当前发布版，不改变编辑与保存。 -->
      <DeviceInfoPanel
        :device="device"
        :resources="resources"
        :catalog="deviceCatalog"
        :network="deviceNetwork"
        :status-display="statusDisplays?.[device.id]"
        :configuration="configuration"
        @configure="$emit('configure', device.id, $event)"
      >
        <template #actions>
          <button
            v-if="coverageEnabled"
            class="btn small section-gap"
            @click="$emit('view-coverage', device.id)"
            >查看覆盖</button
          >
          <button
            v-if="editable && auth.can('resources.edit')"
            class="btn small section-gap"
            @click="$emit('edit-device', device.id)"
          >
            编辑设备参数
          </button>
        </template>
      </DeviceInfoPanel>
    </div>
    <p class="readonly-note">
      节点与设备分别计数。{{ draft ? '当前显示 GIS 草稿，尚未保存。' : '当前显示已保存资源。'
      }}{{ editable ? '仅开放本批已确认的参数。' : '可在 GIS 编辑模式或设备台账维护参数。' }}
    </p>
  </div>
  <div
    v-else
    class="empty-inline"
  >
    在地图或资源树中选择节点<br /><br />查看位置、状态和关联设备
  </div>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed, ref, watch } from 'vue';
import type { Station, ResourcesData } from '../types/domain';
import type { DeviceDetailCatalog } from '../types/device-detail';
import type { DeviceNetworkContext } from '../types/device-network';
import StatusBadge from './StatusBadge.vue';
import DeviceInfoPanel from './DeviceInfoPanel.vue';
import type { DeviceStatusDisplay } from '../types/resource-status';
import { resourceOrigins, stationEquipmentLabel } from '../mocks/resource-presets';
const props = defineProps<{
  station?: Station;
  resources: ResourcesData;
  deviceCatalog?: DeviceDetailCatalog;
  deviceNetwork?: DeviceNetworkContext;
  selectedDeviceId?: string;
  editable?: boolean;
  draft?: boolean;
  coverageEnabled?: boolean;
  statusDisplays?: Record<string, DeviceStatusDisplay>;
  configuration?: { editable: boolean; disabled: boolean; reason: string };
}>();
const emit = defineEmits<{
  'select-device': [id: string];
  'edit-station': [id: string];
  'edit-device': [id: string];
  'new-device': [stationId: string];
  'view-coverage': [deviceId: string];
  // 配置仍由页面校验来源，面板只转发实例和查看模式。
  configure: [deviceId: string, history: boolean];
}>();
const localDeviceId = ref('');
const deviceId = computed(() => props.selectedDeviceId ?? localDeviceId.value);
function chooseDevice(event: Event) {
  const select = event.target as HTMLSelectElement;
  const id = select.value;
  if (props.selectedDeviceId === undefined) localDeviceId.value = id;
  else select.value = deviceId.value; // 由父级完成未保存确认后再更新选择。
  emit('select-device', id);
}
const devices = computed(() =>
  props.resources.devices.filter((item) => item.stationId === props.station?.id),
);
const device = computed(() => devices.value.find((item) => item.id === deviceId.value));
const model = computed(() =>
  props.resources.models.find((item) => item.id === device.value?.modelId),
);
watch(
  () => props.station?.id,
  () => {
    localDeviceId.value = '';
  },
);
</script>
<style scoped>
.object-info {
  padding: 19px;
}
.object-icon {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  background: #173d5b;
  color: #78bdec;
  display: grid;
  place-items: center;
  margin-bottom: 12px;
}
.object-id {
  color: var(--muted);
  margin: 9px 0;
  font-size: 11px;
  display: flex;
  gap: 7px;
  align-items: center;
}
.object-status {
  margin-top: 14px;
}
.device-detail {
  background: #0c1729;
  border: 1px solid #23374e;
  padding: 12px;
  margin-top: 13px;
  border-radius: 5px;
}
.device-detail h4 {
  margin-bottom: 6px;
  font-size: 12px;
}
</style>
