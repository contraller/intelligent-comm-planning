<template>
  <section
    class="plan-operations"
    aria-label="冻结方案业务操作"
  >
    <div
      class="tabs"
      role="tablist"
      aria-label="方案态势"
    >
      <button
        v-for="item in tabs"
        :key="item.id"
        role="tab"
        :aria-selected="tab === item.id"
        :class="{ active: tab === item.id }"
        @click="selectTab(item.id)"
        >{{ item.name }}</button
      >
    </div>
    <p
      v-if="notice"
      role="status"
      class="notice"
      >{{ notice }}</p
    >
    <div
      v-show="tab === 'devices'"
      class="device-workbench"
    >
      <p
        v-if="!sameResource"
        class="notice"
        >历史资源版本：仅查看同版状态快照，不接受当前资源写操作。</p
      >
      <ResourceStatusPanel
        ref="statusPanel"
        :resource-revision="network.identity.resource_revision"
        :total="network.devices.length"
        :services="services.deviceStatuses"
        :enabled="canReadResources"
        :allow-import="sameResource && canImportStatus"
        @dirty="statusDirty = $event"
        @busy="statusBusy = $event"
      />
      <p
        v-if="viewedObservationRef"
        class="notice"
        >观测 {{ viewedObservationRef.datasetId }} · 声明成员
        {{
          viewedObservationRef.ref.deviceIds.join('、')
        }}；下方分页读取完整快照，未读取成员仍为未知。</p
      >
      <fieldset
        v-if="anchor"
        class="status-members"
      >
        <legend>频谱引用成员（已读取）</legend>
        <label
          v-for="id in availableStatusMembers"
          :key="id"
          ><input
            v-model="statusRefMembers"
            type="checkbox"
            :value="id"
          />{{ id }}</label
        >
        <button
          class="btn small"
          :disabled="!statusRefMembers.length"
          @click="statusRefMembers = []"
          >清空成员选择</button
        >
      </fieldset>
      <DeviceMonitoringPanel
        :frozen-network="network"
        :selected-id="selectedDevice"
        :device-status-anchor="anchor"
        :device-status-projections="projections"
        @select="selectDevice"
      />
      <div class="toolbar">
        <label
          >配置设备<select
            v-model="selectedDevice"
            class="input"
            :disabled="configurationVisible || config.busy"
            ><option value="">请选择设备</option
            ><option
              v-for="device in network.devices"
              :key="device.id"
              :value="device.id"
              >{{ device.id }} · {{ device.station_id }}</option
            ></select
          ></label
        >
        <button
          class="btn small"
          :disabled="!selectedDevice || !sameResource || !canReadResources"
          :title="sameResource ? '系统受理及历史，不代表真实设备下发' : '当前是历史资源版本'"
          @click="configurationVisible = true"
          >配置受理与历史</button
        >
      </div>
      <DeviceConfigurationDrawer
        v-if="configurationVisible"
        ref="configurationPanel"
        :visible="configurationVisible"
        view-context="gis"
        :device-id="selectedDevice"
        :resource-revision="network.identity.resource_revision"
        :services="services.deviceConfigurations"
        :editable="sameResource && canConfigure"
        :disabled-reason="canConfigure ? '' : '当前账号只有查看权限'"
        @close="configurationVisible = false"
      />
    </div>
    <LinkMonitoringPanel
      v-show="tab === 'links'"
      :frozen-network="network"
      :selected-id="selectedLinkId"
      :device-status-anchor="anchor"
      :device-status-projections="projections"
      @select="emit('selectLink', $event)"
      @select-station="emit('selectNode', $event)"
    />
    <SpectrumMonitoringPanel
      v-if="tab === 'spectrum'"
      ref="spectrum"
      :services="services.observations"
      :resource-revision="network.identity.resource_revision"
      :device-status-ref="observationStatusRef"
      :can-view="canReadResources"
      :can-import="canImportObservations"
      :session-generation="String(sessionGeneration)"
      @dirty-change="spectrumDirty = $event"
      @busy-change="spectrumBusy = $event"
      @select-dataset="cancelStatusRefRead"
      @select-status-ref="viewObservationStatus"
    />
    <section
      v-if="tab === 'interference'"
      class="interference-workbench"
    >
      <div class="analysis-controls toolbar">
        <label
          ><input
            v-model="analysisAreaVisible"
            type="checkbox"
            aria-label="显示干扰分析影响区域"
          />影响区域</label
        >
        <label
          >影响区透明度<input
            :value="analysisAreaOpacity"
            type="range"
            min="0"
            max="1"
            step="0.05"
            aria-label="干扰分析影响区域透明度"
            @input="setAnalysisOpacity('area', $event)"
        /></label>
        <label
          ><input
            v-model="analysisLinksVisible"
            type="checkbox"
            aria-label="显示规划后链路"
          />规划链路</label
        >
        <label
          >拓扑透明度<input
            :value="analysisTopologyOpacity"
            type="range"
            min="0"
            max="1"
            step="0.05"
            aria-label="拓扑透明度"
            @input="setAnalysisOpacity('topology', $event)"
        /></label>
      </div>
      <div class="interference-map">
        <MapCanvas
          :stations="[]"
          resource-read
          gis-surface
          :frozen-network="analysis.mapProjection ? null : network"
          :interference-projection="analysis.mapProjection"
          :terrain-basemap="interferenceTerrain"
          :map-caption="interferenceTerrain ? '冻结 DEM 地形' : '未提供该分析来源的可核验地形'"
          :selected-id="analysisNode"
          :selected-link-id="analysisLink"
          :selected-interference-id="analysisSource"
          :show-coverage="analysisAreaVisible"
          :opacity="analysisAreaOpacity"
          :show-links="analysisLinksVisible"
          :topology-opacity="analysisTopologyOpacity"
          @select-frozen-node="mapSelection.node"
          @select-frozen-link="mapSelection.link"
          @select-interference="mapSelection.source"
        />
      </div>
      <div class="analysis-details">
        <p
          v-if="analysis.mapProjection"
          class="muted"
          >{{ analysis.mapProjection.planId }} · {{ analysis.mapProjection.runId }} ·
          {{ analysis.mapProjection.phase === 'PREVIEW' ? '措施预览' : '措施前影响' }}</p
        >
        <p v-if="selectedImpact"
          >SNR {{ selectedImpact.snr_before_db }} dB / SINR {{ selectedImpact.sinr_after_db }} dB ·
          {{ selectedImpact.level }}</p
        >
        <InterferenceAnalysisPanel
          :source-editable="false"
          :task-context="taskContext"
          :selected-node-id="analysisNode"
          :selected-link-id="analysisLink"
          @select-node="analysisNode = $event"
          @select-link="analysisLink = $event"
          @select-source="analysisSource = $event"
        />
      </div>
      <InterferenceHistoryDrawer />
      <InterferenceMeasureDrawer
        @open-plan="openAdoptedPlan"
        @open-planning-job="emit('openJob', $event)"
      />
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import MapCanvas from './MapCanvas.vue';
import InterferenceAnalysisPanel from './InterferenceAnalysisPanel.vue';
import InterferenceHistoryDrawer from './InterferenceHistoryDrawer.vue';
import InterferenceMeasureDrawer from './InterferenceMeasureDrawer.vue';
import { useInterferenceStore } from '../stores/interference';
import { workbenchMapKey } from '../maps/interference-workbench-layers';
import { guardedAnalysisMapSelection } from '../services/gis-analysis-map-selection';
import type { TerrainBasemap } from '../services/terrain-basemap';
import ResourceStatusPanel from './ResourceStatusPanel.vue';
import DeviceMonitoringPanel from './DeviceMonitoringPanel.vue';
import LinkMonitoringPanel from './LinkMonitoringPanel.vue';
import SpectrumMonitoringPanel from './SpectrumMonitoringPanel.vue';
import DeviceConfigurationDrawer from './DeviceConfigurationDrawer.vue';
import { useResourceStatusStore } from '../stores/resource-status';
import { useDeviceConfigurationAcceptanceStore } from '../stores/device-configuration-acceptance';
import { useAuthStore } from '../stores/auth';
import type { GisNetwork, GisPlanOperationServices } from '../types/gis-plan';
import type { FrozenDeviceStatusProjection } from '../stores/monitoring';
import type { ObservationDeviceStatusRefInput } from '../types/observation';
import {
  readObservationStatusHeader,
  selectedObservationStatusRef,
} from '../services/gis-observation-status';
const props = defineProps<{
  network: GisNetwork;
  services: GisPlanOperationServices;
  currentResourceRevision?: string;
  sessionGeneration: number;
  selectedLinkId?: string;
  planVersion?: string;
  terrainBasemap?: TerrainBasemap | null;
  initialTab?: 'devices' | 'interference';
}>();
const emit = defineEmits<{
  selectLink: [id: string];
  selectNode: [id: string];
  analysisMap: [active: boolean];
  openPlan: [value: { taskId: string; planId: string }];
  openJob: [value: { taskId: string; jobId: string }];
}>();
const auth = useAuthStore(),
  status = useResourceStatusStore(),
  config = useDeviceConfigurationAcceptanceStore();
