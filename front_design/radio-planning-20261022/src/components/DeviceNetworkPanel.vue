<template>
  <section class="device-network"
    ><p
      v-if="!networkReadable"
      class="network-note"
      >当前角色没有 GIS 查看权限，无法查看网络关联。</p
    ><p
      v-else-if="network?.state !== 'ready'"
      class="network-note"
      role="status"
      >{{ network?.message || '暂无当前演示网络的关联资料' }}</p
    ><template v-else
      ><p class="network-note"
        >{{ network.title }} · {{ network.snapshotId }}<br />{{ network.source }}</p
      ><h5>关联链路 · {{ detail.links.length }} 条</h5
      ><p
        v-if="!detail.links.length"
        class="network-note"
        >当前演示网络未关联此设备。</p
      ><article
        v-for="link in detail.links"
        :key="link.id"
        class="network-item"
        ><button
          class="btn small"
          @click="$emit('detail', 'link', link.id, network!.snapshotId)"
          ><strong>{{ link.id }}</strong></button
        ><span
          class="link-state"
          :style="{ color: LINK_STATUS_STYLES[link.state].color }"
          >{{ LINK_STATUS_STYLES[link.state].label }}</span
        ><dl class="kv"
          ><dt>对端设备</dt><dd>{{ deviceLabel(peer(link)) }}</dd
          ><dt>链路频点</dt><dd>{{ link.frequencyKhz }} kHz</dd><dt>链路标记</dt
          ><dd>{{ link.backup ? '备用链路' : '普通链路' }}</dd></dl
        ></article
      ><h5>承载业务 · {{ detail.services.length }} 项</h5
      ><p
        v-if="!detail.services.length"
        class="network-note"
        >此设备暂无预设承载业务。</p
      ><article
        v-for="item in detail.services"
        :key="item.service.id"
        class="network-item"
        ><button
          class="btn small"
          @click="$emit('detail', 'service', item.service.id, network!.snapshotId)"
          ><strong>{{ item.service.name }} · {{ item.service.serviceType }}</strong></button
        ><p class="network-note">{{ item.service.id }}</p
        ><p
          >源端：{{ deviceLabel(item.service.sourceDeviceId) }}<br />目的端：{{
            deviceLabel(item.service.targetDeviceId)
          }}</p
        ><div
          v-for="entry in item.routes"
          :key="entry.route.id"
          class="network-route"
          ><b>{{ entry.route.routeType === 'PRIMARY' ? '主路径' : '备用路径' }}</b
          ><span class="route-role">{{
            entry.participates
              ? entry.route.routeType === 'PRIMARY'
                ? '主路径参与'
                : '备用保障'
              : '未经过本设备'
          }}</span
          ><p>{{ entry.route.nodeIds.map(stationName).join(' → ') }}</p
          ><p class="network-note">{{ entry.route.linkIds.join(' → ') }}</p></div
        ></article
      ><p
        v-if="detail.services.length"
        class="network-note"
        >预设路径用于教学展示；备用保障不表示已切换或正在承载流量。</p
      ></template
    ></section
  >
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { LINK_STATUS_STYLES } from '../config/link-status';
import { selectDeviceNetwork } from '../services/device-network';
import type { NetworkLink } from '../types/domain';
import type { GisResourceIndex } from '../types/gis-workspace';
import type { DeviceNetworkContext } from '../types/device-network';

const props = defineProps<{
  deviceId: string;
  resources: Pick<GisResourceIndex, 'stations' | 'devices'>;
  network?: DeviceNetworkContext;
  context?: 'gis' | 'ledger';
}>();
defineEmits<{ detail: [kind: 'link' | 'service', id: string, snapshotId: string] }>();
const auth = useAuthStore();
const networkReadable = computed(() =>
  auth.can(props.context === 'ledger' ? 'resources.view' : 'situation.view'),
);
// 查看权限独立于编辑权限；不发请求、不提交资源，也不自动切换主备路径。
const detail = computed(() =>
  selectDeviceNetwork(networkReadable.value ? props.network : undefined, props.deviceId),
);
const stationName = (id: string) =>
  props.resources.stations.find((row) => row.id === id)?.name ?? id;
const deviceLabel = (id: string) => {
  const stationId = props.resources.devices.find((row) => row.id === id)?.stationId;
  return stationId ? `${stationName(stationId)} · ${id}` : id;
};
const peer = (link: NetworkLink) => (link.deviceA === props.deviceId ? link.deviceB : link.deviceA);
</script>

<style scoped>
.device-network {
  min-width: 0;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.device-network h5 {
  margin: 14px 0 8px;
  color: #bbd8ee;
  font-size: 12px;
}
.network-note {
  color: var(--muted);
  font-size: 11px;
}
.network-item {
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.network-item p {
  margin-top: 6px;
}
.link-state {
  margin-left: 10px;
}
.network-route {
  margin-top: 10px;
  padding-left: 10px;
  border-left: 2px solid #365674;
}
.route-role {
  display: inline-block;
  margin-left: 8px;
  color: #8dbfe2;
  font-size: 11px;
}
.kv dd {
  min-width: 0;
}
</style>
