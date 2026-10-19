<template>
  <div
    v-if="data"
    class="page"
  >
    <div class="page-heading">
      <div>
        <p class="eyebrow">RESOURCE CENTER</p>
        <h1>资源管理</h1>
        <p class="subtitle">统一查看设备实例、节点归属及频谱接口配置</p>
      </div>
      <div
        v-if="tab === '设备台账'"
        class="toolbar"
      >
        <button
          class="btn"
          :disabled="configurationEntry.disabled"
          @click="openConfiguration('', true)"
          >配置记录</button
        >
        <button
          class="btn"
          :disabled="!editor.canEdit || editor.busy"
          @click="importResources"
        >
          <i class="pi pi-upload" />导入</button
        ><button
          class="btn"
          :disabled="!auth.can('resources.view')"
          @click="
            configurationAction(() => {
              exportOpen = true;
            })
          "
        >
          <i class="pi pi-download" />导出</button
        ><button
          class="btn primary"
          :disabled="!editor.canEdit || editor.busy"
          @click="showNewPreview"
        >
          <i class="pi pi-plus" />新增设备
        </button>
      </div>
    </div>
    <p
      v-if="store.notice || editor.message"
      class="notice"
      role="status"
      >{{ editor.message || store.notice }}</p
    ><p
      v-if="editor.error"
      class="notice"
      role="alert"
      >{{ editor.error }}</p
    >
    <div class="stats-grid">
      <div class="stat-card">
        <div>
          <small>设备实例</small><strong class="value">{{ rows.length }}<em>台</em></strong
          ><small>独立设备编号</small>
        </div>
        <i class="pi pi-server stat-icon" />
      </div>
      <div class="stat-card">
        <div>
          <small>站点 / 节点</small
          ><strong class="value">{{ data.resources.stations.length }}<em>个</em></strong
          ><small>一个节点可关联多台设备</small>
        </div>
        <i class="pi pi-map-marker stat-icon" />
      </div>
      <div class="stat-card">
        <div>
          <small>设备型号</small
          ><strong class="value">{{ data.resources.models.length }}<em>类</em></strong
          ><small>原始型号字典</small>
        </div>
        <i class="pi pi-box stat-icon" />
      </div>
      <div class="stat-card">
        <div>
          <small>附加告警</small
          ><strong class="value"
            >{{ rows.filter((r) => (r.statusDisplay ?? r).alert === true).length
            }}<em>台</em></strong
          ><small>{{ observed ? '同步观测；未提供不计作无告警' : '与运行状态分别统计' }}</small>
        </div>
        <i class="pi pi-bell stat-icon" />
      </div>
    </div>
    <div class="split">
      <aside class="panel">
        <div class="panel-head">
          <h3>资源分类</h3>
          <i class="pi pi-filter muted" />
        </div>
        <div class="side-list">
          <button
            v-for="item in ['全部设备', 'HF', 'VUHF']"
            :key="item"
            :class="{ active: category === item }"
            @click="
              switchTab('设备台账').then(() => {
                if (tab === '设备台账') category = item;
              })
            "
          >
            <span class="row-label"
              ><i
                class="pi"
                :class="item === '全部设备' ? 'pi-folder-open' : 'pi-wifi'"
              />{{
                item === 'HF' ? '短波设备 HF' : item === 'VUHF' ? '超短波设备 VUHF' : item
              }}</span
            ><small>{{
              item === '全部设备' ? rows.length : rows.filter((r) => r.deviceClass === item).length
            }}</small>
          </button>
        </div>
        <div class="resource-tip">
          <i class="pi pi-info-circle" />
          <p>按设备实例分类。节点具有 HF / VUHF 双频能力时，仍分别展示其关联设备。</p>
        </div>
      </aside>
      <section class="panel">
        <div class="tabs">
          <button
            v-for="item in ['设备台账', '频谱接口配置']"
            :key="item"
            :class="{ active: tab === item }"
            @click="switchTab(item)"
          >
            {{ item }}
          </button>
        </div>
        <template v-if="tab === '设备台账'">
          <ResourceStatusPanel
            v-if="env.mode === 'mock'"
            context="ledger"
            :enabled="statusEnabled"
            :selected-ids="selectedIds"
            :hidden-count="hiddenCheckedCount" />
          <ResourceLedgerFilters
            v-model:query="query"
            v-model:state="state"
            v-model:availability="availability"
            v-model:alert="alert"
            :observed="observed"
            :frequency="frequencyInput"
            :applied-frequency="frequency"
            :pending="frequencyPending"
            :error="frequencyError"
            :count="filtered.length"
            @update:frequency="updateFrequency"
            @apply="applyFrequency"
            @clear="clearFilters" />
          <p
            v-if="hiddenDetail || hiddenEdit"
            class="filter-retained"
            role="status"
            >当前查看或编辑的设备不在筛选结果中，详情和输入已保留。</p
          >
          <div class="panel-body toolbar">
            <button
              class="btn small"
              @click="selectedIds = filtered.map((r) => r.id)"
              >勾选筛选结果（全部分页）</button
            ><button
              class="btn small"
              @click="selectedIds = []"
              >清空勾选</button
            ><span>已勾选 {{ selectedIds.length }} 台</span
            ><span
              v-if="hiddenCheckedCount"
              class="muted"
              role="status"
              >其中
              {{ hiddenCheckedCount }} 台在筛选结果外；批量操作和按勾选导出仍包含这些设备。</span
            >
            <button
              class="btn small"
              :disabled="!editor.canEdit || editor.busy || !selectedIds.length"
              @click="configurationAvailability([...selectedIds], 'OFF_SHELF')"
              >批量下架</button
            ><button
              class="btn small"
              :disabled="!editor.canEdit || editor.busy || !selectedIds.length"
              @click="configurationAvailability([...selectedIds], 'ACTIVE')"
              >批量恢复</button
            >
          </div>
          <AppTable
            :rows="filtered"
            :columns="columns"
            :selected="selected"
            @select="selectDetail($event.id)"
            ><template #selection="{ row }"
              ><input
                type="checkbox"
                :aria-label="'勾选 ' + row.id"
                :checked="selectedIds.includes(row.id)"
                @click.stop
                @change="toggle(row.id, ($event.target as HTMLInputElement).checked)" /></template
            ><template #availability="{ row }"
              ><span
                class="chip"
                :class="{ amber: row.availability === 'OFF_SHELF' }"
                >{{ row.availability === 'OFF_SHELF' ? '已下架' : '在架' }}</span
              ></template
            ><template #deviceClass="{ row }"
              ><span class="chip blue">{{ row.deviceClass }}</span></template
            ><template #displayedStatus="{ row }"
              ><ResourceStatusBadge
                v-if="row.statusDisplay"
                :value="row.statusDisplay"
                compact /><StatusBadge
                v-else
                :status="row.status"
                :alert="row.alert" /></template
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
        <SpectrumConfigPanel v-else />
      </section>
    </div>
    <AppDrawer
      :visible="
        !!selected &&
        !editor.form &&
        !editor.importOpen &&
        !exportOpen &&
        !configuration.visible &&
        tab === '设备台账'
      "
      title="设备实例详情"
      subtitle="已保存资源参数；保留空值，不推算缺失结果。"
      @update:visible="!$event && selectDetail('')"
      ><template v-if="selected"
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
          :resources="data.resources"
          :catalog="data.deviceDetails"
          :network="deviceNetwork"
          :status-display="selected.statusDisplay"
          :configuration="configurationEntry"
          @configure="openConfiguration(selected!.id, $event)"
        >
          <template #actions>
            <div class="toolbar section-gap"
              ><button
                class="btn"
                :disabled="!editor.canEdit || editor.busy"
                @click="
                  configurationAvailability(
                    [selected!.id],
                    selected!.availability === 'OFF_SHELF' ? 'ACTIVE' : 'OFF_SHELF',
                  )
                "
                >{{ selected.availability === 'OFF_SHELF' ? '恢复上架' : '下架设备' }}</button
              >
              <button
                class="btn"
                :disabled="!editor.canEdit || editor.busy"
                @click="
                  configurationAction(() => editor.openForm('device', selected!.id, 'ledger'))
                "
              >
                编辑设备参数</button
              ><button
                v-if="auth.can('situation.view')"
                class="btn"
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
    <ResourceExportDrawer
      v-model:visible="exportOpen"
      context="ledger"
      :filtered-ids="{ nodes: [], devices: filtered.map((r) => r.id), interference_sources: [] }"
      :selected-ids="{ nodes: [], devices: selectedIds, interference_sources: [] }"
    />
  </div>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed, ref, watch } from 'vue';
