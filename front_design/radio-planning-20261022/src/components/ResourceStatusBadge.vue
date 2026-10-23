<template>
  <div class="resource-status-badge">
    <span
      class="status-label"
      :class="tone"
      >{{ label
      }}{{ value.alert === true ? ' · 告警' : value.alert === null ? ' · 告警未提供' : '' }}</span
    >
    <small
      >{{ value.mode === 'baseline' ? '台账基线' : value.sourceLabel
      }}<template v-if="value.retained"> · 上次记录</template></small
    >
    <template v-if="!compact">
      <small>采集时间：{{ value.observedAt || '未提供' }}</small>
      <small v-if="value.mode === 'observed'">最近获取：{{ value.fetchedAt || '尚未获取' }}</small>
      <small>{{ value.note }}</small>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { DeviceStatusDisplay } from '../types/resource-status';
const props = defineProps<{ value: DeviceStatusDisplay; compact?: boolean }>();
// 未知及告警缺省采用中性色，不能落入原正常绿的默认分支。
const tone = computed(() =>
  props.value.status === 'FAULT'
    ? 'fault'
    : props.value.status === 'OFFLINE'
      ? 'offline'
      : props.value.status === null || props.value.alert === null
        ? 'unknown'
        : props.value.alert
          ? 'alert'
          : 'normal',
);
const label = computed(() =>
  props.value.status === null
    ? '状态未提供'
    : { NORMAL: '正常', FAULT: '故障', OFFLINE: '离线' }[props.value.status],
);
</script>
<style scoped>
.resource-status-badge {
  display: grid;
  gap: 4px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.resource-status-badge small {
  color: var(--muted);
  font-size: 11px;
}
.normal {
  color: #45c9af;
}
.fault {
  color: #f27887;
}
.offline {
  color: #8192a8;
}
.alert {
  color: #f0bd67;
}
.unknown {
  color: #b8bed0;
}
</style>
