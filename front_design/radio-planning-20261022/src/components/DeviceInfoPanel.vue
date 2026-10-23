<template>
  <section class="device-info-panel"
    ><div
      v-if="alarm"
      class="device-alarm"
      role="alert"
      ><strong><i class="pi pi-exclamation-triangle" /> {{ alarm }}</strong
      ><span>具体原因和发生时间未提供</span></div
    ><DeviceNetworkDetailPanel
      v-if="drill.active.value"
      :data="drill.data.value"
      :busy="drill.busy.value"
      :error="drill.error.value"
      :network="network"
      :parent-link="drill.parentLink.value"
      :context="maintenanceBinding?.context ?? 'gis'"
      @back="closeDrill"
      @back-link="backToLink"
      @service="openLinkedService"
      @locate="locateDrill"
    />
    <DeviceDetailTabs
      v-show="!drill.active.value"
      :device-id="device.id"
      :model-id="device.modelId"
      :knowledge-available="detailContext?.knowledgeAvailable"
      ><template #basic
        ><dl class="kv"
          ><dt>设备编号</dt><dd>{{ device.id }}</dd
          ><dt>设备型号</dt
          ><dd
            >{{ model?.name || '未提供' }}<br /><small>{{ device.modelId }}</small></dd
          ><dt>厂家</dt><dd>{{ model?.manufacturer || '未提供' }}</dd
          ><dt>设备类别</dt><dd>{{ model?.deviceClass || '未提供' }}</dd
          ><dt>电台类型</dt><dd>{{ modelDetail?.category || '未提供' }}</dd
          ><dt>设备网络角色</dt
          ><dd aria-label="设备网络角色"
            ><template v-if="networkRole.role"
              >{{ roleCopy(networkRole.role.role)
              }}<small class="role-source"
                >网络 {{ network?.snapshotId }} · {{ roleCopy(networkRole.source) }}<br />{{
                  roleCopy(networkRole.role.source)
                }}<br />{{ roleCopy(networkRole.role.description) }}</small
              ></template
            ><template v-else
              >未提供<small class="role-source">{{
                !auth.can('situation.view') || auth.blocked
                  ? '当前角色没有关联网络查看权限'
                  : networkRole.message
              }}</small
              ><small
                v-if="networkRole.source"
                class="role-source"
                >网络 {{ network?.snapshotId }} · {{ roleCopy(networkRole.source) }}</small
              ></template
            ></dd
          ><dt>运行状态</dt
          ><dd
            ><ResourceStatusBadge
              v-if="statusDisplay"
              :value="statusDisplay"
            /><StatusBadge
              v-else
              :status="device.status ?? 'UNKNOWN'"
              :alert="device.alert ?? undefined"
            /><span v-if="detailContext && device.alert === null"> · 告警未提供</span></dd
          ><dt v-if="statusSnapshotRef">状态快照引用</dt
          ><dd v-if="statusSnapshotRef">{{ statusSnapshotRef.deviceId === device.id && statusSnapshotRef.resourceRevision === maintenanceBinding?.revision ? statusSnapshotRef.snapshotId : '引用未对齐，未关联' }}</dd
          ><dt>在架状态</dt
          ><dd>{{
            detailContext && device.availability == null
              ? '未提供'
              : device.availability === 'OFF_SHELF'
                ? '已下架，不能用于新规划'
                : '在架'
          }}</dd
          ><dt>创建来源</dt
          ><dd>{{
            detailContext && device.origin == null
              ? '未提供'
              : resourceOrigins[device.origin ?? 'SOURCE']
          }}</dd
          ><dt>所属节点</dt
          ><dd
            >{{ station?.name || '未提供' }}<br /><small>{{ device.stationId }}</small></dd
          ><dt>部署区域</dt><dd>{{ station?.region || '未提供' }}</dd
          ><dt>部署位置</dt
          ><dd>{{
            station
              ? `${station.coordinate[0].toFixed(6)}, ${station.coordinate[1].toFixed(6)}（经度, 纬度）`
              : '未提供'
          }}</dd
          ><dt>安装时间</dt><dd>{{ device.installedAt || '未提供' }}</dd></dl
        ></template
      ><template #structure
        ><DevicePortsPanel
          v-if="maintenanceBinding"
          :ports="'ports' in device ? device.ports : maintenanceState.data.value?.device.ports"
          :observations="maintenanceState.data.value?.observations ?? []"
          :source="maintenanceState.data.value?.source ?? ''"
          :loaded="!!maintenanceState.data.value"
          :busy="maintenanceState.busy.value"
          :error="maintenanceState.error.value"
          :editable="maintenanceBinding.editable"
          @load="maintenanceState.load"
          @edit="emit('ports')"
        />
        <p
          v-if="knowledgeSummary"
          class="detail-note"
          >型号知识发布版本：{{ knowledgeSummary.versionId }}</p
        ><dl class="kv"
          ><dt>关联天线</dt
          ><dd
            >{{ antenna?.name || '未提供' }}<br /><small>{{ device.antennaId }}</small></dd
          ><template
            v-for="group in structureKnowledge"
            :key="group.kind"
            ><dt>{{ group.label }}</dt
            ><dd :aria-label="group.ariaLabel"
              ><p
                v-if="knowledgeStatus !== 'ready'"
                class="knowledge-state"
                role="status"
                >{{ knowledgeNotice }}</p
              ><p
                v-else-if="!group.items.length"
                class="knowledge-state"
                >此发布版本未提供该型号的{{ group.kind }}知识</p
              ><ul
                v-else
                class="knowledge-list"
                ><li
                  v-for="item in group.items"
                  :key="item.entityId"
                  ><strong>{{ item.name }}</strong
                  ><p>{{ item.description || '未提供说明' }}</p
                  ><p class="detail-note">资料来源：{{ item.entitySource }}</p
                  ><details class="knowledge-evidence"
                    ><summary>查看关联依据</summary><p>知识实体：{{ item.entityId }}</p
                    ><div
                      v-for="binding in item.bindings"
                      :key="`${binding.rootId}:${binding.relationId}`"
                      ><p>型号知识根：{{ binding.rootName }}（{{ binding.rootId }}）</p
                      ><p>型号根来源：{{ binding.rootSource }}</p
                      ><p>关系：{{ binding.relationType }}（{{ binding.relationId }}）</p
                      ><p>关系来源：{{ binding.relationSource }}</p></div
                    ></details
                  ></li
                ></ul
              ></dd
            ></template
          ></dl
        ><button
          v-if="canRetryKnowledge"
          class="btn ghost small"
          @click="retryKnowledge"
          >重试型号知识</button
        ></template
      ><template #functions
        ><p
          v-if="knowledgeSummary"
          class="detail-note"
          >型号知识发布版本：{{ knowledgeSummary.versionId }}</p
        ><dl class="kv"
          ><dt>型号功能知识</dt
          ><dd aria-label="设备型号功能知识"
            ><p
              v-if="knowledgeStatus !== 'ready'"
              class="knowledge-state"
              role="status"
              >{{ knowledgeNotice }}</p
            ><p
              v-else-if="!knowledgeSummary?.functions.length"
              class="knowledge-state"
              >此发布版本未提供该型号的功能知识</p
            ><ul
              v-else
              class="knowledge-list"
              ><li
                v-for="item in knowledgeSummary.functions"
                :key="item.entityId"
                ><strong>{{ item.name }}</strong
                ><p>{{ item.description || '未提供说明' }}</p
                ><p class="detail-note">资料来源：{{ item.entitySource }}</p
                ><details class="knowledge-evidence"
                  ><summary>查看关联依据</summary><p>知识实体：{{ item.entityId }}</p
                  ><div
                    v-for="binding in item.bindings"
                    :key="`${binding.rootId}:${binding.relationId}`"
                    ><p>型号知识根：{{ binding.rootName }}（{{ binding.rootId }}）</p
                    ><p>型号根来源：{{ binding.rootSource }}</p
                    ><p>关系：{{ binding.relationType }}（{{ binding.relationId }}）</p
                    ><p>关系来源：{{ binding.relationSource }}</p></div
                  ></details
                ></li
              ></ul
            ></dd
          ><dt>支持工作模式</dt><dd>{{ values(model?.workMode) }}</dd
          ><dt>支持业务类型</dt><dd>{{ values(services) }}</dd
          ><dt>支持数据速率</dt><dd>{{ values(modelDetail?.dataRatesKbps, 'kbps') }}</dd
          ><dt>约束说明</dt><dd>{{ modelDetail?.constraintNote || '未提供' }}</dd></dl
        ><button
          v-if="canRetryKnowledge"
          class="btn ghost small"
          @click="retryKnowledge"
          >重试型号知识</button
        ></template
      ><template #parameters
        ><div
          v-if="configuration"
          class="section-gap"
          ><button
            v-if="configuration.editable"
            class="btn small"
            :disabled="configuration.disabled || device.availability === 'OFF_SHELF'"
            @click="$emit('configure', false)"
            >配置请求</button
          ><button
            class="btn small"
            :disabled="configuration.disabled"
            @click="$emit('configure', true)"
            >配置记录</button
          ><p class="detail-note">{{
            configuration.reason ||
            '配置请求仅系统受理，未下发；台账参数需经资源维护另行保存。'
          }}</p></div
        ><h5 class="parameter-heading">台账保存参数</h5
        ><dl class="kv"
          ><dt>工作频率</dt><dd>{{ quantity(device.workFreqKhz, 'kHz') }}</dd
          ><dt>当前工作模式</dt
          ><dd>{{
            maintenanceModes.find((m) => m.value === device.currentWorkMode)?.label ??
            device.currentWorkMode ??
            '未提供'
          }}</dd
          ><dt>发射功率</dt><dd>{{ quantity(device.txPowerDbm, 'dBm') }}</dd
          ><dt>天线高度</dt><dd>{{ quantity(device.antennaHeightM, 'm') }}</dd
          ><dt>倾角 / 方位角</dt
          ><dd>{{ quantity(device.tiltDeg, '°') }} / {{ quantity(device.azimuthDeg, '°') }}</dd></dl
        ><h5 class="parameter-heading">型号与天线资料</h5
        ><p class="detail-note">以下为支持能力，不代表当前使用的模式、带宽或速率。</p
        ><dl class="kv"
          ><dt>支持频段</dt
          ><dd>{{ model ? `${model.freqMinKhz}–${model.freqMaxKhz} kHz` : '未提供' }}</dd
          ><dt>功率上限</dt><dd>{{ quantity(model?.txPowerMaxDbm, 'dBm') }}</dd
          ><dt>支持功率档位</dt><dd>{{ values(modelDetail?.txPowerLevelsDbm, 'dBm') }}</dd
          ><dt>接收灵敏度</dt><dd>{{ quantity(modelDetail?.rxSensitivityDbm, 'dBm') }}</dd
          ><dt>支持信道带宽</dt><dd>{{ values(modelDetail?.bandwidthKhz, 'kHz') }}</dd
          ><dt>支持调制方式</dt><dd>{{ values(model?.modulation) }}</dd
          ><dt>天线型号增益</dt><dd>{{ quantity(antennaDetail?.gainDbi, 'dBi') }}</dd></dl
        ><p class="detail-note">型号资料来源：{{ modelDetail?.sourceDoc || '未提供' }}</p></template
      ><!-- 业务关联独立于型号能力，使用父级已校验的当前网络。 --><template #network
        ><DeviceNetworkPanel
          :device-id="device.id"
          :resources="references ?? resources ?? { stations: [], devices: [] }"
          :network="network"
          :context="maintenanceBinding?.context"
          @detail="drill.open" /></template
      ><template #actions
        ><button
          v-if="maintenanceBinding"
          class="btn small"
          @click="openTrace"
          >变更追溯与历史版本</button
        ><slot name="actions" /></template></DeviceDetailTabs
    ><DeviceTraceDrawer
      v-if="maintenanceBinding && traceOpen"
      :visible="traceOpen"
      :busy="trace.busy.value"
      :error="trace.error.value"
      :editable="traceEditable"
      :history="trace.history.value"
      :record="trace.detail.value"
      :selected="trace.selected.value"
      :restore="trace.restore.value"
      @close="closeTrace"
      @refresh="trace.query"
      @page="trace.query"
      @select="trace.select"
      @preview="trace.preview"
      @restore="acceptRestore"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, inject, watch } from 'vue';
