<template>
  <Dialog
    :visible="!!request"
    :header="request?.title"
    modal
    :style="{ width: '520px', maxWidth: '95vw' }"
    @update:visible="!$event && answer('cancel')"
  >
    <p class="decision-message">{{ request?.message }}</p>
    <template #footer>
      <div class="decision-actions">
        <button
          class="btn"
          @click="answer('cancel')"
        >
          {{ request?.cancelLabel ?? (request?.discardLabel ? '继续编辑' : '取消') }}
        </button>
        <button
          v-if="request?.discardLabel"
          class="btn"
          @click="answer('discard')"
        >
          {{ request.discardLabel }}
        </button>
        <button
          v-if="request?.saveLabel"
          class="btn primary"
          @click="answer('save')"
        >
          {{ request?.saveLabel }}
        </button>
      </div>
    </template>
  </Dialog>
</template>
<script setup lang="ts">
import Dialog from 'primevue/dialog';
import { computed } from 'vue';
import type { Decision, DecisionRequest } from '../types/resource-edit';
import { useResourceEditStore } from '../stores/resource-edit';
const editor = useResourceEditStore();
const props = defineProps<{ request?: DecisionRequest | null }>();
const emit = defineEmits<{ answer: [value: Decision] }>();
// 不传 request 时保持 GIS / 台账原交互；显式 null 表示规划对话框关闭。
const request = computed(() => (props.request === undefined ? editor.decision : props.request));
function answer(value: Decision) {
  if (props.request === undefined) editor.answer(value);
  else emit('answer', value);
}
</script>
<style scoped>
.decision-message {
  line-height: 1.9;
  color: #b8cbe0;
}
.decision-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
