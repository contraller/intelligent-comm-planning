<template>
  <section class="network-panel"
    ><div class="network-toolbar"
      ><div
        ><button
          class="btn small"
          :class="{ primary: mode === 'map' }"
          @click="mode = 'map'"
          >地理态势</button
        ><button
          class="btn small"
          :class="{ primary: mode === 'topology' }"
          @click="mode = 'topology'"
          >网络拓扑</button
        ></div
      ><small
        >{{ network.inputSnapshot.stations.length }} 个节点 ·
        {{ network.links.length }} 条规划链路</small
      ></div
    >
    <p
      v-if="mode === 'topology'"
      class="topology-hint"
      role="note"
      >滚轮缩放、拖动平移。优先显示选中对象及部分场景注入标签，其余节点、设备和链路悬浮查看详情。</p
    >
    <div
      ref="canvas"
      class="network-canvas"
      ><MapCanvas
        v-if="mode === 'map'"
        ref="map"
        :stations="stations"
        :links="network.links"
        :selected-id="selectedNode"
        :selected-link-id="selectedLink"
        :select-links="true"
        :terrain-basemap="terrainBasemap"
        :show-roads="false"
        :map-caption="terrainBasemap ? 'DEM 地形' : terrainMessage || '地形加载中'"
        watermark-caption="TAIHANG REGION"
        :diagnosis-devices="network.inputSnapshot.devices"
        :diagnosis-faults="faults"
        :diagnosis-regions="regions"
        :diagnosis-paths="paths"
        :highlight-station-ids="highlightedNodes"
        :highlight-link-ids="highlightedLinks"
        :opacity="opacity"
        @select="choose('NODE', $event)"
        @select-link="choose('LINK', $event)"
        @select-fault="choose" /><ChartCanvas
        v-else
        :option="graph"
        height="100%"
        label="诊断网络拓扑，可选择节点、设备及规划链路"
        @select="graphSelect"
    /></div>
    <div
      v-if="mode === 'topology'"
      class="topology-controls"
      ><span>站点设备：</span
      ><button
        v-for="node in stations"
        :key="node.id"
        class="text-link"
        @click="toggleStation(node.id)"
        >{{ expanded.includes(node.id) ? '收起' : '展开' }} {{ node.id }}</button
      ><small>实线为规划链路，虚线为备份或归属线；青色箭头为故障传播方向。</small></div
    >
    <div
      v-if="mode === 'topology' && faults.length"
      class="fault-legend"
      aria-label="拓扑场景注入图例"
      ><span
        v-for="item in diagnosisFaultTypes"
        :key="item.type"
        :style="{ color: item.color }"
        >{{ item.glyph }} {{ item.label }}</span
      ><small>场景注入标识；节点填色及链路线色保留受影响状态。</small></div
    >
    <div
      v-if="detail && focused"
      class="object-detail"
      ><strong>{{ diagnosisLabel(focused.type) }} {{ focused.id }}</strong
      ><p>{{ detail }}</p
      ><button
        class="btn small"
        @click="detailVisible = true"
        >查看详情</button
      ><div
        v-if="focused.type === 'NODE'"
        class="devices"
        ><button
          v-for="device in network.inputSnapshot.devices.filter((d) => d.stationId === focused?.id)"
          :key="device.id"
          class="btn small"
          @click="choose('DEVICE', device.id)"
          >{{ device.id }}</button
        ></div
      ></div
    >
    <!-- 透明度允许 0，仅影响区域渲染，故障图标及完整结果保持。 -->
    <div
      v-if="impactReady && result"
      class="layers"
      ><strong>影响图层</strong
      ><div class="level-controls"
        ><label
          v-for="level in ['SEVERE', 'MODERATE', 'MINOR'] as const"
          :key="level"
          ><input
            v-model="levels"
            type="checkbox"
            :value="level"
          />{{ diagnosisLabel(level) }}</label
        ><label
          >透明度
          <input
            v-model.number="opacity"
            type="range"
            min="0"
            max="1"
            step="0.1" /></label></div
      ><label
        v-for="region in result.regions"
        :key="region.id"
        ><input
          type="checkbox"
          :checked="!hidden.includes(region.faultKey ?? region.id)"
          @change="
            ($event.target as HTMLInputElement).checked
              ? (hidden = hidden.filter((id) => id !== (region.faultKey ?? region.id)))
              : hidden.push(region.faultKey ?? region.id)
          "
        />{{ region.label }}</label
      ><small>图层筛选只改变显示，右侧统计及导出保持完整结果。</small></div
    >
    <AppDrawer
      :visible="detailVisible"
      title="网络快照对象详情"
      :subtitle="network.id"
      @update:visible="detailVisible = $event"
      ><div
        v-if="focused"
        class="object-detail"
        ><h3>{{ diagnosisLabel(focused.type) }} {{ focused.id }}</h3
        ><p>{{ detail }}</p
        ><template v-if="focused.type === 'NODE'"
          ><h4>所属设备</h4
          ><button
            v-for="device in network.inputSnapshot.devices.filter(
              (d) => d.stationId === focused?.id,
            )"
            :key="device.id"
            class="btn small"
            @click="choose('DEVICE', device.id)"
            >{{ device.id }}</button
          ></template
        ></div
      ><template #footer><p>读取所选网络版本，不修改资源台账。</p></template></AppDrawer
    >
  </section>
