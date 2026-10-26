<template>
  <!-- 两种来源复用设备信息分组；分页关联设备单独读取，不冒充完整台账。 -->
  <ObjectInfoPanel
    v-if="!paged || object?.kind === 'node' || (object?.kind === 'device' && nodeDetail)"
    v-bind="$attrs"
    :station="paged ? (object?.kind === 'node' ? object : (nodeDetail ?? undefined)) : station"
    :device-detail="paged ? detail : undefined"
    :selected-device-id="paged && object?.kind === 'device' ? object.id : selectedDeviceId"
    :resources="resources"
    :references="references"
    :device-catalog="deviceCatalog"
    :device-network="deviceNetwork"
    :configuration="configuration"
    :maintenance-binding="maintenanceBinding"
    :trace-services="traceServices"
    :coverage-enabled="coverageEnabled"
    @configure="(id, history) => emit('configure', id, history)"
    @ports="emit('ports', $event)"
    @restore="(id, value) => emit('restore', id, value)"
    @restore-candidate="emit('restore-candidate', $event)"
    @locate-network="emit('locate-network', $event)"
    @view-coverage="emit('view-coverage', $event)"
    @select-device="emit('select-device', $event)"
  />
  <section
    v-else
    class="gis-object-info"
  >
    <p
      v-if="error"
      role="alert"
      >{{ error }}</p
    >
    <template v-if="object">
      <!-- 分页详情使用同样的紧凑摘要，只展示当前对象已提供的身份与状态。 -->
      <header
        class="object-summary"
        :aria-label="object.kind === 'device' ? '设备摘要' : '干扰源摘要'"
      >
        <div
          class="object-icon"
          aria-hidden="true"
          ><i
            class="pi"
            :class="object.kind === 'device' ? 'pi-server' : 'pi-bolt'"
        /></div>
        <div class="object-heading">
          <small class="summary-kind">{{ object.kind === 'device' ? '设备实例' : '干扰源' }}</small>
          <h3>{{ object.kind === 'device' ? object.modelName : object.name }}</h3>
          <p class="object-id"
            ><span>{{ object.id }}</span
            ><span
              v-if="object.kind === 'device'"
              class="chip"
              >{{ object.deviceClass }}</span
            ></p
          >
        </div>
        <div
          v-if="object.kind !== 'interference'"
          class="object-status"
          ><StatusBadge
            :status="object.status ?? 'UNKNOWN'"
            :alert="object.alert ?? undefined"
        /></div>
      </header>
      <DeviceInfoPanel
        v-if="object.kind === 'device' && detail"
        :key="object.id"
        :device="object"
        :resources="resources"
        :references="references"
        :catalog="detail.catalog ?? deviceCatalog"
        :network="detail.network ?? deviceNetwork"
        :configuration="configuration"
        :maintenance-binding="maintenanceBinding"
        :trace-services="traceServices"
        @ports="emit('ports', object.id)"
        @restore="emit('restore', object.id, $event)"
        @restore-candidate="emit('restore-candidate', $event)"
        @locate-network="emit('locate-network', $event)"
        @configure="emit('configure', object.id, $event)"
        :detail-context="{
          node: nodeDetail,
          model: detail.model,
          antenna: detail.antenna,
          knowledgeAvailable: true,
        }"
        ><template #actions
          ><button
            v-if="coverageEnabled"
            class="btn small"
            @click="emit('view-coverage', object.id)"
            >查看覆盖</button
          ></template
        ></DeviceInfoPanel
      >
      <dl
        v-else-if="object.kind === 'interference'"
        class="kv"
      >
        <dt>对象类型</dt><dd>干扰源</dd> <dt>位置</dt
        ><dd>{{ object.coordinate.join('，') }}（经度，纬度）</dd> <dt>生效状态</dt
        ><dd>{{ object.active ? '生效' : '未生效' }}</dd> <dt>中心频率</dt
        ><dd>{{ object.centerFreqKhz }} kHz</dd> <dt>带宽</dt
        ><dd>{{ object.bandwidthKhz }} kHz</dd> <dt>功率</dt><dd>{{ object.txPowerDbm }} dBm</dd>
      </dl>
      <p class="muted">资源版本：{{ detail?.revision }} · 当前显示已保存资源</p>
    </template>
    <p
      v-else
      class="muted"
      >在地图或资源树中选择对象，查看位置、状态和关联设备。</p
    >
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, provide } from 'vue';
import ObjectInfoPanel from './ObjectInfoPanel.vue';
import DeviceInfoPanel from './DeviceInfoPanel.vue';
import StatusBadge from './StatusBadge.vue';
import { previewService } from '../services';
import { useAuthStore } from '../stores/auth';
import type { ResourcesData, Station } from '../types/domain';
import type { ReadNode, ResourceObjectDetail } from '../types/resource-read';
defineOptions({ inheritAttrs: false });
// 仅在 GIS 详情入口使用统一业务名称，资源页保留既有操作入口。
provide('gisPresentation', true);
const props = defineProps<{
  paged?: boolean;
  station?: Station;
  // 完整资源仅用于编辑；浏览详情使用按 ID 响应和轻量名称索引。
  resources?: ResourcesData;
  references?: import('../types/gis-workspace').GisResourceIndex;
  detail?: ResourceObjectDetail | null;
  deviceCatalog?: import('../types/device-detail').DeviceDetailCatalog;
  deviceNetwork?: import('../types/device-network').DeviceNetworkContext;
  configuration?: { editable: boolean; disabled: boolean; reason: string };
  maintenanceBinding?: import('../types/device-maintenance').MaintenanceBinding;
  traceServices?: import('../services/device-trace-http').DeviceTraceClient;
  coverageEnabled?: boolean;
  selectedDeviceId?: string;
}>();
const emit = defineEmits<{
  ports: [deviceId: string];
  restore: [deviceId: string, value: import('../types/device-maintenance').DeviceRestorePreview];
  'restore-candidate': [value: import('../types/device-trace').RestoreProposal];
  'locate-network': [value: { snapshotId: string; linkIds: string[]; stationIds: string[] }];
  'select-device': [id: string];
  configure: [id: string, history: boolean];
  'view-coverage': [id: string];
}>();
const auth = useAuthStore(),
  nodeDetail = ref<ReadNode | null>(null),
  error = ref('');