const tabs = [
  { id: 'devices', name: '设备状态' },
  { id: 'links', name: '链路态势' },
  { id: 'spectrum', name: '频谱观测' },
  { id: 'interference', name: '干扰分析' },
] as const;
const tab = ref<'devices' | 'links' | 'spectrum' | 'interference'>(props.initialTab ?? 'devices'),
  selectedDevice = ref(''),
  notice = ref('');
const analysis = useInterferenceStore(),
  analysisAttached = ref(false),
  analysisNode = ref(''),
  analysisLink = ref(''),
  analysisSource = ref('');
const analysisAreaVisible = ref(true),
  analysisAreaOpacity = ref(0.8),
  analysisLinksVisible = ref(true),
  analysisTopologyOpacity = ref(1);
function setAnalysisOpacity(kind: 'area' | 'topology', event: Event) {
  const text = (event.target as HTMLInputElement).value;
  const value = text.trim() ? Number(text) : NaN;
  if (!Number.isFinite(value) || value < 0 || value > 1) return;
  if (kind === 'area') analysisAreaOpacity.value = value;
  else analysisTopologyOpacity.value = value;
}
const analysisMapIdentity = computed(() =>
  analysis.mapProjection
    ? workbenchMapKey(analysis.mapProjection)
    : props.network.identity.snapshot_id,
);
const mapSelection = computed(() =>
  guardedAnalysisMapSelection(
    analysisMapIdentity.value,
    () => analysisMapIdentity.value,
    (kind, id) => {
      if (kind === 'node') {
        analysisNode.value = id;
        analysisLink.value = '';
      } else if (kind === 'link') {
        analysisLink.value = id;
        analysisNode.value = '';
      } else analysisSource.value = id;
    },
    () => analysisLinksVisible.value && analysisTopologyOpacity.value > 0,
  ),
);
watch(analysisMapIdentity, () => {
  analysisNode.value = '';
  analysisLink.value = '';
  analysisSource.value = '';
});
const taskContext = computed(() =>
  props.planVersion && /^V[1-9][0-9]*$/.test(props.planVersion)
    ? {
        taskId: props.network.identity.task_id,
        planId: props.network.identity.plan_id,
        planVersion: props.planVersion,
      }
    : null,
);
const interferenceTerrain = computed(() =>
  !analysis.mapProjection ||
  (analysis.mapProjection.planId === props.network.identity.plan_id &&
    analysis.mapProjection.taskId === props.network.identity.task_id)
    ? props.terrainBasemap
    : null,
);
const selectedImpact = computed(
  () =>
    analysis.filteredImpact?.affected_nodes.find((row) => row.node_id === analysisNode.value) ??
    analysis.filteredImpact?.affected_links.find((row) => row.link_id === analysisLink.value),
);
watch(
  tab,
  (value) => {
    emit('analysisMap', value === 'interference');
    if (value === 'interference') {
      if (!analysisAttached.value) {
        analysis.bindServices({
          workbench: props.services.interferenceWorkbench,
          scenes: props.services.interferenceScenes,
        });
        analysisAttached.value = true;
      }
      analysis.start();
    } else if (analysisAttached.value) analysis.stop();
  },
  { immediate: true },
);
const configurationVisible = ref(false),
  spectrumDirty = ref(false),
  spectrumBusy = ref(false);
