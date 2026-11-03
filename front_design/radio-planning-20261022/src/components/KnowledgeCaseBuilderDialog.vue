<template>
  <Dialog
    :visible="visible"
    modal
    header="结构化构建故障知识"
    :style="{ width: 'min(1080px,96vw)' }"
    :closable="!working"
    :close-on-escape="!working"
    @update:visible="close"
  >
    <p class="intro"
      >填写明确的故障案例，预览将生成的实体与关系。应用后进入未保存草稿，继续保存、审核和发布。</p
    >
    <div class="tabs"
      ><button
        :class="{ active: mode === 'form' }"
        :disabled="working"
        @click="mode = 'form'"
        >单条引导录入</button
      ><button
        :class="{ active: mode === 'file' }"
        :disabled="working"
        @click="mode = 'file'"
        >Excel 批量导入</button
      ></div
    >
    <fieldset
      v-if="mode === 'form'"
      class="case-form"
      :disabled="working"
    >
      <label
        >案例编号<input
          v-model="form.caseId"
          maxlength="80" /></label
      ><label
        >案例标题（选填）<input
          v-model="form.title"
          maxlength="80"
      /></label>
      <label
        >故障类型<select v-model="form.faultType"
          ><option value="">请选择</option
          ><option
            v-for="t in caseFaultTypes"
            :key="t.id"
            :value="t.id"
            >{{ t.name }}</option
          ></select
        ></label
      >
      <label
        >适用对象<select v-model="form.objectType"
          ><option value="">请选择</option
          ><option
            v-for="t in caseObjectTypes"
            :key="t.id"
            :value="t.id"
            >{{ t.name }}</option
          ></select
        ></label
      >
      <label
        >故障原因<input
          v-model="form.cause"
          maxlength="80"
          placeholder="一条明确原因，最多80字" /></label
      ><label
        >故障部件（选填）<input
          v-model="form.component"
          maxlength="80"
          placeholder="未定位到具体部件时留空"
      /></label>
      <label
        >故障现象<textarea
          v-model="symptomText"
          rows="4"
          placeholder="每行一个现象，名称须准确；不自动合并近义词"
        /></label
      ><label
        >排故步骤<textarea
          v-model="stepText"
          rows="4"
          placeholder="每行一步，按执行顺序填写；每步最多77字"
        />
      </label>
      <label class="wide"
        >解决方案<input
          v-model="form.solution"
          maxlength="80"
          placeholder="一条明确处置方案，最多80字"
      /></label>
      <label
        >设备类别（选填）<select v-model="form.deviceClass"
          ><option value="">不限定 HF/VUHF</option
          ><option>HF</option
          ><option>VUHF</option></select
        ></label
      >
      <label
        >知识来源<input
          v-model="form.source"
          maxlength="200"
          placeholder="填写规程、资料或经核对的案例来源"
      /></label>
    </fieldset>
    <div
      v-else
      class="file-area"
      ><button
        class="btn"
        :disabled="working"
        @click="template"
        >下载 Excel 模板</button
      ><label class="file-picker"
        >选择填好的 .xlsx 文件<input
          type="file"
          accept=".xlsx"
          :disabled="working"
          @change="readFile" /></label
      ><p>{{
        fileName || '三张业务表：知识条目、故障现象、排故步骤。按条目标识关联，最多5MiB。'
      }}</p></div
    >
    <p class="boundary"
      >部件未知时留空。发布后重新加载故障诊断，即可选择新增现象；案例是否命中取决于已发布关系及适用对象、频段。</p
    >
    <p
      v-if="message"
      role="alert"
      class="error"
      >{{ message }}</p
    >
    <div
      v-if="preview"
      class="preview"
      ><div class="summary"
        ><strong>构建预览</strong><span>{{ preview.caseCount }} 条案例</span
        ><span>新增 {{ preview.entityCount }} 实体 / {{ preview.relationCount }} 关系</span
        ><span
          >复用 {{ preview.reusedEntities }} 实体 / 跳过
          {{ preview.skippedRelations }} 重复关系</span
        ><span
          >{{ preview.entityCount + preview.relationCount }}/{{ KNOWLEDGE_MAX_OPERATIONS }} 项</span
        ></div
      >
      <table v-if="preview.issues.length"
        ><thead
          ><tr><th>位置</th><th>字段</th><th>问题</th></tr></thead
        ><tbody
          ><tr
            v-for="(issue, i) in preview.issues"
            :key="i"
            ><td>{{ issue.sheet }}{{ issue.row ? ' · 第' + issue.row + '行' : '' }}</td
            ><td>{{ issue.field }}</td
            ><td>{{ issue.message }}</td></tr
          ></tbody
        ></table
      >
      <template v-else-if="preview.draft"
        ><p>基线 {{ preview.draft.baseVersionId }}；整批生成一张草稿，未执行保存或发布。</p
        ><div class="entity-list"
          ><span
            v-for="entity in preview.draft.entities"
            :key="entity.id"
            >{{ typeName(entity.type) }} · {{ entity.name }}</span
          ></div
        ><details
          ><summary>查看生成关系（{{ preview.draft.relations.length }}）</summary
          ><ul
            ><li
              v-for="relation in preview.draft.relations"
              :key="relation.id"
              >{{ entityName(relation.head) }} — {{ relationName(relation.type) }} →
              {{ entityName(relation.tail) }}</li
            ></ul
          ></details
        ></template
      >
    </div>
    <template #footer
      ><span class="footer-note">错误或超出容量时整批拒绝，原草稿保持不变。</span
      ><button
        class="btn"
        :disabled="working"
        @click="close"
        >取消</button
      ><button
        class="btn"
        :disabled="working || !auth.can('knowledge.edit')"
        @click="check"
        >{{ working ? '正在处理…' : '重读基线并预检' }}</button
      ><button
        class="btn primary"
        :disabled="working || !preview?.draft || !auth.can('knowledge.edit')"
        @click="apply"
        >生成草稿并编辑</button
      ></template
    >
  </Dialog>
