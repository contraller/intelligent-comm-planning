<template>
  <section
    class="link-detail"
    aria-label="GIS 链路详情"
    ><p
      v-if="!auth.can('situation.view')"
      class="detail-note"
      role="status"
      >当前角色没有 GIS 查看权限，无法查看链路详情。</p
    ><template v-else
      ><h4
        >{{ link.id }}
        <span
          v-if="quality"
          :style="{ color: quality.color }"
          >{{ quality.label }}</span
        ></h4
      ><p class="detail-note">网络快照：{{ context.snapshotId }}</p
      ><p
        v-if="hidden"
        class="detail-note"
        role="status"
        >当前链路因筛选或图层关闭而不可见，详情已保留。</p
      ><dl class="kv"
        ><dt>A 端站点</dt
        ><dd
          >{{ stationName(link.a) }}<small>{{ link.a }}</small></dd
        ><dt>A 端设备</dt
        ><dd
          >{{ deviceName(link.deviceA) }}<small>{{ link.deviceA }}</small></dd
        ><dt>B 端站点</dt
        ><dd
          >{{ stationName(link.b) }}<small>{{ link.b }}</small></dd
        ><dt>B 端设备</dt
        ><dd
          >{{ deviceName(link.deviceB) }}<small>{{ link.deviceB }}</small></dd
        ><dt>链路类型</dt><dd>{{ link.deviceClass }}</dd
        ><dt>工作频率</dt><dd>{{ link.frequencyKhz }} kHz</dd><dt>带宽</dt
        ><dd>{{ detail.record ? detail.record.bandwidthKhz + ' kHz' : '暂无匹配资料' }}</dd
        ><dt>主干属性</dt
        ><dd>{{
          link.isBackbone == null ? '未提供' : link.isBackbone ? '主干链路' : '非主干链路'
        }}</dd
        ><dt>备用属性</dt><dd>{{ link.backup ? '备用链路' : '非备用链路' }}</dd></dl
      ><p
        v-if="detail.state !== 'ready'"
        class="detail-note"
        role="status"
        >{{ detail.message }}</p
      ><!-- 只有匹配当前网络的有效资料才能进入指标和趋势，旧结果不留在画布中。 --><template
        v-else-if="latest && detail.record"
        ><p class="detail-note"
          >{{ context.source }}<br />最新采样：{{ formatLinkTime(latest.timestamp) }} (UTC+8)</p
        ><!-- 指标逐行对齐，仅状态沿用业务色；缺测和越限原因保持原值。 --><div
          class="link-metrics"
          aria-label="链路指标"
          ><article
            v-for="item in LINK_METRICS"
            :key="item.key"
            :data-metric="item.key"
            class="metric-card"
            :class="{ violation: ['WARNING', 'FAULT'].includes(latest.metrics[item.key].status) }"
            :style="{ color: LINK_METRIC_STYLES[latest.metrics[item.key].status].color }"
            ><span class="metric-name">{{ item.label }}</span
            ><strong class="metric-value"
              >{{ formatLinkMetric(item.key, latest.metrics[item.key].value)
              }}<small v-if="latest.metrics[item.key].value !== null">{{
                ' ' + item.unit
              }}</small></strong
            ><span class="metric-state">{{
              LINK_METRIC_STYLES[latest.metrics[item.key].status].label
            }}</span
            ><p
              class="metric-reason"
              v-if="latest.metrics[item.key].reason"
              >{{ latest.metrics[item.key].reason }}</p
            ></article
          ></div
        ><LinkHistoryChart
          :link-id="link.id"
          :samples="detail.record.samples" /><LinkAssessmentPanel
          :display="assessment.display"
          :owner="assessment.owner"
          :observed-state="latest.linkState" /></template></template
  ></section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { LINK_STATUS_STYLES } from '../config/link-status';
import {
  formatLinkMetric,
  formatLinkTime,
  LINK_METRICS,
  LINK_METRIC_STYLES,
  selectLinkDetail,
  selectHistoryAssessment,
} from '../services/link-detail';
import LinkAssessmentPanel from './LinkAssessmentPanel.vue';
import LinkHistoryChart from './LinkHistoryChart.vue';
import type { NetworkLink } from '../types/domain';
import type { GisResourceIndex } from '../types/gis-workspace';
import type { LinkDetailContext } from '../types/link-detail';

const props = defineProps<{
  link: NetworkLink;
  resources: GisResourceIndex;
  context: LinkDetailContext;
  hidden?: boolean;
}>();
const auth = useAuthStore();
const detail = computed(() => selectLinkDetail(props.context, props.link.id));
const latest = computed(() => detail.value.record?.samples.at(-1));
// 与当前最新指标使用同一份网络采样。
const assessment = computed(() => selectHistoryAssessment(props.context, props.link.id));
const quality = computed(() => LINK_STATUS_STYLES[props.link.state]);
const stationName = (id: string) =>
  props.resources.stations.find((row) => row.id === id)?.name ?? '站点未提供';
const deviceName = (id: string) => {
  const device = props.resources.devices.find((row) => row.id === id);
  return props.resources.models.find((row) => row.id === device?.modelId)?.name ?? '型号未提供';
};
</script>

<style scoped>
.link-detail {
  padding: 14px;
  min-width: 0;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.link-detail h4 {
  margin: 0 0 8px;
  font-size: 14px;
}
.link-detail h4 span {
  margin-left: 8px;
  font-size: 12px;
}
.detail-note,
.kv small {
  color: var(--muted);
  font-size: 11px;
}
.kv dd {
  min-width: 0;
}
.kv small {
  display: block;
}
.link-metrics {
  display: grid;
  gap: 7px;
}
.metric-card {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px 8px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--line);
  border-radius: 5px;
  background: #112237;
}
.metric-name {
  color: #a9bdd3;
  font-size: 12px;
}
.metric-value {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  color: #d9e8f7;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}
.metric-value small {
  color: var(--muted);
  font-size: 10px;
  font-weight: normal;
}
.metric-state {
  padding: 1px 5px;
  border-radius: 3px;
  background: #192c41;
  font-size: 10px;
  white-space: nowrap;
}
.metric-reason {
  grid-column: 1 / -1;
  margin: 0;
  color: #91acc5;
  font-size: 11px;
}
.metric-card.violation {
  border-left-color: currentColor;
}
</style>
