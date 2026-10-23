<template>
  <div class="page">
    <div class="page-heading">
      <div class="page-title">
        <!-- 未保存状态迁到标题旁，端口维护和导入也沿用同一状态。 -->
        <h1>资源管理</h1>
        <span
          v-if="editor.dirty"
          class="chip amber"
          role="status"
          >未保存</span
        >
      </div>
      <div
        v-if="tab === '设备台账'"
        class="toolbar"
      >
        <button
          class="btn"
          :disabled="!read.readable || read.refreshing"
          @click="read.refresh()"
          >{{ read.refreshing ? '正在刷新' : '刷新资源' }}</button
        >
        <button
          class="btn"
          :disabled="configurationEntry.disabled"
          @click="openConfiguration('', true)"
          >配置记录</button
        >
        <button
          class="btn"
          :disabled="!editor.canImport || selectionDisabled"
          @click="importResources"
        >
          <i class="pi pi-upload" />导入</button
        ><button
          class="btn"
          :disabled="
            !auth.can('resources.view') || workspace.frozen.value || !workspace.ready.value
          "
          @click="
            configurationAction(() => {
              exportOpen = true;
            })
          "
        >
          <i class="pi pi-download" />导出</button
        ><button
          class="btn primary"
          :disabled="!editor.canCreate || selectionDisabled"
          @click="showNewPreview"
        >
          <i class="pi pi-plus" />新增设备
        </button>
        <details
          v-if="resourceReset && auth.can('resources.reset')"
          class="resource-more"
        >
          <summary class="btn">更多操作</summary>
          <div class="resource-more-panel">
            <button
              class="btn"
              :disabled="resourceReset.disabled.value"
              @click="resourceReset.run()"
              >恢复初始资源</button
            >
          </div>
        </details>
      </div>
    </div>
    <p
      v-if="editor.message"
      class="notice"
      role="status"
      >{{ editor.message }}</p
    ><p
      v-if="editor.error"
      class="notice"
      role="alert"
      >{{ editor.error }}</p
    >
    <ResourceReadStatus v-if="tab === '设备台账'" />
    <!-- 页签属于整个资源工作区，频谱配置不沿用设备目录和统计。 -->
    <div class="tabs resource-tabs">
      <button
        v-for="item in ['设备台账', '规划频点', '频谱接口配置', '频谱观测']"
        :key="item"
        :class="{ active: tab === item }"
        @click="switchTab(item)"
        >{{ item }}</button
      >
      <div
        v-if="tab === '设备台账'"
        class="resource-summary"
        aria-label="资源统计"
        ><span
          >设备 <strong>{{ workspace.counts.value.devices ?? '未提供' }}</strong> 台</span
        ><span
          >节点 <strong>{{ workspace.counts.value.nodes ?? '未提供' }}</strong> 个</span
        ><span
          >型号 <strong>{{ workspace.counts.value.models ?? '未提供' }}</strong> 类</span
        ><span
          >告警 <strong>{{ workspace.counts.value.alerts ?? '未提供' }}</strong> 台</span
        ></div
      >
    </div>
    <div
      v-if="tab === '设备台账'"
      class="split"
    >
      <ResourceLedgerTree
        :category="category"
        :mobility="classification.mobility"
        :counts="workspace.counts.value"
        :disabled="workspace.frozen.value"
        @select="selectCategory"
      />
      <section class="panel">
        <template v-if="workspace.ready.value">
          <ResourceStatusPanel
            ref="statusPanel"
            :services="collaborationHttp.deviceStatuses"
            :enabled="statusEnabled"
            :allow-import="auth.can('resources.device.status.import')"
            :resource-revision="workspace.read.workspace?.revision"
            :total="workspace.counts.value.devices"
            :query-busy="selectionDisabled"
            :selected-ids="selectedIds"
            @snapshot-selected="selectStatusSnapshot"
            @clear-snapshot="statusSnapshot = null"
            @dirty="statusDirty = $event"
            @busy="statusBusy = $event" />
          <ResourceLedgerFilters
            v-model:query="query"
            v-model:state="state"
            v-model:availability="availability"
            v-model:alert="alert"
            :observed="observed"
            :classification="classification"
            :unknown-availability="true"
            :disabled="workspace.frozen.value"
            :category="category"
            :applied-summary="appliedSummary"
            :applied-advanced-count="appliedAdvancedCount"
            :query-pending="queryPending"
            :frequency="frequencyInput"
            :applied-frequency="frequency"
            :pending="frequencyPending"
            :error="frequencyError"
            :count="matchCount"
            @update:classification="classification = $event"
            @update:frequency="updateFrequency"
            @apply="applyFrequency"
            @clear="clearFilters" />
          <p
            v-if="hiddenDetail || hiddenEdit"
            class="filter-retained"
            role="status"
            >当前查看或编辑的设备不在当前页，详情和输入已保留。</p
          >
          <div class="panel-body toolbar">
            <label class="page-selection"
              ><input
                type="checkbox"
                aria-label="全选当前页"
                :checked="allChecked"
                :indeterminate="someChecked"
                :disabled="selectionDisabled || !filtered.length"
                @change="selectPage(($event.target as HTMLInputElement).checked)"
              />全选当前页</label
            ><span>已勾选 {{ selectedIds.length }} 台</span>
            <button
              class="btn small"
              :disabled="!canChangeAvailability || !selectedIds.length"
              @click="configurationAvailability([...selectedIds], 'OFF_SHELF')"
              >批量下架</button
            ><button
              class="btn small"
              :disabled="!canChangeAvailability || !selectedIds.length"
              @click="configurationAvailability([...selectedIds], 'ACTIVE')"
              >批量启用</button
            >
          </div>
          <AppTable
            :inert="selectionDisabled || undefined"
            :rows="filtered"
            :columns="columns"
            :selected="selected"
            :server="true"
            :sortable="false"
            :total="matchCount"
            :page-size="workspace.read.ledger?.pageSize ?? 10"
            :first="
              ((workspace.read.ledger?.pageNum ?? 1) - 1) * (workspace.read.ledger?.pageSize ?? 10)
            "
            :loading="queryBusy"
            @page="pageLedger"
            @select="selectDetail($event.id)"
            ><template #selection="{ row }"
              ><input
                type="checkbox"
                :aria-label="'勾选 ' + row.id"
                :checked="selectedIds.includes(row.id)"
                :disabled="selectionDisabled"
                @click.stop
                @change="toggle(row.id, ($event.target as HTMLInputElement).checked)" /></template
            ><template #availability="{ row }"
              ><span
                class="chip"
                :class="{ amber: row.availability === 'OFF_SHELF' }"
                >{{
                  row.availability === null
                    ? '未提供'
                    : row.availability === 'OFF_SHELF'
                      ? '已下架'
                      : '在架'
                }}</span
              ></template
            ><template #deviceClass="{ row }"
              ><span class="chip blue">{{ row.deviceClass }}</span></template
            ><template #displayedStatus="{ row }"
              ><ResourceStatusBadge
                v-if="row.statusDisplay"
                :value="row.statusDisplay"
                compact
              /><StatusBadge
                v-else
                :status="row.status ?? 'UNKNOWN'"
                :alert="row.alert ?? undefined"
              /><small v-if="row.alert === null">告警未提供</small></template
            ><template #freqMinKhz="{ row }">
              {{
                row.freqMinKhz == null || row.freqMaxKhz == null
                  ? '未提供'
                  : row.freqMinKhz + '–' + row.freqMaxKhz
              }}
            </template>
            <template #workFreqKhz="{ row }">{{ row.workFreqKhz ?? '未提供' }}</template>
            <template #actions="{ row }"
              ><button
                class="text-link"
                @click.stop="selectDetail(row.id)"
              >
                查看详情 <i class="pi pi-angle-right" /></button></template></AppTable
        ></template>
      </section>
    </div>
    <FrequencyResourcePanel
      v-if="frequencyVisited"
      v-show="tab === '规划频点'"
      ref="frequencyPanel"
      :active="tab === '规划频点'"
      :session="frequencySession"
      :services="collaborationHttp.frequencies"
      :load-context="loadFrequencyContext"
      @resource-changed="frequencyChanged"
      @busy-change="frequencyBusy = $event"
      @pending-operation-change="frequencyPendingOperation = $event"
    />
    <SpectrumConfigPanel
      v-if="spectrumVisited"
      v-show="tab === '频谱接口配置'"
      ref="spectrumPanel"
      :services="collaborationHttp.spectrumSources"
      :can-view="auth.can('resources.view') && !auth.blocked"
      :can-edit="auth.can('resources.spectrum.edit') && !auth.blocked"
      :session-generation="sessionGeneration"
      @dirty-change="spectrumDirty = $event"
      @busy-change="spectrumBusy = $event"
      @select-source="selectSpectrumSource"
    />
    <SpectrumMonitoringPanel
      v-if="monitoringVisited"
      v-show="tab === '频谱观测'"
      ref="monitoringPanel"
      :services="collaborationHttp.observations"
      :can-view="auth.can('resources.view') && auth.can('situation.view') && !auth.blocked"
      :can-import="auth.can('situation.observation.import') && !auth.blocked"
      :session-generation="sessionGeneration"
      :initial-selection="observationSelection"
      @dirty-change="monitoringDirty = $event"
      @busy-change="monitoringBusy = $event"
    />
    <SpectrumObservationImportDialog
      ref="observationImport"
      v-model:visible="observationImportOpen"
      :services="collaborationHttp.observations"
      :resource-revision="read.workspace?.revision ?? ''"
      :source-selection="observationSource"
      :can-import="auth.can('resources.view') && auth.can('situation.view') && auth.can('situation.observation.import') && !auth.blocked"
      :session-generation="sessionGeneration"
      @dirty-change="observationDirty = $event"
      @busy-change="observationBusy = $event"
      @committed="observationImported"
    />
    <p v-if="hostMessage" class="notice" role="status">{{ hostMessage }}</p>
    <!-- 台账上下文生效后才展示详情，避免 GIS 遗留选中项瞬时打开空遮罩。 -->
    <AppDrawer
      :visible="
        workspace.read.context === 'ledger' &&
        !!workspace.read.selected &&
        !editor.visible &&
        !editor.importOpen &&
        !exportOpen &&
        !configuration.visible &&
        !configurationHistoryOpen &&
        tab === '设备台账'
      "
      title="设备实例详情"
      subtitle="已保存资源参数；保留空值，不推算缺失结果。"
      @update:visible="!$event && selectDetail('')"
      ><p v-if="workspace.read.pending.detail">正在读取所选设备…</p>
      <p
        v-else-if="workspace.read.errors.detail"
        role="alert"
        >{{ workspace.read.errors.detail
        }}<button
          class="text-link"
          :disabled="workspace.frozen.value"
          @click="workspace.read.selected && selectDetail(workspace.read.selected.id)"
          >重试</button
        ></p
      >
      <template v-else-if="selected"
        ><div class="resource-detail-title">
          <i class="pi pi-server" />
          <div>
            <h2>{{ selected.modelName }}</h2>
            <p class="subtitle">{{ selected.id }}</p>
          </div>
        </div>
        <hr />
        <!-- 与 GIS 使用同一发布知识查询，资源台账仍保持原保存粒度。 -->
        <DeviceInfoPanel
          :device="selected"
          :catalog="workspace.read.detail?.catalog ?? undefined"
          :detail-context="workspace.detailContext.value"
          :network="workspace.read.detail?.network ?? undefined"
          :status-display="selected.statusDisplay"
          :status-snapshot-ref="selectedStatusSnapshot"
          :trace-services="collaborationHttp.deviceTraces"
          :configuration="configurationEntry"
          :maintenance-binding="
            read.workspace && !read.frozen
              ? { context: 'ledger', revision: read.workspace.revision, editable: canEditParameters }
              : undefined
          "
          @ports="openDevicePorts"
          @restore="(value) => configurationAction(() => editor.applyRestore(selected!.id, value))"
          @restore-candidate="restoreCandidate"
          @configure="openConfiguration(selected!.id, $event)"
        >
          <template #actions>
            <div class="toolbar section-gap"
              ><button
                class="btn"
                :disabled="!canChangeAvailability"
                @click="
                  configurationAvailability(
                    [selected!.id],
                    selected!.availability === 'OFF_SHELF' ? 'ACTIVE' : 'OFF_SHELF',
                    true,
                  )
                "
                >{{ selected.availability === 'OFF_SHELF' ? '启用设备' : '下架设备' }}</button
              >
              <button
                class="btn"
                :disabled="!canEditParameters"
                @click="configurationAction(() => editor.openForm(selected!.id))"
              >
                编辑设备参数</button
              ><button
                v-if="auth.can('situation.view')"
                class="btn"
                :disabled="workspace.frozen.value"
                @click="locate"
                ><i class="pi pi-map-marker" />地图定位</button
              >
            </div>
          </template>
        </DeviceInfoPanel> </template
      ><template #footer
        ><p class="readonly-note">参数按设备单条保存，成功后同步台账与 GIS。</p></template
      ></AppDrawer
    >
    <ResourceLedgerExportDrawer
      v-model:visible="exportOpen"
      :revision="workspace.read.workspace?.revision ?? ''"
      :filter="appliedFilter"
      :selected-ids="selectedIds"
    />
    <ResourceLedgerEditDrawer />
    <DevicePortsEditDrawer
      v-if="editor.visible && editor.portsEditing"
      :visible="editor.visible && editor.portsEditing"
      :form="editor.form"
      context="ledger"
      :editable="editor.canEdit"
      :busy="editor.busy"
      :error="editor.error"
      :message="editor.message"
      :issues="editor.issues"
      @ports="editor.form && (editor.form.fields.ports = JSON.stringify($event))"
      @close="editor.closeForm"
      @submit="editor.save"
    />
    <ResourceLedgerImportDrawer />
    <DeviceConfigurationDrawer
      ref="configurationPanel"
      :services="collaborationHttp.deviceConfigurations"
      :visible="configurationOpen"
      :device-id="configurationDeviceId"
      :resource-revision="configurationRevision"
      :editable="auth.can('resources.device.edit') && !auth.blocked"
      :disabled-reason="configurationDisabledReason"
      @close="configurationOpen = false"
    />
    <AppDrawer
      :visible="configurationHistoryOpen"
      title="配置受理历史"
      @update:visible="!$event && closeConfigurationHistory()"
    >
      <p v-if="configurationHistoryBusy" role="status">正在读取配置受理历史…</p>
      <p v-if="configurationHistoryError" role="alert">{{ configurationHistoryError }}</p>
      <button class="btn" :disabled="configurationHistoryBusy" @click="queryConfigurationHistory(1)">刷新历史</button>
      <ul class="configuration-history">
        <li v-for="item in configurationHistory?.items ?? []" :key="item.request_id">
          <button class="text-link" :disabled="configurationHistoryBusy" @click="selectConfigurationHistory(item.request_id)">{{ item.request_id }}</button>
          <small>{{ item.device_id }} · {{ item.base_revision }} · {{ item.accepted_at }} · 系统受理，未下发</small>
        </li>
      </ul>
      <p v-if="configurationHistory && !configurationHistory.total">暂无配置受理记录</p>
      <div v-if="configurationHistory" class="toolbar">
        <button class="btn" :disabled="configurationHistoryBusy || configurationHistory.page <= 1" title="上一页" aria-label="上一页配置历史" @click="queryConfigurationHistory(configurationHistory.page - 1)"><i class="pi pi-chevron-left" /></button>
        <span>{{ configurationHistory.page }} · {{ configurationHistory.total }} 条</span>
        <button class="btn" :disabled="configurationHistoryBusy || configurationHistory.page * configurationHistory.page_size >= configurationHistory.total" title="下一页" aria-label="下一页配置历史" @click="queryConfigurationHistory(configurationHistory.page + 1)"><i class="pi pi-chevron-right" /></button>
      </div>
      <dl v-if="configurationHistoryDetail" class="configuration-history-detail">
        <dt>原请求号</dt><dd>{{ configurationHistoryDetail.request_id }}</dd>
        <dt>设备 / 型号</dt><dd>{{ configurationHistoryDetail.device_id }} / {{ configurationHistoryDetail.model_id }}</dd>
        <dt>历史资源版本</dt><dd>{{ configurationHistoryDetail.base_revision }}</dd>
        <dt>申请功率 / dBm</dt><dd>{{ configurationHistoryDetail.requested_values.tx_power_dbm }}</dd>
        <dt>申请频点 / kHz</dt><dd>{{ configurationHistoryDetail.requested_values.work_freq_khz }}</dd>
        <dt>受理说明</dt><dd>{{ configurationHistoryDetail.message }}</dd>
      </dl>
    </AppDrawer>
    <DecisionDialog
      :request="editor.decision"
      @answer="editor.answer"
    />
  </div>
