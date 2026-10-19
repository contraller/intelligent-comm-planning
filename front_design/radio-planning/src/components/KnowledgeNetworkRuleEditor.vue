<template>
  <section
    v-if="applicable || entity.networkRule != null"
    class="rule-editor"
    aria-label="状态规则说明维护"
  >
    <h4>状态规则说明维护</h4><p>仅维护文字说明；发布不会重算观测状态。</p>
    <template v-if="view.rule && applicable">
      <label
        >适用范围<textarea
          :value="view.rule.scope"
          :readonly="!writable"
          maxlength="500"
          aria-label="规则适用范围"
          :onInput="view.field('scope')"
        />
      </label>
      <label
        >规则来源<input
          :value="view.rule.source"
          :readonly="!writable"
          maxlength="200"
          aria-label="规则来源"
          :onInput="view.field('source')"
      /></label>
      <div
        v-for="(row, i) in view.rule.criteria"
        :key="row.state"
        class="rule-edit-row"
      >
        <strong>{{ LINK_STATUS_STYLES[row.state]?.label ?? '无效状态' }}</strong>
        <label
          >文字条件<textarea
            :value="row.condition"
            :readonly="!writable"
            maxlength="500"
            :aria-label="row.state + ' 条件'"
            :onInput="view.criterion(i, 'condition')"
          />
        </label>
        <label
          >状态含义<textarea
            :value="row.meaning"
            :readonly="!writable"
            maxlength="500"
            :aria-label="row.state + ' 含义'"
            :onInput="view.criterion(i, 'meaning')"
          />
        </label>
      </div>
      <div
        v-for="(row, i) in view.rule.transitions"
        :key="i"
        class="rule-edit-row"
      >
        <label
          >起始状态<select
            :value="row.from"
            :disabled="!writable"
            :aria-label="'变化 ' + (i + 1) + ' 起始状态'"
            :onChange="view.transition(i, 'from')"
            ><option
              v-for="state in networkRuleStates"
              :key="state"
              :value="state"
              >{{ LINK_STATUS_STYLES[state].label }}</option
            ></select
          ></label
        >
        <label
          >目标状态<select
            :value="row.to"
            :disabled="!writable"
            :aria-label="'变化 ' + (i + 1) + ' 目标状态'"
            :onChange="view.transition(i, 'to')"
            ><option
              v-for="state in networkRuleStates"
              :key="state"
              :value="state"
              >{{ LINK_STATUS_STYLES[state].label }}</option
            ></select
          ></label
        >
        <label
          >变化说明<textarea
            :value="row.description"
            :readonly="!writable"
            maxlength="500"
            :aria-label="'变化 ' + (i + 1) + ' 说明'"
            :onInput="view.transition(i, 'description')"
          />
        </label>
        <button
          v-if="writable"
          class="text-link"
          :onClick="view.removeTransition(i)"
          >移除此变化说明</button
        >
      </div>
      <button
        v-if="writable"
        class="btn small"
        :disabled="view.rule.transitions.length >= 12"
        :onClick="view.add"
        >添加状态变化说明</button
      >
    </template>
    <div
      v-if="writable"
      class="toolbar section-gap"
    >
      <button
        v-if="!view.rule && applicable"
        class="btn small"
        :onClick="view.enable"
        >{{ resolved ? '采用教学内容' : '添加规则说明' }}</button
      >
      <button
        v-if="view.rule || resolved"
        class="text-link"
        :onClick="view.remove"
        >移除规则说明</button
      >
    </div>
    <p
      v-for="issue in issues"
      :key="issue.message"
      class="error"
      role="alert"
      >{{ issue.message }}</p
    >
    <KnowledgeNetworkRulePanel
      :entity="entity"
      :context="context"
    />
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import type { KnowledgeEntity, KnowledgeNetworkRule } from '../types/knowledge';
import {
  copyNetworkRule,
  networkRuleIssues,
  networkRuleStates,
  resolveNetworkRule,
} from '../services/knowledge-network-rule';
import { LINK_STATUS_STYLES } from '../config/link-status';
import KnowledgeNetworkRulePanel from './KnowledgeNetworkRulePanel.vue';
const props = defineProps<{ entity: KnowledgeEntity; readonly: boolean; context: string }>();
const emit = defineEmits<{ 'update:rule': [value: KnowledgeNetworkRule | null] }>();
const auth = useAuthStore();
const applicable = computed(
  () => props.entity.type === 'NetRule' && props.entity.category === '网络态势知识',
);
const writable = computed(() => !props.readonly && auth.can('knowledge.edit') && !auth.blocked);
const resolved = computed(() => resolveNetworkRule(props.entity)),
  issues = computed(() => networkRuleIssues(props.entity));
