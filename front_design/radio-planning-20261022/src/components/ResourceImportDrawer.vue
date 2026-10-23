<template>
  <AppDrawer
    :visible="editor.importOpen"
    title="导入资源"
    subtitle="选择文件 → 预检 → 查看差异 → 确认。任何错误均不写入。"
    @update:visible="!$event && editor.closeImport()"
  >
    <div class="fields">
      <label
        >导入资源类型<select
          v-model="editor.importKind"
          :disabled="reading || editor.busy || !editor.canEdit"
          @change="editor.importPreview = null"
          ><option value="nodes">站点</option
          ><option value="devices">设备</option
          ><option value="interference_sources">干扰源</option
          ><option value="topology_links">候选链路（专用文件）</option></select
        ></label
      >
      <div class="toolbar"
        ><button
          class="btn small"
          :disabled="!editor.canEdit"
          @click="template('csv')"
          >CSV 模板</button
        ><button
          class="btn small"
          :disabled="!editor.canEdit"
          @click="template('xlsx')"
          >{{ editor.importKind === 'topology_links' ? 'XLSX 候选模板' : 'XLSX 三表模板' }}</button
        ></div
      >
      <p
        v-if="editor.importKind === 'topology_links'"
        class="readonly-note"
        >UTF-8 CSV 或候选专用 XLSX；≤5 MiB、≤5000
        行。按链路编号新增或更新，未出现的记录保留。两端站点和设备需已存在或先应用资源草稿；结果来自文件，页面不计算。</p
      >
      <p
        v-else
        class="readonly-note"
        >UTF-8 CSV 或 XLSX；≤5 MiB、合计≤5000 行。CSV 设备示例需先有对应站点。XLSX
        同批校验节点引用；日期请用带时区文本。</p
      >
      <input
        type="file"
        accept=".csv,.xlsx"
        aria-label="选择资源文件"
        :disabled="reading || editor.busy || !editor.canEdit"
        @change="choose"
      />
      <p
        v-if="reading || editor.importing"
        role="status"
        >正在读取并预检…</p
      >
      <button
        v-if="editor.importFile?.bytes.length"
        class="btn"
        :disabled="editor.busy || reading || !editor.canEdit"
        @click="editor.previewImport(toRaw(editor.importFile))"
        >重新预检 {{ editor.importFile.name }}</button
      >
      <p
        v-if="localError || editor.error"
        class="error"
        role="alert"
        >{{ localError || editor.error }}</p
      >
    </div>
    <div
      v-if="editor.importPreview"
      ref="previewRoot"
    >
      <p class="notice"
        >新增 {{ editor.importPreview.rows.filter((r) => r.action === 'NEW').length }}；更新
        {{ editor.importPreview.rows.filter((r) => r.action === 'UPDATE').length }}；无变化
        {{ editor.importPreview.rows.filter((r) => r.action === 'UNCHANGED').length }}；错误
        {{ editor.importPreview.issues.length }}</p
      >
      <ul class="error"
        ><li
          v-for="(issue, i) in editor.importPreview.issues"
          :key="i"
          ><button
            v-if="previewRow(issue)"
            type="button"
            class="text-link"
            :disabled="reading || editor.busy || editor.importing"
            v-on="{ click: rowIssueAction(issue) }"
            >{{ issue.sheet || '资源' }} · 第 {{ issue.row ?? '—' }} 行</button
          ><span v-else>{{ issue.sheet || '资源' }} · 第 {{ issue.row ?? '—' }} 行</span> ·
          {{ issue.objectId }} / {{ issue.field }}：{{ issue.message
          }}<small
            v-if="!previewRow(issue)"
            class="unlocated"
            >此错误对应表头或未生成预览的行，请在原文件修正后重新预检。</small
          ></li
        ></ul
      >
      <p
        v-if="locationNotice"
        class="readonly-note"
        role="status"
        >{{ locationNotice }}</p
      >
      <!-- 来源疑点只作提示，不能把外部参考静默修正或当作当前评估。 -->
      <ul
        v-if="editor.importPreview.warnings?.length"
        class="readonly-note"
        ><li
          v-for="(warning, i) in editor.importPreview.warnings"
          :key="i"
          >来源提示 · {{ warning.sheet }} 第 {{ warning.row ?? '—' }} 行 ·
          {{ warning.objectId }}：{{ warning.message }}</li
        ></ul
      >
      <details
        v-for="row in editor.importPreview.rows"
        :id="'import-' + row.sheet + '-' + row.row"
        :key="row.sheet + row.row"
        :data-import-sheet="row.sheet"
        :data-import-row="row.row"
        :open="row.action !== 'UNCHANGED'"
      >
        <summary
          >{{ row.sheet }} 第 {{ row.row }} 行 · {{ row.id }} ·
          {{ { NEW: '新增', UPDATE: '更新', UNCHANGED: '无变化' }[row.action] }}</summary
        >
        <dl
          ><template
            v-for="diff in row.differences"
            :key="diff.field"
            ><dt>{{ diff.field }}</dt
            ><dd>{{ value(diff.before) }} → {{ value(diff.after) }}</dd></template
          ></dl
        >
      </details>
    </div>
    <!-- 后端按原文件重验并原子提交，不与未保存任务草稿混成一笔事务。 -->
    <template #footer
      ><p class="readonly-note">确认后整批保存资源；任务草稿不变。</p
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
import { useResourceEditStore } from '../stores/resource-edit';
import { useAuthStore } from '../stores/auth';
import { previewService } from '../services';
import { downloadFile } from '../services/file-download';
import type { ResourceFormat, ResourceFile, ResourceIssue } from '../types/resource-edit';
import { RESOURCE_MAX_FILE_BYTES } from '../config/demo';
const editor = useResourceEditStore(),
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
  },
);
watch(
  () => [editor.importOpen, editor.importPreview],
  () => {
    locationNotice.value = '';
  },
  { flush: 'sync' },
);
function previewRow(issue: ResourceIssue) {
  return editor.importPreview?.rows.find(
    (row) => row.sheet === issue.sheet && row.row === issue.row,
  );
}
// 仅定位当前预览中真实存在的行；表头、重复行等错误不能伪造定位目标。
function rowIssueAction(issue: ResourceIssue) {
  const preview = editor.importPreview,
    token = serial,
    context = editor.context;
  const valid = () =>
    !!preview &&
    editor.importOpen &&
    editor.importPreview === preview &&
    serial === token &&
    editor.context === context &&
    preview.issues.includes(issue) &&
    !reading.value &&
    !editor.busy &&
    !editor.importing &&
    !!previewRoot.value;
  return async () => {
    if (!valid()) return;
    locationNotice.value = '';
    const row = previewRow(issue);
    if (!row) {
      locationNotice.value = '此错误未生成对应预览行，请按工作表和行号在原文件中修正后重新预检。';
      return;
    }
    const target = Array.from(
      previewRoot.value!.querySelectorAll<HTMLDetailsElement>('[data-import-row]'),
    ).find(
      (element) =>
        element.getAttribute('data-import-sheet') === row.sheet &&
        element.getAttribute('data-import-row') === String(row.row),
    );
    if (!target) {
      locationNotice.value = '当前预览行无法定位，请重新预检后查看。';
      return;
    }
    target.open = true;
    await nextTick();
    if (!valid()) return;
    target.querySelector('summary')?.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center' });
  };
}
async function choose(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || !editor.canEdit) return;
  const token = ++serial,
    session = auth.generation;
  localError.value = '';
  editor.importPreview = null;
  editor.importFile = null;
  if (file.size > RESOURCE_MAX_FILE_BYTES) {
    localError.value = '单文件最多 5 MiB';
    return;
  }
  reading.value = true;
  // 读取文件时先登记未提交状态，离开仍要明确处理。
  editor.importFile = { name: file.name, bytes: new Uint8Array() };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (token === serial && session === auth.generation && editor.importOpen)
      await editor.previewImport({ name: file.name, bytes });
  } catch (e) {
    if (token === serial) localError.value = e instanceof Error ? e.message : '文件读取失败';
  } finally {
    if (token === serial) reading.value = false;
  }
}
async function download(file: ResourceFile, session: number) {
  if (
    session !== auth.generation ||
    !(await auth.check()) ||
    !editor.canEdit ||
    session !== auth.generation
  )
    return;
  downloadFile(file, 1000);
}
async function template(format: ResourceFormat) {
  const session = auth.generation;
  try {
    await download(await previewService.getResourceTemplate(format, editor.importKind), session);
  } catch (e) {
    if (session === auth.generation)
      localError.value = e instanceof Error ? e.message : '模板生成失败';
  }
}
function value(v: unknown) {
  return v === null || v === undefined
    ? '（空）'
    : typeof v === 'object'
      ? JSON.stringify(v)
      : String(v);
}
</script>
<style scoped>
.fields {
  display: grid;
  gap: 14px;
}
.fields label {
  display: grid;
  gap: 8px;
}
.error {
  color: #ffb4b4;
  line-height: 1.8;
}
.unlocated {
  display: block;
  margin-top: 4px;
}
details {
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
  font-size: 12px;
}
summary:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: 2px;
}
dl {
  font-size: 11px;
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: 8px;
  margin-top: 10px;
}
dd {
  margin: 0;
}
</style>
