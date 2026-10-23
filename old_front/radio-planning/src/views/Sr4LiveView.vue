<template>
  <div class="sr4-page">
    <header class="sr4-toolbar">
      <div><h1>SR4 全流程联调</h1><span>现有任务场景与干扰源版本</span></div>
      <label>任务
        <select v-model="taskId" :disabled="running || busy" @change="loadSnapshot">
          <option v-for="task in catalog?.tasks" :key="task.task_id" :value="task.task_id">{{ task.task_id }} · {{ task.task_name }}</option>
        </select>
      </label>
      <button class="btn" :disabled="!taskId || busy || running || !dirty" @click="save">保存资源版本</button>
      <button class="btn primary" :disabled="!taskId || busy || running" @click="run">{{ dirty || !snapshot ? '保存并运行 SR4' : plan ? '重新计算' : '运行 SR4' }}</button>
    </header>

    <div class="sr4-meta">
      <span>任务 {{ taskId || '未选择' }}</span>
      <span>数据 {{ catalog?.dataset_revision ?? '未加载' }}</span>
      <span>资源 {{ snapshot?.snapshot_id ?? '未保存' }}</span>
      <span v-if="dirty" class="warning">任务、干扰源或基础数据版本已变化，需保存并重算</span>
      <span v-else-if="plan && plan.summary.snapshot_id !== snapshot?.snapshot_id" class="warning">当前结果基于旧资源版本</span>
    </div>
    <p v-if="error" class="sr4-error" role="alert">{{ error }}</p>
    <p v-if="notice" class="sr4-notice" role="status">{{ notice }}</p>

    <div class="sr4-layout">
      <section class="sr4-map-section" aria-label="SR4 计算拓扑地图">
        <div ref="mapHost" class="sr4-map" />
        <div class="sr4-map-key"><span class="terrain-key" />DEM 地形 <span class="link-key" />链路 <span class="node-key" />台站 <span class="jam-key" />干扰源</div>
        <div v-if="terrainSource" class="sr4-map-source" :title="terrainSource">{{ terrainSource }}</div>
      </section>
      <aside class="sr4-side">
        <section><h2>计算进度</h2>
          <div class="sr4-progress"><div :style="{ width: `${progress}%` }" /></div>
          <p>{{ status }}</p>
          <p v-if="jobId">作业 {{ jobId }}</p>
        </section>
        <section v-if="plan"><h2>方案结果</h2>
          <dl><dt>方案编号</dt><dd>{{ plan.solution_id }}</dd>
            <dt>拓扑节点</dt><dd>{{ plan.detail.nodes.length }}</dd>
            <dt>拓扑链路</dt><dd>{{ plan.detail.links.length }}</dd>
            <dt>频率冲突</dt><dd>{{ plan.summary.frequency_conflicts }}</dd>
            <dt>受干扰链路</dt><dd>{{ plan.summary.affected_links }}</dd>
            <dt>校验通过</dt><dd>{{ plan.summary.check_passed ? '是' : '否' }}</dd>
            <dt>耗时</dt><dd>{{ plan.summary.total_s }} s</dd></dl>
        </section>
      </aside>
    </div>

    <section class="sr4-section"><div class="sr4-section-head"><h2>任务通信需求</h2><span>{{ demands.length }} 条</span></div>
      <div class="sr4-table-wrap"><table><thead><tr><th>ID</th><th>起点</th><th>终点</th><th>优先级</th><th>必达</th><th>速率 kbps</th><th>最低可靠性</th></tr></thead>
        <tbody><tr v-for="demand in demands" :key="demand.demand_id"><td>{{ demand.demand_id }}</td><td>{{ demand.src_node_id }}</td><td>{{ demand.dst_node_id }}</td>
          <td><select v-model="demand.priority" :disabled="running || busy"><option>P1</option><option>P2</option><option>P3</option></select></td>
          <td><input type="checkbox" :checked="String(demand.is_mandatory) === 'true'" :disabled="running || busy" @change="demand.is_mandatory = ($event.target as HTMLInputElement).checked ? 'true' : 'false'" /></td>
          <td><input v-model.number="demand.required_rate_kbps" type="number" min="0.01" step="0.1" :disabled="running || busy" /></td>
          <td><input v-model.number="demand.min_reliability" type="number" min="0.01" max="1" step="0.001" :disabled="running || busy" /></td>
        </tr></tbody></table></div>
    </section>

    <section class="sr4-section"><div class="sr4-section-head"><h2>干扰源</h2><span>{{ rows.length }} 条</span></div>
      <div class="sr4-table-wrap"><table><thead><tr><th>ID</th><th>名称</th><th>经度</th><th>纬度</th><th>中心频率 kHz</th><th>功率 dBm</th><th>启用</th></tr></thead>
        <tbody><tr v-for="source in rows" :key="source.interference_id">
          <td>{{ source.interference_id }}</td><td>{{ source.name }}</td>
          <td><input v-model.number="source.lon" type="number" step="0.000001" :disabled="running || busy" /></td>
          <td><input v-model.number="source.lat" type="number" step="0.000001" :disabled="running || busy" /></td>
          <td><input v-model.number="source.center_freq_khz" type="number" step="0.1" :disabled="running || busy" /></td>
          <td><input v-model.number="source.tx_power_dbm" type="number" step="0.1" :disabled="running || busy" /></td>
          <td><input type="checkbox" :checked="String(source.active) === 'true'" :disabled="running || busy" @change="source.active = ($event.target as HTMLInputElement).checked ? 'true' : 'false'" /></td>
        </tr></tbody></table></div>
    </section>

    <section v-if="plan" class="sr4-section"><div class="sr4-section-head"><h2>链路结果</h2><span>{{ plan.detail.links.length }} 条</span></div>
      <div class="sr4-table-wrap"><table><thead><tr><th>ID</th><th>起点</th><th>终点</th><th>频段</th></tr></thead>
        <tbody><tr v-for="link in plan.detail.links" :key="link.link_id"><td>{{ link.link_id }}</td><td>{{ link.node_a_id }}</td><td>{{ link.node_b_id }}</td><td>{{ link.device_class }}</td></tr></tbody></table></div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Map from 'ol/Map';
