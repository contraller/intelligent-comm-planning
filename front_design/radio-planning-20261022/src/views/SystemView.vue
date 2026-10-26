<template>
  <div class="page">
    <div class="page-heading"
      ><h1>系统管理</h1>
      <div class="toolbar"
        ><span class="chip">账号与权限</span><button v-if="formal" class="btn" :disabled="store.busy" @click="store.openPassword()"><i class="pi pi-key" />修改本人密码</button
        ><button
          v-if="auth.can('system.reset') && (!formal || auth.can('system.parameters'))"
          class="btn"
          :disabled="store.busy || store.loading || !store.catalog"
          @click="store.reset('system')"
          >{{ formal ? '恢复参数默认值' : '重置系统配置' }}</button
        ></div
      >
    </div>
    <div v-if="store.pendingMutation" class="notice" role="status">操作结果待核实：{{ store.pendingMutation.requestId }}<button class="btn" :disabled="store.busy" @click="store.reconcilePending">核实回执</button></div>
    <div class="split">
      <aside class="panel"
        ><div class="panel-head"><h3>管理中心</h3></div
        ><div class="side-list"
          ><button
            v-for="t in visibleTabs"
            :key="t.key"
            :class="{ active: store.tab === t.key }"
            :disabled="store.busy"
            @click="store.changeTab(t.key)"
            >{{ t.name }}</button
          ></div
        ><div class="panel-body"
          ><!-- 侧栏保留当前身份，省去开发与演示职责说明。 -->
          <p>当前：{{ auth.identity?.name }}</p
          ><p class="muted">{{ auth.identity?.roleName }}</p></div
        ></aside
      >
      <section class="panel"
        ><div class="panel-head"
          ><h3>{{ title }}</h3
          ><div class="toolbar">
            <button
              v-if="allowed && store.tab === 'accounts'"
              class="btn primary"
              :disabled="store.loading || store.busy || !store.catalog"
              @click="store.openAccount()"
              >新增账号</button
            >
            <button
              v-if="allowed && store.tab === 'roles'"
              class="btn primary"
              :disabled="store.loading || store.busy || !store.catalog"
              @click="store.openRole()"
              >新增角色</button
            >
            <button
              v-if="store.tab === 'logs' && auth.can('system.logs') && auth.can('system.reset')"
              class="btn"
              :disabled="store.busy || store.loading"
              @click="store.reset('logs')"
              >{{ formal ? '归档日志视图' : '重置日志' }}</button
            >
          </div></div
        >
        <div
          v-if="allowed"
          class="panel-body toolbar filters"
        >
          <input
            v-model="store.query.search"
            placeholder="搜索关键字"
            aria-label="搜索系统记录"
            @keyup.enter="store.search()"
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
              aria-label="日志操作者" /><select
              v-model="store.query.outcome"
              aria-label="操作结果"
              ><option :value="undefined">全部结果</option
              ><option
                v-for="(label, value) in outcomes"
                :key="value"
                :value="value"
                >{{ label }}</option
              ></select
            ><input
              v-model="store.query.date"
              type="date"
              aria-label="日志日期（北京时间）"
          /><label v-if="formal"><input v-model="store.query.includeArchived" type="checkbox" />包含归档历史</label></template>
          <!-- 查询统一提交筛选，四个页签都不提供排序。 -->
          <button
            class="btn"
            :disabled="store.loading || store.busy"
            @click="store.search()"
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
            class="system-table accounts-table"
            :page-size="store.page?.pageSize ?? 20"
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
                :disabled="store.loading || store.busy"
                @click="store.openAccount(row)"
                >编辑</button
              ><button
                class="text-link"
                :disabled="store.loading || store.busy"
                @click="store.setEnabled(row)"
                >{{ row.enabled ? '停用' : '启用' }}</button
              ><button v-if="formal" class="text-link" :disabled="store.loading || store.busy" @click="store.openPassword(row)">维护密码</button
              ></template
            >
          </AppTable>
          <AppTable
            class="system-table roles-table"
            :page-size="store.page?.pageSize ?? 20"
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
            ><template #permissions="{ row }">{{ row.permissionCount }}</template
            ><template #action="{ row }"
              ><button
                class="text-link"
                :disabled="store.loading || store.busy"
                @click="store.openRole(row)"
                >权限矩阵 / 编辑</button
              ></template
            ></AppTable
          >
          <AppTable
            class="system-table parameters-table"
            :page-size="store.page?.pageSize ?? 20"
            :paginator="false"
            v-if="store.tab === 'parameters'"
            :rows="store.parameters?.items ?? []"
            :columns="
              listColumns([
                { field: 'name', header: '参数' },
                { field: 'value', header: '参数值' },
                { field: 'unit', header: '单位' },
                { field: 'description', header: '说明' },
                { field: 'action', header: '操作' },
              ])
            "
            ><template #action="{ row }"
              ><button
                class="text-link"
                :disabled="store.loading || store.busy"
                @click="store.openParameter(row)"
                >{{ row.readonly ? '查看' : '编辑' }}</button
              ></template
            ></AppTable
          >
          <AppTable
            class="system-table logs-table"
            :page-size="store.page?.pageSize ?? 20"
            :paginator="false"
            v-if="store.tab === 'logs'"
            @select="openLog"
            :rows="store.logs?.items ?? []"
            :columns="
              listColumns([
                { field: 'time', header: '时间' },
                { field: 'actor', header: '操作者 / 当时角色', minWidth: '170px' },
                { field: 'module', header: '模块' },
                { field: 'action', header: '操作' },
                { field: 'objectId', header: '对象' },
                { field: 'outcome', header: '结果', minWidth: '112px' },
                { field: 'summary', header: '摘要' },
              ])
            "
            ><template #outcome="{ row }">{{ outcomeLabel(row.outcome) }}</template
            ><template #time="{ row }">{{ formatLogTime(row.time) }}</template
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
            ><span
              >共 {{ store.page?.total ?? 0 }} 条，每页 {{ store.page?.pageSize ?? 20 }} 条</span
            ><button
              class="btn"
              :disabled="store.loading || store.busy || (store.page?.pageNum ?? 1) <= 1"
              @click="store.changePage(-1)"
              >上一页</button
            ><span>第 {{ store.page?.pageNum ?? 1 }} 页</span
            ><button
              class="btn"
              :disabled="
                store.loading ||
                store.busy ||
                (store.page?.pageNum ?? 1) * (store.page?.pageSize ?? 20) >=
                  (store.page?.total ?? 0)
              "
              @click="store.changePage(1)"
              >下一页</button
            ></div
          >
        </template>
      </section>
    </div>
    <AppDrawer
      :visible="!!selectedLog"
      title="操作日志详情"
      @update:visible="!$event && closeLog()"
      ><dl
        v-if="selectedLog"
        class="kv"
        ><dt>事件 ID</dt><dd>{{ selectedLog.id }}</dd
        ><dt>操作时间</dt><dd>{{ formatLogTime(selectedLog.time) }}</dd
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
        ><dt>摘要</dt><dd>{{ selectedLog.summary }}</dd
        ><template v-if="selectedLog.changes"><dt>变更快照</dt><dd><pre class="history-changes">{{ JSON.stringify(selectedLog.changes, null, 2) }}</pre></dd></template></dl
      ><template #footer
        ><p>身份为操作当时快照，后续改名或换角色不改写此记录。</p></template
      ></AppDrawer
    >
    <SystemPasswordDrawer v-if="formal && store.passwordTarget" :visible="true" :mode="store.passwordTarget.mode" :disabled="!store.canSubmitPassword" :submit="store.submitPassword" @close="store.allowLeave()" @dirty-change="store.secretDirty = $event" @saved="store.passwordSaved" />
    <SystemAccountDrawer /><SystemRoleDrawer /><SystemParameterDrawer /><DecisionDialog
      :request="store.decision"
      @answer="store.answer"
    />
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import type { OperationEvent } from '../types/system';
import AppDrawer from '../components/AppDrawer.vue';
import { previewService } from '../services';
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
import SystemPasswordDrawer from '../components/SystemPasswordDrawer.vue';
import { env } from '../config/env';
const formal = env.mode === 'http';
const store = useSystemStore(),
  auth = useAuthStore(),
  selectedLog = ref<OperationEvent | null>(null);
