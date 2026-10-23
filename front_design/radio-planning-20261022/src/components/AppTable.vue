<template>
  <DataTable
    v-model:expanded-rows="expandedRows"
    :class="{ 'compact-table': compact }"
    :table-style="tableMinWidth ? { minWidth: tableMinWidth } : undefined"
    :value="rows"
    :selection="selected"
    data-key="id"
    selection-mode="single"
    :paginator="paginator"
    :rows="pageSize"
    :lazy="server"
    :total-records="server ? total : undefined"
    :first="server ? first : undefined"
    :loading="loading"
    :sort-field="sortable && !controlledSort ? sortField : undefined"
    :sort-order="sortable && !controlledSort ? sortOrder : undefined"
    :rows-per-page-options="[5, 10, 20, 50]"
    sort-mode="single"
    removable-sort
    striped-rows
    row-hover
    scrollable
    paginator-template="CurrentPageReport FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown"
    current-page-report-template="共 {totalRecords} 条 · 第 {first}–{last} 条"
    @update:selection="(value: T) => value && $emit('select', value)"
    @page="
      expandedRows = {};
      server && $emit('page', { first: $event.first, rows: $event.rows });
    "
    @sort="
      sortable &&
      !controlledSort &&
      server &&
      $emit('sort', {
        sortField: typeof $event.sortField === 'string' ? $event.sortField : undefined,
        sortOrder: $event.sortOrder,
      })
    "
  >
    <template #empty><div class="empty-inline">暂无符合条件的数据</div></template>
    <Column
      v-if="detailColumns.length || $slots.details"
      expander
      header="详情"
      style="width: 44px; min-width: 44px"
      :pt="{ rowToggleButton: { 'aria-label': '展开或收起详情', title: '展开或收起详情' } }"
    />
    <Column
      v-for="column in columns"
      :key="column.field"
      :field="column.field"
      :header="controlledSort ? undefined : column.header"
      :sortable="sortable && !controlledSort && column.sortable !== false"
      :style="column.minWidth ? { minWidth: column.minWidth } : undefined"
      :pt="
        controlledSort && sortable && column.sortable
          ? {
              headerCell: {
                'aria-sort':
                  sortField === column.field
                    ? sortOrder === -1
                      ? 'descending'
                      : 'ascending'
                    : 'none',
              },
            }
          : undefined
      "
    >
      <!-- 受控表头只发列选择事件，数值规则和显示顺序由调用方管理。 -->
      <template
        v-if="controlledSort"
        #header
      >
        <button
          v-if="sortable && column.sortable"
          type="button"
          class="header-sort"
          :aria-label="`按${column.header}排序`"
          @click.stop="emit('sort', { sortField: column.field })"
          >{{ column.header
          }}<span aria-hidden="true">{{
            sortField === column.field ? (sortOrder === -1 ? '↓' : '↑') : '↕'
          }}</span></button
        >
        <span v-else>{{ column.header }}</span>
      </template>
      <template #body="slotProps"
        ><slot
          :name="column.field"
          :row="slotProps.data as T"
          >{{ cellValue(slotProps.data, column.field) }}</slot
        ></template
      >
    </Column>
    <Column
      v-if="$slots.actions"
      header="操作"
      :style="actionsMinWidth || compact ? { minWidth: actionsMinWidth || '88px' } : undefined"
      ><template #body="slotProps"
        ><div
          v-if="compact"
          class="table-actions"
          ><slot
            name="actions"
            :row="slotProps.data as T" /></div
        ><slot
          v-else
          name="actions"
          :row="slotProps.data as T" /></template
    ></Column>
    <template #expansion="slotProps">
      <slot
        name="details"
        :row="slotProps.data as T"
      >
        <dl class="table-details"
          ><template
            v-for="column in detailColumns"
            :key="column.field"
            ><dt>{{ column.header }}</dt
            ><dd
              ><slot
                :name="`detail-${column.field}`"
                :row="slotProps.data as T"
                >{{ cellValue(slotProps.data, column.field) }}</slot
              ></dd
            ></template
          ></dl
        >
      </slot>
    </template>
  </DataTable>
</template>
<script setup lang="ts" generic="T extends { id: string }">
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import { ref, watch } from 'vue';
const props = withDefaults(
  defineProps<{
    rows: T[];
    columns: { field: string; header: string; sortable?: boolean; minWidth?: string }[];
    // 紧凑阅读和展开明细均由调用方显式启用，不改变其他页面默认布局。
    sortable?: boolean;
    controlledSort?: boolean;
    compact?: boolean;
    tableMinWidth?: string;
    actionsMinWidth?: string;
    detailColumns?: { field: string; header: string }[];
    detailsKey?: string;
    selected?: T | null;
    pageSize?: number;
    // 已有外层服务分页的页面可关闭内部分页，其他使用者保持默认。
    paginator?: boolean;
    server?: boolean;
    total?: number;
    first?: number;
    loading?: boolean;
    sortField?: string;
    sortOrder?: number;
  }>(),
  {
    pageSize: 10,
    paginator: true,
    sortable: true,
    controlledSort: false,
    compact: false,
    detailColumns: () => [],
  },
);
const expandedRows = ref<Record<string, boolean>>({});
// 换结果、筛选或翻页后关闭旧明细，不能因相同 ID 继承上个快照的展开现场。
watch(
  () => [props.rows, props.detailsKey],
  () => {
    expandedRows.value = {};
  },
  { flush: 'sync' },
);
// 服务端模式只发事件，不把本页记录当作完整集合排序或统计。
const emit = defineEmits<{
  select: [value: T];
  page: [value: { first: number; rows: number }];
  sort: [value: { sortField?: string; sortOrder?: number | null }];
}>();
// 空值统一占位；具体业务列可用插槽覆盖展示。
function cellValue(row: T, field: string) {
  const value = (row as unknown as Record<string, unknown>)[field];
  if (value == null) return props.compact ? '未提供' : '—';
  if (props.compact && Array.isArray(value)) return value.length ? value.join(' / ') : '无';
  if (props.compact && typeof value === 'boolean') return value ? '是' : '否';
  return value;
}
</script>
<style scoped>
.header-sort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.header-sort span {
  width: 12px;
  color: var(--muted);
}
.header-sort:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}
.compact-table {
  min-width: 0;
}
.compact-table :deep(.p-datatable-table-container) {
  max-width: 100%;
}
.compact-table :deep(.p-datatable-thead > tr > th) {
  padding: 10px 8px;
  white-space: nowrap;
}
.compact-table :deep(.p-datatable-tbody > tr > td) {
  padding: 10px 8px;
  line-height: 1.6;
  vertical-align: top;
}
.compact-table :deep(.p-paginator) {
  gap: 3px;
  padding: 10px 4px;
  flex-wrap: wrap;
}
.table-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
}
.table-actions :deep(button) {
  white-space: nowrap;
  flex-shrink: 0;
}
.table-details {
  display: grid;
  grid-template-columns: minmax(100px, 140px) minmax(0, 1fr);
  gap: 8px 16px;
  margin: 0;
  padding: 12px;
  background: #14283d;
  font-size: 12px;
}
.table-details dt {
  color: var(--muted);
}
.table-details dd {
  margin: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .table-details {
    grid-template-columns: 100px minmax(0, 1fr);
    padding: 8px;
    gap: 8px;
  }
}
</style>
