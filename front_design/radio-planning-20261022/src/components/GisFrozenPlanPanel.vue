<template>
  <section
    class="frozen-workspace"
    aria-label="数据库冻结方案"
  >
    <form
      class="toolbar catalog-tools"
      @submit.prevent="search()"
    >
      <label
        >方案搜索
        <input
          v-model="searchText"
          class="input"
          maxlength="120"
      /></label>
      <label
        >状态
        <select
          v-model="state"
          class="input"
          ><option value="">全部</option
          ><option value="SAVED">已保存</option
          ><option value="REFERENCE">参考方案</option
          ><option value="CONFIRMED">已确认</option></select
        ></label
      >
      <button
        class="btn"
        :disabled="model.listing"
        >查询</button
      >
      <span role="status">{{
        model.listing ? '读取方案目录中' : `共 ${model.catalog?.total ?? 0} 条`
      }}</span>
    </form>
    <p
      v-if="model.listError"
      role="alert"
      class="notice"
      >{{ model.listError }}<span v-if="model.catalog"> · 当前保留上次目录，未更新</span></p
    >
    <div class="catalog-table">
      <table
        ><thead
          ><tr><th>方案 / 任务</th><th>版本与状态</th><th>保存时间</th><th>操作</th></tr></thead
        >
        <tbody
          ><tr
            v-for="row in model.catalog?.items ?? []"
            :key="row.id"
          >
            <td
              >{{ row.name }}<small>{{ row.id }} / {{ row.taskId }}</small></td
            >
            <td
              >{{ row.version }} · {{ labels[row.state]
              }}<small v-if="row.sourceChanged">来源已变化，历史保留</small></td
            >
            <td>{{ row.savedAt }}</td
            ><td
              ><button
                class="btn small"
                type="button"
                :disabled="model.opening"
                @click="model.openPlan(row)"
                >打开冻结网络</button
              ></td
            >
          </tr></tbody
        >
      </table>
      <p
        v-if="!model.listing && model.catalog?.total === 0"
        class="notice"
        >暂无已保存方案。请在网络规划中计算并保存方案。</p
      >
    </div>
    <div class="toolbar"
      ><button
        class="btn small"
        :disabled="page <= 1 || model.listing"
        @click="changePage(-1)"
        >上一页</button
      ><span>第 {{ page }} 页</span
      ><button
        class="btn small"
        :disabled="!model.catalog || page * 10 >= model.catalog.total || model.listing"
        @click="changePage(1)"
        >下一页</button
      ></div
    >
    <p
      v-if="model.opening"
      role="status"
      class="notice"
      >正在打开指定冻结方案…</p
    >
    <p
      v-if="model.error"
      role="alert"
      class="notice"
      >{{ model.error }}</p
    >
    <template v-if="model.network">
      <div class="snapshot-heading toolbar"
        ><strong>{{ model.network.identity.plan_id }}</strong
        ><span>{{ model.network.identity.snapshot_id }}</span
        ><span>构造联调 · 算法预测，非实测</span
        ><span v-if="model.network.identity.source_changed">历史来源已变化</span
        ><button
          class="btn small"
          @click="model.closeNetwork"
          >关闭网络</button
        ></div
      >
      <div class="frozen-layout">
        <div class="frozen-map">
          <MapCanvas
            :stations="[]"
            resource-read
            gis-surface
            :frozen-network="model.network"
            :terrain-basemap="basemap"
            :map-caption="basemap ? '冻结 DEM 地形' : groundMessage"
            :selected-id="model.selectedNodeId"
            :selected-link-id="model.selectedLinkId"
            :selected-demand-id="model.selectedDemandId"
            @select-frozen-node="model.selectNode"
            @select-frozen-link="model.selectLink"
            @select-frozen-demand="model.selectDemand"
          />
        </div>
        <aside class="frozen-details">
          <div class="toolbar"
            ><strong
              >{{ model.network.nodes.length }} 节点 / {{ model.network.links.length }} 链路</strong
            ></div
          >
          <label
            >链路<select
              class="input"
              :value="model.selectedLinkId"
              @change="model.selectLink(($event.target as HTMLSelectElement).value)"
              ><option value="">请选择</option
              ><option
                v-for="link in model.network.links"
                :key="link.id"
                :value="link.id"
                >{{ link.id }} · {{ link.backup ? '备用' : '主用' }}</option
              ></select
            ></label
          >
          <label
            >通联需求<select
              class="input"
              :value="model.selectedDemandId"
              @change="model.selectDemand(($event.target as HTMLSelectElement).value)"
              ><option value="">请选择</option
              ><option
                v-for="demand in model.network.demands"
                :key="demand.id"
                :value="demand.id"
                >{{ demand.id }} · {{ demand.source_id }} → {{ demand.target_id }}</option
              ></select
            ></label
          >
          <p
            v-if="model.readingDetail"
            role="status"
            >读取详情中…</p
          ><p
            v-if="model.detailError"
            role="alert"
            >{{ model.detailError }}</p
          >
          <dl v-if="node"
            ><dt>节点</dt><dd>{{ node.name }} / {{ node.id }}</dd
            ><dt>坐标</dt><dd>{{ node.coordinate.join(', ') }}</dd
            ><dt>冻结状态 / 告警</dt
            ><dd
              >{{ node.status ?? '未提供' }} /
              {{ node.alert === null ? '未提供' : node.alert ? '是' : '否' }}</dd
            ></dl
          >
          <dl v-if="model.detail"
            ><dt>链路端点</dt><dd>{{ model.detail.link.a }} → {{ model.detail.link.b }}</dd
            ><dt>频率</dt><dd>{{ value(model.detail.link.frequency_khz, 'kHz') }}</dd
            ><dt>预测等级</dt><dd>{{ model.detail.link.planned_state ?? '未提供' }}</dd
            ><dt>实际设备</dt
            ><dd
              v-for="device in model.detail.endpoint_devices"
              :key="device.id"
              >{{ device.id }} · {{ value(device.tx_power_dbm, 'dBm') }} ·
              {{ value(device.antenna_height_m, 'm') }}</dd
            ><dt>实测观测</dt><dd>{{ model.detail.observation.message }}</dd></dl
          >
          <template v-if="model.paths"
            ><p v-if="model.paths.paths_state === 'missing'">{{ model.paths.paths_message }}</p
            ><dl
              v-for="route in model.paths.routes"
              :key="route.id"
              ><dt>{{ route.backup ? '备用路径' : '主路径' }}</dt
              ><dd>{{ route.node_ids.join(' → ') }}</dd
              ><dt>链路</dt><dd>{{ route.link_ids.join(' → ') }}</dd></dl
            ></template
          >
          <p
            v-if="model.surfaceError"
            role="alert"
            >{{ model.surfaceError }}</p
          >
          <p
            v-if="!basemap && groundMessage"
            class="muted"
            >{{ groundMessage }}</p
          >
        </aside>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import MapCanvas from './MapCanvas.vue';
