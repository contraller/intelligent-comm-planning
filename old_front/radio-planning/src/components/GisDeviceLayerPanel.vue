<template>
  <section
    class="device-layer-panel"
    aria-label="设备点位显示控制"
  >
    <h3>设备点位</h3>
    <p v-if="statusSource">设备状态来源：{{ statusSource }}；节点仍使用自身台账基线。</p>
    <p
      v-if="!available"
      class="notice"
      role="status"
      >仅在有查看权限的普通资源地图中控制设备点位；当前显示偏好已保留。</p
    >
    <div
      v-for="type in GIS_DEVICE_TYPES"
      :key="type"
      class="device-layer-row"
    >
      <label
        ><input
          type="checkbox"
          :checked="settings[type].visible"
          :disabled="!available"
          :aria-label="`显示${type}设备`"
          @change="
            available &&
            emit('configure', type, { visible: ($event.target as HTMLInputElement).checked })
          "
        />{{ type === 'HF' ? '◇ 短波设备 HF' : '□ 超短波设备 VUHF' }}</label
      >
      <label
        >透明度 {{ Math.round(settings[type].opacity * 100) }}%<input
          type="range"
          min="0"
          max="1"
          step="0.1"
          :value="settings[type].opacity"
          :disabled="!available"
          :aria-label="`${type}设备透明度`"
          @input="
            available &&
            emit('configure', type, { opacity: Number(($event.target as HTMLInputElement).value) })
          "
      /></label>
    </div>
    <label
      >设备状态<select
        :value="state"
        :disabled="!available"
        aria-label="设备点位状态"
        @change="
          available &&
          emit('filter', ($event.target as HTMLSelectElement).value as GisDeviceStateFilter)
        "
      >
        <option
          v-for="item in GIS_DEVICE_FILTERS.filter(
            (row) => observed || !['UNKNOWN', 'UNKNOWN_ALERT'].includes(row.value),
          )"
          :key="item.value"
          :value="item.value"
          >{{ item.label }}</option
        >
      </select></label
    >
    <form
      class="device-frequency-form"
      aria-label="GIS 设备频率筛选"
      novalidate
      @submit.prevent="available && emit('applyFrequency')"
    >
      <label
        >频率依据<select
          :value="frequencyInput.mode"
          :disabled="!available"
          aria-label="GIS 频率筛选依据"
          @change="
            updateFrequency({
              mode: ($event.target as HTMLSelectElement).value as DeviceFrequencyMode,
            })
          "
        >
          <option value="ALL">不限频率</option
          ><option value="MODEL">型号支持频段</option
          ><option value="DEVICE">设备工作频点</option>
        </select></label
      >
      <label v-if="frequencyInput.mode === 'DEVICE'"
        >工作频点<select
          :value="frequencyInput.presence"
          :disabled="!available"
          aria-label="GIS 工作频点是否有值"
          @change="
            updateFrequency({
              presence: ($event.target as HTMLSelectElement).value as DeviceFrequencyPresence,
            })
          "
        >
          <option value="ALL">全部工作频点</option
          ><option value="PRESENT">频点有值</option
          ><option value="MISSING">频点为空</option>
        </select></label
      >
      <label
        >下限（kHz）<input
          :value="frequencyInput.min"
          :disabled="!rangeEnabled"
          inputmode="decimal"
          aria-label="GIS 频率下限（kHz）"
          placeholder="不限"
          @input="
            rangeEnabled && updateFrequency({ min: ($event.target as HTMLInputElement).value })
          "
      /></label>
      <label
        >上限（kHz）<input
          :value="frequencyInput.max"
          :disabled="!rangeEnabled"
          inputmode="decimal"
          aria-label="GIS 频率上限（kHz）"
          placeholder="不限"
          @input="
            rangeEnabled && updateFrequency({ max: ($event.target as HTMLInputElement).value })
          "
      /></label>
      <div class="frequency-actions"
        ><button
          class="btn small"
          type="submit"
          :disabled="!available"
          >应用频率条件</button
        >
        <button
          class="btn small"
          type="button"
          :disabled="!available"
          @click="available && emit('clearFrequency')"
          >清除频率条件</button
        ></div
      >
    </form>
    <p role="status"
      >已应用：{{ deviceFrequencySummary(frequency)
      }}<span v-if="frequencyPending">；频率条件尚未应用，地图仍使用上次条件。</span></p
    >
    <p
      v-if="frequencyError"
      class="frequency-error"
      role="alert"
      >{{ frequencyError }}</p
    >
    <p
      v-if="frequencyNotice"
      role="status"
      >{{ frequencyNotice }}</p
    >
    <p>频率条件只筛选设备点位及聚合清单。编辑时随已应用草稿更新，不改变目录、导出、链路或覆盖。</p>
    <p
      v-if="available"
      role="status"
      >当前显示 {{ count }} 台设备；数字聚合点可点击查看清单。</p
    >
    <p
      v-if="available && missingCount"
      class="notice"
      role="status"
      >{{ missingCount }} 台设备缺少有效类别或位置，未绘制点位，可在原资源台账核对资料。</p
    >
    <p>设备状态独立于站点状态；告警可与故障或离线并存。设备图层开关不改变链路及覆盖。</p>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { deviceFrequencySummary } from '../services/device-frequency-filter';
