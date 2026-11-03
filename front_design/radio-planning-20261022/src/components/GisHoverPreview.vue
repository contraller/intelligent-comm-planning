<template>
  <section
    class="gis-hover-preview"
    :class="{ interactive }"
    role="tooltip"
    :style="{
      left: position.left + 'px',
      top: position.top + 'px',
      width: position.width + 'px',
      maxHeight: position.maxHeight + 'px',
    }"
  >
    <strong>{{ summary.title }}</strong>
    <button v-if="interactive" class="close text-link" aria-label="关闭节点浮卡" @click="$emit('close')">×</button>
    <dl
      ><template
        v-for="row in summary.rows"
        :key="row.label"
        ><dt>{{ row.label }}</dt
        ><dd>{{ row.value }}</dd></template
      ></dl
    >
    <p class="source">{{ summary.source }}</p>
    <template v-if="interactive && summary.devices?.length"><select aria-label="浮卡设备选择" :value="selectedDeviceId" @change="$emit('device',($event.target as HTMLSelectElement).value)"><option value="">查看设备参数</option><option v-for="device in summary.devices" :key="device.id" :value="device.id">{{ device.label }}</option></select><dl v-if="selectedDevice"><template v-for="row in selectedDevice.rows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></template></dl><button class="text-link" :disabled="!selectedDevice" @click="$emit('device',selectedDeviceId || '')">选择此设备覆盖</button></template>
    <p v-if="!interactive">{{
      summary.kind === 'device' || summary.kind === 'station'
        ? '点击地图对象查看完整详情'
        : '点击地图对象展开或查看成员'
    }}</p>
  </section>
</template>
<script setup lang="ts">
import type { GisHoverSummary } from '../maps/gis-hover';
import { computed } from 'vue';
// 预览没有操作按钮，不遮挡原地图点击，也不抢占焦点。
const props=defineProps<{
  summary: GisHoverSummary;
  position: { left: number; top: number; width: number; maxHeight: number };
  interactive?:boolean;
  selectedDeviceId?:string;
}>();
defineEmits<{device:[id:string];close:[]}>();
const selectedDevice=computed(()=>props.summary.devices?.find(d=>d.id===props.selectedDeviceId));
</script>
<style scoped>
.gis-hover-preview {
  position: absolute;
  z-index: 6;
  pointer-events: none;
  box-sizing: border-box;
  overflow: hidden;
  padding: 10px 12px;
  border: 1px solid #55758e;
  border-radius: 6px;
  background: #0c1b2df5;
  box-shadow: 0 5px 18px #0005;
  color: #d9e8f5;
  font-size: 11px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.interactive{pointer-events:auto;overflow:auto;max-height:360px!important}.interactive select{width:100%;margin:6px 0}.close{position:absolute;right:8px;top:6px;font-size:19px}
strong {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  margin-bottom: 6px;
}
dl {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 3px 5px;
  margin: 0;
}
dt {
  color: #91aac0;
}
dd {
  margin: 0;
}
p {
  margin: 5px 0 0;
  color: #91aac0;
}
.source {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
