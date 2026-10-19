<template>
  <section class="panel task-panel"
    ><div class="panel-head"
      ><h3>任务输入</h3
      ><span class="chip"
        >{{ task.saved ? '已保存任务' : '新任务' }}{{ task.changed ? ' · 有修改' : '' }}</span
      ></div
    ><div class="panel-body">
      <div class="toolbar"
        ><button
          class="btn small"
          :disabled="!task.editable"
          @click="task.newTask"
          >新建</button
        ><button
          class="btn small"
          :disabled="!task.readable || task.busy || task.running || !!task.pendingSave"
          @click="libraryVisible = true"
          >打开任务</button
        ><button
          class="btn small"
          :disabled="!task.editable"
          @click="task.importVisible = true"
          >导入</button
        ><button
          class="btn primary small"
          :disabled="!task.editable || task.importFiles.length > 0"
          @click="task.save"
          >保存任务</button
        ></div
      >
      <p class="meta"
        >{{ task.taskId }}<br />输入版本：{{ task.saved?.inputVersion ?? '尚未保存'
        }}<br />资源版本：{{ task.resourceRevision || '尚未读取' }}</p
      >
      <div
        v-if="task.error"
        class="notice warn"
        role="alert"
        >{{ task.error
        }}<button
          v-if="task.pendingSave"
          class="btn small"
          @click="task.reconcileSave"
          >核实保存结果</button
        ></div
      ><p
        v-if="task.notice"
        class="notice"
        >{{ task.notice }}</p
      >
      <p
        v-for="(issue, i) in task.issues"
        :key="i"
        class="notice warn"
        >{{ issue.objectId }} / {{ issue.field }}：{{ issue.message }}</p
      >
      <p
        v-if="task.loading"
        role="status"
        >正在读取任务输入…</p
      ><button
        v-if="task.error"
        class="btn small"
        :disabled="!task.readable || task.busy"
        @click="task.initialize(task.context)"
        >重试读取</button
      >
      <div class="toolbar section-gap"
        ><button
          class="text-link"
          :disabled="!task.editable || resources.refreshing"
          @click="refreshReferences"
          >刷新已保存资源引用</button
        ><span class="muted">刷新保留任务草稿</span></div
      >
      <TaskApiForm />
      <TaskApiLibraryDrawer
        v-model:visible="libraryVisible"
        @opened="emit('opened')"
      /><TaskApiImportDrawer /> </div
  ></section>
</template>
<script setup lang="ts">
// 两个页面复用同一任务入口，资源刷新只更新已保存引用。
import { ref } from 'vue';
import { useTaskInputStore } from '../stores/task-input';
import { useResourceReadStore } from '../stores/resource-read';
import TaskApiForm from './TaskApiForm.vue';
import TaskApiLibraryDrawer from './TaskApiLibraryDrawer.vue';
import TaskApiImportDrawer from './TaskApiImportDrawer.vue';
const emit = defineEmits<{ opened: [] }>();
const task = useTaskInputStore(),
  resources = useResourceReadStore(),
  libraryVisible = ref(false);
async function refreshReferences() {
  if (await resources.refresh()) await task.refreshReferences();
}
</script>
<style scoped>
.task-panel {
  min-width: 0;
}
.task-panel .panel-body {
  padding: 16px;
}
.toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.meta {
  font-size: 10px;
  line-height: 1.8;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.notice {
  margin: 10px 0;
}
.muted {
  font-size: 11px;
}
</style>