const object = computed(() => props.detail?.object);
let serial = 0;
watch(
  () => [props.detail?.revision, object.value?.id, auth.generation],
  async () => {
    const token = ++serial;
    nodeDetail.value = null;
    error.value = '';
    const item = object.value;
    if (!props.paged || !item || !props.detail) return;
    // 节点成员来自完整轻目录，不为下拉列表预读设备完整参数。
    if (item.kind === 'device') {
      try {
        const result = props.detail.node
          ? { object: props.detail.node }
          : await previewService.getResourceObject({
              context: 'gis',
              revision: props.detail.revision,
              kind: 'node',
              id: item.stationId,
            });
        if (token === serial && result.object.kind === 'node') nodeDetail.value = result.object;
      } catch (reason) {
        if (token === serial)
          error.value = reason instanceof Error ? reason.message : '所属节点读取失败';
      }
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  serial++;
});
</script>
<style scoped>
.gis-object-info {
  padding: 18px;
}
.object-summary {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  margin-bottom: 14px;
}
.object-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: #173d5b;
  color: #78bdec;
}
.object-heading {
  min-width: 0;
}
.summary-kind {
  display: block;
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 10px;
}
.object-heading h3 {
  margin: 0;
  font-size: 15px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.object-id {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 11px;
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
.muted {
  font-size: 11px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.member {
  display: block;
  margin: 8px 0;
  border: 0;
  color: #9bc8e7;
  background: transparent;
  text-align: left;
}
.toolbar {
  display: flex;
  gap: 8px;
}
</style>