import { env } from '../config/env';
import { useResourceStatusStore } from '../stores/resource-status';
import ResourceStatusPanel from '../components/ResourceStatusPanel.vue';
import ResourceStatusBadge from '../components/ResourceStatusBadge.vue';
import { useRouter } from 'vue-router';
import { usePreviewStore } from '../stores/preview';
import { useResourceEditStore } from '../stores/resource-edit';
import { useDeviceConfigurationStore } from '../stores/device-configuration';
import { useUnsavedChangesGuard } from '../composables/useUnsavedChangesGuard';
import AppTable from '../components/AppTable.vue';
import ResourceLedgerFilters from '../components/ResourceLedgerFilters.vue';
import {
  emptyLedgerFrequencyFilter,
  emptyLedgerFrequencyInput,
  matchesLedgerAlert,
  matchesLedgerFrequency,
  parseLedgerFrequency,
} from '../services/resource-ledger-filter';
import type { LedgerAlertFilter, LedgerFrequencyInput } from '../services/resource-ledger-filter';
import AppDrawer from '../components/AppDrawer.vue';
import StatusBadge from '../components/StatusBadge.vue';
import DeviceInfoPanel from '../components/DeviceInfoPanel.vue';
import { createDeviceNetworkContext } from '../services/device-network';
import SpectrumConfigPanel from '../components/SpectrumConfigPanel.vue';
import ResourceExportDrawer from '../components/ResourceExportDrawer.vue';
import { useSpectrumStore } from '../stores/spectrum';
const store = usePreviewStore();
const statusSync = useResourceStatusStore();
const statusEnabled = computed(() => env.mode === 'mock' && auth.can('resources.view'));
const observed = computed(() => statusEnabled.value && statusSync.mode === 'observed');
const editor = useResourceEditStore();
const router = useRouter();
useUnsavedChangesGuard(true);
const spectrum = useSpectrumStore();
const data = computed(() => store.data!);
// 台账只按已保存资源判断关联有效性，未提交的单条表单不会冒充当前网络。
const deviceNetwork = computed(() =>
  createDeviceNetworkContext(data.value.situation, data.value.resources, data.value.resourceMeta),
);
const tab = ref('设备台账');
const configuration = useDeviceConfigurationStore();
const configurationBlocked = computed(
  () =>
    env.mode !== 'mock' ||
    editor.busy ||
    editor.dirty ||
    !!editor.form ||
    editor.importOpen ||
    spectrum.busy ||
    spectrum.dirty ||
    tab.value !== '设备台账',
);
const configurationEntry = computed(() => ({
  editable: auth.can('resources.edit'),
  disabled: configurationBlocked.value || auth.blocked,
  reason: configurationBlocked.value
    ? '请先完成或关闭资源／频谱编辑、导入'
    : '回执独立记录，台账单独保存',
}));
watch(
  () => [
    configuration.visible,
    configuration.context,
    configuration.data,
    configurationBlocked.value,
    data.value?.resourceMeta.revision,
  ],
  () => {
    const source = configuration.data,
      meta = data.value?.resourceMeta;
    // 退出时资源先清空、组件随后卸载，同步监听不能再读取旧来源。
    if (!meta) return;
    const changed =
      !!source &&
      (source.resourceEpoch !== meta.resourceEpoch ||
        source.deviceVersion !== (meta.deviceVersions[source.deviceId] ?? 'initial'));
    configuration.setEligibility(
      'ledger',
      !configurationBlocked.value && !changed,
      changed ? '来源已变化，请重新读取并校验' : configurationEntry.value.reason,
    );
  },
  { flush: 'sync' },
);
// 配置和旧工作区全部允许后才清理，后续取消保留原配置输入。
async function configurationAction(action: () => unknown | Promise<unknown>) {
  const active = configuration.visible,
    session = auth.generation;
  if (active && !(await configuration.leave(true))) return false;
  if (session !== auth.generation || auth.blocked || !auth.can('resources.view')) return false;
  const result = await action();
  if (result === false) return false;
  if (active && session === auth.generation) configuration.clearForSession();
  return true;
}
async function configurationAvailability(ids: string[], availability: 'ACTIVE' | 'OFF_SHELF') {
  return configurationAction(async () => {
    const revision = data.value.resourceMeta.revision;
    await editor.setAvailability(ids, availability);
    // 旧方法没有成功返回值；取消、失败或无变化时保留配置现场。
    return data.value.resourceMeta.revision !== revision;
  });
}
async function openConfiguration(id: string, history = false) {
  if (
    configurationEntry.value.disabled ||
    (id && !data.value.resources.devices.some((d) => d.id === id)) ||
    !auth.can('resources.view')
  )
    return;
  if (await configuration.open('ledger', id, !history && auth.can('resources.edit'))) {
    configuration.setEligibility(
      'ledger',
      !configurationBlocked.value,
      configurationEntry.value.reason,
    );
    if (history) configuration.tab = 'history';
  }
}
const category = ref('全部设备');
const query = ref('');
const state = ref('全部状态');
const alert = ref<LedgerAlertFilter>('ALL');
// 切回基线只解除该来源不支持的条件，保留其他筛选和未提交输入。
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
const frequencyInput = ref(emptyLedgerFrequencyInput()),
  frequency = ref(emptyLedgerFrequencyFilter()),
  frequencyError = ref('');