</template>
<script setup lang="ts">
import { computed, inject, ref, watch, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useResourceLedgerWorkspace } from '../composables/useResourceLedgerWorkspace';
import { useResourceLedgerLeaveGuard } from '../composables/useResourceLedgerLeaveGuard';
import { useResourceLedgerEditStore } from '../stores/resource-ledger-edit';
import { useResourceStatusStore } from '../stores/resource-status';
import { useDeviceConfigurationAcceptanceStore } from '../stores/device-configuration-acceptance';
import { useFrequencyResourceStore } from '../stores/frequency-resource';
import { usePreviewStore } from '../stores/preview';
import { collaborationHttp, httpService } from '../services/http';
import type { FrequencyResourceChange, FrequencyResourceHostContext } from '../types/frequency-resource';
import type { DeviceStatusSnapshotRef } from '../types/device-status-snapshot';
import type { ConfigurationAcceptanceHistory, ConfigurationSystemAcceptance } from '../services/device-configuration-decode';
import type { RestoreProposal } from '../types/device-trace';
import type { ObservationSource, ObservationImportReceipt } from '../types/observation';
import {
  emptyLedgerFrequencyInput,
  emptyLedgerFrequencyFilter,
  parseLedgerFrequency,
  ledgerFrequencySummary,
} from '../services/resource-ledger-filter';
import type { LedgerAlertFilter, LedgerFrequencyInput } from '../services/resource-ledger-filter';
import type { LedgerClassification } from '../types/resource-ledger';
import type { ResourceReadFilter } from '../types/resource-read';
import ResourceLedgerTree from '../components/ResourceLedgerTree.vue';
import ResourceReadStatus from '../components/ResourceReadStatus.vue';
// 仅复用壳层的恢复动作，不在台账页面复制确认和清理流程。
const resourceReset = inject<{
  disabled: { readonly value: boolean };
  run: () => Promise<void>;
} | null>('resourceResetAction', null);
import ResourceStatusPanel from '../components/ResourceStatusPanel.vue';
import ResourceStatusBadge from '../components/ResourceStatusBadge.vue';
import ResourceLedgerFilters from '../components/ResourceLedgerFilters.vue';
import ResourceLedgerEditDrawer from '../components/ResourceLedgerEditDrawer.vue';
import ResourceLedgerImportDrawer from '../components/ResourceLedgerImportDrawer.vue';
import ResourceLedgerExportDrawer from '../components/ResourceLedgerExportDrawer.vue';
import DeviceConfigurationDrawer from '../components/DeviceConfigurationDrawer.vue';
import DevicePortsEditDrawer from '../components/DevicePortsEditDrawer.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import AppTable from '../components/AppTable.vue';
import AppDrawer from '../components/AppDrawer.vue';
import StatusBadge from '../components/StatusBadge.vue';
import DeviceInfoPanel from '../components/DeviceInfoPanel.vue';
import SpectrumConfigPanel from '../components/SpectrumConfigPanel.vue';
import FrequencyResourcePanel from '../components/FrequencyResourcePanel.vue';
import SpectrumMonitoringPanel from '../components/SpectrumMonitoringPanel.vue';
import SpectrumObservationImportDialog from '../components/SpectrumObservationImportDialog.vue';
const auth = useAuthStore(),
  router = useRouter(),
  workspace = useResourceLedgerWorkspace();
