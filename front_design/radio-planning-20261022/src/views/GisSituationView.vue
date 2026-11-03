<template>
  <section class="situation-screen">
    <header class="situation-heading"><div><p class="eyebrow">RADIO NETWORK · SITUATION</p><h1>GIS 态势 <span>规划成果总览</span></h1></div><div class="actions"><span class="readonly"><i class="pi pi-lock" />只读浏览</span><label><input v-model="autoRefresh" type="checkbox" />30 秒刷新</label><button class="btn" :disabled="loading" @click="refresh"><i class="pi pi-refresh" />刷新</button><button class="btn primary" :disabled="loading" @click="latest">返回最新结果</button></div></header>
    <div class="source-strip"><span class="status-dot" /><strong>{{ frame?.plan.name || '待选择规划方案' }}</strong><span v-if="frame">{{ frame.plan.taskId }} · {{ frame.plan.version }} · {{ stateLabel[frame.plan.state] }}</span><span class="mode">{{ env.mode === 'mock' ? 'Mock 本地示例' : '冻结方案 · 规划预测' }}</span></div>
    <p v-if="error" class="message error" role="alert">{{ error }}</p><p v-if="notice" class="message" role="status">{{ notice }}</p>
    <div v-if="newest" class="new-version" role="status">有新保存方案：{{ newest.name }} · {{ newest.version }}<button class="text-link" :disabled="loading" @click="chooseNewPlan">切换查看</button><span>当前画面保持原版本</span></div>
    <!-- 控制区放在地图之外，避免方案、覆盖和地图自带控件相互遮挡。 -->
    <div class="situation-controls">
      <div class="selector"><label for="situation-plan"><i class="pi pi-folder" />任务与方案</label><select id="situation-plan" aria-label="选择已保存方案" :value="frame?.plan.id || ''" :disabled="loading" @change="choosePlan"><option value="">选择已保存方案</option><option v-for="row in rows" :key="row.id" :value="row.id">{{ row.name }} · {{ row.version }} · {{ stateLabel[row.state] }} · {{ row.taskId }}</option></select><div class="paging"><button class="text-link" :disabled="page <= 1 || loading" @click="readPage(page-1)">上一页</button><span>{{ total }} 份 · 第 {{ page }} 页</span><button class="text-link" :disabled="page*10 >= total || loading" @click="readPage(page+1)">下一页</button></div><p class="muted">{{ frame ? `保存 ${time(frame.plan.savedAt)} · 读取 ${time(frame.readAt)}` : '按保存时间倒序排列，仅显示已保存成果' }}</p></div>
      <div v-if="frame" class="coverage-controls"><label for="situation-device"><i class="pi pi-wifi" />设备覆盖</label><select id="situation-device" v-model="deviceId" aria-label="覆盖设备" :disabled="loading" @change="deviceChanged"><option value="">选择一台设备</option><option v-for="d in frame.network.devices" :key="d.id" :value="d.id">{{ d.device_class }} · {{ d.id }} · {{ d.station_id }} · {{ coverageDeviceStatus(d.id) }}</option></select><select v-model="display" aria-label="覆盖显示方式"><option value="field">场强等值线</option><option value="strength">强 / 中 / 弱</option><option value="boundary">通信门限线</option></select><label class="coverage-toggle"><input v-model="coverageVisible" type="checkbox" :disabled="loading || selectedCoverage?.status !== 'COMPLETE' || frame.coverage?.state !== 'HIT'" @change="coverageChanged" />显示覆盖</label>
        <div class="coverage-actions"><label v-if="frequencies.length>1">频点<select :value="selectedFrequency" aria-label="覆盖频点" @change="chooseFrequency"><option v-for="f in frequencies" :key="f" :value="f">{{ f }} kHz</option></select></label><span v-else-if="selectedFrequency">{{ selectedFrequency }} kHz</span><label><input v-model="terrainReference" type="checkbox" :disabled="!coverageOverlay || display==='boundary'" />显示地形影响标记</label><button class="text-link" :disabled="!coverageOverlay" @click="focusCoverage()">定位覆盖</button><button class="text-link" @click="mapCanvas?.fit()">返回全网</button></div>
        <p v-if="coverageMessage">{{ coverageMessage }}</p><RouterLink v-if="frame.coverage?.state!=='HIT'" :to="{path:'/planning',query:{taskId:frame.plan.taskId,planId:frame.plan.id}}" class="text-link">打开同一方案的覆盖计算</RouterLink>
        <details v-if="selectedCoverage?.status==='COMPLETE' && frame.coverage?.state==='HIT'"><summary>参数与来源</summary>
          <p>计算半径 {{ localRadiusKm }} km · 网格 {{ frame.coverage.parameters.cell_m }} m · 功率 {{ selectedCoverage.radio_parameters?.tx_dbm ?? '未提供' }} dBm · 天线高度 {{ selectedCoverage.radio_parameters?.height ?? '未提供' }} m</p>
          <p>预测覆盖已考虑地形，非现场实测。计算半径不代表最远通信距离；关闭地形影响标记仍保留地形计算。等值线在有效采样间插值，悬停读取原始采样；精度受网格分辨率限制。</p>
          <p v-if="display==='field' && coverageRange">所选设备 {{ coverageRange.min.toFixed(1) }}–{{ coverageRange.max.toFixed(1) }} dBμV/m；同一方案采用统一场强刻度。</p>
          <p v-if="display==='boundary' && coverageRange">门限线按接收余量判定，遇缺格或计算边缘不补闭合。</p>
          <p>{{ coverageView?.evaluated === undefined ? '已评估采样数未提供' : `所选频点达标 ${coverageView.features.length} / ${coverageView.evaluated} 个采样点` }}；不代表面积覆盖率。空白可能为未达门限、计算范围外或缺少地形数据，不能统一判为遮挡。</p><p>{{ frame.network.identity.snapshot_id }} · {{ frame.network.identity.resource_revision }}</p>
        </details>
      </div>
    </div>
    <div class="situation-map">
      <MapCanvas ref="mapCanvas" :stations="[]" resource-read gis-surface :readonly-situation="true" :frozen-network="frame?.network" :terrain-basemap="frame?.terrain" :frozen-coverage="coverageOverlay" :frozen-selected-device-id="deviceId" :resource-bounds="dimensions?.bbox" :hover-preview="hoverContext" :map-caption="frame?.terrain ? '冻结 DEM 地形' : '未提供可核验地形底图'" watermark-caption="PLANNING SITUATION" @select-frozen-device="chooseDevice" />
      <div v-if="!frame" class="empty-state"><i class="pi pi-map" /><h2>{{ loading ? '正在读取规划成果…' : '选择一份规划成果，查看完整网络' }}</h2><p>展示已保存方案的节点、链路与已有覆盖。编辑与标绘请进入 GIS 工作台。</p><RouterLink to="/gis-workbench" class="btn">进入 GIS 工作台</RouterLink></div>
      <div v-if="loading && frame" class="loading-pill" role="status">正在刷新，保留当前画面…</div>
    </div>
    <aside class="legend"><strong>图例</strong>
      <template v-if="!mapCanvas?.coverageFocus"><div><span v-for="row in qualities" :key="row.label"><b :style="{background:row.color}" />{{ row.label }}</span></div><p title="图标：青绿正常、青蓝状态未提供、橙色告警、红色故障、灰色离线。聚合数字统计设备而非节点；悬停查看成员及缺失信息。">实线 主链路 · 虚线 备用链路 · 蓝色数字 设备数（HF / VUHF 分类） · 青蓝图标 状态未提供 · 外圈 选中对象</p></template>
      <template v-if="coverageOverlay && coverageView">
        <CoverageLineLegend :display="display" :has-grid="!!coverageView.grid" :boundary-status="coverageView.boundaryStatus" :margin-min-db="coverageOverlay.result.provenance.parameters.margin_min_db" />
        <div v-if="display==='strength'"><span><b style="background:#22a05a" />强 ≥20 dB</span><span><b style="background:#f0c541" />中 ≥10 dB</span><span><b style="background:#ee8735" />弱（其余达标格）</span></div>
        <span v-if="terrainReference && display!=='boundary'"><b class="terrain-hatch" />斜纹：{{ selectedCoverage?.band==='HF'?'有地形附加损耗':'非通视' }}</span>
      </template>
    </aside>
    <footer class="situation-footer"><template v-if="mapCanvas?.coverageFocus && coverageOverlay"><span>{{ selectedCoverage?.device_id }} · {{ selectedFrequency }} kHz</span><span>计算半径 {{ localRadiusKm }} km · 采样间隔 {{ frame?.coverage?.parameters.cell_m }} m</span></template><template v-else><span v-if="frame">{{ frame.network.nodes.length }} 节点 · {{ frame.network.devices.length }} 设备 · {{ frame.network.links.length }} 链路</span><span :title="dimensions?.detailLabel">{{ dimensions?.label }}</span></template><span>WGS84 · EPSG:4326</span></footer>
    <p v-for="message in frame?.notices || []" :key="message" class="data-note">{{ message }}</p><p v-if="frame?.plan.sourceChanged" class="data-note">当前资源已变化，本页仍展示所选方案保存时的冻结网络。</p>
  </section>
