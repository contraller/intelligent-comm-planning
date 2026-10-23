<template>
  <div class="resource-map-page">
    <div class="map-heading"
      ><div><p class="eyebrow">GEOGRAPHIC SITUATION</p><h1>GIS 态势</h1></div
      ><div class="toolbar"
        ><span class="chip blue">{{ showTask ? '任务输入' : '资源浏览' }}</span
        ><button
          class="btn small"
          :disabled="!auth.can('planning.view')"
          @click="openTaskInput"
          >{{ showTask ? '返回资源树' : '任务输入' }}</button
        ><button
          v-for="label in ['编辑资源', '干扰分析', '态势监控']"
          :key="label"
          class="btn small"
          disabled
          :title="label + '的 HTTP 能力尚未接入'"
          >{{ label }}</button
        ></div
      ></div
    >
    <ResourceReadStatus />
    <div
      class="read-map-layout"
      :class="{ 'task-layout': showTask }"
      ><aside class="panel tree-panel"
        ><TaskApiPanel v-if="showTask" /><template v-else
          ><div class="panel-head"><h3>资源树</h3></div
          ><div class="search tree-search"
            ><i class="pi pi-search" /><input
              v-model="search"
              :disabled="store.frozen"
              aria-label="搜索地图资源"
              placeholder="资源编号或名称" /></div
          ><ResourceReadTree
            :filter="store.mapFilter"
            :cluster="cluster"
            @select="(kind, id) => select(kind, id)"
            @clear-cluster="cluster = null" /></template
      ></aside>
      <section class="map-panel"
        ><div class="map-tools"
          ><label
            ><input
              type="checkbox"
              v-model="roads"
            />本地道路</label
          ><label
            ><input
              type="checkbox"
              v-model="store.showNodes"
              :disabled="store.frozen"
            />节点</label
          ><label
            ><input
              type="checkbox"
              v-model="store.showInterferences"
              :disabled="store.frozen"
            />干扰源</label
          ><span
            >当前范围：{{ store.frame?.totalNodes ?? '—' }} 节点 /
            {{ store.frame?.totalInterferences ?? '—' }} 干扰源</span
          ></div
        >
        <MapCanvas
          :deployment-constraints="deploymentFrame"
          v-if="store.workspace"
          ref="map"
          :stations="[]"
          resource-read
          :resource-frame="store.frame"
          :resource-bounds="store.workspace.bounds"
          :planning-overlay="taskOverlay"
          planning-context="gis"
          :selected-id="
            store.detail?.object.kind === 'device'
              ? store.detail.object.stationId
              : store.detail?.object.id
          "
          :resource-selected-kind="
            store.detail?.object.kind === 'device' ? 'node' : store.detail?.object.kind
          "
          :show-roads="roads"
          @viewport="viewport"
          @select="select('node', $event, false)"
          @select-resource="select($event.kind, $event.id, false)"
          @select-cluster="chooseCluster"
        />
        <div
          v-else
          class="map-empty"
          >{{ store.refreshing ? '正在读取资源范围…' : '资源尚未加载，请重试。' }}</div
        >
        <div
          v-if="queued || store.pending.map"
          class="map-progress"
          role="status"
          >正在读取当前范围，保留上次成功图层…</div
        >
        <div
          v-if="store.errors.map"
          class="map-progress error"
          role="alert"
          >{{ store.errors.map }}
          <button
            class="text-link"
            :disabled="store.frozen"
            @click="store.loadMap()"
            >重试</button
          ></div
        >
      </section>
      <aside class="panel detail-panel"
        ><ResourceReadDetail
          can-locate
          @locate="locate"
      /></aside>
    </div>
    <p class="scope-note"
      >地图随视野自动读取，聚合数字来自接口。任务需求以虚线显示，与网络规划共享草稿；资源编辑、分析结果与监控尚未接入。</p
    >
    <DecisionDialog
      :request="task.decision"
      @answer="task.answer"
    />
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useResourceReadStore } from '../stores/resource-read';
import type {
  Bounds,
  ReadObject,
  ResourceMapCluster,
  ResourceObjectKind,
} from '../types/resource-read';
import MapCanvas from '../components/MapCanvas.vue';
import ResourceReadStatus from '../components/ResourceReadStatus.vue';
import ResourceReadTree from '../components/ResourceReadTree.vue';
import ResourceReadDetail from '../components/ResourceReadDetail.vue';
import TaskApiPanel from '../components/TaskApiPanel.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import { useTaskInputStore } from '../stores/task-input';
import { useAuthStore } from '../stores/auth';
import { useTaskPlanningLeaveGuard } from '../composables/useTaskPlanningLeaveGuard';
const store = useResourceReadStore(),
  route = useRoute(),
  map = ref<InstanceType<typeof MapCanvas>>();
