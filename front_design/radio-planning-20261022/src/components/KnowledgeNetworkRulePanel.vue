<template>
  <section
    v-if="auth.can('knowledge.view') && !auth.blocked && applicable"
    class="network-rule"
    aria-label="网络状态规则说明"
  >
    <h4>网络状态规则说明</h4><p class="source">{{ knowledgeText(context) }}</p>
    <template v-if="resolved">
      <p class="source">{{ '状态等级与变化依据' }}。</p>
      <p>{{ knowledgeText(resolved.rule.scope) }}</p
      ><p class="source">来源：{{ knowledgeSource(resolved.rule.source) }}</p>
      <article
        v-for="row in resolved.rule.criteria"
        :key="row.state"
        ><strong :style="{ color: LINK_STATUS_STYLES[row.state].color }">{{
          LINK_STATUS_STYLES[row.state].label
        }}</strong
        ><p>{{ knowledgeText(row.condition) }}</p
        ><p>{{ knowledgeText(row.meaning) }}</p></article
      >
      <h5>状态变化说明</h5><p v-if="!resolved.rule.transitions.length">暂无状态变化说明</p>
      <article
        v-for="(row, i) in resolved.rule.transitions"
        :key="i"
        ><strong
          >{{ LINK_STATUS_STYLES[row.from].label }} → {{ LINK_STATUS_STYLES[row.to].label }}</strong
        ><p>{{ knowledgeText(row.description) }}</p></article
      >
    </template>
    <p
      v-else
      role="status"
      >{{
        knowledgeText(
          networkRuleIssues(entity)[0]?.message ??
            (entity.networkRule === null ? '本条知识已明确移除规则说明' : '未提供状态规则说明'),
        )
      }}</p
    >
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { LINK_STATUS_STYLES } from '../config/link-status';
import { resolveNetworkRule, networkRuleIssues } from '../services/knowledge-network-rule';
import { knowledgeSource, knowledgeText } from '../services/knowledge-display';
import type { KnowledgeEntity } from '../types/knowledge';
const props = defineProps<{ entity: KnowledgeEntity; context: string }>();
const auth = useAuthStore(),
  resolved = computed(() => resolveNetworkRule(props.entity));
// 已发布、草稿预览和历史均显式给出自己的归属。
const applicable = computed(
  () => props.entity.type === 'NetRule' || props.entity.networkRule != null,
);
</script>
<style scoped>
.network-rule {
  margin: 14px 0;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 5px;
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.network-rule h4,
.network-rule h5 {
  margin: 0 0 8px;
}
.network-rule h5 {
  margin-top: 12px;
}
.network-rule article {
  padding: 8px 0;
  border-top: 1px solid var(--line);
}
.network-rule p {
  white-space: pre-wrap;
  margin: 6px 0;
}
.source {
  color: var(--muted);
  font-size: 11px;
}
</style>