import {
  createGisFrozenPlanWorkspace,
  type GisFrozenPlanServices,
} from '../stores/gis-frozen-plan';
import { useTerrainBasemap } from '../composables/useTerrainBasemap';
import type { ApiPlan } from '../types/planning-api';
const props = defineProps<{ services: GisFrozenPlanServices; sessionGeneration: number }>();
const model = reactive(createGisFrozenPlanWorkspace(props.services));
const searchText = ref(''),
  state = ref<ApiPlan['state'] | ''>(''),
  page = ref(1);
const labels = { SAVED: '已保存', REFERENCE: '参考方案', CONFIRMED: '已确认' };
const node = computed(() => model.network?.nodes.find((row) => row.id === model.selectedNodeId));
const value = (n: number | null, unit: string) => (n === null ? '未提供' : `${n} ${unit}`);
const { basemap, message: terrainMessage } = useTerrainBasemap(() => model.surface?.terrain, {
  enabled: () => !!model.network && !!model.surface,
  unavailableReason: () =>
    model.surface?.terrain_notice || model.surfaceError || '未提供可核验的冻结地形',
});
const groundMessage = computed(
  () =>
    terrainMessage.value || model.surfaceError || model.surface?.terrain_notice || '读取冻结地形中',
);
function load() {
  return model.queryPlans({
    pageNum: page.value,
    pageSize: 10,
    search: searchText.value || undefined,
    ...(state.value ? { state: state.value } : {}),
  });
}
function search() {
  page.value = 1;
  return load();
}
function changePage(delta: number) {
  page.value += delta;
  return load();
}
watch(
  () => props.sessionGeneration,
  () => {
    model.stop();
    page.value = 1;
    searchText.value = '';
    state.value = '';
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(model.stop);
defineExpose({ stop: model.stop });
</script>

<style scoped>
.frozen-workspace {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.catalog-tools {
  align-items: end;
  flex-wrap: wrap;
}
label {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.catalog-table {
  overflow: auto;
  max-height: 320px;
  scrollbar-gutter: stable;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
td,
th {
  padding: 9px 12px;
  text-align: left;
  border-bottom: 1px solid #2a4055;
  overflow-wrap: anywhere;
}
small {
  display: block;
  color: #95aec4;
  margin-top: 4px;
}
.snapshot-heading {
  flex-wrap: wrap;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.frozen-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 320px);
  gap: 14px;
  min-width: 0;
}
.frozen-map {
  height: 560px;
  min-width: 0;
  position: relative;
  overflow: hidden;
  border: 1px solid #2a4055;
  border-radius: 6px;
}
.frozen-map :deep(.map-wrap) {
  height: 100%;
  min-height: 0;
}
.frozen-details {
  display: grid;
  align-content: start;
  gap: 12px;
  max-height: 560px;
  overflow: auto;
  scrollbar-gutter: stable;
}
dl {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 12px 0;
  border-top: 1px solid #2a4055;
}
dt {
  color: #95aec4;
  font-size: 13px;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
@media (max-width: 850px) {
  .frozen-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .frozen-map {
    height: 420px;
  }
  .frozen-details {
    max-height: none;
  }
}
</style>
