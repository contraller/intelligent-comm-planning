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
            @click="openPlan(row)"
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
        ><strong>方案 {{ model.planVersion || '版本未提供' }} · {{ model.network.identity.plan_id }}</strong
        ><span>所属任务：{{ model.network.identity.task_id }}</span
        ><span>{{ model.network.identity.snapshot_id }}</span
        ><span>算法预测</span
        ><span v-if="model.network.identity.source_changed">历史来源已变化</span
        ><button
          class="btn small"
          @click="closeNetwork"
          >关闭网络</button
        ></div
      >
      <div v-if="coverageReader && !analysisMap" class="v6-controls">
        <strong>设备覆盖</strong><select v-model="v6DeviceId" aria-label="覆盖设备" :disabled="coverageReading || v6Cache?.state!=='HIT'" @change="chooseCoverageDevice"><option value="">选择设备覆盖</option><option v-for="d in v6Cache?.result?.devices ?? []" :key="d.device_id" :value="d.device_id">{{ d.band }} · {{ d.device_id }} · {{ d.node_id }} · {{ coverageStatus[d.status] }}</option></select>
        <select v-if="v6Frequencies.length>1" :value="v6Frequency" aria-label="覆盖频点" @change="chooseCoverageFrequency"><option v-for="f in v6Frequencies" :key="f" :value="f">{{ f }} kHz</option></select><span v-else-if="v6Frequency">{{ v6Frequency }} kHz</span>
        <select v-model="v6Display" aria-label="V6覆盖显示方式"><option value="field">场强等值线</option><option value="strength">强 / 中 / 弱</option><option value="boundary">通信门限线</option></select>
        <label><input v-model="v6Visible" type="checkbox" :disabled="v6Selected?.status!=='COMPLETE'" @change="coverageVisibilityChanged" />显示覆盖</label><label><input v-model="v6Terrain" type="checkbox" :disabled="!v6Overlay || v6Display==='boundary'" />显示地形影响标记</label>
        <button class="btn small" :disabled="!v6Overlay" @click="focusCoverage()">定位覆盖</button><button class="btn small" @click="mapCanvas?.fit()">返回全网</button><button class="btn small" :disabled="coverageReading" @click="readCoverage">刷新覆盖</button><button v-if="model.surface?.coverage" class="text-link" @click="showHistorical=!showHistorical">历史覆盖</button>
        <p v-if="coverageReading">读取同快照覆盖中…</p><p v-else-if="coverageError" role="alert">{{ coverageError }}</p><p v-else-if="v6Cache?.state!=='HIT'">{{ v6Cache?.reason || '尚无已计算的V6覆盖' }} <button class="text-link" @click="openCoveragePlanning">打开同一方案的覆盖计算</button></p>
        <p v-else-if="!v6Selected">选择设备以查看已有覆盖</p><p v-else-if="v6Selected.status!=='COMPLETE'" role="status">{{ coverageStatus[v6Selected.status] }}：{{ v6Selected.reasons.join('；') || '此设备未提供可显示的覆盖' }}</p>
        <div v-if="v6Overlay && v6View" class="v6-legend">
          <CoverageLineLegend :display="v6Display" :has-grid="!!v6View.grid" :boundary-status="v6View.boundaryStatus" :margin-min-db="v6Overlay.result.provenance.parameters.margin_min_db" />
          <span v-if="v6Display==='strength'">强 ≥20 dB · 中 ≥10 dB · 其余达标格为弱</span>
          <span v-if="v6Terrain && v6Display!=='boundary'"><i class="terrain-hatch" />斜纹：{{ v6Selected?.band==='HF'?'有地形附加损耗':'非通视' }}</span>
        </div>
        <details v-if="v6Selected?.status==='COMPLETE' && v6Cache?.state==='HIT'"><summary>参数与来源</summary>
          <p>计算半径 {{ v6RadiusKm }} km · 网格 {{ v6Cache.parameters.cell_m }} m · 功率 {{ v6Selected.radio_parameters?.tx_dbm ?? '未提供' }} dBm · 天线高度 {{ v6Selected.radio_parameters?.height ?? '未提供' }} m</p>
          <p>预测覆盖已考虑地形，非现场实测。计算半径不代表最远通信距离；关闭地形影响标记仍保留地形计算。等值线在有效采样间插值，悬停读取原始采样；精度受网格分辨率限制。</p>
          <p v-if="v6Display==='field' && Number.isFinite(v6View?.min)">所选设备 {{ v6View?.min.toFixed(1) }}–{{ v6View?.max.toFixed(1) }} dBμV/m；同一方案采用统一场强刻度。</p>
          <p>{{ v6View?.evaluated === undefined ? '已评估采样数未提供' : `所选频点达标 ${v6View.features.length} / ${v6View.evaluated} 个采样点` }}；不是面积覆盖率。空白可能为未达门限、计算范围外或缺少地形数据，不能统一判为遮挡。{{ model.network.identity.snapshot_id }}</p>
        </details>
      </div>
      <p v-if="deviceStatus && !analysisMap" class="status-render-anchor" role="status" data-testid="gis-device-status-render"
        :data-snapshot-id="deviceStatus.anchor.snapshotId" :data-snapshot-revision="deviceStatus.anchor.snapshotRevision"
        :data-resource-revision="deviceStatus.anchor.resourceRevision" :data-network-snapshot-id="deviceStatus.networkSnapshotId"
        :data-applied-at="deviceStatus.appliedAt" :data-rendered-at="statusRender?.renderedAt ?? ''" :data-point-count="statusRender?.pointCount ?? 0">
        设备状态叠加 · {{ deviceStatus.anchor.snapshotId }} · {{ deviceStatus.anchor.snapshotRevision }} · 资源 {{ deviceStatus.anchor.resourceRevision }}
        · {{ statusRender ? '地图绘制完成 ' + statusRender.renderedAt + ' · ' + statusRender.pointCount + ' 台' : '等待地图绘制完成' }}
      </p>
      <div v-show="!analysisMap" class="frozen-layout">
        <div class="frozen-map">
          <MapCanvas
            ref="mapCanvas"
            :stations="[]"
            resource-read
            gis-surface
            :frozen-network="model.network"
            :frozen-device-status="deviceStatus"
            :planning-overlay="coverageOverlay"
            :show-coverage="showCoverage"
            :coverage-display="coverageDisplay"
            :frozen-coverage="v6Overlay"
            :terrain-basemap="basemap"
            :map-caption="basemap ? '冻结 DEM 地形' : groundMessage"
            :selected-id="model.selectedNodeId"
            :selected-link-id="model.selectedLinkId"
            :selected-demand-id="model.selectedDemandId"
            @select-frozen-node="model.selectNode"
            @select-frozen-link="model.selectLink"
            @select-frozen-demand="model.selectDemand"
            @device-status-rendered="acceptStatusRender"
            @select-frozen-device="operationPanel?.selectDevice($event)"
          />
        </div>
        <aside class="frozen-details">
          <div v-if="!coverageReader || showHistorical" class="coverage-controls">
            <span v-if="coverageReader">历史覆盖（非V6格面）</span>
            <label><input v-model="showCoverage" type="checkbox" :disabled="!model.surface?.coverage" />覆盖结果</label>
            <select v-model="coverageDisplay" class="input" aria-label="覆盖显示方式" :disabled="!model.surface?.coverage">
              <option value="auto">自动</option><option value="raster">场强栅格</option><option value="contour">覆盖轮廓</option>
            </select>
            <span v-if="model.surface?.coverage_notice" class="muted">{{ model.surface.coverage_notice }}</span>
          </div>
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
      <GisPlanOperations v-if="operations" ref="operationPanel" :key="model.network.identity.plan_id + ':' + model.network.identity.snapshot_id"
        :network="model.network" :services="operations" :current-resource-revision="currentResourceRevision" :session-generation="sessionGeneration" :plan-version="model.planVersion"
        :terrain-basemap="basemap" :initial-tab="initialTab" :selected-link-id="model.selectedLinkId"
        @analysis-map="analysisMap = $event" @select-link="model.selectLink" @select-node="model.selectNode" @device-status="acceptDeviceStatus"
        @open-plan="emit('openPlan', $event)" @open-job="emit('openJob', $event)" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import MapCanvas from './MapCanvas.vue';
