<template>
  <div class="knowledge-canvas" :class="{ 'graph-light': theme === 'light' }"
    ><details class="legend">
      <summary>图例 <span>知识类型图标</span></summary>
      <div class="legend-items"><div
        v-for="group in model.legend"
        :key="group.name"
        class="legend-group"
      >
        <strong>{{ group.name }}</strong>
        <span
          v-for="item in group.items"
          :key="item.type"
        >
          <img :src="item.url" :title="item.label" alt="" aria-hidden="true" />
          {{ knowledgeTypeName(item.type, catalog.types.find((t) => t.id === item.type)?.name) }}
        </span>
      </div></div></details
    ><div
      ref="host"
      class="canvas"
      role="img"
      aria-label="知识关系图，支持点击节点和关系，也可通过左侧列表选择"
    /><div class="graph-foot"
      >显示 {{ graph.entities.length }} / {{ graph.totalNodes }} 个节点 ·
      {{ graph.relations.length }} / {{ graph.totalEdges }} 条关系
      <span v-if="model.truncated">已达显示上限，请筛选或聚焦查看其余内容</span
      ><span>拖动平移 · 滚轮缩放 · 悬停查看名称与关系</span>
      <span class="icon-note">图标表示知识类型，实物图片为参考照片。</span>
      <details v-if="photos.length" class="photo-credits"><summary>实物参考图片 · 来源</summary><p v-for="photo in photos" :key="photo.url">{{ photo.label }} · {{ photo.credit }}</p></details></div
    ></div
  >
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { init, use, type ECharts } from 'echarts/core';
import { GraphChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { KnowledgeCatalog, KnowledgeGraph } from '../types/knowledge';
import { knowledgeGraphModel, knowledgeGraphPalette, type KnowledgeGraphTheme } from '../graphs/knowledge-graph';
import { knowledgeTypeName } from '../services/knowledge-display';
import { knowledgeMedia } from '../config/knowledge-media';
use([GraphChart, TooltipComponent, CanvasRenderer]);
const props = withDefaults(defineProps<{
  graph: KnowledgeGraph;
  selectedId: string;
  matchedIds?: string[];
  catalog: KnowledgeCatalog;
  theme?: KnowledgeGraphTheme;
}>(), { theme: 'dark' });
const emit = defineEmits<{ entity: [id: string]; relation: [id: string] }>();
const host = ref<HTMLDivElement>();
const viewport = ref({ width: 0, height: 0 });
const photos = computed(() => [...new Map(props.graph.entities.flatMap(entity => { const photo=knowledgeMedia(entity); return photo ? [[photo.url,photo] as const] : []; })).values()]);
const availableMedia = ref(new Set<string>());
const attemptedMedia = new Set<string>();
let chart: ECharts | undefined, observer: ResizeObserver | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
let chartWidth = 0, chartHeight = 0;
let disposed = false,
  renderedKey: string | undefined;
const model = computed(() =>
  knowledgeGraphModel(
    props.graph,
    props.selectedId,
    props.catalog.types.map((t) => t.id),
    Object.fromEntries(props.catalog.relationTypes.map((t) => [t.id, t.name])),
    props.matchedIds,
    viewport.value,
    availableMedia.value,
    props.theme,
  ),
);
const palette = computed(() => knowledgeGraphPalette(props.theme));
function update() {
  if (!readViewport()) return;
  if (!chart) {
    chart = init(host.value!);
    chartWidth = viewport.value.width;
    chartHeight = viewport.value.height;
    chart.on('click', (event) => {
      const item = event.data as { id?: string };
      if (item?.id) {
        if (event.dataType === 'edge') emit('relation', item.id);
        else emit('entity', item.id);
      }
    });
  }
  resizeChart();
  // 画布中心取命中范围；点选实体居中，少量邻居留出边距。
  const focused = model.value.nodes.filter((node) =>
    props.selectedId ? node.id === props.selectedId : props.matchedIds?.includes(node.id),
  );
  const center = focused.length
    ? [
        (Math.min(...focused.map((node) => node.x)) + Math.max(...focused.map((node) => node.x))) /
          2,
        (Math.min(...focused.map((node) => node.y)) + Math.max(...focused.map((node) => node.y))) /
          2,
      ]
    : undefined;
  chart?.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', renderMode: 'richText', confine: true,
        backgroundColor: palette.value.tooltipBackground,
        borderColor: palette.value.tooltipBorder,
        textStyle: { color: palette.value.tooltipText, fontSize: 12 } },
      series: [
        {
          type: 'graph',
          id: 'knowledge-graph',
          layout: 'none',
          roam: true,
          scaleLimit: { min: 0.35, max: 4 },
          center,
          zoom: props.selectedId ? (model.value.nodes.length === 2 ? 0.5 : 0.8) : 1,
          data: model.value.nodes,
          links: model.value.links,
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: model.value.edgeSymbolSize,
          edgeLabel: { show: false, formatter: '{c}', color: palette.value.edgeLabel, fontSize: 10,
            backgroundColor: palette.value.labelBackground, padding: [2, 4] },
          labelLayout: { hideOverlap: true },
          lineStyle: { color: palette.value.edge, width: 1.5, curveness: 0.12 },
          emphasis: {
            focus: 'adjacency',
            lineStyle: { width: 3, opacity: 1 },
            edgeLabel: { show: true },
          },
        },
      ],
    },
    true,
  );
  renderedKey = renderKey.value;
}
function readViewport() {
  if (disposed || !host.value || host.value.clientWidth <= 0 || host.value.clientHeight <= 0)
    return false;
  const { clientWidth: width, clientHeight: height } = host.value;
  if (viewport.value.width !== width || viewport.value.height !== height)
    viewport.value = { width, height };
  return true;
}
function resize() {
  if (!readViewport()) return;
  if (!chart || renderedKey !== renderKey.value) {
    update();
    return;
  }
  if (chartWidth === viewport.value.width && chartHeight === viewport.value.height) return;
  resizeChart();
  // 尺寸变化只更新像素样式，省略 center/zoom，保留用户当前的平移缩放。
  chart.setOption({
    series: [
      {
        id: 'knowledge-graph',
        data: model.value.nodes,
        edgeSymbolSize: model.value.edgeSymbolSize,
      },
    ],
  });
}
function resizeChart() {
  if (!chart || chartWidth === viewport.value.width && chartHeight === viewport.value.height) return;
  chart.resize();
  chartWidth = viewport.value.width;
  chartHeight = viewport.value.height;
}
function scheduleResize() {
  if (disposed || resizeTimer !== undefined) return;
  // 折叠详情和图例会连续改变容器尺寸；合并观察回调，避免观察循环内反复写画布。
  resizeTimer = setTimeout(() => { resizeTimer = undefined; resize(); }, 32);
}
onMounted(() => {
  update();
  observer = new ResizeObserver(scheduleResize);
  observer.observe(host.value!);
});
// 相同绘图内容不重建，列表翻页保留平移与缩放；显式重置仍直接调用 update。
const renderKey = computed(() =>
  JSON.stringify([props.graph, props.selectedId, props.matchedIds ?? [], props.catalog, props.theme]),
);
watch(renderKey, update);
// 失败照片使用本地类型图标，避免离线缺图后出现空白节点。
watch(photos, values => {
  if (typeof Image === 'undefined') return;
  for (const photo of values) {
    if (attemptedMedia.has(photo.url)) continue;
    attemptedMedia.add(photo.url);
    const picture = new Image();
    picture.onload = () => {
      if (disposed) return;
      availableMedia.value = new Set([...availableMedia.value, photo.url]);
      chart?.setOption({ series: [{ id: 'knowledge-graph', data: model.value.nodes }] });
    };
    picture.src = photo.url;
  }
}, { immediate: true });
// 专用画布独立释放事件与观察器，不改变其他页面图表的交互。
onBeforeUnmount(() => {
  disposed = true;
  if (resizeTimer !== undefined) clearTimeout(resizeTimer);
  observer?.disconnect();
  chart?.dispose();
});
defineExpose({ resetView: update });
</script>
<style scoped>
.knowledge-canvas {
  --graph-background: radial-gradient(ellipse at center, #152d46, #0c1728 75%);
  --graph-surface: #102439;
  --graph-border: #24364b;
  --graph-text: #b1c6d9;
  --graph-muted: #95adc5;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--graph-background);
}
.knowledge-canvas.graph-light {
  --graph-background: radial-gradient(ellipse at center, #fff, #f5f8fc 85%);
  --graph-surface: #fff;
  --graph-border: #dce5ef;
  --graph-text: #334e6c;
  --graph-muted: #5d738d;
}
.canvas { flex: 1 1 260px; min-width: 0; min-height: 260px; width: 100%; }
.legend,
.graph-foot { padding: 7px 10px; font-size: 10px; color: var(--graph-muted); }
.legend { position: relative; flex: 0 0 auto; border-bottom: 1px solid var(--graph-border); }
.legend summary { cursor: pointer; color: var(--graph-text); font-size: 11px; }
.legend summary > span { margin-left: 8px; font-size: 10px; color: var(--graph-muted); }
.legend-items {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: min(240px, 55vh);
  overflow: auto;
  padding: 10px;
  background: var(--graph-surface);
  border: 1px solid var(--graph-border);
  box-shadow: 0 7px 18px #0002;
}
.legend span { align-items: center; gap: 5px; }
.legend-group > span { display: inline-flex; }
.legend img { width: 19px; height: 19px; object-fit: contain; }
.legend-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; width: 100%; }
.legend-group strong { min-width: 72px; color: var(--graph-text); font-size: 10px; }
.graph-foot { display: flex; flex-wrap: wrap; gap: 6px 12px; flex: 0 0 auto; border-top: 1px solid var(--graph-border); line-height: 1.5; }
.graph-foot > span { margin-left: auto; color: var(--graph-text); }
.graph-foot .icon-note { margin-left: 0; color: var(--graph-muted); }
.photo-credits { width: 100%; }
.photo-credits summary { cursor: pointer; }
.photo-credits p { margin: 5px 0; overflow-wrap: anywhere; }
</style>
