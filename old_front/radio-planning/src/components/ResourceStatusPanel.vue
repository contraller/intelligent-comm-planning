<template>
  <section
    class="resource-status-panel"
    aria-label="设备状态同步"
  >
    <div class="toolbar">
      <strong>设备状态同步</strong>
      <label
        >状态来源
        <select
          aria-label="设备状态来源"
          :value="enabled ? status.mode : 'baseline'"
          :disabled="!entry.available.value || status.busy"
          @change="
            entry.available.value &&
            !status.busy &&
            status.setMode(($event.target as HTMLSelectElement).value as 'baseline' | 'observed')
          "
        >
          <option value="baseline">台账基线</option
          ><option
            value="observed"
            :disabled="!status.batch"
            >同步观测</option
          >
        </select></label
      >
      <label v-if="status.catalog?.examples?.length"
        >教学样例
        <select
          aria-label="设备状态教学样例"
          :value="status.exampleId"
          :disabled="!entry.available.value || status.busy"
          @change="
            entry.available.value &&
            !status.busy &&
            status.setExample(($event.target as HTMLSelectElement).value)
          "
        >
          <option
            v-for="example in status.catalog.examples"
            :key="example.id"
            :value="example.id"
            >{{ example.label }}</option
          >
        </select></label
      >
      <button
        class="btn small"
        :disabled="disabled || !allIds.length"
        @click="entry.sync(allIds)"
        >同步全部设备状态（{{ allIds.length }}）</button
      >
      <button
        v-if="selectedIds"
        class="btn small"
        :disabled="disabled || !selectedIds.length"
        @click="entry.sync(selectedIds)"
        >同步勾选设备状态（{{ selectedIds.length }}）</button
      >
      <span v-if="hiddenCount">包含筛选外 {{ hiddenCount }} 台</span>
      <button
        v-if="!status.catalog"
        class="btn small"
        :disabled="!entry.available.value || status.busy"
        @click="entry.retry"
        >重试状态目录</button
      >
    </div>
    <p>预生成状态样例，未连接真实设备。同步只刷新观测展示；台账基线为已保存状态。</p>
    <p v-if="context === 'gis'">站点参考点与资源树节点继续显示节点自身台账基线。</p>
    <p
      v-if="pausedReason"
      role="status"
      >{{ pausedReason }}</p
    >
    <p
      v-if="status.busy"
      role="status"
      >正在读取设备状态…</p
    >
    <p
      v-if="status.notice"
      role="status"
      >{{ status.notice }}</p
    >
    <p
      v-if="status.error"
      role="alert"
      >{{ status.error }}</p
    >
    <details v-if="status.batch && entry.available.value">
      <summary
        >最近批次：已上报 {{ count('REPORTED') }} / 未上报 {{ count('NO_REPORT') }} / 失败
        {{ count('FAILED') }}（{{ status.source?.label }}）</summary
      >
      <ul
        ><li
          v-for="item in status.batch.items"
          :key="item.deviceId"
          >{{ item.deviceId }}：{{
            item.outcome === 'REPORTED' ? '已上报' : item.outcome === 'FAILED' ? '失败' : '未上报'
          }}
          {{ item.reason || ''
          }}<template v-if="item.outcome === 'REPORTED'">
            · 采集 {{ item.observation.observedAt }}</template
          >
          · 最近获取 {{ status.records[item.deviceId]?.fetchedAt
          }}<span v-if="status.records[item.deviceId]?.retained">
            · 上次记录（{{ status.records[item.deviceId]?.reason }}）</span
          >
        </li></ul
      >
    </details>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type { DeviceStatusContext } from '../types/resource-status';
import { useResourceStatusEntry } from '../stores/resource-status';
import { usePreviewStore } from '../stores/preview';
const props = withDefaults(
  defineProps<{
    context: DeviceStatusContext;
    enabled?: boolean;
    selectedIds?: string[];
    hiddenCount?: number;
    pausedReason?: string;
  }>(),
  { enabled: true, hiddenCount: 0 },
);
const entry = useResourceStatusEntry(props.context, () => props.enabled),
  status = entry.status,
  preview = usePreviewStore();
const allIds = computed(() => preview.data?.resources.devices.map((d) => d.id) ?? []);
const count = (outcome: string) =>
  status.batch?.items.filter((i) => i.outcome === outcome).length ?? 0;
// 全部和勾选均使用已保存 ID；分页及筛选不截断同步目标。
const disabled = computed(() => !entry.available.value || status.busy || !status.catalog);
</script>
<style scoped>
.resource-status-panel {
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: #101e30;
  font-size: 12px;
}
.toolbar {
  flex-wrap: wrap;
  gap: 10px;
}
.toolbar label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.toolbar select {
  width: auto;
}
p {
  margin: 8px 0 0;
  color: var(--muted);
}
[role='alert'] {
  color: #f5a6b2;
}
summary {
  cursor: pointer;
  margin-top: 8px;
}
ul {
  max-height: 190px;
  overflow: auto;
  padding-left: 22px;
  line-height: 1.8;
}
</style>