import View from 'ol/View';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import VectorLayer from 'ol/layer/Vector';
import ImageLayer from 'ol/layer/Image';
import VectorSource from 'ol/source/Vector';
import ImageStatic from 'ol/source/ImageStatic';
import { Circle, Fill, Stroke, Style } from 'ol/style';
import type { Extent } from 'ol/extent';
import { fromLonLat, transformExtent } from 'ol/proj';
import { sr4Live, type InterferenceRow, type Sr4Plan, type Sr4Snapshot, type TaskDemand } from '../services/sr4-live';

const catalog = ref<Awaited<ReturnType<typeof sr4Live.catalog>> | null>(null);
const taskId = ref('');
const snapshot = ref<Sr4Snapshot | null>(null);
const rows = ref<InterferenceRow[]>([]);
const demands = ref<TaskDemand[]>([]);
const baseline = ref('');
const jobId = ref('');
const plan = ref<Sr4Plan | null>(null);
const progress = ref(0);
const status = ref('等待提交');
const busy = ref(false);
const running = ref(false);
const error = ref('');
const notice = ref('');
const mapHost = ref<HTMLElement | null>(null);
const terrainSource = ref('');
const dirty = computed(() => JSON.stringify([rows.value, demands.value]) !== baseline.value);
let map: Map | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let terrainExtent: Extent | null = null;
const overlay = new VectorSource();

function draw(fitTerrain = false) {
  overlay.clear();
  const nodeMap = new globalThis.Map<string, [number, number]>();
  for (const node of plan.value?.detail.nodes ?? []) {
    const coordinate: [number, number] = [Number(node.lon), Number(node.lat)];
    if (!coordinate.every(Number.isFinite)) continue;
    nodeMap.set(node.node_id, coordinate);
    const feature = new Feature(new Point(fromLonLat(coordinate)));
    feature.setStyle(new Style({ image: new Circle({ radius: 3.5, fill: new Fill({ color: '#dcecf2' }), stroke: new Stroke({ color: '#163c50', width: 1.5 }) }) }));
    overlay.addFeature(feature);
  }
  for (const link of plan.value?.detail.links ?? []) {
    const a = nodeMap.get(link.node_a_id), b = nodeMap.get(link.node_b_id);
    if (!a || !b) continue;
    const feature = new Feature(new LineString([fromLonLat(a), fromLonLat(b)]));
    feature.setStyle(new Style({ stroke: new Stroke({ color: link.device_class === 'HF' ? '#d98552' : '#4aa6dd', width: 1.5 }) }));
    overlay.addFeature(feature);
  }
  for (const source of rows.value) {
    if (String(source.active) !== 'true') continue;
    const coordinate: [number, number] = [Number(source.lon), Number(source.lat)];
    if (!coordinate.every(Number.isFinite)) continue;
    const feature = new Feature(new Point(fromLonLat(coordinate)));
    feature.setStyle(new Style({ image: new Circle({ radius: 6, fill: new Fill({ color: '#e94f56' }), stroke: new Stroke({ color: '#fff', width: 1 }) }) }));
    overlay.addFeature(feature);
  }
  if (fitTerrain && map && terrainExtent) map.getView().fit(
    transformExtent(terrainExtent, 'EPSG:4326', 'EPSG:3857'),
    { padding: [24, 24, 24, 24], duration: 250 },
  );
}

