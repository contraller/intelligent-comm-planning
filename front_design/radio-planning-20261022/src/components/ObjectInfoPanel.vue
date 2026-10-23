<template>
  <div
    v-if="station"
    class="object-info"
  >
    <!-- 站点与设备摘要分别标识，避免把节点编号误认为设备实例编号。 -->
    <header
      class="object-summary"
      aria-label="站点摘要"
    >
      <div
        class="object-icon"
        aria-hidden="true"
        ><i class="pi pi-map-marker"
      /></div>
      <div class="object-heading">
        <small class="summary-kind">站点 / 节点</small>
        <h3>{{ station.name }}</h3>
        <p class="object-id">
          <span>{{ station.id }}</span>
          <span
            class="chip"
            v-for="item in station.classes"
            :key="item"
            >{{ item }}</span
          >
        </p>
      </div>
      <div class="object-status"
        ><StatusBadge
          :status="station.status ?? 'UNKNOWN'"
          :alert="station.alert ?? undefined"
      /></div>
    </header>
    <p
      v-if="equipment && stationEquipmentLabel(equipment, station.id)"
      class="notice"
      >{{ equipment ? stationEquipmentLabel(equipment, station.id) : '' }}</p
    >
    <p
      v-if="statusDisplays"
      class="readonly-note"
      >节点状态来源：台账基线；与设备同步观测分别显示。</p
    >
    <hr />
    <dl class="kv">
      <dt>来源</dt><dd>{{ station.origin ? resourceOrigins[station.origin] : '未提供' }}</dd
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
      v-if="canEditNode"
      class="btn small section-gap"
      @click="$emit('edit-station', station.id)"
    >
      编辑节点
    </button>
    <div class="subsection">
      <h3>关联设备</h3
      ><button
        v-if="canCreateDevice"
        class="btn small"
        @click="$emit('new-device', station.id)"
        >添加设备</button
      >
      <span class="chip">{{ members?.total ?? devices.length }} 台</span>
    </div>
    <div
      v-if="members"
      class="toolbar"
      ><button
        :disabled="members.pageNum <= 1"
        @click="emit('page', members.pageNum - 1)"
        >上页</button
      ><span>第 {{ members.pageNum }} 页</span
      ><button
        :disabled="members.pageNum * members.pageSize >= members.total"
        @click="emit('page', members.pageNum + 1)"
        >下页</button
      ></div
    >
    <label
      >查看设备实例<select
        :value="deviceId"
        aria-label="选择节点设备"
        @change="chooseDevice"
      >
        <option value="">请选择设备</option>
        <option
          v-if="device && !devices.some((item) => item.id === device?.id)"
          :value="device.id"
          >{{ device.id }} · 当前选中设备</option
        >
        <option
          v-for="item in devices"
          :key="item.id"
          :value="item.id"
        >
          {{ item.id }} ·
          {{
            'deviceClass' in item
              ? item.deviceClass
              : equipment?.models.find((m) => m.id === item.modelId)?.deviceClass
          }}
          ·
          {{
            item.availability === 'OFF_SHELF'
              ? '已下架'
              : item.availability === 'ACTIVE'
                ? '在架'
                : '上下架未提供'
          }}
        </option>
      </select></label
    >
    <div
      v-if="device"
      class="device-detail"
    >
      <header
        class="device-summary"
        aria-label="设备摘要"
      >
        <small class="summary-kind">设备实例</small>
        <h4>{{ model?.name }}</h4>
        <p class="object-id"
          ><span>{{ device.id }}</span
          ><span
            v-if="model"
            class="chip"
            >{{ model.deviceClass }}</span
          ></p
        >
      </header>
      <hr />
      <!-- 网络关联由父级提供；型号知识仍读取当前发布版，不改变编辑与保存。 -->
      <DeviceInfoPanel
        :device="device"
        :resources="resources"
        :references="references"
        :catalog="deviceCatalog ?? deviceDetail?.catalog ?? undefined"
        :network="deviceNetwork ?? deviceDetail?.network ?? undefined"
        :status-display="statusDisplays?.[device.id]"
        :configuration="configuration"
        :maintenance-binding="maintenanceBinding"
        :trace-services="traceServices"
        :detail-context="
          deviceDetail?.object.kind === 'device'
            ? {
                node: deviceDetail.node ?? null,
                model: deviceDetail.model,
                antenna: deviceDetail.antenna,
                knowledgeAvailable: true,
              }
            : undefined
        "
        @configure="$emit('configure', device.id, $event)"
        @ports="emit('ports', device.id)"
        @restore="emit('restore', device.id, $event)"
        @restore-candidate="emit('restore-candidate', $event)"
        @locate-network="emit('locate-network', $event)"
      >
        <template #actions>
          <button
            v-if="coverageEnabled"
            class="btn small section-gap"
            @click="$emit('view-coverage', device.id)"
            >查看覆盖</button
          >
          <button
            v-if="canEditDevice"
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
      }}{{ editable ? '' : '进入编辑模式后可维护参数。' }}
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
import { env } from '../config/env';
import type { Station, ResourcesData } from '../types/domain';
import type { DeviceDetailCatalog } from '../types/device-detail';
import type { DeviceNetworkContext } from '../types/device-network';
import StatusBadge from './StatusBadge.vue';
import DeviceInfoPanel from './DeviceInfoPanel.vue';
import type { DeviceStatusDisplay } from '../types/resource-status';
import { resourceOrigins } from '../config/resource-options';
import { stationEquipmentLabel } from '../services/resource-display';
const props = defineProps<{
  station?: Station | import('../types/resource-read').ReadNode;
  members?:
    | import('../types/resource-read').ResourcePage<import('../types/resource-read').ReadDevice>
    | null;
  resources?: ResourcesData;
  references?: import('../types/gis-workspace').GisResourceIndex;
  deviceCatalog?: DeviceDetailCatalog;
  deviceDetail?: import('../types/resource-read').ResourceObjectDetail | null;
  deviceNetwork?: DeviceNetworkContext;
  selectedDeviceId?: string;
  editable?: boolean;
  draft?: boolean;
  coverageEnabled?: boolean;
  statusDisplays?: Record<string, DeviceStatusDisplay>;
  configuration?: { editable: boolean; disabled: boolean; reason: string };
  maintenanceBinding?: import('../types/device-maintenance').MaintenanceBinding;
  traceServices?: import('../services/device-trace-http').DeviceTraceClient;
}>();
const emit = defineEmits<{
  ports: [deviceId: string];
  restore: [deviceId: string, value: import('../types/device-maintenance').DeviceRestorePreview];
  'restore-candidate': [value: import('../types/device-trace').RestoreProposal];
  'locate-network': [value: { snapshotId: string; linkIds: string[]; stationIds: string[] }];
  page: [value: number];
  'select-device': [id: string];
  'edit-station': [id: string];
  'edit-device': [id: string];
  'new-device': [stationId: string];
  'view-coverage': [deviceId: string];
  // 配置仍由页面校验来源，面板只转发实例和查看模式。
  configure: [deviceId: string, history: boolean];
}>();
const localDeviceId = ref('');
// HTTP只展示已获专项授权的操作，不能借宽资源权限扩大写入范围。
const canEditNode = computed(
  () =>
    !!props.editable &&
    !auth.blocked &&
    auth.can(env.mode === 'http' ? 'resources.workspace.edit' : 'resources.edit'),
);
const canCreateDevice = computed(
  () => canEditNode.value && (env.mode !== 'http' || auth.can('resources.create')),
);
const canEditDevice = computed(
  () => canEditNode.value && (env.mode !== 'http' || auth.can('resources.device.edit')),
);
// 目录负责成员名称；只有详情响应或编辑基线可提供完整设备参数。
const equipment = computed(() => props.references ?? props.resources);
const deviceId = computed(() => props.selectedDeviceId ?? localDeviceId.value);
function chooseDevice(event: Event) {
  const select = event.target as HTMLSelectElement;
  const id = select.value;
  if (props.selectedDeviceId === undefined) localDeviceId.value = id;
  else select.value = deviceId.value; // 由父级完成未保存确认后再更新选择。
  emit('select-device', id);
}
const devices = computed(
  () =>
    props.members?.items ??
    equipment.value?.devices.filter((item) => item.stationId === props.station?.id) ??
    [],
);
const device = computed(() =>
  props.deviceDetail?.object.kind === 'device' && props.deviceDetail.object.id === deviceId.value
    ? props.deviceDetail.object
    : (props.members?.items.find((item) => item.id === deviceId.value) ??
      props.resources?.devices.find(
        (item) => item.id === deviceId.value && item.stationId === props.station?.id,
      )),
);
const model = computed(() =>
  props.deviceDetail?.object.kind === 'device' && props.deviceDetail.object.id === deviceId.value
    ? props.deviceDetail.model
    : props.resources?.models.find((item) => item.id === device.value?.modelId),
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
  padding: 16px;
}
.object-summary {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
}
.object-heading {
  min-width: 0;
}
.summary-kind {
  display: block;
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 10px;
  font-weight: normal;
}
.object-heading h3 {
  margin: 0;
  font-size: 15px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.object-icon {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: #173d5b;
  color: #78bdec;
  display: grid;
  place-items: center;
}
.object-id {
  color: var(--muted);
  margin: 6px 0 0;
  font-size: 11px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: center;
  overflow-wrap: anywhere;
}
.object-id .chip {
  padding: 2px 5px;
  font-size: 10px;
}
.object-status {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  padding-top: 3px;
}
.object-status :deep(.alert-mark) {
  margin-left: 0;
}
.device-detail {
  background: #0c1729;
  border: 1px solid #23374e;
  padding: 10px;
  margin-top: 13px;
  border-radius: 5px;
}
.device-summary h4 {
  margin: 0;
  color: #d9e8f7;
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
</style>