const task = useTaskInputStore(),
  auth = useAuthStore(),
  showTask = ref(false);
useTaskPlanningLeaveGuard();
const taskOverlay = computed(() =>
  showTask.value
    ? {
        nodes: task.nodes.map((n) => ({
          id: n.id,
          name: n.name,
          coordinate: n.coordinate,
          status: n.status,
          alert: n.alert,
        })),
        demands: task.draft?.demands ?? [],
      }
    : null,
);
// 约束层跟随任务预览，退出任务时清空，额外通视节点不入地图参与集合。
const deploymentFrame = computed(() =>
  showTask.value && auth.can('planning.view')
    ? {
        owner: task.taskId + ':' + auth.generation,
        label: '任务草稿',
        constraints: task.draft?.deploymentConstraints,
      }
    : null,
);
async function openTaskInput() {
  if (showTask.value && (task.importFiles.length || Object.values(task.auxiliary).some(Boolean))) {
    if (
      (await task.ask({
        title: '处理未应用输入',
        message: '返回资源树将关闭任务抽屉，请先完成输入，或明确放弃抽屉中的输入。任务草稿仍保留。',
        discardLabel: '放弃抽屉输入',
      })) !== 'discard'
    )
      return;
    task.clearImport();
    task.auxiliary = {};
  }
  showTask.value = !showTask.value;
  if (showTask.value) await task.initialize('gis');
}
const search = ref(store.mapFilter.search ?? ''),
  roads = ref(true),
  cluster = ref<ResourceMapCluster | null>(null),
  queued = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined,
  searchTimer: ReturnType<typeof setTimeout> | undefined,
  active = false;