async function loadSnapshot() {
  const token = ++generation;
  error.value = ''; notice.value = '';
  try {
    const value = await sr4Live.snapshot(taskId.value);
    if (token !== generation) return;
    snapshot.value = value;
    rows.value = structuredClone(value?.interference_sources ?? catalog.value?.interference_sources ?? []);
    demands.value = structuredClone(value?.task_demands ?? catalog.value?.task_demands.filter(row => row.task_id === taskId.value) ?? []);
    baseline.value = value && (!value.task_demands || value.dataset_revision !== catalog.value?.dataset_revision)
      ? '' : JSON.stringify([rows.value, demands.value]);
    plan.value = null; jobId.value = ''; progress.value = 0; status.value = '等待提交';
    draw(true);
  } catch (reason) { if (token === generation) error.value = String(reason); }
}

async function persistSnapshot(): Promise<Sr4Snapshot> {
  const value = await sr4Live.save(taskId.value, snapshot.value?.snapshot_id ?? null, rows.value, demands.value);
  snapshot.value = value;
  rows.value = structuredClone(value.interference_sources);
  demands.value = structuredClone(value.task_demands);
  baseline.value = JSON.stringify([rows.value, demands.value]);
  return value;
}

async function save() {
  busy.value = true; error.value = ''; notice.value = '';
  try {
    await persistSnapshot();
    notice.value = '资源版本已保存；运行后地图和表格将更新。';
  } catch (reason) { error.value = String(reason); }
  finally { busy.value = false; }
}

async function poll(token: number) {
  if (token !== generation || !jobId.value) return;
  try {
    const response = await sr4Live.job(jobId.value);
    if (token !== generation) return;
    if (response.code === 2003) throw new Error(response.data?.error_detail || response.message);
    if (response.code === 2002) {
      progress.value = Math.round((response.data.progress ?? 0) * 100);
      status.value = response.data.stage ?? '计算中';
      timer = setTimeout(() => void poll(token), 2000);
      return;
    }
    if (!response.data.solution_id) throw new Error('计算成功但未返回方案编号');
    plan.value = await sr4Live.plan(response.data.solution_id);
    if (token !== generation) return;
    progress.value = 100; status.value = '计算完成'; running.value = false;
    await nextTick(); draw(true);
  } catch (reason) {
    if (token === generation) { error.value = String(reason); running.value = false; status.value = '计算失败'; }
  }
}

async function run() {
  if (!taskId.value) return;
  const token = ++generation;
  error.value = ''; notice.value = ''; running.value = true;
  progress.value = 0; status.value = '提交中'; plan.value = null; draw();
  try {
    const currentSnapshot = !snapshot.value || dirty.value ? await persistSnapshot() : snapshot.value;
    if (token !== generation) return;
    const job = await sr4Live.run(taskId.value, currentSnapshot.snapshot_id);
    if (token !== generation) return;
    jobId.value = job.task_id;
    await poll(token);
  } catch (reason) { if (token === generation) { error.value = String(reason); running.value = false; status.value = '提交失败'; } }
}

