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
          @click="chooseFilter(item)"
          >{{ item }}</button
        ></div
      >
    </div>
    <!-- 低高度窗口分类和目录连续滚动，避免固定控件把设备区挤成一行。 -->
    <div class="tree-content">
      <div
        class="browse-switch"
        aria-label="资源浏览方式"
      >
        <button
          :class="{ active: browse === 'devices' }"
          @click="emit('update:browse', 'devices')"
          >按设备分类</button
        >
        <button
          :class="{ active: browse === 'stations' }"
          @click="emit('update:browse', 'stations')"
          >按站点浏览</button
        >
      </div>
      <nav
        class="category-nav"
        aria-label="资源类型"
      >
        <button
          v-for="item in categories"
          :key="item.id"
          :class="{ active: category === item.id }"
          @click="chooseCategory(item.id)"
          >{{ item.label }}
          <span v-if="item.id !== 'all'">{{ item.count ?? '未提供' }}</span></button
        >
      </nav>
      <details class="classification-tools">
        <summary>分类筛选</summary>
        <label
          >部署方式<select
            :value="classification.mobility"
            :disabled="disabled"
            @change="classify('mobility', $event)"
            ><option value="">全部</option
            ><option value="FIXED">固定</option
            ><option value="VEHICLE">车载／移动</option
            ><option value="MANPACK">背负／便携</option></select
          ></label
        >
        <label
          >节点角色<select
            :value="classification.role"
            :disabled="disabled"
            @change="classify('role', $event)"
            ><option value="">全部</option
            ><option value="TASK">任务节点</option
            ><option value="FIXED_STATION">固定台站角色</option
            ><option value="RELAY">中继角色</option
            ><option value="CANDIDATE">候选角色</option></select
          ></label
        >
        <label
          >中继能力<select
            :value="classification.relay"
            :disabled="disabled"
            @change="classify('relay', $event)"
            ><option value="">全部</option
            ><option value="YES">支持</option
            ><option value="NO">不支持</option></select
          ></label
        >
      </details>
      <div class="tree-summary"
        ><i class="pi pi-folder-open" />区域通信网络
        <span>{{ tree.stations.length + ' 节点 / ' + tree.devices.length + ' 设备' }}</span></div
      >
      <div class="tree-scroll">
        <p
          v-if="!ready"
          class="empty-inline"
          >资源目录尚未就绪，请等待加载或刷新重试。</p
        >
        <template v-else>
          <p
            v-if="clusterId"
            class="empty-inline"
            >聚合成员</p
          >
          <template v-if="browse === 'devices' && ['all', 'HF', 'VUHF'].includes(category)">
            <details
              v-for="group in deviceGroups"
              :key="group.id"
              class="device-group"
              :open="deviceExpanded[group.id]"
              @toggle="deviceExpanded[group.id] = ($event.currentTarget as HTMLDetailsElement).open"
            >
              <summary>{{ group.label }}（{{ group.total ?? '未提供' }} 台）</summary>
              <details
                v-for="deployment in deployments.filter((row) =>
                  group.devices.some((device) => mobilityOf(device) === row.id),
                )"
                :key="deployment.id"
                :open="!!query"
              >
                <summary
                  >{{ deployment.label }}（{{
                    group.devices.filter((device) => mobilityOf(device) === deployment.id).length
                  }}
                  台）</summary
                >
                <button
                  v-for="device in group.devices.filter(
                    (device) => mobilityOf(device) === deployment.id,
                  )"
                  :key="device.id"
                  class="station-item"
                  :class="{ selected: selectedDeviceId === device.id }"
                  :aria-label="'选择设备 ' + device.id"
                  :disabled="disabled"
                  @click="emit('selectDevice', device.id)"
                  ><span class="station-copy"
                    ><strong>{{ device.id }} · {{ modelName(device.modelId) }}</strong
                    ><small
                      >{{ stationName(device.stationId)
                      }}<span>{{
                        device.availability === null
                          ? '上下架未提供'
                          : device.availability === 'OFF_SHELF'
                            ? '已下架'
                            : '在架'
                      }}</span></small
                    ></span
                  ></button
                >
              </details>
            </details>
          </template>
          <template v-if="browse === 'stations' && ['all', 'HF', 'VUHF'].includes(category)">
            <template
              v-for="row in stationRows"
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
                      stationEquipmentLabel(resources, row.station.id) ||
                      row.station.classes.join(' / ')
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
                  >{{ device.id }} ·
                  {{ device.availability === 'OFF_SHELF' ? '已下架' : '在架' }}</button
                >
              </div>
            </template>
          </template>
          <div
            v-if="
              !(browse === 'devices' ? directoryDevices.length : stationRows.length) &&
              ['all', 'HF', 'VUHF'].includes(category)
            "
            class="empty-inline"
            >未找到匹配节点或设备</div
          >
          <!-- 仅设备分类使用折叠组；站点浏览继续保持原有列表。 -->
          <component
            :is="browse === 'devices' ? 'details' : 'section'"
            v-if="category === 'all' || category === 'links'"
            class="resource-group"
            data-group="links"
            :open="browse === 'devices' ? resourceExpanded.links : undefined"
            @toggle="resourceExpanded.links = ($event.currentTarget as HTMLDetailsElement).open"
          >
            <component
              :is="browse === 'devices' ? 'summary' : 'div'"
              class="tree-summary"
              >规划后链路 <span>{{ tree.linkRows.length }} 条</span></component
            >
            <button
              v-for="row in tree.linkRows.slice((linkPage - 1) * 10, linkPage * 10)"
              :key="row.link.id"
              class="link-item"
              :aria-label="'选择链路 ' + row.link.id"
              :class="{ selected: selectedLinkId === row.link.id }"
              :disabled="disabled || !row.available"
              @click="emit('selectLink', row.link.id)"
            >
              <strong
                >{{ row.link.id }} · {{ row.link.deviceClass }} ·
                {{ linkStates[row.link.state] }}</strong
              >
              <span>{{ row.endpointLabel }}</span
              ><small v-if="row.reason">{{ row.reason }}</small>
            </button>
            <div
              v-if="tree.linkRows.length > 10"
              class="pager"
              ><button
                :disabled="linkPage <= 1"
                @click="linkPage--"
                >上页</button
              ><span>第 {{ linkPage }} 页</span
              ><button
                :disabled="linkPage * 10 >= tree.linkRows.length"
                @click="linkPage++"
                >下页</button
              ></div
            >
            <div
              v-if="!tree.linkRows.length"
              class="empty-inline"
              >未找到匹配规划链路</div
            >
          </component>
          <!-- 仅设备分类使用折叠组；站点浏览继续保持原有列表。 -->
          <component
            :is="browse === 'devices' ? 'details' : 'section'"
            v-if="category === 'all' || category === 'candidates'"
            class="resource-group"
            data-group="candidates"
            :open="browse === 'devices' ? resourceExpanded.candidates : undefined"
            @toggle="
              resourceExpanded.candidates = ($event.currentTarget as HTMLDetailsElement).open
            "
          >
            <!-- 候选与正式链路使用不同事件；参考质量不作为运行状态标签。 -->
            <component
              :is="browse === 'devices' ? 'summary' : 'div'"
              class="tree-summary"
              >候选链路
              <span
                >{{ resources.candidateLinks ? tree.candidateRows.length : '未提供' }} 条</span
              ></component
            >
            <button
              v-for="row in tree.candidateRows.slice((candidatePage - 1) * 10, candidatePage * 10)"
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
              v-if="tree.candidateRows.length > 10"
              class="pager"
              ><button
                :disabled="candidatePage <= 1"
                @click="candidatePage--"
                >上页</button
              ><span>第 {{ candidatePage }} 页</span
              ><button
                :disabled="candidatePage * 10 >= tree.candidateRows.length"
                @click="candidatePage++"
                >下页</button
              ></div
            >
            <div
              v-if="!tree.candidateRows.length"
              class="empty-inline"
              >未找到匹配候选链路</div
            >
          </component>
          <!-- 仅设备分类使用折叠组；站点浏览继续保持原有列表。 -->
          <component
            :is="browse === 'devices' ? 'details' : 'section'"
            v-if="category === 'all' || category === 'interferences'"
            class="resource-group"
            data-group="interferences"
            :open="browse === 'devices' ? resourceExpanded.interferences : undefined"
            @toggle="
              resourceExpanded.interferences = ($event.currentTarget as HTMLDetailsElement).open
            "
          >
            <component
              :is="browse === 'devices' ? 'summary' : 'div'"
              class="tree-summary"
              >干扰源
              <span
                >{{ resources.interferences ? tree.interferences.length : '未提供' }} 个</span
              ></component
            >
            <!-- 分析入口归属干扰源区域，保留多源选择能力。 -->
            <button
              v-if="analysisAvailable"
              class="btn small"
              :disabled="disabled"
              @click="emit('analyze')"
              >干扰分析</button
            >
            <button
              v-for="source in directoryInterferences"
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
          </component>
        </template>
      </div>
    </div>
    <div class="tree-footer"
      >全库 {{ totalNodes ?? '未提供' }} 个节点 / {{ totalDevices ?? '未提供' }} 台设备</div
    >
  </div>
