<template>
  <section class="network-detail"
    ><nav
      class="network-navigation"
      aria-label="网络详情层级"
      ><button
        class="btn small"
        :onClick="navigation.device"
        >返回设备详情</button
      ><button
        v-if="parentLink && data?.service"
        class="btn small"
        :onClick="navigation.link"
        >返回链路 {{ parentLink.link?.id }}</button
      ></nav
    >
    <p
      v-if="data"
      class="network-breadcrumb"
      >设备详情 / <template v-if="parentLink?.link">链路 {{ parentLink.link.id }} / </template
      >{{ data.link ? '链路 ' + data.link.id : '业务 ' + (data.service?.name ?? '未提供') }}</p
    >
    <p
      v-if="busy"
      role="status"
      >读取网络详情…</p
    ><p
      v-if="error"
      role="alert"
      >{{ error }}</p
    ><template v-if="data"
      ><p>{{ data.snapshotId }} · {{ data.source }}</p
      ><LinkDetailPanel
        v-if="data.link && context === 'gis'"
        :link="data.link"
        :resources="data.resources"
        :context="data.linkDetails"
      /><section
        v-else-if="data.link"
        aria-label="资源链路详情"
      >
        <h4>{{ data.link.id }}</h4>
        <dl class="kv"
          ><dt>A 端站点 / 设备</dt><dd>{{ data.link.a }} / {{ data.link.deviceA }}</dd
          ><dt>B 端站点 / 设备</dt><dd>{{ data.link.b }} / {{ data.link.deviceB }}</dd
          ><dt>链路类型</dt><dd>{{ data.link.deviceClass }}</dd
          ><dt>频率 / 带宽</dt
          ><dd>{{ data.link.frequencyKhz }} kHz / {{ detail?.bandwidthKhz ?? '未提供' }} kHz</dd
          ><dt>主干 / 备用</dt
          ><dd
            >{{
              data.link.isBackbone == null ? '未提供' : data.link.isBackbone ? '主干' : '非主干'
            }}
            / {{ data.link.backup ? '备用' : '非备用' }}</dd
          ></dl
        >
        <p v-if="!detail">{{ data.linkDetails.message || '暂无匹配资料' }}</p>
        <template v-if="latest && detail"
          ><p>最新采样：{{ formatLinkTime(latest.timestamp) }} (UTC+8)</p
          ><dl class="kv"
            ><template
              v-for="item in LINK_METRICS"
              :key="item.key"
              ><dt>{{ item.label }}</dt
              ><dd
                >{{ formatLinkMetric(item.key, latest.metrics[item.key].value) }}
                {{ latest.metrics[item.key].value === null ? '' : item.unit }} ·
                {{ LINK_METRIC_STYLES[latest.metrics[item.key].status].label }}
                {{ latest.metrics[item.key].reason }}</dd
              ></template
            ></dl
          ><LinkHistoryChart
            :link-id="data.link.id"
            :samples="detail.samples" /><LinkAssessmentPanel
            :display="assessment.display"
            :owner="assessment.owner"
            :observed-state="latest.linkState"
        /></template> </section
      ><section
        v-if="data.link"
        class="linked-services"
        aria-label="链路关联业务"
        ><h4>关联业务</h4
        ><p
          v-if="associationIssue"
          class="network-note"
          role="status"
          >{{ associationIssue }}</p
        ><p
          v-else-if="!linkedServices.length"
          class="network-note"
          >此快照未提供经过该链路的关联业务。</p
        ><template v-else
          ><article
            v-for="item in linkedServices"
            :key="item.service.id"
            ><div class="service-heading"
              ><strong>{{ item.service.name }} · {{ item.service.serviceType }}</strong
              ><button
                class="btn small"
                :aria-label="'查看业务 ' + item.service.name"
                :disabled="busy"
                :onClick="item.open"
                >查看业务</button
              ></div
            ><p class="network-note">{{ item.service.id }}</p
            ><p>源端 {{ item.service.sourceDeviceId }} → 目的端 {{ item.service.targetDeviceId }}</p
            ><p>{{
              item.routes
                .map((route) =>
                  route.routeType === 'PRIMARY' ? '主路径包含此链路' : '备用路径包含此链路',
                )
                .join('；')
            }}</p></article
          ><p class="network-note"
            >关联来自此快照的预设路径，备用路径不表示已切换或正在承载流量。</p
          ></template
        ></section
      >
      <template v-if="data.service"
        ><h4>{{ data.service.name }}</h4
        ><p
          >{{ data.service.id }} · {{ data.service.serviceType }}<br />源端
          {{ data.service.sourceDeviceId }} → 目的端 {{ data.service.targetDeviceId }}</p
        ><article
          v-for="route in data.routes"
          :key="route.id"
          ><strong>{{ route.routeType === 'PRIMARY' ? '主路径' : '备用路径' }}</strong
          ><p>{{ route.nodeIds.join(' → ') }}<br />{{ route.linkIds.join(' → ') }}</p></article
        ></template
      ><button
        v-if="context === 'gis'"
        class="btn"
        :disabled="busy"
        :onClick="navigation.locate"
        >在当前网络地图定位</button
      ><MapCanvas
        v-else-if="data.stations.length"
        :key="data.snapshotId + ':' + (data.link?.id ?? data.service?.id)"
        class="network-map"
        :stations="data.stations"
        :links="data.links"
        :highlight-link-ids="data.links.map((l) => l.id)"
        :show-coverage="false"
        :show-candidates="false"
        :collapsible-legend="true"
        :compact="true"
      /><p v-else>此快照未提供定位坐标。</p></template
    ></section
  >