watch(rows, () => draw(), { deep: true });
onMounted(async () => {
  try {
    const terrainUrl = import.meta.env.BASE_URL + 'maps/sr4-terrain';
    const response = await fetch(terrainUrl + '.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('DEM 地形元数据加载失败');
    const metadata = await response.json() as { extent: number[]; projection: string; source: string; source_sha256: string };
    if (metadata.projection !== 'EPSG:4326' || metadata.extent?.length !== 4
      || !metadata.extent.every(Number.isFinite)) throw new Error('DEM 地形坐标范围无效');
    terrainExtent = metadata.extent;
    terrainSource.value = metadata.source;
    const terrain = new ImageStatic({ url: terrainUrl + '.png', imageExtent: terrainExtent,
      projection: 'EPSG:4326' });
    terrain.on('imageloaderror', () => { error.value = 'DEM 地形图像加载失败'; });
    map = new Map({
      target: mapHost.value!,
      layers: [
        new ImageLayer({ source: terrain }),
        new VectorLayer({ source: overlay }),
      ],
      view: new View({ center: fromLonLat([114.1, 37.1]), zoom: 8 }),
    });
    map.getView().fit(transformExtent(terrainExtent, 'EPSG:4326', 'EPSG:3857'),
      { padding: [24, 24, 24, 24] });
    catalog.value = await sr4Live.catalog();
    if (catalog.value.terrain_source_sha256 !== metadata.source_sha256) {
      throw new Error('地形图与后端当前 DEM 版本不一致，请重新运行 npm run prepare:sr4-terrain');
    }
    taskId.value = catalog.value.tasks[0]?.task_id ?? '';
    if (taskId.value) await loadSnapshot();
  } catch (reason) { error.value = String(reason); }
});
onBeforeUnmount(() => { generation++; if (timer) clearTimeout(timer); map?.setTarget(undefined); });
</script>

<style scoped>
.sr4-page { padding: 20px 24px 32px; color: #dbe8eb; background: #101d24; min-height: 100%; }
.sr4-toolbar, .sr4-meta, .sr4-section-head { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.sr4-toolbar { justify-content: space-between; }
.sr4-toolbar h1 { font-size: 22px; margin: 0 0 4px; }
.sr4-toolbar span, .sr4-meta, .sr4-side p, .sr4-section-head span { color: #92aab2; font-size: 13px; }
.sr4-toolbar label { display: flex; align-items: center; gap: 8px; }
.sr4-toolbar select, .sr4-table-wrap input, .sr4-table-wrap select { background: #172b34; color: #eaf2f4; border: 1px solid #35505a; border-radius: 4px; padding: 7px; }
.sr4-toolbar select { max-width: 280px; }
.sr4-meta { margin: 15px 0; border-top: 1px solid #30434b; padding-top: 10px; }
.warning { color: #f2bb72 !important; }
.sr4-error { color: #ff9292; }.sr4-notice { color: #8ed8bb; }
.sr4-layout { display: grid; grid-template-columns: minmax(0, 1fr) 250px; gap: 16px; }
.sr4-map-section { position: relative; min-width: 0; }
.sr4-map { height: min(60vh, 640px); min-height: 360px; background: #1b3938; border: 1px solid #35505a; }
.sr4-map-key { position: absolute; left: 10px; bottom: 10px; max-width: calc(100% - 20px); background: #12242de8; padding: 8px 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 7px; font-size: 12px; }
.sr4-map-source { position: absolute; right: 10px; top: 10px; max-width: 44%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: #12242de8; padding: 8px 10px; font-size: 11px; }
.terrain-key { width: 12px; height: 10px; background: #a99e75; }
.link-key { width: 18px; border-top: 2px solid #4aa6dd; }.node-key,.jam-key { width: 10px; height: 10px; border-radius: 50%; background: #dcecf2; }.jam-key { background: #e94f56; }
.sr4-side section { border-bottom: 1px solid #30434b; padding: 0 0 12px; margin-bottom: 16px; }
h2 { margin: 0 0 12px; font-size: 16px; }.sr4-side dl { display: grid; grid-template-columns: 1fr auto; gap: 8px; font-size: 13px; }.sr4-side dt { color: #98aeb7; }.sr4-side dd { margin: 0; font-weight: 600; }
.sr4-progress { background: #30434b; height: 7px; }.sr4-progress div { background: #38a5bd; height: 100%; }
.sr4-section { margin-top: 20px; border-top: 1px solid #30434b; padding-top: 15px; }.sr4-section-head { justify-content: space-between; }
.sr4-table-wrap { max-height: 400px; overflow: auto; }table { border-collapse: collapse; width: 100%; font-size: 13px; }th,td { padding: 8px 10px; border-bottom: 1px solid #30434b; text-align: left; white-space: nowrap; }th { color: #9bb5bd; background: #14252d; position: sticky; top: 0; }.sr4-table-wrap input[type=number] { width: 100px; }
@media (max-width: 850px) { .sr4-layout { grid-template-columns: 1fr; }.sr4-map { height: 400px; }.sr4-toolbar { align-items: stretch; }.sr4-page { padding: 14px; } }
</style>
