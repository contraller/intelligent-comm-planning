<template>
  <template v-if="display!=='strength'">
    <span v-if="display==='field' && hasGrid" class="coverage-line-key"><i aria-hidden="true" :style="{background:coverageLineColors.field}" />场强等值线（dBμV/m）</span>
    <span v-if="hasGrid && !boundaryStatus" class="coverage-line-key"><i aria-hidden="true" :style="{background:coverageLineColors.threshold,height:'3px'}" />通信门限（余量 {{ marginMinDb }} dB）</span>
    <span v-if="boundaryStatus">{{ boundaryStatus }}</span>
  </template>
</template>

<script setup lang="ts">
import type { FrozenCoverageOverlay } from '../types/frozen-coverage';
import { coverageLineColors } from '../maps/frozen-coverage-layers';
defineProps<{ display:FrozenCoverageOverlay['display']; hasGrid:boolean; boundaryStatus:string; marginMinDb:number }>();
</script>

<style scoped>
.coverage-line-key { display:inline-flex;align-items:center;gap:7px;white-space:nowrap; }
.coverage-line-key i { display:inline-block;flex:none;width:20px;height:2px; }
</style>
