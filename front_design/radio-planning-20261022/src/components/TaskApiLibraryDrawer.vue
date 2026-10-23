<template>
  <AppDrawer
    :visible="visible"
    title="已保存任务"
    width="900px"
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
      :rows="task.library?.items.map((t) => ({ id: t.taskId, ...t })) ?? []"
      :columns="columns"
      :paginator="false"
      :page-size="10"
      :loading="task.loading || !!opening"
      :selected="null"
      @select="open($event.taskId)"
      ><template #actions="{ row }"
        ><button
          class="text-link"
          :disabled="!!opening || task.busy || task.running || !!task.pendingSave"
          @click.stop="open(row.taskId)"
          >{{ opening===row.taskId ? '正在打开' : '打开' }}</button
        ></template
      ></AppTable
    >
    <div
      v-if="task.library"
      class="toolbar section-gap"
      ><button
        class="btn"
        :disabled="task.library.pageNum <= 1"
        @click="task.queryLibrary(task.library.pageNum - 1)"
        >上页</button
      ><span>{{ task.library.total }} 项 · 第 {{ task.library.pageNum }} 页</span
      ><button
        class="btn"
        :disabled="task.library.pageNum * task.library.pageSize >= task.library.total"
        @click="task.queryLibrary(task.library.pageNum + 1)"
        >下页</button
      ></div
    >
  </AppDrawer>
</template>
<script setup lang="ts">
// 任务库只读取当前页，仅保留服务分页及顺序，禁止页内再次分页／排序。
// 打开任务前由共享状态层处理未保存输入。
import { ref, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import AppTable from './AppTable.vue';
import { useTaskInputStore } from '../stores/task-input';
const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ 'update:visible': [value: boolean]; opened: [] }>();
const task = useTaskInputStore();
const opening=ref('');
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
  if(opening.value)return;
  opening.value=id;
  try{if (await task.open(id)) {emit('update:visible', false);emit('opened');}}
  finally{opening.value='';}
}
</script>
<style scoped>
/* 窄屏保留表格横向滚动，操作列与任务名称通过显式打开入口保持可达。 */
:deep(.p-datatable-column:last-child) { min-width: 78px; }
</style>