let logSerial = 0,
  logAbort: AbortController | undefined;
function closeLog() {
  logSerial++;
  logAbort?.abort();
  logAbort = undefined;
  selectedLog.value = null;
}
onBeforeUnmount(closeLog);
watch([() => auth.generation, () => auth.identity?.sessionId, () => auth.identity?.revision, () => store.tab], closeLog, { flush: 'sync' });
async function openLog(row: { id: string }) {
  if (!auth.can('system.logs')) return;
  // 同一详情重试成功后，不继续显示上次操作的错误或成功提示。
  store.error = '';
  store.notice = '';
  const serial = ++logSerial,
    session = auth.generation;
  logAbort?.abort();
  logAbort = new AbortController();
  try {
    const value = await previewService.getOperationEvent({ id: row.id, signal: logAbort.signal });
    if (serial === logSerial && session === auth.generation) {
      selectedLog.value = value;
      store.error = '';
    }
  } catch (e) {
    if (serial === logSerial && session === auth.generation)
      store.error = e instanceof Error ? e.message : '日志详情读取失败';
  }
}
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
// 两种数据模式共用初始化和交互，重入时清除其他页签的筛选条件。
onMounted(() => {
  store.tab = visibleTabs.value[0]?.key ?? 'accounts';
  store.resetQuery();
  void store.load();
});
// 列表只展示服务返回的当前页，显式关闭公共表格默认的表头排序。
const listColumns = (columns: { field: string; header: string; minWidth?: string }[]) =>
  columns.map((column) => ({ ...column, sortable: false }));