const statusPanel = ref<InstanceType<typeof ResourceStatusPanel>>(),
  configurationPanel = ref<InstanceType<typeof DeviceConfigurationDrawer>>();
const statusDirty = ref(false),
  statusBusy = ref(false);
const spectrum = ref<InstanceType<typeof SpectrumMonitoringPanel>>();
const can = (permission: string) =>
  !auth.blocked && !!auth.identity?.permissions.some((value) => String(value) === permission);
const canReadResources = computed(() => can('resources.view') && can('situation.view'));
const canImportStatus = computed(() => can('resources.device.status.import'));
const canConfigure = computed(() => can('resources.device.edit'));
const canImportObservations = computed(() => can('situation.observation.import'));
const sameResource = computed(
  () =>
    !!props.currentResourceRevision &&
    props.currentResourceRevision === props.network.identity.resource_revision,
);
const anchor = computed(() =>
  status.mode === 'observed' &&
  status.batch?.resource_revision === props.network.identity.resource_revision
    ? {
        snapshotId: status.batch.snapshot_id,
        snapshotRevision: status.batch.snapshot_revision,
        resourceRevision: status.batch.resource_revision,
      }
    : null,
);
const projections = computed(() => {
  const result: Record<string, FrozenDeviceStatusProjection> = {};
  for (const device of props.network.devices) {
    const value = status.project(device.id, props.network.identity.resource_revision);
    if (value) result[device.id] = value;
  }
  return result;
});
const statusRefMembers = ref<string[]>([]),
  statusRefBusy = ref(false);