function locate(object: ReadObject) {
  map.value?.locateResource(
    object.kind === 'device' ? object.stationCoordinate : object.coordinate,
  );
}
async function select(kind: ResourceObjectKind, id: string, focus = true) {
  await store.selectObject(kind, id);
  if (active && focus && store.detail?.object.id === id) locate(store.detail.object);
}
function viewport(bbox: Bounds, zoom: number) {
  store.setViewport(bbox, zoom);
  clearTimeout(timer);
  store.cancelGroup('map');
  if (store.frozen || !active) {
    queued.value = false;
    return;
  }
  queued.value = true;
  timer = setTimeout(async () => {
    queued.value = false;
    if (active) await store.loadMap();
  }, 250);
}
function chooseCluster(value: ResourceMapCluster) {
  if (store.frozen) return;
  if (value.expansionZoom !== null) map.value?.expandResource(value);
  else cluster.value = value;
}
async function routeTarget() {
  if (!active || !store.workspace || store.frozen) return;
  const { stationId, deviceId, interferenceId } = route.query;
  if ([stationId, deviceId, interferenceId].every((v) => v === undefined)) return;
  if (
    [stationId, deviceId, interferenceId].some(
      (v) => v !== undefined && (typeof v !== 'string' || !v || v.length > 120),
    ) ||
    (interferenceId !== undefined && (stationId !== undefined || deviceId !== undefined)) ||
    (deviceId !== undefined && stationId === undefined)
  ) {
    store.notice = '地图定位参数无效';
    return;
  }
  if (interferenceId) await select('interference', String(interferenceId));
  else if (deviceId) {
    await select('device', String(deviceId), false);
    const object = store.detail?.object;
    if (
      active &&
      object?.kind === 'device' &&
      object.id === deviceId &&
      route.query.deviceId === deviceId &&
      route.query.stationId === stationId
    ) {
      if (object.stationId !== stationId) {
        store.closeDetail();
        store.notice = '设备与定位节点不匹配';
      } else locate(object);
    }
  } else if (stationId) await select('node', String(stationId));
}
// 路由任务与定位对象分别恢复，离开后的初始化响应不再打开任务。
async function routeTask() {
  if (
    !active ||
    !auth.can('planning.view') ||
    (!task.draft && typeof route.query.taskId !== 'string')
  )
    return;
  const id = route.query.taskId;
  showTask.value = true;
  await task.initialize('gis');
  if (active && typeof id === 'string' && id === route.query.taskId && id !== task.taskId)
    await task.open(id);
}
onMounted(async () => {
  active = true;
  task.context = 'gis';
  await store.activate('gis');
  if (!active) return;
  await routeTarget();
  await routeTask();
});
watch(
  () => [route.query.stationId, route.query.deviceId, route.query.interferenceId],
  () => void routeTarget(),
);
watch(
  () => route.query.taskId,
  () => void routeTask(),
);
watch(search, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!active || store.frozen) return;
    cluster.value = null;
    store.setMapFilter({ ...store.mapFilter, search: search.value.trim() });
    void store.loadMap();
  }, 250);
});
watch(
  () => [store.showNodes, store.showInterferences],
  () => {
    if (active && !store.frozen) void store.loadMap();
  },
);
watch(
  () => store.refreshKey,
  () => {
    cluster.value = null;
  },
);
// 刷新时仍可移动地图；完成后补读最新视野，不把旧范围标成当前结果。
watch(
  () => store.refreshing,
  (value) => {
    const view = store.viewport,
      frame = store.frame;
    if (
      !value &&
      active &&
      !store.frozen &&
      view &&
      frame &&
      (view.zoom !== frame.zoom || view.bbox.some((n, i) => n !== frame.bbox[i]))
    )
      void store.loadMap();
  },
);
onBeforeUnmount(() => {
  active = false;
  clearTimeout(timer);
  clearTimeout(searchTimer);
  store.stop();
});
</script>
<style scoped>
.read-map-layout.task-layout {
  grid-template-columns: 390px minmax(330px, 1fr) 260px;
}
.resource-map-page {
  padding: 18px 22px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 720px;
  height: 100%;
}
.map-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.map-heading h1 {
  font-size: 24px;
  margin: 0;
}
.map-heading .eyebrow {
  margin: 0 0 4px;
}
.read-map-layout {
  display: grid;
  grid-template-columns: 245px minmax(330px, 1fr) 300px;
  gap: 12px;
  flex: 1;
  min-height: 480px;
}
.tree-panel,
.detail-panel {
  overflow: auto;
  min-height: 0;
}
.tree-panel {
  padding-bottom: 12px;
}
.tree-search {
  margin: 12px 8px;
}
.tree-search input {
  min-width: 0;
  width: 100%;
}
.map-panel {
  display: flex;
  flex-direction: column;
  position: relative;
  min-width: 0;
  min-height: 480px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}
.map-panel :deep(.map-wrap) {
  flex: 1;
}
.map-tools {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px;
  flex-wrap: wrap;
  background: var(--panel);
  font-size: 11px;
}
.map-tools label {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
}
.map-tools input {
  width: auto;
}
.map-tools span {
  color: var(--muted);
}
.map-progress {
  position: absolute;
  z-index: 5;
  top: 75px;
  left: 15px;
  right: 15px;
  background: #102237eb;
  padding: 9px;
  font-size: 12px;
  color: #b8d6f0;
}
.map-progress.error {
  color: #ffd09b;
}
.map-empty {
  display: grid;
  place-items: center;
  flex: 1;
  color: var(--muted);
}
.scope-note {
  font-size: 11px;
  color: var(--muted);
  margin: 0;
}
.toolbar {
  flex-wrap: wrap;
}
@media (max-width: 1250px) {
  .read-map-layout {
    grid-template-columns: 200px minmax(320px, 1fr) 250px;
  }
}
@media (max-width: 1050px) {
  .resource-map-page {
    overflow: auto;
  }
  .read-map-layout {
    min-width: 880px;
  }
}
</style>
