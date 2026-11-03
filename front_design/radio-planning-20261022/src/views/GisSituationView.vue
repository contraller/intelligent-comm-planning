<template>
  <section class="gis-situation" aria-label="GIS 态势只读地图">
    <MapCanvas
      ref="map"
      :stations="[]"
      resource-read
      gis-surface
      readonly-situation
      :frozen-network="frame.network"
      :terrain-basemap="frame.basemap"
      :frozen-coverage="model.coverage"
      :interferences="model.interferences"
      :hover-preview="hoverContext"
      :show-coverage="model.showCoverage"
      :show-links="model.showLinks"
      :show-roads="false"
      @hover-frozen-devices="model.previewDevices"
    />
    <div class="source-badge" :class="{ example: frame.example }" aria-live="polite">
      <span class="source-dot" />
      <strong>{{ frame.label }}</strong>
      <span>{{ frame.example ? '受控构造示例 · 非实测' : frame.version + ' · 算法预测' }}</span>
    </div>
    <p v-if="model.displayingLiveInterferences" class="interference-source-badge">干扰源已更新；规划链路仍为原计算结果</p>
    <p v-if="model.error" class="map-notice error" role="alert">{{ model.error }}</p>
    <p v-else-if="model.notice" class="map-notice" role="status">{{ model.notice }}</p>
    <span v-if="model.busy" class="read-status" role="status">正在核对态势来源…</span>
    <Teleport v-if="menuTarget" :to="menuTarget">
      <section class="situation-controls" aria-label="GIS 态势显示设置">
        <h2>态势显示</h2>
        <label v-if="model.canAutoFollow" class="auto-follow"><input type="checkbox" :checked="model.autoFollow" @change="changeAutoFollow" />每30秒自动跟随最新已转正方案和已保存干扰源</label>
        <p v-if="model.canAutoFollow && !model.autoFollow" class="source-note">已暂停自动跟随，重新勾选可恢复。切换历史方案时仅显示原冻结干扰源。</p>
        <p v-if="model.lastCheckedAt" class="source-note">最近核对：{{ lastCheckedTime }}。只读刷新，不启动规划或干扰计算。</p>
        <div class="control-actions">
          <button class="btn primary" :disabled="model.busy" @click="model.refreshLatest">刷新当前转正态势</button>
          <button class="btn" @click="map?.fitAll()">全域查看</button>
          <button class="btn" :disabled="!model.coverage" @click="map?.focusFrozenCoverage()">定位覆盖</button>
          <button class="btn" @click="map?.returnFrozenNetwork()">返回全网</button>
        </div>
        <p class="frame-label"><strong>{{ frame.label }}</strong><span>{{ frame.version }} · {{ frame.network.nodes.length }} 节点 / {{ frame.network.links.length }} 链路</span></p>
        <p class="source-note">{{ frame.notice }}</p>
        <p class="source-note">{{ model.interferenceSourceLabel }}</p>
        <button class="btn small" :disabled="model.busy" @click="model.showExample">查看内置受控示例</button>
        <div class="layer-options">
          <label><input v-model="model.showLinks" type="checkbox" />规划链路</label>
          <label><input v-model="model.showCoverage" type="checkbox" :disabled="!coverageDevices.length" />设备覆盖</label>
        </div>
        <label>设备覆盖
          <select v-model="model.selectedDeviceId" class="input" :disabled="!coverageDevices.length" @change="model.showCoverage = !!model.selectedDeviceId">
            <option value="">{{ coverageDevices.length ? '选择已计算设备' : '该帧暂无已保存地形覆盖' }}</option>
            <option v-for="device in coverageDevices" :key="device.device_id" :value="device.device_id">{{ device.device_id }} · {{ device.band || '频段未提供' }}</option>
          </select>
        </label>
        <label>覆盖表达
          <select v-model="model.coverageDisplay" class="input" :disabled="!coverageDevices.length">
            <option value="strength">强 / 中 / 弱</option><option value="field">预测场强热力</option><option value="boundary">覆盖边界</option>
          </select>
        </label>
        <p class="source-note">移动光标查看节点及冻结设备信息。此页只读，计算与编辑请进入 GIS 工作台或网络规划。</p>
        <details class="plan-picker" @toggle="loadCatalog" @mouseenter="revealCatalog" @focusin="revealCatalog">
          <summary @click.prevent="revealCatalog">切换已保存方案</summary>
          <button class="text-link" type="button" @click="hideCatalog">收起方案列表</button>
          <p v-if="model.catalogError" role="alert">{{ model.catalogError }} · 当前态势保留</p>
          <p v-if="model.listing" role="status">读取方案目录中…</p>
          <button v-for="plan in model.catalog?.items ?? []" :key="plan.id" class="plan-option" :disabled="model.busy" @click="model.openPlan(plan)">
            <strong>{{ plan.name }} · {{ plan.version }}</strong><span>{{ stateLabels[plan.state] }} · {{ plan.savedAt }}</span>
          </button>
          <p v-if="model.catalog?.total === 0">暂无已保存方案，内置示例仍可查看。</p>
          <div v-if="model.catalog" class="control-actions">
            <button class="btn small" :disabled="model.listing || model.catalog.pageNum <= 1" @click="model.queryPlans(model.catalog.pageNum - 1)">上一页</button>
            <span>第 {{ model.catalog.pageNum }} 页</span>
            <button class="btn small" :disabled="model.listing || model.catalog.pageNum * model.catalog.pageSize >= model.catalog.total" @click="model.queryPlans(model.catalog.pageNum + 1)">下一页</button>
          </div>
        </details>
      </section>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, onMounted, reactive, ref, type Ref } from 'vue';
