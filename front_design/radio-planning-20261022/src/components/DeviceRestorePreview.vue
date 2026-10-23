<template>
  <section
    class="restore-preview"
    aria-label="历史恢复差异预览"
    ><h4>恢复差异预览</h4
    ><p>仅恢复配置和端口维护属性；身份关联、上下架和观测保持不变。保存产生新版本，不下发配置。</p
    ><ul v-if="!preview.compatible"
      ><li
        v-for="reason in preview.reasons"
        :key="reason"
        >{{ reason }}</li
      ></ul
    ><p v-if="!preview.changes.length">当前允许恢复的字段没有差异。</p
    ><table
      v-if="preview.changes.length"
      aria-label="恢复参数差异"
      ><thead
        ><tr
          ><th scope="col">参数</th><th scope="col">当前值</th><th scope="col">恢复候选</th></tr
        ></thead
      ><tbody
        ><tr
          v-for="row in maintenanceChangeRows(preview.changes)"
          :key="row.key"
          ><th scope="row">{{ row.label }}</th
          ><td data-label="当前值">{{ row.before }}</td
          ><td data-label="恢复候选">{{ row.after }}</td></tr
        ></tbody
      ></table
    ><button
      class="btn primary"
      :disabled="!editable || busy || !preview.compatible || !preview.changes.length"
      @click="$emit('apply', preview)"
      >确认恢复候选</button
    ></section
  >
</template>
<script setup lang="ts">
import type { DeviceRestorePreview } from '../types/device-maintenance';
import { maintenanceChangeRows } from '../services/device-maintenance-display';
// 这里只确认候选，保存交给当前页面已有资源工作区。
defineProps<{ preview: DeviceRestorePreview; editable: boolean; busy: boolean }>();
defineEmits<{ apply: [value: DeviceRestorePreview] }>();
</script>
<style scoped>
.restore-preview {
  padding: 16px;
  margin: 14px 0;
  border: 1px solid var(--line);
  border-radius: 8px;
}
h4 {
  margin-bottom: 8px;
  font-size: 13px;
}
p {
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.7;
  margin: 8px 0;
}
table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  margin: 14px 0;
  font-size: 12px;
}
th,
td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
thead {
  color: var(--muted);
}
th:first-child {
  width: 32%;
}
.btn {
  margin-top: 10px;
}
@media (max-width: 560px) {
  .restore-preview {
    padding: 12px;
  }
  table,
  tbody,
  tr,
  th,
  td {
    display: block;
    width: auto;
  }
  thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  tr {
    padding: 8px 0;
    border-bottom: 1px solid var(--line);
  }
  th:first-child {
    width: auto;
  }
  th,
  td {
    padding: 5px 0;
    border: 0;
  }
  td::before {
    content: attr(data-label) '：';
    color: var(--muted);
  }
}
</style>
