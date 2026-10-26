<template>
  <div class="knowledge-canvas"
    ><div class="legend"
      ><div
        v-for="group in model.legend"
        :key="group.name"
        class="legend-group"
      >
        <strong>{{ group.name }}</strong>
        <span
          v-for="item in group.items"
          :key="item.type"
        >
          <i :style="{ color: item.color }">{{ item.glyph }}</i
          >{{ knowledgeTypeName(item.type, catalog.types.find((t) => t.id === item.type)?.name) }}
        </span>
      </div></div
    ><div
      ref="host"
      class="canvas"
      role="img"
      aria-label="知识关系图，支持点击节点和关系，也可通过左侧列表选择"
    /><div class="graph-foot"
      >显示 {{ graph.entities.length }} / {{ graph.totalNodes }} 个节点 ·
      {{ graph.relations.length }} / {{ graph.totalEdges }} 条关系
      <span v-if="model.truncated">已达显示上限，请筛选或聚焦查看其余内容</span
      ><span>拖动平移 · 滚轮缩放 · 悬停查看名称与关系</span></div
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
import { knowledgeGraphModel } from '../graphs/knowledge-graph';
import { knowledgeTypeName } from '../services/knowledge-display';
use([GraphChart, TooltipComponent, CanvasRenderer]);
const props = defineProps<{
  graph: KnowledgeGraph;
  selectedId: string;
  matchedIds?: string[];
  catalog: KnowledgeCatalog;
}>();
const emit = defineEmits<{ entity: [id: string]; relation: [id: string] }>();
const host = ref<HTMLDivElement>();
const viewport = ref({ width: 0, height: 0 });
let chart: ECharts | undefined, observer: ResizeObserver | undefined;
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
  ),
);
function update() {
  if (!readViewport()) return;
  if (!chart) {
    chart = init(host.value!);
    chart.on('click', (event) => {
      const item = event.data as { id?: string };
      if (item?.id) {
        if (event.dataType === 'edge') emit('relation', item.id);
        else emit('entity', item.id);
      }
    });
  }
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
      tooltip: { trigger: 'item', renderMode: 'richText' },
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
          edgeLabel: { show: false, formatter: '{c}', color: '#96b9d5', fontSize: 10 },
          lineStyle: { color: '#537f9e', width: 1.5, curveness: 0.12 },
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
  chart?.resize();
  if (!chart || renderedKey !== renderKey.value) {
    update();
    return;
  }
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
onMounted(() => {
  update();
  observer = new ResizeObserver(resize);
  observer.observe(host.value!);
});
// 相同绘图内容不重建，列表翻页保留平移与缩放；显式重置仍直接调用 update。
const renderKey = computed(() =>
  JSON.stringify([props.graph, props.selectedId, props.matchedIds ?? [], props.catalog]),
);
watch(renderKey, update);
// 专用画布独立释放事件与观察器，不改变其他页面图表的交互。
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
  chart?.dispose();
});
defineExpose({ resetView: update });
</script>
<style scoped>
.knowledge-canvas {
  height: 100%;
  /* 画布随工作区伸缩，尺寸变化继续由既有 ResizeObserver 处理。 */
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: radial-gradient(ellipse at center, #152d46, #0c1728 75%);
}
.canvas {
  flex: 1;
  min-height: 425px;
}
.legend,
.graph-foot {
  display: flex;
  gap: 15px;
  flex-wrap: wrap;
  padding: 12px 16px;
  font-size: 11px;
  color: #95adc5;
}
.legend span {
  display: flex;
  align-items: center;
  gap: 6px;
}
.legend i {
  font-style: normal;
  font-size: 15px;
}
.legend {
  gap: 8px;
  border-bottom: 1px solid #24364b;
}
.legend-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 13px;
  width: 100%;
}
.legend-group strong {
  min-width: 80px;
  color: #b5cce0;
  font-size: 11px;
}
.graph-foot {
  border-top: 1px solid #24364b;
}
.graph-foot > span {
  margin-left: auto;
  color: #b1c6d9;
}
</style>
