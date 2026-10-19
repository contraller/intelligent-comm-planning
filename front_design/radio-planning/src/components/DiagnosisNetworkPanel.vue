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
    <div
      v-if="drawing"
      class="drawing-banner"
      ><b>故障标绘中</b> 连续点击对象选择 / 取消 · 已选 {{ selected.length }} 个<button
        class="btn small"
        :disabled="!auth.can('diagnosis.scenario') || !selected.length"
        @click="emit('configure')"
        >配置已选对象</button
      ><button
        class="text-link"
        @click="emit('clear')"
        >重新选择</button
      ><button
        class="text-link"
        @click="emit('drawing', false)"
        >退出标绘</button
      ></div
    >
    <div class="network-canvas"
      ><MapCanvas
        v-if="mode === 'map'"
        ref="map"
        :stations="stations"
        :links="network.links"
        :selected-id="selectedNode"
        :selected-link-id="selectedLink"
        :select-links="true"
        :diagnosis-devices="network.inputSnapshot.devices"
        :diagnosis-faults="faults"
        :diagnosis-regions="regions"
        :highlight-station-ids="highlightedNodes"
        :highlight-link-ids="highlightedLinks"
        :opacity="opacity"
        @select="choose('NODE', $event)"
        @select-link="choose('LINK', $event)"
        @select-fault="choose" /><ChartCanvas
        v-else
        :option="graph"
        height="520px"
        label="诊断网络拓扑，可选择节点、设备及规划链路"
        @select="graphSelect"
    /></div>
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
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { planStations } from '../services/planning-snapshot';
import { computed, nextTick, ref, watch } from 'vue';
import type { EChartsCoreOption } from 'echarts/core';
import type { PlanVersion } from '../types/domain';
import type { DiagnosisResult, FaultInput, ImpactLevel } from '../types/diagnosis';
import MapCanvas from './MapCanvas.vue';
import ChartCanvas from './ChartCanvas.vue';
import AppDrawer from './AppDrawer.vue';
import { diagnosisLabel } from '../reports/diagnosis-report';
import { diagnosisFaultTypes, diagnosisFaultVisual } from '../services/diagnosis-display';
const props = defineProps<{
  network: PlanVersion;
  faults: FaultInput[];
  result: DiagnosisResult | null;
  impactReady: boolean;
  drawing: boolean;
  selected: { objectType: FaultInput['objectType']; objectId: string }[];
  focus: { type: FaultInput['objectType']; id: string; nonce: number } | null;
}>();
const emit = defineEmits<{
  pick: [type: FaultInput['objectType'], id: string];
  configure: [];
  drawing: [value: boolean];
  clear: [];
  filters: [value: string];
}>();
const mode = ref('map'),
  opacity = ref(0.7),
  levels = ref<ImpactLevel[]>(['SEVERE', 'MODERATE', 'MINOR']),
  hidden = ref<string[]>([]);
const focused = ref<{ type: FaultInput['objectType']; id: string } | null>(null),
  map = ref<InstanceType<typeof MapCanvas>>();
const detailVisible = ref(false);
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
const affectedLinks = computed(() =>
  props.impactReady
    ? (props.result?.links ?? [])
        .filter((l) => !l.level || levels.value.includes(l.level))
        .map((l) => l.linkId)
    : [],
);
const highlightedNodes = computed(() => [
  ...affectedNodes.value,
  ...props.selected.flatMap((t) =>
    t.objectType === 'NODE'
      ? [t.objectId]
      : t.objectType === 'DEVICE'
        ? [props.network.inputSnapshot.devices.find((d) => d.id === t.objectId)?.stationId ?? '']
        : [],
  ),
]);
const highlightedLinks = computed(() => [
  ...affectedLinks.value,
  ...props.selected.filter((t) => t.objectType === 'LINK').map((t) => t.objectId),
  ...(selectedLink.value ? [selectedLink.value] : []),
]);
// 标绘时保持连续选择，浏览时在右侧抽屉读取冻结对象详情。
function choose(type: FaultInput['objectType'], id: string) {
  focused.value = { type, id };
  if (props.drawing && auth.can('diagnosis.scenario')) emit('pick', type, id);
  else detailVisible.value = true;
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
    detailVisible.value = true;
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
const graph = computed<EChartsCoreOption>(() => {
  const faultVisual = (type: FaultInput['objectType'], id: string) => {
    const fault = props.faults.find((row) => row.objectType === type && row.objectId === id);
    return fault ? diagnosisFaultVisual(fault.faultType) : undefined;
  };
  // 注入类型使用轮廓及单独标签；节点填色和链路线色仍表示原受影响状态。
  const nodeStyle = (type: FaultInput['objectType'], id: string, affected: boolean) => ({
    color: affected ? '#e47589' : type === 'DEVICE' ? '#5996bc' : '#62c4b4',
    borderColor: faultVisual(type, id)?.color ?? '#3c617d',
    borderWidth: 3,
  });
  const label = (type: FaultInput['objectType'], id: string) => {
    const visual = faultVisual(type, id);
    return visual
      ? {
          show: true,
          formatter: () => `${id}\n{fault|场景注入 · ${visual.glyph} ${visual.label}}`,
          rich: { fault: { color: visual.color, fontSize: 11, padding: [3, 0] } },
        }
      : { show: true, formatter: () => id };
  };
  return {
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'graph',
        layout: 'circular',
        roam: true,
        edgeSymbol: ['none', 'arrow'],
        label: { show: true, color: '#c0d5e9', fontSize: 11 },
        data: [
          ...stations.value.map((n) => ({
            id: `NODE:${n.id}`,
            name: n.id,
            symbolSize: 29,
            symbol: faultVisual('NODE', n.id)?.symbol ?? 'circle',
            label: label('NODE', n.id),
            itemStyle: nodeStyle('NODE', n.id, affectedNodes.value.includes(n.id)),
          })),
          ...props.network.inputSnapshot.devices.map((d) => ({
            id: `DEVICE:${d.id}`,
            name: d.id,
            symbolSize: 19,
            symbol: faultVisual('DEVICE', d.id)?.symbol ?? 'circle',
            label: label('DEVICE', d.id),
            itemStyle: nodeStyle('DEVICE', d.id, affectedNodes.value.includes(d.stationId)),
          })),
        ],
        links: [
          ...props.network.inputSnapshot.devices.map((d) => ({
            source: `NODE:${d.stationId}`,
            target: `DEVICE:${d.id}`,
            lineStyle: { color: '#395573', type: 'dotted' as const },
          })),
          ...props.network.links.map((l) => ({
            id: `LINK:${l.id}`,
            name: l.id,
            source: `DEVICE:${l.deviceA}`,
            target: `DEVICE:${l.deviceB}`,
            label: label('LINK', l.id),
            lineStyle: {
              color: affectedLinks.value.includes(l.id) ? '#eb8392' : '#5489b4',
              width: selectedLink.value === l.id ? 5 : 2,
            },
          })),
        ],
      },
    ],
  };
});
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
  height: 520px;
}
.drawing-banner {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  background: #412854;
  padding: 12px;
  color: #e8c4fd;
  font-size: 12px;
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
}
.level-controls {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.level-controls label {
  display: flex;
  align-items: center;
  gap: 5px;
}
.layers small {
  color: #8ca4be;
}
.layers input[type='range'] {
  width: 90px;
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
</style>
