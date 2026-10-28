<template>
  <section
    class="frozen-coverage"
    aria-label="冻结规划覆盖缓存"
  >
    <h3>{{ readonly ? "覆盖结果查看" : "冻结规划覆盖" }}</h3>
    <p v-if="readonly" role="status">只读查看当前方案的已有覆盖；需要生成或调整覆盖时，请进入“调整方案”工作区。</p>
    <p v-if="query.planId.startsWith('PREVIEW-')" role="status">当前覆盖绑定候选作业快照 {{ query.planId.slice(8) }} · {{ query.snapshotId }}；方案保存状态以当前版本信息为准，不会修改基准方案。</p>
    <p class="muted">接收带宽仅用于本次覆盖预测，不改变设备参数或父方案路由指标。</p>
    <label>结果版本<select v-model="coverageVersion" aria-label="覆盖结果版本" :disabled="state.running.value || hasProtectedSelection()">
      <option value="V01-5">预测场强与地形覆盖面</option><option value="V01-4">历史余量采样与环带（只读）</option>
    </select></label>
    <p v-if="query.context==='gis'" class="muted">GIS只读。尚无新版缓存时，请在网络规划中打开同一方案生成新版覆盖结果。</p>
    <p v-if="coverageVersion==='V01-4'" class="muted">历史版本仅回读，不修改带宽或重新计算；切换到“预测场强与地形覆盖面”后可在规划页发起新版计算。</p>
    <p v-if="!active || !currentBinding" role="status">来源或身份已变化，原输入只读保留，请先处理原选择。</p>
    <div v-if="!readonly" class="toolbar">
      <button class="btn small" :disabled="!readable || (!!retainedSelection && !selectionConfirmed) || (bandwidthDirty && !state.bandwidthReceipt.value) || state.bandwidthLoading.value || state.bandwidthSaving.value || !!state.bandwidthPending.value" @click="state.loadBandwidthOptions">刷新带宽选项与选择</button>
      <button v-if="(state.bandwidthPending.value || retainedSelection) && !selectionConfirmed && canWrite" class="btn small" :disabled="state.bandwidthSaving.value || state.bandwidthLoading.value || state.busy.value" @click="retrySelection">核实带宽选择原请求</button>
      <button v-if="retainedSelection && !unverifiedSelection" class="btn small" @click="requestLeave()">放弃失败选择</button>
    </div>
    <p v-if="state.invalidationReason.value" role="status">{{ state.invalidationReason.value }}</p>
    <p v-if="state.bandwidthError.value" role="alert">{{ state.bandwidthError.value }}</p>
    <p v-if="state.bandwidthPending.value" role="status">带宽选择提交未核实，原号 {{ state.bandwidthPending.value.requestId }} 已保留</p>
    <p v-else-if="retainedSelection && !selectionConfirmed && !state.bandwidthSaving.value" role="status">带宽选择保存失败，原号 {{ retainedSelection.requestId }} 及输入已保留</p>
    <details v-if="retainedSelection"><summary>保留的原请求选择 · {{ retainedSelection.requestId }}</summary><p v-for="choice in retainedSelection.choices" :key="choice.device_id">{{ choice.device_id }}：{{ choice.rx_bandwidth_khz }} kHz</p></details>
    <p v-if="leaveError" role="alert">{{ leaveError }}</p>
    <p v-if="state.bandwidthReceipt.value" role="status">带宽选择版本已保存：{{ state.bandwidthReceipt.value.selection_id }}{{ state.bandwidthReady.value ? '' : '；当前选择尚未回读' }}</p>
    <p v-if="state.bandwidthOptions.value?.current_selection" role="status">已回读服务端选择 v{{ state.bandwidthOptions.value.current_selection.version_no }} · {{ state.bandwidthOptions.value.current_selection.selection_id }}</p>
    <FrozenCoverageBandwidthEditor
      v-if="!readonly"
      ref="bandwidthEditor"
      :rows="bandwidthRows" :source-key="bandwidthSource" :writable="canWrite && !state.running.value && !state.pending.value && !retainedSelection && !state.bandwidthPending.value && state.bandwidthReady.value"
      :loading="state.bandwidthLoading.value" :busy="state.busy.value || state.bandwidthSaving.value || !!state.bandwidthPending.value" :error="bandwidthLocalError"
      @dirty-change="bandwidthDirty=$event" @confirm="confirmBandwidth" @discard="discardSelection"
    />
    <div v-if="!readonly" class="toolbar parameters">
      <label
        >超短波半径（km）<input
          v-model.number="radiusKm"
          type="number"
          min="0.25"
          max="120"
          step="0.25"
          :disabled="inputLocked"
      /></label>
      <label
        >网格（m）<input
          v-model.number="cellM"
          type="number"
          min="250"
          max="5000"
          step="250"
          :disabled="inputLocked"
      /></label>
      <label
        >历史缓存方位步长（度）<select
          v-model.number="azStep"
          :disabled="inputLocked"
          ><option
            v-for="value in [1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 18, 20, 24, 30, 36, 40, 45]"
            :key="value"
            :value="value"
            >{{ value }}</option
          ></select
        ></label
      >
      <label
        >时刻（时）<input
          v-model.number="hour"
          type="number"
          min="0"
          max="23.99"
          step="1"
          :disabled="inputLocked"
      /></label>
    </div>
    <label v-if="!readonly">短波最远预测（km）<input v-model.number="hfMaxKm" type="number" min="1" max="900" step="1" :disabled="inputLocked" /></label>
    <p class="muted">超短波按网格计算地形遮蔽；短波使用独立距离范围。方位步长仅用于匹配历史缓存，新版逐格计算不按射线连成圆。覆盖结果为传播模型预测。</p>
    <div class="toolbar">
      <button
        class="btn small"
        :disabled="!readable || state.busy.value || locked || bandwidthDirty || !state.bandwidthReady.value"
        @click="readCache"
        >读取覆盖缓存</button
      >
      <button
        v-if="query.context === 'planning' && canWrite"
        class="btn small"
        :disabled="!readable || locked || state.running.value || bandwidthDirty || !state.bandwidthReady.value"
        @click="state.compute"
        >计算冻结覆盖</button
      >
      <button
        v-if="state.pending.value"
        class="btn small"
        :disabled="state.busy.value || !canWrite"
        @click="state.retry"
        >核实原请求</button
      >
      <button
        v-if="state.knownJobId.value"
        class="btn small"
        :disabled="state.busy.value"
        @click="state.refreshJob"
        >刷新作业</button
      >
      <button
        v-if="state.running.value && canWrite"
        class="btn small"
        :disabled="locked"
        @click="state.cancel"
        >取消覆盖计算</button
      >
    </div>
    <p
      v-if="!services"
      role="status"
      >冻结覆盖服务未接入</p
    >
    <p
      v-if="state.pending.value"
      role="status"
      >请求结果尚未核实，原号 {{ state.pending.value.requestId }} 已保留</p
    >
    <p
      v-if="state.error.value"
      role="alert"
      >{{ state.error.value }}</p
    >
    <p
      v-if="state.job.value"
      role="status"
      >{{ jobLabels[state.job.value.state] }} · {{ Math.round(state.job.value.progress * 100) }}% ·
      {{ state.job.value.stage }}</p
    >
    <p
      v-if="state.cache.value"
      role="status"
      >{{ cacheLabels[state.cache.value.state] }} · {{ state.cache.value.reason }}</p
    >
    <p v-if="state.cache.value?.state === 'HIT'" class="muted">当前显示覆盖的带宽版本：{{ state.cache.value.bandwidth_selection_id || '冻结型号带宽（未使用人工选择）' }}。上方回读的当前选择仅用于下一次计算。</p>
    <template v-if="state.cache.value?.state === 'HIT' && state.cache.value.result">
      <p
        v-if="state.cache.value.result.schema_version === 2 && state.cache.value.result.summary"
        >{{ resultLabels[state.cache.value.result.status] }} ·
        已计算 {{ state.cache.value.result.summary.complete }} / {{ state.cache.value.result.summary.eligible }} 台活动设备 ·
        不可计算 {{ state.cache.value.result.summary.unavailable }} 台（缺带宽 {{ missingBandwidthDevices }} 台，待选带宽 {{ unselectedBandwidthDevices }} 台） ·
        本次无活动链路 {{ state.cache.value.result.summary.skipped }} 台 · 共 {{ state.cache.value.result.summary.total }} 台</p
      >
      <p
        v-else
        >历史结果 · {{ resultLabels[state.cache.value.result.status] }} ·
        {{ completedDevices }} /
        {{ state.devices.value.length }} 台已计算</p
      >
      <div class="toolbar">
        <label
          >覆盖设备<select v-model="state.selectedDeviceId.value"
            ><option
              v-for="device in state.devices.value"
              :key="device.device_id"
              :value="device.device_id"
              >{{ device.device_id }} · {{ device.band ?? '频段未提供' }} ·
              {{ deviceLabels[device.status] }}</option
            ></select
          ></label
        >
        <label
          ><input
            v-model="state.visible.value"
            type="checkbox"
          />覆盖图层</label
        >
        <label v-if="fieldSurface">覆盖显示<select v-model="state.display.value" aria-label="预测覆盖显示方式">
          <option value="strength">强 / 中 / 弱分级</option><option value="field">预测场强热力图</option><option value="boundary">覆盖边界</option>
        </select></label>
      </div>
      <template v-if="fieldSurface">
        <p>预测场强 {{ fieldRange }} dBμV/m · 分辨率：VUHF {{ cellM }} m / HF 1 km。点击地图“全域”查看所选设备的全部覆盖。</p>
        <p v-if="state.display.value==='strength'" class="coverage-strength-legend"><span style="color:#176b3b">■ 强</span>　<span style="color:#84cc7a">■ 中</span>　<span style="color:#f0c541">■ 弱</span></p>
        <p v-else-if="state.display.value==='field'">最低场强 <span style="display:inline-block;width:120px;height:12px;background:linear-gradient(to right,#e7d855,#198f40)"></span> 最高场强（见上方数值范围）</p>
        <p v-else>仅显示已计算格面与环带的边界；静区和未达标格不填色。</p>
        <p class="muted">分级按各频点接收门限以上的场强：强 ≥20 dB，中 ≥10 dB，其余达标格为弱；沿用现有质量显示界限。热力色阶对应上方实际预测场强范围，单位 dBμV/m。</p>
        <details v-if="selected?.band==='HF'"><summary>短波跳距、静区与覆盖距离</summary>
          <p v-for="part in selected.computations" :key="part.freq_khz">{{ part.freq_khz }} kHz · {{ part.skip_distance_m === null ? '当前模型无可返回的单跳天波' : part.skip_distance_m === 0 ? '当前频点与时刻无跳距静区' : `跳距 ${((part.skip_distance_m??0)/1000).toFixed(1)} km` }} · 预测距离上限 {{ ((part.max_distance_m??0)/1000).toFixed(0) }} km</p>
          <p v-for="(ring,index) in hfBands" :key="index">{{ ring.frequency }} kHz · {{ ring.inner }}–{{ ring.outer }} km · {{ ring.note }}{{ ring.covered ? ` · ${ring.field} dBμV/m` : ' · 不绘制为覆盖' }}</p>
          <p>无静区时可呈连续覆盖圆盘；不人为挖孔。环带为假设电离层下的距离预测，不代表远域逐方向地形或实测。</p>
        </details>
      </template>
      <p v-else class="muted">历史覆盖仅含余量采样或旧环带，不是场强面；在规划页重新计算可生成新版预测覆盖，旧缓存保留。</p>
      <p
        v-for="reason in selected?.reasons ?? []"
        :key="reason"
        role="status"
        >{{ reason }}</p
      >
      <p v-if="selected">{{ selectedFrequencies || (selected.status === 'SKIPPED' ? '本次无活动链路' : '无覆盖计算结果') }}</p>
      <p v-if="selected?.bandwidth_provenance">{{ assumptionLabel(selected.bandwidth_provenance) }}</p>
      <p class="muted"
        >{{ fieldSurface ? 'VUHF：逐格地形剖面与预算场强面；HF：地波与天波预算分带，静区不计入覆盖。预测场强。' : 'VUHF：量化网格中心，余量单位 dB；HF：历史覆盖环带，静区不计入覆盖。算法预测场强。' }}</p
      >
      <details
        ><summary>来源与算法限制</summary
        ><dl
          ><dt>资源版本</dt><dd>{{ state.cache.value.anchor.resource_revision }}</dd
          ><dt>DEM 指纹</dt><dd>{{ state.cache.value.anchor.terrain_fingerprint }}</dd
          ><dt>缓存</dt><dd>{{ state.cache.value.cache_key }}</dd></dl
        ><dl v-if="selected?.bandwidth_provenance"
          ><dt>构造资料版本</dt><dd>{{ selected.bandwidth_provenance.source_id }}</dd
          ><dt>构造资料摘要</dt><dd>{{ selected.bandwidth_provenance.source_sha256 }}</dd
          ><dt>原型号带宽</dt><dd>未提供</dd
          ><dt>原始资料标记</dt><dd>{{ originalSourceDoc || '未提供' }}</dd></dl
        ><p
          v-for="note in state.cache.value.result.provenance.limitations"
          :key="note"
          >{{ note }}</p
        ></details
      >
    </template>
    <DecisionDialog :request="leaveDecision" @answer="answerLeave" />
  </section>
