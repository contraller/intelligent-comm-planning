<template>
  <section
    class="frozen-coverage"
    aria-label="冻结规划覆盖缓存"
  >
    <h3>冻结规划覆盖</h3>
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
        :disabled="!readable || state.busy.value"
        @click="state.read"
        >读取覆盖缓存</button
      >
      <button
        v-if="query.context === 'planning' && canWrite"
        class="btn small"
        :disabled="!readable || locked || state.running.value"
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
        {{ state.devices.value.filter((row) => row.status === 'COMPLETE').length }} /
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
      <p v-if="selected">{{
        selected.computations.map((part) => `${part.freq_khz} kHz`).join(' / ') || '无已分配频率'
      }}</p>
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
const locked = computed(() => state.busy.value || !!state.pending.value);
const inputLocked = computed(() => locked.value || state.running.value);
const selected = computed(() =>
  state.devices.value.find((row) => row.device_id === state.selectedDeviceId.value),
);
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
