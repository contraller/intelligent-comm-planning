<template>
  <AppDrawer
    :visible="visible"
    :title="copy ? '复制为新场景' : '新建故障场景'"
    subtitle="选择当前有效的已确认网络"
    @update:visible="!$event && !busy && $emit('close')"
  >
    <div class="source-form">
      <p v-if="copy">复制保留故障输入，创建新的场景；替换网络后请复核对象。</p>
      <label
        >绑定网络<select
          v-model="planId"
          :disabled="busy"
          aria-label="新场景绑定网络"
        >
          <option value="">请选择网络</option>
          <option
            v-for="plan in plans"
            :key="plan.id"
            :value="plan.id"
            :disabled="!plan.canCreate"
            >{{ plan.name }} · {{ plan.taskId }} · {{ plan.id }}</option
          >
        </select></label
      >
      <p v-if="!plans.length">暂无当前有效的已确认网络，请先在网络规划中保存并确认方案。</p>
      <p
        v-if="
          copy && preferredId && !plans.some((plan) => plan.id === preferredId && plan.canCreate)
        "
        >原网络当前不可用，请明确选择替代网络。</p
      >
      <article
        v-for="plan in plans.filter((item) => !item.canCreate)"
        :key="plan.id"
        ><strong>{{ plan.name }}</strong
        ><p>{{ plan.unavailableReason }}</p></article
      >
      <p
        v-if="error"
        class="error"
        role="alert"
        >{{ error }}</p
      >
    </div>
    <template #footer
      ><button
        class="btn"
        :disabled="busy"
        @click="$emit('close')"
        >取消</button
      ><button
        class="btn primary"
        :disabled="busy || !plans.some((plan) => plan.id === planId && plan.canCreate)"
        @click="$emit('confirm', planId)"
        >创建场景草稿</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import AppDrawer from './AppDrawer.vue';
import type { DiagnosisPlanOption } from '../types/diagnosis';
const props = defineProps<{
  visible: boolean;
  plans: DiagnosisPlanOption[];
  preferredId: string;
  copy: boolean;
  busy: boolean;
  error: string;
}>();
defineEmits<{ close: []; confirm: [planId: string] }>();
const planId = ref('');
// 仅复制时预选仍有效的原网络；新建和失效替换均由用户明确选择。
watch(
  () => props.visible,
  (visible) => {
    if (visible)
      planId.value = props.plans.some((plan) => plan.id === props.preferredId && plan.canCreate)
        ? props.preferredId
        : '';
  },
);
</script>
<style scoped>
.source-form {
  display: grid;
  gap: 16px;
  color: #b9cfe2;
  font-size: 13px;
  line-height: 1.8;
}
label {
  display: grid;
  gap: 8px;
}
select {
  width: 100%;
  padding: 10px;
  color: #d9eafa;
  background: #102137;
  border: 1px solid #34516f;
}
article {
  padding: 10px;
  background: #17293c;
  border: 1px solid #354a61;
}
article p {
  margin-bottom: 0;
}
.error {
  color: #ffabb8;
}
</style>