import { useDeviceMaintenance } from '../composables/useDeviceMaintenance';
import { useDeviceNetworkDetail } from '../composables/useDeviceNetworkDetail';
import { maintenanceModes } from '../services/device-maintenance';
import type { MaintenanceBinding, DeviceRestorePreview } from '../types/device-maintenance';
import DevicePortsPanel from './DevicePortsPanel.vue';
import DeviceTraceDrawer from './DeviceTraceDrawer.vue';
import DeviceNetworkDetailPanel from './DeviceNetworkDetailPanel.vue';
import { useAuthStore } from '../stores/auth';
import { selectDeviceRole } from '../services/device-network';
import type { Device, ResourcesData } from '../types/domain';
import type { DeviceDetailCatalog, DeviceReadDetailContext } from '../types/device-detail';
import type { ReadDevice } from '../types/resource-read';
import type { DeviceNetworkContext } from '../types/device-network';
import { useDeviceKnowledgeSummary } from '../composables/useDeviceKnowledgeSummary';
import { resourceOrigins } from '../config/resource-options';
import DeviceDetailTabs from './DeviceDetailTabs.vue';
import DeviceNetworkPanel from './DeviceNetworkPanel.vue';
import StatusBadge from './StatusBadge.vue';
import ResourceStatusBadge from './ResourceStatusBadge.vue';
import type { DeviceStatusDisplay } from '../types/resource-status';
import { useDeviceTrace } from '../composables/useDeviceTrace';
import type { DeviceTraceClient } from '../services/device-trace-http';
import type { RestoreProposal } from '../types/device-trace';
import type { DeviceStatusSnapshotRef } from '../types/device-status-snapshot';

