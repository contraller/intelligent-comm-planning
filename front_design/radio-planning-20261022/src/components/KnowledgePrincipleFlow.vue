<template>
  <section
    v-if="visible && resolved"
    class="principle-flow"
    aria-label="工作原理流程图"
  >
    <div class="principle-heading"
      ><strong>工作原理流程图</strong
      ><button
        class="btn small"
        @click="fullscreen = true"
        >全屏查看</button
      ></div
    >
    <ol class="principle-steps">
      <li
        v-for="(step, index) in resolved.flow.steps"
        :key="index"
      >
        <span
          class="step-number"
          aria-hidden="true"
          >{{ index + 1 }}</span
        >
        <div
          ><strong>{{ knowledgeText(step.title) }}</strong
          ><p v-if="step.description">{{ knowledgeText(step.description) }}</p></div
        >
        <span
          v-if="index < resolved.flow.steps.length - 1"
          class="step-arrow"
          aria-hidden="true"
          >↓</span
        >
      </li>
    </ol>
    <p class="principle-note">工作原理 · {{ knowledgeText(context) }}</p>
    <!-- 应用内全屏，复用 Dialog 的模态、Esc 和焦点约束，不申请系统全屏。 -->
    <Dialog
      v-model:visible="fullscreen"
      modal
      block-scroll
      :draggable="false"
      :dismissable-mask="false"
      close-on-escape
      :header="knowledgeEntityName(entity) + ' · 工作原理'"
      :style="{
        width: '100vw',
        maxWidth: '100vw',
        height: '100dvh',
        maxHeight: '100dvh',
        margin: '0',
        borderRadius: '0',
      }"
      :content-style="{ flex: '1', overflow: 'auto' }"
    >
      <div class="principle-fullscreen">
        <p class="principle-note">{{ knowledgeText(context) }} · 工作原理</p>
        <ol class="principle-steps">
          <li
            v-for="(step, index) in resolved.flow.steps"
            :key="index"
          >
            <span
              class="step-number"
              aria-hidden="true"
              >{{ index + 1 }}</span
            >
            <div
              ><strong>{{ knowledgeText(step.title) }}</strong
              ><p v-if="step.description">{{ knowledgeText(step.description) }}</p></div
            >
            <span
              v-if="index < resolved.flow.steps.length - 1"
              class="step-arrow"
              aria-hidden="true"
              >↓</span
            >
          </li>
        </ol>
        <p class="principle-note">来源：{{ knowledgeSource(entity.source) }}</p>
      </div>
      <template #footer
        ><button
          class="btn"
          @click="fullscreen = false"
          >退出全屏</button
        ></template
      >
    </Dialog>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import { useAuthStore } from '../stores/auth';
import { resolveKnowledgePrinciple } from '../services/knowledge-principle';
import { knowledgeEntityName, knowledgeSource, knowledgeText } from '../services/knowledge-display';
import type { KnowledgeEntity } from '../types/knowledge';

const props = defineProps<{ entity: KnowledgeEntity; context: string }>();
const auth = useAuthStore(),
  fullscreen = ref(false);
const resolved = computed(() => resolveKnowledgePrinciple(props.entity));
const visible = computed(() => auth.can('knowledge.view') && !!resolved.value);
// 全屏只属于打开时的实体、版本和身份；内容刷新后必须重新打开。
watch(
  () => [props.context, JSON.stringify(props.entity), auth.generation, visible.value],
  () => {
    fullscreen.value = false;
  },
  { flush: 'sync' },
);
</script>
<style scoped>
.principle-flow {
  margin: 14px 0;
  min-width: 0;
}
.principle-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #bbd8ee;
}
.principle-steps {
  list-style: none;
  padding: 0;
  margin: 14px 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.principle-steps li {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px 12px;
  background: #142c43;
  border: 1px solid #3b6686;
  border-radius: 6px;
  color: #c7e1f3;
  min-width: 0;
  overflow-wrap: anywhere;
}
.principle-steps li > div {
  min-width: 0;
  flex: 1;
}
.principle-steps strong {
  font-size: 13px;
  line-height: 1.7;
}
.principle-steps p {
  font-size: 12px;
  line-height: 1.8;
  white-space: pre-wrap;
  color: #a5bfd3;
  margin: 6px 0 0;
}
.step-number {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 24px;
  height: 24px;
  border-radius: 50%;
  background: #235476;
  color: #d1efff;
  font-size: 12px;
}
.step-arrow {
  position: absolute;
  bottom: -25px;
  left: 50%;
  transform: translateX(-50%);
  height: 24px;
  line-height: 24px;
  color: #79b6da;
  font-size: 19px;
}
.principle-note {
  font-size: 11px;
  line-height: 1.8;
  color: #8caac1;
  overflow-wrap: anywhere;
  margin: 10px 0;
}
.principle-fullscreen {
  width: min(100%, 800px);
  margin: 0 auto;
  padding: 12px 0;
}
.principle-fullscreen .principle-steps li {
  padding: 20px;
}
.principle-fullscreen .principle-steps strong {
  font-size: 16px;
}
.principle-fullscreen .principle-steps p {
  font-size: 14px;
}
</style>