import type {
  DeviceFrequencyFilter,
  DeviceFrequencyInput,
  DeviceFrequencyMode,
  DeviceFrequencyPresence,
} from '../services/device-frequency-filter';
import type { DeviceClass } from '../types/domain';
import { GIS_DEVICE_FILTERS, GIS_DEVICE_TYPES } from '../maps/gis-device-display';
import type {
  GisDeviceLayerSetting,
  GisDeviceSettings,
  GisDeviceStateFilter,
} from '../maps/gis-device-display';

const props = defineProps<{
  settings: GisDeviceSettings;
  state: GisDeviceStateFilter;
  available: boolean;
  missingCount: number;
  count: number;
  frequencyInput: DeviceFrequencyInput;
  frequency: DeviceFrequencyFilter;
  frequencyPending: boolean;
  frequencyError: string;
  frequencyNotice: string;
  observed?: boolean;
  statusSource?: string;
}>();
// 只发出显示意图；节点筛选、资源保存和业务结果由原流程负责。
const emit = defineEmits<{
  configure: [type: DeviceClass, patch: Partial<GisDeviceLayerSetting>];
  filter: [state: GisDeviceStateFilter];
  updateFrequency: [value: DeviceFrequencyInput];
  applyFrequency: [];
  clearFrequency: [];
}>();
const rangeEnabled = computed(
  () =>
    props.available &&
    props.frequencyInput.mode !== 'ALL' &&
    !(props.frequencyInput.mode === 'DEVICE' && props.frequencyInput.presence === 'MISSING'),
);
// 控件只提交输入意图，校验与已应用条件由显示状态统一持有。
function updateFrequency(patch: Partial<DeviceFrequencyInput>) {
  if (props.available) emit('updateFrequency', { ...props.frequencyInput, ...patch });
}
</script>
<style scoped>
.device-layer-panel {
  display: grid;
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #2a405a;
  font-size: 12px;
}
.device-layer-panel h3 {
  font-size: 13px;
}
.device-layer-panel label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.device-layer-panel input[type='range'],
.device-layer-panel select {
  width: 100%;
  min-width: 0;
}
.device-layer-panel p {
  line-height: 1.7;
  color: #a6bfd7;
}
.device-layer-row {
  display: grid;
  gap: 10px;
  padding: 10px;
  background: #0c1b2d;
}
.device-frequency-form {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.device-frequency-form input {
  width: 100%;
  min-width: 0;
}
.frequency-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.device-layer-panel .frequency-error {
  color: #ffb4b4;
}
</style>