// 只展示父级传入的当前设备：GIS 可传草稿，台账传已保存资源，不自行改写或提交。
const gisPresentation = inject('gisPresentation', false);
// 仅调整 GIS 中预设角色的展示表述，保留来源及“非正式角色枚举”等限定。
function roleCopy(value: string | null) {
  const text = value ?? '';
  return gisPresentation
    ? text
        .replace(/教学角色/g, '参考角色')
        .replace(/教学/g, '')
        .replace(/Mock/g, '预设')
        .replace(/展示示例/g, '说明')
    : text;
}
const props = defineProps<{
  device: Device | ReadDevice;
  resources?: ResourcesData;
  references?: import('../types/gis-workspace').GisResourceIndex;
  catalog?: DeviceDetailCatalog;
  detailContext?: DeviceReadDetailContext;
  network?: DeviceNetworkContext;
  statusDisplay?: DeviceStatusDisplay;
  configuration?: { editable: boolean; disabled: boolean; reason: string };
  maintenanceBinding?: MaintenanceBinding;
  traceServices?: DeviceTraceClient;
  statusSnapshotRef?: DeviceStatusSnapshotRef | null;
}>();
// 仅父级明确开放时显示入口，快照详情与旧调用不自动读取配置服务。
const emit = defineEmits<{
  configure: [history: boolean];
  ports: [];
  restore: [value: DeviceRestorePreview];
  'restore-candidate': [value: RestoreProposal];
  'locate-network': [value: { snapshotId: string; linkIds: string[]; stationIds: string[] }];
}>();
const maintenanceQuery = () =>
  props.maintenanceBinding
    ? {
        context: props.maintenanceBinding.context,
        revision: props.maintenanceBinding.revision,
        deviceId: props.device.id,
      }
    : null;