</template>
<script setup lang="ts">
import { computed, onMounted, onScopeDispose, reactive, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import { KNOWLEDGE_MAX_OPERATIONS } from '../config/demo';
import { useAuthStore } from '../stores/auth';
import { useKnowledgeStore } from '../stores/knowledge';
import type {
  KnowledgeCaseContext,
  KnowledgeCaseInput,
  KnowledgeCaseIssue,
  KnowledgeCasePreview,
} from '../types/knowledge-case';
import {
  buildKnowledgeCases,
  caseFaultTypes,
  caseObjectTypes,
} from '../services/knowledge-case-builder';
import { knowledgeCaseTemplate, parseKnowledgeCaseFile } from '../services/knowledge-case-files';
import { downloadDiagnosisFile } from '../reports/diagnosis-export';
import { randomUuid } from '../services/random-uuid';
const props = defineProps<{ visible: boolean }>(),
  emit = defineEmits<{ close: [] }>(),
  store = useKnowledgeStore(),
  auth = useAuthStore();
const mode = ref<'form' | 'file'>('form'),
  working = ref(false),
  message = ref(''),
  context = ref<KnowledgeCaseContext | null>(null),
  preview = ref<KnowledgeCasePreview | null>(null);
const base = computed(() => context.value?.base ?? null);
const fresh = (): KnowledgeCaseInput => ({
  caseId: 'FC-' + randomUuid().slice(0, 8).toUpperCase(),
  title: '',
  faultType: '',
  objectType: '',
  deviceClass: '',
  cause: '',
  component: '',
  solution: '',
  source: '',
  symptoms: [],
  steps: [],
});
const form = reactive(fresh()),
  symptomText = ref(''),
  stepText = ref(''),
  fileName = ref(''),
  fileCases = ref<KnowledgeCaseInput[]>([]),
  fileIssues = ref<KnowledgeCaseIssue[]>([]);
let serial = 0,
  applied = false;
const generatedCaseId = ref(form.caseId);
const dirty = computed(
  () =>
    props.visible &&
    !applied &&
    (form.caseId !== generatedCaseId.value ||
      !!fileName.value ||
      !!symptomText.value ||
      !!stepText.value ||
      [
        form.title,
        form.faultType,
        form.objectType,
        form.cause,
        form.component,
        form.solution,
        form.source,
        form.deviceClass,
      ].some(Boolean)),
);
watch(
  [form, symptomText, stepText, mode],
  () => {
    preview.value = null;
  },
  { deep: true },
);
watch(
  () => props.visible,
  (visible) => {
    serial++;
    if (visible) {
      applied = false;
      preview.value = null;
      message.value = '';
      context.value = null;
    }
    working.value = false;
  },
);
async function requestLeave() {
  if (!props.visible) return true;
  if (working.value) return false;
  if (
    dirty.value &&
    (await store.ask({
      title: '尚未应用的结构化输入',
      message: '放弃本次表单或导入预览？原知识草稿和已发布版本保留。',
      saveLabel: '放弃本次输入',
      cancelLabel: '继续编辑',
    })) !== 'save'
  )
    return false;
  return true;
}
function resetInput() {
  Object.assign(form, fresh());
  generatedCaseId.value = form.caseId;
  symptomText.value = '';
  stepText.value = '';
  fileName.value = '';
  fileCases.value = [];
  fileIssues.value = [];
  preview.value = null;
}
async function close() {
  if (await requestLeave()) {
    resetInput();
    emit('close');
  }
}
const releaseLeave = auth.registerLeave(requestLeave, () => dirty.value),
  releaseCleaner = auth.registerCleaner(() => {
    serial++;
    working.value = false;
    Object.assign(form, fresh());
    generatedCaseId.value = form.caseId;
    symptomText.value = '';
    stepText.value = '';
    fileName.value = '';
    fileCases.value = [];
    fileIssues.value = [];
    context.value = null;
    preview.value = null;
    emit('close');
  });
onScopeDispose(() => {
  serial++;
  releaseLeave();
  releaseCleaner();
  if (typeof window !== 'undefined') window.removeEventListener('beforeunload', beforeUnload);
});
const beforeUnload = (event: BeforeUnloadEvent) => {
  if (props.visible && (dirty.value || working.value)) { event.preventDefault(); event.returnValue = ''; }
};
onMounted(() => { if (typeof window !== 'undefined') window.addEventListener('beforeunload', beforeUnload); });
defineExpose({ requestLeave });
async function template() {
  if (working.value) return;
  working.value = true;
  message.value = '';
  const token = serial,
    epoch = auth.generation;
  try {
    const file = await knowledgeCaseTemplate();
    if (token === serial && epoch === auth.generation && props.visible) downloadDiagnosisFile(file);
  } catch (e) {
    if (token === serial) message.value = e instanceof Error ? e.message : '模板生成失败';
  } finally {
    if (token === serial) working.value = false;
  }
}
async function readFile(event: Event) {
  if (working.value) return;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const token = ++serial,
    epoch = auth.generation;
  preview.value = null;
  fileCases.value = [];
  fileIssues.value = [];
  fileName.value = file.name;
  working.value = true;
  message.value = '';
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('文件最多5MiB');
    const parsed = await parseKnowledgeCaseFile({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    if (token === serial && epoch === auth.generation && props.visible) {
      fileCases.value = parsed.cases;
      fileIssues.value = parsed.issues;
    }
  } catch (e) {
    if (token === serial) message.value = e instanceof Error ? e.message : '文件解析失败';
  } finally {
    if (token === serial) working.value = false;
  }
}
async function check() {
  if (working.value) return;
  const token = ++serial,
    epoch = auth.generation;
  working.value = true;
  message.value = '';
  preview.value = null;
  const fromFile = mode.value === 'file',
    cases = fromFile
      ? fileCases.value
      : [
          {
            ...form,
            symptoms: symptomText.value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean),
            steps: stepText.value
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((text, i) => ({ order: i + 1, text })),
          },
        ],
    parseIssues = [...fileIssues.value];
  try {
    // 每次显式预检重新读取基线与目录，旧版失败后仍保留表单和已解析的文件。
    const current = await store.readCaseBase();
    if (token !== serial || epoch !== auth.generation || !props.visible) return;
    const next = buildKnowledgeCases(cases, current.base, current.catalog);
    if (fromFile && parseIssues.length) {
      next.issues.unshift(...parseIssues);
      next.draft = null;
    }
    context.value = current;
    preview.value = next;
  } catch (e) {
    if (token === serial) message.value = e instanceof Error ? e.message : '预检失败，输入已保留';
  } finally {
    if (token === serial) working.value = false;
  }
}
async function apply() {
  if (working.value || !preview.value?.draft || !context.value) return;
  const token = ++serial;
  working.value = true;
  message.value = '';
  try {
    await store.applyCaseDraft(preview.value.draft, context.value);
    if (token !== serial || !props.visible) return;
    applied = true;
    emit('close');
    Object.assign(form, fresh());
    generatedCaseId.value = form.caseId;
    symptomText.value = '';
    stepText.value = '';
    fileName.value = '';
    fileCases.value = [];
  } catch (e) {
    if (token === serial) {
      preview.value = null;
      message.value = e instanceof Error ? e.message : '生成草稿失败，请重读基线并预检';
    }
  } finally {
    if (token === serial) working.value = false;
  }
}
const typeName = (type: string) =>
  (context.value?.catalog ?? store.catalog).types.find((t) => t.id === type)?.name || type;
const relationName = (type: string) =>
  (context.value?.catalog ?? store.catalog).relationTypes.find((t) => t.id === type)?.name || type;
const entityName = (id: string) =>
  preview.value?.draft?.entities.find((e) => e.id === id)?.name ||
  base.value?.entities.find((e) => e.id === id)?.name ||
  id;
</script>
<style scoped>
.intro,
.boundary {
  font-size: 12px;
  color: #9fb6cb;
  line-height: 1.7;
}
.case-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 13px 18px;
  margin: 18px 0;
  border: 0;
  padding: 0;
  min-width: 0;
}
.case-form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
}
.wide {
  grid-column: 1/-1;
}
.case-form textarea {
  resize: vertical;
  min-height: 90px;
}
.boundary {
  padding: 10px 13px;
  border-left: 3px solid #479bc1;
  background: #10273a;
}
.file-area {
  padding: 25px 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 18px;
}
.file-picker {
  font-size: 12px;
}
.file-picker input {
  display: block;
  margin-top: 8px;
}
.file-area p {
  width: 100%;
  color: #9fb6cb;
}
.preview {
  border: 1px solid #35516b;
  border-radius: 6px;
  padding: 13px;
  margin-top: 13px;
}
.summary {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  align-items: center;
  color: #b7d4e8;
  font-size: 12px;
}
.entity-list {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin: 12px 0;
  max-height: 150px;
  overflow: auto;
}
.entity-list span {
  border: 1px solid #335975;
  background: #132c43;
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 11px;
}
.preview details {
  font-size: 12px;
}
.preview li {
  margin: 6px 0;
}
table {
  width: 100%;
  font-size: 12px;
  margin-top: 12px;
  text-align: left;
}
td,
th {
  padding: 8px;
  border-bottom: 1px solid #2d4157;
}
.error {
  color: #f9a8b5;
}
.footer-note {
  font-size: 11px;
  color: #9fb0c0;
  margin-right: auto;
}
@media (max-width: 650px) {
  .case-form {
    grid-template-columns: 1fr;
  }
  .wide {
    grid-column: auto;
  }
}
</style>
