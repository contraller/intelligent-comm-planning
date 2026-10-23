<template>
  <Drawer
    :visible="visible"
    position="right"
    :header="title"
    :style="{ width: '460px', maxWidth: '95vw' }"
    @update:visible="$emit('update:visible', $event)"
    @after-show="$emit('after-show')"
  >
    <p
      v-if="subtitle"
      class="subtitle"
      style="margin: 0 0 24px"
      >{{ subtitle }}</p
    >
    <slot />
    <!-- 仅透传业务页提供的底部内容，不再附加历史预览声明。 -->
    <template
      v-if="$slots.footer"
      #footer
      ><slot name="footer"
    /></template>
  </Drawer>
</template>
<script setup lang="ts">
import Drawer from 'primevue/drawer';
defineProps<{ visible: boolean; title: string; subtitle?: string }>();
// 只透传原抽屉动画完成事件，不改变其他调用方的焦点或关闭行为。
defineEmits<{ 'update:visible': [value: boolean]; 'after-show': [] }>();
</script>