import CoverageLineLegend from './CoverageLineLegend.vue';
import GisPlanOperations from './GisPlanOperations.vue';
import {
  createGisFrozenPlanWorkspace,
  type GisFrozenPlanServices,
} from '../stores/gis-frozen-plan';
import { useTerrainBasemap } from '../composables/useTerrainBasemap';
import type { ApiPlan } from '../types/planning-api';
import type { CoverageDisplay } from '../types/coverage';
import type { GisPlanOperationServices } from '../types/gis-plan';
import type { PlanningPlanSummary } from '../types/planning-api';
import { gisDeviceStatusKey, type GisDeviceStatusOverlay, type GisDeviceStatusRender } from '../maps/gis-device-status-layer';
import type { FrozenCoverageCache, FrozenCoverageDisplay, FrozenCoverageOverlay, FrozenCoverageQuery } from '../types/frozen-coverage';
import { coverageFrequencies, coverageFrequency, frozenCoverageView } from '../maps/frozen-coverage-layers';
const props = defineProps<{ services: GisFrozenPlanServices; sessionGeneration: number; operations?: GisPlanOperationServices; coverageReader?:(query:FrozenCoverageQuery,signal?:AbortSignal)=>Promise<FrozenCoverageCache>; currentResourceRevision?: string; initialTab?: 'devices' | 'interference' }>();
const emit = defineEmits<{ openPlan: [value: { taskId: string; planId: string }]; openJob: [value: { taskId: string; jobId: string }] }>();
const analysisMap = ref(false);
const deviceStatus = shallowRef<GisDeviceStatusOverlay | null>(null);
const statusRender = shallowRef<GisDeviceStatusRender | null>(null);
function acceptStatusRender(value: GisDeviceStatusRender) {
  if (deviceStatus.value && value.key === gisDeviceStatusKey(deviceStatus.value) && !statusRender.value) statusRender.value = value;
}
watch(() => deviceStatus.value && gisDeviceStatusKey(deviceStatus.value), () => { statusRender.value = null; }, { flush: 'sync' });
watch(analysisMap, value => { if (value) statusRender.value = null; }, { flush: 'sync' });
function acceptDeviceStatus(value: GisDeviceStatusOverlay | null) {
  const network = model.network;
  deviceStatus.value = value && network && value.taskId === network.identity.task_id && value.planId === network.identity.plan_id
    && value.networkSnapshotId === network.identity.snapshot_id && value.anchor.resourceRevision === network.identity.resource_revision ? value : null;
}
const operationPanel = ref<InstanceType<typeof GisPlanOperations>>();
const model = reactive(createGisFrozenPlanWorkspace(props.services));
const searchText = ref(''),
  state = ref<ApiPlan['state'] | ''>(''),
  page = ref(1);