const editor = useResourceLedgerEditStore(),
  statusSync = useResourceStatusStore(),
  configuration = useDeviceConfigurationAcceptanceStore(),
  frequencyStore = useFrequencyResourceStore(),
  preview = usePreviewStore();
const read = workspace.read,
  tab = ref('设备台账'),
  exportOpen = ref(false),
  selectedIds = ref<string[]>([]);
const hostMessage = ref('');
const frequencyPanel = ref<InstanceType<typeof FrequencyResourcePanel> | null>(null),
  spectrumPanel = ref<InstanceType<typeof SpectrumConfigPanel> | null>(null),
  statusPanel = ref<InstanceType<typeof ResourceStatusPanel> | null>(null),
  configurationPanel = ref<InstanceType<typeof DeviceConfigurationDrawer> | null>(null),
  monitoringPanel = ref<InstanceType<typeof SpectrumMonitoringPanel> | null>(null),
  observationImport = ref<InstanceType<typeof SpectrumObservationImportDialog> | null>(null);
const frequencyVisited = ref(false), spectrumVisited = ref(false), monitoringVisited = ref(false);
const spectrumDirty = ref(false), spectrumBusy = ref(false), statusDirty = ref(false), statusBusy = ref(false),
  frequencyBusy = ref(false), frequencyPendingOperation = ref(false), monitoringDirty = ref(false), monitoringBusy = ref(false),
  observationDirty = ref(false), observationBusy = ref(false), sourceBusy = ref(false);
