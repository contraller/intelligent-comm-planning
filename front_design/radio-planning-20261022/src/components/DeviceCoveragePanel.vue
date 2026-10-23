<template>
  <section
    class="device-coverage-panel"
    aria-label="设备覆盖设置"
  >
    <h3>设备覆盖</h3>
    <label class="coverage-filter"
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
      <label
        v-if="mode === 'single'"
        class="coverage-filter"
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
      <!-- 图形形式与缩放策略分开，切换不改变设备选择。 -->
      <label class="coverage-filter"
        >图形形式<select
          :value="representation"
          aria-label="设备覆盖图形形式"
          @change="
            emit(
              'representation',
              ($event.target as HTMLSelectElement).value as DeviceCoverageRepresentation,
            )
          "
        >
          <option value="field">场强图</option>
          <option value="heatmap">热力图</option>
        </select></label
      >
      <label class="coverage-filter"
        >覆盖显示<select
          :value="display"
          aria-label="设备覆盖显示方式"
          @change="
            emit('display', ($event.target as HTMLSelectElement).value as MockCoverageDisplay)
          "
        >
          <option value="auto">自动</option
          ><option value="raster">始终显示图片</option
          ><option value="contour">覆盖轮廓</option>
        </select></label
      >
      <!-- 显示策略仅影响已有结果的绘制，逐台来源和透明度保持独立。 -->
      <p class="muted">自动：缩小时显示轮廓，放大后显示所选图片；盲区与未计算区域保持独立标识。</p>
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
              !(representation === 'heatmap'
                ? row.sample.heatmapPng
                : row.sample.coverage.rasterPng)
            "
            role="status"
            >此设备未提供{{
              representation === 'heatmap' ? '热力图' : '场强图'
            }}，仅显示已有轮廓。</p
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
        为预设等级；重叠颜色不代表合成场强。</p
      >
    </template>
    <p
      v-else
      class="muted"
      >已提供 {{ samples.length }} 台设备的覆盖结果，其余设备暂无结果。</p
    >
  </section>
</template>
<script setup lang="ts">
import type {
  DeviceCoverageMode,
  DeviceCoverageOverlay,
  DeviceCoverageSample,
  DeviceCoverageRepresentation,
} from '../types/device-coverage';
import type { MockCoverageDisplay, MockCoverageState } from '../maps/mock-coverage-layers';

// 面板只发出显示意图，不选择资源对象或修改设备参数。
defineProps<{
  samples: DeviceCoverageSample[];
  mode: DeviceCoverageMode;
  display: MockCoverageDisplay;
  representation: DeviceCoverageRepresentation;
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
  representation: [value: DeviceCoverageRepresentation];
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
  gap: 8px;
  border-top: 1px solid #2a405a;
  padding-top: 10px;
  margin-top: 10px;
  font-size: 12px;
}
.device-coverage-panel h3 {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.device-coverage-panel label {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
/* 短标签与选择器同行，设备编号等长内容仍可正常换行。 */
.device-coverage-panel .coverage-filter {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
}
.device-coverage-panel select,
.device-coverage-panel input[type='range'] {
  width: 100%;
  min-width: 0;
}
.device-coverage-panel select {
  min-height: 28px;
  padding: 4px 6px;
}
.device-coverage-panel input[type='range'] {
  height: 18px;
  margin: 0;
  padding: 0;
}
.sample-options,
.coverage-item {
  display: grid;
  gap: 6px;
}
.coverage-item {
  background: #0c1b2d;
  border-left: 3px solid;
  padding: 8px;
}
.device-coverage-panel p {
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.device-coverage-panel button {
  justify-self: start;
}
.device-coverage-panel .notice {
  padding: 8px;
}
</style>
