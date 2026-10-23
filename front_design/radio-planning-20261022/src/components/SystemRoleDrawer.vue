<template>
  <AppDrawer
    :visible="!!store.roleForm"
    :title="store.roleForm?.id ? '编辑角色权限' : '新增角色'"
    width="720px"
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
          rows="2"
          maxlength="200"
        />
      </label>
      <p class="role-impact"
        >当前关联
        {{ affected }}
        个账号。保存后关联账号采用新权限；内置系统管理员可兼有知识编辑与审核权限，其他角色不能同时授予。</p
      >
      <!-- 分组并排压缩纵向留白，保留全部权限及原有依赖勾选行为。 -->
      <div class="permission-groups"
        ><section
          v-for="group in groups"
          :key="group"
          class="permission-group"
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
        ></div
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
// 勾选时联动依赖；服务对内置管理员以外的角色校验编辑与审核互斥。
</script>
<style scoped>
.system-form {
  border: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}
.system-form > label {
  display: grid;
  gap: 6px;
}
.role-impact {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
.permission-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.permission-group {
  min-width: 0;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}
.permission-group h3 {
  margin: 0 0 6px;
  font-size: 14px;
}
.permission {
  display: flex;
  /* 覆盖通用表单标签的纵向排列，让复选框与权限名称保持同一行。 */
  flex-direction: row;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 3px 0;
  font-size: 13px;
  line-height: 1.5;
}
.permission input {
  width: auto;
  flex-shrink: 0;
  margin-top: 3px;
}
p {
  line-height: 1.8;
}
/* 抽屉仍沿用屏幕宽度上限，窄屏按单列阅读。 */
@media (max-width: 600px) {
  .permission-groups {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