const maintenanceState = useDeviceMaintenance(maintenanceQuery),
  drill = useDeviceNetworkDetail(maintenanceQuery, () => props.network),
  traceOpen = ref(false);
const auth = useAuthStore();
const traceEditable = computed(() => !!props.maintenanceBinding?.editable && auth.can('resources.device.edit') && !auth.blocked && props.device.availability !== 'OFF_SHELF');
const trace = useDeviceTrace(() => props.maintenanceBinding ? {
  device_id: props.device.id, resource_revision: props.maintenanceBinding.revision,
  readable: auth.can('resources.view') && !auth.blocked,
  editable: traceEditable.value,
} : null, () => props.traceServices);
function openTrace() {
  traceOpen.value = true;
  void trace.query();
}
function acceptRestore(value: RestoreProposal) {
  // 仅交候选；保存成功由宿主的统一资源回执决定，失败时仍保留候选。
  emit('restore-candidate', value);
}
function closeTrace() {
  traceOpen.value = false;
  maintenanceState.cancel();
  trace.cancel();
}
function closeDrill() {
  drill.close();
}
// 层级切换只清理临时高亮；地图平移和缩放仍由原显式定位入口负责。
function clearNetworkFocus() {
  emit('locate-network', {
    snapshotId: props.network?.snapshotId ?? '',
    linkIds: [],
    stationIds: [],
  });
}
async function openLinkedService(id: string, linkId: string, snapshotId: string) {
  const owner = auth.generation,
    binding = maintenanceQuery();
  if (await drill.openRelatedService(id, linkId, snapshotId)) {
    const current = maintenanceQuery();
    if (
      owner === auth.generation &&
      binding?.deviceId === current?.deviceId &&
      binding?.revision === current?.revision &&
      binding?.context === current?.context &&
      drill.data.value?.service?.id === id &&
      drill.data.value.snapshotId === snapshotId
    )
      clearNetworkFocus();
  }
}
function backToLink() {
  if (drill.backToLink()) clearNetworkFocus();
}
function locateDrill(value: { snapshotId: string; linkIds: string[]; stationIds: string[] }) {
  const data = drill.data.value,
    binding = maintenanceQuery();
  if (
    !drill.active.value ||
    drill.busy.value ||
    !binding ||
    !data ||
    auth.blocked ||
    !auth.can(binding.context === 'ledger' ? 'resources.view' : 'situation.view') ||
    props.network?.state !== 'ready' ||
    props.network.snapshotId !== value.snapshotId ||
    data.snapshotId !== value.snapshotId ||
    JSON.stringify(value.linkIds) !== JSON.stringify(data.links.map((link) => link.id)) ||
    JSON.stringify(value.stationIds) !== JSON.stringify(data.stations.map((station) => station.id))
  )
    return;
  emit('locate-network', value);
}
watch(
  () => drill.active.value,
  (value, previous) => {
    if (previous && !value) clearNetworkFocus();
  },
);
watch(
  [
    () => props.device.id,
    () => props.maintenanceBinding?.revision,
    () => props.maintenanceBinding?.context,
  ],
  () => {
    traceOpen.value = false;
  },
);
const model = computed(() =>
  props.detailContext
    ? props.detailContext.model
    : props.resources?.models.find((row) => row.id === props.device.modelId),
);
const station = computed(() =>
  props.detailContext
    ? props.detailContext.node
    : props.resources?.stations.find((row) => row.id === props.device.stationId),
);
const antenna = computed(() =>
  props.detailContext
    ? props.detailContext.antenna
    : props.resources?.antennas.find((row) => row.id === props.device.antennaId),
);
const modelDetail = computed(() =>
  props.catalog?.models.find((row) => row.modelId === props.device.modelId),
);
const antennaDetail = computed(() =>
  props.catalog?.antennas.find((row) => row.antennaId === props.device.antennaId),
);
// 网络角色沿关联网络查看权限；不能从所属节点角色推定。
const networkRole = computed(() =>
  selectDeviceRole(
    auth.can('situation.view') && !auth.blocked ? props.network : undefined,
    props.device.id,
  ),
);
const alarm = computed(() => {
  // 只有显式接入观测时替换状态提示，设备配置和知识关联仍使用原对象。
  if (props.statusDisplay) {
    const value = props.statusDisplay;
    return value.status === 'FAULT'
      ? '设备故障' + (value.alert === true ? ' · 附加告警' : '')
      : value.alert === true
        ? '设备告警'
        : '';
  }
  if (props.device.status === 'FAULT')
    return props.device.alert ? '设备故障 · 附加告警' : '设备故障';
  if (!props.device.alert) return '';
  return props.device.status === 'OFFLINE' ? '设备离线 · 附加告警' : '设备告警（运行状态：正常）';
});
const serviceLabels: Record<string, string> = { voice: '话音', data: '数据' };
const services = computed(() =>
  modelDetail.value?.serviceTypes?.map((value) => serviceLabels[value] ?? value),
);
// 组成与功能使用完整发布版关系，独立于运维页签的关键词检索。
const {
  summary: knowledgeSummary,
  status: knowledgeStatus,
  error: knowledgeError,
  retry: retryKnowledge,
} = props.detailContext?.knowledgeAvailable === false
  ? // 缺能力时不创建会自动请求的知识运行单元；旧调用保留原生命周期。
    ({
      summary: ref(null),
      status: ref('forbidden'),
      error: ref(''),
      retry: async () => {},
    } as ReturnType<typeof useDeviceKnowledgeSummary>)
  : useDeviceKnowledgeSummary(() => props.device);
