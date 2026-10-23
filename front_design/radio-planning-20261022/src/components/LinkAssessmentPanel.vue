<template>
  <section
    class="assessment"
    aria-label="链路判定依据"
  >
    <h5>判定依据</h5>
    <p
      v-if="!readable"
      role="status"
      >当前角色没有此链路态势的查看权限。</p
    >
    <template v-else>
      <p
        v-if="owner"
        class="source"
        >网络 {{ owner.networkKey }} · 链路 {{ owner.linkId }}<br />采样 {{ owner.observedAt }}</p
      >
      <p
        v-if="!data"
        role="status"
        >{{ display.message }}</p
      >
      <template v-else>
        <dl class="kv"
          ><dt>评估结果</dt
          ><dd :style="{ color: LINK_STATUS_STYLES[data.state].color }">{{
            LINK_STATUS_STYLES[data.state].label
          }}</dd>
          <dt>置信度</dt
          ><dd>{{
            data.confidence == null ? '未提供' : (data.confidence * 100).toFixed(1) + '%'
          }}</dd>
          <dt>主导指标</dt
          ><dd>{{
            LINK_METRICS.find((m) => m.key === data!.dominantMetric)?.label ?? '未提供'
          }}</dd></dl
        >
        <p
          v-if="observedState && observedState !== data.state"
          class="warning"
          >评估结果与观测等级（{{
            LINK_STATUS_STYLES[observedState].label
          }}）不一致，地图仍显示原观测等级。</p
        >
        <p>{{ data.explanation ?? '未提供文字解释' }}</p
        ><p class="source">{{ data.source }} · {{ data.version }}</p>
        <p v-if="data.matchedRuleIds == null">未提供命中规则信息</p
        ><p v-else-if="!rows.length">服务明确没有命中规则</p>
        <article
          v-for="row in rows"
          :key="row.id"
          class="rule"
        >
          <button
            v-if="row.rule"
            class="text-link"
            :aria-expanded="expanded.includes(row.id)"
            @click="toggle(row.id, row.identity)"
            >{{ row.id }} · {{ row.rule.title }}</button
          >
          <p v-else>{{ row.id }} · 未提供规则内容</p>
          <div v-if="row.rule && expanded.includes(row.id)"
            ><p>{{ row.rule.conditionText }}</p
            ><p class="source"
              >{{ row.rule.source }} · {{ row.rule.version ?? '未提供规则版本' }}</p
            ></div
          >
        </article>
      </template>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { LINK_STATUS_STYLES } from '../config/link-status';
import { LINK_METRICS } from '../services/link-detail';
import type { LinkAssessmentDisplay, LinkAssessmentOwner } from '../types/link-assessment';
import type { NetworkLink } from '../types/domain';

const props = defineProps<{
  display: LinkAssessmentDisplay;
  owner: LinkAssessmentOwner | null;
  observedState?: NetworkLink['state'];
  monitoring?: boolean;
}>();
const auth = useAuthStore(),
  expanded = ref<string[]>([]);
const readable = computed(
  () =>
    auth.can('situation.view') && (!props.monitoring || auth.can('planning.view')) && !auth.blocked,
);
const data = computed(() =>
  readable.value && props.display.state === 'ready' ? props.display.assessment : null,
);
// 展开属于此身份下的这份解释；旧点击事件不能打开新采样的规则。
const identity = computed(() =>
  JSON.stringify([props.owner, props.display, auth.generation, readable.value]),
);
watch(
  identity,
  () => {
    expanded.value = [];
  },
  { flush: 'sync' },
);
function toggle(id: string, captured: string) {
  if (!readable.value || captured !== identity.value || !data.value?.matchedRuleIds?.includes(id))
    return;
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((v) => v !== id)
    : [...expanded.value, id];
}
const rows = computed(
  () =>
    data.value?.matchedRuleIds?.map((id) => ({
      id,
      rule: data.value!.rules?.find((r) => r.ruleId === id),
      identity: identity.value,
    })) ?? [],
);
</script>
<style scoped>
.assessment {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 5px;
  font-size: 12px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.assessment h5 {
  margin: 0 0 8px;
  font-size: 13px;
}
.assessment p {
  margin: 8px 0;
  white-space: pre-wrap;
}
.source {
  color: var(--muted);
  font-size: 11px;
}
.warning {
  color: #f2cf5b;
}
.rule {
  border-top: 1px solid var(--line);
  padding-top: 8px;
}
.rule button {
  text-align: left;
}
.kv {
  margin: 8px 0;
}
</style>
