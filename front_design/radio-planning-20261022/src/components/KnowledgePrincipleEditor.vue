<template>
  <section
    v-if="entity.category === '设备知识'"
    class="principle-editor"
    aria-label="工作原理步骤维护"
  >
    <h4>工作原理步骤</h4>
    <p class="muted">2–12 个顺序步骤；发布后更新设备知识，来源沿用本条知识的来源说明。</p>
    <template v-if="entity.principleFlow">
      <div
        v-for="(step, index) in steps"
        :key="index"
        class="step-edit"
      >
        <label
          >第 {{ index + 1 }} 步标题<input
            :value="knowledgeText(step.title)"
            :readonly="!editable"
            maxlength="40"
            :aria-label="'第 ' + (index + 1) + ' 步标题'"
            @input="update(index, 'title', $event)"
        /></label>
        <label
          >步骤说明<textarea
            :value="knowledgeText(step.description)"
            :readonly="!editable"
            maxlength="200"
            rows="2"
            :aria-label="'第 ' + (index + 1) + ' 步说明'"
            @input="update(index, 'description', $event)"
          />
        </label>
        <div
          v-if="editable"
          class="toolbar"
          ><button
            class="btn small"
            :disabled="index === 0"
            :aria-label="'上移第 ' + (index + 1) + ' 步'"
            @click="move(index, -1)"
            >上移</button
          ><button
            class="btn small"
            :disabled="index === steps.length - 1"
            :aria-label="'下移第 ' + (index + 1) + ' 步'"
            @click="move(index, 1)"
            >下移</button
          ><button
            class="text-link"
            :disabled="steps.length <= 2"
            :aria-label="'移除第 ' + (index + 1) + ' 步'"
            @click="removeStep(index)"
            >移除此步骤</button
          ></div
        >
      </div>
      <button
        v-if="editable"
        class="btn small"
        :disabled="steps.length >= PRINCIPLE_MAX_STEPS"
        @click="addStep"
        >添加步骤</button
      >
    </template>
    <p
      v-else
      class="muted"
      >{{
        resolved
          ? '已保存的工作原理步骤。'
          : entity.principleFlow === null
            ? '本条知识已移除流程，保留文字说明。'
            : '尚未提供流程步骤，保留文字说明。'
      }}</p
    >
    <div
      v-if="editable"
      class="toolbar section-gap"
    >
      <button
        v-if="!entity.principleFlow"
        class="btn small"
        @click="enable"
        >{{ resolved ? '编辑工作原理' : '添加工作原理流程' }}</button
      >
      <button
        v-if="entity.principleFlow || resolved"
        class="text-link"
        @click="removeFlow"
        >移除整个流程</button
      >
    </div>
    <p
      v-for="issue in issues"
      :key="issue.message"
      class="step-error"
      role="alert"
      >{{ knowledgeText(issue.message) }}</p
    >
    <KnowledgePrincipleFlow
      :entity="entity"
      :context="context"
    />
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import type {
  KnowledgeEntity,
  KnowledgePrincipleFlow as PrincipleFlow,
  KnowledgePrincipleStep,
} from '../types/knowledge';
import {
  PRINCIPLE_MAX_STEPS,
  principleIssues,
  resolveKnowledgePrinciple,
} from '../services/knowledge-principle';
import KnowledgePrincipleFlow from './KnowledgePrincipleFlow.vue';
import { knowledgeText } from '../services/knowledge-display';

const props = defineProps<{ entity: KnowledgeEntity; readonly: boolean; context: string }>();
const emit = defineEmits<{ 'update:flow': [value: PrincipleFlow | null] }>();
const resolved = computed(() => resolveKnowledgePrinciple(props.entity));
const steps = computed(() => props.entity.principleFlow?.steps ?? []);
const issues = computed(() => principleIssues(props.entity));
const editable = computed(() => !props.readonly && props.entity.category === '设备知识');
// 中文仅适配显示，输入事件仍读取原文并沿用原有写入守卫。
function replace(next: KnowledgePrincipleStep[]) {
  if (editable.value) emit('update:flow', { steps: next });
}
// 仅在明确操作时复制示例到草稿，打开查看不会产生未保存修改。
function enable() {
  replace(
    resolved.value?.flow.steps.map((step) => ({ ...step })) ?? [
      { title: '', description: '' },
      { title: '', description: '' },
    ],
  );
}
function update(index: number, field: keyof KnowledgePrincipleStep, event: Event) {
  const value = (event.target as HTMLInputElement).value;
  replace(steps.value.map((step, i) => (i === index ? { ...step, [field]: value } : { ...step })));
}
function move(index: number, offset: number) {
  const target = index + offset;
  if (target < 0 || target >= steps.value.length) return;
  const next = steps.value.map((step) => ({ ...step }));
  [next[index], next[target]] = [next[target], next[index]];
  replace(next);
}
function removeStep(index: number) {
  if (steps.value.length > 2)
    replace(steps.value.filter((_, i) => i !== index).map((step) => ({ ...step })));
}
function addStep() {
  if (steps.value.length < PRINCIPLE_MAX_STEPS)
    replace([...steps.value.map((step) => ({ ...step })), { title: '', description: '' }]);
}
function removeFlow() {
  if (editable.value) emit('update:flow', null);
}
</script>
<style scoped>
.principle-editor {
  padding: 12px;
  margin-top: 14px;
  border: 1px solid #30475e;
  border-radius: 6px;
}
.principle-editor h4 {
  font-size: 13px;
  color: #bbd8ee;
}
.principle-editor > .muted {
  font-size: 12px;
  line-height: 1.8;
  margin: 10px 0;
}
.step-edit {
  display: grid;
  gap: 10px;
  padding: 12px 0;
  border-top: 1px solid #293e54;
}
.step-edit .toolbar {
  flex-wrap: wrap;
}
.step-error {
  font-size: 12px;
  line-height: 1.7;
  color: #ffb4b4;
  margin-top: 10px;
}
</style>
