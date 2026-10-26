<template>
  <section
    class="diagnosis-snapshot"
    aria-label="GIS 诊断快照"
  >
    <div class="actions"
      ><button
        class="btn small"
        @click="actions.retry"
        :disabled="status === 'loading' || refreshing"
        >重新读取报告</button
      ><button
        class="btn small"
        @click="emit('leave')"
        >返回资源视图</button
      ><RouterLink to="/diagnosis">前往故障诊断</RouterLink></div
    >
    <p class="muted">诊断冻结网络。地图操作仅调整显示。</p>
    <p v-if="!record">目标报告：{{ targetId || '未提供有效 ID' }}</p>
    <p
      v-if="status === 'loading'"
      role="status"
      >正在读取完整诊断报告…</p
    >
    <p
      v-if="error"
      class="error"
      role="alert"
      >{{ error }}</p
    >
    <template v-if="record && display">
      <h4>{{ record.name }}</h4>
      <p class="muted">数据来源：{{ diagnosisOriginLabel(record.dataOrigin) }}</p>
      <dl class="identity"
        ><dt>报告 ID</dt><dd>{{ record.id }}</dd
        ><dt>场景 / 版本</dt><dd>{{ record.scenarioId }} / {{ record.scenarioVersion }}</dd
        ><dt>规划任务</dt><dd>{{ reportValue(record.network.taskId) }}</dd
        ><dt>方案 / 版本</dt><dd>{{ record.network.id }} / {{ record.network.version }}</dd
        ><dt>网络快照</dt><dd>{{ record.network.snapshotId }}</dd
        ><dt>诊断任务</dt><dd>{{ reportValue(record.diagnoseTaskId) }}</dd
        ><dt>影响任务</dt><dd>{{ reportValue(record.impactTaskId) }}</dd
        ><dt>完成时间</dt><dd>{{ reportValue(record.completedAt) }}</dd></dl
      >
      <div
        class="source"
        role="status"
        ><strong>{{ refreshing ? '来源正在重新核实' : diagnosisLabel(record.source.state) }}</strong
        ><p v-if="!refreshing">{{ record.source.reasons.join('；') || '服务未提供其他来源说明' }}</p
        ><small>来源状态说明所绑定网络的有效性，不表示最新诊断或实时故障。</small></div
      >
      <h4>完整影响统计</h4>
      <dl v-if="summary"
        ><dt>受影响节点</dt><dd>{{ summary.affectedNodeCount }}</dd
        ><dt>直接 / 间接</dt><dd>{{ summary.directCount }} / {{ summary.indirectCount }}</dd
        ><dt>中断 / 降级节点</dt
        ><dd>{{ summary.interruptedNodeCount }} / {{ summary.degradedNodeCount }}</dd
        ><dt>受影响链路</dt><dd>{{ summary.affectedLinkCount }}</dd
        ><dt>带宽损失</dt><dd>{{ summary.totalBandwidthLossKbps }} kbps</dd><dt>受影响需求</dt
        ><dd>{{ summary.affectedDemandIds.join('、') || '服务返回空集合' }}</dd></dl
      >
      <p
        v-else
        class="muted"
        >未提供结构化影响统计，不按清单补算。</p
      >
      <div
        class="levels"
        aria-label="诊断影响等级"
        ><label
          v-for="level in GIS_DIAGNOSIS_LEVELS"
          :key="level"
          ><input
            type="checkbox"
            :aria-label="'显示' + diagnosisLabel(level) + '诊断影响'"
            :checked="levels.includes(level)"
            :onChange="changeLevel(level)"
          />{{ diagnosisLabel(level) }}</label
        ></div
      >
      <p class="muted">筛选只改变清单、区域和高亮；未提供等级的项目保持可见。完整统计不变。</p>
      <p v-if="!display.regions.length">服务未提供影响区域。</p
      ><p v-else-if="!impact.regions.length">当前等级筛选下无影响区域。</p>
      <h4>受影响节点 · 当前显示 {{ impact.nodes.length }} 项</h4>
      <p
        v-if="!display.nodes.length"
        class="muted"
        >服务返回空节点影响清单。</p
      ><p
        v-else-if="!impact.nodes.length"
        class="muted"
        >当前等级筛选下无节点影响。</p
      >
      <article
        v-for="row in impact.nodes"
        :key="row.nodeId"
        ><button
          class="text-link"
          :onClick="selectRow('NODE', row.nodeId, 'impact')"
          >定位节点 {{ row.nodeId }}</button
        ><p
          >{{ diagnosisLabel(row.affectType) }} /
          {{ row.level === null ? '未提供等级' : diagnosisLabel(row.level) }} /
          {{ diagnosisLabel(row.state) }}</p
        ><p>{{ reportValue(row.reason) }}</p
        ><small>备用路径：{{ row.detourRoute.join(' → ') || '未提供' }}</small></article
      >
      <h4>受影响链路 · 当前显示 {{ impact.links.length }} 项</h4>
      <p
        v-if="!display.impactLinks.length"
        class="muted"
        >服务返回空链路影响清单。</p
      ><p
        v-else-if="!impact.links.length"
        class="muted"
        >当前等级筛选下无链路影响。</p
      >
      <article
        v-for="row in impact.links"
        :key="row.linkId"
        ><button
          class="text-link"
          :onClick="selectRow('LINK', row.linkId, 'impact')"
          >定位链路 {{ row.linkId }}</button
        ><p
          >{{ row.level === null ? '未提供等级' : diagnosisLabel(row.level) }} /
          {{ diagnosisLabel(row.state) }}</p
        ><p>{{ reportValue(row.reason) }}</p
        ><small
          >带宽损失：{{ reportValue(row.bandwidthLossKbps) }} kbps · 主干：{{
            row.isBackbone === null ? '未提供' : row.isBackbone ? '是' : '否'
          }}</small
        ></article
      >
      <h4>故障传播路径 · 全场景</h4><p v-if="display.paths === undefined">该报告未提供传播路径。</p
      ><p v-else-if="!display.paths.length">服务返回无传播路径。</p
      ><p v-else-if="!impact.paths?.length">当前等级筛选下无传播路径。</p
      ><article
        v-for="path in impact.paths ?? []"
        :key="path.id"
        ><strong>{{ diagnosisLabel(path.level) }} · {{ path.faultKey }}</strong
        ><p>{{ path.reason }}</p
        ><ol
          ><li
            v-for="(step, i) in path.steps"
            :key="i"
            ><button
              class="text-link"
              :onClick="selectRow(step.objectType, step.objectId)"
              >{{ diagnosisLabel(step.objectType) }} {{ step.objectId }}</button
            ><p>{{ step.reason }}</p></li
          ></ol
        ></article
      >
      <h4>场景注入对象</h4
      ><p
        v-if="!display.faults.length"
        class="muted"
        >未提供完整故障输入，不按历史案例名称补标。</p
      >
      <article
        v-for="row in display.faults"
        :key="row.objectType + ':' + row.objectId"
        ><button
          class="text-link"
          :onClick="selectRow(row.objectType, row.objectId, 'fault')"
          >定位{{ diagnosisLabel(row.objectType) }} {{ row.objectId }}</button
        ><p>{{ diagnosisLabel(row.faultType) }}</p
        ><small>发生时间：{{ reportValue(row.occurTime) }}</small></article
      >
      <div
        v-if="selected"
        class="frozen-detail"
        aria-label="冻结对象详情"
        ><h4>{{ diagnosisLabel(selected.target.objectType) }} {{ selected.target.objectId }}</h4>
        <template v-if="selected.device"
          ><p>所属节点：{{ selected.device.stationId }} · 型号：{{ selected.device.modelId }}</p
          ><p
            >输入频率：{{ reportValue(selected.device.workFreqKhz) }} kHz · 输入功率：{{
              reportValue(selected.device.txPowerDbm)
            }}
            dBm</p
          ></template
        >
        <p v-else-if="selected.link"
          >{{ selected.link.a }} → {{ selected.link.b }} · {{ selected.link.frequencyKhz }} kHz ·
          {{ selected.link.backup ? '备份链路' : '规划链路' }} · 冻结状态
          {{ selected.link.state }}</p
        >
        <p v-else-if="selected.station"
          >{{ selected.station.name }} · {{ selected.station.region }} · 冻结状态
          {{ selected.station.status }}</p
        >
        <p
          >定位坐标：{{
            selected.coordinates.map((point) => '[' + point.join(', ') + ']').join(' → ')
          }}</p
        >
        <p v-if="selected.nodeImpact || selected.linkImpact"
          >关联影响：{{ diagnosisLabel((selected.nodeImpact || selected.linkImpact)!.level) }} /
          {{ diagnosisLabel((selected.nodeImpact || selected.linkImpact)!.state) }} ·
          {{ (selected.nodeImpact || selected.linkImpact)!.reason }}</p
        >
        <p
          v-else
          class="muted"
          >报告未列出该对象的影响记录，不能据此断言无影响。</p
        >
        <div class="actions"
          ><button
            v-for="device in selectedDevices"
            :key="device.id"
            class="text-link"
            :onClick="selectRow('DEVICE', device.id)"
            >{{ device.id }}</button
          ></div
        >
      </div>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { diagnosisLabel, reportValue } from '../reports/diagnosis-report';
