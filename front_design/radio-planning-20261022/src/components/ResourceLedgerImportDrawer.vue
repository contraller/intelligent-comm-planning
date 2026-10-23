<template>
  <AppDrawer
    :visible="editor.importOpen"
    title="导入资源"
    subtitle="选择文件 → 预检 → 查看差异 → 确认。任何错误均不写入。"
    @update:visible="!$event && editor.closeImport()"
  >
    <label
      >导入资源类型<select
        v-model="editor.importKind"
        :disabled="!editor.canEdit || editor.busy || reading"
        @change="editor.importPreview = null"
        ><option value="nodes">站点</option
        ><option value="devices">设备</option
        ><option value="interference_sources">干扰源</option></select
      ></label
    >
    <div class="toolbar section-gap"
      ><button
        class="btn small"
        :disabled="!editor.canEdit || editor.busy"
        @click="template('csv')"
        >CSV 模板</button
      ><button
        class="btn small"
        :disabled="!editor.canEdit || editor.busy"
        @click="template('xlsx')"
        >XLSX 三表模板</button
      ></div
    >
    <p class="readonly-note"
      >UTF-8 CSV 或 XLSX；≤5 MiB、合计≤5000 行。XLSX 同批校验节点引用；日期请用带时区文本。</p
    >
    <input
      type="file"
      accept=".csv,.xlsx"
      aria-label="选择资源文件"
      :disabled="!editor.canEdit || editor.busy || reading"
      @change="choose"
    />
    <p
      v-if="reading || editor.importing"
      role="status"
      >正在读取并预检…</p
    >
    <p
      v-if="localError || editor.error"
      class="error"
      role="alert"
      >{{ localError || editor.error }}</p
    >
    <button
      v-if="editor.importFile?.bytes.length"
      class="btn small"
      :disabled="!editor.canEdit || editor.busy || reading"
      @click="editor.previewImport(toRaw(editor.importFile))"
      >重新预检 {{ editor.importFile.name }}</button
    >
    <div
      v-if="editor.importPreview"
      ref="previewRoot"
    >
      <p class="notice"
        >新增 {{ count('NEW') }}；更新 {{ count('UPDATE') }}；无变化 {{ count('UNCHANGED') }}；错误
        {{ editor.importPreview.issues.length }}</p
      >
      <ul class="error"
        ><li
          v-for="(issue, index) in editor.importPreview.issues"
          :key="index"
          ><button
            v-if="previewRow(issue)"
            class="text-link"
            :disabled="editor.busy || reading"
            @click="locateIssue(issue)"
            >{{ issue.sheet }} · 第 {{ issue.row ?? '—' }} 行</button
          ><span v-else>{{ issue.sheet }} · 第 {{ issue.row ?? '—' }} 行</span> ·
          {{ issue.objectId }} / {{ issue.field }}：{{ issue.message }}</li
        ></ul
      >
      <p
        v-if="locationNotice"
        class="readonly-note"
        role="status"
        >{{ locationNotice }}</p
      >
      <ul class="readonly-note"
        ><li
          v-for="(issue, index) in editor.importPreview.warnings"
          :key="index"
          >来源提示 · {{ issue.sheet }} 第 {{ issue.row ?? '—' }} 行 · {{ issue.objectId }}：{{
            issue.message
          }}</li
        ></ul
      >
      <details
        v-for="row in editor.importPreview.rows"
        :key="row.sheet + row.row"
        :open="row.action !== 'UNCHANGED'"
        :data-import-sheet="row.sheet"
        :data-import-row="row.row"
        ><summary
          >{{ row.sheet }} 第 {{ row.row }} 行 · {{ row.id }} ·
          {{ { NEW: '新增', UPDATE: '更新', UNCHANGED: '无变化' }[row.action] }}</summary
        ><dl class="kv"
          ><template
            v-for="diff in row.differences"
            :key="diff.field"
            ><dt>{{ diff.field }}</dt
            ><dd>{{ value(diff.before) }} → {{ value(diff.after) }}</dd></template
          ></dl
        ></details
      >
    </div>
    <template #footer
      ><p class="readonly-note">确认后整批保存，成功才更新列表。</p
      ><div class="toolbar"
        ><button
          class="btn"
          :disabled="editor.busy || reading"
          @click="editor.closeImport()"
          >关闭</button
        ><button
          class="btn primary"
          :disabled="
            !editor.canEdit ||
            editor.busy ||
            reading ||
            !editor.importPreview ||
            !!editor.importPreview.issues.length
          "
          @click="editor.confirmImport()"
          >确认整批保存</button
        ></div
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { nextTick, ref, toRaw, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import { useResourceLedgerEditStore } from '../stores/resource-ledger-edit';
import { useAuthStore } from '../stores/auth';
import { previewService } from '../services';
import { downloadFile } from '../services/file-download';
import { RESOURCE_MAX_FILE_BYTES } from '../config/demo';
import type { ResourceFile, ResourceFormat, ResourceIssue } from '../types/resource-edit';
const editor = useResourceLedgerEditStore(),
  auth = useAuthStore(),
  reading = ref(false),
  localError = ref('');
const previewRoot = ref<HTMLElement | null>(null),
  locationNotice = ref('');
let serial = 0;
watch(
  () => [editor.importOpen, auth.generation],
  () => {
    serial++;
    reading.value = false;
    localError.value = '';
    locationNotice.value = '';
  },
);
const count = (action: string) =>
  editor.importPreview?.rows.filter((r) => r.action === action).length ?? 0;
const value = (v: unknown) =>
  v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const previewRow = (issue: ResourceIssue) =>
  editor.importPreview?.rows.find((row) => row.sheet === issue.sheet && row.row === issue.row);
async function locateIssue(issue: ResourceIssue) {
  const preview = editor.importPreview,
    session = auth.generation;
  if (
    !preview ||
    !editor.importOpen ||
    editor.busy ||
    reading.value ||
    !preview.issues.includes(issue)
  )
    return;
  // 只定位本次预检中真实存在的行，不从外部字段构造选择器。
  const row = previewRow(issue),
    element = Array.from(
      previewRoot.value?.querySelectorAll<HTMLDetailsElement>('[data-import-row]') ?? [],
    ).find(
      (el) => el.dataset.importSheet === row?.sheet && el.dataset.importRow === String(row?.row),
    );
  if (!element) {
    locationNotice.value = '此错误未生成预览行，请按工作表和行号在原文件修正后重新预检。';
    return;
  }
  element.open = true;
  await nextTick();
  if (preview !== editor.importPreview || session !== auth.generation || !editor.importOpen) return;
  element.querySelector('summary')?.focus({ preventScroll: true });
  element.scrollIntoView({ block: 'center' });
}
async function choose(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || !editor.canEdit || editor.busy) return;
  localError.value = '';
  editor.importPreview = null;
  if (file.size > RESOURCE_MAX_FILE_BYTES) {
    localError.value = '单文件最多 5 MiB';
    return;
  }
  const token = ++serial,
    session = auth.generation;
  // 文件读取期间也属于未提交输入，退出失败不得丢失该状态。
  editor.importFile = { name: file.name, bytes: new Uint8Array() };
  reading.value = true;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (token === serial && session === auth.generation && editor.importOpen)
      await editor.previewImport({ name: file.name, bytes });
  } catch (reason) {
    if (token === serial)
      localError.value = reason instanceof Error ? reason.message : '文件读取失败';
  } finally {
    if (token === serial) reading.value = false;
  }
}
async function download(file: ResourceFile, session: number) {
  if (
    session !== auth.generation ||
    !(await auth.check()) ||
    session !== auth.generation ||
    !editor.canEdit
  )
    return;
  downloadFile(file, 0);
}
async function template(format: ResourceFormat) {
  const session = auth.generation;
  try {
    await download(await previewService.getResourceTemplate(format, editor.importKind), session);
  } catch (reason) {
    if (session === auth.generation)
      localError.value = reason instanceof Error ? reason.message : '模板下载失败';
  }
}
</script>
<style scoped>
label {
  display: grid;
  gap: 8px;
}
details {
  margin-top: 12px;
}
summary {
  cursor: pointer;
}
.error {
  color: #f5a6b2;
}
</style>