</template>
<script setup lang="ts">
import type { GisResourceFilter, GisResourceTree } from '../services/gis-resource-tree';
import type { GisResourceIndex, GisDeviceReference } from '../types/gis-workspace';
import { resourceOrigins } from '../config/resource-options';
import { stationEquipmentLabel } from '../services/resource-display';
import { computed, ref, watch } from 'vue';
import type { GisBrowse, GisCategory, GisClassification, GisCounts } from '../types/gis-workspace';

const props = withDefaults(
  defineProps<{
    tree: GisResourceTree;
    resources: GisResourceIndex;
    ready?: boolean;
    query: string;
    filter: GisResourceFilter;
    selectedId: string;
    selectedDeviceId: string;
    selectedLinkId: string;
    selectedInterferenceId: string;
    selectedCandidateLinkId?: string;
    candidateDisabled?: boolean;
    totalLinks?: number | null;
    totalNodes: number | null;
    totalDevices: number | null;
    disabled: boolean;
    browse?: GisBrowse;
    category?: GisCategory;
    classification?: GisClassification;
    clusterId?: string;
    counts?: GisCounts;
    analysisAvailable?: boolean;
  }>(),
  {
    ready: true,
    browse: 'devices',
    category: 'all',
    classification: () => ({ mobility: '', role: '', relay: '' }),
  },
);
const emit = defineEmits<{
  'update:query': [value: string];
  'update:filter': [value: GisResourceFilter];
  selectStation: [id: string];
  selectDevice: [id: string];
  selectLink: [id: string];
  selectInterference: [id: string];
  selectCandidateLink: [id: string];
  'update:browse': [value: GisBrowse];
  'update:category': [value: GisCategory];
  'update:classification': [value: GisClassification];
  analyze: [];
}>();
// 展开状态跟随原生 toggle；再次点击当前类型也能重新展开，不写入业务工作区。
// 频段一级默认展开；原生折叠保留手动选择，搜索和类型入口仍能主动展开。
const linkPage = ref(1),
  candidatePage = ref(1);
