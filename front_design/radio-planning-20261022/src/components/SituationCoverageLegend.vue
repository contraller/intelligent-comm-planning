<template>
  <section v-if="legend" class="situation-coverage-legend" aria-label="当前设备覆盖图例">
    <strong>设备 {{ legend.deviceId }} · 预测覆盖</strong>
    <p v-if="!legend.cells">当前设备没有可显示的达标覆盖格面。</p>
    <template v-else-if="legend.display === 'field'">
      <p>预测场强 {{ legend.range ?? '范围未提供' }}<span v-if="legend.range"> dBμV/m</span></p>
      <div v-if="legend.range" class="field-scale"><span>低</span><i :style="{ background: gradient }" /><span>高</span></div>
      <p>按当前设备的场强范围着色；不同设备的颜色不能直接比较。</p>
    </template>
    <template v-else-if="legend.display === 'strength'">
      <p class="strength-scale"><span>■ 强 ≥20 dB</span><span>■ 中 10–&lt;20 dB</span><span>■ 弱 0–&lt;10 dB</span></p>
      <p>按接收门限以上的余量分级；不是绝对场强等级。</p>
    </template>
    <p v-else>轮廓表示已计算达标格面的边界，保留盲区及未达标区域。</p>
    <p v-if="legend.local">格面分辨率 {{ legend.resolutionM }} m · 算法预测，非实测</p>
    <p v-else>历史预测结果，非实测</p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { FrozenCoverageOverlay } from '../types/frozen-coverage';
import { frozenCoverageLegend } from '../services/frozen-coverage-legend';
const props = defineProps<{ overlay: FrozenCoverageOverlay | null }>();
const legend = computed(() => frozenCoverageLegend(props.overlay));
const gradient = computed(() => legend.value?.local
  ? 'linear-gradient(to right,rgb(218,145,78),rgb(230,193,93),rgb(137,183,105),rgb(41,137,89))'
  : 'linear-gradient(to right,hsl(28,75%,62%),hsl(84,75%,47%),hsl(140,75%,32%))');
</script>

<style scoped>
.situation-coverage-legend { max-width: 310px; padding: 10px 12px; border: 1px solid #3b5b67; border-radius: 6px; background: #0b2032ed; color: #c7dfef; font-size: var(--font-secondary); line-height: 1.6; pointer-events: none; }
.situation-coverage-legend strong { color: #e1f0f2; }
p { margin: 4px 0 0; }
.field-scale, .strength-scale { display: flex; gap: 9px; align-items: center; }.strength-scale { flex-wrap: wrap; }
.field-scale { margin-top: 5px; }.field-scale i { flex: 1; height: 10px; border-radius: 2px; }
.strength-scale span:nth-child(1) { color: #51cf88; }.strength-scale span:nth-child(2) { color: #f0c541; }.strength-scale span:nth-child(3) { color: #ee9b55; }
</style>