</template>
<script setup lang="ts">
import { computed, watch, ref, nextTick } from 'vue';
import MapCanvas from '../components/MapCanvas.vue';
import CoverageLineLegend from '../components/CoverageLineLegend.vue';
import { useAuthStore } from '../stores/auth';
import { env } from '../config/env';
import { useGisSituation } from '../composables/useGisSituation';
import { LINK_STATUS_STYLES } from '../config/link-status';
import { coverageFrequencies, frozenCoverageView } from '../maps/frozen-coverage-layers';
const auth=useAuthStore();
const readable=()=>!auth.blocked&&auth.can('situation.view')&&auth.can('planning.view');
const state=useGisSituation(readable,()=>auth.generation);
const {frame,rows,loading,error,notice,newest,autoRefresh,page,total,deviceId,coverageVisible,display,frequencyKhz,selectedFrequency,terrainReference,coverageOverlay,dimensions,catalog,select,latest,refresh,reset}=state;
const mapCanvas=ref<InstanceType<typeof MapCanvas>>();
const stateLabel={SAVED:'已保存',REFERENCE:'参考方案 · 未达标或来源变化',CONFIRMED:'已确认'};
const qualities=Object.values(LINK_STATUS_STYLES);
const hoverContext=computed(()=>frame.value?{key:JSON.stringify([frame.value.network.identity.task_id,frame.value.network.identity.plan_id,frame.value.network.identity.snapshot_id]),source:frame.value.plan.name+' · '+frame.value.plan.version,models:[]}:undefined);
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{hour12:false});
const selectedCoverage=computed(()=>frame.value?.coverage?.result?.devices.find(d=>d.device_id===deviceId.value));
const frequencies=computed(()=>coverageFrequencies(selectedCoverage.value));
const coverageView=computed(()=>coverageOverlay.value?frozenCoverageView(coverageOverlay.value):null);

