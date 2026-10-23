<template>
  <div class="knowledge-canvas"
    ><div class="legend"
      ><span
        v-for="item in model.legend"
        :key="item.name"
        ><i :style="{ background: item.color }" />{{ item.name }}</span
      ></div
    ><div class="type-legend"
      ><span
        v-for="item in model.typeLegend"
        :key="item.type"
        >{{ item.symbol }}
        {{ catalog.types.find((t) => t.id === item.type)?.name ?? item.type }}</span
      ></div
    ><div
      ref="host"
      class="canvas"
      role="img"
      aria-label="知识关系图，支持点击节点和关系，也可通过左侧列表选择"
    /><div class="graph-foot"
      >显示 {{ graph.entities.length }} / {{ graph.totalNodes }} 个节点 ·
      {{ graph.relations.length }} / {{ graph.totalEdges }} 条关系
      <span v-if="model.truncated">已达显示上限，请筛选或聚焦查看其余内容</span
      ><span>拖动平移 · 滚轮缩放</span></div
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
use([GraphChart, TooltipComponent, CanvasRenderer]);
const props = defineProps<{
  graph: KnowledgeGraph;
  selectedId: string;
  matchedIds?: string[];
  catalog: KnowledgeCatalog;
}>();
const emit = defineEmits<{ entity: [id: string]; relation: [id: string] }>();
const host = ref<HTMLDivElement>();
let chart: ECharts | undefined, observer: ResizeObserver | undefined;
const model = computed(() =>
  knowledgeGraphModel(
    props.graph,
    props.selectedId,
    props.catalog.types.map((t) => t.id),
    Object.fromEntries(props.catalog.relationTypes.map((t) => [t.id, t.name])),
    props.matchedIds,
  ),
);
function update() {
  chart?.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item', renderMode: 'richText' },
      series: [
        {
          type: 'graph',
          layout: 'none',
          roam: true,
          scaleLimit: { min: 0.35, max: 4 },
          data: model.value.nodes,
          links: model.value.links,
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 7,
          edgeLabel: { show: true, formatter: '{c}', color: '#96b9d5', fontSize: 10 },
          lineStyle: { color: '#537f9e', width: 1.5, curveness: 0.12 },
          emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
        },
      ],
    },
    true,
  );
}
onMounted(() => {
  chart = init(host.value!);
  update();
  chart.on('click', (event) => {
    const item = event.data as { id?: string };
    if (item?.id) {
      if (event.dataType === 'edge') emit('relation', item.id);
      else emit('entity', item.id);
    }
  });
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(host.value!);
});
// 新检索和返回概览重新适配画布；复用现有视图重置与点击事件。
watch(() => [props.graph, props.selectedId, props.matchedIds, props.catalog], update, {
  deep: true,
});
// 专用画布独立释放事件与观察器，不改变其他页面图表的交互。
onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.dispose();
});
defineExpose({ resetView: update });
</script>
<style scoped>
.knowledge-canvas {
  height: 100%;
  min-height: 510px;
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
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.graph-foot {
  border-top: 1px solid #24364b;
}
.graph-foot > span {
  margin-left: auto;
  color: #b1c6d9;
}
</style>
<style scoped>
.type-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 7px 13px;
  padding: 0 16px 10px;
  color: #879fb7;
  font-size: 10px;
}
</style>