const viewedObservationRef = ref<{
  datasetId: string;
  ref: ObservationDeviceStatusRefInput;
} | null>(null);
const availableStatusMembers = computed(() =>
  Object.keys(projections.value)
    .filter((id) => !!projections.value[id]?.ref)
    .sort(),
);
const observationStatusRef = computed(() =>
  selectedObservationStatusRef(anchor.value, statusRefMembers.value, projections.value),
);
watch(
  () => (anchor.value ? JSON.stringify(anchor.value) : ''),
  () => {
    statusRefMembers.value = [];
    viewedObservationRef.value = null;
  },
);
let statusRefSerial = 0,
  statusRefRead: AbortController | undefined,
  selectingStatusRef = false;
function cancelStatusRefRead() {
  statusRefSerial++;
  statusRefRead?.abort();
  statusRefRead = undefined;
  statusRefBusy.value = false;
  if (selectingStatusRef) {
    selectingStatusRef = false;
    status.cancel();
  }
}
async function viewObservationStatus(input: {
  datasetId: string;
  datasetRevision: string;
  ref: ObservationDeviceStatusRefInput;
}) {
  if (!canReadResources.value || !(await requestLeave())) return;
  cancelStatusRefRead();
  const serial = statusRefSerial,
    owner = props.sessionGeneration,
    identity = props.network.identity.snapshot_id;
  const target = {
    datasetId: input.datasetId,
    ref: { ...input.ref, deviceIds: [...input.ref.deviceIds] },
  };
  const controller = new AbortController();
  statusRefRead = controller;
  statusRefBusy.value = true;
  notice.value = '';
  const current = () =>
    serial === statusRefSerial &&
    owner === props.sessionGeneration &&
    identity === props.network.identity.snapshot_id &&
    !controller.signal.aborted;
  try {
    const header = await readObservationStatusHeader(
      props.services.deviceStatuses,
      target.ref,
      props.network.identity.resource_revision,
      controller.signal,
    );
    if (!header || !current()) return;
    selectingStatusRef = true;
    await status.select(header);
    if (!current()) return;
    if (
      status.batch?.snapshot_id !== target.ref.snapshotId ||
      status.batch.snapshot_revision !== target.ref.snapshotRevision ||
      status.batch.resource_revision !== target.ref.resourceRevision ||
      status.error
    )
      throw new Error(status.error || '冻结状态快照尚未成功读取');
    viewedObservationRef.value = target;
    tab.value = 'devices';
  } catch (reason) {
    if (current()) notice.value = reason instanceof Error ? reason.message : '冻结状态引用读取失败';
  } finally {
    if (serial === statusRefSerial) {
      statusRefBusy.value = false;
      selectingStatusRef = false;
      statusRefRead = undefined;
    }
  }
}
function selectDevice(id: string) {
  if (configurationVisible.value || config.busy) {
    notice.value = '请先处理当前设备配置表单。';
    return;
  }
  const row = props.network.devices.find((device) => device.id === id);
  if (!row) return;
  selectedDevice.value = id;
  emit('selectNode', row.station_id);
}
async function requestLeave() {
  notice.value = '';
  if (
    status.pendingImport ||
    status.busy ||
    (configurationVisible.value && (config.pending || config.busy))
  ) {
    notice.value = '请先完成正在提交的操作，或核实原请求编号。';
    return false;
  }
  if (statusPanel.value && !(await statusPanel.value.requestLeave())) {
    notice.value = '请先处理设备状态导入输入。';
    return false;
  }
  if (configurationPanel.value && !(await configurationPanel.value.requestLeave())) {
    notice.value = '请先处理设备配置输入或原号。';
    return false;
  }
  if (spectrum.value && !(await spectrum.value.requestLeave())) {
    notice.value = '频谱导入尚未处理，当前输入已保留。';
    return false;
  }
  if (analysisAttached.value && !(await analysis.prepareLeave())) {
    notice.value = '请先处理干扰场景草稿或核实原请求。';
    return false;
  }
  return true;
}
async function selectTab(next: typeof tab.value) {
  if (next === tab.value) return;
  if (!(await requestLeave())) return;
  cancelStatusRefRead();
  tab.value = next;
}
watch(
  () => props.initialTab,
  (value) => {
    if (value) void selectTab(value);
  },
);
function openAdoptedPlan(id: string) {
  const value = analysis.adoptions.find(
    (row) => row.state === 'SUCCESS' && row.result_plan_id === id,
  );
  if (value) emit('openPlan', { taskId: value.task_id, planId: id });
  else notice.value = '该采纳尚未生成可打开的真实方案。';
}
// 明确保留原号并关闭后允许离开；未关闭的输入与写等待仍须阻止刷新丢失。
const hasPending = () =>
  statusDirty.value ||
  statusBusy.value ||
  !!status.pendingImport ||
  configurationVisible.value ||
  spectrumDirty.value ||
  spectrumBusy.value ||
  (analysisAttached.value &&
    (analysis.dirty ||
      analysis.busy ||
      !!analysis.pendingScene ||
      !!analysis.pendingWrites.length));