import MapCanvas from '../components/MapCanvas.vue';
import { gisExampleMetadata, useGisSituation } from '../composables/useGisSituation';
const menuTarget = inject<Ref<HTMLElement | null>>('applicationMenuTarget', ref(null));
const model = reactive(useGisSituation());
const map = ref<InstanceType<typeof MapCanvas>>();
const frame = computed(() => model.frame);
const hoverContext = computed(() => ({ key: frame.value.key + ':' + (model.displayingLiveInterferences ? model.liveInterferences?.revision : 'frozen'),
  source: '节点/设备：' + (frame.value.example ? '受控构造示例 · 冻结规划参数 · 非实测' : '已保存冻结规划参数 · 非实测') + '；' + model.interferenceSourceLabel,
  models: frame.value.example ? gisExampleMetadata.models : [] }));
const lastCheckedTime = computed(() => model.lastCheckedAt ? new Date(model.lastCheckedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '');
function changeAutoFollow(event: Event) { model.setAutoFollow((event.target as HTMLInputElement).checked); }
const coverageDevices = computed(() => frame.value.coverage?.result?.devices.filter(device => device.status === 'COMPLETE') ?? []);
const stateLabels = { SAVED: '已保存', CONFIRMED: '已确认', REFERENCE: '未达标参考' };
function loadCatalog(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !model.catalog && !model.listing) void model.queryPlans();
}
function revealCatalog(event: Event) {
  const picker = (event.currentTarget as HTMLElement).closest('details');
  if (!picker) return;
  picker.open = true;
  if (!model.catalog && !model.listing) void model.queryPlans();
}
function hideCatalog(event: Event) {
  const picker = (event.currentTarget as HTMLElement).closest('details');
  if (picker) picker.open = false;
}
onMounted(() => { void model.initialize(); model.startAutoRefresh(); });
</script>

<style scoped>
.gis-situation { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: #081621; }
.gis-situation :deep(.map-wrap) { min-height: 0; height: 100%; }
.source-badge { position: absolute; left: 76px; top: 20px; display: flex; gap: 9px; align-items: center; max-width: calc(100% - 105px); padding: 9px 12px; border: 1px solid #386179; border-radius: 7px; background: #091b2bdd; color: #c7e0ee; font-size: 11px; pointer-events: none; }
.source-badge strong { font-size: 12px; white-space: nowrap; }
.source-badge > span:last-child { color: #9bb7c9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-dot { width: 6px; height: 6px; border-radius: 50%; background: #6acebb; }
.interference-source-badge { position: absolute; left: 76px; top: 59px; max-width: calc(100% - 105px); margin: 0; padding: 6px 10px; border: 1px solid #79643d; border-radius: 6px; background: #142332ed; color: #e4c88e; font-size: 10px; line-height: 1.7; pointer-events: none; }
.example .source-dot { background: #ecc582; }
.map-notice { position: absolute; bottom: 70px; left: 18px; max-width: min(620px, calc(100% - 36px)); margin: 0; padding: 9px 12px; border: 1px solid #416176; border-radius: 6px; background: #0b2032ed; color: #c7dfef; font-size: 12px; line-height: 1.7; pointer-events: none; }
.map-notice.error { border-color: #876745; color: #efc68f; }
.read-status { position: absolute; right: 18px; top: 20px; padding: 9px 12px; border-radius: 6px; background: #0b2032ed; color: #b4d8f0; font-size: 12px; pointer-events: none; }
.situation-controls { display: grid; gap: 12px; border-top: 1px solid #2f455b; padding-top: 14px; margin-top: 14px; font-size: 12px; }
h2 { margin: 0; color: #e2eff8; font-size: 14px; }
.control-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.frame-label { display: grid; gap: 5px; margin: 0; line-height: 1.7; }
.frame-label span, .source-note { color: #91acbf; }
.source-note { margin: 0; font-size: 11px; line-height: 1.8; }
.layer-options { display: flex; flex-wrap: wrap; gap: 13px; }
label { display: grid; gap: 6px; min-width: 0; color: #bed4e3; }
.layer-options label { display: flex; align-items: center; gap: 6px; }
.auto-follow { display: flex; align-items: flex-start; gap: 7px; line-height: 1.7; }
.input { min-width: 0; width: 100%; }
.plan-picker summary { cursor: pointer; color: #92cce9; padding: 8px 0; }
.plan-option { width: 100%; display: grid; text-align: left; gap: 5px; background: #142d40; border: 1px solid #2d4c62; border-radius: 5px; padding: 9px; color: #c9e0ee; margin: 6px 0; cursor: pointer; }
.plan-option span { color: #98b6c9; font-size: 10px; }
.plan-option:hover { border-color: #6ca5c5; }
@media (max-width: 650px) { .source-badge { left: 66px; top: 18px; } .source-badge > span:last-child { display: none; } .read-status { top: 70px; } }
</style>