const sessionGeneration = computed(() => JSON.stringify([auth.identity?.id, auth.identity?.sessionId, auth.generation]));
const frequencySession = computed<FrequencyResourceHostContext>(() => ({
  accountId: auth.identity?.id ?? '', generation: auth.generation,
  readable: auth.can('resources.view') && !auth.blocked,
  canDisable: auth.can('resources.frequency.disable') && !auth.blocked,
  canMaintain: auth.can('resources.frequency.maintain') && !auth.blocked,
}));
const statusSnapshot = ref<Omit<DeviceStatusSnapshotRef, 'deviceId'> | null>(null);
function selectStatusSnapshot(value: { snapshot_id: string; snapshot_revision: string; resource_revision: string }) {
  statusSnapshot.value = value.resource_revision === read.workspace?.revision
    && value.snapshot_id === statusSync.batch?.snapshot_id && value.snapshot_revision === statusSync.batch?.snapshot_revision
    ? { snapshotId: value.snapshot_id, snapshotRevision: value.snapshot_revision, resourceRevision: value.resource_revision }
    : null;
}
watch(() => statusSync.batch, value => {
  if (!value || value.resource_revision !== read.workspace?.revision) statusSnapshot.value = null;
}, { flush: 'sync' });
const selectedStatusSnapshot = computed<DeviceStatusSnapshotRef | null>(() =>
  observed.value && selected.value && statusSnapshot.value?.resourceRevision === read.workspace?.revision
    && statusSnapshot.value?.snapshotId === statusSync.snapshotId
    && statusSnapshot.value?.snapshotRevision === statusSync.batch?.snapshot_revision
    ? { ...statusSnapshot.value, deviceId: selected.value.id } : null);
const configurationOpen = ref(false), configurationDeviceId = ref(''), configurationRevision = ref(''), configurationDisabledReason = ref('');
const configurationHistoryOpen = ref(false), configurationHistoryBusy = ref(false), configurationHistoryError = ref(''),
  configurationHistoryDevice = ref<string | undefined>(), configurationHistory = ref<ConfigurationAcceptanceHistory | null>(null),
  configurationHistoryDetail = ref<ConfigurationSystemAcceptance | null>(null);
let historySerial = 0, historyControl: AbortController | null = null, sourceSerial = 0, sourceControl: AbortController | null = null;
const observationImportOpen = ref(false), observationSource = ref<ObservationSource | null>(null),
  observationSelection = ref<{ datasetId: string; datasetRevision: string }>();