const release = auth.registerLeave(requestLeave, hasPending);
function beforeUnload(event: BeforeUnloadEvent) {
  if (hasPending()) {
    event.preventDefault();
    event.returnValue = '';
  }
}
onMounted(() => window.addEventListener('beforeunload', beforeUnload));
onBeforeUnmount(() => {
  release();
  cancelStatusRefRead();
  status.cancel();
  spectrum.value?.stop();
  if (analysisAttached.value) analysis.stop();
  window.removeEventListener('beforeunload', beforeUnload);
});
defineExpose({ requestLeave });
</script>

<style scoped>
.plan-operations {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding-top: 16px;
  border-top: 1px solid #2a4055;
}
.device-workbench {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.status-members {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  border: 1px solid #2a4055;
  min-width: 0;
}
.status-members label {
  display: flex;
  align-items: center;
  gap: 5px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 10px;
}
label {
  display: grid;
  gap: 6px;
  min-width: 0;
}
select {
  max-width: 100%;
}
.notice {
  overflow-wrap: anywhere;
}
.interference-workbench {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 380px);
  gap: 16px;
  min-width: 0;
}
.interference-map {
  height: 560px;
  min-width: 0;
  overflow: hidden;
  border: 1px solid #2a4055;
  border-radius: 6px;
}
.analysis-controls {
  grid-column: 1 / -1;
}
.interference-map :deep(.map-wrap) {
  height: 100%;
  min-height: 0;
}
.analysis-details {
  min-width: 0;
  max-height: 560px;
  overflow: auto;
  scrollbar-gutter: stable;
}
@media (max-width: 850px) {
  .interference-workbench {
    grid-template-columns: minmax(0, 1fr);
  }
  .interference-map {
    height: 420px;
  }
  .analysis-details {
    max-height: none;
  }
}
</style>