</template>
<script setup lang="ts">
import { computed, getCurrentInstance, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useFrozenCoverage } from '../composables/useFrozenCoverage';
import { coverageBandwidthChoices } from '../services/frozen-coverage-decode';
import DecisionDialog from './DecisionDialog.vue';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import FrozenCoverageBandwidthEditor, { type CoverageBandwidthChange, type CoverageBandwidthRow } from './FrozenCoverageBandwidthEditor.vue';
import type {
  FrozenCoverageClient,
  FrozenCoverageBandwidthProvenance,
  FrozenCoverageOverlay,
  FrozenCoverageQuery,
} from '../types/frozen-coverage';
import { ref } from 'vue';
const props = withDefaults(defineProps<{ query: FrozenCoverageQuery; services?: FrozenCoverageClient; active?: boolean; readonly?: boolean }>(),{active:true,readonly:false});
const emit = defineEmits<{ overlay: [value: FrozenCoverageOverlay | null] }>();
const auth = useAuthStore(),
  radiusKm = ref(60),
  cellM = ref(5000),
  azStep = ref(10),
  hour = ref(12);
const hfMaxKm=ref(900);
const coverageVersion=ref<'V01-4'|'V01-5'>('V01-5');
const bandwidthDirty=ref(false),bandwidthLocalError=ref(''),latestReading=ref(false);
const bandwidthEditor=ref<InstanceType<typeof FrozenCoverageBandwidthEditor>>();
const actor=()=>JSON.stringify([auth.identity?.id,auth.identity?.sessionId,auth.generation]);
const cloneQuery=(query:FrozenCoverageQuery):FrozenCoverageQuery=>({...query,...query.bandwidthSelection?{bandwidthSelection:{...query.bandwidthSelection}}:{}});
const binding=shallowRef({actor:actor(),accountId:auth.identity?.id,query:cloneQuery(props.query)});
const currentBinding=computed(()=>binding.value.actor===actor()&&JSON.stringify(binding.value.query)===JSON.stringify(props.query));
const readable = computed(
  () =>
    !!props.services &&
    props.active &&
    !auth.blocked &&
    currentBinding.value &&
    auth.can('planning.view') &&
    (props.query.context !== 'gis' || auth.can('situation.view')),
);
const canWrite = computed(
  () => readable.value && !props.readonly && props.query.context === 'planning' && auth.can('planning.execute') && coverageVersion.value==='V01-5',
);
const guardedClient=computed<FrozenCoverageClient|undefined>(()=>{
  const client=props.services;if(!client)return undefined;
  const current=()=>{if(!readable.value)throw new Error('覆盖来源或身份已变化，原输入只读保留');return client;};
  return {
    getBandwidthOptions:(...args)=>current().getBandwidthOptions(...args),
    saveBandwidthSelection:(...args)=>current().saveBandwidthSelection(...args),
    getBandwidthSelection:(...args)=>current().getBandwidthSelection(...args),
    getCache:(...args)=>current().getCache(...args),
    ...(client.getLatestCache?{getLatestCache:(query:FrozenCoverageQuery,signal?:AbortSignal)=>current().getLatestCache!(query,signal)}:{}),
    compute:(...args)=>current().compute(...args),
    getJob:(...args)=>current().getJob(...args),
    cancel:(...args)=>current().cancel(...args),
  };
});
const state = useFrozenCoverage({
  // 未处理输入或原号时固定来源；失权冻结现场，不把它挂到新账号/新方案。
  query: () => ({...binding.value.query,engineVersion:coverageVersion.value}),
  parameters: () => ({
    radius_m: radiusKm.value * 1000,
    cell_m: cellM.value,
    az_step_deg: azStep.value,
    hour: hour.value,
    hf_max_km:hfMaxKm.value,
  }),
  client: () => guardedClient.value,
  owner: () => binding.value.actor,
  canWrite: () => canWrite.value,
});
type SelectionRequest=NonNullable<typeof state.bandwidthPending.value>;
const retainedSelection=shallowRef<SelectionRequest|null>(null);
const selectionConfirmed=ref(false);
const leaveError=ref(''),leaveDecision=ref<DecisionRequest|null>(null);
let resolveLeave:((value:Decision)=>void)|undefined;
const selectionKey=()=>`frozen-coverage.bandwidth-pending:${JSON.stringify([binding.value.accountId,binding.value.query])}`;
function storeSelection(value:SelectionRequest|null,rejected=false){
  try{if(value)sessionStorage.setItem(selectionKey(),JSON.stringify({...value,rejected}));else sessionStorage.removeItem(selectionKey());}
  catch{ /* 内存与离开保护仍保留原号；不把存储失败当作服务端成功。 */ }
}
function restoreSelection(){
  try{
    const raw=sessionStorage.getItem(selectionKey());if(!raw)return;
    const value=JSON.parse(raw) as SelectionRequest&{rejected?:boolean},query=binding.value.query;
    if(!value||typeof value.requestId!=='string'||!value.requestId.trim()||JSON.stringify(value.query)!==JSON.stringify(query)
      ||value.anchor?.plan_id!==query.planId||value.anchor.task_id!==query.taskId||value.anchor.snapshot_id!==query.snapshotId||value.anchor.resource_revision!==query.resourceRevision)
      throw new Error('保留的带宽请求来源无效，未重放');
    coverageBandwidthChoices(value.choices);retainedSelection.value=value;if(!value.rejected)state.bandwidthPending.value=value;
  }catch(reason){if(typeof sessionStorage!=='undefined')leaveError.value=reason instanceof Error?reason.message:'保留请求不可读取';}
}
watch(state.bandwidthPending,pending=>{
  if(pending){selectionConfirmed.value=false;retainedSelection.value=pending;storeSelection(pending);}
  else if(retainedSelection.value)storeSelection(retainedSelection.value,!selectionConfirmed.value);
},{flush:'sync',immediate:true});
// 新回执且一致回读后才清原号，旧回执不能清掉后来失败的请求。
watch(state.bandwidthReceipt,receipt=>{if(receipt&&retainedSelection.value){selectionConfirmed.value=true;storeSelection(retainedSelection.value);}},{flush:'sync'});
watch(state.bandwidthReady,ready=>{if(ready&&selectionConfirmed.value){retainedSelection.value=null;selectionConfirmed.value=false;storeSelection(null);}},{flush:'sync'});
const unverifiedSelection=computed(()=>state.bandwidthSaving.value||!!state.bandwidthPending.value||!!state.bandwidthReceipt.value&&!state.bandwidthReady.value);
const hasProtectedSelection=()=>bandwidthDirty.value||unverifiedSelection.value||!!retainedSelection.value;
const owner=()=>JSON.stringify([binding.value.actor,binding.value.query]);
watch([actor,()=>JSON.stringify(props.query),hasProtectedSelection,()=>auth.blocked,()=>props.active,()=>props.services,coverageVersion],()=>{
  if(!readable.value)state.stop();
  if(hasProtectedSelection()||leaveDecision.value||auth.blocked)return;
  const changed=!currentBinding.value;
  if(changed)binding.value={actor:actor(),accountId:auth.identity?.id,query:cloneQuery(props.query)};
  bandwidthLocalError.value='';restoreSelection();
  if(readable.value&&!state.bandwidthPending.value&&(changed||!state.bandwidthReady.value))void state.loadBandwidthOptions();
},{immediate:true});
function answerLeave(value:Decision){const resolve=resolveLeave;resolveLeave=undefined;leaveDecision.value=null;resolve?.(value);}
function discardSelection(){
  if(unverifiedSelection.value)return;
  bandwidthEditor.value?.discard();bandwidthDirty.value=false;retainedSelection.value=null;storeSelection(null);leaveError.value='';
}
async function retrySelection(){
  if(!canWrite.value||state.bandwidthSaving.value||state.bandwidthLoading.value||state.busy.value)return;
  if(!state.bandwidthPending.value&&retainedSelection.value)state.bandwidthPending.value=retainedSelection.value;
  await state.retryBandwidthSelection();
}
async function requestLeave(deferDiscard=false){
  if(unverifiedSelection.value){leaveError.value='请先核实带宽选择原请求并回读保存版本，当前原号和输入已保留';return false;}
  if(!hasProtectedSelection())return true;
  if(leaveDecision.value||auth.blocked)return false;
  const session=actor(),source=owner();
  const answer=await new Promise<Decision>(resolve=>{resolveLeave=resolve;leaveDecision.value={title:'未确认的覆盖带宽选择',message:'放弃本次未确认选择后继续？已保存的选择版本与覆盖历史保留。',discardLabel:'放弃未确认选择',cancelLabel:'继续选择'};});
  if(answer!=='discard'||session!==actor()||source!==owner()||auth.blocked)return false;
  if(!deferDiscard)discardSelection();return true;
}
const releaseLeave=auth.registerLeave(()=>requestLeave(true),hasProtectedSelection);
const releaseCleaner=auth.registerCleaner(discardSelection);
let navigationDiscard:{to:string;from:string;source:string;request:SelectionRequest|null;allowed:boolean;committed:boolean}|null=null;
const releaseNavigation=getCurrentInstance()?.appContext.config.globalProperties.$router?.afterEach((to:{fullPath:string},from:{fullPath:string},failure?:unknown)=>{
  const intent=navigationDiscard;
  if(!intent||intent.to!==to.fullPath||intent.from!==from.fullPath)return;
  if(failure||!intent.allowed)navigationDiscard=null;else intent.committed=true;
});
onBeforeRouteLeave(async(to,from)=>{
  const intent={to:to.fullPath,from:from.fullPath,source:owner(),request:retainedSelection.value,allowed:false,committed:false};
  navigationDiscard=intent;
  const allowed=auth.bypassLeave||await requestLeave(true);
  if(navigationDiscard===intent)intent.allowed=allowed;
  return allowed;
});
const beforeUnload=(event:BeforeUnloadEvent)=>{if(hasProtectedSelection()){event.preventDefault();event.returnValue='';}};
onMounted(()=>window.addEventListener('beforeunload',beforeUnload));
onBeforeUnmount(()=>{
  // 其他守卫取消或导航失败不清原号；成功提交且真实卸载才完成本次延迟放弃。
  if(navigationDiscard?.committed&&navigationDiscard.request&&navigationDiscard.source===owner()
    &&navigationDiscard.request===retainedSelection.value&&!unverifiedSelection.value)storeSelection(null);
  releaseNavigation?.();releaseLeave();releaseCleaner();answerLeave('cancel');window.removeEventListener('beforeunload',beforeUnload);
});
async function readCache() {
  if(!readable.value||locked.value||bandwidthDirty.value)return;
  if(props.readonly&&guardedClient.value?.getLatestCache){
    const source={...binding.value.query,engineVersion:coverageVersion.value},captured=JSON.stringify([owner(),source]);
    latestReading.value=true;state.error.value='';
    try{
      const value=await guardedClient.value.getLatestCache(source);
      if(captured!==JSON.stringify([owner(),{...binding.value.query,engineVersion:coverageVersion.value}])||!readable.value||!props.readonly)return;
      radiusKm.value=value.parameters.radius_m/1000;cellM.value=value.parameters.cell_m;
      azStep.value=value.parameters.az_step_deg;hour.value=value.parameters.hour;hfMaxKm.value=value.parameters.hf_max_km;
      state.cache.value=value;state.invalidationReason.value='';
      state.selectedDeviceId.value=value.result?.devices.find(row=>row.status==='COMPLETE')?.device_id??value.result?.devices[0]?.device_id??'';
    }catch(error){if(captured===JSON.stringify([owner(),source]))state.error.value=error instanceof Error?error.message:'已有覆盖读取失败';}
    finally{latestReading.value=false;}
    return;
  }
  await state.loadBandwidthOptions();
  if(readable.value&&state.bandwidthReady.value&&!bandwidthDirty.value&&!locked.value)await state.read();
}
watch(()=>props.readonly,()=>{state.cache.value=null;state.selectedDeviceId.value='';});
defineExpose({requestLeave,hasProtectedSelection,readCache});
const bandwidthSource=computed(()=>JSON.stringify([owner(),state.bandwidthOptions.value?.anchor,state.bandwidthOptions.value?.current_selection?.selection_id,state.bandwidthOptions.value?.current_selection?.selection_hash]));
const assumptionLabel=(source:FrozenCoverageBandwidthProvenance)=>`构造接收假设，非厂家实参 · ${source.source_id} · ${source.source_note}`;
const bandwidthRows=computed<CoverageBandwidthRow[]>(()=>{
  const catalog=state.bandwidthOptions.value,selection=catalog?.current_selection,chosen=new Map(selection?.choices.map(row=>[row.device_id,row.rx_bandwidth_khz]));
  return catalog?.devices.map(row=>{
    // SINGLE_VALUE由服务端明确认证为冻结型号标量，不是从多选项中取第一值。
    const fixed=row.state==='SINGLE_VALUE'?row.options_khz![0]:null,explicit=chosen.has(row.device_id);
    const skipped=catalog!.anchor.engine_version==='V01-4'&&row.state==='NO_ASSIGNED_FREQUENCY';
    const source=explicit?`人工冻结 v${selection!.version_no} · ${selection!.selection_id}`:fixed!==null?'冻结型号单值':row.options_khz?'冻结型号选项；人工未选':'冻结型号无带宽资料';
    return {deviceId:row.device_id,modelId:row.model_id,modelName:row.model_id,optionsKhz:row.options_khz,
      frozenKhz:chosen.get(row.device_id)??fixed,
      frozenSource:row.bandwidth_provenance?`${source} · ${assumptionLabel(row.bandwidth_provenance)}`:source,
      editable:!skipped&&!!row.options_khz?.length,unavailableReason:row.reason,...skipped?{participation:'SKIPPED' as const}:{}};
  })??[];
});
async function confirmBandwidth(value:{sourceKey:string;changes:CoverageBandwidthChange[]}){
  if(retainedSelection.value){bandwidthLocalError.value='请先核实或明确放弃已保留的原请求';return;}
  if(value.sourceKey!==bandwidthSource.value||!canWrite.value||!state.bandwidthReady.value||state.running.value||state.pending.value||state.bandwidthPending.value)return;
  bandwidthLocalError.value='';
  const current=new Map(bandwidthRows.value.map(row=>[row.deviceId,row])),choices=new Map(state.bandwidthOptions.value?.current_selection?.choices.map(row=>[row.device_id,row.rx_bandwidth_khz]));
  for(const change of value.changes){const row=current.get(change.deviceId);
    if(!row||!row.editable||row.participation==='SKIPPED'||row.frozenKhz!==change.before||!row.optionsKhz?.includes(change.bandwidthKhz)){bandwidthLocalError.value='带宽选择来源或前态已变化，未提交';return;}
    choices.set(change.deviceId,change.bandwidthKhz);
  }
  await state.saveBandwidthSelection([...choices].map(([device_id,rx_bandwidth_khz])=>({device_id,rx_bandwidth_khz})));
}
const locked = computed(() => latestReading.value || state.busy.value || !!state.pending.value || state.bandwidthSaving.value || state.bandwidthLoading.value || !!state.bandwidthPending.value);
const inputLocked = computed(() => locked.value || state.running.value);
const selected = computed(() =>
  state.devices.value.find((row) => row.device_id === state.selectedDeviceId.value),
);
const fieldSurface=computed(()=>state.cache.value?.anchor.engine_version==='V01-5');
const selectedFeatures=computed(()=>selected.value?.computations.flatMap(part=>part.geojson.features)??[]);
const fieldRange=computed(()=>{
  const values=selectedFeatures.value.filter(row=>row.geometry&&row.properties.is_coverage).map(row=>row.properties.field_strength_dbuvm).filter((v):v is number=>typeof v==='number'&&Number.isFinite(v));
  if(!values.length)return '无达标采样';
  let lo=Infinity,hi=-Infinity;for(const value of values){lo=Math.min(lo,value);hi=Math.max(hi,value);}
  return `${lo.toFixed(1)}–${hi.toFixed(1)}`;
});
const hfBands=computed(()=>selectedFeatures.value.map(row=>({frequency:row.properties.freq_khz,
  inner:((row.properties.inner_m??0)/1000).toFixed(0),outer:((row.properties.outer_m??0)/1000).toFixed(0),
  note:row.properties.note??'',covered:row.properties.is_coverage,field:row.properties.field_strength_dbuvm?.toFixed(1)??'未提供'})));
