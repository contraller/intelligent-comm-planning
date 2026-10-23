<template>
  <section
    class="panel adjustment-preview"
    aria-label="方案调整前后预览"
    ><div class="panel-head"><h3>调整前后预览</h3></div
    ><p
      class="notice"
      role="status"
      >{{ status }}</p
    >
    <div class="preview-columns"
      ><article
        v-for="row in rows"
        :key="row.label"
        ><h4>{{ row.label }}</h4
        ><template v-if="row.result"
          ><p class="muted">结果快照 {{ row.result.snapshotId }}</p>
          <div class="preview-map"
            ><MapCanvas
              v-if="'nodes' in row.result"
              :key="row.result.snapshotId"
              :stations="[]"
              :planning-overlay="overlay(row.result)"
              show-coverage
              compact />
            <MapCanvas
              v-else
              :key="row.result.snapshotId"
              :stations="
                configuredStations(row.result.inputSnapshot.stations, row.result.configuration)
              "
              :links="row.result.links"
              :regions="row.result.regions"
              :mock-coverage="row.result.coverage"
              show-coverage
              compact
          /></div>
          <dl class="metric-list"
            ><div
              v-for="metric in planningMetricCards(row.result.metrics, row.result.checks)"
              :key="metric.id"
              :class="metric.state"
              ><dt>{{ metric.label }}</dt
              ><dd
                >{{ metric.value === null ? '未提供' : `${metric.value} ${metric.unit}` }} ·
                {{ metric.status }}</dd
              ><small>{{ metric.note }}</small></div
            ></dl
          ></template
        ><p
          v-else
          class="empty-inline"
          >尚无本次调整的成功结果；父方案仅在左侧展示。</p
        ></article
      ></div
    >
    <div
      v-if="after"
      class="deltas"
      ><span
        v-for="item in deltas"
        :key="item.key"
        >{{ item.label }}：{{
          item.value === null ? '未提供' : `${item.value > 0 ? '+' : ''}${item.value} ${item.unit}`
        }}</span
      ></div
    >
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import MapCanvas from './MapCanvas.vue';
import { configuredStations } from '../services/planning-snapshot';
import { planningMetricCards } from '../services/planning-result-display';
import type { PlanVersion } from '../types/domain';
import type { PlanningResult } from '../types/planning';
import type { ApiPlan, ApiPlanningResult } from '../types/planning-api';
import type { PlanningMapOverlay } from '../maps/planning-api-layers';

const props = defineProps<{
  before: PlanVersion | ApiPlan;
  after: PlanningResult | ApiPlanningResult | null;
  status: string;
}>();
// 两幅地图只展示各自冻结结果，未成功的调整没有“新覆盖”。
const beforeResult = computed(() =>
  'result' in props.before
    ? props.before.result
    : {
        ...props.before,
        configuration: props.before.workflow?.configuration,
        checks: props.before.workflow?.checks ?? [],
      },
);
const rows = computed(() => [
  { label: '调整前 · 父方案', result: beforeResult.value },
  { label: '调整后 · 服务返回', result: props.after },
]);
function overlay(result: ApiPlanningResult): PlanningMapOverlay {
  return {
    nodes: result.nodes.map((n) => ({
      ...n,
      coordinate:
        result.configuration.deployment.find((d) => d.stationId === n.id)?.plannedCoordinate ??
        n.coordinate,
    })),
    links: result.links,
    coverage: result.coverage,
    snapshotId: result.snapshotId,
  };
}
const deltas = computed(() =>
  [
    { key: 'connectivityPercent' as const, label: '连通率变化', unit: '个百分点' },
    { key: 'totalRadiatedPowerW' as const, label: '总辐射功率变化', unit: 'W' },
    { key: 'survivabilityPercent' as const, label: '抗毁性变化', unit: '个百分点' },
  ].map((item) => {
    const before = beforeResult.value.metrics[item.key],
      after = props.after?.metrics[item.key];
    return {
      ...item,
      value:
        typeof before === 'number' && typeof after === 'number'
          ? Number((after - before).toFixed(6))
          : null,
    };
  }),
);
</script>
<style scoped>
.adjustment-preview {
  padding-bottom: 16px;
}
.adjustment-preview > .notice {
  margin: 12px 16px;
}
.preview-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 0 16px;
}
.preview-columns article {
  min-width: 0;
}
.preview-map {
  height: 300px;
  border: 1px solid var(--line);
  margin-bottom: 12px;
}
.metric-list > div {
  border-left: 3px solid #9aafc9;
  padding: 8px 12px;
  margin: 10px 0;
  background: #122540;
}
.metric-list .passed {
  border-color: #8ed66b;
}
.metric-list .failed {
  border-color: #ef5f64;
}
.metric-list dd {
  margin: 6px 0;
}
.metric-list .passed dd {
  color: #8ed66b;
}
.metric-list .failed dd {
  color: #ef5f64;
}
.metric-list small,
.muted {
  font-size: 11px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.deltas {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  padding: 16px 16px 0;
  font-size: 12px;
}
@media (max-width: 950px) {
  .preview-columns {
    grid-template-columns: 1fr;
  }
}
</style>