// 事件绑定实体、修订上下文及身份，迟到事件不能修改新打开的草稿。
const editGeneration = ref(0);
// 同一草稿移除或替换内容也使旧行事件失效，防止索引复用污染下一条。
watch(
  () => [props.entity, props.context, props.readonly, auth.generation],
  () => {
    editGeneration.value++;
  },
  { deep: true, flush: 'sync' },
);
const owner = computed(
  () => props.entity.id + '|' + props.context + '|' + auth.generation + '|' + editGeneration.value,
);
const canWrite = (captured: string) =>
  writable.value && captured === owner.value && applicable.value;
function emitRule(rule: KnowledgeNetworkRule | null, captured: string) {
  if (writable.value && captured === owner.value && (rule === null || applicable.value))
    emit('update:rule', rule);
}
function enable(captured: string) {
  if (!canWrite(captured)) return;
  emitRule(
    resolved.value
      ? copyNetworkRule(resolved.value.rule)
      : {
          scope: '',
          source: '',
          criteria: networkRuleStates.map((state) => ({ state, condition: '', meaning: '' })),
          transitions: [],
        },
    captured,
  );
}
function change(field: 'scope' | 'source', value: string, captured: string) {
  if (!canWrite(captured)) return;
  if (props.entity.networkRule)
    emitRule({ ...copyNetworkRule(props.entity.networkRule), [field]: value }, captured);
}
function criterion(index: number, field: 'condition' | 'meaning', value: string, captured: string) {
  if (!canWrite(captured)) return;
  const current = props.entity.networkRule;
  if (!current) return;
  const rule = copyNetworkRule(current);
  if (!rule.criteria[index]) return;
  rule.criteria[index][field] = value;
  emitRule(rule, captured);
}
function transition(
  index: number,
  field: 'from' | 'to' | 'description',
  value: string,
  captured: string,
) {
  if (!canWrite(captured)) return;
  const current = props.entity.networkRule;
  if (!current) return;
  const rule = copyNetworkRule(current);
  if (!rule.transitions[index]) return;
  rule.transitions[index] = { ...rule.transitions[index], [field]: value };
  emitRule(rule, captured);
}
function add(captured: string) {
  if (!canWrite(captured)) return;
  const current = props.entity.networkRule;
  if (!current || current.transitions.length >= 12) return;
  const rule = copyNetworkRule(current);
  rule.transitions.push({ from: 'GOOD', to: 'WARNING', description: '' });
  emitRule(rule, captured);
}
function remove(index: number, captured: string) {
  if (!canWrite(captured)) return;
  const current = props.entity.networkRule;
  if (!current) return;
  const rule = copyNetworkRule(current);
  rule.transitions.splice(index, 1);
  emitRule(rule, captured);
}
// 每次渲染保存归属令牌，监听器不从旧 DOM 读取新上下文。
const view = computed(() => {
  const captured = owner.value;
  return {
    rule: props.entity.networkRule,
    enable: () => enable(captured),
    remove: () => emitRule(null, captured),
    add: () => add(captured),
    field: (key: 'scope' | 'source') => (e: Event) =>
      change(key, (e.target as HTMLInputElement).value, captured),
    criterion: (i: number, key: 'condition' | 'meaning') => (e: Event) =>
      criterion(i, key, (e.target as HTMLInputElement).value, captured),
    transition: (i: number, key: 'from' | 'to' | 'description') => (e: Event) =>
      transition(i, key, (e.target as HTMLInputElement).value, captured),
    removeTransition: (i: number) => () => remove(i, captured),
  };
});
</script>
<style scoped>
.rule-editor {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 5px;
}
.rule-editor h4 {
  font-size: 13px;
}
.rule-editor p {
  font-size: 12px;
  line-height: 1.8;
}
.rule-editor label {
  display: grid;
  gap: 6px;
  margin: 10px 0;
  font-size: 12px;
}
.rule-edit-row {
  padding: 10px 0;
  border-top: 1px solid var(--line);
}
.rule-editor textarea {
  min-height: 60px;
}
.error {
  color: #ffb4b4;
}
</style>
