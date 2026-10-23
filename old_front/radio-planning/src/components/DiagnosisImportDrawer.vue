<template>
  <AppDrawer
    :visible="visible"
    title="导入故障场景"
    subtitle="CSV / XLSX · 整批预检后提交，不覆盖已有场景"
    @update:visible="!$event && emit('close')"
  >
    <div class="import-form">
      <label
        >绑定当前有效方案<select
          v-model="planId"
          :disabled="
            !auth.can('diagnosis.scenario') || diagnosis.importing || !!diagnosis.importPreview
          "
          ><option
            v-for="plan in diagnosis.sources.plans"
            :key="plan.id"
            :value="plan.id"
            >{{ plan.name }} · {{ plan.id }}</option
          ></select
        ></label
      >
      <div class="buttons"
        ><button
          class="btn small"
          :disabled="!auth.can('diagnosis.scenario')"
          @click="diagnosis.template('csv')"
          >CSV 模板</button
        ><button
          class="btn small"
          @click="diagnosis.template('xlsx')"
          >XLSX 模板</button
        ></div
      >
      <p
        >单文件最多 5 MiB，最多 20 个场景，每场景最多 20 个故障对象。现象 ID
        使用分号分隔；时间填写带时区的 ISO 文本。</p
      >
      <input
        type="file"
        accept=".csv,.xlsx"
        :disabled="
          !auth.can('diagnosis.scenario') || !planId || diagnosis.importing || diagnosis.busy
        "
        @change="choose"
      />
      <p v-if="diagnosis.importing">正在读取与预检…</p>
      <template v-if="diagnosis.importPreview"
        ><h3>{{ diagnosis.importPreview.fileName }}</h3
        ><div
          v-for="(draft, index) in diagnosis.importPreview.drafts"
          :key="index"
          class="preview"
          ><strong>{{ draft.name }}</strong
          ><span
            >{{ draft.faults.length }} 个对象 ·
            {{
              diagnosis.importPreview.matches[index] ? '已匹配预生成结果' : '可保存，暂无预生成结果'
            }}</span
          ></div
        >
        <p
          v-for="(issue, index) in diagnosis.importPreview.issues"
          :key="index"
          class="error"
          >{{ issue.row ? '第 ' + issue.row + ' 行 · ' : '' }}{{ issue.field }}：{{
            issue.message
          }}</p
        >
        <p
          v-if="!diagnosis.importPreview.issues.length"
          class="success"
          >预检通过，点击“整批导入”保存。</p
        >
      </template>
      <p
        v-if="diagnosis.error"
        class="error"
        >{{ diagnosis.error }}</p
      >
    </div>
    <template #footer
      ><button
        class="btn"
        @click="emit('close')"
        >关闭</button
      ><button
        class="btn primary"
        :disabled="
          !auth.can('diagnosis.scenario') ||
          !diagnosis.importPreview ||
          !!diagnosis.importPreview.issues.length ||
          diagnosis.locked
        "
        @click="commit"
        >整批导入</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { useAuthStore } from '../stores/auth';
// 当前权限变化时仅禁用操作，保留表单输入。
const auth = useAuthStore();
import AppDrawer from './AppDrawer.vue';
import { useDiagnosisStore } from '../stores/diagnosis';
import { ref, watch } from 'vue';
const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ close: [] }>();
const diagnosis = useDiagnosisStore(),
  planId = ref('');
watch(
  () => props.visible,
  (visible) => {
    if (visible) planId.value = diagnosis.draft?.planId ?? diagnosis.sources.plans[0]?.id ?? '';
  },
);
async function choose(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file && planId.value) await diagnosis.previewImport(file, planId.value);
}
async function commit() {
  if (await diagnosis.commitImport()) emit('close');
}
</script>
<style scoped>
.import-form {
  display: grid;
  gap: 16px;
  color: #aec4dc;
  font-size: 13px;
  line-height: 1.8;
}
label {
  display: grid;
  gap: 7px;
}
select {
  padding: 10px;
  color: #d9eafa;
  background: #102137;
  border: 1px solid #34516f;
  width: 100%;
}
.buttons {
  display: flex;
  gap: 9px;
}
.preview {
  padding: 12px;
  background: #152a44;
  display: grid;
  gap: 7px;
}
.preview span {
  font-size: 12px;
}
.error {
  color: #ffabb8;
}
.success {
  color: #7ed4ba;
}
</style>