const coverageRange=computed(()=>coverageView.value&&Number.isFinite(coverageView.value.min)?coverageView.value:null);
const localRadiusKm=computed(()=>{const p=frame.value?.coverage?.parameters;return p?(selectedCoverage.value?.band==='HF'?Math.min(p.radius_m/1000,p.hf_max_km):p.radius_m/1000):undefined;});
const coverageStatuses=computed(()=>new Map(frame.value?.coverage?.result?.devices.map(d=>[d.device_id,d.status])));
function coverageDeviceStatus(id:string){const status=coverageStatuses.value.get(id);return status==='COMPLETE'?'已计算':status==='UNAVAILABLE'?'不可计算':status==='SKIPPED'?'本次无活动链路':'未提供覆盖';}
const coverageMessage=computed(()=>{const cache=frame.value?.coverage;if(cache?.state!=='HIT')return cache?.reason||'尚无已计算覆盖，请在网络规划中计算并保存覆盖结果。';const d=selectedCoverage.value;return !deviceId.value?'选择设备以查看已有覆盖':d?.status==='COMPLETE'?'':coverageDeviceStatus(deviceId.value)+'：'+(d?.reasons.join('；')||'此设备未提供可显示的覆盖。');});
function choosePlan(event:Event){const row=rows.value.find(p=>p.id===(event.target as HTMLSelectElement).value);if(row)void select(row);}
const focusKey=()=>`${auth.generation}:${frame.value?.plan.id}:${frame.value?.network.identity.snapshot_id}:${deviceId.value}:${selectedFrequency.value}`;
async function focusCoverage(preserveScale=false){const key=focusKey();await nextTick();if(readable()&&coverageOverlay.value&&key===focusKey())mapCanvas.value?.fitFrozenCoverage(preserveScale);}
function coverageChanged(){if(coverageVisible.value)void focusCoverage(true);}
function deviceChanged(){coverageVisible.value=frame.value?.coverage?.state==='HIT'&&selectedCoverage.value?.status==='COMPLETE';if(coverageVisible.value)void focusCoverage(true);}
function chooseFrequency(event:Event){frequencyKhz.value=Number((event.target as HTMLSelectElement).value);if(coverageVisible.value)void focusCoverage(true);}
function chooseDevice(id:string){if(!loading.value&&readable()&&frame.value?.network.devices.some(d=>d.id===id)){deviceId.value=id;deviceChanged();}}
async function readPage(value:number){try{await catalog(value);}catch(e){error.value=e instanceof Error?e.message:'目录读取失败';}}
async function chooseNewPlan(){const row=newest.value;if(!row)return;await select(row);
  // 新成果可能尚未进入当前目录页，切换成功后同步首页，避免下拉框显示为空。
  if(frame.value?.plan.id===row.id)await readPage(1);
}
// 服务读取会重新接纳同值身份；分别比较代次和权限，避免数组引用变化触发无限重读。
watch([()=>auth.generation,readable],()=>{reset();if(readable())void latest();},{immediate:true});
</script>
<style scoped>
.situation-screen { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 660px; padding: 18px 22px 14px; }
.situation-heading, .actions, .source-strip, .situation-footer, .paging { display: flex; align-items: center; gap: 14px; }
.situation-heading { justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.eyebrow { font-size: 10px; letter-spacing: 2px; color: #6c9ab8; margin: 0 0 5px; }
h1 { margin: 0; font-size: 23px; }
h1 span { font-size: 12px; font-weight: 400; color: #8da7bf; margin-left: 10px; }
.actions { font-size: 12px; flex-wrap: wrap; gap: 12px; }
.actions label, .coverage-toggle { flex-direction: row; align-items: center; gap: 6px; white-space: nowrap; }
.readonly { display: flex; align-items: center; gap: 6px; color: #7fd1c9; }
.source-strip { padding: 9px 12px; border: 1px solid #244159; border-radius: 7px; background: linear-gradient(100deg, #112c42, #0f1b2c); font-size: 12px; flex-wrap: wrap; gap: 8px 14px; }
.source-strip strong { overflow-wrap: anywhere; }
.status-dot { width: 7px; height: 7px; flex-shrink: 0; border-radius: 50%; background: #58c8c7; box-shadow: 0 0 10px #58c8c755; }
.source-strip .mode { margin-left: auto; color: #88a8bd; }
.situation-controls { display: flex; gap: 16px; padding: 12px 14px; border: 1px solid #263d54; border-radius: 7px; background: #101e30; font-size: 12px; }
.selector, .coverage-controls { display: grid; align-items: center; gap: 8px 12px; min-width: 0; flex: 1; }
.selector { grid-template-columns: minmax(0, 1fr) auto; }
.selector > label, .coverage-controls > label:first-child { grid-column: 1 / -1; flex-direction: row; align-items: center; gap: 6px; font-weight: 600; color: #b5cce0; }
.selector select, .coverage-controls select { width: 100%; max-width: 100%; height: 34px; padding: 6px 9px; font-size: 12px; }
.paging { gap: 9px; font-size: 11px; white-space: nowrap; }
.coverage-controls { grid-template-columns: minmax(150px, 1fr) minmax(130px, 160px) auto; border-left: 1px solid #263d54; padding-left: 16px; }
.coverage-actions { grid-column:1/-1;display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px; }
.coverage-actions label { display:flex;flex-direction:row;align-items:center;gap:5px; }
.coverage-actions select { width:auto; }
.coverage-controls details { grid-column:1/-1;font-size:11px;color:#91a9bd; }
.terrain-hatch { height:9px !important;background:repeating-linear-gradient(135deg,#b5cce0 0 1px,transparent 1px 5px);border:1px solid #8ca9bf; }
.selector p, .coverage-controls p { grid-column: 1 / -1; color: #839eb6; line-height: 1.5; margin: 0; font-size: 11px; overflow-wrap: anywhere; }
.situation-map { position: relative; min-height: 360px; flex: 1 0 360px; border: 1px solid #263d54; border-radius: 9px; overflow: hidden; background: #0d1a2b; }
.situation-map :deep(.map-wrap) { height: 100%; min-height: 0; }
.situation-map :deep(.map-watermark), .situation-map :deep(.map-legend) { display: none; }
.legend { display: flex; align-items: center; gap: 10px 20px; flex-wrap: wrap; font-size: 11px; color: #93aabd; }
.legend strong { color: #b5cce0; font-weight: 500; }
.legend div { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.legend p { margin: 0; line-height: 1.6; }
.legend b { display: inline-block; width: 15px; height: 3px; vertical-align: middle; margin-right: 5px; }
.empty-state { position: absolute; inset: 70px 20px 45px; display: flex; align-items: center; justify-content: center; text-align: center; flex-direction: column; color: #a0b4c7; }
.empty-state > i { font-size: 38px; color: #4d8ba9; }
.empty-state h2 { font-size: 18px; margin: 16px 0 4px; }
.empty-state p { line-height: 1.8; max-width: 460px; margin: 8px 0 18px; }
.situation-footer { justify-content: space-between; color: #8fa9be; font-size: 11px; flex-wrap: wrap; gap: 8px; }
.data-note { font-size: 11px; line-height: 1.5; color: #a9b5c1; margin: 0; }
.message, .new-version { padding: 10px 14px; background: #112c42; border: 1px solid #33546b; border-radius: 6px; font-size: 12px; margin: 0; }
.error { color: #ffc2c6; border-color: #864c5e; }
.new-version { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.new-version span { color: #a5b9c9; }
.loading-pill { position: absolute; bottom: 14px; left: 20px; background: #132e43; padding: 8px 14px; border-radius: 18px; font-size: 12px; z-index: 5; }
@media (max-width: 1200px) {
  .situation-controls { gap: 12px; }
  .selector { flex: 0.85; grid-template-columns: minmax(0, 1fr); }
  .paging { justify-content: space-between; }
  .coverage-controls { grid-template-columns: minmax(140px, 1fr) minmax(130px, 160px); }
  .coverage-toggle { grid-column: 1 / -1; }
}
@media (max-width: 800px) {
  .situation-screen { height: auto; min-height: 100%; padding: 14px; }
  .situation-heading { align-items: flex-start; }
  .actions { gap: 10px; }
  .situation-controls { flex-direction: column; }
  .coverage-controls { border-left: 0; border-top: 1px solid #263d54; padding: 12px 0 0; }
  .source-strip .mode { margin-left: 0; }
  .situation-map { flex: none; height: 440px; }
  .legend { gap: 8px 12px; }
}
</style>
