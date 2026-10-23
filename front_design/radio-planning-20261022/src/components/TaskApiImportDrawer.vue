<template>
  <AppDrawer
    :visible="task.importVisible"
    title="导入任务输入"
    subtitle="选择文件 → 解析格式 → 校验引用 → 应用草稿；保存与规划分别操作。"
    @update:visible="!$event && close()"
  >
    <div class="toolbar"
      ><button
        class="btn small"
        :disabled="!task.editable"
        @click="template('xlsx')"
        >XLSX 模板</button
      ><button
        class="btn small"
        :disabled="!task.editable"
        @click="template('csv', 'task_scenarios')"
        >任务 CSV 模板</button
      ><button
        class="btn small"
        :disabled="!task.editable"
        @click="template('csv', 'task_links')"
        >需求 CSV 模板</button
      ></div
    >
    <label class="section-gap"
      >选择 XLSX 或配套 CSV<input
        type="file"
        accept=".csv,.xlsx"
        multiple
        :disabled="!task.editable || reading || task.importBusy"
        @change="choose"
    /></label>
    <p>{{ task.importFiles.map((f) => f.name).join(' / ') }}</p
    ><p
      v-if="reading || task.importBusy"
      role="status"
      >{{ reading ? '正在读取文件…' : '正在解析文件并校验任务引用…' }}</p
    >
    <p
      v-if="fileError || task.error"
      class="notice warn"
      >{{ fileError || task.error }}</p
    ><button
      class="btn"
      :disabled="!task.editable || !task.importFiles.length || reading || task.importBusy"
      @click="task.previewImport(task.importFiles)"
      >解析并校验</button
    >
    <template v-if="task.importPreview"
      ><p class="notice"
        >任务 {{ task.importPreview.taskId }} ·
        {{ task.importPreview.existing ? '已有任务的新草稿' : '新任务草稿' }}</p
      ><p
        v-for="note in task.importPreview.notes"
        :key="note"
        class="muted"
        >{{ note }}</p
      >
      <!-- 部署条件需能看见前后值，清空不能只列字段名。 -->
      <DeploymentConstraintsSummary
        v-if="task.importPreview.input"
        :value="task.importPreview.input.deploymentConstraints"
        label="导入后的部署筛选条件"
      />
      <PlanningOptionsSummary
        v-if="task.importPreview.input"
        :input="task.importPreview.input"
      />
      <details
        v-for="diff in task.importPreview.differences.filter((row) =>
          ['frequencyConstraints', 'deploymentSolve'].includes(row.field),
        )"
        :key="diff.field"
        ><summary>{{ diff.field }} 前后值</summary
        ><pre>
之前：{{ JSON.stringify(diff.before, null, 2) }}
之后：{{ JSON.stringify(diff.after, null, 2) }}</pre
        >
      </details>
      <template
        v-for="diff in task.importPreview.differences.filter(
          (row) => row.field === 'deploymentConstraints',
        )"
        :key="diff.field"
        ><DeploymentConstraintsSummary
          :value="
            diff.before as
              | import('../types/deployment-constraints').DeploymentConstraints
              | null
              | undefined
          "
          label="导入前的部署筛选条件"
      /></template>
      <AppTable
        :sortable="false"
        compact
        v-if="task.importPreview.issues.length"
        :rows="task.importPreview.issues.map((x, i) => ({ id: String(i), ...x }))"
        :columns="issueColumns"
        :page-size="10"
      />
      <div v-else
        ><p
          >校验通过。{{ task.importPreview.input?.stationIds.length }} 个节点，{{
            task.importPreview.input?.demands.length
          }}
          条需求。</p
        ><p>变化字段：{{ task.importPreview.differences.map((d) => d.field).join('、') || '无' }}</p
        ><button
          class="btn primary"
          :disabled="!task.editable || task.importBusy"
          @click="task.applyImport()"
          >确认替换当前草稿</button
        ></div
      >
    </template>
  </AppDrawer>
</template>
<script setup lang="ts">
// 文件预览、应用到草稿和保存任务是三个独立动作。
import { ref, toRaw } from 'vue';
import PlanningOptionsSummary from './PlanningOptionsSummary.vue';
import AppDrawer from './AppDrawer.vue';
import DeploymentConstraintsSummary from './DeploymentConstraintsSummary.vue';
import AppTable from './AppTable.vue';
import { useTaskInputStore } from '../stores/task-input';
import { useAuthStore } from '../stores/auth';
import { previewService } from '../services';
import { downloadFile } from '../services/file-download';
import { TASK_MAX_FILE_BYTES } from '../config/demo';
const task = useTaskInputStore(),
  auth = useAuthStore(),
  fileError = ref(''),
  reading = ref(false);
async function choose(event: Event) {
  const files = Array.from((event.target as HTMLInputElement).files ?? []);
  fileError.value = '';
  if (
    !files.length ||
    files.length > 2 ||
    files.some((f) => !f.size || f.size > TASK_MAX_FILE_BYTES)
  ) {
    fileError.value = '选择一个 XLSX 或两个 CSV，单文件最多 5 MiB。';
    return;
  }
  const session = auth.generation;
  reading.value = true;
  try {
    const input = await Promise.all(
      files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    if (session === auth.generation && task.editable) {
      task.importFiles = input;
      task.importPreview = null;
    }
  } catch {
    fileError.value = '文件读取失败，请重新选择。';
  } finally {
    reading.value = false;
  }
}
async function template(format: 'csv' | 'xlsx', kind?: 'task_scenarios' | 'task_links') {
  if (!task.draft) return;
  const session = auth.generation;
  fileError.value = '';
  try {
    // 保留无效数值，由模板边界拒绝，不能导出成看似合法的空条件。
    const file = await previewService.getTaskInputTemplate({
      context: task.context,
      format,
      kind,
      input: structuredClone(toRaw(task.draft)),
    });
    if (session !== auth.generation) return;
    downloadFile(file, 1000);
  } catch (e) {
    fileError.value = e instanceof Error ? e.message : '模板下载失败';
  }
}
async function close() {
  if (
    task.importFiles.length &&
    (await task.ask({
      title: '放弃导入预览',
      message: '文件尚未应用到任务草稿。',
      discardLabel: '放弃导入',
    })) !== 'discard'
  )
    return;
  task.clearImport();
}
const issueColumns = [
  // 问题正文允许换行，短身份列保留可辨识宽度。
  { field: 'sheet', header: '工作表', minWidth: '70px' },
  { field: 'row', header: '行号', minWidth: '50px' },
  { field: 'field', header: '字段', minWidth: '80px' },
  { field: 'message', header: '问题', minWidth: '200px' },
];
</script>
