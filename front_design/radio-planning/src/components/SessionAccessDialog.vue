<template>
  <div
    v-if="auth.logWarning"
    class="session-log"
    role="status"
    >{{ auth.logWarning }}（待补 {{ auth.pendingLogs }} 条）<button
      class="btn"
      @click="auth.retryLogs()"
      >仅重试补记</button
    ></div
  >
  <Dialog
    :visible="auth.blocked"
    header="当前工作区已冻结"
    modal
    :closable="false"
    :close-on-escape="false"
    :base-z-index="10000"
    :style="{ width: '540px', maxWidth: '95vw' }"
  >
    <p>{{
      auth.error ||
      (auth.pageDenied ? '当前角色已无此页面的查看权限。' : '当前标签页未登录或会话已失效。')
    }}</p>
    <p>当前未保存输入仍保留。已提交任务和保存的数据不会因会话失效被取消或删除。</p>
    <p v-if="auth.sessionReplaced"
      >浏览器的登录会话已经变化。明确丢弃旧现场后才会重新进入，清理本页不会退出其他标签页的新账号。</p
    >
    <p v-if="retained">{{
      auth.sessionReplaced
        ? '已保留旧输入并保持冻结；这些输入不会转交给新会话。'
        : '已保留输入并保持冻结；恢复原账号权限后可重新校验。'
    }}</p
    ><p
      v-if="auth.notice"
      role="alert"
      >{{ auth.notice }}</p
    >
    <template #footer
      ><button
        class="btn"
        @click="retained = true"
        >保留输入并保持冻结</button
      ><button
        class="btn"
        :disabled="!!auth.busy || auth.transition"
        @click="auth.check()"
        >重新校验</button
      ><button
        class="btn primary"
        :disabled="!!auth.busy || auth.transition"
        @click="discard"
        >明确丢弃输入并{{
          env.mode === 'http'
            ? '重新读取登录状态'
            : auth.identity && !auth.error
              ? '离开此页'
              : '返回登录'
        }}</button
      ></template
    >
  </Dialog>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { env } from '../config/env';
import Dialog from 'primevue/dialog';
const auth = useAuthStore(),
  router = useRouter(),
  retained = ref(false);
async function discard() {
  if (await auth.discardRestricted())
    await router.replace(auth.identity ? auth.firstPath() : '/login');
}
// 不关闭或卸载业务组件；确认丢弃后才切换页面和清理缓存。
</script>
<style scoped>
p {
  line-height: 1.8;
}
.session-log {
  position: fixed;
  bottom: 28px;
  left: 20px;
  right: 20px;
  z-index: 9999;
  background: #473a23;
  color: #ffe1a7;
  padding: 12px;
  border: 1px solid #a78443;
}
.session-log button {
  margin-left: 12px;
}
</style>
