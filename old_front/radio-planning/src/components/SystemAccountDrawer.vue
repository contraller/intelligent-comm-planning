<template>
  <AppDrawer
    :visible="!!store.accountForm"
    :title="store.accountForm?.id ? '编辑账号' : '新增账号'"
    @update:visible="!$event && store.allowLeave()"
  >
    <fieldset
      v-if="store.accountForm"
      :disabled="!store.canSave"
      class="system-form"
    >
      <label
        >登录名<input
          v-model="store.accountForm.username"
          :readonly="!!store.accountForm.id"
          maxlength="32"
          placeholder="小写字母开头，3–32 位"
      /></label>
      <label
        >显示名<input
          v-model="store.accountForm.name"
          maxlength="40"
      /></label>
      <label
        >部门<input
          v-model="store.accountForm.department"
          maxlength="60"
      /></label>
      <label
        >角色<select v-model="store.accountForm.roleId"
          ><option
            v-for="role in store.catalog?.roles"
            :key="role.id"
            :value="role.id"
            >{{ role.name }}</option
          ></select
        ></label
      >
      <p class="muted"
        >每个账号仅关联一个角色。登录名创建后不可修改；新增账号默认启用，使用公开演示口令
        Demo@2026。</p
      >
    </fieldset>
    <p
      v-if="store.error"
      role="alert"
      >{{ store.error }}</p
    >
    <template #footer
      ><button
        class="btn"
        :disabled="store.busy"
        @click="store.allowLeave()"
        >关闭</button
      ><button
        class="btn primary"
        :disabled="!store.canSave"
        @click="store.save()"
        >保存账号</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { useSystemStore } from '../stores/system';
import AppDrawer from './AppDrawer.vue';
const store = useSystemStore();
// 表单保存在工作区内，失权时只禁用，不清空输入。
</script>
<style scoped>
.system-form {
  border: 0;
  padding: 0;
  display: grid;
  gap: 18px;
}
.system-form label {
  display: grid;
  gap: 8px;
}
.system-form input,
.system-form select {
  width: 100%;
}
p {
  line-height: 1.8;
}
</style>
