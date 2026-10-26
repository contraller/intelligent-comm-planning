<template>
  <section
    class="panel adjustment-preview compact"
    aria-label="方案调整前后预览"
    ><div class="panel-head"><h3>本次调整变化</h3></div
    ><p class="preview-hint muted">对照三项指标，再通过地图的“调整前／调整后”查看空间变化。</p
    ><p
      class="notice"
      role="status"
      >{{ status }}</p
    >
    <div class="metric-comparison"
      ><table
        ><thead
          ><tr><th>指标</th><th>调整前</th><th>调整后</th><th>变化</th></tr></thead
        ><tbody
          ><tr
            v-for="(metric, index) in comparison"
            :key="metric.before.id"
            :data-metric="metric.before.id"
            ><th>{{ metric.before.label }}</th
            ><td
              >{{ metric.before.value ?? '未提供' }}
              {{ metric.before.value === null ? '' : metric.before.unit
              }}<small>{{ metric.before.status }}</small></td
            ><td :class="metric.after?.state"
              >{{ metric.after?.value ?? '未提供' }}
              {{ metric.after?.value == null ? '' : metric.after.unit
              }}<small>{{ metric.after?.status ?? '等待预览' }}</small></td
            ><td
              >{{
                deltas[index]?.value == null
                  ? '未提供'
                  : `${deltas[index]!.value! > 0 ? '+' : ''}${deltas[index]!.value}`
              }}
              <small>{{ deltas[index]?.unit }}</small></td
            ></tr
          ></tbody
        ></table
      ><p
        v-if="!after"
        class="muted"
        >当前输入尚无成功结果，地图显示父方案。</p
      ></div
    >
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { planningMetricCards } from '../services/planning-result-display';
import type { ApiPlan, ApiPlanningResult } from '../types/planning-api';

const props = defineProps<{
  before: ApiPlan;
  after: ApiPlanningResult | null;
  status: string;
}>();
// 指标只读取当前 API 冻结结果，未成功的调整保留父方案对照。
const beforeResult = computed(() => props.before.result);
// 前后值与逐项状态来自同一结果卡片，不以差值判断方案优劣。
const comparison = computed(() =>
  planningMetricCards(beforeResult.value.metrics, beforeResult.value.checks).map(
    (before, index) => ({
      before,
      after: props.after
        ? planningMetricCards(props.after.metrics, props.after.checks)[index]
        : null,
    }),
  ),
);
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
.metric-comparison {
  padding: 0 12px 12px;
  overflow-x: auto;
}
.metric-comparison table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.metric-comparison th,
.metric-comparison td {
  padding: 8px 6px;
  text-align: left;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
.metric-comparison small {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted);
}
.metric-comparison .passed {
  color: #8ed66b;
}
.metric-comparison .failed {
  color: #ef5f64;
}
.adjustment-preview {
  padding-bottom: 16px;
}
.adjustment-preview > .notice {
  margin: 12px 16px;
}
.preview-hint {
  margin: 12px 16px;
  line-height: 1.6;
  font-size: 12px;
}
.muted {
  font-size: 11px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.compact > .notice {
  margin: 6px 12px;
  font-size: 11px;
}
.compact .panel-head {
  padding: 10px 12px;
}
</style>
