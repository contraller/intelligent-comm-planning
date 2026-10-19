<template>
  <DataTable
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
    :sort-field="sortField"
    :sort-order="sortOrder"
    :rows-per-page-options="[5, 10, 20, 50]"
    sort-mode="single"
    removable-sort
    striped-rows
    row-hover
    scrollable
    paginator-template="CurrentPageReport FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink RowsPerPageDropdown"
    current-page-report-template="共 {totalRecords} 条 · 第 {first}–{last} 条"
    @update:selection="(value: T) => value && $emit('select', value)"
    @page="server && $emit('page', { first: $event.first, rows: $event.rows })"
    @sort="
      server &&
      $emit('sort', {
        sortField: typeof $event.sortField === 'string' ? $event.sortField : undefined,
        sortOrder: $event.sortOrder,
      })
    "
  >
    <template #empty><div class="empty-inline">暂无符合条件的数据</div></template>
    <Column
      v-for="column in columns"
      :key="column.field"
      :field="column.field"
      :header="column.header"
      :sortable="column.sortable !== false"
    >
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
      ><template #body="slotProps"
        ><slot
          name="actions"
          :row="slotProps.data as T" /></template
    ></Column>
  </DataTable>
</template>
<script setup lang="ts" generic="T extends { id: string }">
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
withDefaults(
  defineProps<{
    rows: T[];
    columns: { field: string; header: string; sortable?: boolean }[];
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
  { pageSize: 10, paginator: true },
);
// 服务端模式只发事件，不把本页记录当作完整集合排序或统计。
defineEmits<{
  select: [value: T];
  page: [value: { first: number; rows: number }];
  sort: [value: { sortField?: string; sortOrder?: number | null }];
}>();
// 空值统一占位；具体业务列可用插槽覆盖展示。
function cellValue(row: T, field: string) {
  return (row as unknown as Record<string, unknown>)[field] ?? '—';
}
</script>