const parsedFrequency = computed(() => parseLedgerFrequency(frequencyInput.value));
const frequencyPending = computed(
  () =>
    !parsedFrequency.value.ok ||
    JSON.stringify(parsedFrequency.value.value) !== JSON.stringify(frequency.value),
);
// 筛选输入不是资源草稿；只有合法提交才替换正在使用的频率条件。
function updateFrequency(value: LedgerFrequencyInput) {
  frequencyInput.value = value;
  frequencyError.value = '';
}
function applyFrequency() {
  const parsed = parsedFrequency.value;
  if (!parsed.ok) {
    frequencyError.value = parsed.error;
    return;
  }
  frequency.value = parsed.value;
  frequencyError.value = '';
}
function clearFilters() {
  query.value = '';
  category.value = '全部设备';
  state.value = '全部状态';
  availability.value = 'ALL';
  alert.value = 'ALL';
  frequencyInput.value = emptyLedgerFrequencyInput();
  frequency.value = emptyLedgerFrequencyFilter();
  frequencyError.value = '';
}
const detailId = ref('');
const exportOpen = ref(false),
  selectedIds = ref<string[]>([]),
  availability = ref('ALL');
const rows = computed(() =>
  data.value.resources.devices.map((device) => {
    const station = data.value.resources.stations.find((s) => s.id === device.stationId)!;
    const model = data.value.resources.models.find((m) => m.id === device.modelId)!;
    const statusDisplay = statusEnabled.value ? statusSync.display(device) : undefined;
    return {
      ...device,
      statusDisplay,
      // 排序读取当前展示状态；未知观测不回退到台账，原设备状态保持不变。
      displayedStatus: statusDisplay ? (statusDisplay.status ?? 'UNKNOWN') : device.status,
      stationName: station.name,
      modelName: model.name,
      deviceClass: model.deviceClass,
      freqMinKhz: model.freqMinKhz,
      freqMaxKhz: model.freqMaxKhz,
      region: station.region,
    };
  }),
);
const filtered = computed(() =>
  rows.value.filter(
    (row) =>
      (category.value === '全部设备' || row.deviceClass === category.value) &&
      (state.value === '全部状态' ||
        (row.statusDisplay ? (row.statusDisplay.status ?? 'UNKNOWN') : row.status) ===
          state.value) &&
      (availability.value === 'ALL' || row.availability === availability.value) &&
      matchesLedgerAlert(row.statusDisplay ?? row, alert.value) &&
      matchesLedgerFrequency(row, frequency.value) &&
      `${row.id}${row.modelName}${row.stationName}`
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
);
const selected = computed(() => rows.value.find((row) => row.id === detailId.value));
// 被筛选隐藏的勾选、详情和编辑输入仍由原流程持有，不自动截断操作目标。
const filteredIds = computed(() => new Set(filtered.value.map((row) => row.id)));
const hiddenCheckedCount = computed(
  () => selectedIds.value.filter((id) => !filteredIds.value.has(id)).length,
);
const hiddenDetail = computed(() => !!selected.value && !filteredIds.value.has(selected.value.id));
const hiddenEdit = computed(
  () =>
    editor.context === 'ledger' &&
    editor.form?.kind === 'device' &&
    rows.value.some((row) => row.id === editor.form!.id) &&
    !filteredIds.value.has(editor.form.id),
);
// 台账仅保留三项常用排序，公共表格及其他页面的默认规则不变。
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
async function selectDetail(id: string) {
  const active = configuration.visible,
    session = auth.generation;
  if (active && !(await configuration.leave(true))) return;
  if (id !== detailId.value && !(await editor.closeForm())) return;
  if (session !== auth.generation || auth.blocked) return;
  if (active) configuration.clearForSession();
  detailId.value = id;
}
async function showNewPreview() {
  if (configuration.visible) {
    await configurationAction(showNewPreviewWithoutConfiguration);
    return;
  }
  await showNewPreviewWithoutConfiguration();
}
async function showNewPreviewWithoutConfiguration() {
  if (!(await editor.closeForm())) return false;
  detailId.value = '';
  return editor.newForm('device', 'ledger');
}
async function switchTab(value: string) {
  if (tab.value === value) return;
  const active = configuration.visible,
    session = auth.generation;
  if (active && !(await configuration.leave(true))) return;
  if (!(await editor.leave(true)) || !(await spectrum.leave(true))) return;
  if (session !== auth.generation || auth.blocked) return;
  if (active) configuration.clearForSession();
  editor.clearSession();
  spectrum.form = null;
  detailId.value = '';
  tab.value = value;
}
async function importResources() {
  await configurationAction(async () => {
    if (!(await spectrum.leave())) return false;
    detailId.value = '';
    return editor.openImport('ledger');
  });
}
function toggle(id: string, on: boolean) {
  selectedIds.value = on
    ? [...new Set([...selectedIds.value, id])]
    : selectedIds.value.filter((value) => value !== id);
}
function locate() {
  if (!auth.can('situation.view')) return;
  if (selected.value)
    void router.push({
      path: '/situation',
      query: { stationId: selected.value.stationId, deviceId: selected.value.id },
    });
}
</script>
<style scoped>
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
</style>
