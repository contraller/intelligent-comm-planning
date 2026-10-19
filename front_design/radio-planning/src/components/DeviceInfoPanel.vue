<template>
  <section class="device-info-panel"
    ><div
      v-if="alarm"
      class="device-alarm"
      role="alert"
      ><strong><i class="pi pi-exclamation-triangle" /> {{ alarm }}</strong
      ><span>具体原因和发生时间未提供</span></div
    ><DeviceDetailTabs
      :device-id="device.id"
      :model-id="device.modelId"
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
              >{{ networkRole.role.role
              }}<small class="role-source"
                >网络 {{ network?.snapshotId }} · {{ networkRole.source }}<br />{{
                  networkRole.role.source
                }}<br />{{ networkRole.role.description }}</small
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
                >网络 {{ network?.snapshotId }} · {{ networkRole.source }}</small
              ></template
            ></dd
          ><dt>运行状态</dt
          ><dd
            ><ResourceStatusBadge
              v-if="statusDisplay"
              :value="statusDisplay" /><StatusBadge
              v-else
              :status="device.status"
              :alert="device.alert" /></dd
          ><dt>在架状态</dt
          ><dd>{{ device.availability === 'OFF_SHELF' ? '已下架，不能用于新规划' : '在架' }}</dd
          ><dt>创建来源</dt><dd>{{ resourceOrigins[device.origin ?? 'SOURCE'] }}</dd
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
        ><p
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
            >配置演示</button
          ><button
            class="btn small"
            :disabled="configuration.disabled"
            @click="$emit('configure', true)"
            >配置记录</button
          ><p class="detail-note">{{
            configuration.reason || '教学配置只记录回执，台账需单独保存。'
          }}</p></div
        ><h5 class="parameter-heading">设备当前配置</h5
        ><dl class="kv"
          ><dt>工作频率</dt><dd>{{ quantity(device.workFreqKhz, 'kHz') }}</dd
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
          :resources="resources"
          :network="network" /></template
      ><template #actions><slot name="actions" /></template></DeviceDetailTabs
  ></section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { selectDeviceRole } from '../services/device-network';
import type { Device, ResourcesData } from '../types/domain';
import type { DeviceDetailCatalog } from '../types/device-detail';
import type { DeviceNetworkContext } from '../types/device-network';
import { useDeviceKnowledgeSummary } from '../composables/useDeviceKnowledgeSummary';
import { resourceOrigins } from '../mocks/resource-presets';
import DeviceDetailTabs from './DeviceDetailTabs.vue';
import DeviceNetworkPanel from './DeviceNetworkPanel.vue';
import StatusBadge from './StatusBadge.vue';
import ResourceStatusBadge from './ResourceStatusBadge.vue';
import type { DeviceStatusDisplay } from '../types/resource-status';

// 只展示父级传入的当前设备：GIS 可传草稿，台账传已保存资源，不自行改写或提交。
const props = defineProps<{
  device: Device;
  resources: ResourcesData;
  catalog?: DeviceDetailCatalog;
  network?: DeviceNetworkContext;
  statusDisplay?: DeviceStatusDisplay;
  configuration?: { editable: boolean; disabled: boolean; reason: string };
}>();
// 仅父级明确开放时显示入口，快照详情与旧调用不自动读取配置服务。
defineEmits<{ configure: [history: boolean] }>();
const model = computed(() => props.resources.models.find((row) => row.id === props.device.modelId));
const station = computed(() =>
  props.resources.stations.find((row) => row.id === props.device.stationId),
);
const antenna = computed(() =>
  props.resources.antennas.find((row) => row.id === props.device.antennaId),
);
const modelDetail = computed(() =>
  props.catalog?.models.find((row) => row.modelId === props.device.modelId),
);
const antennaDetail = computed(() =>
  props.catalog?.antennas.find((row) => row.antennaId === props.device.antennaId),
);
// 网络角色沿关联网络查看权限；不能从所属节点角色推定。
const auth = useAuthStore();
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
} = useDeviceKnowledgeSummary(() => props.device);
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