const showCoverage = ref(!props.coverageReader), coverageDisplay = ref<CoverageDisplay>('auto');
const mapCanvas=ref<InstanceType<typeof MapCanvas>>(),showHistorical=ref(false);
const v6Cache=shallowRef<FrozenCoverageCache|null>(null),coverageReading=ref(false),coverageError=ref('');
const v6DeviceId=ref(''),v6FrequencyChoice=ref<number>(),v6Display=ref<FrozenCoverageDisplay>('field'),v6Visible=ref(false),v6Terrain=ref(false);
const coverageStatus={COMPLETE:'已计算',UNAVAILABLE:'不可计算',SKIPPED:'本次无活动链路'};
const v6Selected=computed(()=>v6Cache.value?.result?.devices.find(d=>d.device_id===v6DeviceId.value));
const v6Frequencies=computed(()=>coverageFrequencies(v6Selected.value));
const v6Frequency=computed(()=>coverageFrequency(v6Selected.value,v6FrequencyChoice.value));
const v6RadiusKm=computed(()=>{const p=v6Cache.value?.parameters;return p?(v6Selected.value?.band==='HF'?Math.min(p.radius_m/1000,p.hf_max_km):p.radius_m/1000):undefined;});
const v6Overlay=computed<FrozenCoverageOverlay|null>(()=>{const cache=v6Cache.value;if(!v6Visible.value||cache?.state!=='HIT'||!cache.result||v6Selected.value?.status!=='COMPLETE')return null;return {anchor:cache.anchor,result:cache.result,deviceId:v6DeviceId.value,frequencyKhz:v6Frequency.value,display:v6Display.value,terrainReference:v6Terrain.value,...cache.bandwidth_selection_id&&cache.bandwidth_selection_hash?{bandwidthSelection:{selectionId:cache.bandwidth_selection_id,selectionHash:cache.bandwidth_selection_hash}}:{}};});
const v6View=computed(()=>v6Overlay.value?frozenCoverageView(v6Overlay.value):null);