// 单日筛选、列表与详情共用北京时间口径，保留时分秒区分同日操作。
const formatLogTime = (time: string) =>
  new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
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
.history-changes {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.split {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  gap: 18px;
}
.filters {
  flex-wrap: wrap;
}
/* 固定列布局让长标识在单元格内换行，避免撑宽表格后遮住右侧列。 */
.system-table {
  min-width: 0;
  max-width: 100%;
}
.system-table :deep(.p-datatable-table-container) {
  max-width: 100%;
  overflow-x: auto;
}
.system-table :deep(.p-datatable-table) {
  width: 100%;
  table-layout: fixed;
}
.system-table :deep(.p-datatable-thead > tr > th) {
  padding: 12px 10px;
  white-space: nowrap;
}
.system-table :deep(.p-datatable-tbody > tr > td) {
  padding: 12px 10px;
  white-space: normal;
  overflow-wrap: anywhere;
  vertical-align: top;
}
/* 窄屏保留可读列宽，横向滚动只发生在各自表格容器内。 */
.accounts-table :deep(.p-datatable-table) {
  min-width: 760px;
}
.accounts-table :deep(th:nth-child(5)) {
  width: 70px;
}
.accounts-table :deep(th:nth-child(6)) {
  width: 170px;
}
.accounts-table :deep(th:nth-child(7)) {
  width: 108px;
}
.roles-table :deep(.p-datatable-table),
.parameters-table :deep(.p-datatable-table) {
  min-width: 650px;
}
.roles-table :deep(th:nth-child(1)) {
  width: 150px;
}
.roles-table :deep(th:nth-child(3)) {
  width: 110px;
}
.roles-table :deep(th:nth-child(4)) {
  width: 100px;
}
.roles-table :deep(th:nth-child(5)) {
  width: 150px;
}
.parameters-table :deep(th:nth-child(1)) {
  width: 140px;
}
.parameters-table :deep(th:nth-child(2)) {
  width: 110px;
}
.parameters-table :deep(th:nth-child(3)) {
  width: 60px;
}
.parameters-table :deep(th:nth-child(5)) {
  width: 80px;
}
.logs-table :deep(.p-datatable-table) {
  min-width: 900px;
}
.logs-table :deep(th:nth-child(1)) {
  width: 140px;
}
.logs-table :deep(th:nth-child(2)) {
  width: 170px;
}
.logs-table :deep(th:nth-child(3)) {
  width: 80px;
}
.logs-table :deep(th:nth-child(4)),
.logs-table :deep(th:nth-child(5)) {
  width: 130px;
}
.logs-table :deep(th:nth-child(6)) {
  width: 112px;
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
  white-space: nowrap;
}
p {
  line-height: 1.8;
}
@media (max-width: 760px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
  .split > aside,
  .split > section {
    min-width: 0;
    max-width: 100%;
  }
  .side-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .side-list button {
    min-width: 0;
    white-space: normal;
  }
  .page-heading,
  .split > section > .panel-head {
    flex-direction: column;
    align-items: stretch;
  }
  .page-heading > .toolbar,
  .split > section > .panel-head > .toolbar {
    justify-content: flex-start;
  }
  .system-table :deep(.p-datatable-table-container) {
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
  }
}
@media (max-width: 600px) {
  .panel-head,
  .panel-body {
    padding: 12px;
  }
  .filters {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
  }
  .filters input:not([type='checkbox']),
  .filters select {
    width: 100%;
    max-width: 100%;
    min-width: 0;
  }
  .toolbar .btn {
    max-width: 100%;
    white-space: normal;
  }
}
</style>