</template>
<script setup lang="ts">
import LinkDetailPanel from './LinkDetailPanel.vue';
import { computed, onBeforeUnmount } from 'vue';
import LinkHistoryChart from './LinkHistoryChart.vue';
import LinkAssessmentPanel from './LinkAssessmentPanel.vue';
import {
  selectLinkDetail,
  selectHistoryAssessment,
  formatLinkTime,
  formatLinkMetric,
  LINK_METRICS,
  LINK_METRIC_STYLES,
} from '../services/link-detail';
import MapCanvas from './MapCanvas.vue';
import type { DeviceNetworkContext, DeviceNetworkDetail } from '../types/device-network';
// 资源页地图只渲染响应里的同源端点，不补取当前资源。
const props = defineProps<{
  data: DeviceNetworkDetail | null;
  busy: boolean;
  error: string;
  context: 'gis' | 'ledger';
  network?: DeviceNetworkContext;
  parentLink?: DeviceNetworkDetail | null;
}>();
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});
const associationIssue = computed(() => {
  const source = props.network,
    link = props.data?.link;
  if (!source || source.state === 'missing') return source?.message || '未提供链路关联业务资料。';
  if (source.state === 'stale') return source.message || '网络关联资料已过期，暂不可进入业务。';
  if (source.state !== 'ready') return source.message || '网络关联资料无效，暂不可进入业务。';
  if (source.snapshotId !== props.data?.snapshotId)
    return '链路与业务资料快照不一致，暂不可进入业务。';
  if (!link || !source.links.some((item) => item.id === link.id))
    return '当前链路不在设备关联资料中，暂不可进入业务。';
  return '';
});
const linkedServices = computed(() => {
  const data = props.data,
    source = props.network;
  if (associationIssue.value || !data?.link || !source) return [];
  const linkId = data.link.id,
    snapshotId = data.snapshotId;
  // 仅筛选路径中明确给出的链路关系，不推算实时业务，也不借其他快照补资料。
  return source.services.flatMap((service) => {
    const routes = source.routes.filter(
      (route) => route.demandId === service.id && route.linkIds.includes(linkId),
    );
    return routes.length
      ? [
          {
            service,
            routes,
            open: () => {
              if (
                !alive ||
                props.busy ||
                props.data !== data ||
                props.network !== source ||
                associationIssue.value ||
                !source.services.some((item) => item.id === service.id) ||
                !source.routes.some(
                  (route) => route.demandId === service.id && route.linkIds.includes(linkId),
                )
              )
                return;
              emit('service', service.id, linkId, snapshotId);
            },
          },
        ]
      : [];
  });
});
// 事件闭包绑定渲染时的详情；换层、失效或卸载后的旧按钮不能操作新现场。
const navigation = computed(() => {
  const data = props.data,
    parent = props.parentLink;
  const current = () => alive && props.data === data && props.parentLink === parent;
  return {
    device: () => {
      if (current()) emit('back');
    },
    link: () => {
      if (current() && data?.service && parent?.link) emit('back-link');
    },
    locate: () => {
      if (current() && !props.busy && props.context === 'gis' && data)
        emit('locate', {
          snapshotId: data.snapshotId,
          linkIds: data.links.map((link) => link.id),
          stationIds: data.stations.map((station) => station.id),
        });
    },
  };
});
// 资源上下文沿用同源指标和图表，不借用 GIS 专属查看权限。
const detail = computed(() =>
  props.data?.link ? selectLinkDetail(props.data.linkDetails, props.data.link.id).record : null,
);
const latest = computed(() => detail.value?.samples.at(-1));
const assessment = computed(() =>
  selectHistoryAssessment(props.data!.linkDetails, props.data!.link!.id),
);
const emit = defineEmits<{
  back: [];
  'back-link': [];
  service: [id: string, linkId: string, snapshotId: string];
  locate: [value: { snapshotId: string; linkIds: string[]; stationIds: string[] }];
}>();
</script>
<style scoped>
section {
  font-size: 12px;
  overflow-wrap: anywhere;
}
.network-navigation,
.service-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.network-navigation {
  justify-content: flex-start;
  margin-bottom: 10px;
}
.network-detail p {
  line-height: 1.7;
  margin: 8px 0;
}
.network-breadcrumb,
.network-note {
  color: var(--muted);
}
.network-breadcrumb {
  font-size: 11px;
}
.linked-services {
  margin: 16px 0;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}
.linked-services h4 {
  font-size: 13px;
  margin-bottom: 8px;
}
.service-heading .btn {
  white-space: nowrap;
}
.network-map {
  height: 260px;
  min-height: 260px;
  margin-top: 12px;
}
article {
  padding: 8px 0;
  border-top: 1px solid var(--line);
}
</style>
