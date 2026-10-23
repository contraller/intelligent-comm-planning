<template>
  <div class="page resource-ledger">
    <div class="page-heading"
      ><div
        ><p class="eyebrow">RESOURCE CENTER</p><h1>资源管理</h1
        ><p class="subtitle">查看设备实例、节点归属与已保存参数</p></div
      ><div class="toolbar"
        ><button
          class="btn"
          disabled
          title="HTTP 导入尚未接入"
          >导入</button
        ><button
          class="btn"
          disabled
          title="HTTP 导出尚未接入"
          >导出</button
        ><button
          class="btn primary"
          disabled
          title="HTTP 资源维护尚未接入"
          >新增设备</button
        ></div
      ></div
    >
    <ResourceReadStatus />
    <div class="stats-grid section-gap"
      ><div class="stat-card"
        ><small>全库设备</small
        ><strong class="value">{{ stats?.devices ?? '—' }}<em>台</em></strong></div
      ><div class="stat-card"
        ><small>全库节点</small
        ><strong class="value">{{ stats?.nodes ?? '—' }}<em>个</em></strong></div
      ><div class="stat-card"
        ><small>设备型号</small
        ><strong class="value">{{ stats?.models ?? '—' }}<em>类</em></strong></div
      ><div class="stat-card"
        ><small>附加告警设备</small><strong class="value">{{ stats?.alerts ?? '未知' }}</strong
        ><small>告警未提供：{{ stats?.unknownAlerts ?? '未知' }}</small></div
      ></div
    >
    <div class="read-split"
      ><aside class="panel"
        ><div class="panel-head"><h3>资源分类 · 全库</h3></div
        ><div class="side-list">
          <button
            :disabled="store.frozen"
            :class="{ active: !filters.deviceClass }"
            @click="filters.deviceClass = undefined"
            ><span>全部设备</span><small>{{ stats?.devices ?? '—' }}</small></button
          >
          <button
            v-for="kind in ['HF', 'VUHF'] as const"
            :key="kind"
            :disabled="store.frozen"
            :class="{ active: filters.deviceClass === kind }"
            @click="filters.deviceClass = kind"
            ><span>{{ kind }}</span
            ><small>{{ kind === 'HF' ? stats?.hf : stats?.vuhf }}</small></button
          > </div
        ><p class="resource-note"
          >数量来自同一资源版本。未提供的告警与在架状态保留为未知。</p
        ></aside
      >
      <section class="panel"
        ><div class="tabs"
          ><button class="active">设备台账</button
          ><button
            disabled
            title="HTTP 频谱接口配置尚未接入"
            >频谱接口配置</button
          ></div
        >
        <div class="panel-body toolbar"
          ><div class="search"
            ><i class="pi pi-search" /><input
              v-model="search"
              :disabled="store.frozen"
              aria-label="搜索设备"
              placeholder="设备编号、型号或所属节点"
          /></div>
          <select
            v-model="filters.status"
            :disabled="store.frozen"
            aria-label="筛选运行状态"
            ><option :value="undefined">全部状态</option
            ><option value="NORMAL">正常</option
            ><option value="FAULT">故障</option
            ><option value="OFFLINE">离线</option></select
          >
          <select
            v-model="filters.availability"
            :disabled="store.frozen"
            aria-label="筛选在架状态"
            ><option :value="undefined">全部在架状态</option
            ><option value="ACTIVE">在架</option
            ><option value="OFF_SHELF">已下架</option
            ><option value="UNKNOWN">未知</option></select
          >
          <select
            v-model="filters.alert"
            :disabled="store.frozen"
            aria-label="筛选附加告警"
            ><option :value="undefined">全部告警状态</option
            ><option value="YES">有告警</option
            ><option value="NO">无告警</option
            ><option value="UNKNOWN">未提供</option></select
          >
        </div>
        <p class="query-caption"
          >上次成功查询：{{ store.ledgerApplied?.search || '全部关键词' }} ·
          {{ store.ledgerApplied?.deviceClass || '全部类别' }} · 匹配
          {{ store.ledger?.total ?? '—' }} 台；当前页 {{ rows.length }} 台</p
        >
        <div :inert="store.frozen || undefined"
          ><AppTable
            :rows="rows"
            :columns="columns"
            :selected="selected"
            server
            :total="store.ledger?.total ?? 0"
            :page-size="store.ledger?.pageSize ?? 10"
            :first="((store.ledger?.page ?? 1) - 1) * (store.ledger?.pageSize ?? 10)"
            :loading="store.pending.ledger"
            :sort-field="store.ledgerQuery.sort === 'name' ? 'modelName' : store.ledgerQuery.sort"
            :sort-order="store.ledgerQuery.order === 'desc' ? -1 : 1"
            @page="
              store.loadLedger({
                page: Math.floor($event.first / $event.rows) + 1,
                pageSize: $event.rows,
              })
            "
            @sort="sort"
            @select="store.selectObject('device', $event.id)"
          >
            <template #availability="{ row }"
              ><span class="chip">{{
                row.availability === null
                  ? '未知'
                  : row.availability === 'ACTIVE'
                    ? '在架'
                    : '已下架'
              }}</span></template
            >
            <template #status="{ row }"
              ><StatusBadge
                :status="row.status"
                :alert="row.alert === true"
              /><small
                v-if="row.alert === null"
                class="unknown"
                >告警未提供</small
              ></template
            >
            <template #actions="{ row }"
              ><button
                class="text-link"
                @click.stop="store.selectObject('device', row.id)"
                >查看详情</button
              ></template
            >
          </AppTable></div
        >
        <p class="resource-note"
          >当前开放 HTTP 只读浏览；新增、编辑、上下架、导入导出及频谱配置尚未接入。</p
        >
      </section></div
    >
    <AppDrawer
      :visible="!!store.selected"
      title="设备实例详情"
      @update:visible="!$event && store.closeDetail()"
      ><ResourceReadDetail
        :can-locate="auth.can('situation.view')"
        @locate="locate"
      /><template #footer
        ><span class="muted">已保存资源 · 缺失字段保留未知含义</span></template
      ></AppDrawer
    >
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useResourceReadStore } from '../stores/resource-read';
import { useAuthStore } from '../stores/auth';
import type { ReadObject, ResourceReadFilter } from '../types/resource-read';
import AppTable from '../components/AppTable.vue';
import AppDrawer from '../components/AppDrawer.vue';
import StatusBadge from '../components/StatusBadge.vue';
import ResourceReadStatus from '../components/ResourceReadStatus.vue';
import ResourceReadDetail from '../components/ResourceReadDetail.vue';
const store = useResourceReadStore(),
  auth = useAuthStore(),
  router = useRouter();