watch(
  () => [props.query, props.category, props.filter, props.classification],
  () => {
    linkPage.value = 1;
    candidatePage.value = 1;
  },
);
watch(
  () => props.selectedCandidateLinkId,
  (id) => {
    const index = props.tree.candidateRows.findIndex((row) => row.link.id === id);
    if (index >= 0) candidatePage.value = Math.floor(index / 10) + 1;
  },
);
const deviceExpanded = ref<Record<string, boolean>>({ HF: true, VUHF: true });
watch(
  () => [props.query, props.category],
  () => {
    if (props.query) deviceExpanded.value = { HF: true, VUHF: true };
    else if (props.category === 'HF' || props.category === 'VUHF')
      deviceExpanded.value[props.category] = true;
  },
);
const resourceExpanded = ref({ links: false, candidates: false, interferences: false });
watch(
  () => [
    props.category,
    props.query,
    props.tree.linkRows.length,
    props.tree.candidateRows.length,
    props.tree.interferences.length,
  ],
  () => {
    const searching = !!props.query.trim();
    resourceExpanded.value = {
      links: props.category === 'links' || (searching && props.tree.linkRows.length > 0),
      candidates:
        props.category === 'candidates' || (searching && props.tree.candidateRows.length > 0),
      interferences:
        props.category === 'interferences' || (searching && props.tree.interferences.length > 0),
    };
  },
  { immediate: true },
);
const categories = computed(() => [
  { id: 'all' as const, label: '全部类型', count: null },
  {
    id: 'HF' as const,
    label: '短波设备',
    count:
      props.counts?.hf ??
      props.resources.devices.filter(
        (device) =>
          props.resources.models.find((model) => model.id === device.modelId)?.deviceClass === 'HF',
      ).length,
  },
  {
    id: 'VUHF' as const,
    label: '超短波设备',
    count:
      props.counts?.vuhf ??
      props.resources.devices.filter(
        (device) =>
          props.resources.models.find((model) => model.id === device.modelId)?.deviceClass ===
          'VUHF',
      ).length,
  },
  {
    id: 'links' as const,
    label: '规划后链路',
    count: props.totalLinks ?? null,
  },
  {
    id: 'candidates' as const,
    label: '候选链路',
    count: props.resources.candidateLinks?.length ?? null,
  },
  {
    id: 'interferences' as const,
    label: '干扰源',
    count: props.counts?.interferences ?? props.resources.interferences?.length ?? 0,
  },
]);
// 空分组不占目录空间；有真实缺失部署的数据时仍保留未知分组。
const deployments = [
  { id: 'FIXED', label: '固定部署' },
  { id: 'VEHICLE', label: '车载／移动部署' },
  { id: 'MANPACK', label: '背负／便携部署' },
  { id: 'UNKNOWN', label: '部署方式未提供' },
];
// 设备分类基于同一完整轻目录，空分类不伪造设备。
const directoryDevices = computed(() => props.tree.devices);
const stationRows = computed(() => props.tree.stationRows);
const directoryInterferences = computed(() => props.tree.interferences);
const mobilityOf = (device: GisDeviceReference) =>
  props.resources.stations.find((station) => station.id === device.stationId)?.mobility ||
  'UNKNOWN';
