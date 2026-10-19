<template>
  <div class="page">
    <div class="page-heading"
      ><div
        ><p class="eyebrow">SYSTEM ADMINISTRATION</p><h1>系统管理</h1
        ><p class="subtitle">演示账号、角色权限、操作记录与参数配置</p></div
      >
      <div class="toolbar"
        ><span class="chip">Mock 账号与权限</span
        ><button
          v-if="auth.can('system.reset')"
          class="btn"
          :disabled="store.busy || !store.catalog"
          @click="store.reset('system')"
          >重置系统配置</button
        ></div
      >
    </div>
    <div class="split">
      <aside class="panel"
        ><div class="panel-head"><h3>管理中心</h3></div
        ><div class="side-list"
          ><button
            v-for="t in visibleTabs"
            :key="t.key"
            :class="{ active: store.tab === t.key }"
            @click="store.changeTab(t.key)"
            >{{ t.name }}</button
          ></div
        ><div class="panel-body"
          ><p>当前：{{ auth.identity?.name }}</p
          ><p class="muted">{{ auth.identity?.roleName }}</p
          ><p class="muted">演示权限用于前端流程。正式认证、鉴权和持久化由甲方服务端实现。</p></div
        ></aside
      >
      <section class="panel"
        ><div class="panel-head"
          ><h3>{{ title }}</h3
          ><div class="toolbar">
            <button
              v-if="allowed && store.tab === 'accounts'"
              class="btn primary"
              @click="store.openAccount()"
              >新增账号</button
            >
            <button
              v-if="allowed && store.tab === 'roles'"
              class="btn primary"
              @click="store.openRole()"
              >新增角色</button
            >
            <button
              v-if="store.tab === 'logs' && auth.can('system.logs') && auth.can('system.reset')"
              class="btn"
              :disabled="store.busy"
              @click="store.reset('logs')"
              >重置日志</button
            >
          </div></div
        >
        <div
          v-if="allowed"
          class="panel-body toolbar filters"
        >
          <input
            v-model="store.query.query"
            placeholder="搜索关键字"
            aria-label="搜索系统记录"
            @keyup.enter="search"
          />
          <template v-if="store.tab === 'accounts'"
            ><select
              v-model="store.query.roleId"
              aria-label="筛选角色"
              ><option :value="undefined">全部角色</option
              ><option
                v-for="r in store.catalog?.roles"
                :key="r.id"
                :value="r.id"
                >{{ r.name }}</option
              ></select
            ><select
              v-model="store.query.enabled"
              aria-label="筛选账号状态"
              ><option :value="undefined">全部状态</option
              ><option :value="true">启用</option
              ><option :value="false">停用</option></select
            ></template
          >
          <template v-if="store.tab === 'logs'"
            ><input
              v-model="store.query.actorId"
              placeholder="操作者 ID"
              aria-label="日志操作者" /><input
              v-model="store.query.module"
              placeholder="模块"
              aria-label="日志模块" /><input
              v-model="store.query.action"
              placeholder="操作"
              aria-label="日志操作" /><select
              v-model="store.query.outcome"
              aria-label="操作结果"
              ><option :value="undefined">全部结果</option
              ><option
                v-for="(label, value) in outcomes"
                :key="value"
                :value="value"
                >{{ label }}</option
              ></select
            ><label
              >开始<input
                v-model="store.query.from"
                type="datetime-local" /></label
            ><label
              >结束<input
                v-model="store.query.to"
                type="datetime-local" /></label
          ></template>
          <select
            v-model="store.query.sort"
            aria-label="排序字段"
            ><option :value="undefined">默认排序</option
            ><option
              v-if="store.tab !== 'logs'"
              value="name"
              >名称</option
            ><option
              v-if="store.tab === 'accounts'"
              value="username"
              >登录名</option
            ><option
              v-if="store.tab === 'logs'"
              value="time"
              >时间</option
            ></select
          ><label
            ><input
              v-model="store.query.descending"
              type="checkbox"
            />降序</label
          ><button
            class="btn"
            @click="search"
            >查询</button
          >
        </div>
        <div
          v-if="store.notice"
          class="panel-body notice"
          >{{ store.notice }}</div
        ><div
          v-if="store.error"
          class="panel-body"
          role="alert"
          >{{ store.error }}</div
        >
        <RequestState
          v-if="!allowed"
          state="forbidden"
          message="当前角色没有此管理项权限，请选择有权限的页签。"
        />
        <RequestState
          v-else-if="store.loading"
          state="loading"
        />
        <RequestState
          v-else-if="store.loadError"
          state="error"
          :message="store.loadError"
          @retry="store.load"
        />
        <template v-else>
          <AppTable
            :page-size="20"
            :paginator="false"
            v-if="store.tab === 'accounts'"
            :rows="store.accounts?.items ?? []"
            :columns="
              listColumns([
                { field: 'username', header: '登录名' },
                { field: 'name', header: '显示名' },
                { field: 'department', header: '部门' },
                { field: 'roleName', header: '角色' },
                { field: 'enabled', header: '状态' },
                { field: 'lastLogin', header: '最近成功登录' },
                { field: 'action', header: '操作' },
              ])
            "
          >
            <template #enabled="{ row }">{{ row.enabled ? '启用' : '停用' }}</template
            ><template #lastLogin="{ row }">{{
              row.lastLogin ? new Date(row.lastLogin).toLocaleString() : '暂无记录'
            }}</template>
            <template #action="{ row }"
              ><button
                class="text-link"
                @click="store.openAccount(row)"
                >编辑</button
              ><button
                class="text-link"
                @click="store.setEnabled(row)"
                >{{ row.enabled ? '停用' : '启用' }}</button
              ></template
            >
          </AppTable>
          <AppTable
            :page-size="20"
            :paginator="false"
            v-if="store.tab === 'roles'"
            :rows="store.roles?.items ?? []"
            :columns="
              listColumns([
                { field: 'name', header: '角色名称' },
                { field: 'description', header: '说明' },
                { field: 'accountCount', header: '关联账号数' },
                { field: 'permissions', header: '权限数量' },
                { field: 'action', header: '操作' },
              ])
            "
            ><template #permissions="{ row }">{{ row.permissions.length }}</template
            ><template #action="{ row }"
              ><button
                class="text-link"
                @click="store.openRole(row)"
                >权限矩阵 / 编辑</button
              ></template
            ></AppTable
          >
          <AppTable
            :page-size="20"
            :paginator="false"
            v-if="store.tab === 'parameters'"
            :rows="store.parameters?.items ?? []"
            :columns="
              listColumns([
                { field: 'name', header: '参数' },
                { field: 'value', header: '演示值' },
                { field: 'unit', header: '单位' },
                { field: 'description', header: '说明' },
                { field: 'action', header: '操作' },
              ])
            "
            ><template #action="{ row }"
              ><button
                class="text-link"
                @click="store.openParameter(row)"
                >{{ row.readonly ? '查看' : '编辑' }}</button
              ></template
            ></AppTable
          >
          <AppTable
            :page-size="20"
            :paginator="false"
            v-if="store.tab === 'logs'"
            @select="selectedLog = $event"
            :rows="store.logs?.items ?? []"
            :columns="
              listColumns([
                { field: 'time', header: '时间' },
                { field: 'actor', header: '操作者 / 当时角色' },
                { field: 'module', header: '模块' },
                { field: 'action', header: '操作' },
                { field: 'objectId', header: '对象' },
                { field: 'outcome', header: '结果' },
                { field: 'summary', header: '摘要' },
              ])
            "
            ><template #outcome="{ row }">{{ outcomeLabel(row.outcome) }}</template
            ><template #time="{ row }">{{ new Date(row.time).toLocaleString() }}</template
            ><template #actor="{ row }">{{
              row.actor
                ? row.actor.name + ' / ' + row.actor.roleName
                : '登录尝试：' + row.attemptedUsername
            }}</template
            ><template #summary="{ row }"
              >{{ row.summary
              }}<small v-if="row.errorCode">（{{ row.errorCode }}）</small></template
            ></AppTable
          >
          <div class="panel-body toolbar"
            ><span>共 {{ store.page?.total ?? 0 }} 条，每页 20 条</span
            ><button
              class="btn"
              :disabled="(store.page?.page ?? 1) <= 1"
              @click="page(-1)"
              >上一页</button
            ><span>第 {{ store.page?.page ?? 1 }} 页</span
            ><button
              class="btn"
              :disabled="(store.page?.page ?? 1) * 20 >= (store.page?.total ?? 0)"
              @click="page(1)"
              >下一页</button
            ></div
          >
        </template>
      </section>
    </div>
    <details
      v-if="store.catalog"
      class="panel panel-body"
      ><summary>原始演示资料（只读参考）</summary
      ><p class="muted">下列旧资料不作为当前可登录账号或实际操作日志。</p
      ><pre>{{ JSON.stringify(store.catalog.legacy, null, 2) }}</pre>
    </details>
    <AppDrawer
      :visible="!!selectedLog"
      title="操作日志详情"
      @update:visible="!$event && (selectedLog = null)"
      ><dl
        v-if="selectedLog"
        class="kv"
        ><dt>事件 ID</dt><dd>{{ selectedLog.id }}</dd
        ><dt>操作时间</dt><dd>{{ selectedLog.time }}</dd
        ><dt>操作身份</dt
        ><dd
          >{{ selectedLog.actor?.name ?? '未认证的登录尝试' }} ·
          {{ selectedLog.actor?.id ?? selectedLog.attemptedUsername }}</dd
        ><dt>当时角色</dt
        ><dd>{{ selectedLog.actor?.roleName ?? '无' }} · {{ selectedLog.actor?.roleId }}</dd
        ><dt>模块 / 操作</dt><dd>{{ selectedLog.module }} / {{ selectedLog.action }}</dd
        ><dt>业务对象</dt><dd>{{ selectedLog.objectId || '未提供' }}</dd
        ><dt>请求 ID</dt><dd>{{ selectedLog.requestId || '未提供' }}</dd
        ><dt>结果 / 错误码</dt
        ><dd>{{ outcomeLabel(selectedLog.outcome) }} / {{ selectedLog.errorCode || '无' }}</dd
        ><dt>摘要</dt><dd>{{ selectedLog.summary }}</dd></dl
      ><template #footer
        ><p>身份为操作当时快照，后续改名或换角色不改写此记录。</p></template
      ></AppDrawer
    >
    <SystemAccountDrawer /><SystemRoleDrawer /><SystemParameterDrawer /><DecisionDialog
      :request="store.decision"
      @answer="store.answer"
    />
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { OperationEvent } from '../types/system';
import AppDrawer from '../components/AppDrawer.vue';
import { useSystemStore } from '../stores/system';
import { useAuthStore } from '../stores/auth';
import { useSystemLeaveGuard } from '../composables/useSystemLeaveGuard';
import { type Permission } from '../config/permissions';
import AppTable from '../components/AppTable.vue';
import RequestState from '../components/RequestState.vue';
import DecisionDialog from '../components/DecisionDialog.vue';
import SystemAccountDrawer from '../components/SystemAccountDrawer.vue';
import SystemRoleDrawer from '../components/SystemRoleDrawer.vue';
import SystemParameterDrawer from '../components/SystemParameterDrawer.vue';
const store = useSystemStore(),
  auth = useAuthStore(),
  selectedLog = ref<OperationEvent | null>(null);