// 筛选状态不携带旧分页/排序，避免改筛选时覆盖用户刚选择的排序。
const filters = ref<ResourceReadFilter>({
  deviceClass: store.ledgerQuery.deviceClass,
  status: store.ledgerQuery.status,
  availability: store.ledgerQuery.availability,
  alert: store.ledgerQuery.alert,
});
const search = ref(store.ledgerQuery.search ?? '');
const stats = computed(() => store.workspace?.stats);
const rows = computed(() => store.ledger?.items ?? []);
const selected = computed(() => rows.value.find((d) => d.id === store.selected?.id) ?? null);
const columns = [
  { field: 'id', header: '设备编号' },
  { field: 'modelName', header: '设备型号' },
  { field: 'deviceClass', header: '类别', sortable: false },
  { field: 'stationName', header: '所属节点', sortable: false },
  { field: 'availability', header: '在架状态', sortable: false },
  { field: 'status', header: '运行状态' },
];
let timer: ReturnType<typeof setTimeout> | undefined,
  active = false;
onMounted(async () => {
  active = true;
  await store.activate('ledger');
});
watch(
  [search, filters],
  () => {
    if (!active || store.frozen) return;
    clearTimeout(timer);
    store.cancelGroup('ledger');
    timer = setTimeout(
      () => void store.loadLedger({ ...filters.value, search: search.value.trim(), page: 1 }),
      250,
    );
  },
  { deep: true },
);
onBeforeUnmount(() => {
  active = false;
  clearTimeout(timer);
  store.stop();
});
function sort(input: { sortField?: string; sortOrder?: number | null }) {
  const sort =
    input.sortField === 'modelName' ? 'name' : input.sortField === 'status' ? 'status' : 'id';
  void store.loadLedger({ sort, order: input.sortOrder === -1 ? 'desc' : 'asc', page: 1 });
}
function locate(object: ReadObject) {
  if (object.kind === 'device' && auth.can('situation.view'))
    void router.push({
      path: '/situation',
      query: { stationId: object.stationId, deviceId: object.id },
    });
}
</script>
<style scoped>
.read-split {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 18px;
}
.stat-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.resource-note,
.query-caption {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.8;
  padding: 12px 16px;
  margin: 0;
}
.unknown {
  display: block;
  color: #c2a87f;
  margin-top: 4px;
}
.toolbar {
  flex-wrap: wrap;
}
.toolbar .search {
  max-width: 330px;
}
.side-list button {
  display: flex;
  justify-content: space-between;
  width: 100%;
}
@media (max-width: 1150px) {
  .read-split {
    grid-template-columns: 170px minmax(0, 1fr);
  }
}
</style>
