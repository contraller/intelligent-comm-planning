<template>
  <AppDrawer
    :visible="!!store.roleForm"
    :title="store.roleForm?.id ? '编辑角色权限' : '新增角色'"
    @update:visible="!$event && store.allowLeave()"
  >
    <fieldset
      v-if="store.roleForm"
      :disabled="!store.canSave"
      class="system-form"
    >
      <label
        >角色名称<input
          v-model="store.roleForm.name"
          maxlength="40"
      /></label>
      <label
        >说明<textarea
          v-model="store.roleForm.description"
          maxlength="200"
        />
      </label>
      <p
        >当前关联
        {{ affected }} 个账号。保存后关联账号采用新权限；知识编辑与审核权限不能同时授予。</p
      >
      <section
        v-for="group in groups"
        :key="group"
        ><h3>{{ group }}</h3
        ><label
          v-for="p in permissions.filter((p) => p.group === group)"
          :key="p.code"
          class="permission"
          ><input
            type="checkbox"
            :checked="store.roleForm.permissions.includes(p.code)"
            @change="store.toggle(p.code, ($event.target as HTMLInputElement).checked)"
          />{{ p.name }}</label
        ></section
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
        >保存角色</button
      ></template
    >
  </AppDrawer>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useSystemStore } from '../stores/system';
import { permissions } from '../config/permissions';
import AppDrawer from './AppDrawer.vue';
const store = useSystemStore(),
  groups = [...new Set(permissions.map((p) => p.group))];
const affected = computed(
  () => store.roles?.items.find((r) => r.id === store.roleForm?.id)?.accountCount ?? 0,
);
// 勾选时联动依赖；编辑与审核互斥由服务显式校验并反馈。
</script>
<style scoped>
.system-form {
  border: 0;
  padding: 0;
  display: grid;
  gap: 18px;
}
.system-form > label {
  display: grid;
  gap: 8px;
}
.permission {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 12px 0;
}
.permission input {
  width: auto;
}
p {
  line-height: 1.8;
}
</style>
