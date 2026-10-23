<template>
  <section
    class="device-coverage-panel"
    aria-label="设备覆盖教学样例"
  >
    <h3>设备覆盖 <span class="chip">Mock 教学样例</span></h3>
    <label
      >显示范围<select
        :value="mode"
        aria-label="覆盖设备范围"
        @change="emit('mode', ($event.target as HTMLSelectElement).value as DeviceCoverageMode)"
      >
        <option value="network">原有整网区域</option
        ><option value="single">单台设备</option
        ><option value="multiple">多台叠加</option>
      </select></label
    >
    <template v-if="mode !== 'network'">
      <p
        v-if="pausedReason"
        class="notice"
        role="status"
        >{{ pausedReason
        }}<button
          v-if="canResume"
          class="text-link"
          @click="emit('resume')"
          >返回资源地图</button
        ></p
      >
      <p
        v-else-if="!enabled"
        class="notice"
        >信号覆盖当前未显示，所选设备已保留。</p
      >
      <label v-if="mode === 'single'"
        >查看设备<select
          :value="singleId"
          aria-label="单台覆盖设备"
          @change="emit('single', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">请选择设备</option>
          <option
            v-if="singleId && !samples.some((s) => s.deviceId === singleId)"
            :value="singleId"
            >{{ singleId }} · 暂无预生成结果</option
          >
          <option
            v-for="sample in samples"
            :key="sample.deviceId"
            :value="sample.deviceId"
            >{{ sample.deviceId }} · {{ sample.deviceClass }} · {{ sample.stationId }}</option
          >
        </select></label
      >
      <div
        v-else
        class="sample-options"
      >
        <label
          v-for="sample in samples"
          :key="sample.deviceId"
          ><input
            type="checkbox"
            :checked="selectedIds.includes(sample.deviceId)"
            :aria-label="`叠加 ${sample.deviceId}`"
            @change="emit('toggle', sample.deviceId, ($event.target as HTMLInputElement).checked)"
          />{{ sample.deviceId }} · {{ sample.deviceClass }}</label
        >
        <button
          class="text-link"
          @click="emit('clear')"
          >清空叠加选择</button
        >
      </div>
      <p
        v-if="!overlays.length"
        class="notice"
        role="status"
        >{{ mode === 'single' && singleId ? '此设备暂无预生成结果。' : '请选择要展示的设备。' }}</p
      >
      <label
        >覆盖显示<select
          :value="display"
          aria-label="设备覆盖显示方式"
          @change="
            emit('display', ($event.target as HTMLSelectElement).value as MockCoverageDisplay)
          "
        >
          <option value="auto">自动</option
          ><option value="raster">场强图</option
          ><option value="contour">覆盖轮廓</option>
        </select></label
      >
      <!-- 显示策略仅影响已有结果的绘制，逐台来源和透明度保持独立。 -->
      <p class="muted">自动：全域显示场强图，放大保留场强并叠加已有边界；手动选择不随缩放改变。</p>
      <article
        v-for="row in overlays"
        :key="row.sample.snapshotId"
        class="coverage-item"
        :style="{ borderLeftColor: row.sample.color }"
      >
        <label
          ><input
            type="checkbox"
            :checked="row.visible"
            :aria-label="`显示 ${row.sample.deviceId}`"
            @change="
              emit('configure', row.sample.deviceId, {
                visible: ($event.target as HTMLInputElement).checked,
              })
            "
          /><strong>{{ row.sample.deviceId }}</strong> · {{ row.sample.deviceClass }}</label
        >
        <p>{{ row.sample.label }}</p>
        <p
          >工作频率：{{
            row.sample.inputSnapshot.device.workFreqKhz === null
              ? '未提供'
              : `${row.sample.inputSnapshot.device.workFreqKhz} kHz`
          }}</p
        >
        <label
          >单台透明度 {{ Math.round(row.opacity * 100) }}%<input
            type="range"
            min="0"
            max="1"
            step="0.1"
            :value="row.opacity"
            :aria-label="`${row.sample.deviceId} 覆盖透明度`"
            @input="
              emit('configure', row.sample.deviceId, {
                opacity: Number(($event.target as HTMLInputElement).value),
              })
            "
        /></label>
        <button
          class="btn small"
          :disabled="!!pausedReason || !enabled || !row.visible"
          @click="emit('locate', row.sample.snapshotId)"
          >定位覆盖范围</button
        >
        <template v-if="!pausedReason && enabled && row.visible">
          <p
            v-if="display === 'contour' && !row.sample.coverage.contour?.features.length"
            role="status"
            >此设备未提供覆盖轮廓。</p
          >
          <p
            v-else-if="
              !row.sample.coverage.rasterPng && !row.sample.coverage.contour?.features.length
            "
            role="status"
            >此设备未提供覆盖数据。</p
          >
          <p
            v-if="loads[row.sample.snapshotId] === 'loading'"
            role="status"
            >图片加载中，{{
              row.sample.coverage.contour?.features.length
                ? '保留本设备轮廓…'
                : '未提供本设备轮廓。'
            }}</p
          >
          <p
            v-if="loads[row.sample.snapshotId] === 'error'"
            role="alert"
            >图片加载失败，{{
              row.sample.coverage.contour?.features.length
                ? '已保留本设备轮廓。'
                : '未提供本设备轮廓。'
            }}<button
              class="text-link"
              @click="emit('retry', row.sample.snapshotId)"
              >重试图片</button
            ></p
          >
        </template>
      </article>
      <p class="muted"
        >显示透明度为信号覆盖组与单台透明度的乘积。弱 20／中 30／强 40 dBμV/m
        为固定示意值；重叠颜色不代表合成场强。各设备盲区与未计算区域分别标识。</p
      >
    </template>
    <p
      v-else
      class="muted"
      >可查看 4 台设备的独立教学样例，其余设备暂未提供。</p
    >
  </section>
</template>
<script setup lang="ts">
import type {
  DeviceCoverageMode,
  DeviceCoverageOverlay,
  DeviceCoverageSample,
} from '../types/device-coverage';
import type { MockCoverageDisplay, MockCoverageState } from '../maps/mock-coverage-layers';

// 面板只发出显示意图，不选择资源对象或修改设备参数。
defineProps<{
  samples: DeviceCoverageSample[];
  mode: DeviceCoverageMode;
  display: MockCoverageDisplay;
  singleId: string;
  selectedIds: string[];
  overlays: DeviceCoverageOverlay[];
  loads: Record<string, MockCoverageState>;
  pausedReason: string;
  enabled: boolean;
  canResume: boolean;
}>();
const emit = defineEmits<{
  mode: [mode: DeviceCoverageMode];
  display: [mode: MockCoverageDisplay];
  single: [id: string];
  toggle: [id: string, selected: boolean];
  configure: [id: string, change: { visible?: boolean; opacity?: number }];
  clear: [];
  locate: [snapshotId: string];
  retry: [snapshotId: string];
  resume: [];
}>();
</script>
<style scoped>
.device-coverage-panel {
  display: grid;
  gap: 12px;
  border-top: 1px solid #2a405a;
  padding-top: 16px;
  margin-top: 16px;
  font-size: 12px;
}
.device-coverage-panel h3 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.device-coverage-panel label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.device-coverage-panel select,
.device-coverage-panel input[type='range'] {
  width: 100%;
  min-width: 0;
}
.sample-options,
.coverage-item {
  display: grid;
  gap: 10px;
}
.coverage-item {
  background: #0c1b2d;
  border-left: 3px solid;
  padding: 10px;
}
.device-coverage-panel p {
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.device-coverage-panel button {
  justify-self: start;
}
</style>