</template>
<script setup lang="ts">
import { planStations } from '../services/planning-snapshot';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import type { PlanVersion } from '../types/domain';
import type { DiagnosisResult, FaultInput, ImpactLevel } from '../types/diagnosis';
import MapCanvas from './MapCanvas.vue';
import ChartCanvas from './ChartCanvas.vue';
import AppDrawer from './AppDrawer.vue';
import { diagnosisLabel } from '../reports/diagnosis-report';
import { diagnosisFaultTypes } from '../services/diagnosis-display';
import { diagnosisTopology } from '../services/diagnosis-topology';
import { useTerrainBasemap } from '../composables/useTerrainBasemap';
const props = defineProps<{
  network: PlanVersion;
  faults: FaultInput[];
  result: DiagnosisResult | null;
  impactReady: boolean;
  focus: { type: FaultInput['objectType']; id: string; nonce: number } | null;
}>();
const emit = defineEmits<{
  filters: [value: string];
}>();
const { basemap: terrainBasemap, message: terrainMessage } = useTerrainBasemap(() => props.network.terrain, {
  unavailableReason: () => props.network.terrainNotice ?? '',
});
const mode = ref('map'),
  opacity = ref(0.7),
  levels = ref<ImpactLevel[]>(['SEVERE', 'MODERATE', 'MINOR']),
  hidden = ref<string[]>([]);
const focused = ref<{ type: FaultInput['objectType']; id: string } | null>(null),
  map = ref<InstanceType<typeof MapCanvas>>();
