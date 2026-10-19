<template>
  <AppDrawer
    :visible="visible"
    title="已保存任务"
    subtitle="按任务 ID 打开服务端保存版本。"
    @update:visible="emit('update:visible', $event)"
    ><div class="toolbar"
      ><input
        v-model="task.libraryQuery.search"
        placeholder="任务编号或名称"
        @keyup.enter="task.queryLibrary(1)"
      /><button
        class="btn"
        @click="task.queryLibrary(1)"
        >查询</button
      ></div
    ><p
      v-if="task.error"
      class="notice warn"
      >{{ task.error }}</p
    >
    <AppTable
      :rows="task.library?.items.map((t) => ({ id: t.taskId, ...t, name: t.input.name })) ?? []"
      :columns="columns"
      :paginator="false"
      :page-size="10"
      ><template #actions="{ row }"
        ><button
          class="text-link"
          :disabled="task.busy || task.running || !!task.pendingSave"
          @click="open(row.taskId)"
          >打开</button
        ></template
      ></AppTable
    >
    <div
      v-if="task.library"
      class="toolbar section-gap"
      ><button
        class="btn"
        :disabled="task.library.page <= 1"
        @click="task.queryLibrary(task.library.page - 1)"
        >上页</button
      ><span>{{ task.library.total }} 项 · 第 {{ task.library.page }} 页</span
      ><button
        class="btn"
        :disabled="task.library.page * task.library.pageSize >= task.library.total"
        @click="task.queryLibrary(task.library.page + 1)"
        >下页</button
      ></div
    >
  </AppDrawer>
</template>
<script setup lang="ts">
// 任务库只读取当前页，仅保留服务分页及顺序，禁止页内再次分页／排序。
// 打开任务前由共享状态层处理未保存输入。
import { watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import AppTable from './AppTable.vue';
import { useTaskInputStore } from '../stores/task-input';
const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ 'update:visible': [value: boolean]; opened: [] }>();
const task = useTaskInputStore();
watch(
  () => props.visible,
  (value) => {
    if (value) void task.queryLibrary(1);
  },
);
const columns = [
  { field: 'taskId', header: '任务编号', sortable: false },
  { field: 'name', header: '名称', sortable: false },
  { field: 'updatedAt', header: '保存时间', sortable: false },
];
async function open(id: string) {
  if (await task.open(id)) {
    emit('update:visible', false);
    emit('opened');
  }
}
</script>
