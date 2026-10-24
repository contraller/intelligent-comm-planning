<template>
  <section
    class="frozen-coverage"
    aria-label="冻结规划覆盖缓存"
  >
    <h3>冻结规划覆盖</h3>
    <p class="muted">接收带宽仅用于本次覆盖预测，不改变设备参数或父方案路由指标。</p>
    <div class="toolbar">
      <button class="btn small" :disabled="!readable || bandwidthDirty || state.bandwidthLoading.value || state.bandwidthSaving.value || !!state.bandwidthPending.value" @click="state.loadBandwidthOptions">刷新带宽选项与选择</button>
      <button v-if="state.bandwidthPending.value && canWrite" class="btn small" :disabled="state.bandwidthSaving.value || state.busy.value" @click="state.retryBandwidthSelection">核实带宽选择原请求</button>
    </div>
    <p v-if="state.bandwidthError.value" role="alert">{{ state.bandwidthError.value }}</p>
    <p v-if="state.bandwidthPending.value" role="status">带宽选择提交未核实，原号 {{ state.bandwidthPending.value.requestId }} 已保留</p>
    <p v-if="state.bandwidthReceipt.value" role="status">带宽选择版本已保存：{{ state.bandwidthReceipt.value.selection_id }}{{ state.bandwidthReady.value ? '' : '；当前选择尚未回读' }}</p>
    <p v-if="state.bandwidthOptions.value?.current_selection" role="status">已回读服务端选择 v{{ state.bandwidthOptions.value.current_selection.version_no }} · {{ state.bandwidthOptions.value.current_selection.selection_id }}</p>
    <FrozenCoverageBandwidthEditor
      :rows="bandwidthRows" :source-key="bandwidthSource" :writable="canWrite && !state.running.value && !state.pending.value && !state.bandwidthPending.value && state.bandwidthReady.value"
      :loading="state.bandwidthLoading.value" :busy="state.busy.value || state.bandwidthSaving.value" :error="bandwidthLocalError"
      @dirty-change="bandwidthDirty=$event" @confirm="confirmBandwidth"
    />
    <div class="toolbar parameters">
      <label
        >半径（km）<input
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
        >方位步长（度）<select
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
    <div class="toolbar">
      <button
        class="btn small"
        :disabled="!readable || state.busy.value || locked || bandwidthDirty || !state.bandwidthReady.value"
        @click="state.read"
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
    <template v-if="state.cache.value?.state === 'HIT' && state.cache.value.result">
      <p
        >{{ resultLabels[state.cache.value.result.status] }} ·
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
              {{ device.status === 'COMPLETE' ? '已计算' : '不可计算' }}</option
            ></select
          ></label
        >
        <label
          ><input
            v-model="state.visible.value"
            type="checkbox"
          />覆盖图层</label
        >
      </div>
      <p
        v-for="reason in selected?.reasons ?? []"
        :key="reason"
        role="status"
        >{{ reason }}</p
      >
      <p v-if="selected">{{ selectedFrequencies || '无已分配频率' }}</p>
      <p class="muted"
        >VUHF：量化网格中心，余量单位 dB；HF：覆盖环带，静区不计入覆盖。算法预测，非实测场强。</p
      >
      <details
        ><summary>来源与算法限制</summary
        ><dl
          ><dt>资源版本</dt><dd>{{ state.cache.value.anchor.resource_revision }}</dd
          ><dt>DEM 指纹</dt><dd>{{ state.cache.value.anchor.terrain_fingerprint }}</dd
          ><dt>缓存</dt><dd>{{ state.cache.value.cache_key }}</dd></dl
        ><p
          v-for="note in state.cache.value.result.provenance.limitations"
          :key="note"
          >{{ note }}</p
        ></details
      >
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useFrozenCoverage } from '../composables/useFrozenCoverage';
import FrozenCoverageBandwidthEditor, { type CoverageBandwidthChange, type CoverageBandwidthRow } from './FrozenCoverageBandwidthEditor.vue';
import type {
  FrozenCoverageClient,
  FrozenCoverageOverlay,
  FrozenCoverageQuery,
} from '../types/frozen-coverage';
import { ref } from 'vue';
const props = defineProps<{ query: FrozenCoverageQuery; services?: FrozenCoverageClient }>();
const emit = defineEmits<{ overlay: [value: FrozenCoverageOverlay | null] }>();
const auth = useAuthStore(),
  radiusKm = ref(60),
  cellM = ref(5000),
  azStep = ref(10),
  hour = ref(12);