const structureKnowledge = computed(() => [
  {
    label: '子功能模块',
    kind: '部件',
    items: knowledgeSummary.value?.components ?? [],
    ariaLabel: '设备子模块知识',
  },
  {
    label: '设备接口',
    kind: '接口',
    items: knowledgeSummary.value?.interfaces ?? [],
    ariaLabel: '设备接口知识',
  },
]);
const knowledgeNotice = computed(() => {
  if (props.detailContext?.knowledgeAvailable === false) return '型号知识服务尚未接入';
  if (knowledgeStatus.value === 'forbidden') return '当前角色没有知识查看权限';
  if (knowledgeStatus.value === 'workspace-error')
    return `知识工作区不可用：${knowledgeError.value}`;
  if (knowledgeStatus.value === 'error') return `型号知识读取失败：${knowledgeError.value}`;
  return '正在读取型号知识…';
});
const canRetryKnowledge = computed(
  () => knowledgeStatus.value === 'workspace-error' || knowledgeStatus.value === 'error',
);
// null 与 0 分开；数组仅展示支持档位，不选择其中一项作为当前配置。
const quantity = (value: number | null | undefined, unit: string) =>
  value == null ? '未提供' : `${value} ${unit}`;
const values = (items: readonly (number | string)[] | null | undefined, unit = '') =>
  items?.length ? items.join(' / ') + (unit ? ` ${unit}` : '') : '未提供';
</script>

<style scoped>
.device-info-panel {
  min-width: 0;
}
.device-alarm {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid #b85969;
  border-radius: 5px;
  background: #472431;
  color: #ffc0ca;
  font-size: 12px;
  line-height: 1.6;
}
.device-alarm span {
  font-size: 11px;
}
.parameter-heading {
  margin-top: 14px;
  font-size: 12px;
  color: #bbd8ee;
}
.detail-note {
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.device-info-panel :deep(.kv) {
  grid-template-columns: minmax(90px, 0.85fr) minmax(0, 1.35fr);
}
.kv dd {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.kv small {
  color: var(--muted);
}
.role-source {
  display: block;
  margin-top: 5px;
  font-size: 11px;
}
.knowledge-state {
  margin: 0;
  color: var(--muted);
}
.knowledge-list {
  display: grid;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.knowledge-list p {
  margin: 5px 0;
}
.knowledge-evidence {
  margin-top: 7px;
  font-size: 11px;
  color: var(--muted);
}
.knowledge-evidence > summary {
  cursor: pointer;
  color: #bbd8ee;
}
.knowledge-evidence > div {
  padding: 5px 0;
  border-top: 1px solid var(--line);
}
</style>
