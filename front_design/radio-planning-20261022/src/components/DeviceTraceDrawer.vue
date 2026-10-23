<template>
  <AppDrawer
    :visible="visible"
    title="设备变更追溯"
    subtitle="查看设备台账的修改内容与历史状态；配置下发记录单独展示。时间均为北京时间（UTC+8）。"
    width="720px"
    @update:visible="!$event && $emit('close')"
  >
    <div class="trace-toolbar"
      ><button
        class="btn small"
        :disabled="busy"
        @click="$emit('refresh')"
        >刷新追溯</button
      ><span
        v-if="busy"
        role="status"
        >读取中…</span
      ></div
    >
    <p
      v-if="error"
      role="alert"
      >{{ error }}</p
    >
    <section
      class="trace-section"
      aria-label="台账变更与历史版本"
    >
      <h3>台账变更与历史版本</h3>
      <section
        v-if="record"
        class="trace-detail"
        aria-label="选中记录详情"
      >
        <div class="section-heading"
          ><h4>{{ isDeviceBaseline(record) ? '初始基线 · 留存状态' : '字段前后对比' }}</h4
          ><span class="record-badge">{{ isDeviceBaseline(record) ? '基线' : '已选中' }}</span></div
        >
        <p
          >{{ isDeviceBaseline(record) ? '留存时间' : '变更时间' }}：{{
            formatMaintenanceTime(record.time)
          }}</p
        >
        <p
          v-if="isDeviceBaseline(record)"
          class="trace-note"
          >这是首次修改前留存的设备状态，并非一次新增或修改。原操作人及原修改时间未知，以下仅展示留存值。</p
        >
        <p v-else>操作人：{{ record.actor?.name ?? '未提供' }} · {{ record.source }}</p>
        <dl
          v-if="isDeviceBaseline(record)"
          class="snapshot-grid"
          ><template
            v-for="row in maintenanceSnapshotRows(record.after)"
            :key="row.key"
            ><dt>{{ row.label }}</dt
            ><dd>{{ row.value }}</dd></template
          ></dl
        >
        <table
          v-else
          class="change-table"
          aria-label="台账字段前后对比"
          ><thead
            ><tr
              ><th scope="col">参数</th><th scope="col">修改前</th><th scope="col">修改后</th></tr
            ></thead
          ><tbody
            ><tr
              v-for="row in maintenanceChangeRows(record.changes)"
              :key="row.key"
              ><th scope="row">{{ row.label }}</th
              ><td data-label="修改前">{{ row.before }}</td
              ><td data-label="修改后">{{ row.after }}</td></tr
            ></tbody
          ></table
        >
        <p
          v-if="!isDeviceBaseline(record) && !record.changes.length"
          class="trace-note"
          >此记录未提供字段差异。</p
        >
        <details class="record-identifiers"
          ><summary>记录标识</summary
          ><dl class="snapshot-grid"
            ><dt>记录编号</dt><dd>{{ record.id }}</dd
            ><dt>保存版本</dt
            ><dd>{{ record.revision === 'initial' ? '初始基线' : record.revision }}</dd
            ><dt>前一版本</dt
            ><dd>{{
              record.previousRevision === 'initial' ? '初始基线' : record.previousRevision
            }}</dd
            ><template v-if="record.restoredFrom"
              ><dt>恢复来源记录</dt><dd>{{ record.restoredFrom }}</dd></template
            ></dl
          ></details
        >
        <button
          v-if="editable"
          class="btn"
          :disabled="busy"
          @click="$emit('preview')"
          >预览恢复此版本</button
        >
      </section>
      <DeviceRestorePreview
        v-if="restore"
        :preview="restore"
        :editable="editable"
        :busy="busy"
        @apply="$emit('restore', $event)"
      />
      <p
        v-if="history && !history.total"
        class="trace-note"
        >尚无设备变更记录。首次保存后开始积累。</p
      >
      <p
        v-else-if="history && !record"
        class="trace-note"
        >选择一条记录查看差异或基线状态。</p
      >
      <h4
        v-if="changes.length"
        class="list-heading"
        >变更记录</h4
      >
      <article
        v-for="item in changes"
        :key="item.id"
        class="record-card"
        :class="{ selected: record?.id === item.id }"
        ><div class="section-heading"
          ><strong>{{ item.source }}</strong
          ><button
            class="btn small"
            :disabled="busy"
            :aria-pressed="record?.id === item.id"
            @click="$emit('select', item.id)"
            >查看差异</button
          ></div
        >
        <p>{{ formatMaintenanceTime(item.time) }} · {{ item.actor?.name ?? '操作人未提供' }}</p
        ><p class="trace-note">{{
          item.fields.map(maintenanceFieldLabel).join('、') || '未提供变更字段'
        }}</p>
        <p
          v-if="item.restoredFrom"
          class="trace-note"
          >由历史恢复保存产生</p
        ></article
      >
      <h4
        v-if="baselines.length"
        class="list-heading"
        >初始基线</h4
      >
      <article
        v-for="item in baselines"
        :key="item.id"
        class="record-card baseline-card"
        :class="{ selected: record?.id === item.id }"
        ><div class="section-heading"
          ><strong>首次留存的修改前状态</strong
          ><button
            class="btn small"
            :disabled="busy"
            :aria-pressed="record?.id === item.id"
            @click="$emit('select', item.id)"
            >查看基线</button
          ></div
        ><p>留存时间：{{ formatMaintenanceTime(item.time) }}</p
        ><p class="trace-note"
          >原操作人及原修改时间未知。此快照用于查看或预览恢复，不代表一次修改。</p
        ></article
      >
      <div
        v-if="history"
        class="pager"
        ><button
          class="btn small"
          :disabled="busy || history.pageNum <= 1"
          @click="$emit('page', history.pageNum - 1)"
          >上一页</button
        ><span>记录总数 {{ history.total }} 条 · 第 {{ history.pageNum }} 页</span
        ><button
          class="btn small"
          :disabled="busy || history.pageNum * history.pageSize >= history.total"
          @click="$emit('page', history.pageNum + 1)"
          >下一页</button
        ></div
      >
    </section>
    <section
      class="trace-section"
      aria-label="配置下发与回执"
    >
      <h3>配置下发与回执</h3
      ><p class="trace-note"
        >这里记录发送给设备的参数及执行结果。保存台账不会自动下发，执行成功也不会修改台账。</p
      >
      <section
        v-if="configuration?.operation"
        class="trace-detail"
        aria-label="选中配置回执"
      >
        <h4>配置请求与执行结果</h4
        ><p
          >{{ configuration.operation.actor?.name ?? '操作人未提供' }} ·
          {{ configurationStatusLabel(configuration.operation.status) }}</p
        ><p
          >受理：{{ formatMaintenanceTime(configuration.operation.acceptedAt) }}<br />更新：{{
            formatMaintenanceTime(configuration.operation.updatedAt)
          }}</p
        >
        <p
          v-if="configuration.sourceChanged"
          class="trace-warning"
          >此记录对应的资源来源已变化，请按当时的请求与执行值查看。</p
        >
        <table
          class="change-table"
          aria-label="配置请求与执行参数"
          ><thead
            ><tr
              ><th scope="col">参数</th><th scope="col">请求值</th><th scope="col">执行值</th></tr
            ></thead
          ><tbody
            ><tr
              v-for="row in configurationRows"
              :key="row.key"
              ><th scope="row">{{ row.label }}</th
              ><td data-label="请求值">{{ row.before }}</td
              ><td data-label="执行值">{{
                configuration.operation.appliedValues ? row.after : '尚无执行值'
              }}</td></tr
            ></tbody
          ></table
        >
        <p>{{ configuration.operation.message }}</p>
      </section>
      <p
        v-else-if="configuration?.status === 'NOT_FOUND'"
        class="trace-note"
        >未找到所选配置记录。</p
      >
      <p
        v-if="configurations && !configurations.total"
        class="trace-note"
        >尚无配置下发记录。</p
      >
      <article
        v-for="item in configurations?.items"
        :key="item.id"
        class="record-card"
        :class="{ selected: configuration?.operation?.request.requestId === item.requestId }"
        ><div class="section-heading"
          ><strong>{{ configurationStatusLabel(item.status) }}</strong
          ><button
            class="btn small"
            :disabled="busy"
            :aria-pressed="configuration?.operation?.request.requestId === item.requestId"
            @click="$emit('configuration', item.requestId)"
            >查看回执</button
          ></div
        ><p>{{ formatMaintenanceTime(item.acceptedAt) }}</p
        ><p
          v-if="item.sourceChanged"
          class="trace-warning"
          >历史来源已变化</p
        ></article
      >
      <div
        v-if="configurations"
        class="pager"
        ><button
          class="btn small"
          :disabled="busy || configurations.pageNum <= 1"
          @click="$emit('configuration-page', configurations.pageNum - 1)"
          >上一页</button
        ><span>配置共 {{ configurations.total }} 条 · 第 {{ configurations.pageNum }} 页</span
        ><button
          class="btn small"
          :disabled="
            busy || configurations.pageNum * configurations.pageSize >= configurations.total
          "
          @click="$emit('configuration-page', configurations.pageNum + 1)"
          >下一页</button
        ></div
      >
    </section>
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import AppDrawer from './AppDrawer.vue';
import DeviceRestorePreview from './DeviceRestorePreview.vue';
import type { PageResult } from '../types/data-access';
import type {
  DeviceHistorySummary,
  DeviceHistory,
  DeviceRestorePreview as RestorePreview,
} from '../types/device-maintenance';
import type {
  ConfigurationHistoryItem,
  ConfigurationOperationResult,
} from '../types/device-configuration';
import {
  configurationStatusLabel,
  formatMaintenanceTime,
  isDeviceBaseline,
  maintenanceChangeRows,
  maintenanceFieldLabel,
  maintenanceSnapshotRows,
} from '../services/device-maintenance-display';
// 详情按选中记录读取，不把历史全文放入设备列表。
const props = defineProps<{
  visible: boolean;
  busy: boolean;
  error: string;
  editable: boolean;
  history: PageResult<DeviceHistorySummary> | null;
  record: DeviceHistory | null;
  restore: RestorePreview | null;
  configurations: PageResult<ConfigurationHistoryItem> | null;
  configuration: ConfigurationOperationResult | null;
}>();
defineEmits<{
  close: [];
  refresh: [];
  select: [id: string];
  page: [page: number];
  preview: [];
  restore: [value: RestorePreview];
  configuration: [requestId: string];
  'configuration-page': [page: number];
}>();
// 基线与真实变更分组展示，分页总数仍使用服务返回的记录数。
const changes = computed(
  () => props.history?.items.filter((item) => !isDeviceBaseline(item)) ?? [],
);
const baselines = computed(() => props.history?.items.filter(isDeviceBaseline) ?? []);
const configurationRows = computed(() => {
  const operation = props.configuration?.operation;
  return operation
    ? maintenanceChangeRows(
        ['txPowerDbm', 'workFreqKhz', 'currentWorkMode'].map((field) => ({
          field,
          before: operation.request.values[field as keyof typeof operation.request.values],
          after: operation.appliedValues?.[field as keyof typeof operation.request.values],
        })),
      )
    : [];
});
</script>
<style scoped>
.trace-toolbar,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.trace-toolbar {
  margin-bottom: 18px;
  color: var(--muted);
}
.trace-section + .trace-section {
  margin-top: 24px;
  padding-top: 22px;
  border-top: 1px solid var(--line);
}
.trace-section h3 {
  margin-bottom: 12px;
}
.trace-section h4 {
  font-size: 13px;
}
.trace-section p {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.trace-note {
  color: var(--muted);
}
.trace-warning {
  color: var(--yellow);
}
.trace-detail {
  margin: 12px 0 18px;
  padding: 16px;
  border: 1px solid var(--cyan);
  border-radius: 8px;
  background: var(--panel);
}
.trace-detail > .btn {
  margin-top: 14px;
}
.record-badge {
  color: var(--cyan);
  font-size: 11px;
}
.list-heading {
  margin: 16px 0 10px;
}
.record-card {
  margin: 10px 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 7px;
}
.record-card.selected {
  border-color: var(--cyan);
}
.baseline-card {
  border-style: dashed;
}
.record-identifiers {
  margin-top: 14px;
  color: var(--muted);
  font-size: 12px;
}
.record-identifiers summary {
  cursor: pointer;
}
.snapshot-grid {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) minmax(0, 2fr);
  gap: 10px 16px;
  margin: 14px 0 0;
  font-size: 12px;
}
.snapshot-grid dt {
  color: var(--muted);
}
.snapshot-grid dd {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.change-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  margin-top: 14px;
  font-size: 12px;
}
.change-table th,
.change-table td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.change-table thead {
  color: var(--muted);
}
.change-table th:first-child {
  width: 32%;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  margin: 12px 0;
  flex-wrap: wrap;
}
@media (max-width: 560px) {
  .trace-detail {
    padding: 12px;
  }
  .change-table,
  .change-table tbody,
  .change-table tr,
  .change-table th,
  .change-table td {
    display: block;
    width: auto;
  }
  .change-table thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .change-table tr {
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
  }
  .change-table th:first-child {
    width: auto;
  }
  .change-table th,
  .change-table td {
    padding: 5px 0;
    border: 0;
  }
  .change-table td::before {
    content: attr(data-label) '：';
    color: var(--muted);
  }
  .snapshot-grid {
    grid-template-columns: 1fr;
    gap: 5px;
  }
  .snapshot-grid dd {
    margin-bottom: 8px;
  }
}
</style>