const tabs = [
  { key: 'accounts', name: '账号管理' },
  { key: 'roles', name: '角色权限' },
  { key: 'logs', name: '操作日志' },
  { key: 'parameters', name: '参数配置' },
] as const;
const visibleTabs = computed(() => tabs.filter((t) => auth.can(('system.' + t.key) as Permission)));
const title = computed(() => tabs.find((t) => t.key === store.tab)?.name);
const allowed = computed(() => visibleTabs.value.some((t) => t.key === store.tab));
useSystemLeaveGuard();
// 重入首个有权限页签时同步重置查询，避免带入日志排序和筛选。
onMounted(() => {
  store.tab = visibleTabs.value[0]?.key ?? 'accounts';
  store.query = { page: 1 };
  void store.load();
});
function search() {
  store.query.page = 1;
  void store.refresh();
}
function page(delta: number) {
  store.query.page = (store.page?.page ?? 1) + delta;
  void store.refresh();
}
// 当前数据已经由服务分页；全量排序统一走上方查询，不在本页再次排序。
const listColumns = (columns: { field: string; header: string }[]) =>
  columns.map((column) => ({ ...column, sortable: false }));
const outcomes: Record<OperationEvent['outcome'], string> = {
  SUCCESS: '成功',
  FAILED: '失败',
  DENIED: '无权限',
  UNCHANGED: '未变化',
};
const outcomeLabel = (value: string) =>
  Object.hasOwn(outcomes, value)
    ? outcomes[value as OperationEvent['outcome']]
    : `未知结果（${value}）`;
// 筛选与列表各走受保护的业务接口，不借助资源预加载取得系统数据。
</script>
<style scoped>
.split {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 18px;
}
.filters {
  flex-wrap: wrap;
}
.filters input {
  max-width: 200px;
}
.filters input[type='checkbox'] {
  width: auto;
}
.filters label {
  display: flex;
  gap: 6px;
  align-items: center;
}
pre {
  max-height: 250px;
  overflow: auto;
  font-size: 12px;
}
details {
  margin-top: 18px;
}
.text-link {
  margin-right: 12px;
}
p {
  line-height: 1.8;
}
</style>
