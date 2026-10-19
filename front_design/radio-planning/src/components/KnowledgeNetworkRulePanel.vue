<template>
  <section
    v-if="auth.can('knowledge.view') && !auth.blocked && applicable"
    class="network-rule"
    aria-label="网络状态规则说明"
  >
    <h4>网络状态规则说明</h4><p class="source">{{ context }}</p>
    <template v-if="resolved">
      <p class="source"
        >{{
          resolved.teaching ? '独立教学补充 · 不是该历史版本内保存的规则' : '版本内规则说明'
        }}；仅展示文字，不执行状态判定。</p
      >
      <p>{{ resolved.rule.scope }}</p
      ><p class="source">来源：{{ resolved.rule.source }}</p>
      <article
        v-for="row in resolved.rule.criteria"
        :key="row.state"
        ><strong :style="{ color: LINK_STATUS_STYLES[row.state].color }">{{
          LINK_STATUS_STYLES[row.state].label
        }}</strong
        ><p>{{ row.condition }}</p
        ><p>{{ row.meaning }}</p></article
      >
      <h5>状态变化说明</h5><p v-if="!resolved.rule.transitions.length">暂无状态变化说明</p>
      <article
        v-for="(row, i) in resolved.rule.transitions"
        :key="i"
        ><strong
          >{{ LINK_STATUS_STYLES[row.from].label }} → {{ LINK_STATUS_STYLES[row.to].label }}</strong
        ><p>{{ row.description }}</p></article
      >
    </template>
    <p
      v-else
      role="status"
      >{{
        networkRuleIssues(entity)[0]?.message ??
        (entity.networkRule === null ? '本条知识已明确移除规则说明' : '未提供状态规则说明')
      }}</p
    >
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '../stores/auth';
import { LINK_STATUS_STYLES } from '../config/link-status';
import { resolveNetworkRule, networkRuleIssues } from '../services/knowledge-network-rule';
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