async function loadFrequencyContext(signal?: AbortSignal) {
  return httpService.loadResourceReadContext({ context: 'ledger', signal });
}
async function frequencyChanged(value: FrequencyResourceChange) {
  if (!value.changed) return;
  const session = auth.generation;
  preview.invalidateResources();
  const refreshed = await read.refresh();
  if (session === auth.generation) hostMessage.value = refreshed
    ? '频点变更已保存，资源已重新读取。' : '频点变更已保存，资源刷新失败，请刷新资源。';
}
const leaveGuard = useResourceLedgerLeaveGuard(() => [
  { dirty: () => statusDirty.value || !!statusSync.pendingImport, busy: () => statusBusy.value,
    leave: () => statusPanel.value?.requestLeave() ?? !statusSync.pendingImport },
  { dirty: () => configuration.dirty || !!configuration.pending, busy: () => configuration.busy,
    leave: leaveConfiguration },
  { dirty: () => spectrumDirty.value, busy: () => spectrumBusy.value,
    leave: () => spectrumPanel.value?.requestLeave() ?? true, clear: () => spectrumPanel.value?.clearForSession() },
  { dirty: () => frequencyPendingOperation.value || !!frequencyStore.pending || !!frequencyStore.selectedIds.length || !!frequencyStore.preview,
    busy: () => frequencyBusy.value,
    leave: () => {
      if (frequencyStore.pending) { hostMessage.value = '请先核实频点原请求；停止读取不会撤销已提交保存。'; return false; }
      return frequencyPanel.value?.requestLeave() ?? true;
    } },
  { dirty: () => monitoringDirty.value, busy: () => monitoringBusy.value,
    leave: () => monitoringPanel.value?.requestLeave() ?? true, clear: () => monitoringPanel.value?.clearForSession() },
  { dirty: () => observationDirty.value, busy: () => observationBusy.value || sourceBusy.value,
    leave: () => observationImport.value?.requestLeave() ?? true, clear: () => observationImport.value?.clearForSession() },
]);
function leaveConfiguration() {
  if (configuration.pending || configuration.dirty || configuration.busy) {
    configuration.notice = '请先核实原请求或明确放弃未提交输入；停止等待不代表取消受理。';
    hostMessage.value = configuration.notice;
    return false;
  }
  const closed = configuration.close();
  if (closed) configurationOpen.value = false;
  return closed;
}
const statusEnabled = computed(
  () => auth.can('resources.view') && !workspace.frozen.value && tab.value === '设备台账',
);
const observed = computed(() => statusSync.mode === 'observed');
const category = ref(read.ledgerQuery.deviceClass ?? '全部设备'),
  query = ref(read.ledgerQuery.search ?? ''),
  state = ref<string>(read.ledgerQuery.status ?? '全部状态');
const availability = ref(read.ledgerQuery.availability ?? 'ALL'),
  alert = ref<LedgerAlertFilter>(read.ledgerQuery.alert ?? 'ALL');
