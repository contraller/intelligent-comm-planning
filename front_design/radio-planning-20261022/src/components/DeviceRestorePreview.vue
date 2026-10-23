<template>
  <section v-if="preview" class="restore-preview" aria-label="参数恢复候选">
    <h3>参数恢复候选 · 尚未保存</h3>
    <p class="identifier">来源 {{ preview.source_revision }} · 当前 {{ preview.base_revision }}</p>
    <ul><li v-for="warning in preview.warnings" :key="warning">{{ warning }}</li></ul>
    <dl><template v-for="change in preview.changes" :key="change.field">
      <dt>{{ labels[change.field] }}</dt><dd>{{ change.before ?? '未知' }} → {{ change.after }}</dd>
    </template></dl>
    <p v-if="!preview.compatible">没有可提交的兼容参数候选</p>
    <button class="btn" :disabled="!editable || busy || !preview.compatible" @click="$emit('apply', preview)">交资源维护确认</button>
  </section>
</template>
<script setup lang="ts">
import type { RestoreProposal } from '../types/device-trace';
defineProps<{ preview: RestoreProposal | null; editable: boolean; busy: boolean }>();
defineEmits<{ apply: [value: RestoreProposal] }>();
const labels = { tx_power_dbm: '发射功率（dBm）', work_freq_khz: '工作频率（kHz）', antenna_height_m: '天线高度（m）' };
</script>
<style scoped>
.restore-preview { border-top: 1px solid var(--line, #d5d9de); padding: 12px 0; }
h3 { font-size: 14px; } p, li, dd { overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr); gap: 8px; }
dd { margin: 0; }
</style>
