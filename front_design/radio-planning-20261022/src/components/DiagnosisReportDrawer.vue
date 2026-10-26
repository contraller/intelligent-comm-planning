<template>
  <Drawer
    :visible="visible"
    header="诊断报告预览"
    position="right"
    :style="{ width: '850px', maxWidth: '95vw' }"
    @update:visible="!$event && $emit('close')"
    ><article class="report-paper"
      ><small>无线网络智能规划系统 · {{ diagnosisOriginLabel(record.dataOrigin) }}</small
      ><h1>{{ record.name }}诊断报告</h1
      ><img
        :src="figure"
        alt="冻结网络与影响范围示意图"
      /><section
        v-for="(section, index) in sections"
        :key="index"
        ><h2>{{ section.title }}</h2
        ><p
          v-for="(line, i) in section.text"
          :key="i"
          >{{ line }}</p
        ><table v-if="section.headers.length"
          ><thead
            ><tr
              ><th
                v-for="header in section.headers"
                :key="header"
                >{{ header }}</th
              ></tr
            ></thead
          ><tbody
            ><tr
              v-for="(row, i) in section.rows"
              :key="i"
              ><td
                v-for="(cell, j) in row"
                :key="j"
                >{{ cell }}</td
              ></tr
            ></tbody
          ></table
        ></section
      ></article
    ><template #footer
      ><p v-if="!auth.can('diagnosis.export')">当前角色可查看报告，无文件导出权限。</p
      ><p
        v-if="error"
        class="error"
        >{{ error }}</p
      ><div class="downloads"
        ><span v-if="exporting">正在生成文件…</span
        ><button
          v-for="format in ['docx', 'pdf', 'json'] as const"
          :key="format"
          class="btn primary"
          :disabled="!auth.can('diagnosis.export') || exporting"
          @click="$emit('download', format)"
          >下载 {{ format.toUpperCase() }}</button
        ></div
      ></template
    ></Drawer
  >
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import { computed } from 'vue';
import Drawer from 'primevue/drawer';
import type { DiagnosisRecord, ReportFormat } from '../types/diagnosis';
import { diagnosisReportSections } from '../reports/diagnosis-report';
import { diagnosisFigureSvg } from '../reports/diagnosis-figure';
import { diagnosisOriginLabel } from '../services/diagnosis-presentation';
const props = defineProps<{
  visible: boolean;
  record: DiagnosisRecord;
  exporting: boolean;
  error: string;
}>();
defineEmits<{ close: []; download: [format: ReportFormat] }>();
const sections = computed(() => diagnosisReportSections(props.record));
// SVG 由内部绘图器生成，所有来源文本在绘图器中转义。
const figure = computed(
  () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(diagnosisFigureSvg(props.record))}`,
);
</script>
<style scoped>
.report-paper {
  background: #f7f9fc;
  color: #243a51;
  padding: 30px;
  border-radius: 5px;
}
.report-paper small {
  color: #56718a;
}
h1 {
  font-size: 24px;
  margin: 20px 0;
}
h2 {
  font-size: 16px;
  border-bottom: 2px solid #c0d5e5;
  padding-bottom: 8px;
  margin-top: 27px;
}
img {
  width: 100%;
}
p,
td,
th {
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
td,
th {
  border: 1px solid #bdccda;
  padding: 8px;
  vertical-align: top;
  text-align: left;
}
th {
  background: #e2ebf3;
}
.downloads {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: flex-end;
}
.error {
  color: #ffb0bc;
}
</style>