const stationName = (id: string) =>
  props.resources.stations.find((station) => station.id === id)?.name ?? id;
const modelName = (id: string) =>
  props.resources.models.find((model) => model.id === id)?.name ?? id;
const deviceGroups = computed(() =>
  ['HF', 'VUHF']
    .filter((id) => props.category === 'all' || props.category === id)
    .map((id) => ({
      id,
      label: id === 'HF' ? '短波设备' : '超短波设备',
      total: directoryDevices.value.filter(
        (device) =>
          props.resources.models.find((model) => model.id === device.modelId)?.deviceClass === id,
      ).length,
      devices: directoryDevices.value.filter(
        (device) =>
          props.resources.models.find((model) => model.id === device.modelId)?.deviceClass === id,
      ),
    })),
);
// 顶部快捷筛选与类型导航共用条件，避免两个频段条件互相抵消。
function chooseFilter(value: GisResourceFilter) {
  if (value === 'HF' || value === 'VUHF') deviceExpanded.value[value] = true;
  emit('update:filter', value);
  emit('update:category', value === 'HF' || value === 'VUHF' ? value : 'all');
}
function chooseCategory(value: GisCategory) {
  if (value === 'HF' || value === 'VUHF') deviceExpanded.value[value] = true;
  if (value === 'links' || value === 'candidates' || value === 'interferences')
    resourceExpanded.value[value] = true;
  emit('update:category', value);
  emit('update:filter', value === 'HF' || value === 'VUHF' ? value : '全部');
}
function classify(key: keyof GisClassification, event: Event) {
  emit('update:classification', {
    ...props.classification,
    [key]: (event.target as HTMLSelectElement).value,
  });
}
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
.tree-content {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}
@media (max-height: 850px) {
  .tree-content {
    display: block;
    overflow: auto;
  }
  .tree-scroll {
    overflow: visible;
  }
  .tree-tools,
  .tree-footer {
    flex-shrink: 0;
  }
}
.browse-switch,
.pager {
  display: flex;
  gap: 6px;
  padding: 7px;
}
.browse-switch button,
.category-nav button,
.pager button {
  border: 1px solid var(--line);
  background: #102136;
  color: #a7bbd5;
  border-radius: 4px;
  padding: 6px;
  font-size: 11px;
}
.browse-switch button {
  flex: 1;
}
.category-nav {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
  padding: 0 9px 9px;
}
.category-nav button {
  text-align: left;
  display: flex;
  justify-content: space-between;
  gap: 4px;
}
.category-nav button.active,
.browse-switch button.active {
  background: #234766;
  color: #c3e5ff;
  border-color: #42769d;
}
.classification-tools {
  margin: 0 10px 8px;
  font-size: 11px;
}
.classification-tools label {
  display: grid;
  grid-template-columns: 65px 1fr;
  align-items: center;
  margin-top: 6px;
}
.classification-tools small {
  display: block;
  margin-top: 8px;
  color: var(--muted);
}
.device-group > summary {
  padding: 10px 4px;
  color: #8ec7e7;
}
.device-group > details {
  margin-left: 12px;
  font-size: 11px;
}
.device-group > details > summary {
  padding: 8px 4px;
  color: #8bbda9;
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
.resource-group > summary.tree-summary {
  display: list-item;
  list-style-position: inside;
  cursor: pointer;
}
.resource-group > summary.tree-summary::marker {
  color: #8ec7e7;
}
.resource-group > summary.tree-summary span {
  float: right;
  margin-left: 8px;
}
.resource-group > summary.tree-summary:focus-visible {
  outline: 2px solid #6bbfee;
  outline-offset: -2px;
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