let coverageRequest:AbortController|undefined,coverageSerial=0;
const coverageOwner=()=>`${props.sessionGeneration}:${model.network?.identity.plan_id}:${model.network?.identity.snapshot_id}`;
async function readCoverage(){
  const network=model.network,read=props.coverageReader;if(!network||!read)return;
  coverageRequest?.abort();const request=new AbortController(),serial=++coverageSerial,owner=coverageOwner();coverageRequest=request;coverageReading.value=true;coverageError.value='';
  try{const i=network.identity,cache=await read({planId:i.plan_id,taskId:i.task_id,snapshotId:i.snapshot_id,resourceRevision:i.resource_revision,context:'gis',engineVersion:'V01-6'},request.signal);
    if(request.signal.aborted||serial!==coverageSerial||owner!==coverageOwner())return;
    if(cache.anchor.plan_id!==i.plan_id||cache.anchor.task_id!==i.task_id||cache.anchor.snapshot_id!==i.snapshot_id||cache.anchor.resource_revision!==i.resource_revision||cache.anchor.engine_version!=='V01-6')throw new Error('覆盖与当前冻结网络身份不一致');
    v6Cache.value=cache;if(!cache.result?.devices.some(d=>d.device_id===v6DeviceId.value)){v6DeviceId.value='';v6Visible.value=false;v6FrequencyChoice.value=undefined;}
    // 失效频点回退后记住实际显示值，后续刷新不跳回旧频点。
    if(v6Frequency.value!==undefined)v6FrequencyChoice.value=v6Frequency.value;
  }catch(reason){if(!request.signal.aborted&&serial===coverageSerial)coverageError.value=(reason instanceof Error?reason.message:'覆盖读取失败')+(v6Cache.value?'；保留上次成功结果':'');}
  finally{if(serial===coverageSerial)coverageReading.value=false;}
}
async function focusCoverage(preserveScale=false){const key=coverageOwner()+':'+v6DeviceId.value+':'+v6Frequency.value;await nextTick();if(v6Overlay.value&&key===coverageOwner()+':'+v6DeviceId.value+':'+v6Frequency.value)mapCanvas.value?.fitFrozenCoverage(preserveScale);}
function chooseCoverageDevice(){v6FrequencyChoice.value=undefined;v6Visible.value=v6Selected.value?.status==='COMPLETE';if(v6Visible.value){showCoverage.value=false;void focusCoverage(true);}}
function chooseCoverageFrequency(event:Event){v6FrequencyChoice.value=Number((event.target as HTMLSelectElement).value);if(v6Visible.value)void focusCoverage(true);}
function coverageVisibilityChanged(){if(v6Visible.value){showCoverage.value=false;void focusCoverage(true);}}
async function openCoveragePlanning(){const i=model.network?.identity;if(i&&await requestLeave())emit('openPlan',{taskId:i.task_id,planId:i.plan_id});}
// 换来源先取消旧读取；相同快照仅回读缓存，不卸载地图或抢回用户视角。
watch(coverageOwner,()=>{coverageSerial++;coverageRequest?.abort();v6Cache.value=null;v6DeviceId.value='';v6Visible.value=false;v6FrequencyChoice.value=undefined;v6Terrain.value=false;coverageReading.value=false;coverageError.value='';if(model.network&&props.coverageReader)showCoverage.value=false;void readCoverage();},{flush:'sync'});
watch(showCoverage,value=>{if(value)v6Visible.value=false;});
// GIS 仅显示已有冻结覆盖；配置与计算保留在规划页，栅格沿用既有安全下载。
const coverageOverlay = computed(() => model.surface?.coverage ? { nodes: [], coverage: model.surface.coverage, snapshotId: model.surface.identity.snapshot_id } : null);
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
async function requestLeave() { return operationPanel.value ? operationPanel.value.requestLeave() : true; }
async function openPlan(row: PlanningPlanSummary) { if (await requestLeave()) await model.openPlan(row); }
async function closeNetwork() { if (await requestLeave()) model.closeNetwork(); }
async function openIdentity(input: { taskId: string; planId: string }) { return await requestLeave() && await model.openIdentity(input); }
watch(() => model.network, () => { analysisMap.value = false; deviceStatus.value = null; }, { flush: 'sync' });
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
onBeforeUnmount(()=>{coverageSerial++;coverageRequest?.abort();model.stop();});
defineExpose({ stop: model.stop, requestLeave, openIdentity });
</script>

<style scoped>
.v6-controls { display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:12px;border:1px solid #2b455e;border-radius:6px;background:#102035;font-size:12px; }
.v6-controls select { max-width:310px;padding:6px; }
.v6-controls label { display:flex;flex-direction:row;align-items:center;gap:5px; }
.v6-controls p,.v6-controls details,.v6-legend { flex-basis:100%;margin:0;font-size:11px;color:#a9c1d4; }
.v6-legend { display:flex;align-items:center;flex-wrap:wrap;gap:8px 20px; }
.terrain-hatch { display:inline-block;width:18px;height:9px;margin-right:5px;border:1px solid #8ca9bf;background:repeating-linear-gradient(135deg,#b5cce0 0 1px,transparent 1px 5px); }
.status-render-anchor { margin: 0; padding: 8px 0; font-size: 12px; overflow-wrap: anywhere; }
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
.coverage-controls { display: grid; gap: 8px; }
.coverage-controls label { display: flex; align-items: center; gap: 6px; }
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