const detailVisible = ref(false);
const expanded = ref<string[]>([]);
const canvas = ref<HTMLDivElement>();
const viewport = ref({ width: 800, height: 500 });
let canvasObserver: ResizeObserver | undefined, resizeFrame: number | undefined;
onMounted(() => {
  const measure = () => {
    const width = canvas.value?.clientWidth ?? 0, height = canvas.value?.clientHeight ?? 0;
    if (width > 0 && height > 0 && (width !== viewport.value.width || height !== viewport.value.height)) viewport.value = { width, height };
  };
  measure();
  if (canvas.value && typeof ResizeObserver !== 'undefined') {
    // 只读取诊断画布尺寸，按帧合并观察通知，不反向写入容器高度。
    canvasObserver = new ResizeObserver(() => {
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; measure(); });
    });
    canvasObserver.observe(canvas.value);
  }
});
onBeforeUnmount(() => {
  canvasObserver?.disconnect();
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
});
function toggleStation(id: string) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((value) => value !== id)
    : [...expanded.value, id];
}
// 地图和详情读取规划输出点位，原输入快照仍可追溯。
const stations = computed(() => planStations(props.network));
const selectedNode = computed(() =>
  focused.value?.type === 'NODE'
    ? focused.value.id
    : focused.value?.type === 'DEVICE'
      ? props.network.inputSnapshot.devices.find((d) => d.id === focused.value?.id)?.stationId
      : undefined,
);
const selectedLink = computed(() =>
  focused.value?.type === 'LINK' ? focused.value.id : undefined,
);
const regions = computed(() =>
  props.impactReady
    ? (props.result?.regions ?? []).filter(
        (r) =>
          (!r.level || levels.value.includes(r.level)) &&
          !hidden.value.includes(r.faultKey ?? r.id),
      )
    : [],
);
const affectedNodes = computed(() =>
  props.impactReady
    ? (props.result?.nodes ?? [])
        .filter((n) => !n.level || levels.value.includes(n.level))
        .map((n) => n.nodeId)
    : [],
);
// 传播筛选只改变展示，完整场景统计仍直接读取结果。
const paths = computed(() =>
  props.impactReady
    ? (props.result?.propagationPaths ?? []).filter(
        (path) => levels.value.includes(path.level) && !hidden.value.includes(path.faultKey),
      )
    : [],
);
const affectedLinks = computed(() =>
  props.impactReady
    ? (props.result?.links ?? [])
        .filter((l) => !l.level || levels.value.includes(l.level))
        .map((l) => l.linkId)
    : [],
);
const highlightedNodes = computed(() => affectedNodes.value);
const highlightedLinks = computed(() => [
  ...affectedLinks.value,
  ...(selectedLink.value ? [selectedLink.value] : []),
]);
// 诊断页仅查看冻结对象，故障标绘统一在 GIS 完成。
function choose(type: FaultInput['objectType'], id: string) {
  focused.value = { type, id };
  detailVisible.value = false;
}
function graphSelect(value: string) {
  const i = value.indexOf(':');
  const type = value.slice(0, i);
  if (['NODE', 'DEVICE', 'LINK'].includes(type))
    choose(type as FaultInput['objectType'], value.slice(i + 1));
}
watch(
  () => props.focus,
  async (target) => {
    if (!target) return;
    focused.value = { type: target.type, id: target.id };
    mode.value = 'map';
    detailVisible.value = false;
    await nextTick();
    map.value?.locate();
  },
);
watch(
  () => props.network.id,
  () => {
    focused.value = null;
    hidden.value = [];
    detailVisible.value = false;
    expanded.value = [];
  },
);
watch(
  [levels, hidden, opacity],
  () =>
    emit(
      'filters',
      `等级：${levels.value.map(diagnosisLabel).join('、')}；隐藏：${hidden.value.join('、') || '无'}；透明度：${opacity.value}`,
    ),
  { deep: true },
);
const graph = computed<EChartsCoreOption>(() =>
  diagnosisTopology(
    props.network,
    props.faults,
    affectedNodes.value,
    affectedLinks.value,
    paths.value,
    expanded.value,
    focused.value ? { objectType: focused.value.type, objectId: focused.value.id } : null,
    viewport.value,
  ),
);
const detail = computed(() => {
  if (!focused.value) return null;
  const { type, id } = focused.value;
  if (type === 'NODE') {
    const node = stations.value.find((n) => n.id === id);
    return node ? `${node.name} · [${node.coordinate.join(', ')}] · ${node.region}` : null;
  }
  if (type === 'DEVICE') {
    const d = props.network.inputSnapshot.devices.find((d) => d.id === id),
      config = props.network.workflow?.configuration.devices.find((d) => d.deviceId === id);
    return d
      ? `归属 ${d.stationId} · ${config?.frequencyKhz ?? d.workFreqKhz ?? '未提供'} kHz · ${config?.txPowerDbm ?? d.txPowerDbm ?? '未提供'} dBm`
      : null;
  }
  const link = props.network.links.find((l) => l.id === id);
  return link
    ? `${link.a} → ${link.b} · ${link.frequencyKhz} kHz · ${link.backup ? '备份链路' : '规划链路'}`
    : null;
});
</script>
<style scoped>
.network-panel {
  border: 1px solid #2c4563;
  border-radius: 6px;
  overflow: hidden;
  background: #101e33;
  min-width: 0;
  flex: 1;
  min-height: 480px;
  display: flex;
  flex-direction: column;
}
.network-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 12px;
}
.network-toolbar > div {
  display: flex;
  gap: 7px;
}
.network-toolbar small {
  font-size: 11px;
  color: #7f9ebc;
}
.network-canvas {
  /* 固定画布格式，不让内部渲染器的像素尺寸反向撑高外层。 */
  position: relative;
  flex: 1 1 0;
  min-height: 350px;
  overflow: hidden;
}
.topology-hint {
  margin: 0;
  padding: 0 12px 8px;
  color: #9bbbc9;
  font-size: 11px;
  line-height: 1.7;
  flex-shrink: 0;
}
.network-canvas > :deep(.map-wrap),
.network-canvas > :deep(.chart-canvas) {
  position: absolute;
  inset: 0;
  min-height: 0;
  height: 100%;
}
.object-detail {
  padding: 14px 17px;
  border-top: 1px solid #2f4966;
  color: #acc9e2;
  font-size: 12px;
}
.object-detail p {
  line-height: 1.7;
}
.devices {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.layers {
  padding: 14px 17px;
  border-top: 1px solid #2f4966;
  display: grid;
  gap: 10px;
  font-size: 12px;
  max-height: 175px;
  overflow-y: auto;
}
.level-controls {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.level-controls label {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 5px;
}
.layers small {
  color: #8ca4be;
}
.layers input[type='range'] {
  width: 90px;
}
/* 区域开关保持横排，避免继承通用表单的纵向标签样式。 */
.layers > label {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.layers input[type='checkbox'] {
  width: 14px;
  height: 14px;
  margin: 0;
  flex-shrink: 0;
}
.fault-legend {
  display: flex;
  gap: 10px 16px;
  flex-wrap: wrap;
  padding: 12px 17px;
  border-top: 1px solid #2f4966;
  font-size: 11px;
}
.fault-legend small {
  width: 100%;
  color: #8ca4be;
  line-height: 1.7;
}
.topology-controls {
  padding: 10px 17px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  max-height: 112px;
  overflow-y: auto;
  flex-shrink: 0;
  align-content: flex-start;
}
.topology-controls small {
  width: 100%;
  color: #9bbbc9;
}
</style>
