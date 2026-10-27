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
        ></div
      >
      <details class="task-meta"
        ><summary>任务详情与版本</summary
        ><p class="meta"
          >{{ task.taskId }}<br />输入版本：{{ task.saved?.inputVersion ?? '尚未保存'
          }}<br />资源版本：{{ task.resourceRevision || '尚未读取' }}</p
        ><button
          class="text-link"
          :disabled="!task.editable || resources.refreshing"
          @click="task.refreshResources()"
          >刷新已保存资源引用</button
        ><p class="muted">刷新保留任务草稿</p></details
      >
      <p v-if="task.resourceStale" class="notice warn" role="status">
        当前任务仍引用历史资源；新增或修改资源后，请刷新并保存任务。
        <button class="text-link" :disabled="!task.editable || resources.refreshing" @click="task.refreshResources()">刷新资源并保留草稿</button>
      </p>
      <p v-if="task.referencesRefreshing" class="notice" role="status">正在刷新资源及任务引用…</p>
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
        v-for="(issue, i) in task.context === 'planning' ? [] : task.issues"
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
      <details class="preset-entry"
        ><summary>从整套任务预设开始 <small>替换节点、需求与条件</small></summary
        ><div class="toolbar section-gap">
          <select
            v-model="presetId"
            aria-label="整套任务预设"
            :disabled="!task.editable"
          >
            <option value="">选择整套任务预设</option>
            <option
              v-for="preset in task.catalog?.presets ?? []"
              :key="preset.id"
              :value="preset.id"
              >{{ preset.label }}</option
            >
          </select>
          <button
            class="btn small"
            :disabled="!task.editable || !presetId"
            @click="task.loadPreset(presetId)"
            >载入整套任务</button
          >
        </div></details
      >
      <TaskApiForm ref="form" />
      <TaskApiLibraryDrawer
        v-model:visible="libraryVisible"
        @opened="emit('opened')"
      /><TaskApiImportDrawer />
    </div>
    <!-- 保存与规划仍是两个独立动作，底部始终可达。 -->
    <footer class="task-actions"
      ><div
        v-if="task.context === 'planning' && task.displayIssues.length"
        class="notice warn"
        role="alert"
      >
        <strong>请检查以下输入</strong>
        <ul
          ><li
            v-for="(issue, index) in task.displayIssues"
            :key="index"
          >
            <button
              class="text-link"
              @click="locate(issue)"
              >{{ planningIssueText(issue) }}</button
            >
          </li></ul
        >
      </div>
      <p
        v-if="locationNotice"
        class="notice warn"
        role="status"
        >{{ locationNotice }}</p
      >
      <slot name="feedback" />
      <span role="status">{{
        task.pendingSave
          ? '保存结果待核实'
          : task.changed
            ? '任务有修改，请先保存'
            : task.saved
              ? '任务已保存'
              : '新任务尚未保存'
      }}</span
      ><div class="toolbar"
        ><button
          class="btn"
          :disabled="!task.editable || task.importFiles.length > 0"
          @click="task.save"
          >保存任务</button
        ><slot name="actions" /></div
      ><slot name="submit-hint"
    /></footer>
  </section>
</template>
<script setup lang="ts">
// 任务入口不感知数据源，资源刷新只更新已保存引用。
import { ref } from 'vue';
import { useTaskInputStore } from '../stores/task-input';
import { useResourceReadStore } from '../stores/resource-read';
import TaskApiForm from './TaskApiForm.vue';
import TaskApiLibraryDrawer from './TaskApiLibraryDrawer.vue';
import TaskApiImportDrawer from './TaskApiImportDrawer.vue';
import type { PlanningIssue } from '../types/planning';
import { planningIssueText } from '../services/planning-issue-display';
const emit = defineEmits<{ opened: [] }>();
const task = useTaskInputStore(),
  resources = useResourceReadStore(),
  libraryVisible = ref(false);
const presetId = ref('');
const form = ref<InstanceType<typeof TaskApiForm> | null>(null),
  locationNotice = ref('');
// 定位失败只说明位置，不代改资源或丢弃未知问题。
async function locate(issue: PlanningIssue) {
  locationNotice.value = (await form.value?.focusIssue(issue))
    ? ''
    : '该问题无法在当前任务表单定位，请按对象和字段核查；输入已保留。';
}
</script>
<style scoped>
.task-panel {
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.task-panel .panel-body {
  padding: 16px;
  min-height: 0;
  overflow: auto;
  flex: 1;
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
.task-actions {
  flex: none;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  background: #102035;
  display: grid;
  gap: 8px;
  font-size: 11px;
}
.task-actions .toolbar {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.task-actions > span {
  color: var(--muted);
}
/* 多项反馈在操作区内滚动，保存和提交按钮保持可达。 */
.task-actions > .notice,
.task-actions :deep(.planning-feedback) {
  display: block;
  max-height: 180px;
  overflow: auto;
}
.task-actions li {
  margin-top: 6px;
  overflow-wrap: anywhere;
}
.task-actions li button {
  text-align: left;
}
.task-meta,
.preset-entry {
  margin: 8px 0;
  font-size: 12px;
}
summary {
  cursor: pointer;
  color: var(--muted);
}
.preset-entry small {
  display: inline;
  margin-left: 4px;
  font-size: 11px;
}
</style>