// 基线不提供“状态未提供”选项；来源切换时解除该条件，保留其他筛选。
watch(
  observed,
  (value) => {
    if (!value) {
      if (state.value === 'UNKNOWN') state.value = '全部状态';
      if (alert.value === 'UNKNOWN') alert.value = 'ALL';
    }
  },
  { flush: 'sync' },
);
const classification = ref<LedgerClassification>({
  mobility: read.ledgerQuery.mobility ?? '',
  role: read.ledgerQuery.nodeRole ?? '',
  relay:
    read.ledgerQuery.relayCapable === undefined ? '' : read.ledgerQuery.relayCapable ? 'YES' : 'NO',
});
const frequency = ref<ReturnType<typeof emptyLedgerFrequencyFilter>>({
  ...emptyLedgerFrequencyFilter(),
  mode: 'MODEL',
  ...read.ledgerQuery.frequency,
});
const frequencyInput = ref<LedgerFrequencyInput>({
  ...emptyLedgerFrequencyInput(),
  mode: frequency.value.mode,
  presence: frequency.value.presence,
  min: frequency.value.minKhz?.toString() ?? '',
  max: frequency.value.maxKhz?.toString() ?? '',
});
const frequencyError = ref('');
const parsedFrequency = computed(() => parseLedgerFrequency(frequencyInput.value));
const frequencyPending = computed(
  () =>
    !parsedFrequency.value.ok ||
    JSON.stringify(parsedFrequency.value.value) !== JSON.stringify(frequency.value),
);
function updateFrequency(value: LedgerFrequencyInput) {
  if (!workspace.frozen.value) {
    frequencyInput.value = value;
    frequencyError.value = '';
  }
}
function applyFrequency() {
  if (workspace.frozen.value) return;
  const parsed = parsedFrequency.value;
  if (!parsed.ok) {
    frequencyError.value = parsed.error;
    return;
  }
  frequency.value = parsed.value;
  frequencyError.value = '';
}
function clearFilters() {
  if (workspace.frozen.value) return;
  query.value = '';
  category.value = '全部设备';
  state.value = '全部状态';
  availability.value = 'ALL';
  alert.value = 'ALL';
  classification.value = { mobility: '', role: '', relay: '' };
  frequencyInput.value = { ...emptyLedgerFrequencyInput(), mode: 'MODEL' };
  frequency.value = { ...emptyLedgerFrequencyFilter(), mode: 'MODEL' };
  frequencyError.value = '';
}
// 查询参数在页面只有一份；两种适配器均负责全范围筛选后再分页。
const requestedFilter = computed<ResourceReadFilter>(() => ({
  search: query.value.trim() || undefined,
  deviceClass: category.value === 'HF' || category.value === 'VUHF' ? category.value : undefined,
  status: state.value === '全部状态' ? undefined : (state.value as ResourceReadFilter['status']),
  availability:
    availability.value === 'ALL'
      ? undefined
      : (availability.value as ResourceReadFilter['availability']),
  alert: alert.value === 'ALL' ? undefined : alert.value,
  mobility: classification.value.mobility || undefined,
  nodeRole: classification.value.role || undefined,
  relayCapable: classification.value.relay ? classification.value.relay === 'YES' : undefined,
  frequency:
    frequency.value.minKhz !== null ||
    frequency.value.maxKhz !== null ||
    (frequency.value.mode === 'DEVICE' && frequency.value.presence !== 'ALL')
      ? { ...frequency.value }
      : undefined,
  statusMode: observed.value ? 'observed' : 'baseline',
  observationSnapshotId: observed.value ? statusSync.snapshotId : undefined,
}));
const filterKeys = [
  'search',
  'deviceClass',
  'status',
  'availability',
  'alert',
  'mobility',
  'nodeRole',
  'relayCapable',
  'frequency',
  'statusMode',
  'observationSnapshotId',
] as const;
const appliedFilter = computed<ResourceReadFilter>(() =>
  Object.fromEntries(filterKeys.map((key) => [key, read.ledgerApplied?.[key]])),
);
const queryPending = computed(
  () =>
    !!read.ledgerApplied &&
    JSON.stringify(requestedFilter.value) !==
      JSON.stringify({
        ...appliedFilter.value,
        statusMode: appliedFilter.value.statusMode ?? 'baseline',
      }),
);
const appliedAdvancedCount = computed(() => {
  const f = appliedFilter.value;
  return [f.availability, f.alert, f.nodeRole, f.relayCapable !== undefined, f.frequency].filter(
    Boolean,
  ).length;
});
const labels: Record<string, string> = {
  NORMAL: '正常',
  FAULT: '故障',
  OFFLINE: '离线',
  UNKNOWN: '未提供',
  ACTIVE: '在架',
  OFF_SHELF: '已下架',
  YES: '有告警',
  NO: '无告警',
  FIXED: '固定部署',
  VEHICLE: '车载／移动部署',
  MANPACK: '背负／便携部署',
};
const appliedSummary = computed(() =>
  read.ledgerApplied
    ? [
        read.ledgerApplied.deviceClass ?? '全部设备',
        read.ledgerApplied.mobility ? labels[read.ledgerApplied.mobility] : '',
        read.ledgerApplied.status ? labels[read.ledgerApplied.status] : '全部状态',
        read.ledgerApplied.availability ? labels[read.ledgerApplied.availability] : '',
        read.ledgerApplied.alert ? labels[read.ledgerApplied.alert] : '',
        read.ledgerApplied.nodeRole
          ? ({
              TASK: '任务节点',
              FIXED_STATION: '已有固定站',
              RELAY: '中继站',
              CANDIDATE: '候选部署点',
            }[read.ledgerApplied.nodeRole] ?? read.ledgerApplied.nodeRole)
          : '',
        read.ledgerApplied.relayCapable === undefined
          ? ''
          : read.ledgerApplied.relayCapable
            ? '支持中继'
            : '不支持中继',
        read.ledgerApplied.frequency ? ledgerFrequencySummary(read.ledgerApplied.frequency) : '',
        read.ledgerApplied.search ? '搜索：' + read.ledgerApplied.search : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '暂无成功查询',
);
const filtering = ref(false);
const queryBusy = computed(() => filtering.value || !!read.pending.ledger || read.refreshing);
const selectionDisabled = computed(() => workspace.frozen.value || queryBusy.value || editor.busy);
// 参数维护和上下架使用独立权限，不开放导入、新增或端口维护。
const canEditParameters = computed(() => editor.canEdit && !selectionDisabled.value);
const canMaintain = computed(() => canEditParameters.value && editor.canMaintainAll);
const canChangeAvailability = computed(() => editor.canChangeAvailability && !selectionDisabled.value);
const filtered = computed(() => workspace.rows.value.map(row => {
    const statusDisplay = observed.value && read.ledgerApplied?.observationSnapshotId === statusSync.snapshotId
      ? row.statusDisplay ?? statusSync.display(row) : statusSync.display(row);
    return { ...row, statusDisplay, displayedStatus: statusDisplay.status ?? 'UNKNOWN' };
  })),
  matchCount = computed(() => read.ledger?.total ?? 0);
const pageIds = computed(() => new Set(filtered.value.map((row) => row.id)));
const allChecked = computed(
  () =>
    filtered.value.length > 0 && filtered.value.every((row) => selectedIds.value.includes(row.id)),
);
const someChecked = computed(() => selectedIds.value.length > 0 && !allChecked.value);
function selectPage(checked: boolean) {
  if (!selectionDisabled.value)
    selectedIds.value = checked ? filtered.value.map((row) => row.id) : [];
}
function toggle(id: string, checked: boolean) {
  if (selectionDisabled.value || !pageIds.value.has(id)) return;
  selectedIds.value = checked
    ? [...new Set([...selectedIds.value, id])]
    : selectedIds.value.filter((value) => value !== id);
}
// 在发起分页/筛选/刷新时清空，失败也不恢复旧勾选；迟到的旧行事件不被接纳。
watch(
  () => [read.refreshing, read.refreshKey, read.ledger?.items.map((row) => row.id).join('|')],
  () => {
    selectedIds.value = [];
  },
  { flush: 'sync' },
);
let queryTimer: ReturnType<typeof setTimeout> | undefined;
function queueQuery() {
  selectedIds.value = [];
  clearTimeout(queryTimer);
  read.cancelGroup('ledger');
  if (workspace.frozen.value || !read.workspace) {
    filtering.value = false;
    return;
  }
  filtering.value = true;
  queryTimer = setTimeout(() => {
    filtering.value = false;
    if (!workspace.frozen.value) void read.loadLedger({ ...requestedFilter.value, pageNum: 1 });
  }, 250);
}
watch(requestedFilter, queueQuery, { deep: true });
watch(
  () => workspace.frozen.value,
  (value) => {
    if (value) {
      clearTimeout(queryTimer);
      filtering.value = false;
    } else if (read.workspace && queryPending.value) {
      // 刷新中解除过期观测条件后，补查最新条件，避免保留不可见的旧过滤。
      queueQuery();
    }
  },
);
onBeforeUnmount(() => clearTimeout(queryTimer));
function selectCategory(value: string, mobility: string) {
  if (!workspace.frozen.value) {
    category.value = value;
    classification.value = { ...classification.value, mobility };
  }
}
function pageLedger(input: { first: number; rows: number }) {
  if (selectionDisabled.value) return;
  selectedIds.value = [];
  void read.loadLedger({ pageNum: Math.floor(input.first / input.rows) + 1, pageSize: input.rows });
}
const selected = computed(() => {
  const row = workspace.selected.value;
  if (!row) return null;
  const statusDisplay = observed.value && read.ledgerApplied?.observationSnapshotId === statusSync.snapshotId
    ? row.statusDisplay ?? filtered.value.find(d => d.id === row.id)?.statusDisplay ?? statusSync.display(row)
    : statusSync.display(row);
  return { ...row, statusDisplay };
});
const hiddenDetail = computed(() => !!selected.value && !pageIds.value.has(selected.value.id));
const hiddenEdit = computed(
  () => !!editor.form && !editor.form.creating && !pageIds.value.has(editor.form.id),
);
const configurationBlocked = computed(
  () =>
    workspace.frozen.value ||
    editor.busy ||
    editor.dirty ||
    editor.visible ||
    editor.importOpen ||
    spectrumBusy.value ||
    spectrumDirty.value ||
    tab.value !== '设备台账',
);
const configurationEntry = computed(() => ({
  editable: auth.can('resources.device.edit'),
  disabled: configurationBlocked.value || auth.blocked || !auth.can('resources.view'),
  reason: configurationBlocked.value
    ? '请先完成或关闭资源／频谱编辑、导入'
    : '回执独立记录，台账单独保存',
}));
watch(
  () => [configuration.visible, read.workspace?.revision],
  () => {
    if (configuration.visible && configuration.target && configuration.target.resourceRevision !== read.workspace?.revision) {
      configuration.target.editable = false;
      configuration.target.disabledReason = '来源已变化，请先处理原请求和输入，再重新打开配置。';
    }
  },
  { flush: 'sync' },
);
async function configurationAction(action: () => unknown | Promise<unknown>) {
  if (workspace.frozen.value) return false;
  const session = auth.generation;
  if (!(await statusPanel.value?.requestLeave() ?? true) || !leaveConfiguration()) return false;
  if (session !== auth.generation || auth.blocked) return false;
  const result = await action();
  if (session !== auth.generation || auth.blocked) return false;
  if (result === false) return false;
  return true;
}
async function configurationAvailability(
  ids: string[],
  availability: 'ACTIVE' | 'OFF_SHELF',
  detail = false,
) {
  if (!canChangeAvailability.value) return false;
  return configurationAction(
    async () => (await editor.setAvailability(ids, availability, detail)) && editor.lastChanged,
  );
}
async function openConfiguration(id: string, history = false) {
  if (configurationEntry.value.disabled || !auth.can('resources.view')) return;
  if (!configuration.visible && configuration.pending) {
    configurationDeviceId.value = configuration.pending.device_id;
    configurationRevision.value = configuration.pending.base_revision;
    configurationDisabledReason.value = '请先核实保留的原请求。';
    configurationOpen.value = true;
    return;
  }
  if (!leaveConfiguration()) return;
  if (history) {
    configurationHistoryDevice.value = id || undefined;
    configurationHistory.value = null;
    configurationHistoryDetail.value = null;
    configurationHistoryOpen.value = true;
    await queryConfigurationHistory(1);
    return;
  }
  if (!id || !read.workspace) { hostMessage.value = '请先选择当前资源版本中的设备。'; return; }
  closeConfigurationHistory();
  configurationDeviceId.value = id;
  configurationRevision.value = read.workspace.revision;
  configurationDisabledReason.value = auth.can('resources.device.edit') ? '' : '无设备配置维护权限，仅可读取。';
  configurationOpen.value = true;
}
async function configurationHistoryRead(operation: (signal: AbortSignal, current: () => boolean) => Promise<void>) {
  historyControl?.abort();
  const token = ++historySerial, session = auth.generation;
  historyControl = new AbortController(); configurationHistoryBusy.value = true; configurationHistoryError.value = '';
  const current = () => token === historySerial && session === auth.generation && configurationHistoryOpen.value && !auth.blocked;
  try { await operation(historyControl.signal, current); }
  catch (reason) { if (current()) configurationHistoryError.value = reason instanceof Error ? reason.message : '配置历史读取失败'; }
  finally { if (token === historySerial) { configurationHistoryBusy.value = false; historyControl = null; } }
}
async function queryConfigurationHistory(page = 1) {
  if (!auth.can('resources.view') || auth.blocked) return;
  const device = configurationHistoryDevice.value;
  await configurationHistoryRead(async (signal, current) => {
    const value = await collaborationHttp.deviceConfigurations.queryHistory({ context: 'ledger', ...(device ? { device_id: device } : {}), page, page_size: 20 }, { signal });
    if (current()) configurationHistory.value = value;
  });
}
async function selectConfigurationHistory(requestId: string) {
  const account = auth.identity?.id;
  configurationHistoryDetail.value = null;
  await configurationHistoryRead(async (signal, current) => {
    const value = await collaborationHttp.deviceConfigurations.getRequest({ context: 'ledger', request_id: requestId }, { signal });
    if (!current()) return;
    if (value.actor.account_id !== account || configurationHistoryDevice.value && value.device_id !== configurationHistoryDevice.value)
      throw new Error('配置历史归属不符，未关联当前设备。');
    configurationHistoryDetail.value = value;
  });
}
function closeConfigurationHistory() {
  historySerial++; historyControl?.abort(); historyControl = null;
  configurationHistoryBusy.value = false; configurationHistoryOpen.value = false;
}
async function restoreCandidate(value: RestoreProposal) {
  const id = selected.value?.id, session = auth.generation;
  if (!id || !value.compatible || value.device_id !== id || value.base_revision !== read.workspace?.revision || !auth.can('resources.device.edit')) {
    hostMessage.value = '恢复候选与当前设备或资源版本不符，未写入参数。'; return;
  }
  await configurationAction(async () => {
    if (!await editor.openForm(id) || session !== auth.generation || value.base_revision !== read.workspace?.revision
      || editor.context?.device?.modelId !== value.model_id || !editor.form || editor.form.id !== id) return false;
    const fields = { tx_power_dbm: 'txPowerDbm', work_freq_khz: 'workFreqKhz', antenna_height_m: 'antennaHeightM' } as const;
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const candidate = value.patch[key];
      if (candidate !== undefined) editor.form.fields[fields[key]] = String(candidate);
    }
    hostMessage.value = '三参数恢复候选已载入，请核对后保存设备参数。';
    return true;
  });
}
function openDevicePorts() {
  if (!canMaintain.value) { hostMessage.value = '当前仅开放设备三参数维护，端口与模式接口待确认。'; return; }
  if (selected.value) void configurationAction(() => editor.openPorts(selected.value!.id));
}
async function selectDetail(id: string) {
  if (!id) {
    read.closeDetail();
    return;
  }
  if (workspace.frozen.value || !(await configurationAction(() => editor.closeForm()))) return;
  await read.selectObject('device', id);
}
async function showNewPreview() {
  if (editor.canCreate && !selectionDisabled.value)
    await configurationAction(async () => {
      const opened = await editor.openForm();
      if (opened) read.closeDetail();
      return opened;
    });
}
async function importResources() {
  if (editor.canImport && !selectionDisabled.value)
    await configurationAction(async () => {
      const opened = await editor.openImport();
      if (opened) read.closeDetail();
      return opened;
    });
}
async function switchTab(value: string) {
  if (value === tab.value) return;
  const session = auth.generation;
  if (!(await leaveGuard.leave(true)) || session !== auth.generation || auth.blocked)
    return;
  editor.clearForSession();
  closeConfigurationHistory();
  spectrumPanel.value?.stop();
  monitoringPanel.value?.stop();
  observationImport.value?.clearForSession();
  observationImportOpen.value = false;
  read.closeDetail();
  if (value === '规划频点') frequencyVisited.value = true;
  if (value === '频谱接口配置') spectrumVisited.value = true;
  if (value === '频谱观测') monitoringVisited.value = true;
  tab.value = value;
}
async function selectSpectrumSource(value: { sourceId: string; configRevision: string }) {
  if (!auth.can('situation.view') || !auth.can('situation.observation.import')) {
    hostMessage.value = '当前身份无频谱观测导入权限。'; return;
  }
  const session = auth.generation;
  if (!(await leaveGuard.leave(true)) || session !== auth.generation) return;
  sourceControl?.abort(); sourceControl = new AbortController();
  const token = ++sourceSerial; sourceBusy.value = true; hostMessage.value = '';
  try {
    const source = await collaborationHttp.spectrumSources.getSource({ ...value, signal: sourceControl.signal });
    if (token !== sourceSerial || session !== auth.generation || auth.blocked) return;
    if (source.sourceId !== value.sourceId || source.configRevision !== value.configRevision) throw new Error('采集源版本不符');
    if (source.draft.minKhz === null || source.draft.maxKhz === null) {
      hostMessage.value = '所选采集源未声明完整频段，请先补充来源配置。'; return;
    }
    observationSource.value = { sourceId: source.sourceId, configRevision: source.configRevision, name: source.draft.name,
      minKhz: source.draft.minKhz, maxKhz: source.draft.maxKhz, intervalSeconds: source.draft.intervalSeconds };
    observationImportOpen.value = true;
  } catch (reason) { if (token === sourceSerial && session === auth.generation) hostMessage.value = reason instanceof Error ? reason.message : '采集源读取失败'; }
  finally { if (token === sourceSerial) { sourceBusy.value = false; sourceControl = null; } }
}
function observationImported(value: ObservationImportReceipt) {
  observationSelection.value = { datasetId: value.datasetId, datasetRevision: value.datasetRevision };
  hostMessage.value = '观测集已持久化，可在频谱观测页查看历史帧。';
}
watch(sessionGeneration, () => {
  closeConfigurationHistory(); sourceSerial++; sourceControl?.abort(); sourceControl = null; sourceBusy.value = false;
  configurationOpen.value = false; observationImportOpen.value = false; observationSource.value = null;
  observationSelection.value = undefined; statusSnapshot.value = null; hostMessage.value = '';
}, { flush: 'sync' });
onBeforeUnmount(() => { closeConfigurationHistory(); sourceSerial++; sourceControl?.abort(); });
function locate() {
  if (selected.value && auth.can('situation.view') && !workspace.frozen.value)
    void router.push({
      path: '/situation',
      query: { stationId: selected.value.stationId, deviceId: selected.value.id },
    });
}
// 台账保留服务返回顺序，统一关闭表头排序。
const columns = [
  { field: 'selection', header: '勾选', sortable: false },
  { field: 'availability', header: '在架状态', sortable: false },
  { field: 'id', header: '设备编号' },
  { field: 'modelName', header: '设备型号', sortable: false },
  { field: 'deviceClass', header: '类别', sortable: false },
  { field: 'stationName', header: '所属节点', sortable: false },
  { field: 'region', header: '部署区域', sortable: false },
  { field: 'displayedStatus', header: '运行状态' },
  { field: 'freqMinKhz', header: '型号支持频段（kHz）', sortable: false },
  { field: 'workFreqKhz', header: '设备工作频点（kHz）' },
];
</script>
<style scoped>
.resource-tabs {
  margin-bottom: 18px;
  align-items: center;
  flex-wrap: wrap;
}
.resource-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-left: auto;
  padding: 8px 0;
  color: var(--muted);
  font-size: 12px;
}
.resource-summary strong {
  color: var(--text);
  font-size: 15px;
}
.page-selection {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
  cursor: pointer;
}
.page-selection input {
  width: auto;
}
.split {
  grid-template-columns: 260px minmax(0, 1fr);
}
@media (max-width: 800px) {
  /* 小屏顺序排列，不能把业务区压进侧栏右边的窄缝。 */
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}
.filter-retained {
  margin: 0;
  padding: 0 18px 12px;
  color: #b4d5ed;
  font-size: 12px;
  line-height: 1.7;
}
.resource-tip {
  margin: 15px;
  padding: 15px 10px;
  border-top: 1px solid var(--line);
  color: #738fae;
  line-height: 1.8;
  font-size: 11px;
}
.resource-tip .pi {
  margin-bottom: 10px;
  color: #5486b4;
}
.spectrum-card {
  display: grid;
  grid-template-columns: 1fr 1.2fr auto;
  gap: 25px;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 24px;
  margin-top: 18px;
}
.spectrum-card h3 .pi {
  margin-right: 9px;
  color: var(--blue);
}
.resource-detail-title {
  display: flex;
  gap: 15px;
  align-items: center;
}
.resource-detail-title > .pi {
  font-size: 25px;
  color: var(--blue);
  padding: 17px;
  background: #153250;
  border-radius: 9px;
}
.configuration-history { padding-left: 18px; }
.configuration-history li { margin: 12px 0; overflow-wrap: anywhere; }
.configuration-history small { display: block; margin-top: 4px; }
.configuration-history-detail dd { margin: 4px 0 12px; overflow-wrap: anywhere; }
</style>