const bandwidthDirty=ref(false),bandwidthLocalError=ref('');
const readable = computed(
  () =>
    !!props.services &&
    !auth.blocked &&
    auth.can('planning.view') &&
    (props.query.context !== 'gis' || auth.can('situation.view')),
);
const canWrite = computed(
  () => readable.value && props.query.context === 'planning' && auth.can('planning.execute'),
);
const state = useFrozenCoverage({
  query: () => (readable.value ? props.query : null),
  parameters: () => ({
    radius_m: radiusKm.value * 1000,
    cell_m: cellM.value,
    az_step_deg: azStep.value,
    hour: hour.value,
  }),
  client: () => props.services,
  owner: () => JSON.stringify([auth.identity?.id, auth.identity?.sessionId, auth.generation]),
  canWrite: () => canWrite.value,
});
const owner=()=>JSON.stringify([auth.identity?.id,auth.identity?.sessionId,auth.generation,readable.value?props.query:null]);
watch(owner,()=>{bandwidthDirty.value=false;bandwidthLocalError.value='';void state.loadBandwidthOptions();},{immediate:true});
const bandwidthSource=computed(()=>JSON.stringify([owner(),state.bandwidthOptions.value?.anchor,state.bandwidthOptions.value?.current_selection?.selection_id,state.bandwidthOptions.value?.current_selection?.selection_hash]));
const bandwidthRows=computed<CoverageBandwidthRow[]>(()=>{
  const catalog=state.bandwidthOptions.value,selection=catalog?.current_selection,chosen=new Map(selection?.choices.map(row=>[row.device_id,row.rx_bandwidth_khz]));
  return catalog?.devices.map(row=>{
    // SINGLE_VALUE由服务端明确认证为冻结型号标量，不是从多选项中取第一值。
    const fixed=row.state==='SINGLE_VALUE'?row.options_khz![0]:null,explicit=chosen.has(row.device_id);
    return {deviceId:row.device_id,modelId:row.model_id,modelName:row.model_id,optionsKhz:row.options_khz,
      frozenKhz:chosen.get(row.device_id)??fixed,
      frozenSource:explicit?`人工冻结 v${selection!.version_no} · ${selection!.selection_id}`:fixed!==null?'冻结型号单值':row.options_khz?'冻结型号选项；人工未选':'冻结型号无带宽资料',
      editable:!!row.options_khz?.length,unavailableReason:row.reason};
  })??[];
});
async function confirmBandwidth(value:{sourceKey:string;changes:CoverageBandwidthChange[]}){
  if(value.sourceKey!==bandwidthSource.value||!canWrite.value||!state.bandwidthReady.value||state.running.value||state.pending.value||state.bandwidthPending.value)return;
  bandwidthLocalError.value='';
  const current=new Map(bandwidthRows.value.map(row=>[row.deviceId,row])),choices=new Map(state.bandwidthOptions.value?.current_selection?.choices.map(row=>[row.device_id,row.rx_bandwidth_khz]));
  for(const change of value.changes){const row=current.get(change.deviceId);
    if(!row||row.frozenKhz!==change.before||!row.optionsKhz?.includes(change.bandwidthKhz)){bandwidthLocalError.value='带宽选择来源或前态已变化，未提交';return;}
    choices.set(change.deviceId,change.bandwidthKhz);
  }
  await state.saveBandwidthSelection([...choices].map(([device_id,rx_bandwidth_khz])=>({device_id,rx_bandwidth_khz})));
}
const locked = computed(() => state.busy.value || !!state.pending.value || state.bandwidthSaving.value || state.bandwidthLoading.value || !!state.bandwidthPending.value);
const inputLocked = computed(() => locked.value || state.running.value);
const selected = computed(() =>
  state.devices.value.find((row) => row.device_id === state.selectedDeviceId.value),
);
const completedDevices = computed(() => state.devices.value.filter(row => row.status === 'COMPLETE').length);
const selectedFrequencies = computed(() => selected.value?.computations.map(part => `${part.freq_khz} kHz`).join(' / '));
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
