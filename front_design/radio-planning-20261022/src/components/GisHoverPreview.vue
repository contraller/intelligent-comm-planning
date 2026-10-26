<template>
  <section
    class="gis-hover-preview"
    role="tooltip"
    :style="{
      left: position.left + 'px',
      top: position.top + 'px',
      width: position.width + 'px',
      maxHeight: position.maxHeight + 'px',
    }"
  >
    <strong>{{ summary.title }}</strong>
    <dl
      ><template
        v-for="row in summary.rows"
        :key="row.label"
        ><dt>{{ row.label }}</dt
        ><dd>{{ row.value }}</dd></template
      ></dl
    >
    <p class="source">{{ summary.source }}</p>
    <p>{{
      summary.kind === 'device' || summary.kind === 'station'
        ? '点击地图对象查看完整详情'
        : '点击地图对象展开或查看成员'
    }}</p>
  </section>
</template>
<script setup lang="ts">
import type { GisHoverSummary } from '../maps/gis-hover';
// 预览没有操作按钮，不遮挡原地图点击，也不抢占焦点。
defineProps<{
  summary: GisHoverSummary;
  position: { left: number; top: number; width: number; maxHeight: number };
}>();
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