const completedDevices = computed(() => state.devices.value.filter(row => row.status === 'COMPLETE').length);
const missingBandwidthDevices = computed(() => state.devices.value.filter(row => row.status === 'UNAVAILABLE' && row.reason_code === 'RX_BANDWIDTH_UNKNOWN').length);
const unselectedBandwidthDevices = computed(() => state.devices.value.filter(row => row.status === 'UNAVAILABLE' && row.reason_code === 'RX_BANDWIDTH_SELECTION_REQUIRED').length);
const selectedFrequencies = computed(() => selected.value?.computations.map(part => `${part.freq_khz} kHz`).join(' / '));
const originalSourceDoc = computed(() => typeof selected.value?.frozen_model?.source_doc === 'string' ? selected.value.frozen_model.source_doc : '');
const deviceLabels = { COMPLETE: '已计算', UNAVAILABLE: '不可计算', SKIPPED: '本次无活动链路' };
const jobLabels = {
  PENDING: '排队中',
  RUNNING: '计算中',
  SUCCESS: '完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  INTERRUPTED: '服务重启中断',
};
const cacheLabels = {
  HIT: '已命中冻结缓存',
  MISS: '尚无此参数缓存',
  STALE: 'DEM 来源已变化，缓存不显示',
};
const resultLabels = {
  COMPLETE: '完整预测',
  PARTIAL: '部分设备缺少必要输入',
  UNAVAILABLE: '未得到可计算设备',
  NOT_APPLICABLE: '本次无活动链路',
};
watch(state.overlay, (value) => emit('overlay', value), { immediate: true });
onBeforeUnmount(() => emit('overlay', null));
</script>
<style scoped>
.frozen-coverage {
  padding: 10px 0;
  border-top: 1px solid var(--line);
  font-size: 12px;
  min-width: 0;
}
h3 {
  font-size: 14px;
  margin: 0 0 10px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
  align-items: end;
}
label {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
}
.parameters label {
  flex-direction: column;
  align-items: start;
}
input[type='number'] {
  width: 85px;
}
input,
select {
  background: #0c1b2d;
  color: inherit;
  border: 1px solid #30485f;
  padding: 5px;
  min-width: 0;
  max-width: 100%;
}
p,
dd {
  overflow-wrap: anywhere;
  margin: 8px 0;
}
.muted {
  color: var(--muted);
}
summary {
  cursor: pointer;
}
details {
  max-height: 200px;
  overflow: auto;
}
</style>
