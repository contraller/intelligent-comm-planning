<template>
  <AppDrawer :visible="visible" :title="mode === 'SELF' ? '修改本人密码' : '维护账号密码'" @update:visible="!$event && close()">
    <form class="password-form" @submit.prevent="save">
      <label>{{ mode === 'SELF' ? '当前密码' : '操作人当前密码' }}<input v-model="current" type="password" autocomplete="current-password" required :disabled="busy || disabled" maxlength="256" /></label>
      <label>新密码<input v-model="next" type="password" autocomplete="new-password" required :disabled="busy || disabled" maxlength="256" /></label>
      <label>确认新密码<input v-model="confirm" type="password" autocomplete="new-password" required :disabled="busy || disabled" maxlength="256" /></label>
      <p v-if="error" role="alert">{{ error }}</p>
      <p v-if="mode === 'ADMIN'" class="muted">维护后目标账号的旧会话失效，下次登录须修改本人密码。</p>
      <button class="btn primary" type="submit" :disabled="busy || disabled || !valid"><i class="pi pi-key" />{{ busy ? '正在提交' : '提交密码' }}</button>
    </form>
    <template #footer><button class="btn" :disabled="busy" @click="close">关闭</button></template>
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { PasswordFields } from '../types/local-identity';
import type { SystemResult } from '../types/system';
import AppDrawer from './AppDrawer.vue';
const props = defineProps<{ visible: boolean; mode: 'SELF' | 'ADMIN'; disabled?: boolean; submit: (input: PasswordFields) => Promise<SystemResult> }>();
const emit = defineEmits<{ close: []; saved: [result: SystemResult]; 'dirty-change': [dirty: boolean] }>();
const current = ref(''), next = ref(''), confirm = ref(''), error = ref(''), busy = ref(false);
const valid = computed(() => !!current.value && [...next.value].length >= 15 && [...next.value].length <= 128 && next.value === confirm.value && !/[\u0000\ud800-\udfff]/u.test(next.value));
function clear() { current.value = ''; next.value = ''; confirm.value = ''; emit('dirty-change', false); }
watch([current, next, confirm], values => emit('dirty-change', values.some(Boolean)));
watch(() => props.visible, () => { clear(); error.value = ''; });
onBeforeUnmount(clear);
function close() { if (!busy.value) emit('close'); }
async function save() {
  if (busy.value || props.disabled || !valid.value) return;
  busy.value = true; error.value = '';
  try { const result = await props.submit({ currentPassword: props.mode === 'SELF' ? current.value : '', operatorPassword: props.mode === 'ADMIN' ? current.value : '', newPassword: next.value }); clear(); emit('saved', result); }
  catch { error.value = '密码未获确认提交。敏感输入已清空，请先核实操作状态。'; }
  finally { clear(); busy.value = false; }
}
</script>
<style scoped>
.password-form { display: grid; gap: 16px; }
label { display: grid; gap: 8px; }
input { width: 100%; min-width: 0; }
p { overflow-wrap: anywhere; }
</style>
