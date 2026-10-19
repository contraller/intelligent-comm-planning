<template>
  <AppDrawer
    :visible="planning.importOpen"
    title="导入完整任务"
    subtitle="①选择文件 → ②校验 → ③预览 → ④确认应用。应用后仍需保存任务。"
    @update:visible="!$event && !reading && planning.closeTaskImport()"
  >
    <div class="toolbar"
      ><button
        class="btn small"
        @click="template('xlsx')"
        >XLSX 模板</button
      ><button
        class="btn small"
        @click="template('csv', 'task_scenarios')"
        >任务 CSV</button
      ><button
        class="btn small"
        @click="template('csv', 'task_links')"
        >需求 CSV</button
      ></div
    >
    <p class="muted"
      >一个 XLSX 或配套两个 CSV；同批只能包含一个任务，未知列、错误引用和隐藏数据会阻止导入。</p
    >
    <input
      type="file"
      accept=".csv,.xlsx"
      multiple
      :disabled="planning.importing || reading || !auth.can('planning.execute')"
      @change="files"
    />
    <p v-if="planning.importing || reading">正在校验…</p
    ><p
      v-if="error || planning.error"
      role="alert"
      >{{ error || planning.error }}</p
    >
    <template v-if="planning.importPreview">
      <p
        >任务 ID：{{ planning.importPreview.taskId }} ·
        {{ planning.importPreview.existing ? '已有任务，保存时追加版本' : '新任务草稿' }}</p
      >
      <p
        v-for="note in planning.importPreview.notes"
        :key="note"
        class="muted"
        >{{ note }}</p
      >
      <ul
        v-if="planning.importPreview.issues.length"
        role="alert"
        ><li
          v-for="(issue, i) in planning.importPreview.issues"
          :key="i"
          >{{ issue.sheet }} / 第 {{ issue.row }} 行 / {{ issue.field }}：{{ issue.message }}</li
        ></ul
      >
      <template v-else
        ><p
          >校验通过，{{ planning.importPreview.input?.stationIds.length }} 个节点、{{
            planning.importPreview.input?.demands.length
          }}
          条需求。确认后替换当前草稿。</p
        >
        <!-- 导入清空也显示未设置，不继承当前任务条件。 -->
        <DeploymentConstraintsSummary
          :value="planning.importPreview.input?.deploymentConstraints"
          label="导入后的部署筛选条件"
        />
        <PlanningOptionsSummary :input="planning.importPreview.input" />
        <details
          v-for="diff in planning.importPreview.differences"
          :key="diff.field"
          ><summary>{{ diff.field }}</summary
          ><pre>
之前：{{ JSON.stringify(diff.before, null, 2) }}
之后：{{ JSON.stringify(diff.after, null, 2) }}</pre
          >
        </details>
      </template>
    </template>
    <template #footer
      ><button
        class="btn"
        :disabled="planning.importing || reading"
        @click="planning.closeTaskImport()"
        >取消</button
      ><button
        class="btn primary"
        :disabled="
          !planning.importPreview?.input ||
          planning.importing ||
          reading ||
          !auth.can('planning.execute')
        "
        @click="planning.confirmTaskImport(changes)"
        >确认应用到草稿</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';
import AppDrawer from './AppDrawer.vue';
import DeploymentConstraintsSummary from './DeploymentConstraintsSummary.vue';
import PlanningOptionsSummary from './PlanningOptionsSummary.vue';
import { usePlanningStore } from '../stores/planning';
import { usePreviewStore } from '../stores/preview';
import { useAuthStore } from '../stores/auth';
import { previewService } from '../services';
import type { ResourceChanges } from '../types/resource-edit';
const props = defineProps<{ context: 'gis' | 'planning'; changes?: ResourceChanges }>();
const preview = usePreviewStore();
const planning = usePlanningStore(),
  auth = useAuthStore(),
  error = ref(''),
  reading = ref(false);
let serial = 0,
  readingSession = -1;
function releaseRead() {
  if (readingSession === auth.generation) {
    planning.importing = false;
    if (props.context === 'gis') preview.busy = false;
  }
  reading.value = false;
}
onBeforeUnmount(() => {
  serial++;
  if (reading.value) releaseRead();
});
async function files(event: Event) {
  const selected = Array.from((event.target as HTMLInputElement).files ?? []),
    token = ++serial,
    session = auth.generation;
  if (!selected.length) return;
  readingSession = session;
  reading.value = true;
  planning.importing = true;
  if (props.context === 'gis') preview.busy = true;
  error.value = '';
  try {
    if (selected.length > 2 || selected.some((f) => f.size > 5 * 1024 * 1024))
      throw new Error('请选择一个 XLSX 或两个 CSV，单文件最多 5 MiB');
    const data = await Promise.all(
      selected.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
    );
    if (token === serial && session === auth.generation) {
      releaseRead();
      await planning.previewTaskFiles(data, props.context, props.changes);
    }
  } catch (e) {
    if (token === serial) error.value = e instanceof Error ? e.message : '文件读取失败';
  } finally {
    if (token === serial && reading.value) releaseRead();
  }
}
async function template(format: 'csv' | 'xlsx', kind?: 'task_scenarios' | 'task_links') {
  // 切换账号后不触发上一会话发起的下载。
  const session = auth.generation;
  try {
    const file = await previewService.getTaskTemplate(format, kind);
    if (session !== auth.generation || !auth.can('planning.execute')) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.mime })),
      a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '模板下载失败';
  }
}
</script>
<style scoped>
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
}
details {
  margin: 10px 0;
}
li {
  color: #f2b28c;
  line-height: 1.8;
}
</style>