import { diagnosisOriginLabel } from '../services/diagnosis-presentation';
import { GIS_DIAGNOSIS_LEVELS } from '../services/gis-diagnosis-display';
import type {
  GisDiagnosisDisplay,
  GisDiagnosisObject,
  GisDiagnosisTarget,
} from '../services/gis-diagnosis-display';
import type {
  DiagnosisImpactNode,
  DiagnosisImpactLink,
  DiagnosisRegion,
  DiagnosisPropagationPath,
  ImpactLevel,
} from '../types/diagnosis';
const props = defineProps<{
  targetId: string | null;
  display: GisDiagnosisDisplay | null;
  status: string;
  error: string;
  refreshing: boolean;
  levels: ImpactLevel[];
  selected: GisDiagnosisObject | null;
  impact: {
    nodes: DiagnosisImpactNode[];
    links: DiagnosisImpactLink[];
    regions: DiagnosisRegion[];
    paths?: DiagnosisPropagationPath[];
  };
  actions: {
    select: (target: GisDiagnosisTarget, origin?: 'object' | 'impact' | 'fault') => unknown;
    setLevel: (level: ImpactLevel, visible: boolean) => unknown;
    retry: () => unknown;
  };
}>();
const emit = defineEmits<{ leave: [] }>();
const record = computed(() => props.display?.record);
const summary = computed(() => record.value?.result.summary);
// 每次渲染捕获该报告的动作，旧清单或筛选控件不能操作新的同名对象。
function selectRow(
  objectType: GisDiagnosisTarget['objectType'],
  objectId: string,
  origin: 'object' | 'impact' | 'fault' = 'object',
) {
  const select = props.actions.select;
  return () => select({ objectType, objectId }, origin);
}
function changeLevel(level: ImpactLevel) {
  const set = props.actions.setLevel;
  return (event: Event) => set(level, (event.target as HTMLInputElement).checked);
}
const selectedDevices = computed(() =>
  props.selected?.target.objectType === 'NODE'
    ? (props.display?.devices.filter((row) => row.stationId === props.selected?.target.objectId) ??
      [])
    : [],
);
</script>
<style scoped>
.diagnosis-snapshot {
  padding: 14px;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.actions,
.levels {
  display: flex;
  gap: 9px;
  flex-wrap: wrap;
  align-items: center;
}
.actions a {
  color: #94cdf0;
}
.diagnosis-snapshot h4 {
  margin: 17px 0 9px;
  color: #c6deef;
}
.diagnosis-snapshot p {
  margin: 7px 0;
}
.diagnosis-snapshot dl {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 6px;
  margin: 10px 0;
}
.diagnosis-snapshot dt,
.muted,
.diagnosis-snapshot small {
  color: #8ca5bf;
}
.diagnosis-snapshot dd {
  margin: 0;
}
.source,
.frozen-detail {
  padding: 10px;
  background: #162f46;
  border: 1px solid #34536d;
  border-radius: 4px;
}
.diagnosis-snapshot article {
  border-bottom: 1px solid #2a435b;
  padding: 9px 0;
}
.levels {
  margin-top: 15px;
}
.levels label {
  display: flex;
  gap: 5px;
  align-items: center;
}
.error {
  color: #ffb4bf;
}
</style>
